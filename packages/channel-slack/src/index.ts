import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { Session, StratusEvent, ToolResult } from '@stratusagent/core';
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
}

// The thin surfaces of the Slack SDKs the adapter touches — injectable so
// tests run against fakes with no network. The real factories below wrap
// @slack/socket-mode and @slack/web-api.
export interface SlackSocketEventArgs {
  ack: (response?: unknown) => Promise<void>;
  envelope_id?: string;
  body?: { team_id?: string; event_id?: string };
  event?: SlackInboundEvent;
  retry_num?: number;
}

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
    postMessage(args: { channel: string; text: string; thread_ts?: string }): Promise<{ ts?: string; channel?: string }>;
    update(args: { channel: string; ts: string; text: string }): Promise<unknown>;
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
      this.toolLine = `⚙ ${event.call.toolName}…`;
      this.scheduleEdit();
      return;
    }
    if (event.type === 'tool.completed') {
      this.toolLine = undefined;
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
  let unsubscribe: (() => void) | undefined;
  let gatewayRef: GatewayLike | undefined;

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
        metadata: { channel: 'slack', team, slackChannel: event.channel, slackUser: userId },
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
    },
  };
};
