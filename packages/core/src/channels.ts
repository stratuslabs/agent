import type {
  AgentDefinition,
  ApprovalAnswer,
  CredentialScope,
  EventBus,
  ImageAttachment,
  JsonObject,
  Session,
  TrustLevel,
} from './index.ts';

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
    /**
     * What was said in the conversation before this message that the agent
     * never heard — a thread it is mentioned into partway — oldest first,
     * each entry with its own metadata for its speaker's trust. Used only
     * when the dispatch creates the session; see `RunInput.earlier` in
     * `@stratusagent/core`. A host without it ignores the field, and the
     * agent sees only the message that named it.
     */
    earlier?: Array<{ message: string; metadata?: JsonObject }>;
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
    /**
     * Opts into merged turns: sent while the session's turn runs, this
     * message may be answered by one next turn together with others that
     * queued. Called before the dispatch settles when it was absorbed into
     * such a turn led by an earlier message, whose caller posts the answer,
     * so this one takes down anything of its own and posts nothing. A host
     * without it ignores the field. See `DispatchInput.onAbsorbed` in
     * `@stratusagent/gateway`.
     */
    onAbsorbed?: () => void;
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
   * Aborts every turn running on a session, including one the host
   * recovered after a restart that no adapter started, and returns how many
   * turns are on the session, each now stopping (one already aborted that
   * has not settled still counts; 0 means nothing is running there).
   * Optional: a host without it leaves
   * an adapter able to stop only the turns it dispatched with its own
   * signal. The adapter decides who may stop; the host asks nothing.
   */
  abortTurns?(sessionId: string, reason: string): number;
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
   * Whether a session already accepted the message an idempotency key names,
   * as addressed to it — a turn was started for it, finished or not; a turn
   * nobody asked for (`addressed: false`) does not count. Asked before routing a message
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
  /**
   * Channel-native id of a message in that conversation to reply under
   * (for Slack, its `ts`). Absent, a post goes to the top level. Only what
   * `post` sends is threaded: it names where the words go, not a second
   * destination, so it is not part of what an approval or a schedule's
   * pre-authorization compares.
   */
  thread?: string;
  /**
   * Who is speaking: the session whose turn asked for the post, and the
   * label its words carry (`sessionWriteTrust` of that session, so never
   * above `agent`). An adapter uses it to let the posting agent hear its
   * own threaded post in that thread's session, so a reply under a report
   * has the report in context. Absent, nobody vouches for the words and
   * an adapter observes nothing.
   */
  speaker?: { sessionId: string; trust: TrustLevel };
}

/**
 * A request to read a conversation's recent messages, outside any
 * conversation the adapter is rendering — the read twin of
 * `OutboundAddress`. Every id is channel-native (for Slack, a channel id
 * and message `ts` values), for the same reason `OutboundAddress.to` is.
 */
export interface ConversationReadRequest {
  /** Whose app does the reading: its membership is the boundary. */
  agentId: string;
  /** Channel-native conversation id, e.g. `C0123456`. */
  conversation: string;
  /**
   * The root message id of one thread. Given, the read is that thread's
   * root and replies, oldest first; absent, the conversation's top level,
   * newest first.
   */
  thread?: string;
  /** Only messages after this message id or time, exclusive. */
  after?: string;
  /** Only messages before this message id or time, exclusive. */
  before?: string;
  /** At most this many messages; the caller has already bounded it. */
  limit: number;
  /**
   * The session asking, which the gateway always names. A direct message
   * is readable only from a session living in it, which the adapter
   * decides with its own `sessionConversation`; absent, no DM is.
   */
  sessionId?: string;
}

/** One message as a read returns it: text and who wrote it, not markup. */
export interface ConversationMessage {
  /** Channel-native message id (Slack: its `ts`). */
  id: string;
  /** Channel-native author id; a bot's id when a bot wrote it. */
  author: string;
  /** A display name, when the platform supplies one cheaply. */
  authorName?: string;
  text: string;
  /** ISO-8601 time the message was posted, when derivable. */
  at?: string;
  /** The root message id, for a reply inside a thread. */
  thread?: string;
  /** How many replies a thread root has. */
  replies?: number;
  /** Names of attached files; their contents are not read. */
  files?: string[];
}

/** One of a conversation's bookmarks: plain text, no markup and no ids. */
export interface ConversationBookmark {
  title: string;
  link: string;
}

export interface ConversationReadResult {
  messages: ConversationMessage[];
  /** True when the platform had more messages past `limit`. */
  more: boolean;
  /**
   * The conversation's bookmarks, in the platform's order, on a read of its
   * top level with no `before` or `after`, when it has any. Absent on
   * threads and later pages, and on a platform without bookmarks. Written
   * by the people in the conversation, like its messages.
   */
  bookmarks?: ConversationBookmark[];
  /**
   * Why the bookmarks could not be listed, as a sentence for the agent,
   * when a read that would list them could not. The messages still come
   * back.
   */
  bookmarksUnavailable?: string;
  /** How many bookmarks did not fit in the read's budget and were left out. */
  bookmarksOmitted?: number;
}

/**
 * A request to create a conversation through the agent's own app — what
 * `channel.create` resolves. Every id is channel-native, like
 * `ConversationReadRequest`'s.
 */
export interface ConversationCreateRequest {
  /** Whose app creates it: that app becomes its first member. */
  agentId: string;
  /** The new conversation's name, without a leading `#`. */
  name: string;
  /** Private rather than public. */
  private?: boolean;
  topic?: string;
  purpose?: string;
  /**
   * Who to invite: channel-native user ids, or ids of agents on this host,
   * which the adapter resolves to the user its app for that agent posts as.
   */
  invite?: string[];
}

export interface ConversationCreateResult {
  /** Channel-native id of the new conversation (Slack: `C…`). */
  conversation: string;
  /** Its name as the platform stored it. */
  name: string;
  /** Each `invite` entry that was invited, as the caller named it. */
  invited: string[];
  /** Each `invite` entry that was not, with a sentence for the agent. */
  notInvited: Array<{ who: string; reason: string }>;
  /** A topic or purpose that was asked for and not set, and why. */
  notSet: Array<{ field: 'topic' | 'purpose'; reason: string }>;
}

/**
 * A request for the agent's own app to join an existing conversation —
 * what `channel.join` resolves. Channel-native ids, like
 * `ConversationReadRequest`'s.
 */
export interface ConversationJoinRequest {
  /** Whose app joins. */
  agentId: string;
  /** The conversation to join (Slack: `C…`). */
  conversation: string;
}

export interface ConversationJoinResult {
  /** Channel-native id of the conversation the app is now in. */
  conversation: string;
  /** The app was already a member, so nothing changed. */
  alreadyMember: boolean;
}

/**
 * A request to invite people to a conversation that already exists,
 * through the agent's own app — what `channel.invite` resolves.
 */
export interface ConversationInviteRequest {
  /** Whose app sends the invitation; it has to be a member already. */
  agentId: string;
  /** The conversation to invite them to (Slack: `C…`). */
  conversation: string;
  /**
   * Who to invite: channel-native user ids, or ids of agents on this host,
   * which the adapter resolves to the user its app for that agent posts as.
   */
  invite: string[];
}

export interface ConversationInviteResult {
  /** Each `invite` entry that is now a member, as the caller named it. */
  invited: string[];
  /** Each `invite` entry that was not invited, with a sentence for the agent. */
  notInvited: Array<{ who: string; reason: string }>;
}

/**
 * A request for the agent's own app to archive a conversation it created —
 * what `channel.archive` resolves.
 */
export interface ConversationArchiveRequest {
  /** Whose app archives it; only a conversation that app created qualifies. */
  agentId: string;
  /** The conversation to archive (Slack: `C…`). */
  conversation: string;
}

export interface ConversationArchiveResult {
  /** Channel-native id of the archived conversation. */
  conversation: string;
  /** It was archived already, so nothing changed. */
  alreadyArchived: boolean;
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
  /**
   * A new value for a key the agent already holds, swapped in place. Only
   * an approver may answer it, as with an add; the form should say a key
   * is being replaced.
   */
  replace?: boolean;
  /**
   * The environment variable the agent's shell commands will read the key
   * from once it is stored. The form must say so before anything is typed
   * ("Atlas's shell commands will be able to read this as `GH_TOKEN`"),
   * because answering it is the approval for that too.
   */
  env?: string;
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
  /**
   * True when this adapter's `requestCredential` form honors `replace`:
   * it tells the approver the stored key will be overwritten. Absent on an
   * adapter written before replacements, which the gateway never hands one,
   * since its ordinary add form would rotate a key without saying so.
   */
  credentialReplaceForms?: boolean;
  /**
   * True when this adapter's `requestCredential` form shows `env`: it tells
   * the approver which variable the agent's shell will read the key from.
   * Absent on an adapter written before bindings, which the gateway never
   * hands a request with `env`, since its form would make a key readable by
   * the agent without saying so.
   */
  credentialEnvForms?: boolean;
  /**
   * The read side of an addressable conversation — what `message.read`
   * resolves. Optional, like `resolveOutbound`: a transport with no
   * history (or none it will share) lacks the method, and the gateway
   * says the channel cannot be read.
   *
   * MUST reject, with a sentence for the agent, anything its app could
   * not or should not read: an agent with no app here, a conversation it
   * is not a member of, and any kind of conversation the adapter keeps
   * private to the people in it. The result is quoted to the model, so
   * an implementation returns text, never platform markup or tokens.
   * The one exception to private conversations is the one the asking
   * session lives in (`request.sessionId`, through `sessionConversation`).
   */
  readConversation?(request: ConversationReadRequest): Promise<ConversationReadResult>;
  /**
   * The conversation a session lives in, as this agent's own app here
   * sees it: the conversation id its session key names, when the session
   * id is exactly that key (a thread inside it included). Undefined for
   * any other session: another agent's, another workspace's, a delegated
   * or scheduled one, an archived one, or one on another transport, and
   * for an agent with no connected app here. Decided from the id alone,
   * with no lookup. Both `message.read`'s refusal and the adapter's own
   * `readConversation` ask it, so the two layers cannot disagree about
   * which direct message a session may read: only its own. Optional:
   * without it, no direct message is readable.
   */
  sessionConversation?(agentId: string, sessionId: string): string | undefined;
  /**
   * Creates a conversation with the agent's own app and invites people to
   * it — what `channel.create` resolves. Optional, like `readConversation`:
   * a transport that cannot create conversations lacks the method, and the
   * gateway says so.
   *
   * MUST reject, with a sentence for the agent, a request it can tell is
   * invalid before creating anything (a name, topic or purpose the
   * platform would refuse), so a bad request leaves nothing behind, and a
   * create the platform refuses (no app here, a missing permission, a
   * taken name). Once the conversation exists it MUST resolve: an invite,
   * topic or purpose that then fails goes in `notInvited` or `notSet`,
   * never undoes the conversation, and never turns into a rejection the
   * agent would retry into a second one.
   */
  createConversation?(request: ConversationCreateRequest): Promise<ConversationCreateResult>;
  /**
   * Joins an existing conversation with the agent's own app — what
   * `channel.join` resolves. Optional, like `createConversation`.
   *
   * MUST reject, with a sentence for the agent, anything it did not join:
   * no app here, a missing permission, a conversation the platform will
   * not let an app join on its own (a private one), an archived or unknown
   * one. When the platform's answer leaves it unknown whether the app
   * joined, it MUST reject saying so, and that a retry is safe. Joining a
   * conversation the app is already in resolves with `alreadyMember`.
   */
  joinConversation?(request: ConversationJoinRequest): Promise<ConversationJoinResult>;
  /**
   * Invites people to an existing conversation through the agent's own
   * app — what `channel.invite` resolves. Optional, like
   * `createConversation`.
   *
   * MUST reject only when it knows nobody was invited: a request it
   * refuses before asking the platform (no app here, nobody to invite, too
   * many), or a whole call the platform refused without acting (the app
   * not in the conversation, a missing permission, an archived or unknown
   * conversation). A rejection means the members did not change. Every
   * other outcome resolves, each entry it did not invite in `notInvited`
   * with a reason, including a call that may have partly worked; an entry
   * whose outcome cannot be checked is never claimed as invited.
   */
  inviteToConversation?(request: ConversationInviteRequest): Promise<ConversationInviteResult>;
  /**
   * Archives a conversation the agent's own app created — what
   * `channel.archive` resolves. Optional, like `createConversation`.
   *
   * Resolves only when the conversation is archived, by this call or
   * already (`alreadyArchived`). MUST reject, with a sentence for the
   * agent, anything it did not archive: no app here, an unknown id, a
   * direct message, a conversation shared outside this workspace, a
   * missing permission, an app that is no longer a member, a workspace
   * rule against it. MUST NOT archive a conversation unless the platform
   * says this agent's own app created it and no other agent here uses that
   * app, and refuses when the creator can't be told. When the platform's
   * answer leaves the outcome unknown, it MUST reject saying the
   * conversation may have been archived and that a retry is safe.
   *
   * The gateway refuses the conversation the asking work came from before
   * an adapter is asked, so an adapter need not check that. It asks the
   * adapter's `sessionConversation` which one that is, so an adapter with
   * this method implements that too: without it, every archive is refused.
   */
  archiveConversation?(request: ConversationArchiveRequest): Promise<ConversationArchiveResult>;
  /**
   * The workspace this agent's app is connected to, for a transport whose
   * conversation ids are unique only within one: a Slack team id.
   * Undefined when the agent has no app here or it has not authenticated.
   * A standing per-conversation grant records it and matches only under
   * the same one. Optional: a transport whose ids are globally unique
   * lacks the method.
   */
  accountFor?(agentId: string): string | undefined;
  /**
   * Whether a conversation is a channel (`channel`, public or private) or
   * a direct message (`direct`, including a group DM), as this agent's own
   * app sees it. Undefined when it cannot say: no app, not connected, or
   * a conversation it cannot see. The operator's standing channel
   * authorization (`approvals.channels`) covers `channel` only, so an
   * implementation never guesses `channel` from an id's shape. Optional:
   * without it, that authorization never applies on this transport.
   */
  conversationKindFor?(agentId: string, conversation: string): Promise<'channel' | 'direct' | undefined>;
  /**
   * Picks up a change in which agents this channel carries, without a
   * restart: an agent whose secrets were stored or removed since `start`,
   * a soul that appeared, one that is gone. The gateway calls it after
   * every roster reload, on each channel that started, one channel at a
   * time, once the new roster is what `GatewayLike.agents()` answers.
   *
   * Connects, reconnects or drops only what changed and leaves every other
   * connection alone, so a conversation on an unchanged app never notices.
   * Settings other than the secrets come from wherever `start` read them,
   * which for the daemon is the config it started with: a reload changes
   * which apps are connected, never how an agent is configured.
   *
   * Resolves once done. Rejects, with a reason for the log, only when the
   * reload could not run at all; one app that would not connect is the
   * adapter's to log, the way `start` does, and not a reason to reject.
   * The gateway stops waiting after a bound and goes on, so a second
   * reload can arrive before the first settled, and `stop()` can arrive
   * during one: an implementation serializes its own reloads, and leaves
   * nothing connected that a stop has already taken down. Optional: a
   * channel without it changes only at a restart.
   */
  reload?(): Promise<void>;
}

export interface ChannelSessionKeyParts {
  /** Channel kind, e.g. 'slack'. */
  channel: string;
  /** The addressed agent — part of the key, so sessions never cross identities. */
  agentId: string;
  team: string;
  conversation: string;
  /**
   * Thread id for threaded containers. Omit for a DM's top level, which is
   * one ongoing conversation per peer keyed by the conversation alone; a
   * thread inside a DM passes its root and is a session of its own.
   */
  thread?: string;
}

/**
 * The stable session id for one conversation: `channel:agent:team:conversation[:thread]`.
 * Stable means resumable — any later message with the same parts lands in
 * the same session, across daemon restarts included. Callers pass
 * `thread_ts ?? ts` as the thread for channel messages (a top-level mention
 * roots its own reply-thread conversation), no thread for a DM's top level,
 * and the thread's root for a reply in a DM thread.
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
 * this module's, and the daemon's config resolves an absent one to
 * `principals` before any adapter sees it. Pass the policy with that
 * default already applied.
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
