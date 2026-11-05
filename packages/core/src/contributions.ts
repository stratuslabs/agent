/*
 * What a plugin registers besides tools, and the registries that hold it:
 * the built-in names a plugin may not take, provider, channel, memory store
 * and executor contributions, the registration handles and fleet view a
 * plugin's `setup` receives in its `PluginContext`, and the `Plugin` and
 * `PluginRegistry` types themselves. A module of its own because the host,
 * the plugin loader and every plugin build against it. `index.ts`
 * re-exports every name, so the package's one public entry is unchanged.
 */
import type {
  AgentMemoryStore,
  CredentialResolver,
  EventBus,
  Executor,
  ImageAttachment,
  JsonObject,
  MemoryPassHandle,
  ModelProvider,
  ProviderCallGuard,
  Session,
  SessionStatus,
  ToolRegistry,
  ToolRisk,
  TrustLevel,
} from './index.ts';

// ---- contribution kinds a plugin registers besides tools ------------------

/**
 * The providers the host builds itself. Here, in the dependency-free
 * package, because two packages that never import each other need the one
 * list: `@stratusagent/state` resolves a selection against it, and
 * `@stratusagent/plugins` refuses a manifest that declares one of these as
 * a provider of its own — `provider: anthropic` in a soul has to keep
 * meaning the first-party adapter, and a plugin that could shadow it would
 * be a plugin that could receive every key the operator stored for it.
 */
export const BUILTIN_PROVIDER_NAMES = ['demo', 'openai', 'anthropic', 'codex'] as const;
export type BuiltinProviderName = (typeof BUILTIN_PROVIDER_NAMES)[number];

/**
 * The names a trusted config's `executor` and `memoryStore` keys mean the
 * built-ins by — the local child-process executor and the file store —
 * and so the names a plugin may not register: the host's selection
 * special-cases them and would never look a contribution up under them.
 * Here for the same reason the provider list is: the manifest parser and
 * the selection logic live in packages that never import each other.
 */
export const BUILTIN_EXECUTOR_NAME = 'local';
export const BUILTIN_MEMORY_STORE_NAME = 'file';

/**
 * What a soul's `provider:` and `model:` pick, handed to a contributed
 * provider so it can build the right client. `systemPrompt` is the
 * operator's preamble from the config file — the persona itself arrives on
 * every request as `session.agent`, so a provider that ignores this still
 * speaks as the agent; what it loses is the daemon-wide preamble.
 */
export interface ProviderSelection {
  model?: string;
  systemPrompt?: string;
}

/**
 * A provider contributed by a plugin.
 *
 * A factory rather than a `ModelProvider`, and the reason is the soul: a
 * provider is built for a model, and `model:` in one soul and another in
 * the next have to reach it. A registered instance would serve one model
 * for the whole fleet. The host calls `create` once per distinct selection
 * and keeps the result, so a plugin holding a client per model holds one
 * per model, never one per turn.
 */
export interface ProviderContribution {
  /** The name a soul's `provider:` selects — `ollama`, never a package name. */
  name: string;
  create(selection: ProviderSelection): ModelProvider;
  /**
   * Whether providers built here report progress through `onDelta`. A
   * host arms its stall watchdog only for a streaming provider — silence
   * from one means a stall, while a non-streaming call is silent until it
   * answers, and a watchdog armed over it would abort every long turn.
   * Default false, the safe reading for a provider that did not say.
   */
  streams?: boolean;
}

/**
 * The slice of a channel adapter the kernel holds: structurally the
 * `ChannelAdapter` in `channels.ts`, declared on its own because it
 * predates that contract moving into core (the gateway keeps a copy for
 * the same reason). `name` is the channel kind (`slack`, `discord`); the
 * gateway it is started with is the host's.
 */
export interface ChannelAdapterLike {
  name: string;
  start(gateway: unknown): Promise<void>;
  stop(): Promise<void>;
  required?: boolean;
  resolveOutbound?(address: { agentId: string; to: string; thread?: string }): Promise<{
    post(text: string): Promise<unknown>;
  }>;
  /** See `ChannelAdapter.readConversation`. */
  readConversation?(request: {
    agentId: string;
    conversation: string;
    thread?: string;
    after?: string;
    before?: string;
    limit: number;
    sessionId?: string;
    images?: { count: number; bytes: number };
  }): Promise<{
    messages: Array<{
      id: string;
      author: string;
      authorName?: string;
      text: string;
      at?: string;
      thread?: string;
      replies?: number;
      files?: string[];
      images?: ImageAttachment[];
      imageNotes?: string[];
    }>;
    more: boolean;
    bookmarks?: Array<{ title: string; link: string }>;
    bookmarksUnavailable?: string;
    bookmarksOmitted?: number;
  }>;
  /** See `ChannelAdapter.createConversation`. */
  createConversation?(request: {
    agentId: string;
    name: string;
    private?: boolean;
    topic?: string;
    purpose?: string;
    invite?: string[];
  }): Promise<{
    conversation: string;
    name: string;
    invited: string[];
    notInvited: Array<{ who: string; reason: string }>;
    notSet: Array<{ field: 'topic' | 'purpose'; reason: string }>;
  }>;
  /** See `ChannelAdapter.joinConversation`. */
  joinConversation?(request: { agentId: string; conversation: string }): Promise<{ conversation: string; alreadyMember: boolean }>;
  /** See `ChannelAdapter.inviteToConversation`. */
  inviteToConversation?(request: { agentId: string; conversation: string; invite: string[] }): Promise<{
    invited: string[];
    notInvited: Array<{ who: string; reason: string }>;
  }>;
  /** See `ChannelAdapter.archiveConversation`. */
  archiveConversation?(request: { agentId: string; conversation: string }): Promise<{ conversation: string; alreadyArchived: boolean }>;
  /** See `ChannelAdapter.accountFor`. */
  accountFor?(agentId: string): string | undefined;
  /** See `ChannelAdapter.conversationKindFor`. */
  conversationKindFor?(agentId: string, conversation: string): Promise<'channel' | 'direct' | undefined>;
  /** See `ChannelAdapter.sessionConversation`. */
  sessionConversation?(agentId: string, sessionId: string): string | undefined;
  /** See `ChannelAdapter.reload`. */
  reload?(): Promise<void>;
}

/**
 * A channel contributed by a plugin: the adapter plus the agents it
 * carries. Channels key on (agent, kind), not on the agent alone — one
 * agent reachable on Slack and on Discord is two registrations that do
 * not collide; two adapters both claiming Discord for that agent do.
 */
export interface ChannelContribution {
  /** Its `name` is the channel kind. */
  adapter: ChannelAdapterLike;
  /** Agent ids this adapter carries: the (agent, kind) pairs it claims. */
  agents: readonly string[];
}

/**
 * A memory store contributed by a plugin. Every `AgentMemoryStore` method
 * takes the agent id, and that is what makes a contributed store
 * per-agent-resolvable rather than process-global: a plugin that closed
 * over one agent at setup would hand every agent the first agent's
 * memories, the way a `tool-fs` that cached its roots would hand every
 * agent the first agent's files.
 */
/**
 * The revision of `AgentMemoryStore` a contributed store is built against.
 *
 * Bumped when the contract changes shape in a way a plugin compiled against
 * the old one cannot satisfy — which it *silently* cannot, because the
 * change that matters here is the shape of an argument rather than the
 * number of them. A v1 store's `search(agentId, query, limit)` still
 * accepts three arguments and still returns entries when the host hands it
 * an options object; it just binds `{ limit: 10 }` where a number belonged,
 * and answers with an unbounded read or none at all. No runtime check can
 * tell the two apart from the function, so the plugin declares it.
 *
 * - **1** — `append(agentId, content, metadata?, provenance?)` and
 *   `search(agentId, query, limit?)`, the shape before 29.
 * - **2** — `append(agentId, content, options?)` and
 *   `search(agentId, query, options?)`, plus the optional `pin`, `unpin`,
 *   `pinned`, `topics`, and `importEntries`.
 */
export const MEMORY_STORE_CONTRACT_VERSION = 2;

export interface MemoryStoreContribution {
  name: string;
  store: AgentMemoryStore;
  /**
   * Must be `MEMORY_STORE_CONTRACT_VERSION`. A store declaring an older
   * revision — or none, which is what a plugin built before this field
   * existed produces — is refused at registration rather than routed
   * traffic it will mishandle without saying so.
   */
  contract: typeof MEMORY_STORE_CONTRACT_VERSION;
  /**
   * The store accepts a list in `supersedes` (one record retiring several
   * facts) and reads one back as retiring each. Without it, a store gets
   * single ids only: a memory pass can still save and supersede one fact,
   * but never merges several into one. Optional, so a store built before
   * lists keeps loading under the same contract version. The built-in
   * stores accept lists.
   */
  supersedesMany?: true;
}

/** An executor contributed by a plugin, selectable by name in a trusted config. */
export interface ExecutorContribution {
  name: string;
  executor: Executor;
}

/**
 * A name-keyed registry for one contribution kind — the counterpart of
 * `ToolRegistry` for providers, memory stores, and executors. Like it, a
 * bare `Map.set`: it keeps no provenance and refuses nothing, and a plugin
 * never touches one directly. The manifest-bound view in
 * `@stratusagent/plugins` is what refuses an undeclared name or a
 * collision; this is where a whole plugin's contributions land once it has
 * loaded.
 */
export class ContributionRegistry<T> {
  private readonly entries = new Map<string, T>();

  register(name: string, value: T): void {
    this.entries.set(name, value);
  }

  get(name: string): T | undefined {
    return this.entries.get(name);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  list(): T[] {
    return [...this.entries.values()];
  }
}

/** The (agent, kind) key a channel registration claims. */
export const channelClaimKey = (kind: string, agentId: string): string => `${kind}:${agentId}`;

/**
 * The registry for contributed channels. Keyed by (agent, kind) rather than
 * by name, because that is what collides — see `ChannelContribution` — and
 * listed as adapters, because that is what a host starts. Same discipline
 * as the other registries: no refusal here, the view refuses.
 */
export class ChannelRegistry {
  private readonly contributions: ChannelContribution[] = [];

  /** Undefined marks a claim the host made for an adapter it wired itself. */
  private readonly claims = new Map<string, ChannelContribution | undefined>();

  register(contribution: ChannelContribution): void {
    this.contributions.push(contribution);
    for (const agentId of contribution.agents) {
      this.claims.set(channelClaimKey(contribution.adapter.name, agentId), contribution);
    }
  }

  /**
   * Claim (agent, kind) pairs the host carries itself, so a plugin
   * registering the same kind for the same agent collides with the host's
   * adapter exactly as it would with another plugin's — two adapters on
   * one agent's Slack would each answer every message.
   */
  claim(kind: string, agentIds: readonly string[]): void {
    for (const agentId of agentIds) {
      if (!this.claims.has(channelClaimKey(kind, agentId))) {
        this.claims.set(channelClaimKey(kind, agentId), undefined);
      }
    }
  }

  /** Whether some adapter — the host's or a plugin's — already carries this agent on this kind. */
  claimed(kind: string, agentId: string): boolean {
    return this.claims.has(channelClaimKey(kind, agentId));
  }

  list(): ChannelContribution[] {
    return [...this.contributions];
  }
}

/**
 * A memory store that resolves which store serves an agent **per call**.
 *
 * The seam a host selects a contributed store through. The runner and the
 * memory tools are built before any plugin has loaded, so the store they
 * hold has to be one that can change its mind — and an agent-by-agent
 * answer is what keeps a contributed store from being process-global.
 * Every optional method is forwarded only when the chosen store has it: a
 * store that omitted one cannot do that thing, and this must not claim
 * otherwise. The routed store declares them all, because which store
 * serves an agent is not known until the call — so the honest answer for a
 * store that lacks one is the same answer the seam's own default gives
 * (nothing pinned, no topics, no re-assertion).
 */
export const createRoutedMemoryStore = (
  storeFor: (agentId: string) => AgentMemoryStore,
): AgentMemoryStore => ({
  append: (agentId, content, options) => storeFor(agentId).append(agentId, content, options),
  list: (agentId, options) => storeFor(agentId).list(agentId, options),
  search: (agentId, query, options) => storeFor(agentId).search(agentId, query, options),
  forget: (agentId, entryId) => storeFor(agentId).forget(agentId, entryId),
  audit: (agentId) => storeFor(agentId).audit(agentId),
  async reassertTrust(agentId, entryId, trust) {
    const store = storeFor(agentId);
    if (!store.reassertTrust) {
      return false;
    }
    return store.reassertTrust(agentId, entryId, trust);
  },
  async pin(agentId, entryId) {
    const store = storeFor(agentId);
    if (!store.pin) {
      return { pinned: false, reason: 'This memory store does not support pinning.', bytes: 0 };
    }
    return store.pin(agentId, entryId);
  },
  async unpin(agentId, entryId) {
    const store = storeFor(agentId);
    return store.unpin ? store.unpin(agentId, entryId) : false;
  },
  async pinned(agentId, options) {
    const store = storeFor(agentId);
    return store.pinned ? store.pinned(agentId, options) : [];
  },
  async topics(agentId) {
    const store = storeFor(agentId);
    return store.topics ? store.topics(agentId) : [];
  },
  async importEntries(agentId, entries) {
    const store = storeFor(agentId);
    if (!store.importEntries) {
      throw new Error('This memory store cannot import entries.');
    }
    return store.importEntries(agentId, entries);
  },
});

/** The handle a plugin registers providers through. Manifest-bound; see `@stratusagent/plugins`. */
export interface ProviderRegistrationHandle {
  register(contribution: ProviderContribution): void;
}

/**
 * The transport secrets a channel plugin receives, by agent id: the values
 * under `channels.<kind>.<agentId>` in the host's credential store. Every
 * value is a string — a token, an app id — and nothing here is ever
 * resolved through an agent's own credential allowlist.
 */
export type ChannelTransportSecrets = Record<string, Record<string, string>>;

export interface ChannelRegistrationHandle {
  register(contribution: ChannelContribution): void;
  /**
   * The host-owned path for a channel's transport secrets, for a kind
   * this plugin's manifest declares. Host-owned because the invariant is
   * firm: a channel token is a gateway infrastructure secret, never
   * resolvable through the agent-scoped `credentials` resolver, since an
   * agent must not read the tokens of the transport carrying it. Without
   * this a channel plugin could not initialize at all — it has no other
   * defined way to learn which agents it carries.
   */
  transportSecrets(kind: string): Promise<ChannelTransportSecrets>;
}

/**
 * Where each agent's files go, answered by the host.
 *
 * A seam rather than a path in a config block because the layout is this
 * repository's to own: the workspace is `~/.stratus/agents/<id>/workspace`
 * today and was `~/.stratus/workspaces/<id>` before it, and every plugin
 * that joined the agent id onto a root held a copy of that shape. Five of
 * them did, and all five had to change when it moved — which is the cost
 * the `workspaceRoot` key was introduced to avoid and did not.
 *
 * Asked per call, from `session.agent.id`, for the same reason credentials
 * are: the answer is the *calling* agent's, and one captured at setup is
 * the first agent's forever.
 */
export interface AgentWorkspaces {
  /**
   * Where this agent's files go. Resolution only: nothing is created and
   * nothing can fail that would not fail for a bad id, so a caller that
   * merely needs to *name* the path — the provenance ledger looking for a
   * file that may not exist — can ask without consequence.
   */
  forAgent(agentId: string): string;
  /**
   * The same path, created and with its permissions settled, for a caller
   * about to write.
   *
   * The host does this rather than the plugin because the workspace sits
   * inside the agent's state directory, beside its sessions, memories and
   * grants — so the recursive `mkdir` a file-producing plugin would
   * otherwise reach for makes a *state* directory under the process umask.
   * A plugin has no way to know that; the host that chose the layout does.
   * Callers may still create subdirectories under what they are handed.
   *
   * Separate from {@link forAgent} because it can fail, and what fails
   * with it should be only what needed the directory. A read that wanted
   * a path, a navigation that writes nothing, a tool result that turned
   * out to be text — none of those should stop because a directory they
   * were never going to use could not be made.
   */
  prepare(agentId: string): string;
  /**
   * Every agent workspace the host can currently name, for the guards that
   * have to recognise *any* agent's file rather than the caller's — the
   * filesystem provenance ledger is the one that does.
   *
   * Paths, not a promise that each exists: a caller canonicalizes and
   * tolerates what is missing. Re-read rather than cached, so an agent
   * added under a running daemon is visible to the next call.
   */
  all(): Promise<readonly string[]>;
}

/**
 * Where one plugin keeps durable state of its own, answered by the host.
 *
 * A seam for the reason {@link AgentWorkspaces} is one: the layout is the
 * host's to own. A plugin that needs to remember something across restarts
 * — a channel's read position in a store it does not own, a cursor into a
 * vendor's event log — would otherwise join a path onto `~/.stratus` itself,
 * and every plugin doing so is one more copy of the layout to find when it
 * moves. Per plugin, never per agent: what a plugin remembers is its own,
 * and it makes whatever structure it needs beneath this.
 */
export interface PluginStateDirectory {
  /**
   * The directory, created and with its permissions settled, for a caller
   * about to write. Private to the daemon's user, because what a plugin
   * keeps is the daemon's business, and a plugin cannot be expected to know
   * the mode the rest of the state is held to.
   *
   * Asked per write rather than captured at setup: a daemon runs for weeks,
   * and the directory can be removed or replaced with a link under it.
   */
  prepare(): string;
}

/**
 * Files and directories on this machine that no plugin may hand an agent,
 * answered by the host.
 *
 * A seam for the reason {@link AgentWorkspaces} is one: which files hold
 * the daemon's own secrets is the host's layout, not a plugin's. Before it,
 * nothing kept them out of a tool whose roots happened to cover them: an
 * operator who gave an agent `roots: ["~"]` gave it `fs.read` of
 * `~/.stratus/credentials.json`, which `fs.read` answers ungated. Roots are
 * the operator's choice of where an agent may work; this is the short list
 * of places no choice of roots opens.
 *
 * Paths, not a promise that each exists: a caller canonicalizes and
 * tolerates what is missing. Re-read rather than cached, so a file the host
 * starts keeping under a running daemon is protected from the next call.
 */
export interface ProtectedPaths {
  /** What is protected. A directory protects everything beneath it. */
  all(): Promise<readonly string[]>;
  /**
   * Directories beneath a protected one that stay reachable. The daemon
   * protects its whole home and exempts the agents' workspaces, which live
   * inside it and are where agents are meant to work. Whether a given agent
   * reaches a given workspace is still its roots' decision.
   */
  exempt(): Promise<readonly string[]>;
}

export interface MemoryRegistrationHandle {
  register(contribution: MemoryStoreContribution): void;
}

export interface ExecutorRegistrationHandle {
  register(contribution: ExecutorContribution): void;
}

/**
 * One task for a sub-agent (roadmap 24): an ephemeral helper that runs as
 * the calling agent, on its provider and credentials, with only the tools
 * it is handed and nothing else of the agent's: no persona, no memory, no
 * channel, and no human to ask.
 */
export interface SubAgentRunInput {
  /**
   * The session of the turn asking: the very object a tool's `execute`
   * was handed, while that call is running. The host checks it by
   * identity, so an id, a copy, or a session from a call that has ended
   * is refused, and a plugin cannot start sub-agents of a turn that did
   * not call it. The agent, its allowlist and depth come from the host's
   * own records, never from this object.
   */
  parent: Pick<Session, 'id'>;
  /** The task, as the sub-agent's only user message. */
  instruction: string;
  /**
   * Tool names the sub-agent may call, each one the parent may call itself.
   * Exact names, not globs. `agent.spawn`, `agent.delegate`, and `memory.*`
   * are refused even when the parent holds them.
   */
  tools: string[];
  /** Not supported yet: refused rather than ignored. The parent's model runs. */
  model?: string;
  /**
   * An extra stop. The host already ties the sub-agent to the parent
   * turn's own cancel, so this is only for a plugin that wants to end it
   * sooner.
   */
  signal?: AbortSignal;
}

/**
 * How a sub-agent ended. `result` and `empty` both ran to completion; the
 * difference is whether it said anything. `error` is a run that failed —
 * a refusal at the start is thrown instead, before anything runs. `trust`
 * is the sub-agent session's label: what it returns may repeat what it
 * read, and a caller handing it to its own turn marks that call with it.
 */
export type SubAgentOutcome =
  | { status: 'result'; text: string; sessionId: string; trust: TrustLevel }
  | { status: 'empty'; sessionId: string; trust: TrustLevel }
  | { status: 'error'; error: string; sessionId: string; trust: TrustLevel };

/** The host's way to start sub-agents. See `PluginContext.subAgents`. */
export interface SubAgentHandle {
  /**
   * Run one sub-agent to the end. Rejects, naming the reason, when the
   * request is refused: a parent that is not running a turn or is itself
   * a sub-agent, the delegation depth limit, a tool outside the parent's
   * allowlist or never given to a sub-agent, a model. Rejects with the
   * abort error when `signal` fires.
   */
  run(input: SubAgentRunInput): Promise<SubAgentOutcome>;
}

/** One agent the daemon is serving, as `FleetReader.agents` reports it. */
export interface FleetAgent {
  id: string;
  name: string;
  /** The newest session activity for this agent. Absent when it has none. */
  lastActiveAt?: string;
  /** Sessions `running` or `pending_approval` right now. */
  activeSessions: number;
}

/** One session's lifecycle, never its content. */
export interface FleetSession {
  id: string;
  agentId: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
}

/** One schedule, without its prompt. */
export interface FleetSchedule {
  id: string;
  agentId: string;
  /** As `stratus schedules` prints it: `every 2h`, `cron 5 19 * * *`, `once at <iso>`. */
  cadence: string;
  /** `channel:to` when the schedule reports somewhere. */
  destination?: string;
  createdAt: string;
  nextFireAt?: string;
  lastFiredAt?: string;
  /** The status of the most recent firing's session, while it is still stored. */
  lastSessionStatus?: SessionStatus;
}

/** One call parked on a human, without its input. */
export interface FleetPendingApproval {
  requestId: string;
  agentId: string;
  sessionId: string;
  toolName: string;
  risk: ToolRisk;
  parkedAt: string;
  expiresAt?: string;
}

/**
 * Read-only fleet metadata for a plugin (roadmap 26), from the same reads
 * the control API's `/agents`, `/sessions`, `/health`, `/schedules` and
 * `/approvals` use, so a report and the console agree. Content never
 * crosses it: no messages, no schedule prompts, no approval inputs. There
 * is no write verb. The host logs every read with the plugin's name.
 */
export interface FleetReader {
  agents(): Promise<FleetAgent[]>;
  /** Newest first. `limit` bounds the rows; omitted, every stored session. */
  sessions(options?: { agentId?: string; limit?: number }): Promise<FleetSession[]>;
  /** Stored sessions by status, counted in the index. */
  countByStatus(): Promise<Record<string, number>>;
  /** Every schedule, oldest first. */
  schedules(): Promise<FleetSchedule[]>;
  /** Every parked call, oldest first. */
  pendingApprovals(): Promise<FleetPendingApproval[]>;
}

export interface PluginContext {
  bus: EventBus;
  tools: ToolRegistry;
  /**
   * How a plugin resolves a credential for the agent whose call it is
   * serving, so it never needs `process.env`. It declares what it needs by
   * name in its manifest and receives exactly that, per call — which is
   * what a search backend needs to reach the *calling* agent's key rather
   * than one captured at setup.
   *
   * A host that omits it leaves every plugin that wants a credential with
   * no way to get one: such a plugin must fail the call naming what is
   * missing, never fall back to ambient environment. Read
   * `docs/architecture/plugins.md` on what this does and does not buy — a
   * plugin is code, so scoping it is an interface rather than a boundary.
   */
  credentials?: CredentialResolver;
  /**
   * The registration handles for the four contribution kinds that are not
   * tools: each a manifest-bound view, never the raw registry, following
   * the shape `tools` established. Optional because a bare
   * `PluginRegistry.loadAll({ bus, tools })` host supplies none; the
   * `@stratusagent/plugins` loader supplies all four. A plugin that needs
   * one and finds it absent must fail its `setup` naming the kind, so the
   * operator learns the host cannot carry it — never register nothing and
   * report itself loaded.
   */
  providers?: ProviderRegistrationHandle;
  channels?: ChannelRegistrationHandle;
  memory?: MemoryRegistrationHandle;
  executors?: ExecutorRegistrationHandle;
  /**
   * Where this plugin may write files, per agent. See {@link AgentWorkspaces}.
   *
   * A host that omits it leaves every plugin that produces a file with
   * nowhere the host has chosen to put it. Such a plugin falls back to the
   * `workspaceRoot` config key — the documented root it joins the agent id
   * onto — and, given neither, must fail the call naming what is missing,
   * the way `browser.screenshot` does. Never a directory of its own
   * choosing: a file an agent was told it produced has to be somewhere the
   * operator can find, and a turn that cannot store its output must not
   * read as though it did.
   */
  workspaces?: AgentWorkspaces;
  /**
   * Where this plugin may keep durable state. See {@link PluginStateDirectory}.
   *
   * A host that omits it gives the plugin nowhere to remember anything
   * across a restart. Such a plugin must say what it gives up — a channel
   * that cannot store its read position cannot promise a message is handled
   * once — and must never choose a directory of its own instead.
   */
  stateDirectory?: PluginStateDirectory;
  /**
   * What no plugin may hand an agent, whatever the agent's own roots say.
   * See {@link ProtectedPaths}.
   *
   * A host that omits it protects nothing beyond what each plugin's own
   * configuration excludes: a file-reading plugin with roots above the
   * host's state reads the host's secrets there. The daemon and `stratus
   * run` both supply it.
   */
  protectedPaths?: ProtectedPaths;
  /**
   * The host's log, for what a plugin has to say after `setup` returns —
   * a server that dropped, a reconnect that failed. The daemon's is the
   * structured log `stratus logs` reads. A host that omits these leaves
   * the plugin to its own stderr, which under a service manager is a line
   * nobody sees: plugin-mcp's disconnect warnings went there for as long
   * as this seam did not exist.
   */
  log?: (message: string) => void;
  warn?: (message: string) => void;
  /**
   * Starts sub-agents for a running turn (roadmap 24). The host enforces
   * every limit (the slice, the exclusions, depth, concurrency, no human
   * asked), so a plugin owns only the fan-out and how results come back.
   * A host that omits it cannot run sub-agents; a plugin that needs it
   * must fail its `setup` naming it.
   */
  subAgents?: SubAgentHandle;
  /**
   * Runs memory passes (spec 962): short model runs, as the agent, that may
   * only recall and remember. The host owns the transcript, the provider and
   * the store, and enforces every rule; a plugin decides only when to ask. A
   * host that omits it (`stratus run`) cannot run passes; a plugin that
   * needs it must fail its `setup` naming it.
   */
  memoryPasses?: MemoryPassHandle;
  /**
   * Reads fleet metadata (roadmap 26). See {@link FleetReader}. A host that
   * omits it has no fleet to describe; a plugin that needs it must fail its
   * `setup` naming it.
   */
  fleet?: FleetReader;
  /**
   * Registers a guard the host asks before every provider call. See
   * {@link ProviderCallGuard}. A host passing it enforces what is
   * registered for every agent it runs, sub-agents included. A host that
   * omits it cannot enforce one, and a plugin that needs it (a budget) must
   * fail its `setup` naming it: a limit nothing enforces must not report
   * itself loaded.
   */
  providerCalls?: ProviderCallGuardHandle;
  /**
   * Feeds this plugin's events to the host's event triggers. See
   * {@link EventIngestHandle}. A host that omits it takes no events from
   * plugins (`stratus run` is one), and a plugin whose whole job is feeding
   * them must fail its `setup` naming it, rather than load and poll for
   * events nothing will ever act on.
   */
  events?: EventIngestHandle;
}

export interface ProviderCallGuardHandle {
  register(guard: ProviderCallGuard): void;
}

/**
 * What the host did with one event a plugin fed it. `matched`: stored, with
 * a firing waiting for each event trigger it matched. `unmatched`: stored,
 * and no trigger wanted it. `duplicate`: the source took the same id within
 * the dedup window, so nothing new was stored and nothing fires.
 */
export interface EventIngestResult {
  status: 'matched' | 'unmatched' | 'duplicate';
}

/**
 * How a plugin that is not a webhook (a poller, an MCP subscriptions bridge)
 * wakes agents' event triggers. Its events take the same path a signed
 * delivery to the events port takes: the size limit, the per-source rate,
 * dedup on the source and the event's id, the rule filter, then a firing
 * per matched trigger. What a plugin skips is the signature, because the
 * plugin is code the operator installed. Its event text is still labeled
 * `external` in the turn, the way a webhook's is: who fed an event says
 * nothing about who wrote the comment inside it.
 *
 * Bound to the source ids the plugin's manifest declares
 * (`contributes.eventSources`), the way its tools are bound to the names it
 * declares. A source a plugin feeds is never a path on the events port.
 */
export interface EventIngestHandle {
  /**
   * Store one event for a declared source. The event is a structured
   * CloudEvents 1.0 object: `specversion` "1.0" and non-empty string `id`,
   * `source` and `type`, with `subject`, `time`, scalar extension
   * attributes and JSON `data` as wanted. Resolves once it is stored, so a
   * poller can move its cursor past it. Rejects, naming the reason, for a
   * source the manifest does not declare, an event that is not a
   * CloudEvent, one over the size limit, a source over its rate, a plugin
   * that has not finished loading or did not load, and a host that has
   * stopped. A rejected event fires nothing; feeding it again later is
   * safe, because the id is what dedup keys on.
   */
  ingest(sourceId: string, event: JsonObject): Promise<EventIngestResult>;
}

export interface Plugin {
  name: string;
  setup(context: PluginContext): Promise<void> | void;
  /**
   * Release whatever `setup` acquired. Optional, and most plugins have
   * nothing to release — a plugin that registers pure functions is done
   * when the process is.
   *
   * It exists because some do: a browser plugin holds a Chromium and a
   * listening socket, and a daemon that stopped without telling it would
   * leak both. The host calls this on shutdown, after channels have
   * stopped, and a plugin that throws here is logged rather than allowed to
   * hold up the drain.
   */
  dispose?(): Promise<void> | void;
}

export class PluginRegistry {
  private plugins: Plugin[] = [];

  register(plugin: Plugin): void {
    this.plugins.push(plugin);
  }

  async loadAll(context: PluginContext): Promise<void> {
    for (const plugin of this.plugins) {
      await plugin.setup(context);
    }
  }

  /**
   * Dispose every plugin that has something to dispose, in reverse load
   * order. Settled rather than awaited in sequence-with-throw: one
   * plugin's failed cleanup must not strand the next plugin's.
   */
  async disposeAll(): Promise<void> {
    await Promise.allSettled(
      [...this.plugins].reverse().map(async (plugin) => plugin.dispose?.()),
    );
  }
}
