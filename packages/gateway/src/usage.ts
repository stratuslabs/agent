import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { UsageRecord } from '@stratusagent/core';
import { assertDerivedStatePathSync, foldedAgentId, type BudgetWeights } from '@stratusagent/state';
import { openStratusDatabase, tightenSqliteFile, type SqliteSessionStoreOptions } from './sessions.ts';

/**
 * One provider call's usage as the ledger keeps it: the kernel's record,
 * plus when it was spent and by whom.
 */
export interface UsageLedgerEntry {
  /**
   * Unique per call, assigned once. Recording the same entry twice is a
   * no-op, which is what makes replaying held usage safe: a drain that
   * wrote its rows and died before clearing the file writes nothing twice.
   */
  id: string;
  at: string;
  agentId: string;
  sessionId: string;
  record: UsageRecord;
}

/** Spend summed per (agent, provider, model) over a window — what `GET /usage` answers with. */
export interface UsageTotalsRow {
  agentId: string;
  provider: string;
  model?: string;
  /** Provider calls counted, whether or not they reported every bucket. */
  calls: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface UsageQuery {
  /** ISO timestamp, inclusive. */
  since?: string;
  /** ISO timestamp, exclusive. */
  until?: string;
  agentId?: string;
}

const USAGE_TABLE = `
  CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id TEXT NOT NULL UNIQUE,
    at TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    agent_key TEXT NOT NULL,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER
  );
  CREATE INDEX IF NOT EXISTS usage_at ON usage (at);
  CREATE INDEX IF NOT EXISTS usage_agent_at ON usage (agent_key, at);
`;

const whereFor = (query: UsageQuery): { clause: string; params: string[] } => {
  const conditions: string[] = [];
  const params: string[] = [];
  if (query.since !== undefined) {
    conditions.push('at >= ?');
    params.push(query.since);
  }
  if (query.until !== undefined) {
    conditions.push('at < ?');
    params.push(query.until);
  }
  // By the folded id, the way agent identity is matched everywhere: a
  // budget written for `scout` has to count what the soul `Scout` spent.
  if (query.agentId !== undefined) {
    conditions.push('agent_key = ?');
    params.push(foldedAgentId(query.agentId));
  }
  return { clause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '', params };
};

/** A SQL `SUM` that stays NULL when no row reported the bucket, so absence survives the sum. */
const numberOrUndefined = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);

/**
 * The home's usage ledger: one row per provider call, in `fleet.db`.
 *
 * A ledger beside the sessions rather than a sum over them, for two
 * reasons. Spend has to be judged before *every* provider call, and a sum
 * across every agent's shard is a fan-out over files that grow forever.
 * And a budget is a statement about a window of time, which the sessions
 * cannot answer: a session's records carry no timestamps, and a
 * conversation that began last month is still spending today. The rows are
 * the kernel's `UsageRecord`s unchanged — the four buckets kept apart,
 * attribution intact — so a total here and a total over the sessions agree
 * for every call the ledger saw. What it did not see is usage from before
 * it existed, and `stratus run` one-shots, which never pass through a
 * daemon.
 *
 * Fleet infrastructure like the schedules, so it lives in `fleet.db` and is
 * read by `stratus usage` from another process — the same WAL arrangement
 * that lets `stratus schedules` read while the daemon writes.
 */
export class SqliteUsageLedger {
  private readonly db: DatabaseSync;

  constructor(filePath: string, options: SqliteSessionStoreOptions = {}) {
    this.db = openStratusDatabase(filePath, options);
    this.db.exec(USAGE_TABLE);
    tightenSqliteFile(filePath);
  }

  record(entry: UsageLedgerEntry): void {
    const { record } = entry;
    this.db
      .prepare(`INSERT OR IGNORE INTO usage (entry_id, at, agent_id, agent_key, session_id, turn_id, provider, model,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        entry.id,
        entry.at,
        entry.agentId,
        foldedAgentId(entry.agentId),
        entry.sessionId,
        record.turnId,
        record.provider,
        record.model ?? null,
        record.inputTokens ?? null,
        record.outputTokens ?? null,
        record.cacheReadTokens ?? null,
        record.cacheWriteTokens ?? null,
      );
  }

  /** Record several entries, all or none. */
  recordAll(entries: readonly UsageLedgerEntry[]): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const entry of entries) {
        this.record(entry);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Totals per (agent, provider, model) in the window, largest spender first. */
  totals(query: UsageQuery = {}): UsageTotalsRow[] {
    const { clause, params } = whereFor(query);
    // Grouped by the folded id, as the budget counts it: an agent whose id
    // changed case is one agent with one row. The spelling shown is the
    // newest row's — SQLite takes a bare column from the row MAX() chose.
    const rows = this.db.prepare(`
      SELECT agent_id, MAX(id) AS newest, provider, model, COUNT(*) AS calls,
        SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens
      FROM usage ${clause}
      GROUP BY agent_key, provider, model
      ORDER BY agent_key, provider, model
    `).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const model = typeof row.model === 'string' ? row.model : undefined;
      const input = numberOrUndefined(row.input_tokens);
      const output = numberOrUndefined(row.output_tokens);
      const cacheRead = numberOrUndefined(row.cache_read_tokens);
      const cacheWrite = numberOrUndefined(row.cache_write_tokens);
      return {
        agentId: String(row.agent_id),
        provider: String(row.provider),
        ...(model !== undefined ? { model } : {}),
        calls: Number(row.calls),
        ...(input !== undefined ? { inputTokens: input } : {}),
        ...(output !== undefined ? { outputTokens: output } : {}),
        ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
        ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
      };
    });
  }

  /**
   * Weighted spend since `since`, for one agent or the whole home — the
   * number a budget is compared against. Summed in SQL so a budget check
   * costs one indexed query, not a read of every row.
   */
  spent(since: string, agentId: string | undefined, weights: BudgetWeights = {}): number {
    const { clause, params } = whereFor({ since, ...(agentId !== undefined ? { agentId } : {}) });
    const row = this.db.prepare(`
      SELECT SUM(
        COALESCE(input_tokens, 0) * ? + COALESCE(output_tokens, 0) * ?
        + COALESCE(cache_read_tokens, 0) * ? + COALESCE(cache_write_tokens, 0) * ?
      ) AS spent FROM usage ${clause}
    `).get(
      weights.inputTokens ?? 1,
      weights.outputTokens ?? 1,
      weights.cacheReadTokens ?? 1,
      weights.cacheWriteTokens ?? 1,
      ...params,
    ) as { spent: number | null } | undefined;
    return row?.spent ?? 0;
  }

  /** Rows in the ledger — how a settle tells whether it recovered anything. */
  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM usage').get() as { n: number } | undefined;
    return row?.n ?? 0;
  }

  close(): void {
    this.db.close();
  }
}

/** Where held usage waits, in the state home beside `fleet.db`. */
export const USAGE_HOLD_FILENAME = 'usage-held.jsonl';

/**
 * Present when a daemon stopped holding spend it could write nowhere — see
 * `createUsageHold`'s `markUnsettled`. The next daemon refuses budgeted
 * calls while it exists, and removes it once it has settled the ledger.
 */
export const USAGE_UNSETTLED_FILENAME = 'usage-unsettled';
/** The empty file made ahead of time, while there is room, that becomes the marker by a rename. */
const USAGE_UNSETTLED_ARMED_FILENAME = 'usage-unsettled.armed';

/** A fresh entry id — see `UsageLedgerEntry.id`. */
export const newUsageEntryId = (): string => randomUUID();

/**
 * Usage the ledger could not write, kept on disk until it can be.
 *
 * Held in memory only, a row lost to a full disk was lost again at the next
 * restart — and the budget, reading a ledger missing it, would allow the
 * spend a second time. So a failed write is appended here (a few hundred
 * bytes, which often still fits where a SQLite transaction does not), and
 * every later budget check drains the file into the ledger before judging,
 * refusing while it cannot. Rows carry their ids, so a drain that dies
 * between writing the rows and clearing the file writes nothing twice.
 *
 * `0600` like every other file in the home, with the explicit chmod an
 * append needs, and never through a link — it is a name Stratus chose.
 */
export const createUsageHold = (stateHome: string, filePath: string) => ({
  path: filePath,
  append(entries: readonly UsageLedgerEntry[]): void {
    if (entries.length === 0) {
      return;
    }
    assertDerivedStatePathSync(stateHome, filePath, 'file');
    appendFileSync(filePath, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''), { mode: 0o600 });
    chmodSync(filePath, 0o600);
  },
  read(): UsageLedgerEntry[] {
    assertDerivedStatePathSync(stateHome, filePath, 'file');
    let text: string;
    try {
      text = readFileSync(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
    // A line that does not parse is refused, never skipped: a crash or a
    // full disk mid-append leaves a call's record cut short, and dropping
    // it on the next drain would lose spend that happened. Whether that
    // record can be recovered is a person's call, so the drain stops and
    // says where.
    const entries: UsageLedgerEntry[] = [];
    for (const [index, line] of text.split('\n').entries()) {
      if (line.trim().length === 0) {
        continue;
      }
      try {
        entries.push(JSON.parse(line) as UsageLedgerEntry);
      } catch {
        throw new Error(
          `line ${index + 1} of ${filePath} is damaged, so the usage it held cannot be counted. `
          + 'Repair or remove that line once you have accounted for the call it recorded.',
        );
      }
    }
    return entries;
  },
  clear(): void {
    try {
      unlinkSync(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  },
  /** Where the unsettled marker goes; see `USAGE_UNSETTLED_FILENAME`. */
  unsettledPath: path.join(path.dirname(filePath), USAGE_UNSETTLED_FILENAME),
  /**
   * Make the marker's stand-in now, while the disk has room for a new file,
   * so that marking later is a rename — which needs no free data blocks and
   * so still works on the full disk that is the reason for marking.
   */
  arm(): void {
    const armed = path.join(path.dirname(filePath), USAGE_UNSETTLED_ARMED_FILENAME);
    assertDerivedStatePathSync(stateHome, armed, 'file');
    try {
      writeFileSync(armed, '', { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
  },
  /**
   * Leave word for the next daemon that this one is stopping with spend it
   * could not write: the armed file renamed into place, or — if it was never
   * armed — an empty file, which is the next best chance on a full disk.
   * Throws only when neither lands.
   */
  markUnsettled(): void {
    const armed = path.join(path.dirname(filePath), USAGE_UNSETTLED_ARMED_FILENAME);
    const marker = path.join(path.dirname(filePath), USAGE_UNSETTLED_FILENAME);
    assertDerivedStatePathSync(stateHome, marker, 'file');
    try {
      renameSync(armed, marker);
    } catch {
      writeFileSync(marker, '', { mode: 0o600 });
    }
  },
  unsettled(): boolean {
    const marker = path.join(path.dirname(filePath), USAGE_UNSETTLED_FILENAME);
    assertDerivedStatePathSync(stateHome, marker, 'file');
    return existsSync(marker);
  },
  settle(): void {
    unlinkSync(path.join(path.dirname(filePath), USAGE_UNSETTLED_FILENAME));
  },
});
