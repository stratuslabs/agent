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
    for (const sensitive of [filePath, `${filePath}-wal`, `${filePath}-shm`, `${filePath}-journal`]) {
      try {
        chmodSync(sensitive, 0o600);
      } catch {
        // Journal side-files only exist while active; nothing to tighten.
      }
    }
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

export interface GatewayOptions {
  env?: StateEnvironment;
  /** Gateway-wide provider/model overrides applied beneath per-soul pins. */
  selection?: RuntimeSelection;
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

  const loadRoster = async (): Promise<void> => {
    const entries: RosterEntry[] = await loadRosterSouls(env, warn);
    for (const entry of entries) {
      if (sources.has(entry.soul.agent.id)) {
        const existing = sources.get(entry.soul.agent.id);
        warn(`duplicate agent id ${entry.soul.agent.id} (${existing?.soulPath ?? 'built-in'} vs ${entry.path}); keeping the first`);
        continue;
      }
      registerSource({ definition: entry.soul.agent, soulPath: entry.path, soul: entry.soul });
    }
    if (!sources.has(DEFAULT_STRATUS_AGENT.id)) {
      registerSource({ definition: { ...DEFAULT_STRATUS_AGENT } });
    }
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
      try {
        const soul = await loadSoulFile(source.soulPath);
        if (soul.agent.id === agentId) {
          const refreshed: AgentSource = { definition: soul.agent, soulPath: source.soulPath, soul };
          registerSource(refreshed);
          return refreshed;
        }
        warn(`soul ${source.soulPath} now declares id ${soul.agent.id}; keeping the loaded definition for ${agentId}`);
      } catch (error) {
        warn(`could not refresh ${source.soulPath}: ${error instanceof Error ? error.message : String(error)}; keeping the loaded definition`);
      }
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
    const { soul: _soul, fetch: _fetch, ...providerInputs } = config as RuntimeConfig & {
      soul?: unknown;
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
    let armed = idleEnabled;
    let pendingTools = 0;

    const suspendTimer = (): void => {
      armed = false;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    const resetTimer = (): void => {
      if (!armed || effectiveIdleMs <= 0) {
        return;
      }
      if (timer) {
        clearTimeout(timer);
      }
      // Deliberately not unref'd: while a provider await is in flight, this
      // timer is what guarantees the process can always make progress on it.
      timer = setTimeout(() => {
        timedOut = true;
        warn(`watchdog: no activity on session ${sessionId} for ${effectiveIdleMs}ms; aborting the turn`);
        controller.abort();
      }, effectiveIdleMs);
    };

    const unsubscribe = bus.subscribe((event: StratusEvent) => {
      if (!('sessionId' in event) || event.sessionId !== sessionId) {
        return;
      }
      switch (event.type) {
        case 'provider.delta':
          // A reset marks the mid-turn, session-sticky fallback switch: the
          // timer follows whether the now-active provider streams. A silent
          // fallback makes silence healthy for the rest of the turn; a
          // streaming one takes over the primary's watchdog protection.
          if (event.delta.type === 'reset') {
            streamingActive = fallbackStreams;
            if (fallbackStreams) {
              armed = true;
              resetTimer();
            } else {
              suspendTimer();
            }
          } else {
            resetTimer();
          }
          break;
        case 'provider.response':
          // The provider finished; the loop enters its tool phase
          // (approval waits included). The response says exactly how many
          // tool calls must settle before the loop returns to the provider.
          pendingTools = event.parts.filter((part) => part.type !== 'text').length;
          suspendTimer();
          break;
        case 'tool.completed':
        case 'tool.denied':
          pendingTools = Math.max(0, pendingTools - 1);
          if (pendingTools === 0 && streamingActive) {
            armed = true;
            resetTimer();
          }
          break;
        default:
          resetTimer();
          break;
      }
    });
    resetTimer();

    try {
      return await run(controller.signal);
    } catch (error) {
      if (timedOut && error instanceof RunAbortedError) {
        throw new RunAbortedError(`Run aborted: no activity for ${effectiveIdleMs}ms`);
      }
      throw error;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      unsubscribe();
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

    const agentId = input.agentId ?? DEFAULT_STRATUS_AGENT.id;
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
    if (source.soulPath) {
      selection.soul = source.soulPath;
      const pins = source.soul;
      if (pins?.provider || pins?.model) {
        const processEnv = { ...(env.processEnv ?? process.env) };
        const defaultProvider = options.selection?.provider
          ?? processEnv.STRATUS_PROVIDER
          ?? processEnv.STRATUSCLAW_PROVIDER;
        if (pins.provider) {
          delete selection.provider;
          delete processEnv.STRATUS_PROVIDER;
          delete processEnv.STRATUSCLAW_PROVIDER;
          if (pins.provider !== defaultProvider) {
            // The default model, endpoint, and generic credentials were all
            // chosen for the default provider — none may ride along to the
            // soul's: a base URL would point the pinned provider at the
            // wrong service, and a generic API key would be sent to it.
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
        resolveEnv = { ...env, processEnv };
      }
    }
    const config = await resolveRuntimeConfig(selection, resolveEnv);
    const runner = runnerFor(config);

    const metadata: JsonObject = {
      ...(config.provider === 'demo'
        ? { provider: 'demo' }
        : { provider: config.provider, model: config.model }),
      ...input.metadata,
    };

    // Load before starting the watchdog: whether this turn actually streams
    // depends on the session's durable state, not just the primary config —
    // a session sticky-switched to a non-streaming fallback emits no deltas,
    // and an idle timer there would be a wall-clock kill of healthy work.
    const existing = await store.get(input.sessionId);
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

  return {
    bus,
    store,

    async start() {
      await migrateLegacyMemory(env);
      await loadRoster();
      const named = registry.list().map((agent) => agent.name).join(', ');
      log(`stratusd ready — ${registry.list().length} agent(s): ${named}`);
    },

    // Drain: in-flight turns finish, new dispatches are refused, then the
    // database closes. SIGTERM handling in `stratus serve` calls this.
    async stop() {
      stopping = true;
      await Promise.allSettled([...inflight]);
      store.close();
      log('stratusd stopped');
    },

    dispatch,

    agents() {
      return registry.list();
    },
  };
};
