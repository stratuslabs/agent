import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { MAX_IDEMPOTENCY_KEY_LENGTH } from '@stratusagent/core';
import type { InboundEvent } from '@stratusagent/agents';

import { openFleetDatabase, SCHEDULE_SESSION_ID_PREFIX, type SqliteScheduleStoreOptions } from './schedules.ts';

// Event triggers' durable half (card 590, agent-plans
// roadmap/590-event-triggers.md): deliveries, dedup tombstones and firings,
// in fleet.db next to the schedules a trigger is. The listener decides what a
// request is and which triggers it matches; the dispatch side decides when a
// firing goes out. This file owns only what must survive a crash between
// those steps, and the keys that make a firing run at most once.

/** Accepted ids are remembered this long: longer than GitHub's 3-day manual redelivery. */
export const EVENT_DEDUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

/** Delivery rows listed at most: the newest this many, within the dedup window. */
export const EVENT_DELIVERY_ROW_CAP = 10_000;

/** A firing's rendered event block, and so the event text a turn sees, is at most this many bytes. */
export const EVENT_BLOCK_MAX_BYTES = 16 * 1_024;

/** What happened to one request that had a good signature. */
export type EventDeliveryStatus = 'refused' | 'duplicate' | 'unmatched' | 'matched';

/**
 * Where one trigger's firing for one delivery stands. `pending`, `held`,
 * `rate_limited` and `firing` are open and keep their event block; the rest
 * are finished and keep none.
 */
export type EventFiringStatus =
  | 'pending'
  | 'held'
  | 'rate_limited'
  | 'firing'
  | 'fired'
  | 'failed'
  | 'superseded'
  | 'expired';

export interface EventDeliveryRow {
  seq: number;
  source: string;
  eventId: string;
  type: string;
  subject?: string;
  status: EventDeliveryStatus;
  reason?: string;
  receivedAt: string;
}

export interface EventFiringRow {
  id: string;
  deliverySeq: number;
  triggerId: string;
  agentId: string;
  source: string;
  eventId: string;
  coalescingKey: string;
  sessionId: string;
  /** This firing's own idempotency key: `eventDispatchKey` of its trigger, source and event. */
  dispatchKey: string;
  /**
   * The key the batch this firing was claimed in goes out under. Set by the
   * claim and never changed after: a claimed batch is fixed, so a recovered
   * one can't come back under another key and start a second turn.
   */
  batchKey?: string;
  status: EventFiringStatus;
  /** When its batch was first claimed to go out: what the hourly limit counts from. */
  startedAt?: string;
  /** The rendered event block, kept only while the firing is open. */
  block?: string;
  reason?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * What one source has been doing, from the rows (`SqliteEventStore.activity`).
 * Requests refused before they could leave a row (bad signature, too large,
 * over the rate) aren't here: only the running listener counts those.
 */
export interface EventSourceActivity {
  /** The newest delivery row, whatever its status. */
  lastDelivery?: { at: string; type: string; subject?: string; status: EventDeliveryStatus };
  /** The newest signed delivery whose body was refused, and why. */
  lastRefused?: { at: string; reason: string };
  /** Delivery rows received since the cutoff, by status. Of the rows still kept (the newest 10,000). */
  deliveries: Partial<Record<EventDeliveryStatus, number>>;
  /**
   * Firings by status: finished ones that reached it since the cutoff, and
   * every open one however old, since it is waiting now.
   */
  firings: Partial<Record<EventFiringStatus, number>>;
}

/** One trigger's match on a delivery, as the listener hands it to `accept`. */
export interface NewEventFiring {
  triggerId: string;
  agentId: string;
  coalescingKey: string;
  sessionId: string;
  dispatchKey: string;
  block: string;
}

export interface AcceptedEventDelivery {
  source: string;
  eventId: string;
  type: string;
  subject?: string;
  receivedAt: string;
  /** Empty when no trigger matched. */
  firings: NewEventFiring[];
}

export interface RefusedEventDelivery {
  source: string;
  eventId: string;
  type?: string;
  subject?: string;
  reason: string;
  receivedAt: string;
}

const OPEN_STATUSES = ['pending', 'held', 'rate_limited', 'firing'] as const;
const OPEN_SQL = OPEN_STATUSES.map((status) => `'${status}'`).join(', ');

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * What sessions, holds and rate limits group by: source + subject when the
 * event has one, so every Codex round on one PR is one conversation, and
 * source + id when it doesn't, so subjectless events never share a bucket.
 * JSON, so no subject can be spelled to collide with an id key.
 */
export const eventCoalescingKey = (sourceId: string, event: Pick<InboundEvent, 'attributes'>): string => {
  const subject = event.attributes.subject;
  return subject !== undefined && subject.length > 0
    ? JSON.stringify([sourceId, 'subject', subject])
    : JSON.stringify([sourceId, 'id', event.attributes.id ?? '']);
};

/**
 * A trigger's session for one coalescing key. In the reserved `schedule:`
 * namespace, which the gateway refuses to dispatch into from outside, so the
 * only turns on it are the trigger's own firings.
 */
export const eventSessionId = (triggerId: string, coalescingKey: string): string =>
  `${SCHEDULE_SESSION_ID_PREFIX}${triggerId}:event-${sha256(coalescingKey).slice(0, 32)}`;

/**
 * The gateway idempotency key for one trigger's firing on one event: a
 * repeat never starts a second turn, and a turn whose process died continues
 * once. Hashed when over the gateway's bound, as channel-slack does, because
 * a sender picks the event id's length.
 */
export const eventDispatchKey = (triggerId: string, sourceId: string, eventId: string): string => {
  const key = `event:${triggerId}:${sourceId}:${eventId}`;
  return key.length <= MAX_IDEMPOTENCY_KEY_LENGTH ? key : `event-sha256:${sha256(key)}`;
};

const ATTRIBUTE_ORDER = ['id', 'source', 'type', 'subject', 'time'];

/** The longest prefix of `text` that fits in `bytes` of UTF-8, never splitting a character. */
const utf8Prefix = (text: string, bytes: number): string => {
  const { read } = new TextEncoder().encodeInto(text, new Uint8Array(Math.max(0, bytes)));
  return text.slice(0, read);
};

/**
 * What a firing's turn sees after the trigger's prompt. Rendered when the
 * delivery is matched and stored with the firing, so a firing that goes out
 * hours later needs neither the request body nor a second match. Attributes
 * and data are JSON, so a newline in a sender's subject or comment can't pass
 * for a line of the block. Capped at `EVENT_BLOCK_MAX_BYTES` with a note: the
 * agent fetches the rest with its own tools (`gh` for a PR).
 */
export const renderEventBlock = (sourceId: string, event: InboundEvent): string => {
  const attributes: Record<string, string> = {};
  for (const name of ATTRIBUTE_ORDER) {
    const value = event.attributes[name];
    if (value !== undefined) {
      attributes[name] = value;
    }
  }
  for (const name of Object.keys(event.attributes).sort()) {
    if (name !== 'specversion' && !ATTRIBUTE_ORDER.includes(name)) {
      attributes[name] = event.attributes[name]!;
    }
  }
  const full = [
    `Event from source "${sourceId}":`,
    JSON.stringify(attributes),
    'data:',
    ...(event.data !== undefined ? [JSON.stringify(event.data)] : []),
  ].join('\n');
  const size = Buffer.byteLength(full);
  if (size <= EVENT_BLOCK_MAX_BYTES) {
    return full;
  }
  const note = `\n[cut at ${Math.round(EVENT_BLOCK_MAX_BYTES / 1_024)} KB of ${Math.round(size / 1_024)} KB; fetch the rest with your own tools]`;
  return utf8Prefix(full, EVENT_BLOCK_MAX_BYTES - Buffer.byteLength(note)) + note;
};

interface DeliveryRowRaw {
  seq: number;
  source: string;
  event_id: string;
  type: string;
  subject: string;
  status: EventDeliveryStatus;
  reason: string;
  received_at: string;
}

interface FiringRowRaw {
  id: string;
  delivery_seq: number;
  trigger_id: string;
  agent_id: string;
  source: string;
  event_id: string;
  coalescing_key: string;
  session_id: string;
  dispatch_key: string;
  batch_key: string;
  status: EventFiringStatus;
  started_at: string;
  block: string | null;
  reason: string;
  created_at: string;
  updated_at: string;
}

const deliveryFrom = (row: DeliveryRowRaw): EventDeliveryRow => ({
  seq: row.seq,
  source: row.source,
  eventId: row.event_id,
  type: row.type,
  ...(row.subject !== '' ? { subject: row.subject } : {}),
  status: row.status,
  ...(row.reason !== '' ? { reason: row.reason } : {}),
  receivedAt: row.received_at,
});

const firingFrom = (row: FiringRowRaw): EventFiringRow => ({
  id: row.id,
  deliverySeq: row.delivery_seq,
  triggerId: row.trigger_id,
  agentId: row.agent_id,
  source: row.source,
  eventId: row.event_id,
  coalescingKey: row.coalescing_key,
  sessionId: row.session_id,
  dispatchKey: row.dispatch_key,
  ...(row.batch_key !== '' ? { batchKey: row.batch_key } : {}),
  status: row.status,
  ...(row.started_at !== '' ? { startedAt: row.started_at } : {}),
  ...(row.block !== null ? { block: row.block } : {}),
  ...(row.reason !== '' ? { reason: row.reason } : {}),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const minus = (iso: string, ms: number): string => new Date(Date.parse(iso) - ms).toISOString();

/**
 * Deliveries, dedup tombstones and firings, durable in `fleet.db`. Its own
 * connection, like the schedule store's, because the CLI will read it
 * without a daemon (`stratus events`).
 *
 * Every method that changes more than one row does it in one transaction,
 * and every one that moves a firing between statuses is all-or-nothing and
 * conditional on the statuses it expects: a delivery and its firings are
 * committed together before the sender hears 2xx, a batch is claimed whole
 * before its dispatch, and a refused transition changes nothing.
 */
export class SqliteEventStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string, options: SqliteScheduleStoreOptions = {}) {
    this.db = openFleetDatabase(filePath, options, `
      CREATE TABLE IF NOT EXISTS event_deliveries (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        event_id TEXT NOT NULL,
        type TEXT NOT NULL,
        subject TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        received_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS event_deliveries_received ON event_deliveries (received_at);
      CREATE TABLE IF NOT EXISTS event_seen (
        source TEXT NOT NULL,
        id_hash TEXT NOT NULL,
        seen_at TEXT NOT NULL,
        PRIMARY KEY (source, id_hash)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS event_firings (
        id TEXT PRIMARY KEY,
        delivery_seq INTEGER NOT NULL,
        trigger_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        source TEXT NOT NULL,
        event_id TEXT NOT NULL,
        coalescing_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        dispatch_key TEXT NOT NULL,
        batch_key TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT '',
        block TEXT,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS event_firings_status ON event_firings (status, created_at);
      CREATE INDEX IF NOT EXISTS event_firings_trigger ON event_firings (trigger_id, status, updated_at);
      CREATE INDEX IF NOT EXISTS event_firings_batch ON event_firings (batch_key);
    `);
    // A table made before `started_at` existed (an unreleased build of
    // this feature) gains it; rows claimed then count from their update.
    const columns = this.db.prepare('PRAGMA table_info(event_firings)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'started_at')) {
      this.db.exec("ALTER TABLE event_firings ADD COLUMN started_at TEXT NOT NULL DEFAULT ''");
    }
  }

  private transaction<T>(work: () => T): T {
    // IMMEDIATE takes the write lock up front, so the dedup check and the
    // insert it guards can't interleave with another writer's.
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

  private insertDelivery(
    delivery: { source: string; eventId: string; type?: string; subject?: string; receivedAt: string },
    status: EventDeliveryStatus,
    reason = '',
  ): number {
    const result = this.db
      .prepare('INSERT INTO event_deliveries (source, event_id, type, subject, status, reason, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(delivery.source, delivery.eventId, delivery.type ?? '', delivery.subject ?? '', status, reason, delivery.receivedAt);
    return Number(result.lastInsertRowid);
  }

  /**
   * Record a delivery whose signature checked out and whose body parsed:
   * `duplicate` when its (source, id) was accepted within the dedup window,
   * else `matched` with one `pending` firing per match, or `unmatched`. One
   * write, made before the sender hears 2xx. Accepted deliveries leave a
   * tombstone that outlives the row cap, so dedup never depends on it.
   */
  accept(delivery: AcceptedEventDelivery): { status: Exclude<EventDeliveryStatus, 'refused'>; seq: number; firings: EventFiringRow[] } {
    return this.transaction(() => {
      // Insert, or revive a tombstone older than the window; zero changes
      // means a live tombstone, so the id was seen.
      const fresh = this.db
        .prepare(`
          INSERT INTO event_seen (source, id_hash, seen_at) VALUES (?, ?, ?)
          ON CONFLICT (source, id_hash) DO UPDATE SET seen_at = excluded.seen_at WHERE seen_at < ?
        `)
        .run(delivery.source, sha256(delivery.eventId), delivery.receivedAt, minus(delivery.receivedAt, EVENT_DEDUP_WINDOW_MS))
        .changes > 0;
      if (!fresh) {
        return { status: 'duplicate' as const, seq: this.insertDelivery(delivery, 'duplicate'), firings: [] };
      }
      const status = delivery.firings.length > 0 ? 'matched' as const : 'unmatched' as const;
      const seq = this.insertDelivery(delivery, status);
      const insert = this.db.prepare(`
        INSERT INTO event_firings (id, delivery_seq, trigger_id, agent_id, source, event_id, coalescing_key,
          session_id, dispatch_key, batch_key, status, block, reason, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'pending', ?, '', ?, ?)
      `);
      const firings = delivery.firings.map((firing): EventFiringRow => {
        const id = randomUUID();
        insert.run(
          id, seq, firing.triggerId, firing.agentId, delivery.source, delivery.eventId, firing.coalescingKey,
          firing.sessionId, firing.dispatchKey, firing.block, delivery.receivedAt, delivery.receivedAt,
        );
        return {
          id,
          deliverySeq: seq,
          triggerId: firing.triggerId,
          agentId: firing.agentId,
          source: delivery.source,
          eventId: delivery.eventId,
          coalescingKey: firing.coalescingKey,
          sessionId: firing.sessionId,
          dispatchKey: firing.dispatchKey,
          status: 'pending',
          block: firing.block,
          createdAt: delivery.receivedAt,
          updatedAt: delivery.receivedAt,
        };
      });
      return { status, seq, firings };
    });
  }

  /**
   * Record a signed delivery the listener refused (a form-encoded body, a
   * malformed event). No tombstone: the sender can fix it and retry with the
   * same id. Unsigned requests never reach here; they leave no row at all.
   */
  refuse(delivery: RefusedEventDelivery): EventDeliveryRow {
    const seq = this.insertDelivery(delivery, 'refused', delivery.reason);
    return deliveryFrom(this.db.prepare('SELECT * FROM event_deliveries WHERE seq = ?').get(seq) as unknown as DeliveryRowRaw);
  }

  /** Delivery rows, newest first. */
  deliveries(options: { limit?: number; source?: string } = {}): EventDeliveryRow[] {
    const limit = options.limit ?? 100;
    const rows = (options.source !== undefined
      ? this.db.prepare('SELECT * FROM event_deliveries WHERE source = ? ORDER BY seq DESC LIMIT ?').all(options.source, limit)
      : this.db.prepare('SELECT * FROM event_deliveries ORDER BY seq DESC LIMIT ?').all(limit)) as unknown as DeliveryRowRaw[];
    return rows.map(deliveryFrom);
  }

  /**
   * Per source with any row: its last delivery, its last refused one, and
   * counts since `sinceIso` (`stratus events`, `/health`). Grouped in the
   * database, so the cost doesn't grow with the 7 days of rows kept.
   */
  activity(sinceIso: string): Record<string, EventSourceActivity> {
    const result: Record<string, EventSourceActivity> = {};
    const entry = (source: string): EventSourceActivity => (result[source] ??= { deliveries: {}, firings: {} });
    const latest = this.db.prepare(`
      SELECT d.* FROM event_deliveries d
      JOIN (SELECT source, MAX(seq) AS seq FROM event_deliveries GROUP BY source) newest ON newest.seq = d.seq
    `).all() as unknown as DeliveryRowRaw[];
    for (const row of latest) {
      entry(row.source).lastDelivery = {
        at: row.received_at,
        type: row.type,
        ...(row.subject !== '' ? { subject: row.subject } : {}),
        status: row.status,
      };
    }
    const refused = this.db.prepare(`
      SELECT d.* FROM event_deliveries d
      JOIN (SELECT source, MAX(seq) AS seq FROM event_deliveries WHERE status = 'refused' GROUP BY source) newest ON newest.seq = d.seq
    `).all() as unknown as DeliveryRowRaw[];
    for (const row of refused) {
      entry(row.source).lastRefused = { at: row.received_at, reason: row.reason };
    }
    const deliveries = this.db.prepare(`
      SELECT source, status, COUNT(*) AS n FROM event_deliveries WHERE received_at >= ? GROUP BY source, status
    `).all(sinceIso) as unknown as Array<{ source: string; status: EventDeliveryStatus; n: number }>;
    for (const row of deliveries) {
      entry(row.source).deliveries[row.status] = Number(row.n);
    }
    const firings = this.db.prepare(`
      SELECT source, status, COUNT(*) AS n FROM event_firings
      WHERE status IN (${OPEN_SQL}) OR updated_at >= ? GROUP BY source, status
    `).all(sinceIso) as unknown as Array<{ source: string; status: EventFiringStatus; n: number }>;
    for (const row of firings) {
      entry(row.source).firings[row.status] = Number(row.n);
    }
    return result;
  }

  firing(id: string): EventFiringRow | undefined {
    const row = this.db.prepare('SELECT * FROM event_firings WHERE id = ?').get(id) as unknown as FiringRowRaw | undefined;
    return row ? firingFrom(row) : undefined;
  }

  /**
   * Every open firing (`pending`, `held`, `rate_limited`, `firing`), oldest
   * first, with its block and batch key: what the startup sweep recovers and
   * what a hold releases. A `firing` row is a claim whose dispatch may or may
   * not have reached the gateway; its batch goes out again as stored, and the
   * idempotency key decides whether that starts or continues a turn.
   */
  open(): EventFiringRow[] {
    return (this.db
      .prepare(`SELECT * FROM event_firings WHERE status IN (${OPEN_SQL}) ORDER BY created_at ASC, delivery_seq ASC, rowid ASC`)
      .all() as unknown as FiringRowRaw[]).map(firingFrom);
  }

  /**
   * Run `update` on exactly `ids`, all or nothing: false, with nothing
   * changed, unless `precheck` (inside the same transaction) passes and
   * every row matched the update's own conditions.
   */
  private allOrNothing(ids: readonly string[], update: (id: string) => number, precheck = (): boolean => true): boolean {
    if (ids.length === 0 || new Set(ids).size !== ids.length) {
      return false;
    }
    try {
      return this.transaction(() => {
        if (!precheck()) {
          throw new RefusedTransition();
        }
        for (const id of ids) {
          if (update(id) === 0) {
            throw new RefusedTransition();
          }
        }
        return true;
      });
    } catch (error) {
      if (error instanceof RefusedTransition) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Claim firings to go out as one turn under `batchKey`, in one write
   * before the dispatch. Either every row is free and they become a new
   * batch, or `ids` is exactly an existing batch under exactly its key,
   * which is how recovery resends one. A batch is fixed once claimed: no
   * row joins it later, and it never changes key. False, with nothing
   * changed, for anything else, or if any row is finished.
   *
   * With `triggerId`, also false unless that schedule row still exists, in
   * the same transaction: `stratus schedules cancel` deletes from another
   * process, and a trigger cancelled after the scan read it must not fire,
   * as a timed schedule's conditional slot claim already guarantees.
   */
  claim(ids: readonly string[], batchKey: string, nowIso: string, options: { triggerId?: string } = {}): boolean {
    const members = this.db.prepare('SELECT id FROM event_firings WHERE batch_key = ?');
    const update = this.db.prepare(`
      UPDATE event_firings
      SET status = 'firing', batch_key = ?, updated_at = ?,
        started_at = CASE WHEN started_at = '' THEN ? ELSE started_at END
      WHERE id = ? AND status IN (${OPEN_SQL}) AND (batch_key = '' OR batch_key = ?)
    `);
    const wanted = new Set(ids);
    return this.allOrNothing(
      ids,
      (id) => Number(update.run(batchKey, nowIso, nowIso, id, batchKey).changes),
      () => {
        if (options.triggerId !== undefined
          && this.db.prepare('SELECT 1 FROM schedules WHERE id = ?').get(options.triggerId) === undefined) {
          return false;
        }
        const existing = (members.all(batchKey) as Array<{ id: string }>).map((row) => row.id);
        return existing.length === 0 || (existing.length === wanted.size && existing.every((id) => wanted.has(id)));
      },
    );
  }

  /**
   * Hold open firings for quiet hours or paused intake (`held`) or over the
   * trigger's hourly limit (`rate_limited`). The block and any batch key
   * stay, so a held batch still goes out only as itself.
   */
  hold(ids: readonly string[], status: 'held' | 'rate_limited', nowIso: string): boolean {
    const update = this.db.prepare(`UPDATE event_firings SET status = ?, updated_at = ? WHERE id = ? AND status IN (${OPEN_SQL})`);
    return this.allOrNothing(ids, (id) => Number(update.run(status, nowIso, id).changes));
  }

  /**
   * Finish claimed firings after their dispatch, clearing the block in the
   * same write: from here the payload lives only in the session it fired.
   * Only a `firing` row can finish, so nothing is marked fired that wasn't
   * claimed first.
   */
  finish(
    ids: readonly string[],
    outcome: { status: 'fired' } | { status: 'failed'; reason: string },
    nowIso: string,
  ): boolean {
    const reason = outcome.status === 'failed' ? outcome.reason : '';
    const update = this.db.prepare(`
      UPDATE event_firings SET status = ?, reason = ?, block = NULL, updated_at = ?
      WHERE id = ? AND status = 'firing'
    `);
    return this.allOrNothing(ids, (id) => Number(update.run(outcome.status, reason, nowIso, id).changes));
  }

  /**
   * Retire open firings that will never go out: `superseded` by newer ones
   * for the same key, or `expired` (held over 24 hours, or their trigger was
   * cancelled). Clears their blocks. Returns how many were retired; a
   * finished firing is left as it is.
   */
  retire(ids: readonly string[], status: 'superseded' | 'expired', reason: string, nowIso: string): number {
    const update = this.db.prepare(`
      UPDATE event_firings SET status = ?, reason = ?, block = NULL, updated_at = ?
      WHERE id = ? AND status IN (${OPEN_SQL})
    `);
    return this.transaction(() => ids.reduce((count, id) => count + Number(update.run(status, reason, nowIso, id).changes), 0));
  }

  /**
   * Turns a trigger has started since `sinceIso`, for its hourly limit,
   * counted from when each batch was first claimed (a two-hour turn doesn't
   * hold the hour for two more): a batch running now, one that finished,
   * and one that failed all count,
   * since each was a turn started unattended. A failing provider would
   * otherwise let every new event start another. A batch is one turn, so
   * this counts batch keys, not rows; `exceptBatchKey` leaves out a batch
   * being re-sent after a restart, which must not count against itself.
   */
  turnsStartedSince(triggerId: string, sinceIso: string, exceptBatchKey = ''): number {
    const row = this.db
      .prepare(`
        SELECT COUNT(DISTINCT batch_key) AS turns FROM event_firings
        WHERE trigger_id = ? AND status IN ('firing', 'fired', 'failed')
          AND (CASE WHEN started_at = '' THEN updated_at ELSE started_at END) >= ? AND batch_key != ?
      `)
      .get(triggerId, sinceIso, exceptBatchKey) as { turns: number };
    return row.turns;
  }

  /**
   * Drop what the dedup window and the row cap no longer cover: tombstones
   * and delivery rows past 7 days, delivery rows past the newest 10,000, and
   * finished firings past 7 days. An open firing is never pruned: it holds
   * the only copy of an event that hasn't gone out.
   */
  prune(nowIso: string): void {
    const cutoff = minus(nowIso, EVENT_DEDUP_WINDOW_MS);
    this.transaction(() => {
      this.db.prepare('DELETE FROM event_seen WHERE seen_at < ?').run(cutoff);
      this.db.prepare('DELETE FROM event_deliveries WHERE received_at < ?').run(cutoff);
      this.db
        .prepare('DELETE FROM event_deliveries WHERE seq <= (SELECT seq FROM event_deliveries ORDER BY seq DESC LIMIT 1 OFFSET ?)')
        .run(EVENT_DELIVERY_ROW_CAP);
      this.db.prepare(`DELETE FROM event_firings WHERE status NOT IN (${OPEN_SQL}) AND updated_at < ?`).run(cutoff);
    });
  }

  close(): void {
    this.db.close();
  }
}

/** Unwinds an all-or-nothing transition's transaction; never escapes the store. */
class RefusedTransition extends Error {
  constructor() {
    super('refused transition');
    this.name = 'RefusedTransition';
  }
}
