import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { ApprovalAnswer, JsonObject, Session, StratusEvent, ToolResult } from '@stratusagent/core';
import {
  channelSessionKey,
  type ChannelAdapter,
  type GatewayLike,
  type OutboundMessageRef,
} from '@stratusagent/channels';

const SLACK_MAX_MESSAGE_CHARS = 4000;
const DEFAULT_EDIT_INTERVAL_MS = 1000;
const DEDUPE_CAPACITY = 2000;
const PLACEHOLDER_TEXT = '…';

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
    message?: { ts?: string; thread_ts?: string };
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
 * Renders one turn's reply into Slack with the placeholder-then-edit
 * pattern: post `…` immediately, fold streaming deltas and tool status
 * lines into throttled edits, and finalize with the authoritative reply
 * (split across messages when it outgrows one).
 */
class ReplyRenderer {
  private buffer = '';
  private turnBreakPending = false;
  private toolLine: string | undefined;
  private ref: OutboundMessageRef | undefined;
  private lastEditAt = 0;
  private pendingEdit: NodeJS.Timeout | undefined;
  private editChain: Promise<void> = Promise.resolve();
  private uploadChain: Promise<void> = Promise.resolve();
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

  onEvent(event: StratusEvent): void {
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
      if (event.result.ok) {
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
    this.uploadChain = this.uploadChain
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
    if (!this.ref || this.pendingEdit) {
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
      this.queueEdit(truncateForSlack(this.currentText()));
    }, delay);
    this.pendingEdit.unref?.();
  }

  private queueEdit(text: string): void {
    const ref = this.ref;
    if (!ref) {
      return;
    }
    this.editChain = this.editChain
      .then(() => this.web.chat.update({ channel: ref.channel, ts: ref.ts, text }))
      .then(() => undefined)
      .catch((error) => this.warn(`chat.update failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** Replace the placeholder with the final reply, splitting if oversized. */
  async finalize(reply: string): Promise<void> {
    this.finalized = true;
    if (this.pendingEdit) {
      clearTimeout(this.pendingEdit);
      this.pendingEdit = undefined;
    }
    const text = reply.trim().length > 0 ? reply : '(no reply)';
    const chunks = splitForSlack(text);
    this.queueEdit(chunks[0] ?? '(no reply)');
    await this.editChain;
    await this.uploadChain;
    for (const chunk of chunks.slice(1)) {
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

const lastAssistantReply = (session: Session): string => {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (!message) {
      continue;
    }
    // Stop at the current turn's input: an earlier turn's answer must not
    // be replayed as this turn's reply when the provider returned no text.
    if (message.role === 'user') {
      break;
    }
    if (message.role === 'assistant' && message.content.trim().length > 0) {
      return message.content;
    }
  }
  return '(no reply)';
};

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
  // Requests this process answered, and whose message therefore already
  // shows the outcome. A click can still arrive for one of them from a
  // client rendering the message as it was before the retraction, and
  // rewriting it then would replace a real decision with "no longer
  // pending". Bounded like the event dedupe, and for the same reason: it
  // must not grow for the life of a long-running daemon.
  const settledHere = new Set<string>();
  const settledOrder: string[] = [];
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
  const forgetSettled = (requestId: string): void => {
    settledHere.delete(requestId);
    const at = settledOrder.indexOf(requestId);
    if (at >= 0) {
      settledOrder.splice(at, 1);
    }
  };

  const rememberSettled = (requestId: string): void => {
    if (settledHere.has(requestId)) {
      return;
    }
    settledHere.add(requestId);
    settledOrder.push(requestId);
    if (settledOrder.length > DEDUPE_CAPACITY) {
      const evicted = settledOrder.shift();
      if (evicted) {
        settledHere.delete(evicted);
      }
    }
  };

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
  const retireOrphanedPrompt = async (
    connection: AgentConnection,
    args: SlackSocketEventArgs,
  ): Promise<void> => {
    const channel = args.body?.channel?.id;
    const ts = args.body?.message?.ts;
    if (!channel || !ts) {
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
    rememberSettled(event.requestId);

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
      // The message still shows live buttons, so this request is not
      // settled as far as anyone reading the thread can tell. Take the
      // marker back off: it exists to stop a later click overwriting a
      // real outcome, and there is no outcome on that message to protect.
      // Leaving it set would make the stale prompt unrepairable until this
      // process restarts.
      forgetSettled(event.requestId);
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
  const reportUnrenderedFailure = async (
    event: Extract<StratusEvent, { type: 'session.failed' }>,
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
    const thread = typeof metadata.slackThread === 'string' ? metadata.slackThread : undefined;
    try {
      await connection.web.chat.postMessage({
        channel: metadata.slackChannel,
        text: `Something went wrong: ${event.error}`,
        ...(thread ? { thread_ts: thread } : {}),
      });
    } catch (error) {
      warn(`slack: could not report a failed turn: ${error instanceof Error ? error.message : String(error)}`);
    }
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
      // is not offered a decision nothing is waiting for. Two requests are
      // absent from the index without being orphans, and both keep their
      // buttons:
      //
      // one this process settled has already been rewritten with its real
      // outcome, so this click is a stale render of that message rather
      // than a live question;
      //
      // and one still being posted is live, with the index simply not
      // caught up yet — Slack can show a message before postMessage
      // resolves here, so a fast click lands inside that window. Stripping
      // its buttons would strand the turn until the approval times out,
      // because the record written when the post lands does not put them
      // back.
      if (!settledHere.has(requestId) && !rendering.has(requestId)) {
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
        // A failure with no renderer is not a turn this process is
        // serving — it is one the startup sweep or a failed recovery
        // closed out. Nothing downstream would say anything about it.
        //
        // A non-empty queue is not proof the failure belongs to a turn
        // this adapter dispatched, only that it has one for this session.
        // A renderer is queued at intake, before the gateway starts the
        // turn it belongs to, so a message arriving while a recovery is
        // still ahead of it on the session chain leaves the recovery's
        // failure looking rendered when it is not. Suppressing is the
        // conservative half of that trade: the alternative reports every
        // ordinary failure twice.
        //
        // Telling them apart needs a turn identifier, which `StratusEvent`
        // does not carry — the same gap 05's WS envelope closes with
        // `{ sessionId, turnId, event }`. The routing a line below has it
        // too: recovery events are already delivered to whichever renderer
        // is at the head of the queue, whether or not it is theirs.
        if (event.type === 'session.failed' && !renderers.get(event.sessionId)?.length) {
          track(reportUnrenderedFailure(event));
          return;
        }
        if ('sessionId' in event) {
          renderers.get(event.sessionId)?.[0]?.onEvent(event);
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
      // Stop intake first: with the sockets down no new event can slip
      // into `inflight` after the drain snapshot below, so nothing posts
      // to Slack after stop() returns.
      await Promise.allSettled(connections.map((connection) => connection.socket.disconnect()));
      await Promise.allSettled([...inflight]);
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
