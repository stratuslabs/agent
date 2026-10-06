import type {
  AgentDefinition,
  ApprovalAnswer,
  CredentialScope,
  EventBus,
  ImageAttachment,
  JsonObject,
  Session,
  TrustLevel,
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
 * The write side of one conversation. `post` is the whole of what every
 * caller needs: the gateway's `message.send` and schedule delivery only ever
 * post. Everything else is a capability a platform may not have, so it is
 * optional, and a caller that wants it checks for the method rather than
 * assuming it — the way `ChannelAdapter.resolveOutbound` works.
 *
 * Streaming by placeholder-then-edit (post once, edit as fragments arrive,
 * finalize with the full text) is how a platform with editable messages
 * shows a reply forming. A text-message channel has no such thing — an
 * iMessage edit is visibly marked and capped — so it posts the finished
 * reply instead.
 */
export interface OutboundConnection {
  post(text: string): Promise<OutboundMessageRef>;
  /**
   * Rewrites a message this connection posted. A channel without it gives
   * up streaming a reply in place: it posts the final text once.
   */
  edit?(ref: OutboundMessageRef, text: string): Promise<void>;
  /**
   * Uploads a local file into the conversation (tool outputs, screenshots).
   * A channel without it cannot deliver files over an addressable
   * destination; a caller says so instead of dropping the file silently.
   */
  upload?(filePath: string, title?: string): Promise<void>;
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
   * When this agent last SPOKE in the conversation, ISO-8601 — the
   * timestamp of its newest reply, absent when it has never produced one.
   *
   * Deliberately not the session's modification time, which moves on every
   * save a turn makes: a tool result, an approval checkpoint, a recovery
   * resuming after a restart. An agent part-way through a long turn would
   * look like the most recent speaker under that reading while another
   * agent had actually answered, and the Slack adapter orders the agents
   * sharing a thread by this to decide whose an untagged follow-up is.
   *
   * A file counts: a turn whose tool result carried one (`filePathsOf` in
   * `@stratusagent/core`) put something in the thread, whether or not it
   * said a word beside it.
   *
   * Still routing, not transcript: it says *when* an agent spoke, never
   * what was said. Optional because a host may not track it; a caller that
   * needs to order two sessions checks for it rather than assuming, and
   * says what it gives up without it.
   */
  lastSpokeAt?: string;
  /**
   * When the agent last answered a message that ADDRESSED it — its newest
   * reply to a turn somebody asked for, ISO-8601 — and absent when it never
   * has. The anchor of an attention window: an agent that judges whether
   * to speak does so for a bounded stretch after being spoken to, and a
   * reply it chose to give on a turn nobody asked for does not move the
   * anchor, or a talkative judge would keep itself attentive for good.
   * `lastSpokeAt` stays the thread rule's answer, which counts every reply.
   */
  lastAnsweredAt?: string;
  /**
   * How many user messages the session holds after that answer — heard,
   * judged, or asked and left unanswered — and every one of them when it
   * never has. With `lastAnsweredAt`, the two halves of the window, both
   * read from the session rather than remembered in-process, so a restart
   * forgets nothing about who is still listening. Absent from a host that
   * does not count.
   */
  heardSinceAnswered?: number;
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
  /**
   * Whether the turn the session is on is one nobody asked for — its
   * newest user message was dispatched `addressed: false`
   * (`isUnaddressedTurn` in `@stratusagent/core`). Read for a turn the
   * adapter did not render: a judged turn the daemon died inside is
   * failed at the next start by a process with no renderer for it, and
   * an error note posted for a turn nobody asked for, that said nothing,
   * is the interruption the turn existed to avoid.
   */
  unaddressed?: boolean;
}

export interface GatewayLike {
  dispatch(input: {
    sessionId: string;
    agentId?: string;
    userMessage: string;
    /** Images sent with the message — see `Message.images` in `@stratusagent/core`. */
    images?: ImageAttachment[];
    /**
     * Whether the message was said to the agent — see `RunInput.addressed`
     * in `@stratusagent/core`. `false` runs a turn the agent may answer
     * with nothing: the session completes with no reply, and the adapter
     * posts nothing for it.
     */
    addressed?: boolean;
    metadata?: JsonObject;
    signal?: AbortSignal;
    /**
     * Caller-chosen id for this turn, so the adapter can tell its own turn's
     * events from another caller's on the same session — see `activeTurnId`.
     */
    turnId?: string;
    /**
     * The platform's own id for the message, unique within the session, so
     * a redelivery never starts a second turn — across a restart too, which
     * in-memory dedupe cannot survive. A repeat resolves with the original
     * turn: the live one, the finished session, or one the gateway continued
     * after a crash. A finished session may have moved on since, so the
     * reply to post is `turnReplyFor(session, key)` from
     * `@stratusagent/core`, never the latest one. See `DispatchInput.idempotencyKey` in
     * `@stratusagent/gateway`.
     *
     * A host without it ignores the field, and the adapter's own dedupe is
     * all there is.
     */
    idempotencyKey?: string;
    /**
     * Called before the dispatch resolves when it repeats a turn. `live`:
     * another dispatch of the same key in this process is still waiting on
     * it and posts its outcome, so this caller takes down anything of its
     * own and posts nothing. `finished`: nothing ran and no event will
     * come, and the outcome may never have been posted, so this caller
     * posts it from the session — `turnReplyFor`, `turnFilesFor`,
     * `turnFailureFor` in `@stratusagent/core`. Not called for a repeat
     * that continues a turn a crash left unfinished, which this caller
     * renders as its own. See `DispatchInput.onRepeat` in
     * `@stratusagent/gateway`.
     */
    onRepeat?: (repeat: 'live' | 'finished') => void;
  }): Promise<Session>;
  readonly bus: EventBus;
  agents(): AgentDefinition[];
  /**
   * The `turnId` of the turn currently running on a session, if its caller
   * named one. Optional: a host that omits it leaves the adapter to guess
   * which turn an outcome belongs to from the order events arrive in, which
   * is right for every turn the adapter started itself and wrong for a turn
   * another surface dispatched to the same session while a message of the
   * adapter's was queued behind it.
   */
  activeTurnId?(sessionId: string): string | undefined;
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
   * Whether a session already holds the message an idempotency key names — a
   * turn was started for it, finished or not. Asked before routing a message
   * that more than one agent could answer: one an agent already accepted is
   * that agent's, whoever the routing rule would pick now. Optional: a host
   * without it leaves the choice to the rule alone, which after a restart can
   * hand a redelivered message to an agent that has spoken since — and that
   * agent, holding no key for it, runs it again.
   */
  holdsMessage?(sessionId: string, idempotencyKey: string): Promise<boolean>;
  /**
   * A message that reaches a session without running a turn: something
   * said in a conversation the agent is in, to somebody else. The next
   * turn the agent takes has it in hand; nothing is posted now.
   *
   * Resolves `undefined` when there is no such session: an agent hears
   * only conversations it is already in, and the host is the one to say
   * so — on the session's own chain, behind any turn queued ahead, which
   * is what an adapter cannot do from outside. An adapter that checked
   * membership itself first would find nothing for an agent whose
   * invitation is still being written, and drop the message for good.
   *
   * Optional, like `sessionRouting`. A host that omits it gives up
   * overhearing: its agents hear only what they answer, which is what
   * every agent did before this existed.
   */
  observe?(input: {
    sessionId: string;
    agentId?: string;
    message: string;
    metadata?: JsonObject;
  }): Promise<Session | undefined>;
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
  /**
   * Answers a `credential.requested` with the value a person entered.
   * `ok: false` carries a sentence to show them. `retired` on it means no
   * answer to this request can ever land (the name was stored since, or
   * the request is gone), so the adapter should take the form down rather
   * than leave a button that can only be refused.
   *
   * As with approvals, who may answer is the adapter's question: the
   * approver set is written in the channel's own user ids. The value is
   * handed over here and nowhere else — an adapter never logs it, posts it,
   * or passes it to `dispatch`.
   *
   * Optional: a host that omits it gives up taking credentials from a
   * channel, and an adapter says so to whoever tried instead of offering a
   * form that cannot land.
   */
  provideCredential?(input: {
    requestId: string;
    value: string;
    actor?: string;
  }): Promise<{ ok: true } | { ok: false; message: string; retired?: boolean }>;
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

/**
 * A credential an agent asked for, handed to the channel its conversation
 * is in so a person there can be shown a form. Everything the answer needs
 * stays with the gateway under `requestId`; the channel only has to show
 * the question and quote the id back through `GatewayLike.provideCredential`.
 */
export interface ChannelCredentialRequest {
  sessionId: string;
  agentId: string;
  requestId: string;
  name: string;
  scope: CredentialScope;
  /** The agent's own words for why; show them as the agent's. */
  reason?: string;
  /** The session's routing metadata: where the conversation is. */
  metadata: JsonObject;
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
  /**
   * Shows a person in the conversation a form for a credential the agent
   * asked for. Optional, like `resolveOutbound`: a channel without it
   * cannot take credentials, and the gateway refuses a request made in its
   * conversations rather than telling the agent someone was asked.
   *
   * Resolves once the form is in front of someone who can answer it, and
   * MUST reject otherwise (the post failed, nobody here may answer, the
   * agent has no app connected), with a sentence for the agent: the
   * gateway drops the request and hands the agent that sentence, because
   * a request nobody can see would otherwise wait forever while the agent
   * tells its user the operator was asked.
   */
  requestCredential?(request: ChannelCredentialRequest): Promise<void>;
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

/**
 * Whether a sender outside the principals list gets a turn at all.
 * `anyone` admits them, labelled `unknown`; `principals` refuses them
 * before a turn starts, and an adapter that overhears must not let the
 * agent overhear them either — the text would be in the transcript, which
 * is what this mode exists to keep out.
 */
export type AdmitPolicy = 'anyone' | 'principals';

/**
 * Who a channel treats as the operator, and whether anyone else is let in.
 * Ids are the channel's own (a Slack user id, a phone number) — never a
 * Stratus identity, for the same reason `OutboundAddress.to` is not.
 *
 * The two fields answer different questions. `principals` is provenance:
 * an adapter's own admission checks (a DM, a mention) establish nothing
 * about who is typing, and this list is what makes the `user` label mean
 * something. `admit` is authorization. Absent `principals` and `[]` both
 * mean nobody is a principal; an adapter may still tell them apart for
 * presentation (Slack shows everyone's name when there is no list).
 *
 * Which `admit` applies when config gives none is the adapter's call, not
 * this module's: Slack defaults to `anyone`, because only workspace members
 * can reach it, while a channel anyone in the world can message should
 * default to `principals`. Pass the policy with that default already
 * applied.
 */
export interface SenderPolicy {
  principals?: readonly string[];
  admit?: AdmitPolicy;
}

/** Whether `senderId` is on the policy's principals list. */
export const isPrincipal = (policy: SenderPolicy | undefined, senderId: string): boolean =>
  (policy?.principals ?? []).includes(senderId);

/**
 * Whether a message from `senderId` may start a turn. No policy admits:
 * there is nobody's list to refuse against, which is the answer from
 * before admission existed.
 */
export const admitsSender = (policy: SenderPolicy | undefined, senderId: string): boolean =>
  policy === undefined || policy.admit !== 'principals' || isPrincipal(policy, senderId);

/**
 * The trust label a turn from `senderId` carries (`SENDER_TRUST_METADATA_KEY`
 * in `@stratusagent/core`): `user` for a principal, `unknown` for anyone else.
 * Evaluated per message, never per session: a group conversation keys one
 * session for everyone in it.
 */
export const senderTrustFor = (policy: SenderPolicy | undefined, senderId: string): Extract<TrustLevel, 'user' | 'unknown'> =>
  isPrincipal(policy, senderId) ? 'user' : 'unknown';
