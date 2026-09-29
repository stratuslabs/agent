import type { DatabaseSync } from 'node:sqlite';
import type { UsageRecord } from '@stratusagent/core';
import type { BudgetWeights } from '@stratusagent/state';
import { openStratusDatabase, tightenSqliteFile, type SqliteSessionStoreOptions } from './sessions.ts';

/**
 * One provider call's usage as the ledger keeps it: the kernel's record,
 * plus when it was spent and by whom.
 */
export interface UsageLedgerEntry {
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
    at TEXT NOT NULL,
    agent_id TEXT NOT NULL,
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
  CREATE INDEX IF NOT EXISTS usage_agent_at ON usage (agent_id, at);
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
  if (query.agentId !== undefined) {
    conditions.push('agent_id = ?');
    params.push(query.agentId);
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
      .prepare(`INSERT INTO usage (at, agent_id, session_id, turn_id, provider, model,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        entry.at,
        entry.agentId,
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

  /** Totals per (agent, provider, model) in the window, largest spender first. */
  totals(query: UsageQuery = {}): UsageTotalsRow[] {
    const { clause, params } = whereFor(query);
    const rows = this.db.prepare(`
      SELECT agent_id, provider, model, COUNT(*) AS calls,
        SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens
      FROM usage ${clause}
      GROUP BY agent_id, provider, model
      ORDER BY agent_id, provider, model
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

  close(): void {
    this.db.close();
  }
}
