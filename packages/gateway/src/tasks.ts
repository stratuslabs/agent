import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { openFleetDatabase, type SqliteScheduleStoreOptions } from './schedules.ts';

// Background tasks' durable half (AGT-211, agent-plans
// roadmap/952-background-tasks.md): one row per task, in fleet.db next to
// the schedules and event firings, because a task, like a firing, is work
// the gateway owes someone later. The row records only who, where and what
// was asked (the start and any stop). What happened lives in the two
// transcripts, the worker session's and the origin session's, and `status`
// and `delivery` here are caches of those: settling re-derives them from the
// transcripts and writes them back, never the other way round.
//
// Created with CREATE TABLE IF NOT EXISTS and no schema stamp bump, like
// event_firings: a bumped stamp would make every older build refuse the home,
// which breaks rolling back.

/** Final rows already delivered or dropped are kept this long, then pruned. */
export const TASK_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * Where a task stands. `running` and `waiting_approval` are open and count
 * against the agent's cap; the rest are final.
 */
export type TaskStatus = 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

/**
 * Whether the outcome is in the origin session's transcript: `pending` until
 * it is, `delivered` once it is (not that a chat post landed), and `dropped`
 * when the origin session no longer exists, so nothing can be delivered.
 */
export type TaskDelivery = 'pending' | 'delivered' | 'dropped';

const OPEN_STATUSES: readonly TaskStatus[] = ['running', 'waiting_approval'];
const OPEN_SQL = OPEN_STATUSES.map((status) => `'${status}'`).join(', ');

export const isOpenTaskStatus = (status: TaskStatus): boolean => OPEN_STATUSES.includes(status);

export interface TaskRow {
  /** `t_` plus a ULID. */
  id: string;
  /** The agent that started it. */
  agentId: string;
  /** The agent doing the work; may be the same. */
  workerAgentId: string;
  /** The conversation the outcome goes back to. */
  originSessionId: string;
  workerSessionId: string;
  promptDigest: string;
  status: TaskStatus;
  /** Who asked for a stop. Written before anything is aborted. */
  stoppedBy?: string;
  delivery: TaskDelivery;
  createdAt: string;
  updatedAt: string;
  /** When it first reached a final status. */
  endedAt?: string;
}

/** What a claim writes. The caller mints the id first, because the worker session's name carries it. */
export interface NewTask {
  id: string;
  agentId: string;
  workerAgentId: string;
  originSessionId: string;
  workerSessionId: string;
  promptDigest: string;
}

export type TaskClaim =
  | { kind: 'started'; task: TaskRow }
  /** The same worker and prompt is still running from the same conversation. */
  | { kind: 'existing'; task: TaskRow }
  | { kind: 'full'; running: number; cap: number };

interface TaskRowRaw {
  id: string;
  agent_id: string;
  worker_agent_id: string;
  origin_session_id: string;
  worker_session_id: string;
  prompt_digest: string;
  status: TaskStatus;
  stopped_by: string;
  delivery: TaskDelivery;
  created_at: string;
  updated_at: string;
  ended_at: string;
}

const taskFrom = (row: TaskRowRaw): TaskRow => ({
  id: row.id,
  agentId: row.agent_id,
  workerAgentId: row.worker_agent_id,
  originSessionId: row.origin_session_id,
  workerSessionId: row.worker_session_id,
  promptDigest: row.prompt_digest,
  status: row.status,
  ...(row.stopped_by !== '' ? { stoppedBy: row.stopped_by } : {}),
  delivery: row.delivery,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.ended_at !== '' ? { endedAt: row.ended_at } : {}),
});

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const base32 = (value: bigint, length: number): string => {
  let out = '';
  let rest = value;
  for (let index = 0; index < length; index += 1) {
    out = CROCKFORD[Number(rest & 31n)] + out;
    rest >>= 5n;
  }
  return out;
};

/**
 * `t_` plus a ULID: 48 bits of milliseconds then 80 random bits, Crockford
 * base32, so ids sort by when they were made.
 */
export const newTaskId = (nowMs: number = Date.now()): string => {
  const random = BigInt(`0x${randomBytes(10).toString('hex')}`);
  return `t_${base32(BigInt(nowMs), 10)}${base32(random, 16)}`;
};

/**
 * What "the same job" means for a repeat: the worker and the prompt,
 * encoded as a pair so moving text across the boundary is a different job.
 * Only the digest is stored; the prompt itself lives in the worker session.
 */
export const taskPromptDigest = (workerAgentId: string, prompt: string): string =>
  createHash('sha256').update(JSON.stringify([workerAgentId, prompt])).digest('hex');

/**
 * Task rows, durable in `fleet.db`. Its own connection, like the schedule
 * and event stores, so the CLI can read it without a daemon.
 *
 * Every write is conditional on the state it expects, and the claim is one
 * transaction: turns in different conversations run at the same time, and
 * two of them must not both pass the cap.
 */
export class SqliteTaskStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string, options: SqliteScheduleStoreOptions = {}) {
    this.db = openFleetDatabase(filePath, options, `
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        worker_agent_id TEXT NOT NULL,
        origin_session_id TEXT NOT NULL,
        worker_session_id TEXT NOT NULL,
        prompt_digest TEXT NOT NULL,
        status TEXT NOT NULL,
        stopped_by TEXT NOT NULL DEFAULT '',
        delivery TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ended_at TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS tasks_agent_status ON tasks (agent_id, status);
      CREATE INDEX IF NOT EXISTS tasks_origin_digest ON tasks (origin_session_id, prompt_digest);
      CREATE INDEX IF NOT EXISTS tasks_settle ON tasks (status, delivery, created_at);
    `);
  }

  private transaction<T>(work: () => T): T {
    // IMMEDIATE takes the write lock up front, so the count and the insert
    // it guards can't interleave with another connection's claim.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Start a task, or don't, in one write before the worker starts:
   * `existing` when the same worker and prompt is still open from the same
   * conversation (a retried call or a repeated ask gets the running job,
   * even at the cap), `full` when the agent already has `cap` open tasks,
   * else `started` with the row written as running and undelivered.
   */
  claim(task: NewTask, cap: number, nowIso: string): TaskClaim {
    if (!Number.isInteger(cap) || cap < 1) {
      throw new Error(`A task cap must be a whole number of at least 1, not ${cap}.`);
    }
    return this.transaction((): TaskClaim => {
      const existing = this.db
        .prepare(`
          SELECT * FROM tasks
          WHERE agent_id = ? AND origin_session_id = ? AND prompt_digest = ? AND status IN (${OPEN_SQL})
          ORDER BY created_at ASC, rowid ASC LIMIT 1
        `)
        .get(task.agentId, task.originSessionId, task.promptDigest) as unknown as TaskRowRaw | undefined;
      if (existing !== undefined) {
        return { kind: 'existing', task: taskFrom(existing) };
      }
      const { running } = this.db
        .prepare(`SELECT COUNT(*) AS running FROM tasks WHERE agent_id = ? AND status IN (${OPEN_SQL})`)
        .get(task.agentId) as { running: number };
      if (running >= cap) {
        return { kind: 'full', running: Number(running), cap };
      }
      this.db
        .prepare(`
          INSERT INTO tasks (id, agent_id, worker_agent_id, origin_session_id, worker_session_id, prompt_digest,
            status, delivery, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'running', 'pending', ?, ?)
        `)
        .run(task.id, task.agentId, task.workerAgentId, task.originSessionId, task.workerSessionId, task.promptDigest, nowIso, nowIso);
      return {
        kind: 'started',
        task: { ...task, status: 'running', delivery: 'pending', createdAt: nowIso, updatedAt: nowIso },
      };
    });
  }

  get(id: string): TaskRow | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as TaskRowRaw | undefined;
    return row ? taskFrom(row) : undefined;
  }

  /**
   * Every row settling still owes something, oldest first: open ones, and
   * final ones whose outcome isn't in the origin transcript yet. What the
   * startup sweep settles.
   */
  unsettled(): TaskRow[] {
    return (this.db
      .prepare(`
        SELECT * FROM tasks WHERE status IN (${OPEN_SQL}) OR delivery = 'pending'
        ORDER BY created_at ASC, rowid ASC
      `)
      .all() as unknown as TaskRowRaw[]).map(taskFrom);
  }

  /**
   * One agent's tasks, for its own list: every one still open or still owed
   * a delivery, newest first, then up to `finished` of the rest, most
   * recently ended first. The first part is bounded by the agent's cap and
   * by settling; the second by `finished`, so the list stays short however
   * long the agent has run.
   */
  listForAgent(agentId: string, finished: number): TaskRow[] {
    const owed = this.db
      .prepare(`
        SELECT * FROM tasks WHERE agent_id = ? AND (status IN (${OPEN_SQL}) OR delivery = 'pending')
        ORDER BY created_at DESC, rowid DESC
      `)
      .all(agentId) as unknown as TaskRowRaw[];
    const done = this.db
      .prepare(`
        SELECT * FROM tasks WHERE agent_id = ? AND status NOT IN (${OPEN_SQL}) AND delivery != 'pending'
        ORDER BY CASE WHEN ended_at = '' THEN updated_at ELSE ended_at END DESC, rowid DESC
        LIMIT ?
      `)
      .all(agentId, Math.max(0, Math.floor(finished))) as unknown as TaskRowRaw[];
    return [...owed, ...done].map(taskFrom);
  }

  /**
   * The tasks one conversation started that are still open, oldest first:
   * what a person's Stop there reaches (AGT-357). Bounded by the agent's cap.
   */
  openForOrigin(originSessionId: string): TaskRow[] {
    return (this.db
      .prepare(`
        SELECT * FROM tasks WHERE origin_session_id = ? AND status IN (${OPEN_SQL})
        ORDER BY created_at ASC, rowid ASC
      `)
      .all(originSessionId) as unknown as TaskRowRaw[]).map(taskFrom);
  }

  /**
   * Write the status settling derived from the worker session. True when the
   * row changed. A final row may move to another final status (a restore can
   * show a worker the row called completed was cut off), but never back to
   * an open one: a task that ended stays ended. `ended_at` keeps the first
   * time it ended.
   */
  setStatus(id: string, status: TaskStatus, nowIso: string): boolean {
    const final = !isOpenTaskStatus(status);
    return Number(this.db
      .prepare(`
        UPDATE tasks
        SET status = ?, updated_at = ?,
          ended_at = CASE WHEN ? AND ended_at = '' THEN ? ELSE ended_at END
        WHERE id = ? AND status != ? AND (? OR status IN (${OPEN_SQL}))
      `)
      .run(status, nowIso, final ? 1 : 0, nowIso, id, status, final ? 1 : 0)
      .changes) > 0;
  }

  /**
   * Record who asked for a stop, before anything is aborted, so settling
   * reports `cancelled` whatever happens next. Only on an open row, and only
   * once: the first stopper is kept. False when nothing was written.
   */
  recordStop(id: string, stoppedBy: string, nowIso: string): boolean {
    return Number(this.db
      .prepare(`
        UPDATE tasks SET stopped_by = ?, updated_at = ?
        WHERE id = ? AND stopped_by = '' AND status IN (${OPEN_SQL})
      `)
      .run(stoppedBy, nowIso, id)
      .changes) > 0;
  }

  /**
   * Mark the outcome as in the origin transcript (`delivered`) or
   * undeliverable (`dropped`). Only from `pending`, and only once the status
   * is final, so nothing reads as delivered before the task ended.
   */
  setDelivery(id: string, delivery: Exclude<TaskDelivery, 'pending'>, nowIso: string): boolean {
    return Number(this.db
      .prepare(`
        UPDATE tasks SET delivery = ?, updated_at = ?
        WHERE id = ? AND delivery = 'pending' AND status NOT IN (${OPEN_SQL})
      `)
      .run(delivery, nowIso, id)
      .changes) > 0;
  }

  /**
   * Drop final rows already delivered or dropped and older than the
   * retention window, so the table and the agent's list stay bounded. A row
   * still open, or still owed a delivery, is never pruned.
   */
  prune(nowIso: string, retentionMs: number = TASK_RETENTION_MS): number {
    const cutoff = new Date(Date.parse(nowIso) - retentionMs).toISOString();
    return Number(this.db
      .prepare(`
        DELETE FROM tasks
        WHERE status NOT IN (${OPEN_SQL}) AND delivery IN ('delivered', 'dropped') AND updated_at < ?
      `)
      .run(cutoff)
      .changes);
  }

  close(): void {
    this.db.close();
  }
}
