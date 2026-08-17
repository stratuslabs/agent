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
    uploadV2(args: { channel_id: string; file: string; filename?: string; title?: string; thread_ts?: string }): Promise<unknown>;
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
      this.buffer += event.delta.text;
      this.scheduleEdit();
      return;
    }
    if (event.type === 'tool.called') {
      this.toolLine = `⚙ ${event.call.toolName}…`;
      this.scheduleEdit();
      return;
    }
    if (event.type === 'tool.completed') {
      this.toolLine = undefined;
      // The next delta or the finalize will refresh the message.
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
      .then(() => this.web.files.uploadV2({
        channel_id: this.channel,
        file: filePath,
        filename: path.basename(filePath),
        ...(this.threadTs ? { thread_ts: this.threadTs } : {}),
      }))
      .then(() => undefined)
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

const truncateForSlack = (text: string): string =>
  text.length <= SLACK_MAX_MESSAGE_CHARS ? text : `${text.slice(0, SLACK_MAX_MESSAGE_CHARS - 1)}…`;

const splitForSlack = (text: string): string[] => {
  if (text.length <= SLACK_MAX_MESSAGE_CHARS) {
    return [text];
  }
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > SLACK_MAX_MESSAGE_CHARS) {
    // Prefer a newline break inside the window; fall back to a hard cut.
    const window = rest.slice(0, SLACK_MAX_MESSAGE_CHARS);
    const breakAt = window.lastIndexOf('\n') > SLACK_MAX_MESSAGE_CHARS / 2 ? window.lastIndexOf('\n') : SLACK_MAX_MESSAGE_CHARS;
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
    if (message && message.role === 'assistant' && message.content.trim().length > 0) {
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

  const displayNameFor = async (web: SlackWebLike, userId: string): Promise<string> => {
    const cached = displayNames.get(userId);
    if (cached) {
      return cached;
    }
    try {
      const info = await web.users.info({ user: userId });
      const name = info.user?.profile?.display_name || info.user?.profile?.real_name || info.user?.name || userId;
      displayNames.set(userId, name);
      return name;
    } catch {
      return userId;
    }
  };

  // Mentions arrive as <@U123> markup; the model should read names.
  const humanizeMentions = async (web: SlackWebLike, text: string, botUserId: string): Promise<string> => {
    const withoutBot = text.replaceAll(`<@${botUserId}>`, '').trim();
    const mentionPattern = /<@([A-Z0-9]+)>/g;
    const ids = [...withoutBot.matchAll(mentionPattern)].map((match) => match[1]).filter((id): id is string => Boolean(id));
    let result = withoutBot;
    for (const id of new Set(ids)) {
      result = result.replaceAll(`<@${id}>`, `@${await displayNameFor(web, id)}`);
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

    const cleaned = await humanizeMentions(connection.web, event.text ?? '', connection.botUserId);
    if (cleaned.length === 0) {
      return;
    }
    const author = await displayNameFor(connection.web, event.user);
    // In shared channels the model should know who is speaking; a DM is
    // unambiguous.
    const userMessage = isDm ? cleaned : `${author}: ${cleaned}`;

    const renderer = new ReplyRenderer(connection.web, event.channel, thread, editIntervalMs, warn);
    try {
      await renderer.open();
    } catch (error) {
      warn(`could not post to ${event.channel}: ${error instanceof Error ? error.message : String(error)}`);
      return;
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
      metadata: { channel: 'slack', team, slackChannel: event.channel, slackUser: event.user },
    });

    try {
      const session = await turn;
      await renderer.finalize(lastAssistantReply(session));
    } catch (error) {
      await renderer.fail(error instanceof Error ? error.message : String(error));
    } finally {
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
      await Promise.allSettled([...inflight]);
      unsubscribe?.();
      unsubscribe = undefined;
      gatewayRef = undefined;
      await Promise.allSettled(connections.map((connection) => connection.socket.disconnect()));
      connections.length = 0;
    },
  };
};
