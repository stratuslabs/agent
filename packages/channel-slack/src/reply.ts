/*
 * How a turn's reply reaches Slack: `ReplyRenderer`, which owns a turn's
 * placeholder, loading status, interim words, edits, overflow messages and
 * file uploads, plus the limits and helpers only reply rendering uses
 * (message size, splitting, the placeholder handover). A module of its own
 * because it is the part of the adapter that changes most often. Nothing
 * here is public: `index.ts` imports what the adapter needs, and the
 * package's one public entry is unchanged.
 */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  filePathsOf,
  leastTrusted,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  type OutboundMessageRef,
  postOf,
  type ProviderPart,
  type StratusEvent,
  type ToolPost,
  type ToolResult,
  type TrustLevel,
} from '@stratusagent/core';

import { codeRunsOf, toSlackMrkdwn } from './mrkdwn.ts';
import { neutralizeMentions, sanitizePostBlocks } from './posts.ts';
import { slackErrorCode } from './slack-errors.ts';
import { textingParts } from './texts.ts';
import type {
  SlackReplyMode,
  SlackUploadedFile,
  SlackUploadResult,
  SlackWebLike,
} from './index.ts';

const SLACK_MAX_MESSAGE_CHARS = 4000;

const PLACEHOLDER_TEXT = '…';

/** What the loading status says while a turn works, and while it runs a tool. */
const THINKING_STATUS = 'is thinking…';
const toolStatus = (toolName: string): string => `is running ${toolName}…`;
/**
 * The same step as a line of its own, for Slack's `loading_messages`
 * ("is running shell.run…" -> "Running shell.run…"). Slack's agent sessions
 * show their own generic text ("Finding answers…") in place of `status`,
 * and rotate these instead. None for the clear: Slack wants one to ten,
 * and the empty status alone takes the indicator down.
 */
const loadingMessage = (status: string): string | undefined => {
  const step = status.replace(/^is /, '');
  return step === '' ? undefined : step.charAt(0).toUpperCase() + step.slice(1);
};

/**
 * How often a loading status is set again while its turn runs. Slack drops
 * one after two minutes with no message, and a long turn — a tool, an
 * approval wait — is exactly the one whose status must not vanish.
 */
const STATUS_REFRESH_MS = 60_000;

/** What a turn that produced no text puts in its message, wherever it is posted from. */
export const NO_REPLY_TEXT = '(no reply)';
/**
 * The most `message.say` lines one turn may post (card 1009). Enough for a
 * question and a heads-up or two; a turn past it is narrating, which is
 * what holding the words between tools exists to stop.
 */
const SAY_LIMIT_PER_TURN = 3;

/**
 * A hold on a queued renderer's placeholder, taken the moment an earlier
 * turn's outcome arrives and before anything about that outcome is looked
 * up. Reading the routing of a turn nobody rendered is a store round trip,
 * and the turn queued behind it can finish inside that window: without a
 * hold it would finalize its own placeholder away, and the earlier turn's
 * reply and attachments would land below the newer turn's answer — exactly
 * the order the handover exists to prevent. `finalize` waits on the hold,
 * so the placeholder is still there when the lookup comes back.
 *
 * Both methods are idempotent, and one of them must be called: a hold that
 * is neither taken nor released stalls the queued turn's reply.
 */
export interface HandoverClaim {
  /**
   * Spend the hold: hand the placeholder to `chunks`, run `between` while
   * this renderer still has no placeholder of its own, and reopen one
   * below. `untaken` when there is nothing to hand over — no placeholder,
   * or the renderer finished before the hold was taken — and the caller
   * posts the chunks itself; `partial` when the placeholder took the first
   * chunk and Slack refused one of the rest. `whole` is the reply the
   * chunks were cut from, attached to a later chunk that tags another
   * agent (card 1033).
   */
  take(chunks: readonly string[], between?: () => Promise<void>, whole?: string): Promise<'complete' | 'partial' | 'untaken'>;
  /** Give the hold back unspent, letting the queued turn finish. */
  release(): void;
}

/**
 * What became of a turn's reply. `published`: whether ALL of its text was
 * — the edit taken and every overflow message posted. `spoke`: whether
 * ANYTHING of the turn's landed, a chunk or a file. `spokeAt`: where in
 * the thread what landed sits — the ts of the lowest message of the
 * turn's that Slack took — present exactly when `spoke` is. `refused`:
 * there was text to say and Slack refused some of it, unlike a turn that
 * decided to say nothing, which is unpublished but not refused.
 */
export interface ReplyOutcome {
  published: boolean;
  spoke: boolean;
  spokeAt?: string;
  refused?: true;
}

/**
 * The dispatch's idempotency key for a message's dedupe key: the key itself
 * when it fits the gateway's bound, and a digest of it when it does not —
 * an agent id is not length-bounded (overlong ids that predate validation
 * are kept), and a key over the bound would refuse every message for that
 * agent. Deterministic, so a redelivery after a restart maps to the same.
 */
export const dispatchKeyFor = (eventKey: string): string =>
  eventKey.length <= MAX_IDEMPOTENCY_KEY_LENGTH ? eventKey : `slack-sha256:${createHash('sha256').update(eventKey).digest('hex')}`;

/**
 * What the report of a turn nobody was rendering got into the thread, part
 * by part: whether its text was said in full (or there was none to say),
 * and which of its files (by path) and tool posts landed. A redelivery
 * waiting behind the report posts only what is missing from it.
 */
export interface ReportedOutcome {
  said: boolean;
  landed: ReadonlyArray<string | ToolPost>;
}

export const NOTHING_REPORTED: ReportedOutcome = { said: false, landed: [] };

/**
 * How far a file's change time may run past the record of the tool result
 * naming it: the rest of the millisecond the record was stamped in, since
 * the record is whole milliseconds and the file time is finer. No more,
 * because any window is one an overwrite fits inside — two seconds was, in
 * review. A filesystem that rounds file times up, coarser than that, fails
 * closed: the file is warned about and not uploaded, which a repeat can
 * afford and a wrong attachment cannot.
 */
const PRODUCED_AT_SLACK_MS = 1;

/**
 * A file a finished turn produced, read for a repeat of it — refused unless
 * it is provably the file the turn left there. The transcript keeps a path,
 * not the bytes, and a repeat can come after a later turn or another
 * process has written the same path; uploading what is there now would
 * answer the old message with a different file, or a sensitive one.
 *
 * The change time, not the modification time, is what is compared: it
 * moves on every write, on a rename into the path, and on `utimes` itself,
 * so neither an older file renamed in nor a backdated one passes. Then the
 * path has to name the same file before and after it is opened — the open
 * handle's file, when it is not a link — and the handle has to be unchanged
 * after the read, so a swap or a write landing between the checks and the
 * read is caught rather than uploaded.
 */
const readUnchangedSince = async (filePath: string, producedAt: number): Promise<Buffer> => {
  // Exclusive: a change time at or past it was a change after the record.
  const writtenBefore = producedAt + PRODUCED_AT_SLACK_MS;
  const changed = (): Error =>
    new Error('it was changed after the turn that produced it, so it may hold another file now; it was not uploaded.');
  const named = await lstat(filePath);
  if (named.ctimeMs >= writtenBefore) {
    throw changed();
  }
  const handle = await open(filePath, 'r');
  try {
    const opened = await handle.stat();
    const stillNamed = await lstat(filePath);
    const samePath = stillNamed.ino === named.ino && stillNamed.dev === named.dev && stillNamed.ctimeMs === named.ctimeMs;
    const sameFile = named.isSymbolicLink() || (opened.ino === named.ino && opened.dev === named.dev);
    if (!samePath || !sameFile || opened.ctimeMs >= writtenBefore) {
      throw changed();
    }
    const data = await handle.readFile();
    const after = await handle.stat();
    if (after.ctimeMs !== opened.ctimeMs || after.size !== data.length) {
      throw changed();
    }
    return data;
  } finally {
    await handle.close();
  }
};

/**
 * A clock reading as a Slack timestamp, for a file whose upload answered
 * with no share ts. Slack timestamps are epoch seconds with six decimals,
 * so the clock's reading compares with them as long as the two agree to
 * within the gap between one message and the next.
 */
const slackTs = (ms: number): string => (ms / 1000).toFixed(6);

/**
 * Where an upload sits in the thread: the ts of the message it became in
 * `channel`, from the shares the upload answers with. Undefined when the
 * answer carries none.
 */
const uploadPlace = (result: SlackUploadResult, channel: string): string | undefined => shareOf(result.files, channel)?.ts;

/** The first share in `channel` of any of `files`, nested ones included. */
const shareOf = (files: readonly SlackUploadedFile[] | undefined, channel: string): { ts: string; thread_ts?: string } | undefined => {
  for (const file of files ?? []) {
    for (const scope of [file.shares?.public, file.shares?.private]) {
      for (const share of scope?.[channel] ?? []) {
        if (share.ts !== undefined) {
          return { ts: share.ts, ...(share.thread_ts !== undefined ? { thread_ts: share.thread_ts } : {}) };
        }
      }
    }
    const nested = shareOf(file.files, channel);
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
};

/** The id of the first file in an upload's answer, nested ones included. */
const uploadedFileId = (files: readonly SlackUploadedFile[] | undefined): string | undefined => {
  for (const file of files ?? []) {
    const id = file.id ?? uploadedFileId(file.files);
    if (id !== undefined) {
      return id;
    }
  }
  return undefined;
};

/** What a reply's whole text is called when it goes up with a part that tags another agent (card 1033). */
const FULL_REPLY_FILENAME = 'full-reply.md';

/**
 * How many times, and how far apart, a part posted as an upload asks Slack
 * where it landed. The upload's answer names no message: Slack shares the
 * file a moment later (55 to 607 ms in a live check, Nov 1 2026), and
 * `files.info` says where once it has. The next part waits for that, so
 * the thread reads in order.
 */
const SHARE_POLLS = 10;
const SHARE_POLL_MS = 250;

/** Where an upload landed in `channel`, from its answer or from `files.info`; undefined when Slack never says. */
const landedShare = async (web: SlackWebLike, result: SlackUploadResult, channel: string): Promise<{ ts: string; thread_ts?: string } | undefined> => {
  const answered = shareOf(result.files, channel);
  const id = uploadedFileId(result.files);
  if (answered !== undefined || id === undefined || !web.files.info) {
    return answered;
  }
  for (let poll = 0; poll < SHARE_POLLS; poll += 1) {
    if (poll > 0) {
      await new Promise((resolve) => setTimeout(resolve, SHARE_POLL_MS));
    }
    const info = await web.files.info({ file: id }).catch(() => undefined);
    const share = info?.file ? shareOf([info.file], channel) : undefined;
    if (share !== undefined) {
      return share;
    }
  }
  return undefined;
};

/**
 * Post one part of a reply. A part that tags another agent, in a reply
 * Slack shows as more than one message, goes up as an upload instead
 * (card 1033): the part is the message, as it would have been, and the
 * whole reply rides along as `full-reply.md`. The tagged agent admits only
 * the message that names it and reads a text file on it into its turn, so
 * it hears all of the reply rather than the part with its name in it.
 * Posting it as one long message is no way around this: Slack splits a
 * post past about 4,000 characters on its own side (live, Nov 1 2026).
 * An upload Slack refuses is posted plainly, as before, so the thread
 * still reads all of it and the tagged agent hears its part.
 */
export const postPart = async (
  web: SlackWebLike,
  part: { channel: string; thread?: string | undefined; text: string; whole?: string | undefined },
  warn: (line: string) => void,
): Promise<{ ts?: string; channel?: string; message?: { ts?: string; thread_ts?: string } }> => {
  const { channel, thread, text, whole } = part;
  if (whole !== undefined) {
    try {
      const result = await web.files.uploadV2({
        channel_id: channel,
        file: Buffer.from(whole, 'utf8'),
        filename: FULL_REPLY_FILENAME,
        title: 'Full reply',
        initial_comment: text,
        ...(thread ? { thread_ts: thread } : {}),
      });
      const share = await landedShare(web, result, channel);
      return share === undefined ? { channel } : { ts: share.ts, channel, message: share };
    } catch (error) {
      warn(`slack: could not attach the full reply to a part that tags another agent, so it is posted on its own and that agent hears only this part: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return web.chat.postMessage({ channel, text, ...(thread ? { thread_ts: thread } : {}) });
};

/**
 * Post a tool's ready-made message (`postOf`, AGT-324) as one message of
 * its own: its words, converted as reply text is and with their mention
 * markup shown as text, and its Slack blocks once `sanitizePostBlocks` has
 * passed them. Blocks it refuses, or that Slack refuses, leave the words
 * to go alone, so a card that cannot be shown is plain text in the thread
 * and never silence. Only a refusal Slack answered is retried as text: a
 * call that never got an answer may have posted, and a second message
 * would say it twice. The warnings name a type or Slack's code, never the
 * post's content.
 */
export const postToolPost = async (
  web: SlackWebLike,
  target: { channel: string; thread?: string | undefined },
  post: ToolPost,
  warn: (line: string) => void,
): Promise<{ ts?: string; channel?: string; message?: { ts?: string; thread_ts?: string } }> => {
  const message = {
    channel: target.channel,
    text: neutralizeMentions(messageText(post.text)),
    ...(target.thread ? { thread_ts: target.thread } : {}),
  };
  const checked = post.slack !== undefined ? sanitizePostBlocks(post.slack.blocks) : undefined;
  if (checked !== undefined && 'refused' in checked) {
    warn(`slack: a tool's post went as text alone, because its blocks held ${checked.refused}`);
  }
  if (checked !== undefined && 'blocks' in checked) {
    try {
      return await web.chat.postMessage({ ...message, blocks: checked.blocks });
    } catch (error) {
      const code = slackErrorCode(error);
      if (code === undefined) {
        throw error;
      }
      warn(`slack: Slack refused a tool's post with blocks (${code}), so it went as text alone`);
    }
  }
  return web.chat.postMessage(message);
};

/**
 * Renders one turn's reply into Slack, one of two ways. Streaming (the
 * `stream` reply mode): post `…` immediately, fold streaming deltas and
 * tool status lines into throttled edits, and finalize with the
 * authoritative reply. Otherwise (`final`, the default): no placeholder —
 * Slack's loading status says the agent is working, and the finished reply
 * is posted once, so the notification carries the answer rather than a
 * `…`. Either way a reply that outgrows one message is split.
 */
export class ReplyRenderer {
  /**
   * Whether the gateway has begun the turn this renderer was opened for.
   * A renderer is queued at intake, before the gateway starts its turn,
   * so until the session reports `running` again the turn at the head of
   * the session's chain may be somebody else's — a recovery still parked
   * on a human — and its completion is not this renderer's to swallow.
   */
  turnStarted = false;
  /**
   * The id this renderer's turn is dispatched under. A gateway that reports
   * its active turn (`activeTurnId`) lets the adapter match an outcome to
   * this renderer exactly, rather than to whichever turn reported `running`
   * next — which, for a session another surface can also dispatch to, may
   * not be this one.
   */
  readonly turnId: string = randomUUID();
  /**
   * What a Slack stop aborts (card 337): the signal this renderer's dispatch
   * runs under, so a stop cancels this turn whether it is running or still
   * queued behind another.
   */
  readonly controller = new AbortController();
  /** The Slack user who stopped this turn, once someone has. */
  stoppedBy: string | undefined;
  private buffer = '';
  /**
   * In `final` and `texts` mode, what the model has said since its last
   * tool call. Only its first words, written before its first tool, are
   * posted (card 950): one line saying what it set out to do, as the tool
   * starts. Words it writes after that are held (card 1009): not posted,
   * and not added to the reply. Slack's own status line is what shows the
   * turn is still working.
   */
  private interim = '';
  /** The first line, once it landed, so a reply that repeats it is not posted twice. */
  private lastInterim: string | undefined;
  /** Whether the first line landed — something said, whatever the reply's fate. */
  private interimPosted = false;
  /** The first line, once it landed whole: what a hosted-loop reply is stripped of first. */
  private readonly interimSaid: string[] = [];
  /**
   * Told of the first line as it is queued — before the reply, and before
   * anything typed while its tool runs — with what of it landed, once that
   * is known, so the thread's other agents hear it in its place.
   */
  private readonly onInterim: ((heard: () => string, landed: Promise<boolean>) => void) | undefined;
  /** Whether this turn's first words have gone out, so later words are held. */
  private firstWordsSaid = false;
  /** Whether a tool of this turn's has been called: words after one are held, with or without a first line. */
  private toolCalled = false;
  /**
   * Words written between tools after the first line, in order — every
   * word a lazy turn writes before a tool, first line included. Never
   * posted; kept only so a hosted-loop reply that repeats them is stripped
   * of them, and so a turn that ends on them can post them as its reply
   * (never a lazy one: see `finalizeInOrder`).
   */
  private readonly held: string[] = [];
  /** Whether the last words this turn wrote before a tool were held rather than posted. */
  private lastWasHeld = false;
  /**
   * The reply as posted, where that is not what `unsaid` leaves of it:
   * held words posted as the reply because the turn ended on them, or a
   * judged turn's answer kept whole although it repeats words it held
   * (see `finalizeInOrder`).
   */
  private postedReply: string | undefined;
  /**
   * What the turn has streamed since its last tool, from text deltas only.
   * Unlike `interim`, never filled from a `provider.response`, which on a
   * provider that hosts its own loop is the whole joined reply. A reply
   * that is exactly this is the turn's last message and nothing it held.
   */
  private streamedAfterTool = '';
  /** The lowest trust this turn's session was lowered to while it ran (`session.tainted`). */
  taintedTo: TrustLevel | undefined;
  private turnBreakPending = false;
  private toolLine: string | undefined;
  private ref: OutboundMessageRef | undefined;
  private lastEditAt = 0;
  private pendingEdit: NodeJS.Timeout | undefined;
  private editChain: Promise<void> = Promise.resolve();
  private uploadChain: Promise<void> = Promise.resolve();
  /**
   * A handover in progress (`yieldTo`): edits and the finalize wait for it,
   * so a turn that finishes while its placeholder is being given away
   * writes into the fresh one rather than over the reply it was given to.
   */
  private handover: Promise<void> = Promise.resolve();
  /**
   * The report of a turn nobody was rendering, made ahead of this renderer
   * while it waited — through its placeholder or as messages of their own
   * — resolving to what of that outcome reached the thread. Set when the
   * report is claimed, before the turn it reports lets this renderer's
   * dispatch go, so a repeat resolving after it can tell its own turn was
   * that one, and post only what the report did not.
   */
  outcomeReportedAhead: Promise<ReportedOutcome> | undefined;
  /**
   * Bumped by a handover. An edit scheduled before it carries the text of
   * the turn that was handed over — the recovery's stream, routed to this
   * renderer while it was at the head of the queue — and must not land in
   * the placeholder opened for this turn.
   */
  private generation = 0;
  private finalized = false;
  /** How many `message.say` lines this turn has sent; see {@link SAY_LIMIT_PER_TURN}. */
  private saidMidTask = 0;
  /** A judged turn's status, waiting on its first tool call; see `showLoading`. */
  private loadOnFirstTool = false;
  /** Whether any upload or tool post of this turn's landed — a file or a card is something said, placeholder or not. */
  private uploaded = false;
  /** Whether any edit of this turn's landed — a streamed line Slack took is something said, whatever the final edit's fate. */
  private edited = false;
  /**
   * Where in the thread this turn's words stand: the ts of the lowest
   * message Slack took them in — the placeholder an edit landed in, or an
   * overflow chunk posted — and, separately, where a file of its landed
   * (the share ts the upload answers with, or the clock — see `queueUpload`).
   * What the thread rule orders by: an untagged reply is for whoever's
   * reply sits lowest in the thread, the one a reader sees last, which is
   * not the turn that finished last — a placeholder posted at intake and
   * filled in slowly sits above a reply posted while it was being written.
   */
  private textAt: string | undefined;
  private uploadedAt: string | undefined;
  /**
   * A turn nobody asked for: the placeholder is not posted at intake but
   * on the first TEXT the turn streams, and a turn that ends having said
   * nothing leaves the thread untouched — no placeholder, no `(no reply)`,
   * no edit. Text and not a tool line, though the spec sketched either: a
   * placeholder posted for a tool the turn ran on the way to deciding it
   * had nothing to add is a message the decision cannot take back.
   */
  readonly lazy: boolean;
  /**
   * A reply-optional turn (card 601): said to the agent, so it shows what
   * any turn shows while it works — status, placeholder, words along the
   * way — but one that ends with nothing to say posts nothing: no
   * `(no reply)`, its placeholder taken back, its status cleared. Unlike a
   * lazy turn, a failure or a stop still says so.
   */
  readonly mayStaySilent: boolean;
  /**
   * Whether this turn streams into a placeholder. When it does not, there
   * is never a placeholder: `finalize` finds none and posts the reply as
   * messages of its own, and a handover has nothing to hand over and says
   * so (`untaken`), so the recovery's reply is posted ahead of this one
   * the ordinary way — both already the paths for a placeholder that
   * could not be opened.
   */
  readonly streaming: boolean;
  /**
   * Whether the reply, and what the turn says before a tool, are posted a
   * paragraph to a message (`texts` mode). Never with `streaming`: there
   * is one placeholder to stream into.
   */
  private readonly texts: boolean;
  /**
   * Whether a text tags another agent, which `texts` mode then posts as
   * one message (card 1014): the tagged agent admits only a message that
   * names it, so a split reply reached it as the tagged part alone.
   */
  private readonly tagsAnAgent: ((text: string) => Promise<boolean>) | undefined;
  /**
   * The thread the loading status belongs to: the reply's thread, or the
   * message itself in a DM, whose reply has no thread to key one on.
   */
  readonly statusThread: string | undefined;
  /** Shared by a connection's renderers, so a status Slack refuses is said once, not per message. */
  private readonly statusWarned: { value: boolean };
  private loading = false;
  /**
   * Status calls, in order, so the last one Slack applies is the last one
   * sent — and so `finalize` can wait for them: a status that reached
   * Slack after the reply would stand over a finished turn until Slack's
   * own timeout, since the post that clears it came first.
   */
  private statusChain: Promise<void> = Promise.resolve();
  /**
   * The turn this one was queued behind has posted everything it will
   * (see `posted`). A streaming turn holds its place with the placeholder
   * it opened at intake; a `final` one has no placeholder, so it waits for
   * this before putting text or files in the thread — or a quick answer
   * would land above the slow one ahead of it.
   */
  private readonly after: Promise<unknown>;
  private settle!: () => void;
  /** Resolves once this turn has put in the thread everything it will. */
  readonly posted: Promise<void> = new Promise<void>((resolve) => {
    this.settle = resolve;
  });
  private statusText: string | undefined;
  private statusTimer: NodeJS.Timeout | undefined;
  /** The tool the turn is running, for the status line; the streamed `toolLine` is the other mode's. */
  private runningTool: string | undefined;
  /**
   * Calls started and not yet settled, by call id, oldest first. Core runs
   * a response's read-only calls together, so one can settle while another
   * still runs: both lines name the newest call still running, and clear
   * only once none is.
   */
  private readonly activeTools = new Map<string, string>();
  private readonly web: SlackWebLike;
  /**
   * The one person in the conversation when this turn is a DM: whoever sent
   * the message. Undefined in a channel, where who can see a thread is
   * Slack's membership to answer, not this turn's.
   */
  readonly dmWith: string | undefined;
  /** The conversation, and the thread in it, this turn replies into. */
  readonly channel: string;
  readonly threadTs: string | undefined;
  private readonly editIntervalMs: number;
  private readonly warn: (line: string) => void;
  private readonly now: () => number;

  constructor(
    web: SlackWebLike,
    channel: string,
    threadTs: string | undefined,
    editIntervalMs: number,
    warn: (line: string) => void,
    options: {
      lazy?: boolean;
      mayStaySilent?: boolean;
      now?: () => number;
      streaming?: boolean;
      texts?: boolean;
      tagsAnAgent?: (text: string) => Promise<boolean>;
      statusThread?: string;
      statusWarned?: { value: boolean };
      after?: Promise<unknown>;
      dmWith?: string;
      onInterim?: (heard: () => string, landed: Promise<boolean>) => void;
    } = {},
  ) {
    this.web = web;
    this.channel = channel;
    this.threadTs = threadTs;
    this.editIntervalMs = editIntervalMs;
    this.warn = warn;
    this.lazy = options.lazy ?? false;
    this.mayStaySilent = options.mayStaySilent ?? false;
    this.now = options.now ?? Date.now;
    this.streaming = options.streaming ?? true;
    this.texts = !this.streaming && options.texts === true;
    this.tagsAnAgent = options.tagsAnAgent;
    this.statusThread = options.statusThread ?? threadTs;
    this.statusWarned = options.statusWarned ?? { value: false };
    this.after = options.after ?? Promise.resolve();
    this.dmWith = options.dmWith;
    this.onInterim = options.onInterim;
  }

  /**
   * Show Slack's loading status for this turn, and keep it up until the
   * turn is finalized. Not for a streaming turn, which has its placeholder.
   * One nobody asked for waits for its first tool call: "is thinking…"
   * over every turn that only decides to say nothing is the interruption
   * silence exists to avoid, but one that went to work was missing its
   * status (card 1009).
   */
  showLoading(head: boolean): void {
    if (this.streaming || this.loading || this.finalized) {
      return;
    }
    if (this.lazy) {
      // Shown once it calls its first tool instead (card 1009): by then it
      // is working on something, and a status, unlike a placeholder,
      // leaves no trace when the turn still ends silent.
      this.loadOnFirstTool = true;
      return;
    }
    this.loading = true;
    // A thread has one status per app, so a turn queued behind another in
    // the same thread must not publish its own: it would overwrite what the
    // running turn says it is doing. It publishes when it reaches the head
    // (`beginTurn`, or `refreshLoading` once the turn ahead has posted).
    // The caller passes `head` for a queued turn whose status lives on a
    // key of its own — every DM message is — since it overwrites nothing.
    if (head) {
      this.publishLoading();
    }
  }

  private publishLoading(): void {
    if (this.statusTimer || this.finalized) {
      return;
    }
    this.setStatus(this.statusText ?? THINKING_STATUS);
    this.statusTimer = setInterval(() => this.refreshLoading(), STATUS_REFRESH_MS);
    this.statusTimer.unref?.();
  }

  /**
   * Set the status again. Slack clears a thread's status whenever the app
   * posts in it, so a reply or file from the turn ahead of this one — or
   * this turn's own upload — takes it down while this turn is still
   * working; the adapter calls this once that post has landed.
   */
  refreshLoading(): void {
    if (!this.loading || this.finalized) {
      return;
    }
    if (!this.statusTimer) {
      // Queued until now: this is the renderer at the head at last.
      this.publishLoading();
      return;
    }
    this.setStatus(this.statusText ?? THINKING_STATUS);
  }

  /**
   * A post of an app's landed in `channel` under `thread` from outside this
   * turn: `message.send` from another of its sessions, say. Slack clears
   * the app's status in a thread on any post of the app's there, so a turn
   * of the same app working in that thread puts its status back rather
   * than wait for the next refresh (card 1009). Another app's post clears
   * nothing of this one's.
   */
  appPosted(web: SlackWebLike, channel: string, thread: string): void {
    if (this.postsAs(web) && channel === this.channel && thread === this.statusThread) {
      this.refreshLoading();
    }
  }

  /** Whether this turn posts through `web`: the same agent's app. */
  postsAs(web: SlackWebLike): boolean {
    return web === this.web;
  }

  /**
   * A `message.say` line (card 1009): posted now, after whatever the turn
   * has already posted, and resolved once it landed. Refused, with a
   * sentence for the agent, on a turn that has already replied, a
   * streaming turn (its words show as they are written), and past
   * {@link SAY_LIMIT_PER_TURN}.
   */
  async say(text: string): Promise<void> {
    if (this.finalized) {
      throw new Error('This turn has already posted its reply, so a mid-task message has nowhere to go.');
    }
    if (this.streaming) {
      throw new Error('This conversation shows your words as you write them, so no separate message is needed. Just write it.');
    }
    if (this.saidMidTask >= SAY_LIMIT_PER_TURN) {
      throw new Error(`This turn already sent ${SAY_LIMIT_PER_TURN} mid-task messages. Put the rest in your reply.`);
    }
    // Counted before the post, so calls racing each other cannot pass the
    // limit, and given back when Slack refused it: a line that never
    // landed was not said (Codex round 2 on #513).
    this.saidMidTask += 1;
    if (!(await this.postLine(text, false))) {
      this.saidMidTask -= 1;
      throw new Error('Slack did not take the message. Say it in your reply.');
    }
  }

  private stopLoading(): void {
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = undefined;
    }
    this.loading = false;
  }

  private setStatus(text: string): void {
    const setStatus = this.web.assistant?.threads.setStatus;
    if (!setStatus || this.statusThread === undefined) {
      return;
    }
    this.statusText = text;
    const thread = this.statusThread;
    const loading = loadingMessage(text);
    // Not awaited by the caller: the turn never waits on a status. Only
    // `finalize` does, for the ordering reason on `statusChain`. A refusal
    // — a workspace or plan without it, a token Slack will not honour for
    // it — is said once and then left alone; the reply still arrives,
    // just without the status ahead of it.
    this.statusChain = this.statusChain
      .then(() => setStatus.call(this.web.assistant?.threads, {
        channel_id: this.channel,
        thread_ts: thread,
        status: text,
        ...(loading ? { loading_messages: [loading] } : {}),
      }))
      .then(() => undefined, (error: unknown) => {
        if (!this.statusWarned.value) {
          this.statusWarned.value = true;
          this.warn(
            `slack: could not show a loading status (${error instanceof Error ? error.message : String(error)}); `
            + 'replies still post when they are ready, without one',
          );
        }
      });
  }

  /**
   * The gateway has begun this renderer's turn. Whatever was streamed here
   * before now belonged to the turn ahead of it on the session chain — a
   * recovery's stream, routed to this renderer because it was at the head
   * of the queue — and is dropped, edits already scheduled for it
   * included, so this turn's placeholder starts empty.
   */
  beginTurn(): void {
    this.turnStarted = true;
    if (this.pendingEdit) {
      clearTimeout(this.pendingEdit);
      this.pendingEdit = undefined;
    }
    this.buffer = '';
    this.interim = '';
    this.streamedAfterTool = '';
    this.activeTools.clear();
    this.toolLine = undefined;
    this.runningTool = undefined;
    this.turnBreakPending = false;
    this.generation += 1;
    // Queued until now, this turn publishes its status as it starts; one
    // already showing may be showing a tool the turn ahead of it ran.
    if (this.loading && !this.statusTimer) {
      this.publishLoading();
    } else if (this.loading && this.statusText !== THINKING_STATUS) {
      this.setStatus(THINKING_STATUS);
    }
  }

  async open(): Promise<void> {
    const posted = await this.web.chat.postMessage({
      channel: this.channel,
      text: PLACEHOLDER_TEXT,
      ...(this.threadTs ? { thread_ts: this.threadTs } : {}),
    });
    if (posted.ts) {
      this.ref = { channel: posted.channel ?? this.channel, ts: posted.ts };
    }
  }

  onEvent(event: StratusEvent, ofThisTurn = true): void {
    if (this.finalized) {
      return;
    }
    if (event.type === 'session.tainted') {
      if (ofThisTurn && this.turnStarted) {
        this.taintedTo = this.taintedTo === undefined ? event.trust : leastTrusted(this.taintedTo, event.trust);
      }
      return;
    }
    if (event.type === 'provider.delta' && event.delta.type === 'text') {
      // Text from a new provider turn (after tools ran) must not fuse
      // with the previous turn's — "I'll check.The result is…" reads as
      // one garbled sentence for the whole duration of the final stream.
      if (this.turnBreakPending && this.buffer.trim().length > 0) {
        this.buffer += '\n\n';
      }
      this.turnBreakPending = false;
      this.buffer += event.delta.text;
      this.interim += event.delta.text;
      this.streamedAfterTool += event.delta.text;
      this.scheduleEdit();
      return;
    }
    if (event.type === 'provider.delta' && event.delta.type === 'reset') {
      // The provider abandoned its partial attempt (e.g. fallback after a
      // mid-stream failure): discard everything streamed so far so two
      // attempts never fuse into one message.
      this.buffer = '';
      this.interim = '';
      this.streamedAfterTool = '';
      this.turnBreakPending = false;
      this.scheduleEdit();
      return;
    }
    if (event.type === 'provider.response') {
      this.turnBreakPending = true;
      // A provider that answers in one piece streams no deltas: the
      // response is the only place its words before a tool call appear.
      // One that streamed them has them already, and is not given them twice.
      if (this.interim.trim().length === 0) {
        this.interim = event.parts
          .filter((part): part is Extract<ProviderPart, { type: 'text' }> => part.type === 'text')
          .map((part) => part.text)
          .join('');
      }
      return;
    }
    if (event.type === 'tool.called') {
      // Also a turn boundary. On the kernel path `provider.response` has
      // already marked one, and marking it twice costs nothing; on a
      // provider that hosts its own loop there is no provider.response at
      // all, so this is the only thing between the text before a tool and
      // the text after it — without it they fuse in the live message.
      this.turnBreakPending = true;
      this.activeTools.set(event.call.id, event.call.toolName);
      this.showActiveTool();
      this.flushInterim(ofThisTurn);
      if (ofThisTurn && this.turnStarted) {
        this.toolCalled = true;
        // Running, so at the head of its session: nothing of a turn ahead
        // is left for this status to overwrite.
        if (this.loadOnFirstTool && !this.finalized) {
          this.loadOnFirstTool = false;
          this.loading = true;
          this.publishLoading();
        }
      }
      this.scheduleEdit();
      return;
    }
    if (event.type === 'tool.denied') {
      // Denial settles a call that never reached tool.called, so nothing
      // else clears the status line or marks the boundary for it — the
      // message would keep claiming a refused tool is running, and the
      // model's follow-up would fuse with the text before the attempt.
      this.activeTools.delete(event.call.id);
      this.showActiveTool();
      this.turnBreakPending = true;
      // Words written before a call that was refused were still said
      // before a tool, and must not run into the next response's.
      this.flushInterim(ofThisTurn);
      this.scheduleEdit();
      return;
    }
    if (event.type === 'tool.completed') {
      this.activeTools.delete(event.result.callId);
      this.showActiveTool();
      // Settled here too for a call rejected before it ran, which never
      // reached `tool.called`; after one that did, this is empty.
      this.flushInterim(ofThisTurn);
      // Also a boundary, and not only for symmetry: a call rejected before
      // execution settles as tool.completed without ever having emitted
      // tool.called, so this is the only mark that attempt leaves.
      this.turnBreakPending = true;
      // Clear the visible status promptly: the next provider turn may be
      // non-streaming or slow to its first delta, and the message must not
      // claim a finished tool is still running that whole time.
      this.scheduleEdit();
      // Only this turn's files: a result the caller knows belongs to the
      // turn ahead of this one on the session chain — a recovery's
      // screenshot — would otherwise be uploaded in this turn's place in
      // the thread. The adapter holds it for the turn that produced it.
      if (event.result.ok && ofThisTurn) {
        for (const filePath of collectFilePaths(event.result)) {
          this.queueUpload(filePath);
        }
        const post = postOf(event.result);
        if (post !== undefined) {
          this.queuePost(post);
        }
      }
    }
  }

  /**
   * Upload files a turn produced that no event delivered: a repeat of a
   * finished turn has only the session to read them from (`turnFilesFor`),
   * and a path written since then is refused (see `readUnchangedSince`).
   */
  queueFiles(files: ReadonlyArray<{ path: string; producedAt: string }>): void {
    for (const file of files) {
      this.queueUpload(file.path, Date.parse(file.producedAt));
    }
  }

  // Tool results that reference local output files (a screenshot, a
  // generated report) become real attachments in the conversation — the
  // channel contract's upload operation. Uploads chain so they land in
  // order and finalize() waits for them.
  private queueUpload(filePath: string, producedAt?: number): void {
    // Behind a handover in progress, for the same reason edits and the
    // finalize are: the turn being handed the placeholder has its own
    // attachments to put in the thread first, and an upload is a message
    // of its own — one sent now would sit above them and read as this
    // turn's answer arriving first. Captured at queue time, not read when
    // the chain runs: a handover that begins after this upload waits for
    // it, and an upload that then waited for that handover would be a
    // cycle nothing breaks (see `queueEdit`).
    const handover = this.handover;
    const after = this.streaming ? undefined : this.after;
    this.uploadChain = this.uploadChain
      .then(() => handover)
      .then(() => after)
      // Read as file DATA inside the chain: the Web API takes contents,
      // not a path, and a missing file surfaces as this upload's own
      // failure instead of an unhandled stream error.
      .then(async () => {
        const data = producedAt === undefined ? await readFile(filePath) : await readUnchangedSince(filePath, producedAt);
        // Where the file will sit is Slack's to say — the ts of the
        // message it becomes, in the shares the upload answers with. When
        // the answer carries none, the clock stands in, read BEFORE the
        // call: the file is posted somewhere inside it, and a colleague's
        // placeholder posted while the answer was on its way back sits
        // below the file. Read after, the file would be placed below that
        // placeholder and take a thread the colleague holds; read before,
        // the error runs the other way, toward the colleague — the fault
        // an @ fixes.
        const before = slackTs(this.now());
        const result = await this.web.files.uploadV2({
          channel_id: this.channel,
          file: data,
          filename: path.basename(filePath),
          ...(this.threadTs ? { thread_ts: this.threadTs } : {}),
        });
        this.uploaded = true;
        // The upload is a post of the app's in this thread, which takes
        // the status down with it while the turn is still working.
        this.refreshLoading();
        const placed = uploadPlace(result, this.channel) ?? before;
        if (this.uploadedAt === undefined || placed > this.uploadedAt) {
          this.uploadedAt = placed;
        }
      })
      .catch((error) => this.warn(`files.uploadV2 failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}`));
  }

  /**
   * Post a tool's ready-made message (`postToolPost`) in the thread, on the
   * upload chain and under its rules, so it lands in order with the turn's
   * files and words and `finalize` waits for it. For every rule here a post
   * that landed is what a file that landed is: something the turn said,
   * placed where Slack put it. A repeat of a finished turn queues the ones
   * the session holds (`turnPostsFor`), which no event delivers.
   */
  queuePost(post: ToolPost): void {
    const handover = this.handover;
    const after = this.streaming ? undefined : this.after;
    this.uploadChain = this.uploadChain
      .then(() => handover)
      .then(() => after)
      .then(async () => {
        const posted = await postToolPost(this.web, { channel: this.channel, thread: this.threadTs }, post, this.warn);
        this.uploaded = true;
        this.refreshLoading();
        if (posted.ts !== undefined && (this.uploadedAt === undefined || posted.ts > this.uploadedAt)) {
          this.uploadedAt = posted.ts;
        }
      })
      .catch((error) => this.warn(`chat.postMessage failed for a tool's post: ${error instanceof Error ? error.message : String(error)}`));
  }

  /**
   * Post what the model said before the first tool it calls, in `final`
   * and `texts` mode only: a streaming turn already shows it in its
   * placeholder. Behind the turn ahead and any handover, on the upload
   * chain, so the first line, files, and the reply land in the order they
   * happened. Words written after that are held, not posted (card 1009),
   * and so are all of a lazy turn's: a turn nobody asked for must not
   * speak before it decides to (card 1060).
   */
  private flushInterim(ofThisTurn: boolean): Promise<boolean> | undefined {
    const text = this.interim.trim();
    this.interim = '';
    this.streamedAfterTool = '';
    if (this.streaming || !this.turnStarted || !ofThisTurn || text.length === 0) {
      return undefined;
    }
    // Only words before the turn's first tool are a message of their own:
    // after one, a step has run, and what follows is the model working,
    // whether or not the turn opened with a line. It is held: posted, it
    // is the running commentary a person has to scroll past (card 1009).
    // A lazy turn's are held from the start, so a hosted-loop reply that
    // joins them in is stripped of them like any other turn's.
    if (this.lazy || this.firstWordsSaid || this.toolCalled) {
      this.held.push(text);
      this.lastWasHeld = true;
      return undefined;
    }
    this.firstWordsSaid = true;
    return this.postLine(text, true);
  }

  /**
   * Post one line of the turn's into its thread, behind the turn ahead and
   * any handover, on the upload chain, so it lands after everything the
   * turn posted before it. Resolves with whether any of it landed. The
   * first line (card 950) is also what a hosted-loop reply is stripped of;
   * a `message.say` line is not, since the reply never contained it.
   */
  private postLine(text: string, first: boolean): Promise<boolean> {
    const handover = this.handover;
    const after = this.after;
    let heard = '';
    let settleLanded!: (landed: boolean) => void;
    const landedNow = new Promise<boolean>((resolve) => {
      settleLanded = resolve;
    });
    this.onInterim?.(() => heard, landedNow);
    this.uploadChain = this.uploadChain
      .then(() => handover)
      .then(() => after)
      .then(async () => {
        const landed: string[] = [];
        let chunks: string[] = [];
        try {
          // A `message.say` line is one message in every reply mode: split
          // at its paragraphs, one call would post several, past the
          // per-turn cap (Codex on #513).
          chunks = first ? await this.chunksOf(text) : [text];
          for (const chunk of chunks) {
            // A part that tags another agent carries all of these words (card 1033).
            const whole = chunks.length > 1 && await this.tagsAnAgent?.(chunk) ? text : undefined;
            const posted = await postPart(this.web, { channel: this.channel, thread: this.threadTs, text: chunk, whole }, this.warn);
            this.placeText(posted.ts);
            landed.push(chunk);
          }
        } finally {
          // Whatever landed was said, whole or not: it counts as speaking,
          // and the others hear it. Only a message that landed whole is
          // stripped from a hosted-loop reply; part of one is left in the
          // reply, where repeating a few lines beats losing the rest.
          if (landed.length > 0) {
            this.interimPosted = true;
            heard = landed.length === chunks.length ? text : landed.join('\n\n');
          }
          settleLanded(landed.length > 0);
        }
        if (first) {
          this.lastInterim = text;
          this.interimSaid.push(text);
        }
        // A post of the app's in this thread takes the status down while
        // the turn is still working; put it back.
        this.refreshLoading();
      })
      .catch((error) => this.warn(`chat.postMessage failed for ${first ? 'an interim' : 'a mid-task'} message: ${error instanceof Error ? error.message : String(error)}`))
      // Settled whatever happened above, or the other agents' intake would
      // wait on it for good. A second settle is a no-op.
      .finally(() => settleLanded(false));
    return landedNow;
  }

  /**
   * Post what the model said before a call that is about to ask for
   * approval, and resolve once it has landed (or could not), or at once
   * when there is nothing to post (card 950).
   *
   * The prompt is posted before the call starts, so waiting for
   * `tool.called` put the question above the line saying what the agent
   * set out to do, and the approver answered without it. The same flush
   * `tool.called` would have done, only earlier: what it posts is stripped
   * from the reply as before, and the flush at `tool.called` finds nothing.
   */
  sayBeforeAsking(ofThisTurn: boolean): Promise<boolean> | undefined {
    if (this.finalized) {
      return undefined;
    }
    return this.flushInterim(ofThisTurn);
  }

  /**
   * Everything this turn said in the thread, for its other agents to hear:
   * the interim messages that landed, then the reply unless it only
   * repeats the last of them. Read once the turn's posts have landed.
   */
  spokenText(reply: string): string {
    if (reply.trim().length === 0) {
      return '';
    }
    return this.postedReply ?? this.unsaid(reply);
  }

  /**
   * The part of a reply that is not the first line or words held after it.
   * A provider that hosts its own loop (codex) returns every message of
   * the turn joined into one reply, so those are stripped from its front
   * in order; one whose last words came before its final tool call returns
   * just those words, which are already accounted for.
   */
  private unsaid(reply: string): string {
    let rest = reply.trim();
    // Whole messages only, at the separator the codex provider joins them
    // with: a reply of its own that merely begins with the same words
    // ("Sure" then "Sure, the build passes.") is not cut.
    for (const said of [...this.interimSaid, ...this.held]) {
      if (rest === said) {
        rest = '';
      } else if (rest.startsWith(`${said}\n\n`)) {
        rest = rest.slice(said.length + 2).trimStart();
      } else {
        break;
      }
    }
    const last = this.lastWasHeld ? this.held.at(-1) : this.lastInterim;
    return rest === last ? '' : rest;
  }

  /** Point both status lines at the newest call still running, or clear them. */
  private showActiveTool(): void {
    const running = [...this.activeTools.values()].at(-1);
    this.runningTool = running;
    this.toolLine = running === undefined ? undefined : `⚙ ${running}…`;
  }

  private currentText(): string {
    const parts = [this.buffer.trim(), this.toolLine].filter((part): part is string => Boolean(part && part.length > 0));
    return parts.length > 0 ? parts.join('\n\n') : PLACEHOLDER_TEXT;
  }

  private scheduleEdit(): void {
    if (!this.streaming) {
      // Nothing to edit: what the turn is doing goes into the status line,
      // and only once the turn is this renderer's own (see `beginTurn`).
      const status = this.runningTool !== undefined ? toolStatus(this.runningTool) : THINKING_STATUS;
      if (this.loading && this.statusTimer && this.turnStarted && !this.finalized && status !== this.statusText) {
        this.setStatus(status);
      }
      return;
    }
    // Not gated on having a placeholder: during a handover there is none
    // for a moment, and the edit reads the fresh one when its turn comes.
    if (this.pendingEdit) {
      return;
    }
    const elapsed = Date.now() - this.lastEditAt;
    const delay = Math.max(0, this.editIntervalMs - elapsed);
    this.pendingEdit = setTimeout(() => {
      this.pendingEdit = undefined;
      if (this.finalized) {
        return;
      }
      // Nothing said yet: a lazy turn has no placeholder to edit, and a
      // tool line alone does not earn one (see `lazy`). Nor does text
      // streamed here before this turn began — a recovery's, routed to
      // the head of the queue — which `beginTurn` drops.
      if (this.lazy && !this.ref && (!this.turnStarted || this.buffer.trim().length === 0)) {
        return;
      }
      this.lastEditAt = Date.now();
      void this.queueEdit(messageText(this.currentText()));
    }, delay);
    this.pendingEdit.unref?.();
  }

  /**
   * Queue one edit of the placeholder. Resolves to whether Slack took it —
   * false when there was no placeholder to edit, the text belonged to a
   * turn handed over meanwhile, or the update was refused — which is what
   * lets `finalize` say whether the reply was ever published.
   */
  private queueEdit(text: string): Promise<boolean> {
    const generation = this.generation;
    // The handover as it stands when the edit is queued, not when it runs:
    // a handover that begins after this edit waits for this edit, and an
    // edit that then waited for that handover would be a cycle nothing
    // could break.
    const handover = this.handover;
    const edit = this.editChain
      .then(() => handover)
      .then(async () => {
        if (this.lazy && !this.ref && this.turnStarted && generation === this.generation) {
          // The first text of a turn nobody asked for: this is where its
          // placeholder is posted, and the edit below fills it. A post
          // that fails leaves the turn without one, and its reply is a
          // message of its own when it comes (see `finalize`).
          try {
            await this.open();
          } catch (error) {
            this.warn(`could not open a placeholder: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        // Read after the handover, not before: the placeholder may have
        // changed hands while this edit waited its turn — and the text
        // may belong to the turn that was handed over.
        const ref = this.ref;
        if (!ref || generation !== this.generation) {
          return false;
        }
        await this.web.chat.update({ channel: ref.channel, ts: ref.ts, text });
        this.edited = true;
        this.placeText(ref.ts);
        return true;
      })
      .catch((error) => {
        this.warn(`chat.update failed: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      });
    this.editChain = edit.then(() => undefined);
    return edit;
  }

  /**
   * Replace the placeholder with the final reply, splitting if oversized.
   * Resolves to a `ReplyOutcome`. A reply Slack refused any part of was
   * not said in the thread as written, and nothing downstream may treat it
   * as if it had been: a colleague hearing the whole of a reply the thread
   * saw half of is reasoning from text nobody read. But a file beside a
   * refused sentence is still the last thing said, for the thread rule.
   */
  async finalize(reply: string): Promise<ReplyOutcome> {
    try {
      return await this.finalizeInOrder(reply);
    } finally {
      this.settle();
    }
  }

  private async finalizeInOrder(reply: string): Promise<ReplyOutcome> {
    await this.handover;
    // Shown, not merely wanted: a turn still queued behind another never
    // published one, and a clear from it would take down the running
    // turn's status instead.
    const hadStatus = this.statusTimer !== undefined;
    this.stopLoading();
    this.finalized = true;
    if (!this.streaming) {
      await this.after;
      await this.statusChain;
    }
    if (this.pendingEdit) {
      clearTimeout(this.pendingEdit);
      this.pendingEdit = undefined;
    }
    // Let the edits already queued land before deciding anything from
    // `ref`: a lazy turn's first text may be opening its placeholder in
    // that chain right now, and reading `ref` ahead of it would post the
    // reply as a message of its own beside a placeholder that then fills
    // with stale partial text.
    await this.editChain;
    // A turn nobody asked for says only what it wrote after its last tool.
    // What came before was held, and a provider that hosts its own loop
    // (codex) joins it into the reply, so it is stripped here, before
    // silence is judged: a reply that is only that narration is the
    // decision to stay out, not something to post (card 1060). Nor are
    // held words ever promoted to its answer, as another turn's are below.
    // A reply that is exactly what it streamed after its last tool is its
    // last message alone, from a provider that returns only that: kept
    // whole, even where it repeats words it held (Codex on #573).
    if (this.lazy && this.held.length > 0) {
      const streamed = this.streamedAfterTool.trim();
      if (streamed.length > 0 && reply.trim() === streamed) {
        this.postedReply = streamed;
      } else {
        reply = this.unsaid(reply);
      }
    }
    if (this.lazy && reply.trim().length === 0 && (!this.ref || await this.retract())) {
      // Silence, decided: nothing was posted and nothing is — or what was
      // posted has been taken back. The uploads still land: a file the
      // turn produced is not nothing to say, and a turn that posted one
      // has spoken, for the thread rule.
      await this.editChain;
      await this.uploadChain;
      // A status it showed from its first tool has no post to take it
      // down, so it is cleared here.
      if (hadStatus) {
        this.setStatus('');
        await this.statusChain;
      }
      return this.outcome(false, this.uploaded);
    }
    // The first line lands before the reply is judged: one that already
    // said what the reply says (the model's only words came before a tool
    // call) is not posted again, and a turn that said it is not followed
    // by `(no reply)`.
    await this.uploadChain;
    // Words the turn ended on, written before its last tool call, are its
    // answer: a reply that only repeats them, or an empty one, posts them
    // as the reply. They were held, so this is the first the thread sees
    // of them. Any other held words stay unsaid (card 1009). That holds on
    // a reply-optional turn too (card 601): its words between tools were
    // held, so they are the only way an answer written before its last
    // tool call reaches the thread, and silence is judged after them.
    if (!this.lazy && !this.ref && (this.interimPosted || this.held.length > 0)) {
      const rest = this.unsaid(reply);
      const lastHeld = this.held.at(-1);
      if (rest.length === 0 && this.lastWasHeld && lastHeld !== undefined) {
        this.postedReply = lastHeld;
        reply = lastHeld;
      } else {
        reply = rest;
      }
    }
    // A reply-optional turn that ended with nothing to say, its last words
    // not held ones that stand in for an answer (card 601).
    const silent = this.mayStaySilent && reply.trim().length === 0;
    if (silent && (!this.ref || await this.retract())) {
      // No `(no reply)`, and a placeholder it opened is taken back. Its
      // first line, and the files it posted, stay: they were said.
      await this.uploadChain;
      // Nothing posts after this to take the status down, so it is cleared.
      if (hadStatus) {
        this.setStatus('');
        await this.statusChain;
      }
      const spoke = this.interimPosted || this.uploaded;
      return this.outcome(this.interimPosted, spoke);
    }
    if (!this.ref && this.interimPosted && reply.trim().length === 0) {
      // Nothing posts after this to take the status down, so it is cleared.
      if (hadStatus) {
        this.setStatus('');
        await this.statusChain;
      }
      return this.outcome(true, true);
    }
    const text = reply.trim().length > 0 ? reply : NO_REPLY_TEXT;
    const chunks = await this.chunksOf(text);
    // A first part that tags another agent would reach Slack as an edit of
    // the placeholder, and an edit starts no agent's turn (Slack sends it
    // as message_changed): it is posted as a message of its own instead,
    // the placeholder taken back (card 1054). One Slack won't let go is
    // edited, as before.
    if (this.ref && await this.tagsAnAgent?.(chunks[0] ?? '')) {
      await this.retract();
    }
    // No placeholder — a handover could not open a fresh one, or it was
    // taken back above — and the reply is a message of its own rather than
    // nothing at all.
    const rest = this.ref ? chunks.slice(1) : chunks;
    const edited = this.ref ? this.queueEdit(chunks[0] ?? NO_REPLY_TEXT) : Promise.resolve(false);
    let landed = await edited;
    let published = this.ref ? landed : true;
    await this.editChain;
    await this.uploadChain;
    for (const chunk of rest) {
      try {
        // A part that tags another agent carries the whole reply (card 1033).
        const whole = chunks.length > 1 && await this.tagsAnAgent?.(chunk) ? text : undefined;
        const posted = await postPart(this.web, { channel: this.channel, thread: this.threadTs, text: chunk, whole }, this.warn);
        landed = true;
        this.placeText(posted.ts);
      } catch (error) {
        published = false;
        this.warn(`chat.postMessage failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // A placeholder that opened for a turn nobody asked for and never
    // took a word of it — every edit refused — is a `…` standing alone
    // under the agent's name, the interruption a judged turn exists to
    // avoid, so it is taken back like an abandoned attempt's. One Slack
    // will not let go stands, and a message the thread can see is the
    // last thing said whatever it says.
    let stranded = false;
    if (this.lazy && this.ref !== undefined && !landed && !this.edited) {
      stranded = !(await this.retract());
      if (stranded) {
        this.placeText(this.ref?.ts);
      }
    }
    // A reply posted into the status's thread clears the status itself;
    // one Slack refused would leave "is thinking…" standing over a turn
    // that has ended. So would one posted anywhere else: a top-level DM
    // reply keys its status to the message it answers (`statusThread`),
    // but posts beside it rather than under it, and Slack never clears it.
    if (hadStatus && (!landed || this.threadTs !== this.statusThread)) {
      this.setStatus('');
      // Awaited: the turn queued behind this one re-shows its own status
      // once this renderer is done, and a clear that reached Slack after
      // that would take the next turn's status down with it.
      await this.statusChain;
    }
    return this.outcome(published, landed || this.edited || this.uploaded || stranded, !published);
  }

  /**
   * This turn's text as the messages it is posted as, in this agent's reply
   * mode: `texts` splits it a paragraph to a message unless it tags another
   * agent.
   */
  private async chunksOf(text: string): Promise<string[]> {
    const texts = this.texts && !(await this.tagsAnAgent?.(text));
    return messageChunks(text, texts ? 'texts' : undefined);
  }

  private placeText(ts: string | undefined): void {
    if (ts !== undefined && (this.textAt === undefined || ts > this.textAt)) {
      this.textAt = ts;
    }
  }

  private outcome(published: boolean, spoke: boolean, refused = false): ReplyOutcome {
    const spokeAt = [this.textAt, this.uploadedAt]
      .filter((ts): ts is string => ts !== undefined)
      .sort()
      .at(-1);
    return { published, spoke, ...(spoke && spokeAt !== undefined ? { spokeAt } : {}), ...(refused ? { refused: true as const } : {}) };
  }

  /**
   * Take back the placeholder a turn nobody asked for opened and then had
   * nothing to put in: the line that opened it was an attempt the provider
   * abandoned (`reset` — a fallback after a mid-stream failure), and the
   * attempt that stood answered with nothing. Editing that placeholder to
   * `(no reply)` would leave exactly the interruption a silent turn exists
   * to avoid, and would count as speaking. Resolves to whether Slack let
   * the message go: a delete refused leaves the abandoned line standing,
   * and the turn finishes the ordinary way, since a message the thread
   * can still see is the last thing said whatever it says.
   */
  private async retract(): Promise<boolean> {
    const ref = this.ref;
    if (!ref) {
      return true;
    }
    try {
      await this.web.chat.delete({ channel: ref.channel, ts: ref.ts });
    } catch (error) {
      this.warn(`chat.delete failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    this.ref = undefined;
    // The line the placeholder took is gone with it: nothing of this
    // turn's stands in the thread unless a file does.
    this.edited = false;
    this.textAt = undefined;
    return true;
  }

  /**
   * Stand down without saying anything: the message this renderer was
   * opened for repeated one whose turn another delivery in this process
   * is still waiting on, and that delivery posts the answer. Whatever this
   * renderer put up — a placeholder, a loading status — comes down, so a
   * redelivery leaves no trace.
   */
  async withdraw(): Promise<void> {
    try {
      await this.handover;
      const hadStatus = this.statusTimer !== undefined;
      this.stopLoading();
      this.finalized = true;
      // The barrier `finalizeInOrder` takes, for the same reason: the turn
      // queued behind this one waits on `posted`, and settling it before
      // the reply ahead has posted would let that turn's reply overtake it.
      if (!this.streaming) {
        await this.after;
        await this.statusChain;
      }
      if (this.pendingEdit) {
        clearTimeout(this.pendingEdit);
        this.pendingEdit = undefined;
      }
      await this.editChain;
      // A repeat can queue files the report ahead of it could not post
      // and then stand down: they land before it settles.
      await this.uploadChain;
      await this.retract();
      if (hadStatus) {
        this.setStatus('');
        await this.statusChain;
      }
    } finally {
      this.settle();
    }
  }

  /**
   * Ends a turn an approver stopped from Slack: says who stopped it where
   * the reply would have gone. A turn nobody asked for that had said
   * nothing stays silent, as its failure would.
   */
  async stopped(by: string): Promise<ReplyOutcome> {
    await this.editChain;
    if (this.lazy && !this.ref && this.buffer.trim().length === 0) {
      return this.finalize('');
    }
    return this.finalize(`Stopped by <@${by}>.`);
  }

  /**
   * `refused` is a turn the host stopped on purpose (`HostRefusalError`), a
   * spent budget, whose message is already a sentence for the person
   * reading it. Framed as something having gone wrong, it would read as a
   * fault to report when it is a limit working.
   */
  async fail(message: string, refused = false): Promise<ReplyOutcome> {
    // The same wait `finalize` takes, for the same reason: a lazy turn's
    // first text may be opening its placeholder right now, and a failure
    // read as "before saying anything" would leave that placeholder saying
    // `(no reply)` where the failure belongs.
    await this.editChain;
    // "Before saying anything" is no placeholder AND nothing buffered: a
    // first text whose zero-delay edit has not fired yet has still been
    // said, and its failure is reported — as a message of its own, since
    // there is no placeholder to edit — rather than swallowed with it.
    if (this.lazy && !this.ref && this.buffer.trim().length === 0) {
      // A turn nobody asked for that failed before saying anything: the
      // failure is in the daemon log, and an error note would be the
      // interruption the turn existed to avoid.
      this.warn(`a turn nobody asked for failed before saying anything: ${message}`);
      return this.finalize('');
    }
    // A spent budget is a limit working, not a fault.
    return this.finalize(refused ? message : `Something went wrong: ${message}`);
  }

  /**
   * Claim the placeholder for a turn that finished ahead of this one — the
   * recovery this renderer was queued behind — without yet knowing what
   * that turn has to say. Slack keeps a message's place when it is edited,
   * so the earlier turn's reply lands above this turn's, in the order the
   * conversation happened; posted as a new message instead, it would sit
   * below a placeholder that was posted first.
   *
   * The claim is made synchronously, so it is in place before the caller
   * awaits anything (see `HandoverClaim`).
   */
  reserveHandover(): HandoverClaim {
    // One handover at a time: two turns ahead of this one finishing close
    // together would otherwise both take the placeholder as they found it,
    // and the second would write over the first's reply. Each waits for
    // the one before it and takes the placeholder that reopen left.
    // The edits to let through first are the ones queued before this
    // handover existed; those queued after it wait for it (see `queueEdit`),
    // so waiting on the live chain here would wait on them in return.
    const drained = this.editChain;
    const previous = this.handover;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.handover = previous.then(() => held);
    let spent = false;
    const settle = (): void => {
      if (!spent) {
        spent = true;
        release();
      }
    };
    return {
      take: async (chunks, between, whole) => {
        if (spent) {
          return 'untaken';
        }
        try {
          await previous;
          return await this.handoverTo(chunks, drained, between, whole);
        } finally {
          settle();
        }
      },
      release: settle,
    };
  }

  /**
   * The body of a handover, running with the placeholder already claimed:
   * edit it to the earlier turn's first chunk, post the rest, run whatever
   * else that turn has to put in the thread, and reopen a placeholder for
   * this turn below it all.
   */
  private async handoverTo(
    chunks: readonly string[],
    drained: Promise<void>,
    between: (() => Promise<void>) | undefined,
    whole?: string,
  ): Promise<'complete' | 'partial' | 'untaken'> {
    const [first, ...rest] = chunks;
    const given = this.ref;
    if (first === undefined || this.finalized || !given) {
      return 'untaken';
    }
    await drained;
    // A first part that tags another agent is not edited in, since an edit
    // starts no agent's turn (card 1054): the placeholder is taken back and
    // every part posted, and the one reopened below keeps the order.
    const posted = this.ref === given && await this.tagsAnAgent?.(first) === true && await this.retract();
    if (!posted) {
      try {
        await this.web.chat.update({ channel: given.channel, ts: given.ts, text: first });
      } catch (error) {
        // Not handed over: the placeholder is still this turn's, and the
        // caller posts the reply as messages of its own.
        this.warn(`chat.update failed: ${error instanceof Error ? error.message : String(error)}`);
        return 'untaken';
      }
    }
    let complete = true;
    // The placeholder is the earlier turn's now, and the reference goes
    // before the reopen, so a reopen that fails cannot leave this turn
    // writing over the reply just handed over. (What was streamed into
    // it is dealt with by `beginTurn`, at the boundary that actually
    // separates the two turns' output.)
    this.ref = undefined;
    for (const chunk of posted ? chunks : rest) {
      try {
        // A part that tags another agent carries the whole reply (card 1033).
        const full = whole !== undefined && await this.tagsAnAgent?.(chunk) ? whole : undefined;
        await postPart(this.web, { channel: this.channel, thread: this.threadTs, text: chunk, whole: full }, this.warn);
      } catch (error) {
        complete = false;
        this.warn(`chat.postMessage failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Anything else the earlier turn has to put in the thread goes here,
    // while this renderer still has no placeholder of its own: a message
    // posted after the reopen would sit below this turn's answer, which
    // is the order the handover exists to keep.
    if (between) {
      await between();
    }
    try {
      await this.open();
    } catch (error) {
      // No placeholder for this turn, then: its reply is posted as a
      // message of its own when it comes (see `finalize`).
      this.warn(`could not reopen a placeholder: ${error instanceof Error ? error.message : String(error)}`);
    }
    return complete ? 'complete' : 'partial';
  }
}

// The file-bearing result convention is the kernel's (`filePathsOf`), so
// the gateway counts a turn that produced a file as having spoken by the
// same rule this adapter uploads it by.
export const collectFilePaths = (result: ToolResult): string[] => filePathsOf(result);

// A hard cut must never land between the halves of a UTF-16 surrogate
// pair — an emoji on the boundary would reach Slack as two replacement
// characters. Backs the index off the pair's high half when it would.
const safeCutIndex = (text: string, index: number): number => {
  const code = text.charCodeAt(index - 1);
  return code >= 0xd800 && code <= 0xdbff ? index - 1 : index;
};

/** `index` moved forward, never back, off the middle of a surrogate pair. */
const pastCodePoint = (text: string, index: number): number => {
  const code = text.charCodeAt(index - 1);
  return code >= 0xd800 && code <= 0xdbff ? index + 1 : index;
};

/**
 * `cut` moved in front of any Slack markup it would land inside — a link
 * `<https://…>` or `<https://…|label>`, a mention `<@U…>` — when that still
 * leaves half a message. Cut through, the first message ends on an
 * unterminated `<https://…` and the next starts with the rest of the
 * address and a stray `>`, and neither half is a link. Markup is one line,
 * so only the cut's own line is looked at.
 */
const outsideSlackMarkup = (text: string, cut: number): number => {
  const open = text.lastIndexOf('<', cut - 1);
  if (open <= SLACK_MAX_MESSAGE_CHARS / 2) {
    return cut;
  }
  const closedBefore = text.lastIndexOf('>', cut - 1);
  const lineBreak = text.lastIndexOf('\n', cut - 1);
  if (closedBefore > open || lineBreak > open) {
    return cut;
  }
  const close = text.indexOf('>', cut);
  const nextLine = text.indexOf('\n', cut);
  if (close === -1 || (nextLine !== -1 && nextLine < close)) {
    return cut;
  }
  return open;
};

const truncateForSlack = (text: string): string =>
  text.length <= SLACK_MAX_MESSAGE_CHARS
    ? text
    : `${text.slice(0, safeCutIndex(text, SLACK_MAX_MESSAGE_CHARS - 1))}…`;

/**
 * Text as however many messages Slack's limit makes it, never leaving a
 * code block broken across the cut. A cut blind to fences ended one
 * message on an unterminated block and started the next mid-block, where
 * Slack read the rest of somebody's log as prose — every `*` and `_` in it
 * formatting. So a cut that would land inside a code run moves in front of
 * it when that still leaves a message worth sending, and otherwise closes
 * the run at the cut and reopens it in the next.
 */
const splitForSlack = (text: string): string[] => {
  if (text.length <= SLACK_MAX_MESSAGE_CHARS) {
    return [text];
  }
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > SLACK_MAX_MESSAGE_CHARS) {
    // Prefer a newline break inside the window; fall back to a hard cut.
    const window = rest.slice(0, SLACK_MAX_MESSAGE_CHARS);
    const newline = window.lastIndexOf('\n');
    const cut = newline > SLACK_MAX_MESSAGE_CHARS / 2 ? newline : safeCutIndex(rest, SLACK_MAX_MESSAGE_CHARS);
    // Scanned two messages deep, not to the end: rescanning the whole rest
    // for every chunk made a megabyte reply quadratic on the event loop. A
    // fence that closes past the window still reads as open to its end,
    // which is what it is here; an inline span that does is longer than a
    // message, and is cut as text either way.
    const run = codeRunsOf(rest.slice(0, SLACK_MAX_MESSAGE_CHARS * 2))
      .find((candidate) => candidate.start < cut && cut < candidate.end);
    if (run !== undefined && run.start > SLACK_MAX_MESSAGE_CHARS / 4) {
      chunks.push(rest.slice(0, run.start).replace(/\n+$/, ''));
      rest = rest.slice(run.start);
      continue;
    }
    // The run is most of the message, so it is cut itself — at its last
    // newline that leaves room for the closer, and past its opener so the
    // continuation always makes progress. A continuation reopens with the
    // info string only while it is short: a two-thousand-character info
    // line repeated on every part would crowd out the code it labels.
    const budget = SLACK_MAX_MESSAGE_CHARS - (run?.closer.length ?? 0);
    const floor = run === undefined ? 0 : run.start + run.opener.length;
    const reopen = run === undefined || run.opener.length <= SLACK_MAX_MESSAGE_CHARS / 8
      ? run?.opener
      : run.opener.endsWith('\n') ? `${run.closer.slice(1)}\n` : run.opener;
    // A delimiter too long to close and reopen inside one message — a fence
    // of a thousand backticks, an opening line that fills the window — is
    // cut raw, as before this existed. Reopening it would send a message
    // over the limit, and consume a character a message after that.
    // Only a fence is reopened. Its closer and opener sit on lines of their
    // own, so they can never run into a backtick of the code; an inline
    // span's would, and `x` + `` would read as a different delimiter.
    // `floor + 2`: the first cut past the opener has to fit a whole code
    // point, or the step that guarantees progress lands inside an emoji.
    const fence = run !== undefined && run.closer.startsWith('\n');
    if (run === undefined || !fence || reopen === undefined || reopen.length + run.closer.length > SLACK_MAX_MESSAGE_CHARS / 4 || floor + 2 > budget) {
      const at = run === undefined ? outsideSlackMarkup(rest, cut) : cut;
      chunks.push(rest.slice(0, at));
      rest = rest.slice(at).replace(/^\n+/, '');
      continue;
    }
    const inner = rest.lastIndexOf('\n', budget - 1);
    const within = inner > Math.max(floor, SLACK_MAX_MESSAGE_CHARS / 2) ? inner : Math.max(safeCutIndex(rest, budget), pastCodePoint(rest, floor + 1));
    chunks.push(`${rest.slice(0, within)}${run.closer}`);
    rest = `${reopen}${rest.slice(within).replace(/^\n/, '')}`;
  }
  if (rest.length > 0) {
    chunks.push(rest);
  }
  return chunks;
};

/**
 * Agent text as one Slack message: converted, then sized.
 *
 * These two are the only ways anything an agent wrote reaches Slack, so
 * mrkdwn is a property of the send path rather than something each call
 * site has to remember — the reason the streamed placeholder and the final
 * reply cannot end up in different markup.
 */
export const messageText = (text: string): string => truncateForSlack(toSlackMrkdwn(text));

/**
 * Agent text as however many Slack messages it takes. Converted before it
 * is split, so a chunk is measured at the length it will be sent at, and so
 * no rewrite is ever asked to span a boundary.
 *
 * In `texts` mode a reply is first cut into the few messages it is texted
 * as, each then converted and sized on its own: the cuts never fall inside
 * code, and nothing else in the conversion crosses a line.
 */
export const messageChunks = (text: string, replies?: SlackReplyMode): string[] =>
  (replies === 'texts' ? textingParts(text) : [text]).flatMap((part) => splitForSlack(toSlackMrkdwn(part)));
