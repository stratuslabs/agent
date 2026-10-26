import { escapeControlCharacters } from '@stratusagent/core';

import {
  callRunningGateway,
  gatewayErrorMessage,
  noRunningDaemonMessage,
  runningGatewayBase,
} from '../daemon.ts';
import type { CliStreams, CliEnvironment } from '../environment.ts';
import { writeLine } from '../io.ts';
import type { ParsedSessionsCommand } from '../parse.ts';

/** How many sessions a listing shows when no --limit is given. */
export const DEFAULT_SESSIONS_LIMIT = 20;

/** One row of `GET /api/v1/sessions`. */
interface SessionRow {
  id: string;
  agentId: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * `stratus sessions` — what the running daemon's sessions are doing, newest
 * first: running, waiting on an approval, failed, or done.
 *
 * A thin read of `GET /api/v1/sessions`, which filters by agent and cuts
 * to a limit but knows nothing of status. So a status filter reads every
 * row and filters here: cutting first would answer "no failed sessions"
 * whenever the newest few happened to be running. Without one, the route
 * does the cutting, asked for one row more than is shown so the listing
 * can say there are more.
 */
export const runSessions = async (
  command: ParsedSessionsCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  const base = await runningGatewayBase(env, command);
  if (!base) {
    writeLine(streams.stderr, `Error: ${noRunningDaemonMessage(env)}`);
    return 1;
  }

  const limit = command.limit ?? DEFAULT_SESSIONS_LIMIT;
  const query = new URLSearchParams();
  if (command.agentId !== undefined) {
    query.set('agent', command.agentId);
  }
  if (command.status === undefined) {
    query.set('limit', String(limit + 1));
  }
  const search = query.toString();

  let rows: SessionRow[];
  try {
    const response = await callRunningGateway(env, command, base, `/api/v1/sessions${search ? `?${search}` : ''}`, undefined, 'GET');
    if (!response.ok) {
      writeLine(streams.stderr, `Error: ${await gatewayErrorMessage(response)}`);
      return 1;
    }
    rows = ((await response.json()) as { sessions?: SessionRow[] }).sessions ?? [];
  } catch (error) {
    writeLine(streams.stderr, `Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const matching = command.status === undefined ? rows : rows.filter((row) => row.status === command.status);
  const shown = matching.slice(0, limit);
  const more = matching.length > limit;

  if (command.format === 'json') {
    writeLine(streams.stdout, JSON.stringify({ sessions: shown, more }));
    return 0;
  }
  if (shown.length === 0) {
    writeLine(streams.stdout, command.status === undefined ? 'No sessions.' : `No ${command.status} sessions.`);
    return 0;
  }
  // Escaped like `stratus memory list`: an id is whatever a channel or an
  // API caller named the session, and this goes to a terminal.
  const lines = shown.map((row) => [row.status, row.agentId, row.updatedAt ?? '-', row.id].map(escapeControlCharacters));
  const widths = [0, 1, 2].map((column) => Math.max(...lines.map((cells) => cells[column]?.length ?? 0)));
  for (const cells of lines) {
    writeLine(streams.stdout, cells.map((cell, column) => (column < 3 ? cell.padEnd(widths[column] ?? 0) : cell)).join('  '));
  }
  if (more) {
    writeLine(streams.stdout, `Showing the newest ${limit}. --limit <n> shows more.`);
  }
  return 0;
};
