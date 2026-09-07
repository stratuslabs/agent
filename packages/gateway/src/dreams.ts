import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  DEFAULT_MAX_DREAMS_PER_NIGHT,
  DREAM_TITLE_METADATA_KEY,
  DREAMING_TURN_METADATA_KEY,
  dreamNightOf,
  dreamPrompt,
  formatDreamWindow,
  type DreamFile,
} from '@stratusagent/agents';
import { SENDER_TRUST_METADATA_KEY, type JsonObject } from '@stratusagent/core';
import type { DreamerEntry } from '@stratusagent/state';

/**
 * What one agent did, or is doing, on one night.
 *
 * `started` is the load-bearing field and the reason this is durable at
 * all: it is incremented BEFORE a dream dispatches, so a daemon that dies
 * mid-dream restarts to a night that has already spent that dream. A dream
 * is unattended work with a cost, and re-running one because the process
 * died inside it is the failure worth engineering against — the same rule
 * the scheduler's `claimSlot` keeps, for the same reason.
 */
export interface DreamNightRecord {
  agentId: string;
  /** Local date the window opened on — see `dreamNightOf`. */
  night: string;
  /** Dreams this night has dispatched. Claimed before the dispatch. */
  started: number;
  /** How many of those have settled, either way. */
  finished: number;
  /** Their titles, in the order they were started. */
  titles: string[];
  /** The dream file the night was read from. */
  source: string;
  openedAt: string;
  updatedAt: string;
  /** The last dream failure of this night, for the operator's listing. */
  lastError?: string;
}

/**
 * One row per agent — the night in progress, or the last one there was.
 *
 * In the database sessions and schedules already share, through its own
 * connection for the schedule store's reason: `stratus dreams` reads it
 * from another process while the daemon writes it, and WAL is what makes
 * that routine. One row per agent rather than one per night: what a night
 * did is in the sessions it dispatched, and this table exists only to
 * answer "how far into tonight are we?" without replaying anything.
 */
export class SqliteDreamStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
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
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dream_nights (
        agent_id TEXT PRIMARY KEY,
        night TEXT NOT NULL,
        started INTEGER NOT NULL,
        body TEXT NOT NULL,
        updated_at TEXT NOT NULL
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

  get(agentId: string): DreamNightRecord | undefined {
    const row = this.db.prepare('SELECT body FROM dream_nights WHERE agent_id = ?').get(agentId) as
      | { body: string }
      | undefined;
    return row ? (JSON.parse(row.body) as DreamNightRecord) : undefined;
  }

  /** Every agent's night, most recently touched first — the operator's list. */
  list(): DreamNightRecord[] {
    const rows = this.db
      .prepare('SELECT body FROM dream_nights ORDER BY updated_at DESC')
      .all() as Array<{ body: string }>;
    return rows.map((row) => JSON.parse(row.body) as DreamNightRecord);
  }

  /**
   * Open a night, if it is not already open. False means another writer
   * opened this same night first and its row stands — the caller re-reads
   * rather than overwriting, because that row may already have spent a
   * dream this one would hand out again.
   */
  beginNight(record: DreamNightRecord): boolean {
    return this.db
      .prepare(`
        INSERT INTO dream_nights (agent_id, night, started, body, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET
          night = excluded.night,
          started = excluded.started,
          body = excluded.body,
          updated_at = excluded.updated_at
        WHERE dream_nights.night != excluded.night
      `)
      .run(record.agentId, record.night, record.started, JSON.stringify(record), record.updatedAt)
      .changes > 0;
  }

  /**
   * Spend one dream, atomically against the count the caller read. False
   * means the night moved under it — nothing is dispatched.
   */
  claimDream(record: DreamNightRecord, expectedStarted: number): boolean {
    return this.db
      .prepare(`
        UPDATE dream_nights SET started = ?, body = ?, updated_at = ?
        WHERE agent_id = ? AND night = ? AND started = ?
      `)
      .run(record.started, JSON.stringify(record), record.updatedAt, record.agentId, record.night, expectedStarted)
      .changes > 0;
  }

  /** Bookkeeping after a dream settles. Never moves `started`. */
  save(record: DreamNightRecord): void {
    this.db
      .prepare('UPDATE dream_nights SET body = ?, updated_at = ? WHERE agent_id = ? AND night = ?')
      .run(JSON.stringify(record), record.updatedAt, record.agentId, record.night);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * The session-id namespace dreams live in — `dream:<agent>:<night>:<n>`.
 *
 * Reserved exactly as the scheduler's is: no external dispatch may name
 * one. A dream runs while nobody is watching, and a caller that could
 * queue a turn behind one — the ids are derivable from `stratus dreams` —
 * would be running inside a session whose transcript the operator reads
 * the next morning as the agent's own overnight work.
 */
export const DREAM_SESSION_ID_PREFIX = 'dream:';

/** Whether a session id belongs to the reserved dreaming namespace. */
export const isDreamSessionId = (sessionId: string): boolean =>
  sessionId.startsWith(DREAM_SESSION_ID_PREFIX);

export interface DreamLimits {
  /**
   * How often the window check runs, milliseconds. Default one minute: a
   * window is hours wide and a dream is a whole turn, so a tighter tick
   * buys nothing but file reads.
   */
  tickMs?: number;
  /**
   * How many dreams a night may start when the file does not say. A file's
   * own `maxPerNight:` wins — it is the operator's number, written where
   * the dreams are.
   */
  maxPerNight?: number;
}

const DEFAULT_TICK_MS = 60_000;

/** What the dream runtime needs from its store — `SqliteDreamStore` as it reads it. */
export interface DreamStoreLike {
  get(agentId: string): DreamNightRecord | undefined;
  beginNight(record: DreamNightRecord): boolean;
  claimDream(record: DreamNightRecord, expectedStarted: number): boolean;
  save(record: DreamNightRecord): void;
}

export interface DreamRuntimeOptions {
  store: DreamStoreLike;
  /**
   * The agents dreaming tonight, from the live roster. Re-read every tick
   * rather than captured at start, so a soul that gained (or lost) its
   * `dreams:` at a roster reload is dreaming (or not) the same night.
   */
  dreamers(): Promise<DreamerEntry[]>;
  /**
   * Read one dream file. Fresh per night, never cached: the file is the
   * operator's standing instructions, and an edit made this evening is
   * meant for tonight.
   */
  loadDreams(dreamsPath: string): Promise<DreamFile>;
  /**
   * The gateway's own dispatch — never a second runner. Late-bound by
   * closure, like the scheduler's, and through the same firing-only entry,
   * since the public door refuses the reserved namespace.
   */
  dispatch(input: {
    sessionId: string;
    agentId: string;
    userMessage: string;
    metadata: JsonObject;
  }): Promise<unknown>;
  limits?: DreamLimits;
  /**
   * Run before every tick, and a rejection stops dreaming for good — the
   * scheduler's `ready` contract, for the same reason: claiming a dream is
   * a write into state a newer build may have re-shaped under this one.
   */
  ready?(): void | Promise<void>;
  /** The clock, injectable so a test can stand inside a window. */
  now?(): Date;
  log(line: string): void;
  warn(line: string): void;
}

export interface DreamRuntime {
  /** Start the window check. */
  start(): Promise<void>;
  /** Stop arming ticks; no further dreams start. Idempotent. */
  stop(): void;
  /** Settles when every dream this runtime started has finished. */
  drain(): Promise<void>;
}

/**
 * Dreaming: an agent works through its dream file inside a nightly window,
 * one dream per session, in order.
 *
 * Three rules the whole design is downstream of:
 *
 * **A dream is spent before it runs.** See `DreamNightRecord.started`.
 *
 * **A missed night is skipped, never caught up.** A daemon that was down
 * from midnight to noon has no dreaming to make up: the work was scoped to
 * a window its operator chose because nobody would be watching, and doing
 * it at lunchtime is a different act. The scheduler catches a missed
 * window up once because a schedule names a task; a dream names a night.
 *
 * **Nothing here is pre-authorized.** A schedule can carry a destination a
 * human approved with its cadence; a dream carries no destination and no
 * grant of any kind, so a gated tool at 3am is refused under `headless`
 * and asked in Slack under `remote`, exactly as it would be at 3pm. What a
 * dream has to show for itself in the morning is what it remembered.
 */
export const createDreamRuntime = (options: DreamRuntimeOptions): DreamRuntime => {
  const { store, dreamers, loadDreams, dispatch, log, warn } = options;
  const tickMs = options.limits?.tickMs ?? DEFAULT_TICK_MS;
  const defaultMaxPerNight = options.limits?.maxPerNight ?? DEFAULT_MAX_DREAMS_PER_NIGHT;
  const now = options.now ?? (() => new Date());

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const inflight = new Set<Promise<void>>();
  /** Agents with a dream running: one at a time, in the file's order. */
  const dreaming = new Set<string>();
  /**
   * The last complaint made about each agent's file, so a file that is
   * missing or unparseable warns once rather than once a minute all night
   * into a log that is meant to stay a trace. Cleared when the file reads
   * again, so the next breakage is heard.
   */
  const warned = new Map<string, string>();

  const complain = (agentId: string, message: string): void => {
    if (warned.get(agentId) !== message) {
      warned.set(agentId, message);
      warn(message);
    }
  };

  const dreamOnce = async (dreamer: DreamerEntry, at: Date): Promise<void> => {
    let file: DreamFile;
    try {
      file = await loadDreams(dreamer.dreamsPath);
    } catch (error) {
      complain(
        dreamer.agentId,
        `${dreamer.agentId} cannot dream: ${error instanceof Error ? error.message : String(error)} (declared by ${dreamer.soulPath})`,
      );
      return;
    }
    warned.delete(dreamer.agentId);

    const night = dreamNightOf(file.window, at);
    if (night === undefined) {
      return;
    }
    if (file.dreams.length === 0) {
      complain(
        dreamer.agentId,
        `${dreamer.agentId}'s dream file has no dreams in it — a dream is a "## " heading and the prose under it (${dreamer.dreamsPath})`,
      );
      return;
    }

    const timestamp = at.toISOString();
    let record = store.get(dreamer.agentId);
    if (record?.night !== night) {
      const opened: DreamNightRecord = {
        agentId: dreamer.agentId,
        night,
        started: 0,
        finished: 0,
        titles: [],
        source: dreamer.dreamsPath,
        openedAt: timestamp,
        updatedAt: timestamp,
      };
      // Re-read rather than trust the insert: another writer's row may
      // already have spent a dream this tick would hand out again.
      record = store.beginNight(opened) ? opened : store.get(dreamer.agentId);
      if (record?.night === night && record.started === 0) {
        log(`${dreamer.agentId} is dreaming the night of ${night} (window ${formatDreamWindow(file.window)}, ${file.dreams.length} dream(s) in ${dreamer.dreamsPath})`);
      }
    }
    if (!record || record.night !== night) {
      return;
    }

    const cap = Math.min(file.dreams.length, file.maxPerNight ?? defaultMaxPerNight);
    if (record.started >= cap) {
      return;
    }
    // One at a time per agent: dreams are a list its operator ordered, and
    // a fleet that starts five of them at once is a fleet spending five
    // times as much while nobody is awake to notice.
    if (dreaming.has(dreamer.agentId)) {
      return;
    }
    const index = record.started;
    const dream = file.dreams[index];
    if (!dream) {
      return;
    }

    const claimed: DreamNightRecord = {
      ...record,
      started: index + 1,
      titles: [...record.titles, dream.title],
      updatedAt: timestamp,
    };
    if (!store.claimDream(claimed, index)) {
      return;
    }

    const sessionId = `${DREAM_SESSION_ID_PREFIX}${dreamer.agentId}:${night}:${index}`;
    const settle = (lastError?: string): void => {
      dreaming.delete(dreamer.agentId);
      // Re-read: the row is the night's, and a later tick may have touched
      // it since this dream was claimed.
      const current = store.get(dreamer.agentId);
      if (!current || current.night !== night) {
        return;
      }
      store.save({
        ...current,
        finished: current.finished + 1,
        updatedAt: new Date().toISOString(),
        ...(lastError !== undefined ? { lastError } : {}),
      });
    };

    dreaming.add(dreamer.agentId);
    const running = dispatch({
      sessionId,
      agentId: dreamer.agentId,
      userMessage: dreamPrompt(file, dream),
      metadata: {
        [DREAMING_TURN_METADATA_KEY]: true,
        [DREAM_TITLE_METADATA_KEY]: dream.title,
        // The operator's own words. A dream file sits beside the soul,
        // under the same authority as the persona — and may not sit
        // anywhere the agent can write, which `resolveDreamsPath` is what
        // enforces. Whatever the dream then reads is labelled where it
        // enters, by the tools that read it.
        [SENDER_TRUST_METADATA_KEY]: 'user',
      },
    }).then(
      () => {
        // The session id and not the title: a dream's title is a line of
        // its prompt, and the daemon log is a trace rather than a second
        // transcript. Which dream this was is the index in the id, and
        // `stratus dreams` prints the night's titles in that order.
        log(`dream ${sessionId} completed`);
        settle();
      },
      (error) => {
        const reason = error instanceof Error ? error.message : String(error);
        warn(`dream ${sessionId} failed: ${reason}`);
        settle(reason);
      },
    );

    inflight.add(running);
    void running.finally(() => inflight.delete(running));
  };

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
        warn(`dreaming stopped before starting any dream: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    try {
      const at = now();
      for (const dreamer of await dreamers()) {
        if (stopped) {
          break;
        }
        await dreamOnce(dreamer, at);
      }
    } catch (error) {
      warn(`dream tick failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!stopped) {
      // Not unref'd, for the scheduler timer's reason: a declared dream
      // file is work the daemon owes tonight, and this timer is the only
      // thing that will start it. Shutdown belongs to stop().
      timer = setTimeout(() => {
        void tick();
      }, tickMs);
    }
  };

  return {
    async start() {
      if (options.ready) {
        await options.ready();
      }
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
  };
};
