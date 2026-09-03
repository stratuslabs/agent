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
/**
 * Where a session came from, for a channel that has to reach it with no
 * live turn to hang the message on.
 *
 * Deliberately not the session. The routing keys are what the channel
 * itself wrote at dispatch, and reading those back is a different
 * capability from reading the conversation — an adapter that needs the
 * transcript has stopped translating events and become something else.
 */
export interface SessionRouting {
  /** Whose app must do the talking. */
  agentId: string;
  /** The metadata the dispatching channel attached to the session. */
  metadata: JsonObject;
  /**
   * The text the session's latest turn produced (`latestTurnReply` in
   * `@stratusagent/core`, the same rule an adapter finalizes its own turns
   * by; absent when the turn produced none) — for a turn the adapter did
   * not start and so never rendered. A turn
   * parked on a human when the daemon died is re-asked after the restart
   * and finishes in a process that has no placeholder to edit; without
   * this, the approval survived the restart and the reply went nowhere.
   */
  reply?: string;
}

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
   * Where a durable session came from, or undefined if there is no such
   * session.
   *
   * Optional for the same reason `SessionStore.listIdsByStatus` is: a
   * gateway that cannot answer simply cannot be asked, and a caller that
   * needs it says so by checking for the method rather than assuming one
   * exists. An adapter without it loses the ability to speak about a turn
   * whose process is gone — nothing else.
   */
  sessionRouting?(sessionId: string): Promise<SessionRouting | undefined>;
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

/**
 * A destination this adapter is being asked to speak to, outside any
 * conversation it is currently rendering.
 *
 * The agent is part of the address, not ambient context: each agent is its
 * own app on the platform — its own tokens, possibly its own workspace — so
 * a destination id alone does not say whose credentials it should be
 * resolved against, or even whose id space it belongs to.
 */
export interface OutboundAddress {
  /** Whose app must do the talking. */
  agentId: string;
  /**
   * Channel-native destination id — for Slack a channel or DM id
   * (`C…`/`G…`/`D…`), the same convention approver lists already use.
   * Never a Stratus identity: mapping through one adds a lookup that can
   * only be wrong.
   */
  to: string;
}

export interface ChannelAdapter {
  name: string;
  start(gateway: GatewayLike): Promise<void>;
  stop(): Promise<void>;
  /**
   * The write side of an addressable destination — what `message.send` and
   * schedule-creation validation resolve. Optional because it is a
   * capability, not a courtesy: a transport with no concept of a
   * destination simply does not have the method, and a caller that needs
   * it checks, the same way `GatewayLike.sessionRouting` works.
   *
   * The contract is validate-then-hand-over: an implementation MUST refuse
   * — by rejecting, with a message fit to show the person who named the
   * destination — anything it could not actually deliver to (an agent with
   * no app here, a conversation that does not exist or that the agent's
   * app is not a member of), rather than returning a connection whose
   * first `post` fails at 6am with nobody watching. Resolving is therefore
   * also how a destination is checked without sending anything.
   */
  resolveOutbound?(address: OutboundAddress): Promise<OutboundConnection>;
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
