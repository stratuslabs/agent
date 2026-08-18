import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  AgentRegistry,
  AgentRunner,
  EventBus,
  RunAbortedError,
  ToolRegistry,
  type AgentDefinition,
  type ApprovalPolicy,
  type JsonObject,
  type Session,
  type SessionStore,
  type StratusEvent,
} from '@stratusagent/core';
import {
  createDelegateTool,
  createRememberTool,
  type ParsedSoul,
} from '@stratusagent/agents';
import { createLocalCommandExecutor } from '@stratusagent/executor-local';
import {
  createDemoTool,
  createFileMemoryStore,
  createRuntimeProvider,
  DEFAULT_STRATUS_AGENT,
  loadRosterSouls,
  FALLBACK_ACTIVE_METADATA_KEY,
  loadSoulFile,
  memoryFilePath,
  migrateLegacyMemory,
  ConfigFileError,
  loadConfigFile,
  readNonEmptyString,
  resolveConfigLocation,
  resolveConfiguredSoul,
  resolveRuntimeConfig,
  stratusHomePath,
  withLegacyDefaultMemories,
  type FallbackRuntime,
  type RosterEntry,
  type RuntimeConfig,
  type RuntimeSelection,
  type StateEnvironment,
} from '@stratusagent/state';

const SESSIONS_DB_FILENAME = 'sessions.db';
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

/**
 * Durable session storage on node:sqlite (unflagged on Node 22.13+). The
 * whole session — messages, status, and metadata, including provider replay
 * state like the Anthropic raw-turn cache — round-trips as one JSON body,
 * so a conversation resumed after a daemon restart replays exactly.
 */
export interface SqliteSessionStoreOptions {
  /**
   * The database's parent directory is dedicated Stratus state (e.g. the
   * default ~/.stratus): tighten it to owner-only even when it already
   * exists, since mkdir's mode only applies to directories it creates and
   * an upgrade over a looser install must not stay world-readable. Leave
   * false for caller-supplied paths — a shared parent like /tmp or a
   * project directory must never be chmodded implicitly.
   */
  ownedDirectory?: boolean;
}

export class SqliteSessionStore implements SessionStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string, options: SqliteSessionStoreOptions = {}) {
    // Sessions hold complete conversations (prompts, replies, tool output,
    // provider replay state) — owner-only, like the credentials file. The
    // file chmods below cover databases created earlier under a looser
    // umask too; directories the store creates are born 0700.
    const dir = path.dirname(filePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (options.ownedDirectory) {
      chmodSync(dir, 0o700);
    }
    this.db = new DatabaseSync(filePath);
    // The database file is tightened FIRST: SQLite derives sidecar
    // permissions from the main file's mode, so everything created later
    // inherits owner-only.
    try {
      chmodSync(filePath, 0o600);
    } catch (error) {
      // A database that cannot be tightened must not be used: conversation
      // bodies would stay readable by other local users for the daemon's
      // whole lifetime, silently.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    // WAL, not the default DELETE journal: DELETE mode recreates a
    // rollback journal on EVERY write, which a one-time chmod could never
    // cover in a traversable caller-supplied directory. WAL keeps one
    // persistent sidecar pair per connection — forced into existence here
    // (the user_version pragma is a real page-one write) so the loop
    // below covers them for the connection's whole lifetime.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.db.exec('PRAGMA user_version = 0');
    for (const sensitive of [filePath, `${filePath}-wal`, `${filePath}-shm`, `${filePath}-journal`]) {
      try {
        chmodSync(sensitive, 0o600);
      } catch (error) {
        // A sidecar that does not exist has nothing to tighten; anything
        // else means session data stays readable — refuse to run over it.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
  }

  async create(input: Omit<Session, 'createdAt' | 'updatedAt'>): Promise<Session> {
    const now = new Date().toISOString();
    const session: Session = { ...input, createdAt: now, updatedAt: now };
    this.db
      .prepare('INSERT OR REPLACE INTO sessions (id, agent_id, status, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(session.id, session.agent.id, session.status, JSON.stringify(session), session.createdAt, session.updatedAt);
    return session;
  }

  async get(id: string): Promise<Session | undefined> {
    const row = this.db.prepare('SELECT body FROM sessions WHERE id = ?').get(id) as
      | { body: string }
      | undefined;
    return row ? (JSON.parse(row.body) as Session) : undefined;
  }

  async save(session: Session): Promise<void> {
    const updated: Session = { ...session, updatedAt: new Date().toISOString() };
    this.db
      .prepare('INSERT OR REPLACE INTO sessions (id, agent_id, status, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(updated.id, updated.agent.id, updated.status, JSON.stringify(updated), updated.createdAt, updated.updatedAt);
  }

  /** Newest-first session listing for one agent (or all agents). */
  list(agentId?: string): Array<Pick<Session, 'id' | 'status' | 'createdAt' | 'updatedAt'> & { agentId: string }> {
    const rows = (agentId
      ? this.db.prepare('SELECT id, agent_id, status, created_at, updated_at FROM sessions WHERE agent_id = ? ORDER BY updated_at DESC').all(agentId)
      : this.db.prepare('SELECT id, agent_id, status, created_at, updated_at FROM sessions ORDER BY updated_at DESC').all()) as Array<{
      id: string;
      agent_id: string;
      status: Session['status'];
      created_at: string;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      agentId: row.agent_id,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  close(): void {
    this.db.close();
  }
}

/**
 * A channel adapter as the gateway sees it: started after the roster
 * loads, stopped before the store drains. Structurally identical to
 * @stratusagent/channels' ChannelAdapter — kept structural here so the
 * gateway does not depend on the channels package.
 */
/** Where the daemon-wide provider default could have come from. */
export interface SoulPinContext {
  /** A provider fixed by the caller (the gateway's own selection). */
  selectionProvider?: string;
  /** The provider named by the active config file. */
  configProvider?: string;
  /** Whether a config file was found at all. */
  configPresent: boolean;
}

/**
 * Apply a soul's provider/model pins to a selection, demoting the
 * daemon-wide defaults the pins outrank.
 *
 * Exported because this is not only dispatch logic: anything that wants to
 * know what a served agent will actually resolve to — a startup billing
 * check, a diagnostic — has to normalize the same way, and a second copy
 * of these rules drifts from this one.
 */
export const applySoulPins = (
  pins: ParsedSoul,
  selection: RuntimeSelection,
  env: StateEnvironment,
  context: SoulPinContext,
): { selection: RuntimeSelection; env: StateEnvironment } => {
  selection.presetSoul = pins;
  if (!pins.provider && !pins.model) {
    return { selection, env };
  }
  const processEnv = { ...(env.processEnv ?? process.env) };
  // The daemon-wide default can come from the selection, the environment,
  // or the config file. A config with no provider key predates the
  // anthropic option and is openai-specific (the resolver treats it that
  // way), so a real file without the key still names openai as the
  // default. Env values normalize exactly as the resolver normalizes
  // them: an empty or whitespace-padded STRATUS_PROVIDER is no default at
  // all, not a mismatching one.
  const defaultProvider: string | undefined = context.selectionProvider
    ?? readNonEmptyString(processEnv.STRATUS_PROVIDER)
    ?? readNonEmptyString(processEnv.STRATUSCLAW_PROVIDER)
    ?? context.configProvider
    ?? (context.configPresent ? 'openai' : undefined);
  if (pins.provider) {
    delete selection.provider;
    delete processEnv.STRATUS_PROVIDER;
    delete processEnv.STRATUSCLAW_PROVIDER;
    if (defaultProvider !== undefined && defaultProvider !== 'demo' && pins.provider !== defaultProvider) {
      // The default model, endpoint, and generic credentials were all
      // chosen for the default provider — none may ride along to the
      // soul's: a base URL would point the pinned provider at the wrong
      // service, and a generic API key would be sent to it. With NO
      // default selected anywhere — or the credential-less demo provider
      // as the default — there is nothing those values could have been
      // chosen for except whatever provider the soul selects — exactly
      // the resolver's own reading of a generic credential — so they stay.
      delete selection.model;
      delete processEnv.STRATUS_MODEL;
      delete processEnv.STRATUSCLAW_MODEL;
      delete selection.baseUrl;
      delete processEnv.STRATUS_BASE_URL;
      delete processEnv.STRATUSCLAW_BASE_URL;
      delete processEnv.STRATUS_API_KEY;
      delete processEnv.STRATUSCLAW_API_KEY;
      delete processEnv.STRATUS_API_KEY_ENV;
      delete processEnv.STRATUSCLAW_API_KEY_ENV;
    }
  }
  if (pins.model) {
    delete selection.model;
    delete processEnv.STRATUS_MODEL;
    delete processEnv.STRATUSCLAW_MODEL;
  }
  return { selection, env: { ...env, processEnv } };
};

export interface GatewayChannelAdapter {
  name: string;
  start(gateway: Gateway): Promise<void>;
  stop(): Promise<void>;
}

export interface GatewayOptions {
  env?: StateEnvironment;
  /** Gateway-wide provider/model overrides applied beneath per-soul pins. */
  selection?: RuntimeSelection;
  /** Channel adapters to run (Slack, …). Started on start(), stopped on stop(). */
  channels?: GatewayChannelAdapter[];
  approvals?: ApprovalPolicy;
  maxTurns?: number;
  /**
   * The activity watchdog: abort a turn when no event for its session has
   * arrived for this long. Progress-based, not wall-clock — any delta, tool
   * event, or response resets it. 0 disables. Default 120s.
   */
  idleTimeoutMs?: number;
  /** Session database path. Default ~/.stratus/sessions.db. */
  sessionDbPath?: string;
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
  metadata?: JsonObject;
  signal?: AbortSignal;
}

export interface Gateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** The one entrypoint: resolve the agent, load-or-create the session, run a turn. */
  dispatch(input: DispatchInput): Promise<Session>;
  /** Live events from every runner, one stream for all consumers. */
  readonly bus: EventBus;
  /** The store shared by every runner (durable across restarts). */
  readonly store: SqliteSessionStore;
  /** The current roster, default agent included. */
  agents(): AgentDefinition[];
}

interface AgentSource {
  definition: AgentDefinition;
  /** Soul file backing this agent; undefined for the built-in default. */
  soulPath?: string;
  /** The parsed soul, carried for its provider/model pins. */
  soul?: ParsedSoul;
}

/**
 * The always-on Stratus process. One gateway holds the roster, the durable
 * session store, the shared event bus, and a pool of runners keyed by
 * resolved provider configuration — each agent runs on its own provider,
 * model, and credentials, delegation included.
 */
export const createGateway = (options: GatewayOptions = {}): Gateway => {
  const env = options.env ?? {};
  const log = options.log ?? (() => {});
  const warn = options.warn ?? (() => {});
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  const bus = new EventBus({
    onError: (error) => warn(`event handler failed: ${error instanceof Error ? error.message : String(error)}`),
  });
  // The default database lives in the gateway-owned ~/.stratus, which is
  // tightened to owner-only; a caller-supplied path may sit in a shared
  // directory that must not be chmodded from under other processes.
  const store = options.sessionDbPath
    ? new SqliteSessionStore(options.sessionDbPath)
    : new SqliteSessionStore(path.join(stratusHomePath(env), SESSIONS_DB_FILENAME), { ownedDirectory: true });
  const memory = withLegacyDefaultMemories(createFileMemoryStore(memoryFilePath(env)));
  const registry = new AgentRegistry();
  const sources = new Map<string, AgentSource>();

  // ---- roster -------------------------------------------------------------

  const registerSource = (source: AgentSource): void => {
    registry.register(source.definition);
    sources.set(source.definition.id, source);
  };

  /**
   * The agent an agentId-less dispatch routes to: the configured default
   * soul when one is set (what `stratus setup` writes to config.json),
   * the built-in Stratus definition otherwise. Re-resolved per call so an
   * edited default soul reaches conversations without a restart — the
   * runtime config already re-reads it, and the identity (persona, tool
   * allowlist, memory id) must follow along, not stay pinned to the
   * built-in definition.
   */
  let lastDefaultAgentId: string | undefined;
  // The last successfully loaded config snapshot, serving dispatches while
  // the file on disk is temporarily broken (an operator mid-edit).
  let lastGoodConfigSnapshot: NonNullable<RuntimeSelection['presetConfig']> | undefined;
  const defaultAgentId = async (): Promise<string> => {
    // Identity only — never full runtime resolution: credential checks do
    // not belong here, or a daemon default provider without installed keys
    // would throw while the soul pins a provider that has them, taking
    // loadRoster (and the whole gateway) down with it. Provider resolution
    // happens at dispatch, where pin demotion applies.
    let resolved: { soul: ParsedSoul; path: string } | undefined;
    try {
      resolved = await resolveConfiguredSoul({ ...options.selection }, env);
    } catch (error) {
      warn(`could not load the configured default soul: ${error instanceof Error ? error.message : String(error)}`);
      // A transiently unreadable default keeps routing to the last known
      // default agent (whose source serves from cache) rather than
      // silently switching identities to the built-in.
      return lastDefaultAgentId ?? DEFAULT_STRATUS_AGENT.id;
    }
    if (!resolved) {
      // The operator removed the default soul on purpose: the built-in is
      // now the cached answer too, so a later transient read failure
      // cannot resurrect the retired soul's identity.
      lastDefaultAgentId = DEFAULT_STRATUS_AGENT.id;
      return DEFAULT_STRATUS_AGENT.id;
    }
    const id = resolved.soul.agent.id;
    // The normal setup layout has the default soul in ~/.stratus/agents
    // too: keep the roster registration — its soulPath drives per-dispatch
    // refresh. A config-only soul registers with the path it resolved
    // from, so it refreshes (and keeps its pins current) exactly like a
    // roster soul, resumed sessions included. A repointed config (same
    // agent id, different file) replaces the source, or moves and
    // replacements would silently keep refreshing the old file.
    const existing = sources.get(id);
    const pathChanged = Boolean(existing?.soulPath && existing.soulPath !== resolved.path);
    if (!existing?.soulPath || pathChanged) {
      registerSource({
        definition: resolved.soul.agent,
        soul: resolved.soul,
        soulPath: resolved.path,
      });
    }
    lastDefaultAgentId = id;
    return id;
  };

  const loadRoster = async (): Promise<void> => {
    // The built-in id is reserved BEFORE ordinary roster entries load: a
    // roster file that happens to declare id "stratus" must not hijack
    // the documented built-in fallback for agentId-less dispatches — the
    // duplicate guard below skips it with a warning. Only the explicitly
    // configured default soul may take the id over (defaultAgentId
    // replaces a pathless source).
    registerSource({ definition: { ...DEFAULT_STRATUS_AGENT } });
    const entries: RosterEntry[] = await loadRosterSouls(env, warn);
    for (const entry of entries) {
      if (sources.has(entry.soul.agent.id)) {
        const existing = sources.get(entry.soul.agent.id);
        warn(`duplicate agent id ${entry.soul.agent.id} (${existing?.soulPath ?? 'built-in'} vs ${entry.path}); keeping the first`);
        continue;
      }
      registerSource({ definition: entry.soul.agent, soulPath: entry.path, soul: entry.soul });
    }
    // The configured default soul is part of the roster too — it is what
    // an agentId-less dispatch answers as.
    await defaultAgentId();
  };

  /**
   * A session pins its agent id, never a snapshot of the agent: the soul
   * file is re-read on every dispatch, so an edited persona (or tool
   * allowlist) reaches existing conversations on their next turn.
   */
  const refreshAgent = async (agentId: string): Promise<AgentSource> => {
    const source = sources.get(agentId);
    if (!source) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    if (source.soulPath) {
      let soul: ParsedSoul | undefined;
      try {
        soul = await loadSoulFile(source.soulPath);
      } catch (error) {
        warn(`could not refresh ${source.soulPath}: ${error instanceof Error ? error.message : String(error)}; keeping the loaded definition`);
        // Serve from cache WITHOUT the failing path: the dispatch resolves
        // from the cached soul snapshot, and the registered source keeps
        // its path for the next refresh attempt.
        return {
          definition: source.definition,
          ...(source.soul ? { soul: source.soul } : {}),
        };
      }
      if (soul.agent.id !== agentId) {
        // The file now belongs to a different agent. Serving this agent
        // anyway would resolve provider/model pins from that other
        // agent's soul — another identity's billing path — so the
        // dispatch is refused rather than run on ambiguous config.
        throw new Error(
          `Soul ${source.soulPath} now declares agent ${soul.agent.id}, not ${agentId} — refusing the dispatch so ${agentId}'s sessions cannot run on another agent's provider pins. Restore the soul's identity, or address the agent by its new id.`,
        );
      }
      const refreshed: AgentSource = { definition: soul.agent, soulPath: source.soulPath, soul };
      registerSource(refreshed);
      return refreshed;
    }
    return source;
  };

  // ---- runner pool --------------------------------------------------------

  const tools = new ToolRegistry();
  tools.register(createDemoTool());
  tools.register(createRememberTool(memory));
  // Delegation is dispatcher-backed, not runner-capturing: the target agent
  // runs through the same per-provider routing as a direct dispatch, so a
  // delegated specialist uses their own provider and credentials.
  tools.register(createDelegateTool({
    registry,
    dispatch: (input) => dispatchInternal({
      sessionId: input.sessionId,
      agentId: input.agent.id,
      userMessage: input.userMessage,
      metadata: input.metadata,
      // A cancelled parent turn cancels its delegated runs too.
      ...(input.signal ? { signal: input.signal } : {}),
    }),
  }));

  const runners = new Map<string, AgentRunner>();

  // Every provider-construction input participates in the key — model,
  // endpoint, credentials, system prompt, fallback config. A rotated
  // credential therefore resolves to a NEW runner on the next dispatch
  // instead of silently reusing a provider built with the old secret.
  // (Hashed so raw secrets never sit in a map key; the soul is excluded
  // because provider construction ignores it.)
  const runnerKeyFor = (config: RuntimeConfig): string => {
    const { soul: _soul, soulPath: _soulPath, fetch: _fetch, ...providerInputs } = config as RuntimeConfig & {
      soul?: unknown;
      soulPath?: unknown;
      fetch?: unknown;
    };
    return createHash('sha256').update(JSON.stringify(providerInputs)).digest('hex');
  };

  const runnerFor = (config: RuntimeConfig): AgentRunner => {
    const key = runnerKeyFor(config);
    const existing = runners.get(key);
    if (existing) {
      return existing;
    }

    // The Claude Code runtime executes kernel tools by calling back into
    // the runner built just below — late-bound because the runner needs
    // the provider first.
    let hostedRunner: AgentRunner | undefined;
    const provider = createRuntimeProvider(
      config,
      (error) => warn(`default model failed (${error instanceof Error ? error.message : String(error)}); using the fallback model`),
      async (session, call, context) => {
        if (!hostedRunner) {
          throw new Error('The Stratus runtime is not ready to execute tools yet.');
        }
        return hostedRunner.executeHostedToolCall(session, call, context);
      },
      options.maxTurns,
      // The sticky-fallback switch is durable the moment it happens, not
      // when the turn's next save lands — a daemon killed mid-fallback
      // must not retry the primary on restart.
      (session) => store.save(session),
    );

    const runner = new AgentRunner({
      provider,
      tools,
      executor: createLocalCommandExecutor(),
      ...(options.approvals ? { approvals: options.approvals } : {}),
      store,
      bus,
      agents: registry,
      memory,
      streaming: true,
      ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
    });
    hostedRunner = runner;
    runners.set(key, runner);
    return runner;
  };

  // ---- watchdog -----------------------------------------------------------

  /**
   * True when this configuration's provider actually emits deltas: the
   * Anthropic API path streams; the Claude Code runtime, OpenAI-compatible
   * adapters, and the demo provider resolve in one piece. An activity
   * watchdog is only honest where activity signals exist — for
   * non-streaming providers the idle timer would be a wall-clock timeout
   * that kills slow-but-healthy turns, so it stays off for them (their
   * tool phases are covered by executor timeouts regardless).
   */
  const fallbackStreamsDeltas = (fallback: FallbackRuntime): boolean =>
    fallback.provider === 'anthropic' && Boolean(fallback.apiKey);

  const streamsDeltas = (config: RuntimeConfig): boolean =>
    config.provider === 'anthropic' && Boolean(config.apiKey);

  /**
   * Progress-based abort, armed only while the turn is actually awaiting a
   * streaming provider — the one phase where silence means a stall. Tool
   * executions and approval waits emit no deltas (executor timeouts cover
   * them), so the timer suspends at each provider.response and re-arms once
   * every tool call from that response has settled and the loop heads back
   * to the provider. A reset delta marks the mid-turn, session-sticky
   * switch to the fallback provider, and the timer follows the active
   * provider through it: switching to a non-streaming fallback suspends it
   * for the rest of the turn (silence is healthy there), while a streaming
   * fallback taking over from a non-streaming primary arms it for the
   * first time.
   */
  const withWatchdog = async <T>(
    sessionId: string,
    external: AbortSignal | undefined,
    idleEnabled: boolean,
    fallbackStreams: boolean,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const effectiveIdleMs = idleEnabled || fallbackStreams ? idleTimeoutMs : 0;
    if (effectiveIdleMs <= 0 && !external) {
      return run(new AbortController().signal);
    }

    const controller = new AbortController();
    let timedOut = false;
    const onExternalAbort = (): void => controller.abort();
    if (external?.aborted) {
      controller.abort();
    } else {
      external?.addEventListener('abort', onExternalAbort, { once: true });
    }

    let timer: NodeJS.Timeout | undefined;
    // Whether the provider currently serving this turn streams deltas —
    // the primary until a reset delta announces the sticky fallback switch.
    let streamingActive = idleEnabled;
    let pendingTools = 0;
    // Set at a text-only provider.response: the turn is wrapping up
    // (saves, completion events); nothing left for the timer to guard.
    let turnSettling = false;

    const suspendTimer = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    const armTimer = (): void => {
      if (effectiveIdleMs <= 0) {
        return;
      }
      suspendTimer();
      // Deliberately not unref'd: while a provider await is in flight, this
      // timer is what guarantees the process can always make progress on it.
      timer = setTimeout(() => {
        timedOut = true;
        warn(`watchdog: no activity on session ${sessionId} for ${effectiveIdleMs}ms; aborting the turn`);
        controller.abort();
      }, effectiveIdleMs);
    };

    // Two subscriptions bracket every event's fan-out. The PREPENDED
    // observer runs before any external consumer: it updates phase state
    // and stops the clock — while the remaining (possibly slow, throttled)
    // subscribers process this event, the provider is not being awaited,
    // so elapsed time is consumer time, not provider silence. The APPENDED
    // marker runs last: control is about to return to the runner and its
    // provider await, so the timer arms only when a streaming provider is
    // actually the thing being waited on (never during tool phases,
    // post-switch silent fallbacks, or turn wrap-up).
    const unsubscribeObserver = bus.subscribe((event: StratusEvent) => {
      if (!('sessionId' in event) || event.sessionId !== sessionId) {
        return;
      }
      switch (event.type) {
        case 'provider.delta':
          // A reset marks the mid-turn, session-sticky fallback switch:
          // the timer follows whether the now-active provider streams.
          if (event.delta.type === 'reset') {
            streamingActive = fallbackStreams;
          }
          break;
        case 'provider.response':
          // The provider finished; the loop enters its tool phase
          // (approval waits included) — or, with no tool calls, the turn
          // is over. The response says exactly how many tool calls must
          // settle before the loop returns to the provider.
          pendingTools = event.parts.filter((part) => part.type !== 'text').length;
          if (pendingTools === 0) {
            turnSettling = true;
          }
          break;
        case 'tool.completed':
        case 'tool.denied':
          pendingTools = Math.max(0, pendingTools - 1);
          break;
        default:
          break;
      }
      suspendTimer();
    }, { prepend: true });

    const unsubscribeDrain = bus.subscribe((event: StratusEvent) => {
      if (!('sessionId' in event) || event.sessionId !== sessionId) {
        return;
      }
      if (streamingActive && pendingTools === 0 && !turnSettling) {
        armTimer();
      }
    });

    if (streamingActive) {
      armTimer();
    }

    try {
      return await run(controller.signal);
    } catch (error) {
      if (timedOut && error instanceof RunAbortedError) {
        throw new RunAbortedError(`Run aborted: no activity for ${effectiveIdleMs}ms`);
      }
      throw error;
    } finally {
      suspendTimer();
      unsubscribeObserver();
      unsubscribeDrain();
      external?.removeEventListener('abort', onExternalAbort);
    }
  };

  // ---- dispatch -----------------------------------------------------------

  // Single-flight per session: a second message to a busy session queues
  // behind the in-flight turn instead of interleaving with it. Sessions
  // are independent — different conversations run concurrently.
  const sessionChains = new Map<string, Promise<unknown>>();
  const inflight = new Set<Promise<unknown>>();
  let stopping = false;

  const dispatchInternal = async (input: DispatchInput): Promise<Session> => {
    // A dispatch whose signal fired while it queued behind another turn
    // must not touch durable state: without this check, the runner would
    // load the session, append the cancelled user message, and save it as
    // failed — polluting future model history with input never processed.
    if (input.signal?.aborted) {
      throw new RunAbortedError();
    }

    // A session pins its agent: when the caller names none, an existing
    // conversation keeps the agent it was created with even if the
    // configured default soul has changed since — only a brand-new session
    // takes the current default. (Loaded here, before the watchdog, also
    // because whether this turn streams depends on durable session state.)
    const existing = await store.get(input.sessionId);
    const agentId = input.agentId ?? existing?.agent.id ?? await defaultAgentId();
    const source = await refreshAgent(agentId);
    const agent = source.definition;

    // Config re-resolves per dispatch, so a changed model, credential, or
    // soul pin applies without a restart. The pool dedupes runners by the
    // resolved configuration. The gateway-wide selection and the daemon's
    // environment are defaults, not overrides: resolveRuntimeConfig gives
    // both higher precedence than the soul (they are explicit flags and
    // env vars on the CLI), so any default the soul pins over is dropped
    // here — an agent pinned to a provider keeps it whatever the gateway
    // was started with, and a default model never rides along to a
    // different provider than it was chosen for.
    const selection: RuntimeSelection = { ...options.selection };
    let resolveEnv = env;

    // One config read per dispatch, through a last-known-good cache: a
    // config.json an operator saved mid-edit must neither fail dispatches
    // (a daemon keeps serving) nor silently change what it configured —
    // discarding a broken config wholesale would flip a config-provided
    // provider back to the demo default, durably recording canned replies
    // in a real conversation. With no known-good snapshot to fall back
    // on, failing is the honest outcome. Credential and provider errors
    // are never masked — only the file itself degrades.
    let configSnapshot: NonNullable<RuntimeSelection['presetConfig']>;
    try {
      const location = await resolveConfigLocation(
        options.selection?.configPath ? { configPath: options.selection.configPath } : {},
        env,
      );
      configSnapshot = location
        ? { config: await loadConfigFile(location.path), trusted: location.trusted, path: location.path }
        : { config: {}, trusted: true };
      lastGoodConfigSnapshot = configSnapshot;
    } catch (error) {
      if (!(error instanceof ConfigFileError) || !lastGoodConfigSnapshot) {
        throw error;
      }
      warn(`${error.message}; using the last known-good config`);
      configSnapshot = lastGoodConfigSnapshot;
    }
    selection.presetConfig = configSnapshot;

    const pins = source.soul;
    if (pins) {
      // One soul read per dispatch: resolution uses the exact snapshot
      // refreshAgent just loaded and identity-checked. Handing the path
      // to resolveRuntimeConfig instead would read the file a second
      // time, racing a concurrent replacement — this turn could keep one
      // agent's definition while adopting another's provider pins.
      const normalized = applySoulPins(pins, selection, env, {
        ...(options.selection?.provider !== undefined ? { selectionProvider: options.selection.provider } : {}),
        ...(configSnapshot.config.provider !== undefined ? { configProvider: configSnapshot.config.provider } : {}),
        configPresent: configSnapshot.path !== undefined,
      });
      resolveEnv = normalized.env;
    } else {
      // A soul-less agent (the built-in default) resolves with no soul at
      // all: the config file's default soul belongs to another identity —
      // and when the default route degrades to the built-in, it is exactly
      // because that file is currently unusable.
      selection.presetSoul = null;
    }

    // The preset snapshot means resolution reads no config file — every
    // failure from here is a credential or provider problem and surfaces.
    const config = await resolveRuntimeConfig(selection, resolveEnv);
    const runner = runnerFor(config);

    const metadata: JsonObject = {
      ...(config.provider === 'demo'
        ? { provider: 'demo' }
        : { provider: config.provider, model: config.model }),
      ...input.metadata,
    };

    if (existing && existing.agent.id !== agent.id) {
      throw new Error(
        `Session ${input.sessionId} belongs to agent ${existing.agent.id}, not ${agent.id} — sessions never cross agent identities.`,
      );
    }

    const switchedToFallback = existing?.metadata?.[FALLBACK_ACTIVE_METADATA_KEY] === true;
    const fallbackStreams = config.provider !== 'demo' && config.fallback
      ? fallbackStreamsDeltas(config.fallback)
      : false;
    const effectiveStreams = switchedToFallback && config.provider !== 'demo' && config.fallback
      ? fallbackStreamsDeltas(config.fallback)
      : streamsDeltas(config);

    return withWatchdog(input.sessionId, input.signal, effectiveStreams, fallbackStreams, async (signal) => {
      // The preflight above (agent refresh, config resolution, session
      // load) awaited filesystem work; the entry check has long passed.
      // Recheck before the runner touches durable state, or a dispatch
      // cancelled mid-preflight would still persist its user message.
      if (signal.aborted) {
        throw new RunAbortedError();
      }

      if (existing) {
        // Refresh the stored definition before resuming, so the turn runs
        // with the current instructions, tools, and credentials.
        existing.agent = agent;
        await store.save(existing);
        return runner.resume({ sessionId: input.sessionId, userMessage: input.userMessage, signal });
      }

      return runner.run({
        sessionId: input.sessionId,
        agent,
        userMessage: input.userMessage,
        metadata,
        signal,
      });
    });
  };

  const dispatch = async (input: DispatchInput): Promise<Session> => {
    if (stopping) {
      throw new Error('The gateway is stopping and no longer accepts new work.');
    }

    const previous = sessionChains.get(input.sessionId) ?? Promise.resolve();
    const turn = previous.then(
      () => dispatchInternal(input),
      () => dispatchInternal(input),
    );

    const settled = turn.catch(() => {});
    sessionChains.set(input.sessionId, settled);
    inflight.add(settled);
    void settled.finally(() => {
      inflight.delete(settled);
      if (sessionChains.get(input.sessionId) === settled) {
        sessionChains.delete(input.sessionId);
      }
    });

    return turn;
  };

  const startedChannels: GatewayChannelAdapter[] = [];

  const gateway: Gateway = {
    bus,
    store,

    async start() {
      await migrateLegacyMemory(env);
      await loadRoster();
      const named = registry.list().map((agent) => agent.name).join(', ');
      log(`stratusd ready — ${registry.list().length} agent(s): ${named}`);
      // Channels come up after the roster so their first inbound message
      // already has agents to dispatch to. One failing adapter must not
      // keep the rest (or the gateway) down.
      for (const adapter of options.channels ?? []) {
        try {
          await adapter.start(gateway);
          startedChannels.push(adapter);
        } catch (error) {
          warn(`channel ${adapter.name} failed to start: ${error instanceof Error ? error.message : String(error)}`);
          // A start() that rejected may still hold sockets or listeners it
          // acquired before failing; it never reaches startedChannels, so
          // this is its only cleanup.
          try {
            await adapter.stop();
          } catch (stopError) {
            warn(`channel ${adapter.name} cleanup after failed start also failed: ${stopError instanceof Error ? stopError.message : String(stopError)}`);
          }
        }
      }
    },

    // Drain: channels stop taking messages, in-flight turns finish, new
    // dispatches are refused, then the database closes. SIGTERM handling
    // in `stratus serve` calls this.
    async stop() {
      // Refuse new work first; then let channels finish rendering their
      // in-flight turns (already-started dispatches keep running), drain,
      // and close.
      stopping = true;
      await Promise.allSettled(startedChannels.map((adapter) => adapter.stop()));
      startedChannels.length = 0;
      await Promise.allSettled([...inflight]);
      store.close();
      log('stratusd stopped');
    },

    dispatch,

    agents() {
      return registry.list();
    },
  };

  return gateway;
};
