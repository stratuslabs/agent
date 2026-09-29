import { stat } from 'node:fs/promises';

import {
  budgetStatus,
  fleetDbPath,
  readGlobalConfigBlock,
  readTrustedConfigBlock,
  stratusHomePath,
  weightedTokens,
  type BudgetConfig,
  type BudgetLimitStatus,
} from '@stratusagent/state';
import type { CliStreams, CliEnvironment } from '../environment.ts';
import { writeLine } from '../io.ts';
import type { ParsedUsageCommand } from '../parse.ts';

const count = (value: number | undefined): string => (value === undefined ? '—' : Math.round(value).toLocaleString('en-US'));

/**
 * The budget this home runs under, read as the daemon reads it: the
 * trusted config, falling through to the global file past a project-local
 * one. An unreadable one is reported as unknown, never as absent — a
 * listing that said "no budget" over a broken file would tell an operator
 * (or a script reading the JSON) that nothing caps spend, when the daemon
 * is holding the last budget it could read, or refusing calls over it.
 */
const readBudget = async (env: CliEnvironment): Promise<
  { status: 'present'; budget: BudgetConfig } | { status: 'absent' } | { status: 'unreadable'; error: string }
> => {
  let block = await readTrustedConfigBlock('budget', env);
  if (block.status === 'untrusted') {
    block = await readGlobalConfigBlock('budget', env);
  }
  if (block.status === 'unreadable') {
    return { status: 'unreadable', error: block.error instanceof Error ? block.error.message : String(block.error) };
  }
  return block.status === 'present' ? { status: 'present', budget: block.value } : { status: 'absent' };
};

/**
 * `stratus usage` — what this home has spent on models, from the ledger
 * the daemon keeps in `fleet.db`, and where each budget limit stands.
 *
 * Straight from the file, like `stratus schedules`: the ledger is SQLite
 * in WAL mode, so reading it beside a serving daemon is routine, and the
 * answer does not depend on the daemon being up. Tokens as the providers
 * reported them, bucket by bucket; turning them into money is a price
 * table this command does not own.
 */
export const runUsage = async (
  command: ParsedUsageCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  const now = new Date();
  const since = command.since !== undefined
    ? new Date(command.since).toISOString()
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const until = command.until !== undefined ? new Date(command.until).toISOString() : undefined;
  const read = await readBudget(env);
  const budget = read.status === 'present' ? read.budget : undefined;

  let exists = true;
  try {
    await stat(fleetDbPath(env));
  } catch {
    exists = false;
  }
  const { SqliteUsageLedger } = await import('@stratusagent/gateway');
  const ledger = exists ? new SqliteUsageLedger(fleetDbPath(env), { stateHome: stratusHomePath(env) }) : undefined;
  let rows: ReturnType<NonNullable<typeof ledger>['totals']> = [];
  let limits: BudgetLimitStatus[] = [];
  try {
    rows = ledger?.totals({
      since,
      ...(until !== undefined ? { until } : {}),
      ...(command.agentId !== undefined ? { agentId: command.agentId } : {}),
    }) ?? [];
    limits = budget
      ? budgetStatus(budget, (windowStart, agentId) => ledger?.spent(windowStart, agentId, budget.weights) ?? 0, now)
      : [];
  } finally {
    ledger?.close();
  }

  if (command.format === 'json') {
    writeLine(streams.stdout, JSON.stringify({
      since,
      ...(until !== undefined ? { until } : {}),
      ...(command.agentId !== undefined ? { agent: command.agentId } : {}),
      usage: rows,
      ...(budget ? { budget: { budget, limits } } : {}),
      ...(read.status === 'unreadable' ? { budgetUnreadable: read.error } : {}),
    }, null, 2));
    return read.status === 'unreadable' ? 1 : 0;
  }

  writeLine(streams.stdout, `Usage since ${since.slice(0, 10)}${until !== undefined ? `, until ${until.slice(0, 10)}` : ''} (tokens, as providers reported them):`);
  if (rows.length === 0) {
    writeLine(streams.stdout, '  nothing recorded. The daemon records each model call as it is made; `stratus run` one-shots are not counted.');
  }
  for (const row of rows) {
    writeLine(
      streams.stdout,
      `  ${row.agentId}  ${row.provider}${row.model !== undefined ? `/${row.model}` : ''}  ${row.calls} call(s)  `
      + `in ${count(row.inputTokens)}  out ${count(row.outputTokens)}  cache read ${count(row.cacheReadTokens)}  cache write ${count(row.cacheWriteTokens)}`
      + (budget ? `  weighted ${count(weightedTokens(row, budget.weights))}` : ''),
    );
  }
  if (read.status === 'unreadable') {
    writeLine(streams.stderr, `The budget could not be read (${read.error}), so whether spend is capped is unknown here. A running daemon keeps the last budget it read, and refuses model calls if it never read one. Fix the config and run this again.`);
    return 1;
  }
  if (!budget) {
    writeLine(streams.stdout, 'No budget is set. A `budget` block in ~/.stratus/config.json caps spend per UTC day or month.');
    return 0;
  }
  writeLine(streams.stdout, 'Budget (weighted tokens):');
  for (const limit of limits) {
    const who = limit.scope === 'home' ? 'this install' : `agent ${limit.agentId ?? ''}`;
    writeLine(
      streams.stdout,
      `  ${who}  ${limit.period}  ${count(limit.spent)} of ${count(limit.limit)}  resets ${limit.resetsAt.slice(0, 16).replace('T', ' ')} UTC`
      + (limit.reached ? '  — reached: model calls in this scope are refused' : ''),
    );
  }
  return 0;
};
