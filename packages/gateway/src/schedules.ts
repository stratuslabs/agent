import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { SENDER_TRUST_METADATA_KEY, type JsonObject, type Session } from '@stratusagent/core';
import {
  canonicalDestination,
  DEFAULT_EVENT_MAX_PER_HOUR,
  isWithinQuietHours,
  nextFireAfter,
  SCHEDULE_ID_METADATA_KEY,
  SCHEDULED_TURN_METADATA_KEY,
  type ScheduleCreateInput,
  type ScheduleDestination,
  type ScheduleRecord,
  type SchedulerHandle,
} from '@stratusagent/agents';
import { assertDerivedStatePathSync } from '@stratusagent/state';

import type { EventTrigger } from './event-intake.ts';
import type { EventFiringRow, SqliteEventStore } from './events.ts';
import { tightenSqliteFile } from './sessions.ts';

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
export interface SqliteScheduleStoreOptions {
  /**
   * The state home `filePath` was derived under, when it was — `fleet.db`
   * is. Every component below it must then be real, the rule
   * `assertDerivedStatePath` owns: this constructor creates the file, puts
   * it in WAL, chmods it and creates the table, so without the check a
   * linked `fleet.db` has all of that done to whatever it points at. The
   * `stratus schedules` commands open it directly, with no session index
   * or migration ahead of them to refuse the link first. Omitted for the
   * legacy database, which an operator may have relocated before the rule.
   */
  stateHome?: string;
}

/**
 * Open `fleet.db` the way every store sharing it must: the derived-path
 * check, an owner-only directory and file, WAL with a busy timeout, then
 * `schema`, then the sidecars tightened. One implementation, because the
 * schedule store and the event store (card 590) each hold their own
 * connection to this file, and a second copy of this sequence is the one
 * that drifts.
 */
export const openFleetDatabase = (
  filePath: string,
  options: SqliteScheduleStoreOptions,
  schema: string,
): DatabaseSync => {
  if (options.stateHome !== undefined) {
    assertDerivedStatePathSync(options.stateHome, filePath, 'file');
  }
  // Same posture as the session store sharing this file: the directory
  // and the database must not be readable by other local users, and the
  // sidecar chmods cover databases created under a looser umask.
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filePath);
  try {
    chmodSync(filePath, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  db.exec('PRAGMA journal_mode = WAL');
  // WAL serializes writers to one at a time across the whole file, and
  // this database is shared between two processes: the daemon claims
  // slots and saves sessions while `stratus schedules cancel` deletes a
  // row from another connection. Without a busy timeout the loser of that
  // lock throws `database is locked` immediately — a cancel that silently
  // failed would leave the schedule (and its destination grant) live.
  // Wait for the writer instead.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(schema);
  tightenSqliteFile(filePath);
  return db;
};

export class SqliteScheduleStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string, options: SqliteScheduleStoreOptions = {}) {
    this.db = openFleetDatabase(filePath, options, `
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        next_fire_at TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
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
    /** An event firing's batch key: a repeat continues its turn rather than starting a second. */
    idempotencyKey?: string;
  }): Promise<unknown>;
  /**
   * Event triggers (card 590): the store their firings wait in, and the
   * sources the operator configured. Without it, an `event` cadence is
   * refused at creation: a trigger nothing can deliver to never fires.
   */
  events?: SchedulerEventOptions;
  /** The clock, for tests. Default `new Date()`. */
  now?(): Date;
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
  /**
   * Run before every scan of due schedules. A rejection stops the
   * scheduler for good, before any slot is claimed: the gateway passes the
   * state-stamp check here, so a newer build stamping the home under a
   * live daemon stops its firings as well as its turns — a claimed slot is
   * a write into state this build no longer understands, and a one-shot
   * whose firing was refused afterwards would be retired unfired.
   *
   * May be synchronous, and the gateway's is: `start()` runs between the
   * control API announcing its address and the daemon marking itself
   * serving, and I/O there is a window in which a restart is refused as
   * "still starting".
   */
  ready?(): void | Promise<void>;
  /**
   * Whether the gateway's intake is paused. While it is, a due recurring
   * firing is skipped to its next slot (a paused agent catching up on hours
   * of missed firings the moment it resumes is the opposite of paused), and
   * a due one-shot waits: it has no next slot, so skipping it would drop it.
   * Consulted on every scan.
   */
  paused?(): boolean;
  log(line: string): void;
  warn(line: string): void;
}

export interface SchedulerEventOptions {
  store: Pick<SqliteEventStore, 'open' | 'claim' | 'hold' | 'finish' | 'retire' | 'turnsFiredSince'>;
  /** The configured source ids, read at each creation. */
  sources(): readonly string[];
  /**
   * Event firings per agent at once, apart from timed schedules' cap: a
   * Codex review must not wait behind a long work-loop firing, which is the
   * polling this replaces. A firing over it waits, it is not dropped.
   * Default 1.
   */
  maxConcurrentPerAgent?: number;
}

/** A held event firing older than this expires, so a long pause never ends in a burst. */
const EVENT_HOLD_MAX_MS = 24 * 60 * 60 * 1_000;

/** Held firings kept per coalescing key; older ones are superseded. */
const EVENT_HELD_PER_KEY = 5;

export interface SchedulerRuntime {
  /** The handle the `schedule.*` tools close over. */
  handle: SchedulerHandle;
  /** The event triggers on a source, for the intake's rule filter. */
  eventTriggers(sourceId: string): EventTrigger[];
  /**
   * Run the hold-or-fire step for waiting event firings now, rather than at
   * the next tick: the intake calls it after a delivery matched.
   */
  kickEvents(): void;
  /**
   * The destination carve-out, shaped for the permission policy's
   * `destinations` option: true exactly when this session is a firing of a
   * schedule that still exists, belongs to this session's agent, and was
   * approved with this destination. Consulted per call — a cancelled
   * schedule gates the very next send.
   */
  isPreauthorized(session: Session, destination: string): boolean;
  /**
   * The thread a live firing's send to its own schedule's destination goes
   * under when the call names none: the thread the schedule was set to
   * report into. Bound exactly as `isPreauthorized` is — a live firing, its
   * agent's schedule, the same conversation — so metadata alone never
   * steers a send.
   */
  reportThreadFor(session: Session, destination: ScheduleDestination): string | undefined;
  /**
   * Where a live firing's approval may be asked when its channel has no
   * approval channel of its own: the destination its schedule was approved
   * with, thread included (card 218). Bound exactly as `isPreauthorized`
   * is, so metadata alone never steers a prompt into a conversation.
   */
  approvalDestinationFor(session: Session): ScheduleDestination | undefined;
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
  /**
   * Retire a spent one-shot whose firing has just finished in THIS process
   * without having been started by it — a firing parked on a human when
   * the last daemon died and recovered by this one. The retirement that
   * normally follows a firing rides on the firing's own promise, which
   * died with that process; without this, the row stayed listed as a
   * schedule until the next restart's sweep. A row that still has a slot,
   * or is not a one-shot, is left alone — and so is one whose last firing
   * was not `sessionId`: the schedule id comes from session metadata, which
   * a row written before the public door refused the daemon's own keys
   * could carry from a caller, and a firing may retire only its own row.
   */
  retireSpentOneShot(scheduleId: string, sessionId: string): void;
}

export const createSchedulerRuntime = (options: SchedulerRuntimeOptions): SchedulerRuntime => {
  const { store, dispatch, validateDestination, sessionStatus, hasAgent, log, warn, events } = options;
  const clock = options.now ?? (() => new Date());
  const maxEventsPerAgent = events?.maxConcurrentPerAgent ?? 1;
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

  /**
   * An event trigger: no slot, so the due scan never sees it; it fires when
   * a delivery matches. Refused for a source the operator hasn't configured,
   * now, while the person approving it can hear why.
   */
  const createTrigger = async (input: ScheduleCreateInput): Promise<ScheduleRecord> => {
    if (input.cadence.kind !== 'event') {
      throw new Error('createTrigger takes an event cadence.');
    }
    if (!events) {
      throw new Error('This daemon takes no events: its config has no "events" sources, so a trigger could never fire. The operator adds a source first.');
    }
    const configured = events.sources();
    if (!configured.includes(input.cadence.source)) {
      throw new Error(
        `No event source "${input.cadence.source}" is configured on this daemon. `
        + (configured.length > 0 ? `Configured: ${configured.join(', ')}.` : 'None is.'),
      );
    }
    if (input.destination) {
      await validateDestination(input.agentId, input.destination);
    }
    const record: ScheduleRecord = {
      id: randomUUID(),
      agentId: input.agentId,
      cadence: input.cadence,
      prompt: input.prompt,
      ...(input.destination ? { destination: input.destination } : {}),
      createdAt: clock().toISOString(),
      ...(input.createdBy ? { createdBy: input.createdBy } : {}),
      ...(input.trust ? { trust: input.trust } : {}),
    };
    store.insert(record);
    log(`event trigger ${record.id} created for ${record.agentId} on source ${input.cadence.source}${record.destination ? `, reports to ${canonicalDestination(record.destination)}` : ''}`);
    return record;
  };

  const handle: SchedulerHandle = {
    async create(input) {
      if (!hasAgent(input.agentId)) {
        throw new Error(`Agent not found: ${input.agentId}`);
      }
      if (input.cadence.kind === 'event') {
        return createTrigger(input);
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
        ...(input.trust ? { trust: input.trust } : {}),
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
        expireTriggerFirings(scheduleId);
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

    if (options.paused?.() === true) {
      const pausedKey = `${record.id}:${slot}:paused`;
      if (following) {
        log(`schedule ${record.id}: intake is paused; skipping the firing at ${slot} to ${following.toISOString()}`);
        store.claimSlot(withNextFire(record, following), slot);
        deferralsWarned.delete(pausedKey);
        return;
      }
      if (!deferralsWarned.has(pausedKey)) {
        deferralsWarned.add(pausedKey);
        log(`schedule ${record.id}: intake is paused; this one-time firing (slot ${slot}) waits until it resumes`);
      }
      return;
    }
    deferralsWarned.delete(`${record.id}:${slot}:paused`);

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
        // The firing's "sender" is the session that wrote the prompt, at
        // the label it had then; a schedule set before labels existed is
        // `unknown`, like every other record from before.
        [SENDER_TRUST_METADATA_KEY]: record.trust ?? 'unknown',
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

  // ---- event triggers (card 590) ------------------------------------------

  /** Batches this process dispatched and has not seen settle. Empty after a restart, which is what makes a claimed batch recoverable. */
  const inflightBatches = new Set<string>();
  const runningEventsPerAgent = new Map<string, number>();
  /** Groups whose deferral under the per-agent slot was already logged. */
  const eventDeferralsWarned = new Set<string>();

  /** A trigger's waiting firings never go out once it is cancelled. */
  const expireTriggerFirings = (triggerId: string): void => {
    if (!events) {
      return;
    }
    const ids = events.store.open()
      .filter((row) => row.triggerId === triggerId && !(row.batchKey !== undefined && inflightBatches.has(row.batchKey)))
      .map((row) => row.id);
    if (ids.length > 0) {
      events.store.retire(ids, 'expired', 'Its trigger was cancelled.', clock().toISOString());
    }
  };

  const fireEventBatch = (record: ScheduleRecord, rows: EventFiringRow[], batchKey: string): void => {
    const sessionId = rows[0]!.sessionId;
    const ids = rows.map((row) => row.id);
    inflightBatches.add(batchKey);
    runningEventsPerAgent.set(record.agentId, (runningEventsPerAgent.get(record.agentId) ?? 0) + 1);
    activeFirings.add(sessionId);
    const firing = dispatch({
      sessionId,
      agentId: record.agentId,
      // The trigger's prompt, then each event in the order it arrived.
      userMessage: [record.prompt, ...rows.map((row) => row.block ?? '')].join('\n\n'),
      idempotencyKey: batchKey,
      metadata: {
        [SCHEDULED_TURN_METADATA_KEY]: true,
        [SCHEDULE_ID_METADATA_KEY]: record.id,
        // The event text came from outside: a valid signature proves who
        // delivered it, not who wrote it (anyone can comment on a PR). So
        // the turn runs at `external`, under the gate that applies after
        // reading a web page, whatever the trigger's creator was trusted at.
        [SENDER_TRUST_METADATA_KEY]: 'external',
      },
    }).then(
      () => {
        events?.store.finish(ids, { status: 'fired' }, clock().toISOString());
        log(`event trigger ${record.id} fired — session ${sessionId} completed (${ids.length} event${ids.length === 1 ? '' : 's'})`);
      },
      (error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        events?.store.finish(ids, { status: 'failed', reason }, clock().toISOString());
        warn(`event trigger ${record.id} firing failed: ${reason}`);
      },
    ).finally(() => {
      activeFirings.delete(sessionId);
      inflightBatches.delete(batchKey);
      const count = (runningEventsPerAgent.get(record.agentId) ?? 1) - 1;
      if (count > 0) {
        runningEventsPerAgent.set(record.agentId, count);
      } else {
        runningEventsPerAgent.delete(record.agentId);
      }
    });
    inflight.add(firing);
    void firing.finally(() => inflight.delete(firing));
  };

  /**
   * The hold-or-fire step, for every waiting event firing: a fresh match, a
   * hold whose window opened, and at startup whatever a crash left. One
   * path, so a recovered firing still waits out quiet hours and counts
   * against its trigger's hour like any other.
   */
  const processEvents = (now: Date): void => {
    if (!events || stopped) {
      return;
    }
    const nowIso = now.toISOString();
    const triggers = new Map<string, ScheduleRecord | undefined>();
    const triggerFor = (id: string): ScheduleRecord | undefined => {
      if (!triggers.has(id)) {
        const record = store.get(id);
        triggers.set(id, record?.cadence.kind === 'event' ? record : undefined);
      }
      return triggers.get(id);
    };

    // A claimed batch stays itself; free firings group by trigger and key.
    // Map order is first appearance in `open()`, oldest first.
    const groups = new Map<string, EventFiringRow[]>();
    for (const row of events.store.open()) {
      if (row.batchKey !== undefined && inflightBatches.has(row.batchKey)) {
        continue;
      }
      const trigger = triggerFor(row.triggerId);
      if (!trigger || trigger.agentId !== row.agentId) {
        events.store.retire([row.id], 'expired', 'Its trigger was cancelled.', nowIso);
        continue;
      }
      if (now.getTime() - Date.parse(row.createdAt) > EVENT_HOLD_MAX_MS) {
        events.store.retire([row.id], 'expired', 'Held for more than 24 hours.', nowIso);
        continue;
      }
      const key = row.batchKey !== undefined ? `batch\n${row.batchKey}` : `key\n${row.triggerId}\n${row.coalescingKey}`;
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }

    const holdAs = (rows: EventFiringRow[], status: 'held' | 'rate_limited'): void => {
      const ids = rows.filter((row) => row.status !== status).map((row) => row.id);
      if (ids.length > 0) {
        events.store.hold(ids, status, nowIso);
      }
    };

    for (const [groupKey, all] of groups) {
      const trigger = triggerFor(all[0]!.triggerId)!;
      if (trigger.cadence.kind !== 'event') {
        continue;
      }
      let rows = all;
      const batched = rows[0]!.batchKey !== undefined;
      if (!batched && rows.length > EVENT_HELD_PER_KEY) {
        const dropped = rows.slice(0, rows.length - EVENT_HELD_PER_KEY);
        events.store.retire(dropped.map((row) => row.id), 'superseded', `Over ${EVENT_HELD_PER_KEY} waiting for one subject; newer ones were kept.`, nowIso);
        rows = rows.slice(-EVENT_HELD_PER_KEY);
      }
      const { quietHours } = trigger.cadence;
      if (options.paused?.() === true || (quietHours !== undefined && isWithinQuietHours(quietHours, now))) {
        holdAs(rows, 'held');
        continue;
      }
      const running = runningEventsPerAgent.get(trigger.agentId) ?? 0;
      if (running >= maxEventsPerAgent) {
        if (!eventDeferralsWarned.has(groupKey)) {
          eventDeferralsWarned.add(groupKey);
          log(`event trigger ${trigger.id}: ${trigger.agentId} already has ${running} event firing(s) running; this one waits`);
        }
        continue;
      }
      eventDeferralsWarned.delete(groupKey);
      const maxPerHour = trigger.cadence.maxPerHour ?? DEFAULT_EVENT_MAX_PER_HOUR;
      if (events.store.turnsFiredSince(trigger.id, new Date(now.getTime() - 3_600_000).toISOString()) >= maxPerHour) {
        if (!batched && rows.length > 1) {
          events.store.retire(rows.slice(0, -1).map((row) => row.id), 'superseded', 'A newer event for the same subject replaced it while over the hourly limit.', nowIso);
          rows = rows.slice(-1);
        }
        holdAs(rows, 'rate_limited');
        continue;
      }
      const batchKey = rows[0]!.batchKey ?? rows[rows.length - 1]!.dispatchKey;
      if (!events.store.claim(rows.map((row) => row.id), batchKey, nowIso)) {
        continue;
      }
      fireEventBatch(trigger, rows, batchKey);
    }
  };

  /**
   * `propagateReadiness` is the startup tick's: a readiness failure there
   * has a caller to reach — `start()`, whose rejection is the gateway's
   * refusal to serve — where the timer-driven ticks have only the log.
   */
  const tick = async (propagateReadiness = false): Promise<void> => {
    if (stopped) {
      return;
    }
    if (options.ready) {
      try {
        await options.ready();
      } catch (error) {
        stopped = true;
        if (propagateReadiness) {
          throw error;
        }
        warn(`scheduler stopped before claiming any firing: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    try {
      const now = clock();
      for (const record of store.due(now.toISOString())) {
        if (stopped) {
          break;
        }
        fireOrSkip(record, now);
      }
      processEvents(now);
    } catch (error) {
      warn(`scheduler tick failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!stopped) {
      // Deliberately NOT unref'd, for the approval timer's reason: a
      // stored schedule is real outstanding work — the daemon owes its
      // next firing — and this timer is the only thing that will ever
      // start it. Shutdown belongs to stop(), which clears it.
      timer = setTimeout(() => {
        void tick();
      }, tickMs);
    }
  };

  return {
    handle,
    eventTriggers(sourceId) {
      return store.list()
        .filter((record) => record.cadence.kind === 'event' && record.cadence.source === sourceId)
        .map((record) => ({
          triggerId: record.id,
          agentId: record.agentId,
          source: sourceId,
          filter: (record.cadence as Extract<ScheduleRecord['cadence'], { kind: 'event' }>).filter,
        }));
    },
    kickEvents() {
      try {
        processEvents(clock());
      } catch (error) {
        warn(`event triggers: processing failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
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
    reportThreadFor(session, destination) {
      if (!activeFirings.has(session.id)) {
        return undefined;
      }
      const scheduleId = session.metadata?.[SCHEDULE_ID_METADATA_KEY];
      if (typeof scheduleId !== 'string') {
        return undefined;
      }
      const record = store.get(scheduleId);
      if (record === undefined || record.agentId !== session.agent.id || record.destination === undefined) {
        return undefined;
      }
      return canonicalDestination(record.destination) === canonicalDestination(destination)
        ? record.destination.thread
        : undefined;
    },
    approvalDestinationFor(session) {
      if (!activeFirings.has(session.id)) {
        return undefined;
      }
      const scheduleId = session.metadata?.[SCHEDULE_ID_METADATA_KEY];
      if (typeof scheduleId !== 'string') {
        return undefined;
      }
      const record = store.get(scheduleId);
      if (record === undefined || record.agentId !== session.agent.id || record.destination === undefined) {
        return undefined;
      }
      const { channel, to, thread } = record.destination;
      return { channel, to, ...(thread !== undefined ? { thread } : {}) };
    },
    list() {
      return store.list();
    },
    cancel(scheduleId) {
      const deleted = store.delete(scheduleId);
      if (deleted) {
        log(`schedule ${scheduleId} cancelled`);
        expireTriggerFirings(scheduleId);
      }
      return deleted;
    },
    async start() {
      // Propagated, not swallowed, at start: the sweep below deletes rows,
      // and a daemon whose home a newer build has stamped must not start
      // serving at all — the tick's swallow-and-stop is for a stamp that
      // advances under a scheduler already running.
      if (options.ready) {
        await options.ready();
      }
      // Spent one-shots first: a row with no next slot is only the
      // approval scope of a firing that may still be parked on a human.
      // Turn over — or turn gone — means the row's work is done.
      for (const record of store.list()) {
        if (record.nextFireAt || record.cadence.kind !== 'at') {
          continue;
        }
        const status = record.lastSessionId ? await sessionStatus(record.lastSessionId) : undefined;
        if (status === 'pending_approval') {
          continue;
        }
        // Once more after the status lookup awaited: the stamp can advance
        // while it does, and this delete is a write into the schedules
        // table — a newer build's row, gone before anything noticed.
        if (options.ready) {
          await options.ready();
        }
        store.delete(record.id);
        log(`schedule ${record.id}: one-shot already fired; removing`);
      }
      // The first tick's readiness check propagates too: the stamp can
      // advance between the check above and here, and a `start()` that
      // resolved after noticing would let the gateway's sweeps run.
      await tick(true);
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
    retireSpentOneShot(scheduleId, sessionId) {
      const record = store.get(scheduleId);
      if (!record || record.cadence.kind !== 'at' || record.nextFireAt || record.lastSessionId !== sessionId) {
        return;
      }
      store.delete(record.id);
      log(`schedule ${record.id}: one-shot's recovered firing finished; removing`);
    },
  };
};
