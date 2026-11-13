/*
 * The gateway's public contract: what a channel adapter, an approval
 * transport, a plugin and the daemon's callers see (`GatewayOptions`,
 * `DispatchInput`, `Gateway` and the shapes they use). Types only, moved out
 * of `index.ts` as is; `index.ts` re-exports them, so the package's surface
 * is unchanged.
 */
import type {
  AgentDefinition,
  AlwaysMeans,
  ApprovalAnswer,
  ApprovalDelegationOrigin,
  ApprovalOutcome,
  ApprovalPolicy,
  ApprovalScheduleDestination,
  CredentialScope,
  EventBus,
  ImageAttachment,
  JsonObject,
  ObserveEntry,
  Session,
  Tool,
  ToolCall,
  ToolRisk,
  TrustLevel,
  UnlistedTools,
} from '@stratusagent/core';
import type {
  ConversationArchiver,
  ConversationCreator,
  ConversationInviter,
  ConversationJoiner,
  ConversationReader,
  ParsedSoul,
  ScheduleRecord,
} from '@stratusagent/agents';
import type { OptionalModuleHost } from '@stratusagent/plugins';
import type {
  MemoryPassSummary,
  PluginsConfig,
  RuntimeSelection,
  StateEnvironment,
} from '@stratusagent/state';

import type {
  ChannelReloadOutcome,
  EventDeliveryRow,
  EventIntakeRequest,
  EventIntakeResponse,
  EventSourceConfig,
  EventsSummary,
  IntakeState,
  MemoryPassDetail,
  RestartOutcome,
  RestartRequest,
  RestartStatus,
  SchedulerLimits,
  ShardedSessionStore,
} from './index.ts';

/**
 * A channel adapter as the gateway sees it: started after the roster
 * loads, stopped before the store drains. Structurally identical to
 * `ChannelAdapter` in @stratusagent/core, declared here because it
 * predates the channel contract moving into core, when the gateway could
 * not import it without depending on the channels package.
 */
export interface GatewayChannelAdapter {
  name: string;
  start(gateway: Gateway): Promise<void>;
  stop(): Promise<void>;
  /**
   * Whether the gateway may serve without this channel.
   *
   * A channel whose `start()` rejects is logged and skipped, which is right
   * for a Slack app whose tokens went stale: the rest of the fleet stays
   * up. A required channel fails `start()` instead — after stopping the
   * channels that did come up, and before the scheduler starts or any
   * sweep re-asks an approval, so a daemon refused this way has done no
   * work. The control API is the case: a second `stratus serve` on the
   * same home lost the port to the first, logged it, and went on serving
   * with no channel at all — and the next scheduled firing ran in it,
   * where nobody could approve or hear anything. A host that omits this
   * gets the skip.
   */
  required?: boolean;
  /**
   * Whether this channel starts while the gateway is held (`held: true`).
   * Only a surface for the operator should: the control API, so health can
   * be asked and `promote` sent. A conversation channel must not, or the
   * held daemon would take work. Absent means it waits for `promote()`.
   */
  servesWhileHeld?: boolean;
  /**
   * The addressable outbound seam, mirroring `ChannelAdapter.resolveOutbound`
   * structurally for the same reason the rest of this interface does. Optional: an
   * adapter with no concept of a destination simply lacks it, and the
   * gateway treats absence as "this channel cannot be spoken through".
   * Implementations MUST reject a destination they could not deliver to,
   * with a message fit to show the person who named it.
   */
  resolveOutbound?(address: { agentId: string; to: string; thread?: string; speaker?: { sessionId: string; trust: TrustLevel } }): Promise<{
    post(text: string): Promise<unknown>;
  }>;
  /**
   * The read side of an addressable conversation, mirroring
   * `ChannelAdapter.readConversation`. Optional:
   * an adapter without it cannot be read through `message.read`.
   * Implementations MUST reject a conversation their app may not read,
   * with a sentence for the agent.
   */
  readConversation?(request: {
    agentId: string;
    conversation: string;
    thread?: string;
    after?: string;
    before?: string;
    limit: number;
    sessionId?: string;
    images?: { count: number; bytes: number };
  }): ReturnType<ConversationReader>;
  /**
   * Creates a conversation with the agent's own app, mirroring
   * `ChannelAdapter.createConversation`. Optional: an adapter without it
   * cannot serve `channel.create`. Implementations MUST reject what they
   * can tell is invalid before creating anything, and MUST resolve once
   * the conversation exists, reporting what did not happen after it.
   */
  createConversation?(request: Omit<Parameters<ConversationCreator>[0], 'channel'>): ReturnType<ConversationCreator>;
  /**
   * Joins an existing conversation with the agent's own app, mirroring
   * `ChannelAdapter.joinConversation`. Optional: an adapter without it
   * cannot serve `channel.join`.
   */
  joinConversation?(request: Omit<Parameters<ConversationJoiner>[0], 'channel'>): ReturnType<ConversationJoiner>;
  /**
   * Invites people to an existing conversation through the agent's own
   * app, mirroring `ChannelAdapter.inviteToConversation`. Optional: an
   * adapter without it cannot serve `channel.invite`. Implementations
   * MUST reject only when nobody was invited.
   */
  inviteToConversation?(request: Omit<Parameters<ConversationInviter>[0], 'channel'>): ReturnType<ConversationInviter>;
  /**
   * Archives a conversation the agent's own app created, mirroring
   * `ChannelAdapter.archiveConversation`. Optional: an adapter without it
   * cannot serve `channel.archive`. The gateway has already refused the
   * conversation the work was asked from, which it asks the same adapter's
   * `sessionConversation`; without that, every archive is refused.
   */
  archiveConversation?(request: Omit<Parameters<ConversationArchiver>[0], 'channel'>): ReturnType<ConversationArchiver>;
  /** See `ChannelAdapter.accountFor`. */
  accountFor?(agentId: string): string | undefined;
  /** See `ChannelAdapter.conversationKindFor`. */
  conversationKindFor?(agentId: string, conversation: string): Promise<'channel' | 'direct' | undefined>;
  /** See `ChannelAdapter.sessionConversation`. */
  sessionConversation?(agentId: string, sessionId: string): string | undefined;
  /**
   * Picks up which agents this channel carries without a restart, mirroring
   * `ChannelAdapter.reload`. The gateway calls it on every started channel
   * after a roster reload, one channel at a time, and stops waiting after
   * `channelReloadTimeoutMs`. Optional: a channel without it changes only
   * at a restart.
   */
  reload?(): Promise<void>;
  /**
   * Shows a person a form for a credential an agent asked for, mirroring
   * `ChannelAdapter.requestCredential`. Optional:
   * a channel without it cannot take credentials, and a request made in
   * its conversations is refused instead of announced. Implementations
   * MUST reject when the form reached nobody who can answer it, with a
   * sentence for the agent.
   */
  requestCredential?(request: {
    sessionId: string;
    agentId: string;
    requestId: string;
    name: string;
    scope: CredentialScope;
    reason?: string;
    replace?: boolean;
    env?: string;
    metadata: JsonObject;
  }): Promise<void>;
  /** See `ChannelAdapter.credentialReplaceForms`. */
  credentialReplaceForms?: boolean;
  /** See `ChannelAdapter.credentialEnvForms`. */
  credentialEnvForms?: boolean;
  /** See `ChannelAdapter.say`. */
  say?(request: { sessionId: string; agentId: string; text: string }): Promise<void>;
  /**
   * Issues a one-time link to a form for a credential request, for the
   * agent to pass on: what a request falls back to when its conversation
   * cannot show a form, and what an agent asking `via: 'link'` gets. The
   * control API implements it. Optional: a host with no adapter carrying it
   * refuses such requests with the machine-side command instead.
   *
   * The link is the whole credential: whoever opens it can answer the
   * request once, through `provideCredential`, which stays add-only and
   * grants only the agent that asked.
   */
  requestCredentialLink?(request: {
    sessionId: string;
    agentId: string;
    agentName: string;
    requestId: string;
    name: string;
    scope: CredentialScope;
    reason?: string;
    /** The variable the agent's shell will read the key from; the page must say so. */
    env?: string;
  }): Promise<{
    url: string;
    expiresAt: string;
    /** The link is on an address only the machine itself can open (no `api.publicUrl`). */
    localOnly?: boolean;
  }>;
}

/**
 * Where a session came from, as the gateway reports it. Structural for the
 * same reason as the adapter above: core's channel contract declares the
 * matching shape (`SessionRouting`) for adapters to consume.
 */
export interface SessionRouting {
  /** Whose app must do the talking. */
  agentId: string;
  /** The metadata the dispatching surface attached to the session. */
  metadata: JsonObject;
  /**
   * When this agent last spoke, ISO-8601 — its newest reply's timestamp,
   * absent when it has never produced one. Not the session's modification
   * time, which a mid-turn save moves; see `SessionRouting` in @stratusagent/core.
   */
  lastSpokeAt?: string;
  /** The latest turn's text (`latestTurnReply`), when it produced any — see `SessionRouting` in @stratusagent/core. */
  reply?: string;
  /** Whether the turn the session is on is one nobody asked for (`isUnaddressedTurn`) — see `SessionRouting` in @stratusagent/core. */
  unaddressed?: boolean;
}

/**
 * What the gateway hands a policy that needs a human somewhere else: one
 * function that publishes a request and settles on the answer. Handed to a
 * factory rather than exposed on the built gateway because the policy has
 * to exist before the first dispatch, and a gateway cannot be constructed
 * with a policy that needs the gateway.
 */
export interface ApprovalTransport {
  request: ApprovalRequester;
  /**
   * Which plugin package contributes a tool right now, or undefined for a
   * kernel tool (`@stratusagent/permissions`' `grants.contributorOf` takes
   * exactly this shape). Read live from the plugins' tool records rather
   * than snapshotted, for the same reason `tools()` is: a bridge registers
   * what its server advertises, and a grant compared against a stale map
   * would follow the wrong tool.
   */
  contributorOf(toolName: string): string | undefined;
  /**
   * The schedule carve-out, for a policy that understands destinations
   * (`@stratusagent/permissions`' `destinations` option takes exactly this
   * shape). True when the session is a firing of a schedule that still
   * exists, belongs to this agent, and was approved with this destination
   * — the gateway answers from the schedule row, so cancelling revokes.
   */
  destinations: {
    isPreauthorized(session: Session, destination: string): boolean;
    /**
     * The workspace the agent's channel for this `channel:to` destination
     * is connected to (`ChannelAdapter.accountFor`), so a standing grant
     * on one conversation is bound to the workspace it was made in.
     */
    accountFor(agentId: string, destination: string): string | undefined;
    /**
     * Whether a `channel:to` destination is a channel or a DM, asked of the
     * agent's own app for that channel (`ChannelAdapter.conversationKindFor`).
     * Undefined when no adapter can say.
     */
    conversationKindFor(agentId: string, destination: string): Promise<'channel' | 'direct' | undefined>;
  };
  /**
   * The review posture's reviewer (`@stratusagent/permissions`' `review`
   * option wraps it): one bounded model call on the agent's own provider
   * and credentials, exactly the model named (the agent's own when none is)
   * with no fallback and no tools, counted by the provider-call guards like
   * any other call. The case it is shown holds the people's own words and
   * the call, never tool output (`review.ts`).
   *
   * Never rejects: a review that couldn't run answers `failed` with a kind
   * a person reads in the log, and the policy asks about the call.
   */
  review(request: GatewayReviewRequest): Promise<{ reply: Record<string, unknown> } | { failed: string }>;
  /**
   * The values of the stored credentials this agent's soul lists, for the
   * review posture's built-in rule against sending one out. Read from disk
   * per call, like every credential, so a key set a moment ago counts.
   * Never logged; an unreadable store answers nothing.
   */
  secretsFor(agentId: string): Promise<string[]>;
  /**
   * Work the policy runs off the call path, such as a shadow review
   * (`@stratusagent/permissions`' `review.offPath`), from its start: its
   * credential read as well as its reviewer call. A shutdown waits for it
   * after the turns have drained, so what it reports isn't lost.
   */
  offPath(task: Promise<unknown>): void;
}

/** One call put to the reviewer. Mirrors `@stratusagent/permissions`' `ReviewRequest`. */
export interface GatewayReviewRequest {
  session: Session;
  call: ToolCall;
  tool: Tool;
  risk: ToolRisk;
  command?: string;
  origin?: string;
  destination?: string;
  /** `approvals.review.model`; undefined for the agent's own model. */
  model?: string;
  signal: AbortSignal;
}

/**
 * A parked call, published for anyone who can reach a person. Mirrors
 * `@stratusagent/permissions`' `ApprovalRequest` structurally rather than
 * importing it: the gateway consumes any `ApprovalPolicy`, and depending on
 * one implementation of the seam to describe the seam would invert that.
 */
export interface GatewayApprovalRequest {
  session: Session;
  call: { id: string; toolName: string; input: JsonObject };
  risk: ToolRisk;
  /**
   * The site this call would act on, for a tool judged by one
   * (`Tool.originFor`). Passed straight through to whatever renders the
   * request, because the call's arguments do not say where a click lands.
   */
  origin?: string;
  /**
   * True when answering `always` runs this call once and remembers
   * nothing, so a renderer can stop offering one. Passed straight through.
   */
  oneShot?: boolean;
  /** What `always` would remember, when it would. Passed straight through. */
  always?: AlwaysMeans;
  /** Why the review posture is asking. Passed straight through. */
  reviewNote?: string;
  /**
   * When this call first parked, if a restart is re-asking it. The wait is
   * measured from here, so a request keeps the window it started with
   * instead of winning a fresh one — otherwise a daemon that restarts a
   * minute before the deadline grants another full timeout, and one that
   * crash-loops keeps a request alive forever.
   */
  parkedAt?: string;
  signal?: AbortSignal;
}

/**
 * Settles with the answer and, when a person gave it, who — the policy
 * records the actor on a standing grant. Every ending settles: a timeout,
 * an abort, and a shutdown are each a `deny` with nobody behind it.
 */
export type ApprovalRequester = (request: GatewayApprovalRequest) => Promise<ApprovalOutcome>;

/**
 * A parked call as an observer sees it — everything `tool.approval-requested`
 * announced, still outstanding.
 *
 * Listable because an event stream only tells you what happened while you
 * were listening. A surface that connects while a turn is already parked
 * would otherwise show no pending request at all until the next one, and
 * rebuilding the set from the bus means keeping a second copy of state the
 * gateway already holds.
 */
export interface PendingApproval {
  requestId: string;
  sessionId: string;
  agentId: string;
  call: { id: string; toolName: string; input: JsonObject };
  risk: ToolRisk;
  /** The site it would act on, for a tool judged by one. */
  origin?: string;
  /** True when `always` on this call remembers nothing — see the event. */
  oneShot?: boolean;
  /** What `always` would remember, when it would — see the event. */
  always?: AlwaysMeans;
  /** Why the review posture is asking — see the event. */
  reviewNote?: string;
  /** When this call parked, ISO-8601. */
  parkedAt: string;
  /**
   * When it denies itself, ISO-8601. Absent when it never will — the same
   * distinction the announcing event draws.
   */
  expiresAt?: string;
  /** The session's metadata: where the turn is happening. */
  metadata?: JsonObject;
  /** Where a delegated call's work was asked from — see the event. */
  delegatedFrom?: ApprovalDelegationOrigin;
  /** Where a scheduled firing's schedule reports — see the event. */
  scheduleDestination?: ApprovalScheduleDestination;
}

export interface ResolveApprovalInput {
  requestId: string;
  answer: ApprovalAnswer;
  /**
   * The person who decided, in whatever ids their channel uses. Recorded on
   * the resolved event; who is *allowed* to decide is the channel's
   * question, since the approver set is written in its ids.
   */
  actor?: string;
  /**
   * Why, when it was not a person. A channel that cannot deliver a request
   * — nobody configured to ask, nowhere to ask — still has to settle it,
   * and recording that as `decided` would file a denial nobody made
   * alongside the ones somebody did. `timeout` and `cancelled` are not
   * offered here: those are the gateway's own endings to declare.
   */
  reason?: 'decided' | 'undeliverable';
}

/** One registered tool, as an operator's surfaces need to see it. */
export interface GatewayTool {
  name: string;
  description?: string;
  risk: ToolRisk;
  /** The plugin package that contributed it; absent for kernel tools. */
  package?: string;
  /** Whether that package is trusted to declare a tool `safe`. */
  trusted?: boolean;
  /**
   * What a call to it is judged by, when it offers exactly one scope hook
   * (`Tool.commandFor`, `originFor`, `destinationFor`): what an
   * `approvals.rules` matcher for it can name. Absent for none or several.
   */
  scopedBy?: 'command' | 'origin' | 'destination';
}

/** One skill this daemon serves — identity and provenance, never the body. */
export interface GatewaySkill {
  /** Canonical id: bare for an operator-installed skill, `<package>:<skill>` for a plugin's. */
  id: string;
  name: string;
  description: string;
  /** The bare id a plugin's skill also answers to, while no one else claims it. */
  alias?: string;
  /** The plugin package that contributed it; absent for operator-installed skills. */
  package?: string;
  /** Where the SKILL.md lives. */
  path?: string;
  /** Ships with Stratus and is enabled for every agent, whatever its soul's `skills:` says. */
  builtin?: boolean;
}

/** A plugin this daemon was asked to load, and what came of it. */
export interface GatewayPluginStatus {
  package: string;
  name?: string;
  trusted?: boolean;
  tools?: GatewayTool[];
  skills?: GatewaySkill[];
  /** Provider names it registered — what a soul's `provider:` can select. */
  providers?: string[];
  /** Channel kinds it registered, and the agents each carries. */
  channels?: Array<{ kind: string; agents: string[] }>;
  /** Memory store names it registered — what `memoryStore` can select. */
  memory?: string[];
  /** Executor names it registered — what `executor` can select. */
  executors?: string[];
  /** Present when the plugin did not load, and the only field that is. */
  error?: string;
}

/** One provider a soul's `provider:` can select on this daemon. */
export interface GatewayProviderStatus {
  /** The name as a soul writes it: `anthropic`, or a plugin's `ollama`. */
  name: string;
  /** The plugin package that registered it; absent for a built-in. */
  package?: string;
}

export interface GatewayOptions {
  env?: StateEnvironment;
  /** Gateway-wide provider/model overrides applied beneath per-soul pins. */
  selection?: RuntimeSelection;
  /** Channel adapters to run (Slack, …). Started on start(), stopped on stop(). */
  channels?: GatewayChannelAdapter[];
  /**
   * Which (kind, agent) pairs the host's own adapters carry, so a plugin
   * channel claiming one of them is refused at load rather than started
   * beside it. The Slack adapter the CLI wires reports its agents here;
   * a host that omits this lets a plugin double up on a host adapter.
   */
  hostChannelClaims?: Array<{ kind: string; agents: readonly string[] }>;
  /**
   * What an agent whose soul has no `tools:` list may call; see
   * `AgentRunnerOptions.unlistedTools`. Omitted, the gateway asks the home
   * (`unlistedToolsFor`): every tool on one an older build set up, safe
   * tools only on a new one.
   */
  unlistedTools?: UnlistedTools;
  /**
   * The policy, or a factory that builds one from the gateway's approval
   * transport. Pass a factory whenever the policy parks turns on a human
   * reached through a channel — `remote` mode — since that policy needs the
   * transport the gateway is still constructing.
   *
   * Omitted, the runners get core's default: only `safe` tools run, and
   * every other call is refused with an error naming this option. Pass
   * `AllowAllApprovalPolicy` from `@stratusagent/core` to run every call.
   */
  approvals?: ApprovalPolicy | ((transport: ApprovalTransport) => ApprovalPolicy);
  /**
   * How long a parked call waits before it denies itself. 0 waits forever,
   * which is only ever right in a test. Default 15 minutes.
   */
  approvalTimeoutMs?: number;
  /**
   * How many tool turns one dispatched turn may take before the runner
   * wraps it up with a summary. Default 40 (`DEFAULT_MAX_TURNS` in core).
   *
   * Applies to every runner this gateway builds, so a delegated
   * sub-session is held to the same ceiling as the turn that delegated it
   * — they are separate dispatches and each gets its own allowance, not a
   * share of one. `stratus serve` fills it from the trusted config's
   * `maxTurns`.
   */
  maxTurns?: number;
  /**
   * One agent's own budget, replacing `maxTurns` for its messages and the
   * sub-sessions it delegates to that agent. Undefined means the shared one.
   * `stratus serve` fills it from the trusted config's `agentMaxTurns`.
   */
  maxTurnsFor?: (agentId: string) => number | undefined;
  /**
   * Whether an agent keeps working past its budget instead of wrapping up
   * (`AgentRunnerOptions.autoContinue`): `true` without a cap, a number for
   * that many extra allowances per message, undefined for off. `stratus
   * serve` fills it from the trusted config's `autoContinue`.
   */
  autoContinueFor?: (agentId: string) => true | number | undefined;
  /**
   * The activity watchdog: abort a turn when no event for its session has
   * arrived for this long. Progress-based, not wall-clock — any delta, tool
   * event, or response resets it. 0 disables. Default 120s.
   */
  idleTimeoutMs?: number;
  /**
   * The events listener's sources and body limit (card 590), from the
   * trusted config's `events` block. With no sources the event store is
   * never opened, and every delivery is to an unknown source.
   */
  events?: { sources?: Record<string, EventSourceConfig>; maxBodyBytes?: number };
  /**
   * Where the per-agent session stores (`agents/<id>/sessions.db`) and the
   * fleet database (`fleet.db`, holding the schedules and the session
   * index) live. Default `~/.stratus`.
   *
   * A directory rather than the single database path it replaced: after
   * per-agent state there is no one file to point at, which is the
   * point — a store is opened on one agent's path, so no query can return
   * another agent's rows.
   */
  stateDir?: string;
  /**
   * Scheduler limits — the interval floor, the per-agent cap on concurrent
   * scheduled turns, and the tick cadence. Defaults are production values;
   * tests lower them.
   */
  schedules?: SchedulerLimits;
  /**
   * Plugins to load, keyed by package name — the `plugins` block, which the
   * caller has already read from a **trusted** config. The gateway does not
   * go looking for one: a plugin runs in-process with the daemon, and which
   * file may say so is a decision that belongs where the config precedence
   * is already understood.
   */
  plugins?: PluginsConfig;
  /**
   * Which executor runs tool calls, by the name a plugin registered it
   * under (`local`, or absent, is the built-in child-process executor).
   * From a **trusted** config only, like `plugins`: an executor is where
   * an agent's commands run, and a cloned repository swapping a sandbox
   * for the host is the downgrade that rule exists to refuse. A name no
   * loaded plugin registered fails `start()` — a daemon silently running
   * commands on the host when the operator selected a sandbox is worse
   * than one that did not start.
   */
  executor?: string;
  /**
   * Host-owned limits for sub-agents (roadmap 24). `maxConcurrentPerTurn`
   * caps how many one parent turn runs at once; the rest wait for a slot.
   * It must be a whole number of at least 1, or `createGateway` throws.
   */
  subAgents?: { maxConcurrentPerTurn?: number };
  /**
   * Background tasks (AGT-211): `agent.delegate` with `background: true`.
   * Off unless `enabled` is true; then the tool offers `background`. The
   * task table in `fleet.db` is kept either way, for the restart sweep.
   * `maxRunningPerAgent` caps the open tasks one agent has started, keyed
   * by agent id (`{ "atlas": 5 }`), 3 for an agent it doesn't name; each
   * entry must be a whole number of at least 1, or `createGateway` throws.
   */
  tasks?: { enabled?: boolean; maxRunningPerAgent?: Readonly<Record<string, number>> };
  /**
   * Which store backs agent memory, by registered name (`file`, or absent,
   * is the built-in). Same trust rule and same refusal as `executor`: a
   * daemon writing memories into a store the operator did not select is a
   * daemon whose agents remember into the wrong place.
   */
  memoryStore?: string;
  /**
   * How plugin packages are resolved and imported.
   *
   * Worth passing, and `stratus serve` does. `import.meta.resolve` answers
   * relative to the module that calls it, so the default here asks "is this
   * plugin visible from the gateway package" when the question is "is it
   * visible from the thing the operator installed". Those differ under any
   * layout that is not flat — a pnpm install being the obvious one — and the
   * failure is a plugin reported as not installed while sitting right next
   * to the CLI.
   */
  pluginHost?: OptionalModuleHost;
  /**
   * How this daemon comes back after `restart()`: called once the gateway
   * has stopped, by the host that owns the process — `stratus serve`
   * starts a fresh daemon and supervises it. The gateway can drain and
   * stop; only its host can start a process. A host that omits this gives
   * up `restart()`, which then throws `RestartUnsupportedError`.
   */
  onRestart?: (outcome: RestartOutcome) => void | Promise<void>;
  /**
   * Asked by {@link Gateway.checkRestart} before a restart is announced,
   * while this daemon still serves: a throw refuses the restart with its
   * message and leaves the daemon up. `stratus serve` checks here that the
   * trusted config will load, because the replacement refuses to start on
   * one that will not (#214) — and a restart that drained first would turn
   * a half-saved file into an outage. A host that omits this restarts
   * unchecked.
   */
  restartPreflight?: () => Promise<void>;
  /**
   * Start held: migrate, load the roster, and bring up only the channels
   * that serve while held (the control API), so the daemon answers health
   * and nothing else. No conversation channel connects, no schedule fires,
   * no parked approval is re-asked and no abandoned turn is failed, and a
   * dispatch is refused, until `promote()`. For an upgrade that has to prove
   * the new version healthy before it touches any work.
   */
  held?: boolean;
  /**
   * Called once after a held gateway is promoted and its work has begun.
   * `stratus serve --hold-new-version` records the running version here,
   * so the next start of the same version is not held. A rejection is
   * warned about and does not undo the promotion: the daemon is serving.
   */
  onPromoted?: () => Promise<void>;
  /** The drain window a `restart()` uses when the request names none. Default 30s. */
  restartDrainTimeoutMs?: number;
  /**
   * How long a roster reload waits on one channel's `reload()` before it
   * goes on without it. Default 30s. The reload is not cancelled: the
   * channel finishes on its own, and its outcome is logged when it does.
   */
  channelReloadTimeoutMs?: number;
  /** The drain window a `stop()` uses. Default 30s; see `DEFAULT_STOP_DRAIN_TIMEOUT_MS`. */
  stopDrainTimeoutMs?: number;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

export interface DispatchInput {
  /**
   * Stable session id chosen by the caller — channels derive it from the
   * conversation (e.g. a Slack thread), so any later message with the same
   * id resumes the conversation, across daemon restarts included.
   */
  sessionId: string;
  /** Roster agent id. Defaults to the gateway's default agent. */
  agentId?: string;
  userMessage: string;
  /** Images sent with the message — see `Message.images` in `@stratusagent/core`. */
  images?: ImageAttachment[];
  /**
   * Whether the message was said to the agent — see `RunInput.addressed`
   * in `@stratusagent/core`. `false` runs a turn the agent may answer with
   * nothing; omitted, the turn is one somebody asked for.
   */
  addressed?: boolean;
  /**
   * Said to the agent, but possibly needing no answer — see
   * `RunInput.replyOptional` in `@stratusagent/core` (card 601). Messages
   * merged into one turn (card 423) keep it only if every one of them
   * carries it: one that owes an answer makes the turn owe it.
   */
  replyOptional?: boolean;
  /**
   * What was said before this message that the agent never heard — see
   * `RunInput.earlier` in `@stratusagent/core`. Used only when this
   * dispatch creates the session; a session that already exists ignores
   * it, so a caller that cannot tell which case it is in may always send it.
   */
  earlier?: ObserveEntry[];
  metadata?: JsonObject;
  signal?: AbortSignal;
  /**
   * Caller-chosen id for this turn, so events emitted while it runs can be
   * attributed to it. A session processes several turns in sequence and
   * `StratusEvent` carries no turn identifier, so a surface that queued a
   * message has no other way to tell its own deltas from the next caller's.
   *
   * Optional because most callers do not need one: a channel renders
   * whatever arrives for the conversation it is watching.
   */
  turnId?: string;
  /**
   * The caller's name for this message, unique within the session — for a
   * channel, the platform's own message id. A repeat never starts a second
   * turn: while the first is queued or running the repeat resolves with it;
   * once it has finished the repeat resolves with the session as it stands,
   * running nothing and emitting nothing — which may have moved on since,
   * so the repeated message's own reply is `turnReplyFor(session, key)`,
   * not `latestTurnReply`; and a turn whose process died
   * mid-run is continued, once (`AgentRunner.continueTurn`), by whichever
   * comes first — the repeat or the next start's sweep. Not on a harness
   * (`runsOnHarness`), whose own tool loop may already have acted on the
   * prompt: that turn is failed, as an unkeyed one is.
   *
   * Stored on the user message in the write that accepts it
   * (`Message.idempotencyKey`), so it lasts as long as the transcript does.
   * A repeat's other fields are not compared, and its `signal` does not
   * reach a turn it attaches to; a failed turn stays failed, and retrying
   * it takes a new key.
   *
   * Optional, and a host that omits it gives up crash-safe dedupe: a
   * channel that delivers at least once can only dedupe in memory, which a
   * restart erases, and a turn that was running when the process died is
   * failed at the next start instead of finished.
   */
  idempotencyKey?: string;
  /**
   * Called, before the dispatch resolves, when it repeats a turn rather
   * than starting or continuing one, and says which kind of repeat:
   *
   * - `live` — it attached to a turn another dispatch with the same key
   *   started in this process and is still waiting on. That dispatch is
   *   alive to render the outcome, so a caller with a reply of its own in
   *   progress takes it down and posts nothing.
   * - `finished` — the turn is over and nothing ran. Its outcome may never
   *   have been posted — the process can die between the turn's last write
   *   and the channel's — and nothing durable says whether it was, so the
   *   caller posts it from the session: `turnReplyFor`, `turnFilesFor`, and
   *   `turnFailureFor` from `@stratusagent/core`, since the session may
   *   have moved on and no event will carry any of it. Said twice beats
   *   never said.
   *
   * Not called for a repeat that continues a turn a crash left unfinished:
   * that turn runs, its events are this caller's, and nobody else is
   * rendering it.
   */
  onRepeat?: (repeat: 'live' | 'finished') => void;
  /**
   * Opts this dispatch into merged turns. A message that arrives while the
   * session's turn is running is not given a turn of its own: every
   * opted-in, addressed dispatch queued by the time that turn ends is
   * answered by ONE next turn, its messages joined in arrival order in one
   * user message (`Message.absorbedKeys` keeps each one's key, so a repeat
   * is that turn). No delay is added; the batch is whatever queued.
   *
   * The first queued dispatch leads: its `turnId` stamps the merged turn's
   * events, and it resolves as any dispatch does. Each later one is
   * absorbed — called here, before it resolves (or rejects) with the same
   * outcome — and, like a `live` repeat, posts nothing of its own: the
   * leader's caller renders the answer. A caller that cannot withdraw what
   * it put up leaves this unset and keeps one turn per dispatch.
   *
   * The merged turn runs at the least trusted sender in it. A turn nobody
   * asked for (`addressed: false`) is never merged.
   *
   * Steering (card 948): while the running turn is itself an opted-in,
   * addressed dispatch for the same agent, the batch waiting behind it is
   * handed to that turn at its next tool step instead (`RunInput.steer`),
   * so the agent reads it before its next call rather than after its whole
   * turn. Every dispatch in the batch, its leader included, is then
   * absorbed into the running turn — called here and settled with that
   * turn's outcome — and the running turn's caller renders the answer. A
   * turn that answers without another tool step leaves the batch to run
   * next, merged, as above.
   */
  onAbsorbed?: () => void;
}

export interface ObserveInput {
  sessionId: string;
  /** Must match the session's agent when given; a session never crosses identities. */
  agentId?: string;
  /** What was said, speaker included — see `ObserveInput.message` in core. */
  message: string;
  /** This message's metadata, read for the speaker's trust; never merged. */
  metadata?: JsonObject;
}

export interface Gateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** The one entrypoint: resolve the agent, load-or-create the session, run a turn. */
  dispatch(input: DispatchInput): Promise<Session>;
  /**
   * A message into an existing session with no turn run on it —
   * `AgentRunner.observe`, on the session's chain so an overheard message
   * and a turn never interleave writes, and behind the same two refusals
   * as `dispatch`: the scheduler's reserved id namespace and the daemon's
   * reserved metadata keys, since text entering a session's context is
   * text entering its next prompt whichever door it came through.
   *
   * Existing only: an agent overhears a conversation it is already in, and
   * a session that would have to be created is one it was never invited
   * to — so a session that does not exist is nothing to hear into, and
   * resolves `undefined` rather than refusing. Read on the chain, which is
   * what makes that answer right: an invitation still in flight — a first
   * mention whose dispatch is queued ahead of this — has created the
   * session by the time this runs, where a read outside the chain would
   * have found nothing and dropped the message for good. A rolled-over
   * transcript refuses like a dispatch would.
   */
  observe(input: ObserveInput): Promise<Session | undefined>;
  /** Live events from every runner, one stream for all consumers. */
  readonly bus: EventBus;
  /** The store shared by every runner (durable across restarts). */
  readonly store: ShardedSessionStore;
  /** The current roster, default agent included. */
  agents(): AgentDefinition[];
  /**
   * Re-read the agents directory and the configured default soul, returning
   * the roster that results. Souls are already re-read on every dispatch, so
   * this is for files that appeared or disappeared since start — an agent
   * created by another surface, or one whose soul was deleted.
   */
  reloadRoster(): Promise<AgentDefinition[]>;
  /**
   * `reloadRoster()`, then what each started channel that can reload
   * (`ChannelAdapter.reload`) did with it, in start order: where a secret
   * stored while the daemon runs is picked up without a restart. A channel
   * missing from the list can't reload, and reads its secrets at the next
   * start. Rejects as `reloadRoster()` does, when the roster won't load.
   */
  reloadRosterAndChannels(): Promise<{ agents: AgentDefinition[]; channels: ChannelReloadOutcome[] }>;
  /**
   * Re-read `~/.stratus/skills/` and serve what is there now, without a
   * restart — the shape `reloadRoster()` established: idempotent,
   * serialized against itself and the roster reload, and a failure that
   * leaves the previous set serving. Plugin-contributed skills are rebuilt
   * from the plugins already loaded (never re-imported), in the same order
   * they loaded, so operator precedence and contested aliases come out as
   * a restart would produce them.
   *
   * A skill that would not load — a malformed `SKILL.md`, a directory whose
   * name is not an id — rejects with the file named and changes nothing:
   * half a catalog is worse than a stale one.
   *
   * Loaded is not enabled: a reloaded skill still reaches only the agents
   * whose souls list it.
   */
  reloadSkills(): Promise<GatewaySkill[]>;
  /**
   * Announce a restart: refuse new turns now, let running ones finish
   * inside the drain window, abort what is still running at the end of
   * it, stop, and hand the process back to the host through `onRestart`.
   * Returns at once with the terms; the drain runs behind it. Idempotent —
   * a second call while one is underway reports the same announcement.
   *
   * What comes back is what a stop-and-start brings back: durable sessions,
   * schedules, and channels; a call parked on a human is denied as
   * cancelled, exactly as a stop denies it. The refusal comes first, which
   * makes the drain's known gap smaller — a turn finishing after the
   * snapshot can still start work the snapshot never saw — but does not
   * close it.
   */
  restart(request?: RestartRequest): RestartStatus;
  /**
   * Whether a `restart()` now would bring the daemon back, as the host
   * judges it (`restartPreflight`): rejects with the host's refusal,
   * resolves when there is none. Separate from `restart()`, which stays
   * synchronous and idempotent, so a caller asks this first — `POST
   * /restart` does.
   */
  checkRestart(): Promise<void>;
  /**
   * The turn currently running on a session, if the caller that started it
   * named one. Single-flight per session is what makes this exact: at most
   * one turn is ever running on a session, so an event emitted for it
   * belongs to this turn and no other.
   */
  activeTurnId(sessionId: string): string | undefined;
  /**
   * True while a side run is running under this session id: a reviewer
   * call (`review:…`) or a memory pass (`memory-pass:…`). Its events reach
   * `bus` like a turn's, so whatever counts provider calls there counts
   * them, but it is not a conversation: nobody can send to it, it is never
   * stored, and a surface that lists conversations leaves it out. Known by
   * the run, not the id's shape, so a dispatched session whose id happens
   * to start the same way is still a conversation.
   */
  isSideRun(sessionId: string): boolean;
  /**
   * Aborts every turn running on a session right now, one recovered after a
   * restart included, the way the watchdog and a restart's window do: each
   * fails with `reason`, its session saved. Returns how many turns are on
   * the session, each now stopping: one aborted earlier that has not
   * settled yet still counts (it is not aborted again), so 0 means nothing
   * is running there at all. An idle or unknown session is 0 and nothing
   * happens. A message queued on the session but not started is left to
   * its caller's own signal. The caller decides who may stop; this asks
   * nothing.
   */
  abortTurns(sessionId: string, reason: string): number;
  /** Every call parked on a human right now, oldest first. */
  pendingApprovals(): PendingApproval[];
  /**
   * Every schedule the fleet has set, oldest first — the audit list the
   * spec demands: an agent that scheduled something an operator cannot see
   * or stop is a bug. Each row is also the scope of its own destination
   * grant, so this doubles as the list of standing permissions to speak.
   */
  schedules(): ScheduleRecord[];
  /**
   * Cancel any agent's schedule — the operator's stop button, and the
   * revocation of the destination grant riding on the row. False when no
   * such schedule exists.
   */
  cancelSchedule(scheduleId: string): boolean;
  /**
   * One request to the events port (card 590): verified, deduplicated,
   * matched against event triggers and recorded, all before the answer.
   * The listener in control-api calls this with the raw body.
   */
  receiveEvent(request: EventIntakeRequest): Promise<EventIntakeResponse>;
  /**
   * Per configured event source: the last delivery, the last refusal and
   * why, and the last 24 hours by status, with the requests refused before
   * they could leave a row (`stratus events`, `/health`). No sources when
   * none is configured.
   */
  eventSummary(): EventsSummary;
  /** Delivery rows, newest first; a row never holds the body. Empty when no source is configured. */
  eventDeliveries(options?: { source?: string; limit?: number }): EventDeliveryRow[];
  /**
   * An agent's memory passes from its ledger, newest first (spec 962).
   * Read from the file each time, so a pass that just ended shows.
   */
  memoryPasses(agentId: string): Promise<MemoryPassSummary[]>;
  /**
   * One pass and the facts it wrote, from the store this daemon writes
   * to (in shadow, the facts it would have written). Undefined when the
   * ledger has no such pass.
   */
  memoryPass(agentId: string, passId: string): Promise<MemoryPassDetail | undefined>;
  /**
   * Every registered tool, with the risk it will actually be judged at and
   * the package it came from.
   *
   * Provenance is the reason this is not `tools.describe()`: "which of
   * these can this daemon run, and whose code is it" is the question the
   * catalog endpoint and 07's tool screens are asking, and a descriptor
   * list answers only half of it. Kernel tools have no package, which is
   * itself the answer for them.
   */
  tools(): GatewayTool[];
  /**
   * Every skill this daemon serves — operator-installed and
   * plugin-contributed — with the ids an allowlist can name. Descriptors
   * only: bodies stay behind `skill.read`, on the agent's own turn.
   */
  skills(): GatewaySkill[];
  /**
   * The plugins this daemon loaded, and the ones it could not — a plugin an
   * operator enabled that failed to load is exactly what they need to see,
   * and an empty list would say the opposite.
   */
  plugins(): GatewayPluginStatus[];
  /**
   * Every provider a soul's `provider:` can select on this daemon: the
   * built-ins, then what loaded plugins registered, in load order. The
   * registry, not the literal — a surface listing providers reads this so
   * a contributed one is offered where the built-ins are.
   */
  providers(): GatewayProviderStatus[];
  /**
   * The soul behind each agent in the current roster, built-in included
   * (which has none).
   *
   * The roster the daemon is *serving*, which the agents directory stops
   * describing the moment a soul is added, deleted, or broken since the last
   * reload — and the gateway keeps dispatching from the soul it cached. A
   * caller that has to answer "what would a turn as this agent run on" needs
   * the pins that answer it, so this hands back the parsed soul rather than a
   * path a second reader would have to re-read (and now read differently).
   *
   * Async because it re-reads each soul file, exactly as `refreshAgent` does
   * before every dispatch: a pin edited on disk is live on the next turn, so
   * a caller answering from the load-time snapshot would name the provider
   * the daemon has already stopped billing. An unreadable file falls back to
   * the cached soul, which is what that next dispatch falls back to as well.
   *
   * An agent is **absent** from this list when its file now declares a
   * different id: `refreshAgent` refuses every dispatch for the old one until
   * the roster reloads, so nothing is served under it and no runtime should
   * be claimed for it. The roster it reports is therefore what can currently
   * run, which is a narrower thing than `agents()`.
   */
  servedSouls(): Promise<Array<{ id: string; soul?: ParsedSoul }>>;
  /**
   * Where a durable session came from — its agent, and the metadata the
   * dispatching surface attached to it.
   *
   * A projection rather than an accessor: the session's messages are not
   * a channel's business, and handing back the whole record to save a few
   * lines would make them one.
   */
  sessionRouting(sessionId: string): Promise<SessionRouting | undefined>;
  /**
   * Whether a session already accepted the message an idempotency key names,
   * as addressed to it: a turn was started for it, finished, running or
   * still queued, here or in the transcript a recent rollover archived
   * (`settleRepeat` reads the same). A turn nobody asked for
   * (`addressed: false`) does not count — that agent heard the message, it
   * did not take it. Lets a channel route a redelivered message to the agent
   * that accepted it rather than to whoever its routing rule picks now.
   */
  holdsMessage(sessionId: string, idempotencyKey: string): Promise<boolean>;
  /**
   * Start a conversation over under the same id, leaving its transcript so
   * far behind as an archived session.
   *
   * The remedy for a session whose trust label cannot honestly be raised. A
   * session from before provenance was tracked reads `unknown`, the label
   * never rises, and some sessions never end — a Slack DM is one resumable
   * session for the life of the install — so without this an operator's
   * own conversation would write `unknown` forever, however carefully the
   * memory it injects was re-asserted. A session boundary is the only move
   * that neither strands the conversation nor quietly raises trust over a
   * transcript nobody re-read: the old session stays exactly what it was,
   * under `<id>:rolledover:<time>-<suffix>`, and the fresh one starts at the top of
   * the lattice with only the routing metadata the channel needs to keep
   * finding it. The fresh session is still `unknown` on its first turn if
   * the memory it injects is — correctly, and that is the case that
   * catches anyone who thinks the rollover alone is the remedy.
   *
   * Refuses a session with a turn in flight: the runner holds the live
   * object and would save the old transcript back over the fresh row.
   */
  rolloverSession(sessionId: string): Promise<{ sessionId: string; archivedAs: string }>;
  /**
   * Settles a parked call. Returns false when the request is not pending —
   * already decided, expired, or belonging to a turn that was cancelled —
   * which is the normal outcome of a button clicked a minute too late, not
   * an error. Callers surface it to whoever clicked; they must never treat
   * it as "try again".
   */
  resolveApproval(input: ResolveApprovalInput): boolean;
  /** Whether the daemon is taking new work. */
  intake(): IntakeState;
  /**
   * Stop taking new work without stopping. Turns already running or queued
   * finish; a new dispatch is refused with `IntakePausedError` carrying
   * `message` (or `DEFAULT_PAUSED_MESSAGE`); due recurring schedules are
   * skipped and one-shots wait. Channels stay connected, so they can say
   * so. Durable: the pause outlives a restart until `resumeIntake`.
   * Pausing again replaces the message and keeps the original `since`.
   */
  pauseIntake(input?: { message?: string }): Promise<IntakeState>;
  /** Take new work again. Idempotent. */
  resumeIntake(): Promise<IntakeState>;
  /** Whether the gateway started held and has not been promoted yet. */
  held(): boolean;
  /**
   * End a held start: connect the remaining channels, start the scheduler,
   * and run the recovery sweeps a normal start runs. Resolves once the
   * channels are up. A no-op on a gateway that is not held. A required
   * channel that fails to start rejects, and the gateway stays held.
   */
  promote(): Promise<void>;
  /**
   * Answers a `credential.requested` with the value an approver entered:
   * stores it add-only (`addNamedCredential`), under the agent or the fleet
   * as the request asked, and adds the name to the requesting agent's soul.
   * The value goes to the credential store and nowhere else — not onto the
   * bus, the log, or the session.
   *
   * Who may answer is the channel's question, as it is for approvals.
   */
  provideCredential(input: ProvideCredentialInput): Promise<ProvideCredentialResult>;
}

export interface ProvideCredentialInput {
  requestId: string;
  /**
   * As entered, line breaks included: a key file such as a PEM private key
   * is stored with the ones inside it. Line breaks at either end are
   * dropped, the way `stratus credential set` drops a trailing one.
   */
  value: string;
  /** Who provided it. Channel-native id (a Slack user). */
  actor?: string;
}

/**
 * `ok: false` carries a sentence for the person who entered the value: the
 * request is gone, the name is already stored, or the value is empty or a
 * PEM key whose line breaks were lost.
 * `granted: false` on success means the soul already listed the name.
 *
 * `retired: true` means the request is no longer pending and no answer
 * can change that, so a channel should take its form down: the name was
 * stored since (add-only means no retry can land), the soul went to another
 * agent, or the request was already answered. Without it the refusal is
 * one a corrected value can clear, like an empty one, and the form stays.
 */
export type ProvideCredentialResult =
  | { ok: true; name: string; scope: CredentialScope; agentId: string; granted: boolean }
  | { ok: false; message: string; retired?: boolean };
