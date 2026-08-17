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
export class SqliteSessionStore implements SessionStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    // Sessions hold complete conversations (prompts, replies, tool output,
    // provider replay state) — owner-only, like the credentials file. The
    // chmods cover databases created earlier under a looser umask too.
    mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
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
  const store = new SqliteSessionStore(
    options.sessionDbPath ?? path.join(stratusHomePath(env), SESSIONS_DB_FILENAME),
  );
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
      registerSource({ definition: entry.soul.agent, soulPath: entry.path });
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
          const refreshed: AgentSource = { definition: soul.agent, soulPath: source.soulPath };
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
   * Progress-based abort: the timer resets on every event the session
   * emits, so a healthy long turn keeps itself alive while a stalled one
   * is cut loose. Tool executions carry their own executor timeouts
   * underneath this.
   */
  const withWatchdog = async <T>(
    sessionId: string,
    external: AbortSignal | undefined,
    idleEnabled: boolean,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const effectiveIdleMs = idleEnabled ? idleTimeoutMs : 0;
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
    const resetTimer = (): void => {
      if (effectiveIdleMs <= 0) {
        return;
      }
      if (timer) {
        clearTimeout(timer);
      }
      // Deliberately not unref'd: while a turn is in flight, this timer is
      // what guarantees the process can always make progress on it.
      timer = setTimeout(() => {
        timedOut = true;
        warn(`watchdog: no activity on session ${sessionId} for ${effectiveIdleMs}ms; aborting the turn`);
        controller.abort();
      }, effectiveIdleMs);
    };

    const unsubscribe = bus.subscribe((event: StratusEvent) => {
      if ('sessionId' in event && event.sessionId === sessionId) {
        resetTimer();
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
    // resolved configuration.
    const config = await resolveRuntimeConfig(
      { ...options.selection, ...(source.soulPath ? { soul: source.soulPath } : {}) },
      env,
    );
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
    const effectiveStreams = switchedToFallback && config.provider !== 'demo' && config.fallback
      ? fallbackStreamsDeltas(config.fallback)
      : streamsDeltas(config);

    return withWatchdog(input.sessionId, input.signal, effectiveStreams, async (signal) => {
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
