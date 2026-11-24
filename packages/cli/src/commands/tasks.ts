import { escapeControlCharacters } from '@stratusagent/core';
import type { TaskListing } from '@stratusagent/gateway';

import {
  callRunningGateway,
  gatewayErrorMessage,
  noRunningDaemonMessage,
  runningGatewayBase,
} from '../daemon.ts';
import type { CliStreams, CliEnvironment } from '../environment.ts';
import { writeLine } from '../io.ts';
import type { ParsedTasksCommand } from '../parse/tasks.ts';

/** What `POST /api/v1/tasks/:id/cancel` answers. */
interface CancelAnswer {
  task: string;
  stopped: boolean;
  /** How it ended, when it had already ended. */
  status?: string;
  /** An earlier cancel had already stopped it; `stoppedBy` is who. */
  already?: boolean;
  stoppedBy?: string;
}

const OPEN_STATUSES = new Set(['running', 'waiting_approval']);

/** Who stopped a task, as a phrase. */
const stopper = (stoppedBy: string): string => {
  switch (stoppedBy) {
    case 'cli':
      return 'from the CLI';
    case 'dashboard':
      return 'from the dashboard';
    case 'agent':
      return 'by the agent';
    default:
      return `by ${stoppedBy}`;
  }
};

/**
 * The last column: where the outcome stands. Nothing for a task still
 * running. `delivered` says only that the outcome is in the conversation's
 * transcript, not that a chat post landed, so it reads "in the
 * conversation".
 */
const outcomeCell = (row: TaskListing): string => {
  const stopped = row.stoppedBy === undefined ? '' : `stopped ${stopper(row.stoppedBy)}`;
  if (OPEN_STATUSES.has(row.status)) {
    return stopped === '' ? '' : `${stopped}, stopping`;
  }
  const delivery = row.delivery === 'delivered'
    ? 'in the conversation'
    : row.delivery === 'dropped' ? 'dropped: its conversation is gone' : 'not in the conversation yet';
  return stopped === '' ? delivery : `${stopped}; ${delivery}`;
};

const errorOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * `stratus tasks` lists the running daemon's background tasks (AGT-211):
 * every one running or owed a delivery, newest first, then the most recently
 * finished. `stratus tasks cancel <id>` stops one, through the daemon, since
 * only the process running a task can stop it. A thin client of
 * `GET /api/v1/tasks` and `POST /api/v1/tasks/:id/cancel`, like `stratus
 * sessions`. Ids and status only, never what a task was asked or answered.
 */
export const runTasks = async (
  command: ParsedTasksCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  const base = await runningGatewayBase(env, command);
  if (!base) {
    writeLine(streams.stderr, `Error: ${noRunningDaemonMessage(env)}`);
    return 1;
  }

  if (command.action === 'cancel') {
    const id = command.taskId ?? '';
    let answer: CancelAnswer;
    try {
      const response = await callRunningGateway(env, command, base, `/api/v1/tasks/${encodeURIComponent(id)}/cancel`, undefined, 'POST');
      if (!response.ok) {
        writeLine(streams.stderr, `Error: ${await gatewayErrorMessage(response)}`);
        return 1;
      }
      answer = (await response.json()) as CancelAnswer;
    } catch (error) {
      writeLine(streams.stderr, `Error: ${errorOf(error)}`);
      return 1;
    }
    if (command.format === 'json') {
      writeLine(streams.stdout, JSON.stringify(answer));
      return 0;
    }
    const line = !answer.stopped
      ? `${id} had already ended (${answer.status ?? 'finished'}), so nothing was stopped.`
      : answer.already === true
        ? `${id} is already stopping (stopped ${stopper(answer.stoppedBy ?? 'someone')}).`
        : `Stopping ${id}. Its conversation gets a notice that it was cancelled.`;
    writeLine(streams.stdout, escapeControlCharacters(line));
    return 0;
  }

  let rows: TaskListing[];
  try {
    const query = command.agentId === undefined ? '' : `?${new URLSearchParams({ agent: command.agentId }).toString()}`;
    const response = await callRunningGateway(env, command, base, `/api/v1/tasks${query}`, undefined, 'GET');
    if (!response.ok) {
      writeLine(streams.stderr, `Error: ${await gatewayErrorMessage(response)}`);
      return 1;
    }
    rows = ((await response.json()) as { tasks?: TaskListing[] }).tasks ?? [];
  } catch (error) {
    writeLine(streams.stderr, `Error: ${errorOf(error)}`);
    return 1;
  }

  if (command.format === 'json') {
    writeLine(streams.stdout, JSON.stringify({ tasks: rows }));
    return 0;
  }
  if (rows.length === 0) {
    writeLine(streams.stdout, command.agentId === undefined ? 'No background tasks.' : `No background tasks started by ${escapeControlCharacters(command.agentId)}.`);
    return 0;
  }
  // Escaped like `stratus sessions`: ids come from whatever named the
  // conversation, and this goes to a terminal.
  const lines = rows.map((row) => [
    row.status,
    row.workerAgentId === row.agentId ? row.agentId : `${row.agentId} → ${row.workerAgentId}`,
    row.createdAt,
    row.steps === 1 ? '1 step' : `${row.steps} steps`,
    row.id,
    outcomeCell(row),
  ].map(escapeControlCharacters));
  const widths = [0, 1, 2, 3, 4].map((column) => Math.max(...lines.map((cells) => cells[column]?.length ?? 0)));
  for (const cells of lines) {
    writeLine(streams.stdout, cells.map((cell, column) => (column < 5 ? cell.padEnd(widths[column] ?? 0) : cell)).join('  ').trimEnd());
  }
  return 0;
};
