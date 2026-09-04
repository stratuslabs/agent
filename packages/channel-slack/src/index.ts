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
 * Code, left exactly as it was written. A fence or a span is the one place
 * a reader means the characters themselves — `**` inside a shell snippet is
 * the snippet — so the conversion below skips them. Capturing the whole
 * delimited run splits the text into alternating prose and code.
 *
 * An unterminated fence runs to the end on purpose: a model that forgets to
 * close one, and every partially streamed block on its way to being closed,
 * would otherwise have its contents rewritten as prose.
 */
const CODE_RUN = /(```[\s\S]*?```|```[\s\S]*$|`[^`\n]*`)/;

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

/** `## Heading`, which mrkdwn has no spelling for at all. */
const MARKDOWN_HEADING = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*$/gm;

const convertProse = (segment: string): string => {
  let converted = segment;
  for (const [pattern, replacement] of MRKDWN_REWRITES) {
    converted = converted.replace(pattern, replacement);
  }
  // Last, so the heading's own text is already converted. Emphasis inside
  // it is dropped rather than nested: the whole line is about to be bold,
  // and `*a *b* c*` renders as neither.
  return converted.replace(MARKDOWN_HEADING, (line, body: string) => {
    const plain = body.replaceAll('*', '').trim();
    return plain.length > 0 ? `*${plain}*` : line;
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
const toSlackMrkdwn = (text: string): string =>
  text
    .split(CODE_RUN)
    .map((segment, index) => (index % 2 === 1 ? segment : convertProse(segment)))
    .join('');

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
 * How an approval request reads once it is settled. `always` deliberately
 * says "this session" out loud: the button is the shortest path to widening
 * what an agent does unattended, and an approver should see the scope they
 * granted in the record of granting it.
 */
const OUTCOME_TEXT: Record<string, string> = {
  'decided:once': 'Allowed once',
  'decided:always': 'Allowed for the rest of this session',
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
): SlackBlock[] => {
  const invocation = renderInvocation(input);
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${escapeSlackText(agentName)}* wants to run \`${escapeSlackText(toolName)}\` (${risk}).`,
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
    {
      type: 'actions',
      // The request id rides on every button rather than in the message
      // reference: Slack gives the value back verbatim, so the gateway is
      // asked about the request that was actually rendered, never one
      // re-derived from a channel and timestamp.
      elements: [
        { type: 'button', action_id: 'stratus_approve_once', text: { type: 'plain_text', text: 'Allow once' }, value: requestId },
        { type: 'button', action_id: 'stratus_approve_always', text: { type: 'plain_text', text: 'Always allow' }, value: requestId, style: 'primary' },
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
  /** Bound at render time, so a later config change cannot widen a live request. */
  approvers: Set<string>;
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
          + `${invocationSummary ? `: ${invocationSummary}` : ''}.`,
        ),
        ...(thread ? { thread_ts: thread } : {}),
        blocks: approvalBlocks(agentName, event.call.toolName, event.risk, event.requestId, event.call.input),
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

    const outcome = OUTCOME_TEXT[`${event.reason}:${event.answer}`] ?? 'Resolved';
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

  const handleInbound = async (connection: AgentConnection, args: SlackSocketEventArgs): Promise<void> => {
    // Ack immediately: Slack redelivers unacked envelopes, and a turn can
    // outlive the ack window many times over.
    await args.ack();

    const gateway = gatewayRef;
    const event = args.event;
    if (!gateway || !event || !event.user || event.bot_id || event.subtype) {
      return;
    }
    const isDm = event.channel_type === 'im';
    if (event.type !== 'app_mention' && !(event.type === 'message' && isDm)) {
      // Mention-only outside DMs.
      return;
    }
    if (event.user === connection.botUserId) {
      return;
    }

    const eventKey = `${connection.config.agentId}:${args.body?.event_id ?? args.envelope_id ?? `${event.channel}:${event.ts}`}`;
    if (alreadySeen(eventKey)) {
      return;
    }

    const team = args.body?.team_id ?? connection.teamId;
    const userId = event.user;
    // A top-level mention has no thread_ts; its own ts roots the reply
    // thread that becomes the conversation. DMs are one conversation per
    // peer, unkeyed by thread.
    const thread = isDm ? undefined : event.thread_ts ?? event.ts;
    const sessionId = channelSessionKey({
      channel: 'slack',
      agentId: connection.config.agentId,
      team,
      conversation: event.channel,
      ...(thread ? { thread } : {}),
    });

    // Everything up to (and including) the dispatch call is serialized per
    // session in Slack receipt order: the user lookups and placeholder
    // post below await network I/O, and without this chain a later message
    // could reach gateway.dispatch first — processing the conversation in
    // reverse order in durable history.
    const previousIntake = intakeChains.get(sessionId) ?? Promise.resolve();
    const intake = previousIntake.then(async () => {
      const cleaned = await humanizeMentions(connection, event.text ?? '');
      if (cleaned.length === 0) {
        return undefined;
      }
      const author = await displayNameFor(connection, userId);
      // In shared channels the model should know who is speaking; a DM is
      // unambiguous.
      const userMessage = isDm ? cleaned : `${author}: ${cleaned}`;

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
      for (const config of options.agents) {
        if (!known.has(config.agentId)) {
          warn(`slack: no roster agent with id ${config.agentId}; skipping its Slack app`);
          continue;
        }
        try {
          const web = createWeb(config.botToken);
          const auth = await web.auth.test();
          const socket = createSocket(config.appToken);
          const connection: AgentConnection = {
            config,
            web,
            socket,
            botUserId: auth.user_id ?? '',
            teamId: auth.team_id ?? '',
          };
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
          // One broken app must not take the rest of the fleet down.
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
      rendering.clear();
      resolvedWhileRendering.clear();
    },
  };
};
