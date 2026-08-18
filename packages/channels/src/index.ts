import type {
  AgentDefinition,
  ApprovalAnswer,
  EventBus,
  JsonObject,
  Session,
} from '@stratusagent/core';

/**
 * One message arriving from a chat platform, normalized. Adapters translate
 * their platform's event shape into this before anything else happens.
 */
export interface InboundMessage {
  /** Channel kind, e.g. 'slack'. */
  channel: string;
  /** Workspace / team identifier. */
  team: string;
  /** The conversation container (Slack: channel id). */
  conversation: string;
  /**
   * Thread identifier within the conversation, when the platform has
   * threads. For a Slack top-level message this is the message's own ts —
   * its reply thread becomes the conversation.
   */
  thread?: string;
  author: { id: string; displayName?: string };
  /** Message text with any bot-mention markup already stripped. */
  text: string;
  /** Whether the agent was explicitly addressed (mention or DM). */
  mentionsAgent: boolean;
  /** Platform event id, used to dedupe redeliveries. */
  eventId: string;
}

/** An outbound message handle the adapter can keep editing. */
export interface OutboundMessageRef {
  channel: string;
  ts: string;
}

/**
 * The write side of one conversation. Streaming replies are the
 * placeholder-then-edit pattern: post once, edit as fragments arrive,
 * finalize with the full text.
 */
export interface OutboundConnection {
  post(text: string): Promise<OutboundMessageRef>;
  edit(ref: OutboundMessageRef, text: string): Promise<void>;
  /** Uploads a local file into the conversation (tool outputs, screenshots). */
  upload(filePath: string, title?: string): Promise<void>;
  /**
   * Optional typing affordance. Platforms without a real bot typing API
   * (Slack among them) no-op here and rely on the placeholder-edit pattern
   * to show liveness.
   */
  typing?(): Promise<void>;
}

/**
 * The slice of the gateway a channel adapter may touch. Adapters translate
 * events only — they dispatch inbound messages and render the event stream
 * back out. Providers, tools, and memory are never theirs to reach; if an
 * adapter needs more, the fix belongs in the gateway.
 */
export interface GatewayLike {
  dispatch(input: {
    sessionId: string;
    agentId?: string;
    userMessage: string;
    metadata?: JsonObject;
    signal?: AbortSignal;
  }): Promise<Session>;
  readonly bus: EventBus;
  agents(): AgentDefinition[];
  /**
   * Settles a call parked on `tool.approval-requested`. False means the
   * request is no longer pending — decided already, expired, or its turn
   * cancelled — which an adapter reports back to whoever answered rather
   * than retrying.
   *
   * Who *may* answer is the adapter's question, not the gateway's: the
   * approver set is written in the channel's own user ids, and posting a
   * request into a conversation must never make everyone in it an approver.
   */
  resolveApproval(input: {
    requestId: string;
    answer: ApprovalAnswer;
    actor?: string;
    /**
     * `undeliverable` when the adapter settled the request itself because
     * it could not put it to anyone. Defaults to `decided`, which means a
     * person answered — never claim it for an automatic denial.
     */
    reason?: 'decided' | 'undeliverable';
  }): boolean;
}

export interface ChannelAdapter {
  name: string;
  start(gateway: GatewayLike): Promise<void>;
  stop(): Promise<void>;
}

export interface ChannelSessionKeyParts {
  /** Channel kind, e.g. 'slack'. */
  channel: string;
  /** The addressed agent — part of the key, so sessions never cross identities. */
  agentId: string;
  team: string;
  conversation: string;
  /**
   * Thread id for threaded containers. Omit for DMs: a DM is deliberately
   * one ongoing conversation per peer, keyed by the conversation alone.
   */
  thread?: string;
}

/**
 * The stable session id for one conversation: `channel:agent:team:conversation[:thread]`.
 * Stable means resumable — any later message with the same parts lands in
 * the same session, across daemon restarts included. Callers pass
 * `thread_ts ?? ts` as the thread for channel messages (a top-level mention
 * roots its own reply-thread conversation) and no thread for DMs.
 */
export const channelSessionKey = (parts: ChannelSessionKeyParts): string => {
  const segments = [parts.channel, parts.agentId, parts.team, parts.conversation];
  if (parts.thread) {
    segments.push(parts.thread);
  }
  return segments.join(':');
};
