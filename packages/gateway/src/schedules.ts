import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { JsonObject, Session } from '@stratusagent/core';
import {
  canonicalDestination,
  nextFireAfter,
  SCHEDULE_ID_METADATA_KEY,
  SCHEDULED_TURN_METADATA_KEY,
  type ScheduleCreateInput,
  type ScheduleDestination,
  type ScheduleRecord,
  type SchedulerHandle,
} from '@stratusagent/agents';

/**
 * Durable schedules, in the same database sessions live in — a schedule
 * survives a restart the way a parked approval does, and an operator has
 * one file to back up, not two.
 *
 * Its own connection rather than a second table grown through
 * `SqliteSessionStore`, because the CLI opens this store *without* a
 * gateway: `stratus schedules` lists and cancels against the daemon's
 * database directly, and WAL mode is what makes two processes on one file
 * routine. The `next_fire_at` column exists so the due scan every tick
 * runs reads no JSON body; the empty string means "spent" (a one-shot that
 * fired, kept only until the turn it pre-authorized finishes) and sorts
 * before every real timestamp, which is why the scan compares both ends.
 */
export class SqliteScheduleStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    // Same posture as the session store sharing this file: the directory
    // and the database must not be readable by other local users, and the
    // sidecar chmods cover databases created under a looser umask.
    mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filePath);
    try {
      chmodSync(filePath, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    this.db.exec('PRAGMA journal_mode = WAL');
    // WAL serializes writers to one at a time across the whole file, and
    // this database is shared between two processes: the daemon claims
    // slots and saves sessions while `stratus schedules cancel` deletes a
    // row from another connection. Without a busy timeout the loser of that
    // lock throws `database is locked` immediately — a cancel that silently
    // failed would leave the schedule (and its destination grant) live.
    // Wait for the writer instead.
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        next_fire_at TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    for (const sensitive of [filePath, `${filePath}-wal`, `${filePath}-shm`, `${filePath}-journal`]) {
      try {
        chmodSync(sensitive, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
  }

  insert(record: ScheduleRecord): void {
    this.db
      .prepare('INSERT INTO schedules (id, agent_id, next_fire_at, body, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(record.id, record.agentId, record.nextFireAt ?? '', JSON.stringify(record), record.createdAt);
  }

  get(id: string): ScheduleRecord | undefined {
    const row = this.db.prepare('SELECT body FROM schedules WHERE id = ?').get(id) as
      | { body: string }
      | undefined;
    return row ? (JSON.parse(row.body) as ScheduleRecord) : undefined;
  }

  /** Every schedule, oldest first — the operator's audit list. */
  list(agentId?: string): ScheduleRecord[] {
    const rows = (agentId !== undefined
      ? this.db.prepare('SELECT body FROM schedules WHERE agent_id = ? ORDER BY created_at ASC').all(agentId)
      : this.db.prepare('SELECT body FROM schedules ORDER BY created_at ASC').all()) as Array<{ body: string }>;
    return rows.map((row) => JSON.parse(row.body) as ScheduleRecord);
  }

  /** Schedules whose slot has arrived. ISO strings order lexicographically. */
  due(nowIso: string): ScheduleRecord[] {
    const rows = this.db
      .prepare("SELECT body FROM schedules WHERE next_fire_at != '' AND next_fire_at <= ? ORDER BY next_fire_at ASC")
      .all(nowIso) as Array<{ body: string }>;
    return rows.map((row) => JSON.parse(row.body) as ScheduleRecord);
  }

  /**
   * Consume a slot, atomically: the write the double-run guarantee rests
   * on, executed BEFORE the dispatch so a daemon that dies mid-firing
   * restarts to a row whose window is already spent.
   *
   * Conditional on the slot still being the one the tick read, because
   * the read and this write are separated by real time and the CLI
   * deletes rows from another process: a schedule cancelled in that gap
   * must stay cancelled — `stratus schedules cancel` revoking the grant
   * but the prompt running anyway would be the worst of both. False means
   * the row is gone or its slot moved, and the caller fires nothing.
   */
  claimSlot(record: ScheduleRecord, expectedNextFireAt: string): boolean {
    return this.db
      .prepare('UPDATE schedules SET next_fire_at = ?, body = ? WHERE id = ? AND next_fire_at = ?')
      .run(record.nextFireAt ?? '', JSON.stringify(record), record.id, expectedNextFireAt)
      .changes > 0;
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id).changes > 0;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * The session-id namespace scheduled firings live in — `schedule:<id>:<slot>`.
 *
 * Reserved: the gateway refuses an *external* dispatch (a control-API
 * message post, a channel) that names a session id in this space, so the
 * only turns that ever run on a firing's session are the firing itself.
 * That is the load-bearing half of the destination carve-out being
 * unforgeable — the id is derivable from `GET /schedules`, so keeping it
 * out of an attacker's reach depends on nobody but the scheduler being
 * allowed to dispatch into it, not on it being secret.
 */
export const SCHEDULE_SESSION_ID_PREFIX = 'schedule:';

/** Whether a session id belongs to the reserved scheduled-firing namespace. */
export const isScheduleSessionId = (sessionId: string): boolean =>
  sessionId.startsWith(SCHEDULE_SESSION_ID_PREFIX);

export interface SchedulerLimits {
  /**
   * The floor under a recurring cadence, milliseconds. Applied to intervals
   * exactly and to cron expressions by their first observed gap — honest
   * enough to stop `* * * * *`, which is the schedule this floor exists
   * for. Default one minute.
   */
  minIntervalMs?: number;
  /**
   * Concurrent scheduled turns per agent. A firing that would exceed it is
   * deferred to the next tick, not dropped. Default 1: a schedule is the
   * first thing that can spend money while nobody watches, and the last
   * thing that should pile up behind its own slow firings.
   */
  maxConcurrentPerAgent?: number;
  /** How often the due scan runs, milliseconds. Default one second. */
  tickMs?: number;
}

const DEFAULT_MIN_INTERVAL_MS = 60_000;
const DEFAULT_MAX_CONCURRENT_PER_AGENT = 1;
const DEFAULT_TICK_MS = 1_000;

/**
 * What the scheduler needs from its store — `SqliteScheduleStore` as the
 * runtime reads it. An interface so a test can wrap the real store and
 * misbehave in the gaps (a cancel racing a due scan), which is exactly
 * where the guarantees live.
 */
export interface ScheduleStoreLike {
  insert(record: ScheduleRecord): void;
  get(id: string): ScheduleRecord | undefined;
  list(agentId?: string): ScheduleRecord[];
  due(nowIso: string): ScheduleRecord[];
  claimSlot(record: ScheduleRecord, expectedNextFireAt: string): boolean;
  delete(id: string): boolean;
}

export interface SchedulerRuntimeOptions {
  store: ScheduleStoreLike;
  /**
   * The gateway's own dispatch — never a second runner. Late-bound by
   * closure because the scheduler is built while the gateway still is.
   */
  dispatch(input: {
    sessionId: string;
    agentId: string;
    userMessage: string;
    metadata: JsonObject;
  }): Promise<unknown>;
  /**
   * Prove a destination can be served, rejecting with a message fit for
   * the person who named it. Called at creation — the whole point is
   * failing while somebody is present to hear why.
   */
  validateDestination(agentId: string, destination: ScheduleDestination): Promise<void>;
  /** Status of a firing's session, for the spent-one-shot sweep. */
  sessionStatus(sessionId: string): Promise<string | undefined>;
  /** The roster check: a schedule for an agent that does not exist is a refusal. */
  hasAgent(agentId: string): boolean;
  limits?: SchedulerLimits;
  log(line: string): void;
  warn(line: string): void;
}

export interface SchedulerRuntime {
  /** The handle the `schedule.*` tools close over. */
  handle: SchedulerHandle;
  /**
   * The destination carve-out, shaped for the permission policy's
   * `destinations` option: true exactly when this session is a firing of a
   * schedule that still exists, belongs to this session's agent, and was
   * approved with this destination. Consulted per call — a cancelled
   * schedule gates the very next send.
   */
  isPreauthorized(session: Session, destination: string): boolean;
  /** All agents' schedules, for the operator surfaces. */
  list(): ScheduleRecord[];
  /** Cancel any agent's schedule — the operator's stop button. */
  cancel(scheduleId: string): boolean;
  /** Sweep missed windows and start the tick loop. */
  start(): Promise<void>;
  /** Stop arming ticks; new firings cease. Idempotent. */
  stop(): void;
  /** Settles when every firing this scheduler started has finished. */
  drain(): Promise<void>;
}

export const createSchedulerRuntime = (options: SchedulerRuntimeOptions): SchedulerRuntime => {
  const { store, dispatch, validateDestination, sessionStatus, hasAgent, log, warn } = options;
  const minIntervalMs = options.limits?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const maxConcurrentPerAgent = options.limits?.maxConcurrentPerAgent ?? DEFAULT_MAX_CONCURRENT_PER_AGENT;
  const tickMs = options.limits?.tickMs ?? DEFAULT_TICK_MS;

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const inflight = new Set<Promise<void>>();
  const runningPerAgent = new Map<string, number>();
  /**
   * `${scheduleId}:${slot}` pairs a concurrency-cap deferral has already
   * logged, so a firing that outlasts its cadence warns once per deferred
   * slot rather than once per tick. Cleared when the slot finally fires or
   * is skipped — the same slot recurs on every tick until then.
   */
  const deferralsWarned = new Set<string>();
  /**
   * Session ids of firings THIS scheduler started and has not seen settle.
   *
   * The unforgeable half of the destination carve-out. Metadata alone
   * cannot be it: the control API forwards caller-supplied metadata into
   * new sessions, so a client could stamp a live schedule's id onto a
   * dispatch of its own and borrow the grant. Membership here is minted
   * only by `fireOrSkip`, in memory, so the only sessions that can pass
   * are the ones the scheduler itself dispatched — and a message queued
   * into a firing's session from outside runs after the firing settles
   * (single-flight), by which point the id is gone from this set.
   *
   * Deliberately not durable: a firing recovered after a restart (parked
   * on some other approval, which only happens where a human is
   * reachable) finishes without the grant and simply asks — losing a
   * convenience is the right failure direction for a security scope.
   */
  const activeFirings = new Set<string>();

  const enforceFloor = (input: ScheduleCreateInput): void => {
    const { cadence } = input;
    if (cadence.kind === 'every' && cadence.intervalMs < minIntervalMs) {
      throw new Error(
        `Schedules may not run more often than every ${Math.round(minIntervalMs / 1000)}s; ${Math.round(cadence.intervalMs / 1000)}s is below the floor.`,
      );
    }
    if (cadence.kind === 'cron') {
      // The first observed gap. Five-field cron cannot express anything
      // under a minute, so with the default floor this refuses nothing —
      // it exists for an operator who RAISES the floor, where `* * * * *`
      // must not slip past just for being spelled as a cron. An irregular
      // expression with one tight pair elsewhere still can — the
      // per-agent concurrency cap is the backstop that bounds the cost.
      const first = nextFireAfter(cadence, new Date());
      const second = first ? nextFireAfter(cadence, first) : undefined;
      if (first && second && second.getTime() - first.getTime() < minIntervalMs) {
        throw new Error(
          `Schedules may not run more often than every ${Math.round(minIntervalMs / 1000)}s; "${cadence.expression}" fires more often than that.`,
        );
      }
    }
  };

  const handle: SchedulerHandle = {
    async create(input) {
      if (!hasAgent(input.agentId)) {
        throw new Error(`Agent not found: ${input.agentId}`);
      }
      enforceFloor(input);
      const now = new Date();
      const next = nextFireAfter(input.cadence, now);
      if (!next) {
        throw new Error('This schedule would never fire — check the cadence.');
      }
      if (input.destination) {
        // Refused NOW, while a person is present to hear why — never
        // accepted and then silently unable to report at 6am.
        await validateDestination(input.agentId, input.destination);
      }
      const record: ScheduleRecord = {
        id: randomUUID(),
        agentId: input.agentId,
        cadence: input.cadence,
        prompt: input.prompt,
        ...(input.destination ? { destination: input.destination } : {}),
        createdAt: now.toISOString(),
        ...(input.createdBy ? { createdBy: input.createdBy } : {}),
        nextFireAt: next.toISOString(),
      };
      store.insert(record);
      log(`schedule ${record.id} created for ${record.agentId} — first firing ${record.nextFireAt}${record.destination ? `, reports to ${canonicalDestination(record.destination)}` : ''}`);
      return record;
    },
    async list(agentId) {
      return store.list(agentId);
    },
    async cancel(agentId, scheduleId) {
      const record = store.get(scheduleId);
      if (!record || record.agentId !== agentId) {
        // Ownership before existence: an agent probing ids learns nothing
        // about other agents' schedules.
        return false;
      }
      const deleted = store.delete(scheduleId);
      if (deleted) {
        log(`schedule ${scheduleId} cancelled by ${agentId}`);
      }
      return deleted;
    },
  };

  /**
   * The first slot strictly after `now`, skipping every window that passed
   * while the daemon was down — in closed form, so downtime never costs a
   * loop. For an interval this stays phase-aligned to the original slot
   * (the cadence keeps its offset); for a cron it is the next matching time
   * after now, which one bounded search already finds. A one-shot never
   * reaches here — a passed `at` has no following occurrence to skip.
   */
  const skipToFuture = (
    cadence: ScheduleRecord['cadence'],
    slotDate: Date,
    now: Date,
  ): Date | undefined => {
    if (cadence.kind === 'every') {
      const elapsed = now.getTime() - slotDate.getTime();
      const jumps = Math.floor(elapsed / cadence.intervalMs) + 1;
      return new Date(slotDate.getTime() + jumps * cadence.intervalMs);
    }
    return nextFireAfter(cadence, now);
  };

  /** `record` with its slot replaced — or removed, for a spent one-shot. */
  const withNextFire = (
    record: ScheduleRecord,
    next: Date | undefined,
    extra: Partial<ScheduleRecord> = {},
  ): ScheduleRecord => {
    const { nextFireAt: _spent, ...rest } = record;
    return { ...rest, ...extra, ...(next ? { nextFireAt: next.toISOString() } : {}) };
  };

  /**
   * Fire one due schedule: consume the slot durably, then dispatch.
   *
   * The catch-up rule is inline rather than a separate restart path,
   * because a restart is just a tick that sees an old slot: a slot whose
   * *following* occurrence has also passed is a window gone entirely —
   * advance past it with a log line, never replay. Anything else fires,
   * which on time is the normal case and late is the single catch-up.
   */
  const fireOrSkip = (record: ScheduleRecord, now: Date): void => {
    const slot = record.nextFireAt;
    if (!slot) {
      return;
    }
    const slotDate = new Date(slot);
    const following = nextFireAfter(record.cadence, slotDate);

    if (following && following.getTime() <= now.getTime()) {
      // Window passed entirely. Jump straight to the first slot after now —
      // in closed form, never by stepping one interval at a time. A daemon
      // down for a year against an `every 1m` schedule would otherwise spin
      // ~525k iterations here, synchronously inside the awaited start(),
      // stalling the whole boot. (A concurrent cancel makes the claim
      // no-op, which is fine: skipped and gone both mean "not replayed".)
      const next = skipToFuture(record.cadence, slotDate, now);
      // Two ways here, and the line says which. A slot this daemon deferred
      // under the per-agent cap has been due every tick since; its window
      // closing is the running turn outlasting the cadence, not downtime —
      // and the line that blamed downtime for it sent an operator to look
      // for a restart that never happened.
      const deferralKey = `${record.id}:${slot}`;
      log(deferralsWarned.has(deferralKey)
        ? `schedule ${record.id}: the firing deferred by the per-agent cap (slot ${slot}) outlasted its window; skipping to ${next ? next.toISOString() : 'never'}`
        : `schedule ${record.id}: missed firing(s) while the daemon was down; skipping to ${next ? next.toISOString() : 'never'}`);
      store.claimSlot(withNextFire(record, next), slot);
      deferralsWarned.delete(deferralKey);
      return;
    }

    const running = runningPerAgent.get(record.agentId) ?? 0;
    if (running >= maxConcurrentPerAgent) {
      // Deferred, not dropped: the slot stays due and the next tick
      // retries. Warned once per deferred slot, not once per tick — a
      // firing that outlasts its cadence would otherwise repeat the same
      // line every tickMs (~1/s) into a log CLAUDE.md keeps as a minimal
      // trace. The entry clears when the slot finally fires or is skipped.
      const deferralKey = `${record.id}:${slot}`;
      if (!deferralsWarned.has(deferralKey)) {
        deferralsWarned.add(deferralKey);
        warn(`schedule ${record.id}: ${record.agentId} already has ${running} scheduled turn(s) running; deferring this firing (slot ${slot})`);
      }
      return;
    }
    deferralsWarned.delete(`${record.id}:${slot}`);

    const firedAt = now.toISOString();
    const sessionId = `${SCHEDULE_SESSION_ID_PREFIX}${record.id}:${slot}`;
    // Advance from the scheduled slot, not from now: `following` is the
    // occurrence after this one, and the branch above proved it is still in
    // the future (a passed-entirely window was skipped there). Computing it
    // from `now` instead would push every future firing later by whatever
    // scheduler or event-loop delay this one suffered, permanently drifting
    // an `every 1h` cadence by the lateness of its first slightly-late tick.
    const next = following;
    // The slot is spent BEFORE the dispatch — the double-run guarantee —
    // and spent ATOMICALLY against the slot this tick read: a schedule
    // cancelled between the due scan and here is gone, and its prompt
    // must not run on a grant that was just revoked.
    if (!store.claimSlot(withNextFire(record, next, { lastFiredAt: firedAt, lastSessionId: sessionId }), slot)) {
      log(`schedule ${record.id}: slot ${slot} was cancelled or already claimed; not firing`);
      return;
    }

    runningPerAgent.set(record.agentId, running + 1);
    activeFirings.add(sessionId);
    const firing = dispatch({
      sessionId,
      agentId: record.agentId,
      userMessage: record.prompt,
      metadata: {
        [SCHEDULED_TURN_METADATA_KEY]: true,
        [SCHEDULE_ID_METADATA_KEY]: record.id,
      },
    }).then(
      () => {
        log(`schedule ${record.id} fired — session ${sessionId} completed`);
      },
      (error) => {
        warn(`schedule ${record.id} firing failed: ${error instanceof Error ? error.message : String(error)}`);
      },
    ).finally(() => {
      activeFirings.delete(sessionId);
      const count = (runningPerAgent.get(record.agentId) ?? 1) - 1;
      if (count > 0) {
        runningPerAgent.set(record.agentId, count);
      } else {
        runningPerAgent.delete(record.agentId);
      }
      // A spent one-shot's row outlives its firing only as the approval's
      // scope; once the turn is over, retire it.
      if (record.cadence.kind === 'at') {
        store.delete(record.id);
      }
    });

    inflight.add(firing);
    void firing.finally(() => inflight.delete(firing));
  };

  const tick = (): void => {
    if (stopped) {
      return;
    }
    try {
      const now = new Date();
      for (const record of store.due(now.toISOString())) {
        if (stopped) {
          break;
        }
        fireOrSkip(record, now);
      }
    } catch (error) {
      warn(`scheduler tick failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!stopped) {
      // Deliberately NOT unref'd, for the approval timer's reason: a
      // stored schedule is real outstanding work — the daemon owes its
      // next firing — and this timer is the only thing that will ever
      // start it. Shutdown belongs to stop(), which clears it.
      timer = setTimeout(tick, tickMs);
    }
  };

  return {
    handle,
    isPreauthorized(session, destination) {
      // A live firing of this scheduler's, first: session metadata is
      // written by whoever dispatches, so on its own it proves nothing —
      // see `activeFirings`. The row checks then bind the grant to the
      // schedule the human approved, re-read per call so a cancel revokes
      // mid-turn.
      if (!activeFirings.has(session.id)) {
        return false;
      }
      const scheduleId = session.metadata?.[SCHEDULE_ID_METADATA_KEY];
      if (typeof scheduleId !== 'string') {
        return false;
      }
      const record = store.get(scheduleId);
      return record !== undefined
        && record.agentId === session.agent.id
        && record.destination !== undefined
        && canonicalDestination(record.destination) === destination;
    },
    list() {
      return store.list();
    },
    cancel(scheduleId) {
      const deleted = store.delete(scheduleId);
      if (deleted) {
        log(`schedule ${scheduleId} cancelled`);
      }
      return deleted;
    },
    async start() {
      // Spent one-shots first: a row with no next slot is only the
      // approval scope of a firing that may still be parked on a human.
      // Turn over — or turn gone — means the row's work is done.
      for (const record of store.list()) {
        if (record.nextFireAt || record.cadence.kind !== 'at') {
          continue;
        }
        const status = record.lastSessionId ? await sessionStatus(record.lastSessionId) : undefined;
        if (status !== 'pending_approval') {
          store.delete(record.id);
          log(`schedule ${record.id}: one-shot already fired; removing`);
        }
      }
      tick();
    },
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
    async drain() {
      await Promise.allSettled([...inflight]);
    },
  };
};
