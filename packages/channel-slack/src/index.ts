import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { latestTurnReply, type ApprovalAnswer, type JsonObject, type Session, type StratusEvent, type ToolResult } from '@stratusagent/core';
import {
  channelSessionKey,
  type ChannelAdapter,
  type GatewayLike,
  type OutboundAddress,
  type OutboundConnection,
  type OutboundMessageRef,
} from '@stratusagent/channels';

const SLACK_MAX_MESSAGE_CHARS = 4000;
const DEFAULT_EDIT_INTERVAL_MS = 1000;
const DEDUPE_CAPACITY = 2000;
/**
 * How many threads' addressees are remembered in receipt order. Past this
 * the least recently addressed is dropped, which costs its next follow-up
 * one session lookup — the durable answer, which is what a restart falls
 * back to anyway.
 */
const THREAD_ADDRESSEE_CAPACITY = 2000;
/**
 * How many cold verdicts are remembered. Far smaller than the addressee
 * map: one is wanted only while the agents sharing a thread resolve the
 * same message, and the addressee record answers for every message after.
 */
const COLD_VERDICT_CAPACITY = 256;
/**
 * How many files an unrendered turn may queue for its outcome. Nothing
 * drains that queue until the outcome arrives, so a session whose outcome
 * this process never sees would otherwise grow it for the life of the
 * daemon. Twenty is well past what one turn produces in practice, and
 * passing it is reported rather than swallowed.
 */
const MAX_UNRENDERED_FILES = 20;

const PLACEHOLDER_TEXT = '…';
/** What a turn that produced no text puts in its message, wherever it is posted from. */
const NO_REPLY_TEXT = '(no reply)';

/** One agent's Slack identity: its own app (avatar, presence) and tokens. */
export interface SlackAgentConfig {
  agentId: string;
  appToken: string;
  botToken: string;
  /**
   * Slack user ids allowed to answer this agent's approval requests.
   * Authorization is by ACTOR, never by delivery: a request posted into a
   * shared thread is visible to everyone there, and one of them clicking
   * **Always allow** would otherwise widen what the agent may do unattended
   * for the rest of the session. Empty (or absent) means nobody can
   * approve, so requests are declined on arrival rather than left hanging.
   */
  approvers?: string[];
  /**
   * Where to ask when the turn is not itself happening in Slack — a
   * schedule-driven turn, a delegate, an HTTP dispatch. Defaults to the
   * conversation the turn came from, which is where the person waiting on
   * the answer already is.
   */
  approvalChannel?: string;
}

// The thin surfaces of the Slack SDKs the adapter touches — injectable so
// tests run against fakes with no network. The real factories below wrap
// @slack/socket-mode and @slack/web-api.
export interface SlackSocketEventArgs {
  ack: (response?: unknown) => Promise<void>;
  envelope_id?: string;
  body?: {
    team_id?: string;
    event_id?: string;
    /** block_actions only: who clicked. The one field authorization reads. */
    user?: { id?: string };
    actions?: SlackBlockAction[];
    channel?: { id?: string };
    /**
     * block_actions only: the message the click came from, as Slack holds
     * it at the moment it processes the interaction — so `blocks` is the
     * message's real current state, not what the clicking client had
     * rendered.
     */
    message?: { ts?: string; thread_ts?: string; blocks?: SlackBlock[] };
  };
  event?: SlackInboundEvent;
  retry_num?: number;
}

export interface SlackBlockAction {
  action_id?: string;
  /** The request id the button carries. */
  value?: string;
}

/** Block Kit is structural, not typed here beyond what the adapter emits. */
export type SlackBlock = Record<string, unknown>;

export interface SlackInboundEvent {
  type: string;
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  channel: string;
  channel_type?: string;
  bot_id?: string;
  subtype?: string;
  /**
   * Attachments on a `file_share` message. Slack puts the file metadata in
   * the event and the bytes behind an authenticated URL that needs
   * `files:read`, which this app does not ask for — so a turn learns that a
   * file arrived and what it is called, never what is in it.
   */
  files?: Array<{ name?: string; title?: string }>;
}

export interface SlackSocketLike {
  on(eventName: string, listener: (args: SlackSocketEventArgs) => void): void;
  start(): Promise<unknown>;
  disconnect(): Promise<void>;
}

export interface SlackWebLike {
  auth: { test(): Promise<{ user_id?: string; team_id?: string }> };
  chat: {
    postMessage(args: { channel: string; text: string; thread_ts?: string; blocks?: SlackBlock[] }): Promise<{ ts?: string; channel?: string }>;
    update(args: { channel: string; ts: string; text: string; blocks?: SlackBlock[] }): Promise<unknown>;
    /**
     * Visible only to `user`. Refusing a click needs to reach the person
     * who clicked without announcing to the channel that they tried.
     */
    postEphemeral(args: { channel: string; user: string; text: string; thread_ts?: string }): Promise<unknown>;
  };
  files: {
    // The real SDK takes file DATA (a buffer or stream), never a path
    // string — typing it that way here keeps fakes honest too.
    uploadV2(args: { channel_id: string; file: Buffer; filename?: string; title?: string; thread_ts?: string }): Promise<unknown>;
  };
  conversations: {
    /**
     * What backs destination validation: whether a conversation exists as
     * this app sees it, and whether the app is in it. Needs the
     * conversations read scopes (`channels:read`, `groups:read`,
     * `im:read`, `mpim:read`) — see the README's app manifest.
     */
    info(args: { channel: string }): Promise<{
      channel?: { id?: string; is_member?: boolean; is_im?: boolean };
    }>;
  };
  users: {
    info(args: { user: string }): Promise<{ user?: { name?: string; profile?: { display_name?: string; real_name?: string } } }>;
  };
}

export interface SlackAdapterOptions {
  agents: SlackAgentConfig[];
  log?: (line: string) => void;
  warn?: (line: string) => void;
  /** Minimum gap between streaming edits per message (chat.update rate limits). */
  editIntervalMs?: number;
  /** Test injection: build a Socket Mode client for an app token. */
  createSocketClient?: (appToken: string) => SlackSocketLike;
  /** Test injection: build a Web API client for a bot token. */
  createWebClient?: (botToken: string) => SlackWebLike;
}

// Lazy (and CJS-interoperable) so tests with injected fakes never load the
// real SDK stack.
const requireModule = createRequire(import.meta.url);

const defaultSocketClient = (appToken: string): SlackSocketLike => {
  const { SocketModeClient } = requireModule('@slack/socket-mode') as typeof import('@slack/socket-mode');
  return new SocketModeClient({ appToken }) as unknown as SlackSocketLike;
};

const defaultWebClient = (botToken: string): SlackWebLike => {
  const { WebClient } = requireModule('@slack/web-api') as typeof import('@slack/web-api');
  return new WebClient(botToken) as unknown as SlackWebLike;
};

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
interface HandoverClaim {
  /**
   * Spend the hold: hand the placeholder to `chunks`, run `between` while
   * this renderer still has no placeholder of its own, and reopen one
   * below. False when there is nothing to hand over — no placeholder, or
   * the renderer finished before the hold was taken — and the caller posts
   * the chunks itself.
   */
  take(chunks: readonly string[], between?: () => Promise<void>): Promise<boolean>;
  /** Give the hold back unspent, letting the queued turn finish. */
  release(): void;
}

/**
 * Renders one turn's reply into Slack with the placeholder-then-edit
 * pattern: post `…` immediately, fold streaming deltas and tool status
 * lines into throttled edits, and finalize with the authoritative reply
 * (split across messages when it outgrows one).
 */
class ReplyRenderer {
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
  private buffer = '';
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
   * Bumped by a handover. An edit scheduled before it carries the text of
   * the turn that was handed over — the recovery's stream, routed to this
   * renderer while it was at the head of the queue — and must not land in
   * the placeholder opened for this turn.
   */
  private generation = 0;
  private finalized = false;
  private readonly web: SlackWebLike;
  private readonly channel: string;
  private readonly threadTs: string | undefined;
  private readonly editIntervalMs: number;
  private readonly warn: (line: string) => void;

  constructor(
    web: SlackWebLike,
    channel: string,
    threadTs: string | undefined,
    editIntervalMs: number,
    warn: (line: string) => void,
  ) {
    this.web = web;
    this.channel = channel;
    this.threadTs = threadTs;
    this.editIntervalMs = editIntervalMs;
    this.warn = warn;
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
    this.toolLine = undefined;
    this.turnBreakPending = false;
    this.generation += 1;
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
    if (event.type === 'provider.delta' && event.delta.type === 'text') {
      // Text from a new provider turn (after tools ran) must not fuse
      // with the previous turn's — "I'll check.The result is…" reads as
      // one garbled sentence for the whole duration of the final stream.
      if (this.turnBreakPending && this.buffer.trim().length > 0) {
        this.buffer += '\n\n';
      }
      this.turnBreakPending = false;
      this.buffer += event.delta.text;
      this.scheduleEdit();
      return;
    }
    if (event.type === 'provider.delta' && event.delta.type === 'reset') {
      // The provider abandoned its partial attempt (e.g. fallback after a
      // mid-stream failure): discard everything streamed so far so two
      // attempts never fuse into one message.
      this.buffer = '';
      this.turnBreakPending = false;
      this.scheduleEdit();
      return;
    }
    if (event.type === 'provider.response') {
      this.turnBreakPending = true;
      return;
    }
    if (event.type === 'tool.called') {
      // Also a turn boundary. On the kernel path `provider.response` has
      // already marked one, and marking it twice costs nothing; on a
      // provider that hosts its own loop there is no provider.response at
      // all, so this is the only thing between the text before a tool and
      // the text after it — without it they fuse in the live message.
      this.turnBreakPending = true;
      this.toolLine = `⚙ ${event.call.toolName}…`;
      this.scheduleEdit();
      return;
    }
    if (event.type === 'tool.denied') {
      // Denial settles a call that never reached tool.called, so nothing
      // else clears the status line or marks the boundary for it — the
      // message would keep claiming a refused tool is running, and the
      // model's follow-up would fuse with the text before the attempt.
      this.toolLine = undefined;
      this.turnBreakPending = true;
      this.scheduleEdit();
      return;
    }
    if (event.type === 'tool.completed') {
      this.toolLine = undefined;
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
      }
    }
  }

  // Tool results that reference local output files (a screenshot, a
  // generated report) become real attachments in the conversation — the
  // channel contract's upload operation. Uploads chain so they land in
  // order and finalize() waits for them.
  private queueUpload(filePath: string): void {
    // Behind a handover in progress, for the same reason edits and the
    // finalize are: the turn being handed the placeholder has its own
    // attachments to put in the thread first, and an upload is a message
    // of its own — one sent now would sit above them and read as this
    // turn's answer arriving first. Captured at queue time, not read when
    // the chain runs: a handover that begins after this upload waits for
    // it, and an upload that then waited for that handover would be a
    // cycle nothing breaks (see `queueEdit`).
    const handover = this.handover;
    this.uploadChain = this.uploadChain
      .then(() => handover)
      // Read as file DATA inside the chain: the Web API takes contents,
      // not a path, and a missing file surfaces as this upload's own
      // failure instead of an unhandled stream error.
      .then(async () => {
        const data = await readFile(filePath);
        await this.web.files.uploadV2({
          channel_id: this.channel,
          file: data,
          filename: path.basename(filePath),
          ...(this.threadTs ? { thread_ts: this.threadTs } : {}),
        });
      })
      .catch((error) => this.warn(`files.uploadV2 failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}`));
  }

  private currentText(): string {
    const parts = [this.buffer.trim(), this.toolLine].filter((part): part is string => Boolean(part && part.length > 0));
    return parts.length > 0 ? parts.join('\n\n') : PLACEHOLDER_TEXT;
  }

  private scheduleEdit(): void {
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
      this.lastEditAt = Date.now();
      this.queueEdit(messageText(this.currentText()));
    }, delay);
    this.pendingEdit.unref?.();
  }

  private queueEdit(text: string): void {
    const generation = this.generation;
    // The handover as it stands when the edit is queued, not when it runs:
    // a handover that begins after this edit waits for this edit, and an
    // edit that then waited for that handover would be a cycle nothing
    // could break.
    const handover = this.handover;
    this.editChain = this.editChain
      .then(() => handover)
      .then(() => {
        // Read after the handover, not before: the placeholder may have
        // changed hands while this edit waited its turn — and the text
        // may belong to the turn that was handed over.
        const ref = this.ref;
        return ref && generation === this.generation
          ? this.web.chat.update({ channel: ref.channel, ts: ref.ts, text })
          : undefined;
      })
      .then(() => undefined)
      .catch((error) => this.warn(`chat.update failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** Replace the placeholder with the final reply, splitting if oversized. */
  async finalize(reply: string): Promise<void> {
    await this.handover;
    this.finalized = true;
    if (this.pendingEdit) {
      clearTimeout(this.pendingEdit);
      this.pendingEdit = undefined;
    }
    const text = reply.trim().length > 0 ? reply : NO_REPLY_TEXT;
    const chunks = messageChunks(text);
    // No placeholder — a handover could not open a fresh one — and the
    // reply is a message of its own rather than nothing at all.
    const rest = this.ref ? chunks.slice(1) : chunks;
    if (this.ref) {
      this.queueEdit(chunks[0] ?? NO_REPLY_TEXT);
    }
    await this.editChain;
    await this.uploadChain;
    for (const chunk of rest) {
      try {
        await this.web.chat.postMessage({
          channel: this.channel,
          text: chunk,
          ...(this.threadTs ? { thread_ts: this.threadTs } : {}),
        });
      } catch (error) {
        this.warn(`chat.postMessage failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async fail(message: string): Promise<void> {
    await this.finalize(`Something went wrong: ${message}`);
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
      take: async (chunks, between) => {
        if (spent) {
          return false;
        }
        try {
          await previous;
          return await this.handoverTo(chunks, drained, between);
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
  ): Promise<boolean> {
    const [first, ...rest] = chunks;
    const given = this.ref;
    if (first === undefined || this.finalized || !given) {
      return false;
    }
    await drained;
    try {
      await this.web.chat.update({ channel: given.channel, ts: given.ts, text: first });
    } catch (error) {
      // Not handed over: the placeholder is still this turn's, and the
      // caller posts the reply as messages of its own.
      this.warn(`chat.update failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    // The placeholder is the earlier turn's now, and the reference goes
    // before the reopen, so a reopen that fails cannot leave this turn
    // writing over the reply just handed over. (What was streamed into
    // it is dealt with by `beginTurn`, at the boundary that actually
    // separates the two turns' output.)
    this.ref = undefined;
    for (const chunk of rest) {
      try {
        await this.web.chat.postMessage({
          channel: this.channel,
          text: chunk,
          ...(this.threadTs ? { thread_ts: this.threadTs } : {}),
        });
      } catch (error) {
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
    return true;
  }
}

// The adapter-level convention for file-bearing tool results: an ok result
// whose object output carries `file: string` or `files: string[]` refers to
// local paths the channel should deliver as attachments.
const collectFilePaths = (result: ToolResult): string[] => {
  const output = result.output;
  if (typeof output !== 'object' || output === null || Array.isArray(output)) {
    return [];
  }
  const paths: string[] = [];
  const single = (output as { file?: unknown }).file;
  if (typeof single === 'string' && single.length > 0) {
    paths.push(single);
  }
  const many = (output as { files?: unknown }).files;
  if (Array.isArray(many)) {
    for (const entry of many) {
      if (typeof entry === 'string' && entry.length > 0) {
        paths.push(entry);
      }
    }
  }
  return paths;
};

// A hard cut must never land between the halves of a UTF-16 surrogate
// pair — an emoji on the boundary would reach Slack as two replacement
// characters. Backs the index off the pair's high half when it would.
const safeCutIndex = (text: string, index: number): number => {
  const code = text.charCodeAt(index - 1);
  return code >= 0xd800 && code <= 0xdbff ? index - 1 : index;
};

const truncateForSlack = (text: string): string =>
  text.length <= SLACK_MAX_MESSAGE_CHARS
    ? text
    : `${text.slice(0, safeCutIndex(text, SLACK_MAX_MESSAGE_CHARS - 1))}…`;

/**
 * Where the run of exactly `length` backticks that closes an open one
 * begins, or -1. Exactly: a longer run is not a closer, which is the whole
 * point of writing a span as ``code with a ` in it`` and a fence as ````
 * when the block itself contains ```.
 */
const closingBacktickRun = (text: string, from: number, length: number, limit: number): number => {
  const run = '`'.repeat(length);
  for (let at = text.indexOf(run, from); at !== -1 && at + length <= limit; at = text.indexOf(run, at + 1)) {
    if (text[at - 1] !== '`' && text[at + length] !== '`') {
      return at;
    }
  }
  return -1;
};

/**
 * The text as alternating prose and code — even indices prose, odd code.
 *
 * Code is the one place a reader means the characters themselves: `**` in a
 * shell snippet is the snippet, so nothing below rewrites it. A run of N
 * backticks opens code and the next run of exactly N closes it, which is
 * the same rule for a span and for a fence and is why a longer delimiter
 * can carry a shorter one inside it.
 *
 * A span may close on a later line, and is protected the whole way. That
 * looks wasteful — two stray backticks paragraphs apart become one long
 * "span" whose contents are left unconverted — and it was briefly changed
 * to end a span at its line for exactly that reason. That was wrong, and
 * the reason is the rule this whole file answers to: what Slack does with
 * the message decides, not what Markdown says. Slack pairs those backticks
 * too, so the text between them is what it renders as code, and rewriting
 * a `**bold**` in there would alter the contents of somebody's snippet.
 * Leaving prose unconverted is a cosmetic loss; changing what a reader is
 * told is code is not, so the doubt resolves toward protecting more.
 *
 * A fence with no closer runs to the end on purpose: a model that forgets
 * to close one, and every partially streamed block on its way to being
 * closed, would otherwise have its contents rewritten as prose. One or two
 * unmatched backticks are the opposite case — literal text, since "use the
 * ` character" must not swallow what follows.
 */
const proseAndCode = (text: string): string[] => {
  const segments: string[] = [];
  let prose = 0;
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf('`', cursor);
    if (open === -1) {
      break;
    }
    let length = 1;
    while (text[open + length] === '`') {
      length += 1;
    }
    const close = closingBacktickRun(text, open + length, length, text.length);
    if (close === -1) {
      if (length < 3) {
        cursor = open + length;
        continue;
      }
      segments.push(text.slice(prose, open), text.slice(open));
      return segments;
    }
    segments.push(text.slice(prose, open), text.slice(open, close + length));
    prose = close + length;
    cursor = prose;
  }
  segments.push(text.slice(prose));
  return segments;
};

/**
 * The spellings that differ, applied to prose only, in an order that matters.
 *
 * Single-asterisk emphasis goes first and is barred from crossing a `*`, so
 * `**bold**` cannot be read as an italic run that happens to begin with one.
 * Bold then rewrites what is left, and its output is never rescanned.
 *
 * Each delimiter has to hug its content — `3 * 4 * 5` is arithmetic, not
 * emphasis — and none may span a line, so one stray marker cannot italicize
 * the rest of a message.
 */
const MRKDWN_REWRITES: ReadonlyArray<readonly [RegExp, string]> = [
  // Both at once, before either rule can take half of it and leave the
  // other half as literal asterisks. Its output is why the italic rule
  // below refuses content that already opens with an underscore.
  [/\*\*\*([^\s*][^*\n]*[^\s*]|[^\s*])\*\*\*/g, '*_$1_*'],
  [/(^|[^*])\*([^\s*_][^*\n]*[^\s*]|[^\s*_])\*(?!\*)/g, '$1_$2_'],
  [/\*\*([^\s*][^*\n]*[^\s*]|[^\s*])\*\*/g, '*$1*'],
  [/(^|[^_])__([^\s_][^_\n]*[^\s_]|[^\s_])__(?!_)/g, '$1*$2*'],
  [/~~([^\s~][^~\n]*[^\s~]|[^\s~])~~/g, '~$1~'],
  // The one construct Slack spells backwards. A scheme is required: a
  // bare `[1](2)` in prose is not a link anybody meant to follow.
  [/\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^()\s]+)\)/g, '<$2|$1>'],
];

/**
 * `## Heading`, which mrkdwn has no spelling for at all.
 *
 * The optional closing hashes have to be spaced off the text, as Markdown
 * requires: without that, `# C#` is a heading whose name loses its last
 * character.
 *
 * What they and any trailing spaces cover is captured rather than dropped,
 * because dropping is only right when they are the heading's own syntax. A
 * heading that opens a code span reaches its end inside one, and there the
 * same characters are the snippet: `` # show `value # `` has a hash that
 * belongs to whoever wrote the code.
 */
const MARKDOWN_HEADING = /^ {0,3}#{1,6}[ \t]+(.+?)((?:[ \t]+#+)?[ \t]*)$/gm;

const convertInline = (segment: string): string => {
  let converted = segment;
  for (const [pattern, replacement] of MRKDWN_REWRITES) {
    converted = converted.replace(pattern, replacement);
  }
  return converted;
};

/**
 * Headings, found on the text's own lines rather than inside each prose
 * fragment.
 *
 * A fragment is not a line: inline code cuts one in two, and the halves
 * begin wherever the code ended. Matched per fragment, `^` then lied in
 * both directions — the tail of `` `status` # not a heading `` looked like a
 * line of its own and lost its hash, and ``## Run `npm test` now`` was only
 * ever half a line, so only the half before the code was wrapped.
 *
 * So the whole text is matched instead, with the code spans it now contains
 * passed in: a `#` whose line begins inside one is a comment in somebody's
 * snippet, not a heading. A heading that merely *contains* code is a
 * heading, and its code goes along untouched.
 *
 * Emphasis inside is already converted by here, so the line is only wrapped
 * when nothing in it can pair with the wrapper. Slack has one bold
 * delimiter and no way to nest it: wrapping `*Run* the thing` again yields
 * `**Run* the thing*`, which it renders as literal asterisks rather than as
 * anything bold. A heading that already carries emphasis therefore keeps
 * exactly the emphasis it has — `## **Title**` is bold by now and needs
 * nothing more, and `# glob *.ts` keeps an asterisk that was never a marker
 * at all. An unbolded heading reads fine; a heading full of stray asterisks
 * does not, and one with characters removed to make room is worse than both.
 *
 * An asterisk inside a code span is not one of those: Slack does not read
 * markup there, so it cannot pair with anything, and ``## Match `*.ts` files``
 * is bolded like any other heading.
 *
 * Both walks are cursors rather than searches: `replace` reports matches in
 * increasing offset, and the spans were collected in that order too, so
 * neither has to be looked at twice. The same work as a scan per heading,
 * without its quadratic on a reply that is mostly headings and snippets.
 */
/** What could pair with a heading's wrapper, or with something out of sight. */
const PAIRABLE_MARKER = /[*`]/g;

const convertHeadings = (text: string, code: ReadonlyArray<readonly [number, number]>): string => {
  let span = 0;
  const startsInside = (position: number, from: number): boolean =>
    position >= (code[from]?.[0] ?? Number.POSITIVE_INFINITY);

  return text.replace(MARKDOWN_HEADING, (line, body: string, tail: string, offset: number) => {
    while (span < code.length && (code[span]?.[1] ?? 0) <= offset) {
      span += 1;
    }
    // A `#` whose line begins inside a span is a comment in somebody's code.
    if (startsInside(offset, span)) {
      return line;
    }
    const heading = body.trim();
    if (heading.length === 0) {
      return line;
    }
    // Where everything this would drop from the line's end begins: the
    // closing hashes and spaces the pattern captured, and whatever else
    // `trimEnd` would take with them. The two are not the same set — the
    // pattern knows only spaces and tabs, while trimming also takes a
    // no-break space, an ideographic space, and the rest of what
    // ECMAScript counts as whitespace — and the difference is exactly
    // where a character goes missing.
    //
    // Dropping any of it is the heading's own syntax being removed, but
    // only while it is the heading's: a line that opens a span reaches its
    // end inside one, and there the same characters are somebody's
    // snippet. Nothing on this line is safe to strip then, so it is left
    // exactly as written. (The front needs no such care: the body starts
    // where the hashes stop, which this line has already been shown to
    // reach in prose.)
    const dropped = tail.length + (body.length - body.trimEnd().length);
    if (dropped > 0) {
      const droppedAt = offset + line.length - dropped;
      let over = span;
      while (over < code.length && (code[over]?.[1] ?? 0) <= droppedAt) {
        over += 1;
      }
      if (startsInside(droppedAt, over)) {
        return line;
      }
    }
    // Anything left on the line that a delimiter could pair with, walked
    // from where the heading cursor already stands rather than from the
    // beginning. An asterisk is the obvious one — it would pair with the
    // wrapper. A backtick counts too: one this side found no partner for is
    // a literal character here, but Slack parses the message itself and may
    // pair it with a backtick further down, and the wrapper's closing `*`
    // would then be written inside what Slack reads as code, where it is
    // ignored — leaving the opening one with nothing to close it. Both are
    // spent characters inside a span, which is why the ranges are consulted
    // rather than the text alone.
    let within = span;
    for (const marker of line.matchAll(PAIRABLE_MARKER)) {
      const position = offset + (marker.index ?? 0);
      while (within < code.length && (code[within]?.[1] ?? 0) <= position) {
        within += 1;
      }
      if (!startsInside(position, within)) {
        return heading;
      }
    }
    // Both markers have to land in prose, not just the opening one. A fence
    // opened on this line — by a model mid-answer, or by a block still being
    // streamed — runs past its end, so the closing `*` would be written
    // inside the code and ignored there, leaving the opening one unpaired.
    // The line began in prose or this never ran, so it is the end that is
    // in question: where the marker would go, one past the line's last
    // character, and not that character itself — a span that closes exactly
    // at the line's end leaves the marker just outside it, which is fine.
    const closer = offset + line.length;
    while (within < code.length && (code[within]?.[1] ?? 0) <= closer) {
      within += 1;
    }
    return startsInside(closer, within) ? heading : `*${heading}*`;
  });
};

/**
 * Markdown as a model writes it, in the spelling Slack actually renders.
 *
 * Slack's mrkdwn is not Markdown, and the gap is not cosmetic: `**bold**`
 * reaches a reader as four literal asterisks, and `## Heading` as a line
 * that starts with two hashes. Models write Markdown because that is what
 * every other surface here renders, and a soul should not have to know
 * which channel is carrying it, so the translation happens at the edge that
 * does know.
 *
 * Only what differs is touched. Lists, block quotes, and inline code
 * already mean in mrkdwn what they mean in Markdown; rewriting them would
 * add ways to be wrong and fix nothing.
 */
const toSlackMrkdwn = (text: string): string => {
  // Where each code span ends up in the converted text, which is not where
  // it started: the prose before it changes length as it is rewritten.
  const code: Array<readonly [number, number]> = [];
  const segments = proseAndCode(text);
  let converted = '';
  segments.forEach((segment, index) => {
    if (index % 2 === 1) {
      // A code segment that ends the text is the unterminated fence: every
      // closed run is followed by a prose slice, even an empty one. It has
      // no end to be past, so nothing may be appended after it either —
      // recording the end as it looks would say a marker placed at the
      // text's end was safely outside.
      const ends = index === segments.length - 1
        ? Number.POSITIVE_INFINITY
        : converted.length + segment.length;
      code.push([converted.length, ends]);
      converted += segment;
      return;
    }
    converted += convertInline(segment);
  });
  return convertHeadings(converted, code);
};

const splitForSlack = (text: string): string[] => {
  if (text.length <= SLACK_MAX_MESSAGE_CHARS) {
    return [text];
  }
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > SLACK_MAX_MESSAGE_CHARS) {
    // Prefer a newline break inside the window; fall back to a hard cut.
    const window = rest.slice(0, SLACK_MAX_MESSAGE_CHARS);
    const breakAt = window.lastIndexOf('\n') > SLACK_MAX_MESSAGE_CHARS / 2
      ? window.lastIndexOf('\n')
      : safeCutIndex(rest, SLACK_MAX_MESSAGE_CHARS);
    chunks.push(rest.slice(0, breakAt));
    rest = rest.slice(breakAt).replace(/^\n+/, '');
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
const messageText = (text: string): string => truncateForSlack(toSlackMrkdwn(text));

/**
 * Agent text as however many Slack messages it takes. Converted before it
 * is split, so a chunk is measured at the length it will be sent at, and so
 * no rewrite is ever asked to span a boundary.
 */
const messageChunks = (text: string): string[] => splitForSlack(toSlackMrkdwn(text));

// One rule with the gateway's `sessionRouting`, which posts the same
// message for a turn this adapter did not start.
const lastAssistantReply = (session: Session): string => latestTurnReply(session) ?? NO_REPLY_TEXT;

const APPROVAL_ACTIONS: Record<string, ApprovalAnswer> = {
  stratus_approve_once: 'once',
  stratus_approve_always: 'always',
  stratus_deny: 'deny',
};

/**
 * How an approval request reads once it is settled. `always` says out loud
 * how long it lasts: the button is the shortest path to widening what an
 * agent does unattended, and an approver should see the scope they granted
 * in the record of granting it.
 *
 * It states the **floor**, because that is the only thing true in every
 * case. A call judged by a scope — a shell command, a browser site —
 * persists that scope in the agent's whitelist and normally keeps it
 * across restarts, but not when the daemon cannot write the file (a
 * hand-edit that will not parse) or was built without one, and by then
 * this message has already been sent. Nothing on the bus distinguishes
 * any of it: the policy returns a boolean, and `tool.approval-resolved`
 * carries the answer that was submitted, not how long the grant lasts.
 *
 * So it says what is always so and no more. Claiming only the session
 * lifetime, as this line first did, tells an approver a durable grant
 * revokes itself; claiming the restart, as it then did, promises one the
 * daemon may have failed to save. The daemon's log has the exact line.
 */
const OUTCOME_TEXT: Record<string, string> = {
  'decided:once': 'Allowed once',
  'decided:always': 'Allowed and remembered — for this session at least',
  'decided:deny': 'Denied',
  'timeout:deny': 'Expired without an answer — denied',
  // Covers both endings that reach here: the turn was aborted, and the
  // daemon shut down with the request still outstanding.
  'cancelled:deny': 'Cancelled before anyone answered — denied',
  'undeliverable:deny': 'Could not be put to an approver — denied',
};

/** Comfortably inside Slack's 3000-character section limit. */
const APPROVAL_INPUT_LIMIT = 1400;
/** One line in a notification; the blocks carry the readable version. */
const APPROVAL_SUMMARY_LIMIT = 160;

/**
 * Subtypes that are still a person saying something, rather than Slack
 * narrating the channel. Everything else a `subtype` marks — an edit, a
 * deletion, a join, a pinned file — is bookkeeping, and an agent following
 * a thread must not answer bookkeeping.
 *
 * These three are here because each is an ordinary thing a person does:
 * `file_share` is a message that happens to carry an attachment (asking a
 * question with the log attached is the normal way to ask it),
 * `thread_broadcast` is a thread reply the author also sent to the channel,
 * and `me_message` is what `/me` produces — typed by a person, in their own
 * words, and marked only by how it is rendered.
 */
const HUMAN_MESSAGE_SUBTYPES = new Set(['file_share', 'me_message', 'thread_broadcast']);

const isPersonSpeaking = (event: SlackInboundEvent): boolean =>
  event.subtype === undefined || HUMAN_MESSAGE_SUBTYPES.has(event.subtype);

/** At most this many attachment names are listed; the rest are counted. */
const MAX_LISTED_ATTACHMENTS = 5;

/**
 * What a message's attachments are called, for a turn that cannot open
 * them. Without this the agent is handed "here's the log" and no log, and
 * answers as though it had read something — the note is what lets it say
 * the true thing instead.
 */
const attachmentNote = (files: SlackInboundEvent['files']): string => {
  if (!files || files.length === 0) {
    return '';
  }
  const names = files.slice(0, MAX_LISTED_ATTACHMENTS).map((file) => file.name ?? file.title ?? 'an unnamed file');
  const rest = files.length - names.length;
  const listed = rest > 0 ? `${names.join(', ')}, and ${rest} more` : names.join(', ');
  return `\n[Attached: ${listed}. Attachment contents cannot be read here — say so rather than guessing at them.]`;
};

/**
 * Whether `text` addresses a bot user by name. Slack writes a mention as
 * `<@U123>` markup whoever typed it, so this is the same question for an
 * `app_mention` event and for a plain channel message the app now also
 * sees.
 */
const mentions = (text: string, botUserId: string): boolean =>
  botUserId.length > 0 && text.includes(`<@${botUserId}>`);

/**
 * Slack's three markup characters. Tool input is written by a model, so it
 * reaches this message as untrusted text: unescaped, `<@U123>` becomes a
 * real mention and `<!channel>` a real broadcast, letting an agent ping a
 * workspace through the very prompt asking whether to trust it. Escaping is
 * applied even inside a code block, where clients disagree about whether
 * that markup still resolves.
 */
const escapeSlackText = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/**
 * What the approver is actually being asked to allow.
 *
 * Without this the prompt names only the tool, and for anything whose
 * danger lives in its arguments — the shell tool this engine exists for —
 * `ls` and a destructive command produce an identical message. Approving
 * something you cannot see is not approval.
 *
 * Truncation is announced rather than silent for the same reason: a
 * decision made on a partial view should at least know it is partial.
 */
const renderInvocation = (input: JsonObject): { detail?: string; summary: string; truncated: boolean } => {
  if (Object.keys(input).length === 0) {
    return { summary: '', truncated: false };
  }
  const rendered = JSON.stringify(input, null, 2);
  const truncated = rendered.length > APPROVAL_INPUT_LIMIT;
  const oneLine = JSON.stringify(input);
  return {
    detail: truncated ? rendered.slice(0, APPROVAL_INPUT_LIMIT) : rendered,
    summary: oneLine.length > APPROVAL_SUMMARY_LIMIT
      ? `${oneLine.slice(0, APPROVAL_SUMMARY_LIMIT)}…`
      : oneLine,
    truncated,
  };
};

const approvalBlocks = (
  agentName: string,
  toolName: string,
  risk: string,
  requestId: string,
  input: JsonObject,
  origin: string | undefined,
  oneShot: boolean,
): SlackBlock[] => {
  const invocation = renderInvocation(input);
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        // The site, when the call is judged by one. It is not in the
        // arguments and cannot be: a `browser.act` request shows a CSS
        // selector, which says nothing about where the click lands — and
        // **Always allow** widens exactly that site, so an approver who was
        // not shown it is being asked to grant something they cannot see.
        text: `*${escapeSlackText(agentName)}* wants to run \`${escapeSlackText(toolName)}\` (${risk})`
          + `${origin ? ` on \`${escapeSlackText(origin)}\`` : ''}.`,
      },
    },
    ...(invocation.detail
      ? [{
          type: 'section',
          text: { type: 'mrkdwn', text: `\`\`\`\n${escapeSlackText(invocation.detail)}\n\`\`\`` },
        }]
      : []),
    ...(invocation.truncated
      ? [{
          type: 'context',
          elements: [{ type: 'mrkdwn', text: ':warning: Arguments shown are truncated — the full call is longer than this.' }],
        }]
      : []),
    // Why there is no second button, when there is no second button.
    ...(oneShot
      ? [{
          type: 'context',
          elements: [{
            type: 'mrkdwn',
            text: ':lock: An approval covers this call only — nothing about it is remembered.',
          }],
        }]
      : []),
    {
      type: 'actions',
      // The request id rides on every button rather than in the message
      // reference: Slack gives the value back verbatim, so the gateway is
      // asked about the request that was actually rendered, never one
      // re-derived from a channel and timestamp.
      //
      // **Always allow** is absent when the engine would not remember the
      // answer — a `dangerous` tool, or a browser action with no page to
      // grant. Offering it there is worse than useless: it does exactly
      // what **Allow once** does, under a label promising a standing grant
      // nobody gets.
      elements: [
        { type: 'button', action_id: 'stratus_approve_once', text: { type: 'plain_text', text: 'Allow once' }, value: requestId, ...(oneShot ? { style: 'primary' } : {}) },
        ...(oneShot
          ? []
          : [{ type: 'button', action_id: 'stratus_approve_always', text: { type: 'plain_text', text: 'Always allow' }, value: requestId, style: 'primary' }]),
        { type: 'button', action_id: 'stratus_deny', text: { type: 'plain_text', text: 'Deny' }, value: requestId, style: 'danger' },
      ],
    },
  ];
};

interface PendingApprovalPost {
  connection: AgentConnection;
  channel: string;
  ts: string;
  thread?: string;
  agentName: string;
  toolName: string;
  risk: string;
  /**
   * Whether `always` on this request would have remembered anything —
   * carried from the request rather than re-derived, because the outcome
   * has to describe the answer that was actually possible. `POST
   * /approvals` still accepts all three answers, so another client can
   * submit `always` for a request this channel never offered it on.
   */
  oneShot: boolean;
  /** Bound at render time, so a later config change cannot widen a live request. */
  approvers: Set<string>;
}

/**
 * A message `admit` has decided is this agent's, and everything it worked
 * out on the way — so the async half neither re-derives nor re-reads any of
 * it. `settled: false` is the one open question left: whether the sessions
 * say this untagged reply is ours.
 */
interface Admission {
  event: SlackInboundEvent;
  isDm: boolean;
  team: string;
  userId: string;
  sessionId: string;
  thread?: string;
  /** Absent for a DM, which has one agent by construction. */
  threadKey?: string;
  settled: boolean;
}

interface AgentConnection {
  config: SlackAgentConfig;
  web: SlackWebLike;
  socket: SlackSocketLike;
  botUserId: string;
  teamId: string;
}

/**
 * The Slack channel adapter. One Slack app per agent — Slack has no way to
 * give a single bot several identities with real avatars, presence, and
 * DMs — so the adapter runs one Socket Mode connection per configured
 * agent and maps each app to its agent id.
 *
 * Session keys are `slack:<agent>:<team>:<channel>:<thread_ts ?? ts>`
 * (DMs: the DM channel id alone), so threads are resumable conversations
 * and two agents sharing a thread keep fully separate sessions. Replies
 * stream via placeholder-then-edit, throttled for chat.update limits.
 *
 * A mention starts a thread conversation; inside one, the agent keeps
 * listening without being tagged again — see `couldBeFollowUp` and
 * `answersFollowUp` for exactly whose reply an untagged message is. That
 * needs the app to be subscribed to `message.channels` / `message.groups`
 * / `message.mpim` (the shipped manifest is); an app installed before
 * those were in it receives only `app_mention` and behaves as it always
 * did, which makes the workspace's own grant the switch.
 */
export const createSlackChannelAdapter = (options: SlackAdapterOptions): ChannelAdapter => {
  const log = options.log ?? (() => {});
  const warn = options.warn ?? (() => {});
  const editIntervalMs = options.editIntervalMs ?? DEFAULT_EDIT_INTERVAL_MS;
  const createSocket = options.createSocketClient ?? defaultSocketClient;
  const createWeb = options.createWebClient ?? defaultWebClient;

  const connections: AgentConnection[] = [];
  // Every agent this adapter was asked to carry, connected or not — the
  // difference between "mine and broken" and "not mine".
  const configuredAgents = new Set(options.agents.map((agent) => agent.agentId));
  // Renderers queue per session: two messages in one thread share a
  // session id, and the gateway serializes their turns — so events route
  // to the FIRST registered renderer (the running turn), never a later
  // message's placeholder. Each handler removes exactly its own renderer.
  const renderers = new Map<string, ReplyRenderer[]>();
  /**
   * Files a turn nobody here rendered produced — a recovery's screenshot,
   * say — keyed by session, waiting for the turn's outcome to be posted so
   * they can follow it into the thread. A rendered turn's files go through
   * its renderer as they are produced; these have no renderer to go through.
   */
  const unrenderedFiles = new Map<string, string[]>();
  // In-flight turns, so stop() can drain: a reply mid-render should reach
  // Slack before the sockets go away.
  const inflight = new Set<Promise<void>>();
  // Per-session intake chains: the pre-dispatch pipeline (lookups,
  // placeholder, dispatch call) runs in Slack receipt order.
  const intakeChains = new Map<string, Promise<void>>();
  const displayNames = new Map<string, string>();
  // Socket Mode redelivers on missed acks; a slow turn must not run twice.
  const seenEvents = new Set<string>();
  const seenOrder: string[] = [];
  /**
   * Who each thread was last handed to, in SLACK RECEIPT ORDER — written
   * the moment a message is accepted for an agent, before any of the work
   * that message causes.
   *
   * The durable answer (`answersFollowUp`) is the agents' own sessions,
   * and it lags: a session row is written when its turn starts, which is a
   * display-name lookup and a placeholder post after the message that
   * asked for it. Inside that window the persisted order still names the
   * agent that spoke *before* the handover, so a mention of Bea followed
   * straight away by an untagged addendum would send the addendum to Ava —
   * and a follow-up typed on the heels of the mention that opened the
   * thread would find no session at all and be dropped for good.
   *
   * Keyed by thread rather than by (agent, thread): the value is which
   * single agent has it, so there is nothing to reconcile. It carries the
   * `ts` of the message that set it, because the writes are not ordered —
   * each agent is its own socket, one can be several messages behind
   * another, and a redelivery can bring an old mention back long after a
   * newer handover. An older write is therefore ignored rather than
   * applied: the holder only ever moves forward through the conversation.
   *
   * Bounded and lossy on purpose — evicting an entry costs one lookup,
   * since the sessions still hold the answer for every thread this map has
   * forgotten, and for every thread a restart forgot.
   *
   * One thing they cannot reconstruct: a handover made in the seconds
   * before the daemon went down. The mention that moved the thread is
   * recorded only here, and the newly named agent has not replied yet, so
   * after a restart the sessions still name the previous speaker and the
   * next untagged reply goes to them. Surviving that needs durable
   * adapter-owned state, which the channel contract deliberately does not
   * have — an adapter reads routing and translates events, and inventing a
   * private store here is the wrong place to answer it. The next mention
   * corrects it.
   */
  const threadAddressee = new Map<string, { agentId: string; ts: string }>();
  /**
   * One cold verdict per message — see `followUpWinner`. Bounded, because
   * an entry outlives its own resolution on purpose.
   */
  const coldVerdicts = new Map<string, Promise<string | undefined>>();
  /**
   * `agentId` → bot user id, for every app whose token this adapter has
   * authenticated — whether or not its socket then came up, and kept for as
   * long as the adapter runs.
   *
   * Separate from `connections` because recognizing that somebody was named
   * and being able to answer are different questions. An agent whose app is
   * down cannot answer anything; a message that names it is still not the
   * other agent's to take, and treating it as untagged would have the wrong
   * agent answer a question a person deliberately handed elsewhere. Silence
   * is the correct outcome there, and it is also the visible one — the same
   * thing a mention has always done when an app is down.
   *
   * Insertion order is `options.agents` order, which is what makes
   * `agentNamedIn` deterministic across every connection.
   */
  const botIdentities = new Map<string, { botUserId: string; teamId: string }>();
  // Rendered approval requests, keyed by the gateway's request id — the
  // same id the buttons carry back.
  const approvalPosts = new Map<string, PendingApprovalPost>();
  // Requests whose message is mid-post. A request can settle — expire, or
  // its turn be cancelled — while the postMessage that announces it is
  // still in flight, and the retraction would then find nothing to retract
  // and leave live-looking buttons behind forever. Resolutions arriving in
  // that window are held here and applied once the post lands. Bounded by
  // construction: an id is only ever in this set while one HTTP call is
  // outstanding.
  const rendering = new Set<string>();
  const resolvedWhileRendering = new Map<string, Extract<StratusEvent, { type: 'tool.approval-resolved' }>>();
  let unsubscribe: (() => void) | undefined;
  let gatewayRef: GatewayLike | undefined;

  // Everything the adapter owes Slack goes through here, so stop() drains
  // it: an approval question or its retraction must reach the workspace
  // before the sockets close, or a message keeps offering buttons that
  // nothing is listening for.
  const track = (work: Promise<void>): void => {
    // Also the rejection boundary, because this is where the work stops
    // being anyone's to await: the caller hands it over and returns to the
    // event loop, so a rejection past this point is attached to nothing
    // and takes the daemon down under Node's default. One call site below
    // remembers to catch before handing over, which is exactly the kind of
    // rule that holds until the next call site forgets it -- so it lives
    // here instead, where there is one of it.
    const settled = work.catch((error) => {
      warn(`slack: background work failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    inflight.add(settled);
    void settled.finally(() => inflight.delete(settled));
  };

  const alreadySeen = (key: string): boolean => {
    if (seenEvents.has(key)) {
      return true;
    }
    seenEvents.add(key);
    seenOrder.push(key);
    if (seenOrder.length > DEDUPE_CAPACITY) {
      const evicted = seenOrder.shift();
      if (evicted) {
        seenEvents.delete(evicted);
      }
    }
    return false;
  };

  // User ids are only unique within a workspace; two agents' apps can live
  // in different workspaces, so the cache key carries the team.
  const displayNameFor = async (connection: AgentConnection, userId: string): Promise<string> => {
    const cacheKey = `${connection.teamId}:${userId}`;
    const cached = displayNames.get(cacheKey);
    if (cached) {
      return cached;
    }
    try {
      const info = await connection.web.users.info({ user: userId });
      const name = info.user?.profile?.display_name || info.user?.profile?.real_name || info.user?.name || userId;
      displayNames.set(cacheKey, name);
      return name;
    } catch {
      return userId;
    }
  };

  // Mentions arrive as <@U123> markup; the model should read names.
  const humanizeMentions = async (connection: AgentConnection, text: string): Promise<string> => {
    const withoutBot = text.replaceAll(`<@${connection.botUserId}>`, '').trim();
    const mentionPattern = /<@([A-Z0-9]+)>/g;
    const ids = [...withoutBot.matchAll(mentionPattern)].map((match) => match[1]).filter((id): id is string => Boolean(id));
    let result = withoutBot;
    for (const id of new Set(ids)) {
      result = result.replaceAll(`<@${id}>`, `@${await displayNameFor(connection, id)}`);
    }
    return result.trim();
  };

  const connectionFor = (agentId: string): AgentConnection | undefined =>
    connections.find((candidate) => candidate.config.agentId === agentId);

  /**
   * The addressable outbound seam — the channel contract's first real
   * `OutboundConnection` implementation. Validate-then-hand-over: every
   * refusal here happens at schedule creation or at the moment of a send,
   * with a message written for the person who named the destination,
   * because the alternative is a connection whose first post fails at 6am.
   *
   * Membership is the boundary on purpose (see the spec's cold-DM
   * decision): the app posts only into conversations it has been invited
   * to, and a DM conversation id (`D…`) is its own proof — the DM exists
   * only because someone opened it with the app.
   */
  const resolveOutbound = async (address: OutboundAddress): Promise<OutboundConnection> => {
    const to = address.to.trim();
    if (!to) {
      throw new Error('slack: a destination needs a conversation id (C…/G…/D…).');
    }
    const connection = connectionFor(address.agentId);
    if (!connection) {
      throw new Error(configuredAgents.has(address.agentId)
        ? `slack: ${address.agentId}'s Slack app is not connected right now, so ${to} cannot be reached.`
        : `slack: agent ${address.agentId} has no Slack app, so it cannot post to Slack at all.`);
    }
    let conversation: { id?: string; is_member?: boolean; is_im?: boolean } | undefined;
    try {
      conversation = (await connection.web.conversations.info({ channel: to })).channel;
    } catch (error) {
      // channel_not_found covers both "no such id" and "not visible to
      // this app" — Slack deliberately does not distinguish, and neither
      // should the message pretend to.
      throw new Error(
        `slack: ${address.agentId}'s app cannot see ${to} (${error instanceof Error ? error.message : String(error)}). `
        + 'Use the conversation id, not a name, and check the app is in that workspace with the conversations read scopes.',
      );
    }
    if (!conversation?.id) {
      throw new Error(`slack: ${address.agentId}'s app cannot see a conversation ${to}.`);
    }
    if (!conversation.is_im && conversation.is_member !== true) {
      throw new Error(
        `slack: ${address.agentId}'s app is not a member of ${to} — invite it there before it can post.`,
      );
    }
    const channelId = conversation.id;
    const web = connection.web;
    return {
      async post(text: string): Promise<OutboundMessageRef> {
        const chunks = messageChunks(text.trim().length > 0 ? text : '(empty message)');
        let first: OutboundMessageRef | undefined;
        for (const chunk of chunks) {
          const posted = await web.chat.postMessage({ channel: channelId, text: chunk });
          if (!first) {
            first = { channel: posted.channel ?? channelId, ts: posted.ts ?? '' };
          }
        }
        return first ?? { channel: channelId, ts: '' };
      },
      async edit(ref: OutboundMessageRef, text: string): Promise<void> {
        await web.chat.update({ channel: ref.channel, ts: ref.ts, text: messageText(text) });
      },
      async upload(filePath: string, title?: string): Promise<void> {
        // File DATA, read here, for the same reason the renderer does it:
        // a missing file is this upload's own failure.
        const data = await readFile(filePath);
        await web.files.uploadV2({
          channel_id: channelId,
          file: data,
          filename: path.basename(filePath),
          ...(title ? { title } : {}),
        });
      },
    };
  };

  /**
   * Renders one parked call as buttons and remembers where it went.
   *
   * A request this adapter cannot route is DENIED here rather than left to
   * expire: with no approver configured, or no conversation to ask in,
   * waiting out the timeout tells the agent nothing it will not be told
   * immediately, and holds the turn (and the thread it is answering) open
   * for the whole window to get there.
   */
  const renderApprovalRequest = async (
    event: Extract<StratusEvent, { type: 'tool.approval-requested' }>,
  ): Promise<void> => {
    const gateway = gatewayRef;
    if (!gateway) {
      return;
    }

    const connection = connectionFor(event.agentId);
    if (!connection) {
      // Two different situations, and only one of them is this adapter's
      // to answer.
      //
      // An agent it was configured for but could not connect (a failed
      // auth, a dead app token) is its own: it was supposed to carry that
      // agent's approvals and cannot, so it says so rather than letting
      // every gated call wait out the timeout.
      //
      // An agent it was never configured for is NOT. Approval requests are
      // a broadcast, and another channel may be the one that serves that
      // agent — denying here would let Slack refuse a question somebody
      // else was going to ask. `stratus serve` reports agents that no
      // channel can ask for, at startup, where the whole roster is visible.
      if (configuredAgents.has(event.agentId)) {
        warn(`slack: ${event.agentId} has no live connection; denying ${event.call.toolName}`);
        gateway.resolveApproval({ requestId: event.requestId, answer: 'deny', reason: 'undeliverable' });
      }
      return;
    }

    const approvers = new Set((connection.config.approvers ?? []).filter((id) => id.length > 0));
    const metadata = event.metadata ?? {};
    const sameChannel = metadata.channel === 'slack' && typeof metadata.slackChannel === 'string'
      ? metadata.slackChannel
      : undefined;
    const channel = sameChannel ?? connection.config.approvalChannel;
    const thread = sameChannel && typeof metadata.slackThread === 'string' ? metadata.slackThread : undefined;

    // Undeliverable, not decided: nobody was asked, so filing this next to
    // the denials somebody actually made would make the audit record lie
    // about which is which.
    const decline = (reason: string): void => {
      warn(`slack: ${reason}; denying ${event.call.toolName} for ${event.agentId}`);
      gateway.resolveApproval({ requestId: event.requestId, answer: 'deny', reason: 'undeliverable' });
    };

    if (approvers.size === 0) {
      decline(`no approvers configured for ${event.agentId}`);
      return;
    }
    if (!channel) {
      decline(`no conversation to ask in for ${event.agentId}`);
      return;
    }

    const agentName = gateway.agents().find((agent) => agent.id === event.agentId)?.name ?? event.agentId;
    // The notification preview is all some approvers see before deciding
    // whether to open the thread, so it carries the arguments too — just
    // the short form.
    const invocationSummary = renderInvocation(event.call.input).summary;

    // The post is the only awaited step, and the only window in which the
    // request can settle behind this function's back — so it is the only
    // step `rendering` covers, and nothing decides anything until it is
    // over and the two possible outcomes can be told apart.
    rendering.add(event.requestId);
    let post: PendingApprovalPost | undefined;
    let failure: string | undefined;
    try {
      const posted = await connection.web.chat.postMessage({
        channel,
        // Fallback text for notifications and clients that do not render
        // blocks — an approval nobody can read is an approval nobody gives.
        text: escapeSlackText(
          `${agentName} wants to run ${event.call.toolName} (${event.risk})`
          + `${event.origin ? ` on ${event.origin}` : ''}`
          + `${invocationSummary ? `: ${invocationSummary}` : ''}.`,
        ),
        ...(thread ? { thread_ts: thread } : {}),
        blocks: approvalBlocks(
          agentName,
          event.call.toolName,
          event.risk,
          event.requestId,
          event.call.input,
          event.origin,
          event.oneShot === true,
        ),
      });
      post = posted.ts
        ? {
            connection,
            channel: posted.channel ?? channel,
            ts: posted.ts,
            ...(thread ? { thread } : {}),
            agentName,
            toolName: event.call.toolName,
            risk: event.risk,
            oneShot: event.oneShot === true,
            approvers,
          }
        : undefined;
      failure = post ? undefined : `Slack accepted the approval request for ${event.agentId} without a timestamp`;
    } catch (error) {
      failure = `could not post an approval request to ${channel} (${error instanceof Error ? error.message : String(error)})`;
    }
    rendering.delete(event.requestId);

    if (post) {
      approvalPosts.set(event.requestId, post);
    }

    const settledMeanwhile = resolvedWhileRendering.get(event.requestId);
    if (settledMeanwhile) {
      resolvedWhileRendering.delete(event.requestId);
      // Already decided — never decline it a second time; just take the
      // buttons off the message that just appeared.
      if (post) {
        await retractApprovalRequest(settledMeanwhile);
      }
      return;
    }

    if (failure) {
      decline(failure);
    }
  };

  /**
   * Retracts the buttons once a request is settled, however it settled.
   * Every ending goes through here — a click, the timeout, a cancelled turn
   * — so a message can never keep offering a decision that no longer has
   * anywhere to land.
   */
  /**
   * Rewrites a prompt left behind by a daemon that is gone, using the
   * click's own coordinates.
   *
   * The index of posted requests is in-memory and keyed by request id, so
   * a new process starts empty and has no way to find the messages its
   * predecessor posted. An interaction payload carries the channel and
   * timestamp of the message it came from, which is the one handle on such
   * a message that survives — so the click that discovers the prompt is
   * dead is also what retires it. Unclicked orphans stay as they are;
   * clearing those needs the posts to be durable, which is a larger change
   * than this and belongs to both billing paths equally.
   */
  const offersDecision = (blocks: SlackBlock[] | undefined): boolean =>
    (blocks ?? []).some((block) => block.type === 'actions');

  const retireOrphanedPrompt = async (
    connection: AgentConnection,
    args: SlackSocketEventArgs,
  ): Promise<void> => {
    const channel = args.body?.channel?.id;
    const ts = args.body?.message?.ts;
    if (!channel || !ts) {
      return;
    }
    // The message decides, not a memory of it. Every ending rewrites this
    // message into a plain section, so buttons still on it mean nothing
    // has been written there yet — and no buttons means something has, and
    // overwriting it would replace a real outcome and the person who made
    // it. Reading the click's own copy answers that with no bookkeeping to
    // disagree with, and no second API call to ask.
    if (!offersDecision(args.body?.message?.blocks)) {
      return;
    }
    const text = 'This request is no longer pending — the daemon that asked it is no longer running.';
    try {
      await connection.web.chat.update({
        channel,
        ts,
        text,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
      });
    } catch (error) {
      warn(`slack: could not retire an orphaned approval request: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const retractApprovalRequest = async (
    event: Extract<StratusEvent, { type: 'tool.approval-resolved' }>,
  ): Promise<void> => {
    const post = approvalPosts.get(event.requestId);
    if (!post) {
      // Still being posted: hold the outcome so the message it is about to
      // create does not keep offering a decision that is already made.
      if (rendering.has(event.requestId)) {
        resolvedWhileRendering.set(event.requestId, event);
      }
      return;
    }
    approvalPosts.delete(event.requestId);

    // The one lifetime this adapter *can* tell, because it rode in on the
    // request: a one-shot call remembers nothing whatever is answered. Both
    // shapes reach here — a `dangerous` tool, and a call judged by an
    // origin with no page to grant — and this channel offers no **Always
    // allow** for either, but `POST /approvals` still takes all three
    // answers, so another client can submit one. The general line below has
    // to hedge between two lifetimes it cannot distinguish; this one must
    // not, or the record of the decision claims a grant that does not exist.
    // Three shapes are one-shot and only one of them is knowable from here:
    // `risk` rode in on the request, so a `dangerous` tool can say why. The
    // other two — a browser action with no page to grant, and a command the
    // parser cannot reduce to a scope — are not distinguishable without
    // carrying a reason this adapter would only ever print, so they share a
    // line that is true of both. Naming one of them by guess is how this
    // read "there was no page to remember" for a shell pipeline.
    const outcome = post.oneShot && event.reason === 'decided' && event.answer === 'always'
      ? post.risk === 'dangerous'
        ? 'Allowed once — a dangerous tool is never remembered'
        : 'Allowed once — nothing about this call could be remembered'
      : OUTCOME_TEXT[`${event.reason}:${event.answer}`] ?? 'Resolved';
    const by = event.actor ? ` by <@${event.actor}>` : '';
    const text = `*${escapeSlackText(post.agentName)}* — \`${escapeSlackText(post.toolName)}\` (${post.risk}): ${outcome}${by}.`;
    try {
      await post.connection.web.chat.update({
        channel: post.channel,
        ts: post.ts,
        text,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
      });
    } catch (error) {
      warn(`slack: could not update a resolved approval request: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /**
   * Says so in the thread when a turn fails with nobody rendering it.
   *
   * The intake path reports a failure through the renderer it opened, so a
   * turn this process started is always answered. A turn it did NOT start
   * has no renderer: one the startup sweep failed because the last daemon
   * died mid-turn, or one whose recovery could not be finished. Those are
   * exactly the cases where the person is still looking at the thread,
   * and silence there reads as an agent that simply never replied.
   *
   * The routing has to come from the durable session, because the only
   * in-memory copy died with the process that had it.
   */
  /**
   * Post a turn's outcome into its thread ahead of a renderer queued behind
   * it, when there is one — through that renderer's placeholder, so the
   * thread reads in order — and as fresh messages otherwise. Each chunk on
   * its own, the way `finalize` posts overflow: one refused chunk must not
   * cost the rest of the answer.
   */
  const postAheadOf = async (
    behind: HandoverClaim | undefined,
    connection: AgentConnection,
    channel: string,
    thread: string | undefined,
    chunks: readonly string[],
    between?: () => Promise<void>,
  ): Promise<void> => {
    if (behind && await behind.take(chunks, between)) {
      return;
    }
    for (const chunk of chunks) {
      try {
        await connection.web.chat.postMessage({
          channel,
          text: chunk,
          ...(thread ? { thread_ts: thread } : {}),
        });
      } catch (error) {
        warn(`slack: could not post part of a turn's outcome: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (between) {
      await between();
    }
  };

  /**
   * The files an unrendered turn produced, taken off the session the moment
   * its outcome arrives — before anything is awaited, so a next turn's files
   * arriving while this outcome waits on Slack are never mistaken for its.
   */
  const takeUnrenderedFiles = (sessionId: string): string[] => {
    const paths = unrenderedFiles.get(sessionId) ?? [];
    unrenderedFiles.delete(sessionId);
    return paths;
  };

  /** Post the files an unrendered turn produced into its thread, in order. */
  const uploadUnrenderedFiles = async (
    connection: AgentConnection,
    channel: string,
    thread: string | undefined,
    paths: readonly string[],
  ): Promise<void> => {
    for (const filePath of paths) {
      try {
        const data = await readFile(filePath);
        await connection.web.files.uploadV2({
          channel_id: channel,
          file: data,
          filename: path.basename(filePath),
          ...(thread ? { thread_ts: thread } : {}),
        });
      } catch (error) {
        warn(`files.uploadV2 failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  const reportUnrenderedFailure = async (
    event: Extract<StratusEvent, { type: 'session.failed' }>,
    behind: HandoverClaim | undefined,
    files: readonly string[],
  ): Promise<void> => {
    const gateway = gatewayRef;
    if (!gateway?.sessionRouting) {
      return;
    }
    let routing;
    try {
      routing = await gateway.sessionRouting(event.sessionId);
    } catch (error) {
      // A store that cannot answer is not a reason to lose the daemon, and
      // the turn is already failed — there is nothing here to salvage
      // beyond saying why the thread stayed quiet.
      warn(`slack: could not read the routing for a failed turn: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const metadata = routing?.metadata;
    // Another surface's session, or one with no conversation to speak
    // into. Not this adapter's to answer either way.
    if (!routing || metadata?.channel !== 'slack' || typeof metadata.slackChannel !== 'string') {
      return;
    }
    const connection = connectionFor(routing.agentId);
    if (!connection) {
      return;
    }
    const channel = metadata.slackChannel;
    const thread = typeof metadata.slackThread === 'string' ? metadata.slackThread : undefined;
    await postAheadOf(
      behind,
      connection,
      channel,
      thread,
      messageChunks(`Something went wrong: ${event.error}`),
      () => uploadUnrenderedFiles(connection, channel, thread, files),
    );
  };

  /**
   * The other half of `reportUnrenderedFailure`: a turn nobody here was
   * rendering that *finished*. A turn parked on a human when the daemon
   * died is re-asked after the restart, approved, and completed by a
   * process that never opened a placeholder for it — so the approval
   * survived the restart and the reply went nowhere. Posted as a fresh
   * message in the thread, since the placeholder it would have edited
   * belonged to the old process.
   */
  const reportUnrenderedReply = async (
    event: Extract<StratusEvent, { type: 'session.completed' }>,
    behind: HandoverClaim | undefined,
    files: readonly string[],
  ): Promise<void> => {
    const gateway = gatewayRef;
    if (!gateway?.sessionRouting) {
      return;
    }
    let routing;
    try {
      routing = await gateway.sessionRouting(event.sessionId);
    } catch (error) {
      warn(`slack: could not read the routing for a finished turn: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const metadata = routing?.metadata;
    if (!routing || metadata?.channel !== 'slack' || typeof metadata.slackChannel !== 'string') {
      return;
    }
    const connection = connectionFor(routing.agentId);
    if (!connection) {
      return;
    }
    const channel = metadata.slackChannel;
    const thread = typeof metadata.slackThread === 'string' ? metadata.slackThread : undefined;
    // A turn that produced files and no text still has the files to post —
    // and still has to take the placeholder when one is queued behind it.
    // An upload is a new message, so an attachment posted while the newer
    // turn's placeholder sits above it reads as the older turn answering
    // last. `NO_REPLY_TEXT` is what a rendered turn with nothing to say
    // puts in its own message too. With nothing queued behind, there is no
    // order to keep and nothing to say, so the files go on their own.
    const chunks = routing.reply ? messageChunks(routing.reply) : [];
    const posting = chunks.length > 0 ? chunks : (behind && files.length > 0 ? [NO_REPLY_TEXT] : []);
    const uploads = (): Promise<void> => uploadUnrenderedFiles(connection, channel, thread, files);
    if (posting.length === 0) {
      await uploads();
      return;
    }
    await postAheadOf(behind, connection, channel, thread, posting, uploads);
    log(`slack: posted the reply of a turn finished after a restart to ${channel}`);
  };

  const handleInteractive = async (connection: AgentConnection, args: SlackSocketEventArgs): Promise<void> => {
    // Ack first and unconditionally: Slack retries an unacked interaction,
    // and a redelivered click on a request that is no longer pending would
    // read as a second, rejected decision.
    await args.ack();

    const gateway = gatewayRef;
    const action = args.body?.actions?.[0];
    const answer = action?.action_id ? APPROVAL_ACTIONS[action.action_id] : undefined;
    const requestId = action?.value;
    if (!gateway || !answer || !requestId) {
      return;
    }

    const post = approvalPosts.get(requestId);
    const clicker = args.body?.user?.id;
    // An unknown request predates this daemon or was already settled; the
    // click is answered where it was made, not silently dropped.
    if (!post) {
      await tellClicker(connection, args, 'That approval request is no longer pending.');
      // And the message itself is corrected, so the next person to read it
      // is not offered a decision nothing is waiting for — unless it is
      // one still being posted, which is live with the index simply not
      // caught up yet. Slack can show a message before postMessage
      // resolves here, so a fast click lands inside that window, and
      // stripping its buttons would strand the turn until the approval
      // times out: the record written when the post lands does not put
      // them back. Whether anything has already been written on the
      // message is `retireOrphanedPrompt`'s own question, answered from
      // the message rather than from a memory of it.
      if (!rendering.has(requestId)) {
        await retireOrphanedPrompt(connection, args);
      }
      return;
    }
    // A different agent's app relaying a click would bypass the approver
    // set bound to the request, since each app carries its own.
    if (post.connection !== connection) {
      return;
    }
    if (!clicker || !post.approvers.has(clicker)) {
      // The request stays pending: someone who may not decide clicking is
      // not a decision, and consuming the request would let any channel
      // member deny an agent's work.
      await tellClicker(
        connection,
        args,
        `You are not an approver for ${post.agentName}, so that decision was not recorded.`,
      );
      return;
    }

    // The retraction rides on tool.approval-resolved, which the gateway
    // emits from resolveApproval — so a decision and the message showing it
    // cannot disagree, and the timeout path retracts through the same code.
    if (!gateway.resolveApproval({ requestId, answer, actor: clicker })) {
      await tellClicker(connection, args, 'That approval request is no longer pending.');
    }
  };

  const tellClicker = async (
    connection: AgentConnection,
    args: SlackSocketEventArgs,
    text: string,
  ): Promise<void> => {
    const user = args.body?.user?.id;
    const channel = args.body?.channel?.id;
    if (!user || !channel) {
      return;
    }
    const thread = args.body?.message?.thread_ts;
    try {
      await connection.web.chat.postEphemeral({
        channel,
        user,
        text,
        ...(thread ? { thread_ts: thread } : {}),
      });
    } catch (error) {
      warn(`slack: could not send an ephemeral notice: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** One thread, whichever agent is talking in it. */
  const threadKeyFor = (parts: { team: string; conversation: string; thread: string }): string =>
    `${parts.team}:${parts.conversation}:${parts.thread}`;

  /**
   * Records that `agentId` has the thread as of the message at `ts`,
   * evicting the least recently addressed once the map is full.
   *
   * A write older than or equal to the one held is dropped, which is what
   * keeps the holder moving forward only. Both cases happen: a connection
   * running behind another reaches a mention the others handled several
   * messages ago, and a redelivered envelope brings one back later still.
   * Equal means the same message — two connections, or two deliveries of
   * one — which agree on the answer anyway.
   *
   * Slack timestamps compare as strings: `seconds.microseconds`, both
   * parts fixed width, so lexicographic order is chronological order.
   */
  const rememberAddressee = (key: string, agentId: string, ts: string): void => {
    const held = threadAddressee.get(key);
    if (held && held.ts >= ts) {
      return;
    }
    // Re-inserted rather than overwritten: a Map iterates in insertion
    // order, which is what makes the first key the one to evict.
    threadAddressee.delete(key);
    threadAddressee.set(key, { agentId, ts });
    if (threadAddressee.size > THREAD_ADDRESSEE_CAPACITY) {
      const oldest = threadAddressee.keys().next();
      if (!oldest.done) {
        threadAddressee.delete(oldest.value);
      }
    }
  };
  /**
   * Which of this process's agents a message names, or undefined if it
   * names none of them.
   *
   * The FIRST in connection order when it names several, and that
   * determinism is the point: every connection sees every message and runs
   * this over the same text and the same array, so all of them agree on who
   * a message handed the thread to — including the connections that will go
   * on to ignore it. Which is what makes the handover record converge
   * without the sockets having to agree on anything, since each agent is
   * its own Socket Mode connection and one can run minutes behind another.
   *
   * Scoped to the message's own workspace, because a bot user id is only
   * unique within one — the same reason the display-name cache is keyed by
   * team. Two agents in two workspaces can hold the same id, and resolving
   * a mention to the wrong one would hand the thread to an agent that
   * cannot see it, leaving the agent that was actually named refusing every
   * reply after.
   *
   * Only agents this adapter has authenticated can be recognized at all.
   * One served by another daemon is invisible here, and both would answer;
   * so is one whose `auth.test` itself failed, since its bot id was never
   * learned.
   */
  const agentNamedIn = (text: string, team: string): string | undefined => {
    for (const [agentId, identity] of botIdentities) {
      if (identity.teamId === team && mentions(text, identity.botUserId)) {
        return agentId;
      }
    }
    return undefined;
  };

  /**
   * Who an untagged reply belongs to, asked of the SESSIONS — the durable
   * answer, for a thread this process has no record of: one it has not seen
   * a message in since it started, or one evicted from `threadAddressee`.
   * Everything else is settled synchronously in `admit`, before this is
   * ever reached.
   *
   * Being in the thread is the first half: a session under a thread's key
   * exists only because someone mentioned that agent here, so an agent
   * follows up only in conversations it was invited into, and stops when
   * the thread is gone. `sessionRouting` is the durable record of that — a
   * restart forgets nothing.
   *
   * Whose turn it is, is the second. In a thread with several agents an
   * unaddressed reply belongs to **whoever spoke last**, the way it does
   * between people: answer the voice that just answered you, and tag
   * someone by name to change that. `lastSpokeAt` orders them — when each
   * agent last *replied*, not when its session last changed, because a turn
   * saves on tool results and approval checkpoints without having said
   * anything, and a recovery resuming after a restart lands in exactly this
   * window.
   *
   * Nobody is the answer when the agents cannot be ordered — a host whose
   * routing carries no `lastSpokeAt`, or an exact tie — because guessing
   * would put two answers under one message. The agent alone in its thread,
   * which is nearly every thread, is answered without the question arising.
   */
  const resolveFollowUpWinner = async (
    parts: { team: string; conversation: string; thread: string },
  ): Promise<string | undefined> => {
    const gateway = gatewayRef;
    if (!gateway?.sessionRouting || !parts.thread) {
      return undefined;
    }
    const engaged: Array<{ agentId: string; lastSpokeAt?: string }> = [];
    // Live connections in this message's OWN workspace. Live, because an
    // agent whose app failed to connect cannot answer anything, and leaving
    // a thread silent because its last speaker is offline is the bug this
    // whole change exists to remove. In-workspace, because a session key
    // carries a team: an agent whose app has moved workspaces still has its
    // old sessions there, and letting those contend for a thread it can no
    // longer receive a message in would leave nobody to answer.
    for (const candidate of connections) {
      if (candidate.teamId !== parts.team) {
        continue;
      }
      const routing = await gateway.sessionRouting(channelSessionKey({
        channel: 'slack',
        agentId: candidate.config.agentId,
        team: parts.team,
        conversation: parts.conversation,
        thread: parts.thread,
      }));
      if (!routing) {
        continue;
      }
      engaged.push({
        agentId: candidate.config.agentId,
        ...(routing.lastSpokeAt !== undefined ? { lastSpokeAt: routing.lastSpokeAt } : {}),
      });
    }
    const first = engaged[0];
    if (!first) {
      return undefined;
    }
    if (engaged.length === 1) {
      return first.agentId;
    }
    let latest: { agentId: string; lastSpokeAt: string } | undefined;
    let tied = false;
    for (const entry of engaged) {
      if (entry.lastSpokeAt === undefined) {
        return undefined;
      }
      if (!latest || entry.lastSpokeAt > latest.lastSpokeAt) {
        latest = { agentId: entry.agentId, lastSpokeAt: entry.lastSpokeAt };
        tied = false;
      } else if (entry.lastSpokeAt === latest.lastSpokeAt) {
        tied = true;
      }
    }
    return tied ? undefined : latest?.agentId;
  };

  /**
   * `resolveFollowUpWinner`, resolved ONCE PER MESSAGE and shared by every
   * agent asking about that message.
   *
   * The sharing is the point. Each agent's own copy of the question is
   * several independent session reads, and turns finishing in between can
   * make two agents' reads disagree: both concluding they are the most
   * recent speaker, so one message is answered twice, or both concluding
   * they are not, so it is answered by nobody. One resolution cannot
   * disagree with itself, which is a stronger guarantee than arbitrating
   * between two that already have.
   *
   * Keyed on the message, so a later reply in the same thread asks again.
   * Bounded, and deliberately not deleted when it settles: an entry has to
   * outlive its own resolution, because an agent it beats may only reach
   * this after the winner has finished, and recomputing for that agent is
   * precisely the disagreement the memo exists to prevent.
   */
  const followUpWinner = (
    parts: { team: string; conversation: string; thread: string },
    ts: string,
  ): Promise<string | undefined> => {
    const key = `${threadKeyFor(parts)}:${ts}`;
    const existing = coldVerdicts.get(key);
    if (existing) {
      return existing;
    }
    const resolving = resolveFollowUpWinner(parts);
    coldVerdicts.set(key, resolving);
    if (coldVerdicts.size > COLD_VERDICT_CAPACITY) {
      const oldest = coldVerdicts.keys().next();
      if (!oldest.done) {
        coldVerdicts.delete(oldest.value);
      }
    }
    return resolving;
  };

  /**
   * Everything about who a message is for that can be decided WITHOUT
   * AWAITING, run straight off the socket's own event emission — so for the
   * whole of it, this process is exactly as far through the conversation as
   * Slack is.
   *
   * That is the point of it being one synchronous block. The Socket Mode
   * client emits envelopes in order, but `ack()` resolves from a WebSocket
   * send callback, so two handlers that ack before deciding anything can
   * come back in either order: a follow-up could then overtake the mention
   * that opened its thread, find neither a record nor a session, and be
   * dropped for good. Nothing here awaits, so nothing can be overtaken —
   * the dedupe and the handover record included, which are the two pieces a
   * later message reads.
   *
   * `undefined` means the message is not this agent's. `settled: false`
   * means only the sessions can still decide it, which is the one case that
   * has to wait — and it is the cold case, where by definition no message
   * of this thread has been seen in this process.
   */
  const admit = (connection: AgentConnection, args: SlackSocketEventArgs): Admission | undefined => {
    const event = args.event;
    if (!gatewayRef || !event || !event.user || event.bot_id || !isPersonSpeaking(event)) {
      return undefined;
    }
    if (event.type !== 'app_mention' && event.type !== 'message') {
      return undefined;
    }
    if (event.user === connection.botUserId) {
      return undefined;
    }

    const isDm = event.channel_type === 'im';
    const team = args.body?.team_id ?? connection.teamId;
    // A top-level mention has no thread_ts; its own ts roots the reply
    // thread that becomes the conversation. DMs are one conversation per
    // peer, unkeyed by thread.
    const thread = isDm ? undefined : event.thread_ts ?? event.ts;
    // Threads only: a DM has one agent by construction.
    const threadKey = thread !== undefined && !isDm
      ? threadKeyFor({ team, conversation: event.channel, thread })
      : undefined;

    const text = event.text ?? '';
    const addressed = isDm || mentions(text, connection.botUserId);

    // Who this message hands the thread to — worked out by EVERY connection
    // that sees it, not only by the one being named, and recorded before any
    // of the rejections below. Each agent is its own Socket Mode connection,
    // so the message naming Bea reaches Ava's socket and Bea's socket
    // independently and in no fixed order; if only Bea recorded the
    // handover, Ava could take the next untagged reply while Bea's socket
    // was still behind, and answer a question that had just been handed
    // away. The message Ava must record is exactly the one Ava ignores.
    const named = agentNamedIn(text, team);
    if (threadKey && named) {
      rememberAddressee(threadKey, named, event.ts);
    }

    if (!addressed) {
      if (event.thread_ts === undefined) {
        // The room is not a conversation: a message that starts a thread,
        // or stands alone, is a follow-up to nothing.
        return undefined;
      }
      if (named) {
        // Somebody else was asked. Tagging an agent hands it the question,
        // and the agent that had it is no longer being asked — two answers
        // to one message is what a thread with a roster in it must never
        // produce.
        return undefined;
      }
    }

    // One Slack MESSAGE, not one delivery. An app subscribed to both
    // `app_mention` and `message.channels` is told about a mention twice —
    // two envelopes carrying two event ids — so keying this on the event
    // id would run the turn twice the moment thread follow-through was
    // switched on. `(channel, ts)` names the message itself, and a
    // redelivery (what the event id was here for) repeats both.
    //
    // After the handover record and not before it: a redelivery re-records
    // the same agent, which costs nothing, while deduping first would drop
    // the record whenever the other copy of a doubly-delivered mention is
    // the one a connection sees second.
    const eventKey = `${connection.config.agentId}:${event.channel}:${event.ts}`;
    if (alreadySeen(eventKey)) {
      return undefined;
    }

    const admission: Admission = {
      event,
      isDm,
      team,
      userId: event.user,
      sessionId: channelSessionKey({
        channel: 'slack',
        agentId: connection.config.agentId,
        team,
        conversation: event.channel,
        ...(thread ? { thread } : {}),
      }),
      ...(thread ? { thread } : {}),
      ...(threadKey ? { threadKey } : {}),
      settled: true,
    };

    if (addressed) {
      // A message that named this agent and others is recorded above under
      // whichever of them comes first in connection order — every agent
      // named answers it, and the thread it leaves behind has one holder
      // that all the sockets agree on, which is the only self-consistent
      // reading of a message that asked several.
      return admission;
    }

    // An untagged reply. The record is what this process has actually seen,
    // in the order it saw it — right even inside the window before a
    // handover reaches the store.
    const holder = threadKey === undefined ? undefined : threadAddressee.get(threadKey);
    if (holder !== undefined && threadKey !== undefined) {
      if (holder.agentId !== connection.config.agentId) {
        return undefined;
      }
      rememberAddressee(threadKey, connection.config.agentId, event.ts);
      return admission;
    }
    // Nothing seen for this thread since startup: only the sessions can
    // answer, and that answer has to be awaited.
    return { ...admission, settled: false };
  };

  const handleInbound = async (connection: AgentConnection, args: SlackSocketEventArgs): Promise<void> => {
    // Decided before the ack, never after it — see `admit`. That block is
    // map and string work measured in microseconds, against an ack window
    // Slack measures in seconds, and the envelope is acked below whatever
    // the decision was.
    const admitted = admit(connection, args);
    // Acked without awaiting it. The ack still leaves as promptly as it ever
    // did — Slack redelivers unacked envelopes, and a turn outlives the ack
    // window many times over — but nothing here needs its send callback, and
    // awaiting one was the single await between receiving a message and
    // taking its place in the queue below. Two handlers waiting on their
    // acks can come back in either order; two handlers that never wait
    // cannot. A failed ack costs a redelivery, which the dedupe absorbs.
    void Promise.resolve(args.ack()).catch((error) => {
      warn(`slack: could not ack an envelope: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (!admitted) {
      return;
    }
    // Re-read rather than carried through the admission: `stop()` can clear
    // it while the ack above is in flight, and a dispatch into a gateway
    // this adapter has let go of is not one to start.
    const gateway = gatewayRef;
    if (!gateway) {
      return;
    }
    const { event, isDm, team, userId, thread, sessionId, threadKey } = admitted;

    // Everything up to (and including) the dispatch call is serialized per
    // session in Slack receipt order: the user lookups and placeholder
    // post below await network I/O, and without this chain a later message
    // could reach gateway.dispatch first — processing the conversation in
    // reverse order in durable history. The chain is claimed here,
    // synchronously, so a message's place in it is fixed by when Slack
    // delivered it and not by how long anything it does takes.
    const previousIntake = intakeChains.get(sessionId) ?? Promise.resolve();
    const intake = previousIntake.then(async () => {
      // The durable half of addressing runs INSIDE the chain, for the same
      // reason: it awaits, and a message that had to ask the sessions must
      // not lose its place to one that did not. A message that turns out
      // not to be this agent's leaves an empty link behind, which is all it
      // should cost.
      if (!admitted.settled) {
        // One verdict for this message, shared with whichever other agents
        // are asking about it — see `followUpWinner`.
        const winner = await followUpWinner(
          { team, conversation: event.channel, thread: event.thread_ts ?? '' },
          event.ts,
        );
        if (winner !== connection.config.agentId) {
          return undefined;
        }
        // Answered from the store rather than from memory: hold it, so the
        // rest of the thread is ordered by receipt like any other.
        if (threadKey) {
          rememberAddressee(threadKey, connection.config.agentId, event.ts);
        }
      }
      const cleaned = await humanizeMentions(connection, event.text ?? '');
      if (cleaned.length === 0) {
        return undefined;
      }
      const author = await displayNameFor(connection, userId);
      // In shared channels the model should know who is speaking; a DM is
      // unambiguous.
      const spoken = isDm ? cleaned : `${author}: ${cleaned}`;
      const userMessage = `${spoken}${attachmentNote(event.files)}`;

      const renderer = new ReplyRenderer(connection.web, event.channel, thread, editIntervalMs, warn);
      try {
        await renderer.open();
      } catch (error) {
        warn(`could not post to ${event.channel}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }

      // The push and the dispatch happen in the same microtask, so queue
      // order matches the gateway's single-flight turn order for this
      // session: index 0 is always the turn currently running.
      const queue = renderers.get(sessionId) ?? [];
      queue.push(renderer);
      renderers.set(sessionId, queue);
      const turn = gateway.dispatch({
        sessionId,
        agentId: connection.config.agentId,
        userMessage,
        turnId: renderer.turnId,
        metadata: {
          channel: 'slack',
          team,
          slackChannel: event.channel,
          slackUser: userId,
          // Carried so a mid-turn approval question is asked in the thread
          // the turn belongs to rather than at the top of a busy channel.
          ...(thread ? { slackThread: thread } : {}),
        },
      });
      return { renderer, turn };
    });
    const settledIntake = intake.then(
      () => undefined,
      () => undefined,
    );
    intakeChains.set(sessionId, settledIntake);
    void settledIntake.then(() => {
      if (intakeChains.get(sessionId) === settledIntake) {
        intakeChains.delete(sessionId);
      }
    });

    const started = await intake;
    if (!started) {
      return;
    }
    const { renderer, turn } = started;

    const removeFromQueue = (): void => {
      const current = renderers.get(sessionId);
      if (current) {
        const index = current.indexOf(renderer);
        if (index >= 0) {
          current.splice(index, 1);
        }
        if (current.length === 0) {
          renderers.delete(sessionId);
        }
      }
    };

    let session: Session | undefined;
    let failure: unknown;
    try {
      session = await turn;
    } catch (error) {
      failure = error;
    }
    // The next queued turn starts the moment this dispatch settles — its
    // events must reach ITS renderer, so this one leaves the queue BEFORE
    // the potentially slow final edit, uploads, and overflow posts.
    removeFromQueue();

    if (session) {
      await renderer.finalize(lastAssistantReply(session));
    } else {
      await renderer.fail(failure instanceof Error ? failure.message : String(failure));
    }
  };

  return {
    name: 'slack',
    resolveOutbound,

    async start(gateway) {
      gatewayRef = gateway;
      unsubscribe = gateway.bus.subscribe((event) => {
        // Approval traffic is not part of a reply: it gets its own message
        // with its own lifetime, and routing it through the running turn's
        // renderer would fold a question into the answer being streamed.
        if (event.type === 'tool.approval-requested') {
          track(renderApprovalRequest(event));
          return;
        }
        if (event.type === 'tool.approval-resolved') {
          track(retractApprovalRequest(event));
          return;
        }
        // A turn ends here in one of two hands. One this adapter started
        // is finished by the renderer it opened at intake, from the
        // session `dispatch` returns. One it did not start — a recovery
        // of a turn parked on a human when the daemon died, or a turn the
        // startup sweep closed out — has no renderer, and is reported
        // from the session's stored routing instead.
        //
        // A renderer in the queue is not proof the outcome is that turn's.
        // The renderer is queued at intake, before the gateway starts the
        // turn, so a message arriving while a recovery is still ahead of
        // it on the session chain has a renderer at the head while the
        // recovery finishes — and the recovery's reply would be swallowed
        // as rendered when nothing rendered it.
        //
        // Which turn is running is exact when the gateway says so: every
        // turn this adapter dispatches carries its renderer's `turnId`, and
        // `activeTurnId` names the one on the session now (`StratusEvent`
        // itself carries no turn identifier), so a turn another surface
        // dispatched to the same session is never taken for this adapter's,
        // whatever order the two started in. A gateway without that answer
        // leaves the order of events: the session reports `running` as
        // each turn begins, and the next `running` is taken to be the
        // head renderer's — right for a recovery, which is always ahead of
        // the message queued behind it, and wrong only for a foreign turn
        // that starts after the message was queued.
        const head = renderers.get(event.sessionId)?.[0];
        const exact = gateway.activeTurnId !== undefined;
        const active = gateway.activeTurnId?.(event.sessionId);
        if (event.type === 'session.updated' && event.status === 'running' && head && (!exact || active === head.turnId)) {
          head.beginTurn();
        }
        // A renderer at the head that has not seen its turn start is
        // queued behind the turn ending now, and its placeholder is
        // already in the thread: the outcome goes through it, so the
        // thread reads in the order the conversation happened.
        const rendered = exact
          ? active !== undefined && (renderers.get(event.sessionId) ?? []).some((renderer) => renderer.turnId === active)
          : head?.turnStarted === true;
        // A file belongs to the turn that produced it. A renderer queued
        // behind a recovery is not its renderer, and uploading through it
        // would put the recovery's attachment below the newer turn's
        // answer — so where the gateway names the running turn, a result
        // from another one is held for that turn's own outcome instead.
        // Without that answer the order of events cannot tell a foreign
        // turn from a renderer still waiting to start, and the renderer
        // keeps what it is handed, as it always has.
        const foreign = exact && !rendered;
        if (event.type === 'tool.completed' && event.result.ok && (foreign || !head)) {
          const produced = collectFilePaths(event.result);
          if (produced.length > 0) {
            const held = [...(unrenderedFiles.get(event.sessionId) ?? []), ...produced];
            // Said out loud when it bites: these are files somebody asked
            // for, and attachments that never arrive with nothing in the
            // log is the hardest kind of loss to work out afterwards.
            if (held.length > MAX_UNRENDERED_FILES) {
              warn(`slack: a turn with no renderer has produced ${held.length} files; only the last ${MAX_UNRENDERED_FILES} will be posted to its thread`);
            }
            unrenderedFiles.set(event.sessionId, held.slice(-MAX_UNRENDERED_FILES));
          }
        }
        // Claimed here, synchronously, rather than inside the report: the
        // report reads the turn's routing from the store first, and the
        // queued turn can finish inside that round trip (see
        // `HandoverClaim`). The claim is released either way, so a report
        // that finds nothing to post — another surface's session, no
        // connection — never leaves the queued reply stalled behind it.
        if (event.type === 'session.failed' && !rendered) {
          const claim = head?.reserveHandover();
          track(reportUnrenderedFailure(event, claim, takeUnrenderedFiles(event.sessionId)).finally(() => claim?.release()));
          return;
        }
        if (event.type === 'session.completed' && !rendered) {
          const claim = head?.reserveHandover();
          track(reportUnrenderedReply(event, claim, takeUnrenderedFiles(event.sessionId)).finally(() => claim?.release()));
          return;
        }
        if ('sessionId' in event) {
          renderers.get(event.sessionId)?.[0]?.onEvent(event, !foreign);
        }
      });

      const known = new Set(gateway.agents().map((agent) => agent.id));
      // Two passes, because who a message names has to be answerable from
      // the first event onwards. Identities are learned for every app
      // FIRST; only then does any socket start delivering. One pass would
      // leave the agents at the front of the roster taking messages while
      // the ones behind them were still authenticating, and a mention of an
      // agent not yet known reads as an untagged reply — which the agent
      // holding that thread would then answer.
      const authenticated: AgentConnection[] = [];
      for (const config of options.agents) {
        if (!known.has(config.agentId)) {
          warn(`slack: no roster agent with id ${config.agentId}; skipping its Slack app`);
          continue;
        }
        try {
          const web = createWeb(config.botToken);
          const auth = await web.auth.test();
          const botUserId = auth.user_id ?? '';
          const teamId = auth.team_id ?? '';
          // Recorded before the socket is even built: an app that never
          // comes up must still be recognizable when somebody names it.
          botIdentities.set(config.agentId, { botUserId, teamId });
          authenticated.push({
            config,
            web,
            socket: createSocket(config.appToken),
            botUserId,
            teamId,
          });
        } catch (error) {
          // One broken app must not take the rest of the fleet down.
          warn(`slack: could not connect ${config.agentId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      for (const connection of authenticated) {
        const { config, socket } = connection;
        try {
          const onEvent = (args: SlackSocketEventArgs): void => {
            const handled = handleInbound(connection, args).catch((error) => {
              warn(`slack event handling failed: ${error instanceof Error ? error.message : String(error)}`);
            });
            inflight.add(handled);
            void handled.finally(() => inflight.delete(handled));
          };
          socket.on('app_mention', onEvent);
          socket.on('message', onEvent);
          socket.on('interactive', (args: SlackSocketEventArgs) => {
            track(handleInteractive(connection, args).catch((error) => {
              warn(`slack interaction handling failed: ${error instanceof Error ? error.message : String(error)}`);
            }));
          });
          await socket.start();
          connections.push(connection);
          log(`slack: ${config.agentId} connected (bot ${connection.botUserId} in team ${connection.teamId})`);
        } catch (error) {
          // Authenticated but not serving: it answers nothing, and stays
          // recognizable so nobody answers in its place.
          warn(`slack: could not connect ${config.agentId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },

    async stop() {
      // Stop intake first, so no new INBOUND event can slip into
      // `inflight` while the drain below runs.
      await Promise.allSettled(connections.map((connection) => connection.socket.disconnect()));
      // Until it stays empty, not once. The bus subscription is still live
      // here — it comes down after the drain, because a turn finishing
      // inside the drain still has an outcome to render — so a turn the
      // gateway is finishing can hand `track` work after any one snapshot
      // was taken. A single snapshot dropped exactly what this drain
      // exists to deliver: a shutdown denies every parked call, and the
      // retraction that takes the live buttons off the message is tracked
      // by a subscriber reacting to that denial, which is to say during
      // the drain rather than before it.
      //
      // This waits for reactions, never for turns: work enters `inflight`
      // only when an event arrives, so a turn that has not finished
      // emitting anything is not something the loop can be waiting on. It
      // ends when the set does, which is when a snapshot drain would have
      // ended, plus the tail it used to leave behind.
      while (inflight.size > 0) {
        await Promise.allSettled([...inflight]);
      }
      unsubscribe?.();
      unsubscribe = undefined;
      gatewayRef = undefined;
      connections.length = 0;
      approvalPosts.clear();
      threadAddressee.clear();
      coldVerdicts.clear();
      botIdentities.clear();
      rendering.clear();
      resolvedWhileRendering.clear();
    },
  };
};
