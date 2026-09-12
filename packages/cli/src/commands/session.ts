import {
  runningGatewayBase,
  callRunningGateway,
  gatewayErrorMessage,
  noRunningDaemonMessage,
} from '../daemon.ts';
import type { CliStreams, CliEnvironment } from '../environment.ts';
import { writeLine } from '../io.ts';
import type { ParsedSessionCommand } from '../parse.ts';

/**
 * `stratus session rollover <id>` — start a conversation over under the
 * same id, archiving its transcript so far. The daemon does the work, on
 * the session's own chain, so a turn cannot interleave; this only asks.
 */
export const runSessionRollover = async (
  command: ParsedSessionCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  const base = await runningGatewayBase(env, command);
  if (!base) {
    writeLine(streams.stderr, `Error: ${noRunningDaemonMessage(env)}`);
    return 1;
  }
  const response = await callRunningGateway(env, command, base, `/api/v1/sessions/${encodeURIComponent(command.sessionId)}/rollover`);
  if (!response.ok) {
    writeLine(streams.stderr, `Error: ${await gatewayErrorMessage(response)}`);
    return 1;
  }
  const outcome = await response.json() as { sessionId?: string; archivedAs?: string };
  writeLine(
    streams.stdout,
    `Rolled over ${outcome.sessionId ?? command.sessionId}: the next message starts a fresh conversation, `
    + `and the transcript so far is archived as ${outcome.archivedAs ?? '(unknown)'}.`,
  );
  writeLine(
    streams.stdout,
    'A fresh session still reads the memory it injects — if that slice holds entries with no recorded origin, `stratus memory list <agent>` shows them and `stratus memory reassert` re-labels them.',
  );
  return 0;
};
