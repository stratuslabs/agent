import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  AgentRegistry,
  AgentRunner,
  EventBus,
  RunAbortedError,
  ToolRegistry,
  readPendingApproval,
  type AgentDefinition,
  type ApprovalAnswer,
  type ApprovalPolicy,
  type ApprovalResolutionReason,
  type JsonObject,
  type Session,
  type SessionStatus,
  type SessionStore,
  type StratusEvent,
  type ToolRisk,
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
  applySoulPins,
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
 * How long a parked call waits for a person. Long enough to survive a
 * meeting, short enough that a request nobody saw does not hold a turn (and
 * the Slack thread it is answering) open indefinitely.
 */
const DEFAULT_APPROVAL_TIMEOUT_MS = 900_000;
/**
 * Node's largest `setTimeout` delay. Anything above it does not become a
 * long wait — it silently becomes a 1ms one, so a config asking for a
 * 30-day approval window would expire every request almost immediately.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

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

  /**
   * Session ids in a state, oldest first — the index a restarting daemon
   * sweeps for turns parked on a human. The `status` column carries it, so
   * no conversation body is deserialized to answer the question.
   */
  async listIdsByStatus(status: SessionStatus): Promise<string[]> {
    const rows = this.db
      .prepare('SELECT id FROM sessions WHERE status = ? ORDER BY updated_at ASC')
      .all(status) as Array<{ id: string }>;
    return rows.map((row) => row.id);
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
/**
 * A soul's provider/model pins, and the daemon-wide defaults they demote.
 *
 * The implementation lives in `@stratusagent/state`, beside the resolver
 * whose precedence it manipulates — it never had a gateway dependency. It is
 * re-exported here because this is where callers were told to import it from,
 * and because "what will a served agent actually resolve to" is a gateway
 * question even when the rule answering it is not gateway code.
 */
export { applySoulPins, type SoulPinContext } from '@stratusagent/state';

export interface GatewayChannelAdapter {
  name: string;
  start(gateway: Gateway): Promise<void>;
  stop(): Promise<void>;
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
   * When this call first parked, if a restart is re-asking it. The wait is
   * measured from here, so a request keeps the window it started with
   * instead of winning a fresh one — otherwise a daemon that restarts a
   * minute before the deadline grants another full timeout, and one that
   * crash-loops keeps a request alive forever.
   */
  parkedAt?: string;
  signal?: AbortSignal;
}

export type ApprovalRequester = (request: GatewayApprovalRequest) => Promise<ApprovalAnswer>;

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
  /** When this call parked, ISO-8601. */
  parkedAt: string;
  /**
   * When it denies itself, ISO-8601. Absent when it never will — the same
   * distinction the announcing event draws.
   */
  expiresAt?: string;
  /** The session's metadata: where the turn is happening. */
  metadata?: JsonObject;
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

export interface GatewayOptions {
  env?: StateEnvironment;
  /** Gateway-wide provider/model overrides applied beneath per-soul pins. */
  selection?: RuntimeSelection;
  /** Channel adapters to run (Slack, …). Started on start(), stopped on stop(). */
  channels?: GatewayChannelAdapter[];
  /**
   * The policy, or a factory that builds one from the gateway's approval
   * transport. Pass a factory whenever the policy parks turns on a human
   * reached through a channel — `remote` mode — since that policy needs the
   * transport the gateway is still constructing.
   */
  approvals?: ApprovalPolicy | ((transport: ApprovalTransport) => ApprovalPolicy);
  /**
   * How long a parked call waits before it denies itself. 0 waits forever,
   * which is only ever right in a test. Default 15 minutes.
   */
  approvalTimeoutMs?: number;
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
  /**
   * Re-read the agents directory and the configured default soul, returning
   * the roster that results. Souls are already re-read on every dispatch, so
   * this is for files that appeared or disappeared since start — an agent
   * created by another surface, or one whose soul was deleted.
   */
  reloadRoster(): Promise<AgentDefinition[]>;
  /**
   * The turn currently running on a session, if the caller that started it
   * named one. Single-flight per session is what makes this exact: at most
   * one turn is ever running on a session, so an event emitted for it
   * belongs to this turn and no other.
   */
  activeTurnId(sessionId: string): string | undefined;
  /** Every call parked on a human right now, oldest first. */
  pendingApprovals(): PendingApproval[];
  /**
   * Settles a parked call. Returns false when the request is not pending —
   * already decided, expired, or belonging to a turn that was cancelled —
   * which is the normal outcome of a button clicked a minute too late, not
   * an error. Callers surface it to whoever clicked; they must never treat
   * it as "try again".
   */
  resolveApproval(input: ResolveApprovalInput): boolean;
}

interface AgentSource {
  definition: AgentDefinition;
  /** Soul file backing this agent; undefined for the built-in default. */
  soulPath?: string;
  /** The parsed soul, carried for its provider/model pins. */
  soul?: ParsedSoul;
}

/**
 * Recorded on a turn the previous process was still running when it died.
 *
 * Exported because "distinguishable" is the whole point: a surface, a
 * test, or an operator reading `lastError` has to be able to tell a turn
 * nobody finished apart from one a provider or a tool actually failed, and
 * matching on prose that lives in one place beats each caller inventing
 * its own guess at the wording.
 */
export const ABANDONED_TURN_ERROR =
  'stratusd stopped while this turn was still running; it was not resumed. Send the message again.';

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

  // ---- approval brokering -------------------------------------------------

  const approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  // Refused at construction, not absorbed: a negative or NaN timeout fails
  // the `> 0` test below and quietly means "never expire" — the one
  // behavior documented for an explicit 0, and the last one a caller who
  // typed a bad number wants. Config-file values are already rejected with
  // a better message; this catches the programmatic path.
  if (!Number.isFinite(approvalTimeoutMs) || approvalTimeoutMs < 0) {
    throw new Error(
      `approvalTimeoutMs must be a non-negative number of milliseconds (0 to wait indefinitely); received ${String(options.approvalTimeoutMs)}.`,
    );
  }
  // Clamped, not trusted: a delay past Node's timer range is not a long
  // wait, it is a 1ms one, so an over-large value would turn every approval
  // into an instant expiry — the opposite of what it asked for. The CLI
  // rejects these at config load with a better message; this is the
  // backstop for a programmatic caller.
  const effectiveApprovalTimeoutMs = Math.min(approvalTimeoutMs, MAX_TIMER_DELAY_MS);
  if (approvalTimeoutMs > MAX_TIMER_DELAY_MS) {
    warn(
      `approval timeout ${approvalTimeoutMs}ms is above Node's maximum timer delay; using ${MAX_TIMER_DELAY_MS}ms (~24.8 days)`,
    );
  }

  type SettleApproval = (
    answer: ApprovalAnswer,
    reason: ApprovalResolutionReason,
    actor?: string,
  ) => void;

  /**
   * One parked call: how to settle it, and what it is. The summary is kept
   * alongside the settler because a listing needs the request itself, and
   * the map is the only place that knows a request is still outstanding.
   */
  interface ParkedCall {
    settle: SettleApproval;
    pending: PendingApproval;
  }

  const pendingApprovals = new Map<string, ParkedCall>();
  /**
   * In-flight `tool.approval-resolved` emissions. `EventBus.emit` awaits its
   * subscribers in order, so one async handler ahead of a channel adapter
   * suspends the emission before the adapter ever sees it. Nothing today is
   * async in front of one — which is exactly the problem: the shutdown
   * guarantee below would rest on that staying true, and the first async
   * subscriber anyone adds would silently leave live-looking buttons in a
   * workspace the daemon has left.
   */
  const approvalEmissions = new Set<Promise<void>>();

  /**
   * Publishes one parked call and settles when somebody answers it, the
   * request expires, or the turn is cancelled.
   *
   * All three endings run through the same `settle`, which removes the
   * request from the registry BEFORE resolving. That ordering is the whole
   * point: a request that is no longer pending cannot be resolved twice,
   * so a click racing the timeout — or arriving after an abort — is refused
   * rather than executing a tool for a turn that has already moved on.
   */
  const requestApproval: ApprovalRequester = (request) => new Promise<ApprovalAnswer>((resolve) => {
    // A shutdown denies what is parked once, at the top of stop(). Turns
    // already running keep going through the drain, though, and one of them
    // can reach a gated tool AFTER that snapshot — finishing a provider
    // call, or moving to the next call in the same response. Parking it
    // would deadlock the drain against a question nobody is left to answer:
    // stop() waits for the turn, the turn waits for the approval, and the
    // approval waits out its timeout — forever when there is none.
    if (stopping) {
      resolve('deny');
      void bus.emit({
        type: 'tool.approval-resolved',
        sessionId: request.session.id,
        requestId: randomUUID(),
        answer: 'deny',
        reason: 'cancelled',
      });
      return;
    }

    const requestId = randomUUID();

    let timer: NodeJS.Timeout | undefined;
    const onAbort = (): void => settle('deny', 'cancelled');

    /**
     * Settles once the request has finished being announced.
     *
     * Both emissions go through the same subscriber list, in order, and
     * `EventBus.emit` awaits each one — so an async subscriber ahead of a
     * channel can hold the announcement while a timeout or abort fires
     * behind it, and the channel would hear that a request it has never
     * heard of was resolved. It drops that, then renders the announcement
     * when it finally arrives, leaving buttons for a settled request that
     * nothing will ever retract.
     *
     * Chaining is the fix rather than remembering orphaned resolutions in
     * the channel: a resolution that arrives before its request is not
     * something a consumer can act on, so it should not be able to happen.
     * Starts resolved, because a turn already aborted never announces at
     * all and its denial should not wait on an emission that never runs.
     */
    let announced: Promise<void> = Promise.resolve();

    const settle: SettleApproval = (answer, reason, actor) => {
      // Identity, not presence: a request that already settled is gone from
      // the registry, and comparing against this exact function is what
      // makes every ending — click, timeout, abort, shutdown — idempotent.
      if (pendingApprovals.get(requestId)?.settle !== settle) {
        return;
      }
      pendingApprovals.delete(requestId);
      if (timer) {
        clearTimeout(timer);
      }
      request.signal?.removeEventListener('abort', onAbort);
      resolve(answer);
      const emitted = announced.then(() => bus.emit({
        type: 'tool.approval-resolved',
        sessionId: request.session.id,
        requestId,
        answer,
        reason,
        ...(actor ? { actor } : {}),
      }));
      approvalEmissions.add(emitted);
      void emitted.finally(() => approvalEmissions.delete(emitted));
    };

    // What is left of the window, not a fresh one: a re-asked request
    // carries when it originally parked, and the elapsed time counts.
    // Computed before registration because the summary below quotes the
    // deadline, and a listing that disagreed with the announcing event about
    // when a request expires would be worse than one that said nothing.
    const alreadyWaitedMs = request.parkedAt ? Date.now() - Date.parse(request.parkedAt) : 0;
    const remainingTimeoutMs = effectiveApprovalTimeoutMs > 0
      ? effectiveApprovalTimeoutMs - (Number.isFinite(alreadyWaitedMs) ? Math.max(0, alreadyWaitedMs) : 0)
      : 0;
    const expiresAt = remainingTimeoutMs > 0
      ? new Date(Date.now() + remainingTimeoutMs).toISOString()
      : undefined;

    pendingApprovals.set(requestId, {
      settle,
      pending: {
        requestId,
        sessionId: request.session.id,
        agentId: request.session.agent.id,
        call: request.call,
        risk: request.risk,
        parkedAt: request.parkedAt ?? new Date().toISOString(),
        ...(expiresAt ? { expiresAt } : {}),
        ...(request.session.metadata ? { metadata: request.session.metadata } : {}),
      },
    });

    if (effectiveApprovalTimeoutMs > 0 && remainingTimeoutMs <= 0) {
      // Nothing left to wait with. Settled here rather than armed with a
      // zero timer, which `setTimeout` would still run a tick later — long
      // enough to announce a request that is already over.
      settle('deny', 'timeout');
      return;
    }

    if (remainingTimeoutMs > 0) {
      // Deliberately NOT unref'd. A parked turn is real outstanding work,
      // and its timer is the only thing that will ever finish it — letting
      // the process exit out from under one would abandon the turn instead
      // of denying it. Shutdown is handled where it belongs, in stop(),
      // which settles every outstanding request before draining.
      timer = setTimeout(() => settle('deny', 'timeout'), remainingTimeoutMs);
    }

    // The abort listener is attached before the request is announced, so a
    // turn cancelled while the event is still being delivered still ends
    // the request rather than leaving it pending forever.
    if (request.signal) {
      if (request.signal.aborted) {
        settle('deny', 'cancelled');
        return;
      }
      request.signal.addEventListener('abort', onAbort, { once: true });
    }

    // `announced` is assigned BEFORE the emission starts, because emit runs
    // its first subscribers synchronously — one of them settling the
    // request inline would otherwise chain onto the already-resolved
    // placeholder and race the very announcement it is answering.
    let markAnnounced = (): void => {};
    announced = new Promise<void>((resolveAnnounced) => {
      markAnnounced = resolveAnnounced;
    });
    const announcing = bus.emit({
      type: 'tool.approval-requested',
      sessionId: request.session.id,
      agentId: request.session.agent.id,
      requestId,
      call: request.call,
      risk: request.risk,
      ...(request.session.metadata ? { metadata: request.session.metadata } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    });
    // Drained at shutdown alongside the resolutions: a channel that has not
    // yet been told a request exists cannot be told it was denied either.
    approvalEmissions.add(announcing);
    void announcing.finally(() => {
      approvalEmissions.delete(announcing);
      markAnnounced();
    });
  });

  const resolveApproval = (input: ResolveApprovalInput): boolean => {
    const parked = pendingApprovals.get(input.requestId);
    if (!parked) {
      return false;
    }
    parked.settle(input.answer, input.reason ?? 'decided', input.actor);
    return true;
  };

  /**
   * How a turn's watchdog stops its own clock, registered while it runs.
   *
   * Recording that a tool phase is open is not enough on its own: the
   * timer is only re-evaluated when an event arrives, so a phase opened by
   * something that emits nothing — an approval policy handed straight to
   * the gateway — would leave an already-armed timer running to fire
   * mid-wait.
   */
  const suspendWatchdog = new Map<string, () => void>();

  /**
   * Approval waits in progress, per session.
   *
   * Deliberately a balanced counter and not a set of call ids. An earlier
   * shape had the approval wrapper *open* a phase that the watchdog's
   * event observer was expected to close, and that handoff was wrong in
   * every way it could be: the observer does not exist when no watchdog is
   * armed, so nothing closed it; a policy that threw closed nothing; and a
   * stale entry did not merely leak, it suppressed the watchdog for the
   * next turn on that session. Four separate exits, each patched in turn.
   *
   * A counter incremented and decremented in one `finally` cannot have any
   * of those bugs, because the thing that opens the phase is the thing
   * that closes it, in the same scope, on every path out.
   */
  const approvalWaits = new Map<string, number>();
  const holdApprovalWait = (sessionId: string): (() => void) => {
    approvalWaits.set(sessionId, (approvalWaits.get(sessionId) ?? 0) + 1);
    // Stop any clock already running: this wait produces no events, so
    // nothing else would.
    suspendWatchdog.get(sessionId)?.();
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const remaining = (approvalWaits.get(sessionId) ?? 1) - 1;
      if (remaining > 0) {
        approvalWaits.set(sessionId, remaining);
      } else {
        approvalWaits.delete(sessionId);
      }
    };
  };

  const configuredApprovals = typeof options.approvals === 'function'
    ? options.approvals({ request: requestApproval })
    : options.approvals;

  /**
   * Every approval opens a tool phase, whatever policy answers it.
   *
   * `tool.approval-requested` is the broker's event, so it exists only for
   * the remote path; a policy handed straight to the gateway emits nothing
   * at all, and `tool.called` comes only *after* the answer. Without this,
   * a slow custom policy on a streaming provider that hosts its own loop
   * would be indistinguishable from a stalled turn — the case this
   * watchdog work exists to stop, arriving through a different door.
   */
  const approvals: ApprovalPolicy | undefined = configuredApprovals
    ? {
        async approve(context) {
          const release = holdApprovalWait(context.session.id);
          try {
            return await configuredApprovals.approve(context);
          } finally {
            // Every path out, including a policy that throws. What happens
            // after the answer is the tool events' business, and they are
            // observed by the watchdog itself.
            release();
          }
        },
      }
    : undefined;
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

  /**
   * Build the roster from what is on disk right now.
   *
   * Runs at start and again on every `reloadRoster()`, which is why it
   * tracks what it registered rather than only adding: a soul file deleted
   * since the last pass has to stop being dispatchable, and re-registering
   * the survivors over a map nothing removes from would leave it addressable
   * — by id, and from every channel — for the rest of the daemon's life.
   */
  const loadRoster = async (): Promise<void> => {
    const seen = new Set<string>();
    const registerFresh = (source: AgentSource): void => {
      registerSource(source);
      seen.add(source.definition.id);
    };

    // The built-in id is reserved BEFORE ordinary roster entries load: a
    // roster file that happens to declare id "stratus" must not hijack
    // the documented built-in fallback for agentId-less dispatches — the
    // guard below skips it with a warning. Only the explicitly
    // configured default soul may take the id over (defaultAgentId
    // replaces a pathless source).
    registerFresh({ definition: { ...DEFAULT_STRATUS_AGENT } });
    // Throws on two roster files claiming one id: that is a collision with
    // no correct winner, and refusing to serve beats letting sort order
    // decide whose sessions, memory, and credentials an agent inherits.
    const entries: RosterEntry[] = await loadRosterSouls(env, warn);
    for (const entry of entries) {
      // Against ids claimed by THIS pass, not by any earlier one: a reload
      // must be free to re-register the agent it just re-read, and only the
      // built-in above can legitimately block a roster file.
      if (seen.has(entry.soul.agent.id)) {
        // Only reachable for the reserved built-in id now — roster-vs-
        // roster duplicates never get this far. Reserved is not the same
        // failure as duplicated: a soul may not take the fallback over,
        // and must not be able to take the daemon down by trying.
        warn(`agent id ${entry.soul.agent.id} is reserved for the built-in agent; ignoring ${entry.path}`);
        continue;
      }
      registerFresh({ definition: entry.soul.agent, soulPath: entry.path, soul: entry.soul });
    }
    // The configured default soul is part of the roster too — it is what
    // an agentId-less dispatch answers as. It may live outside the agents
    // directory, and it survives a read failure by name, so what it
    // resolves to is kept whether or not this pass re-registered it.
    seen.add(await defaultAgentId());

    for (const id of [...sources.keys()]) {
      if (!seen.has(id)) {
        sources.delete(id);
        registry.unregister(id);
      }
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
      ...(approvals ? { approvals } : {}),
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
    // The same two modes as a primary. A subscription fallback that is not
    // recognised as streaming gets no watchdog at all once a session
    // switches to it, so a stall there would run to the provider's own
    // ten-minute timer instead of the idle timeout the operator set.
    fallback.provider === 'anthropic' && Boolean(fallback.apiKey || fallback.authToken);

  const streamsDeltas = (config: RuntimeConfig): boolean =>
    // Both Anthropic modes stream now: an API key through the Messages
    // API, a subscription token through the Agent SDK's partial messages.
    config.provider === 'anthropic' && Boolean(config.apiKey || config.authToken);

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
    /**
     * Tool calls this turn has started and not finished.
     *
     * `pendingTools` above reads a count off `provider.response`, which
     * only a provider that hands its calls back to the kernel loop emits.
     * A provider hosting its own loop dispatches inside `generate`, so that
     * count is zero for the whole of a hosted tool. These are the kernel's
     * own tool events, which every path emits because every path runs its
     * tools through the same executor — and they are turn-local, so an
     * aborted turn takes them with it rather than leaving anything behind.
     */
    const openToolCalls = new Set<string>();
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
          // Only a *fallback* reset marks the mid-turn, session-sticky
          // switch that the timer follows. A provider retrying its own
          // attempt abandons its partial output too, but nothing about
          // who is serving the turn changed — reading that as a switch
          // would disarm the watchdog for the rest of a turn that is
          // still running on the provider it started on.
          if (event.delta.type === 'reset' && event.delta.reason === 'fallback') {
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
        case 'tool.approval-requested':
          // Redundant with the approval wrapper for a gateway-owned
          // transport, and not redundant for a recovered turn, whose
          // request is re-announced without going through a policy again.
          openToolCalls.add(event.call.id);
          break;
        case 'tool.called':
          openToolCalls.add(event.call.id);
          break;
        case 'tool.completed':
          // Completion names the call through its result; denial carries
          // the call itself. Both settle it.
          openToolCalls.delete(event.result.callId);
          pendingTools = Math.max(0, pendingTools - 1);
          break;
        case 'tool.denied':
          openToolCalls.delete(event.call.id);
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
      if (
        streamingActive
        && pendingTools === 0
        && openToolCalls.size === 0
        && (approvalWaits.get(sessionId) ?? 0) === 0
        && !turnSettling
      ) {
        armTimer();
      }
    });

    suspendWatchdog.set(sessionId, suspendTimer);

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
      suspendWatchdog.delete(sessionId);
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

  /**
   * The turn id running on each session, for callers that named one.
   *
   * Set when the chained work actually starts — not when the dispatch was
   * queued — because a message waiting behind another turn has not begun,
   * and stamping events with it would attribute the running turn's output to
   * the queued one. Single-flight per session is what makes one entry per
   * session sufficient.
   */
  const activeTurns = new Map<string, string>();

  /**
   * The runtime one agent would run on right now — config snapshot, soul
   * pins, degradation and all.
   *
   * Extracted so recovery resolves it exactly as a dispatch does. A second
   * copy of this chain is the difference between a recovered turn finishing
   * on its agent's provider and finishing on the daemon's default, and it
   * would drift the first time either side gained a rule.
   */
  const runtimeForAgent = async (source: AgentSource): Promise<RuntimeConfig> => {
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
    return resolveRuntimeConfig(selection, resolveEnv);
  };

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

    const config = await runtimeForAgent(source);
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

  /**
   * Finishes the turns that were parked on a human when this daemon last
   * went down.
   *
   * Run after the channels are up, deliberately: recovery re-asks, and a
   * request emitted into a gateway with no live adapter would be declined
   * for want of anywhere to put it — turning "your approval survived the
   * restart" into "your approval was denied by the restart".
   *
   * Each session is recovered independently and failures are per-session:
   * one unrecoverable turn must not stop the daemon from serving, or from
   * recovering the others.
   */
  const recoverParkedTurns = async (): Promise<void> => {
    if (!store.listIdsByStatus) {
      return;
    }
    const parked = await store.listIdsByStatus('pending_approval');
    if (parked.length === 0) {
      return;
    }
    log(`recovering ${parked.length} turn(s) parked on approval`);

    // Started together, not one after another. Each recovery re-asks and
    // then waits on a human, so awaiting them in sequence would mean the
    // second parked turn is not even *announced* until the first is
    // answered — fifteen minutes later by default, and never at all with a
    // zero timeout. They are independent turns; only same-session work is
    // ordered, and onSessionChain already guarantees that.
    await Promise.allSettled(parked.map((sessionId) => recoverOne(sessionId)));
  };

  const recoverOne = (sessionId: string): Promise<void> =>
    onSessionChain(sessionId, async () => {
      if (stopping) {
        return;
      }
      try {
        const session = await store.get(sessionId);
        if (!session) {
          return;
        }
        const record = readPendingApproval(session);
        // A wait that outlived its window while the daemon was down is
        // honoured, not restarted: the request really did go unanswered for
        // the whole time it was configured to wait, and downtime is not a
        // reason to extend a security decision. Measured from when the turn
        // parked against this daemon's timeout — the transport's original
        // deadline was chosen after the checkpoint was written and is gone
        // with the process that chose it. Denying goes through the same
        // recovery path, so the queue behind it still drains.
        const parkedAt = record ? Date.parse(record.parkedAt) : Number.NaN;
        const expired = effectiveApprovalTimeoutMs > 0
          && Number.isFinite(parkedAt)
          && Date.now() - parkedAt >= effectiveApprovalTimeoutMs;
        if (expired) {
          log(`${sessionId}: the approval for ${record?.call.toolName} outlived its window while the daemon was down; denying it`);
        }

        // Resolved the way a dispatch for this agent would resolve it, so a
        // recovered turn finishes on the same provider, model, and
        // credentials it was parked on.
        const source = await refreshAgent(session.agent.id);

        // And on the CURRENT definition, saved before recovery reads the
        // session back. An allowlist is a permission boundary: a soul that
        // dropped a tool while the daemon was down must not have that tool
        // executed by the turn that outlived the change, and
        // `allowedToolsFor` reads the definition frozen into the session
        // ahead of the registry. Dispatch refreshes it the same way before
        // resuming.
        session.agent = source.definition;
        await store.save(session);

        const runner = runnerFor(await runtimeForAgent(source));
        await runner.recoverPendingApproval(sessionId, { denyPending: expired });
      } catch (error) {
        warn(`could not recover parked session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

  /**
   * Turns the last process was still running when it stopped being able to
   * finish them.
   *
   * `pending_approval` is the one window a turn can be picked up from, and
   * it has its own sweep above. Everything else a turn does is saved as
   * `running`: the provider call, the executor, and — on a provider that
   * hosts its own loop — the approval wait too, since a hosted call is
   * deliberately not checkpointed (`executeHostedToolCall` passes
   * `recoverable: false`, because the SDK's inner loop is not something a
   * restart can rebuild). None of those can be resumed, and nothing else
   * sweeps them, so the record goes on claiming the turn is running for as
   * long as the session exists.
   *
   * Note what this is *not* for. A graceful stop denies everything parked
   * and drains the turns those denials release, so an operator restarting
   * the daemon normally has nothing here. These are the turns a crash, a
   * SIGKILL, or a lost machine left behind.
   */
  const listAbandonedTurns = async (): Promise<string[]> => {
    if (!store.listIdsByStatus) {
      return [];
    }
    return store.listIdsByStatus('running');
  };

  /**
   * Marks each of them failed, with a reason that says what happened.
   *
   * Read BEFORE the channels start and applied after, which is the only
   * ordering that is both honest and safe. Reading first means the list is
   * exactly what the last process left, with no chance of a turn this
   * process started being in it. Applying after means the failure is
   * emitted into a gateway whose surfaces are listening, rather than into
   * one where nothing is.
   *
   * The gap between the two is real, though: an inbound message for one of
   * these sessions can arrive as soon as the channels are up. What makes
   * that safe is single-flight — every writer of a session goes through
   * `onSessionChain`, so this runs either wholly before that turn (it
   * fails, and `resume()` then clears `lastError` and starts fresh) or
   * wholly after it (the status has moved off `running`, and the re-read
   * below leaves it alone). There is no interleaving in which this
   * overwrites a live turn.
   *
   * What that invariant does NOT cover is a second daemon on the same
   * database, whose turns are running with no chain of ours in front of
   * them. Two processes sharing a session store is already unsupported —
   * the parked sweep above would re-ask that daemon's approvals for the
   * same reason — and no check here would make it supported.
   */
  const failAbandonedTurns = async (abandoned: string[]): Promise<void> => {
    if (abandoned.length === 0) {
      return;
    }
    log(`failing ${abandoned.length} turn(s) left running by the last stratusd`);
    await Promise.allSettled(abandoned.map((id) => failAbandonedTurn(id)));
  };

  const failAbandonedTurn = (id: string): Promise<void> =>
    onSessionChain(id, async () => {
      if (stopping) {
        return;
      }
      try {
        const session = await store.get(id);
        // Re-read on the chain, because the snapshot is from before the
        // channels came up: a message that arrived since has already taken
        // this session somewhere else, and that turn owns it now.
        if (!session || session.status !== 'running') {
          return;
        }
        session.status = 'failed';
        session.lastError = ABANDONED_TURN_ERROR;
        await store.save(session);
        await bus.emit({ type: 'session.updated', sessionId: id, status: 'failed' });
        await bus.emit({ type: 'session.failed', sessionId: id, error: ABANDONED_TURN_ERROR });
      } catch (error) {
        warn(`could not fail abandoned turn ${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

  /**
   * Runs `work` as the session's next turn: queued behind whatever that
   * session is already doing, and tracked so shutdown drains it.
   *
   * Recovery goes through here as well as dispatch, and must. Channels are
   * live before a sweep finishes, so an inbound message for a parked
   * session could otherwise `resume()` alongside `recoverPendingApproval()`
   * — one closing the parked call as interrupted while the other re-enters
   * it, both saving divergent copies of the same transcript, and the tool
   * possibly running twice. Single-flight per session is the invariant that
   * stops that, and it only holds if everything that writes a session goes
   * through it.
   */
  const onSessionChain = <T>(sessionId: string, work: () => Promise<T>): Promise<T> => {
    const previous = sessionChains.get(sessionId) ?? Promise.resolve();
    const turn = previous.then(work, work);

    const settled = turn.catch(() => {});
    sessionChains.set(sessionId, settled);
    inflight.add(settled);
    void settled.finally(() => {
      inflight.delete(settled);
      if (sessionChains.get(sessionId) === settled) {
        sessionChains.delete(sessionId);
      }
    });

    return turn;
  };

  const dispatch = async (input: DispatchInput): Promise<Session> => {
    if (stopping) {
      throw new Error('The gateway is stopping and no longer accepts new work.');
    }

    const { turnId } = input;
    if (turnId === undefined) {
      return onSessionChain(input.sessionId, () => dispatchInternal(input));
    }

    return onSessionChain(input.sessionId, async () => {
      activeTurns.set(input.sessionId, turnId);
      try {
        return await dispatchInternal(input);
      } finally {
        // Unconditional, and safe to be: the chain guarantees no other turn
        // for this session ran between the set above and here, so this can
        // only ever be clearing its own entry.
        activeTurns.delete(input.sessionId);
      }
    });
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

      // Read before anything can dispatch, so this is exactly what the
      // last process left running and not a turn of ours caught in flight.
      // Applied further down, once there is somewhere for the failure to
      // be heard.
      const abandoned = await listAbandonedTurns();

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

      // Last, and not awaited: recovery re-asks, so it needs the channels
      // above already listening — but a turn parked behind a slow approver
      // must not hold up start(), or a daemon with one outstanding request
      // would refuse to finish booting.
      void recoverParkedTurns().catch((error) => {
        warn(`recovering parked turns failed: ${error instanceof Error ? error.message : String(error)}`);
      });

      // Not awaited for the same reason, and independent of the sweep
      // above: these sessions are not parked, so the two never touch the
      // same one.
      void failAbandonedTurns(abandoned).catch((error) => {
        warn(`failing abandoned turns failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    },

    // Drain: channels stop taking messages, in-flight turns finish, new
    // dispatches are refused, then the database closes. SIGTERM handling
    // in `stratus serve` calls this.
    async stop() {
      // Refuse new work first; then let channels finish rendering their
      // in-flight turns (already-started dispatches keep running), drain,
      // and close.
      stopping = true;
      // Deny what is parked before draining, or the drain waits out every
      // outstanding approval timeout — a shutdown would hang for as long as
      // the longest request had left. Each denial is a real decision the
      // turn continues from, so the drain below still finishes those turns.
      for (const parked of [...pendingApprovals.values()]) {
        parked.settle('deny', 'cancelled');
      }
      // Let those resolutions reach their subscribers before the channels
      // go down, or a channel that renders approvals never learns to
      // retract the buttons it is still showing.
      await Promise.allSettled([...approvalEmissions]);
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

    async reloadRoster() {
      await loadRoster();
      const roster = registry.list();
      log(`roster reloaded — ${roster.length} agent(s): ${roster.map((agent) => agent.name).join(', ')}`);
      return roster;
    },

    activeTurnId(sessionId) {
      return activeTurns.get(sessionId);
    },

    pendingApprovals() {
      return [...pendingApprovals.values()]
        .map((parked) => parked.pending)
        .sort((a, b) => a.parkedAt.localeCompare(b.parkedAt));
    },

    resolveApproval,
  };

  return gateway;
};
