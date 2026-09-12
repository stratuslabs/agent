import {
  runningGatewayBase,
  callRunningGateway,
  gatewayErrorMessage,
  noRunningDaemonMessage,
} from '../daemon.ts';
import type { CliStreams, CliEnvironment } from '../environment.ts';
import { writeLine } from '../io.ts';
import type { ParsedRestartCommand } from '../parse.ts';

export const runRestart = async (
  command: ParsedRestartCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  const base = await runningGatewayBase(env, command);
  if (!base) {
    writeLine(streams.stderr, `Error: ${noRunningDaemonMessage(env)}`);
    return 1;
  }
  const response = await callRunningGateway(env, command, base, '/api/v1/restart', {
    reason: command.reason ?? 'stratus restart',
    ...(command.drainTimeoutMs !== undefined ? { drainTimeoutMs: command.drainTimeoutMs } : {}),
  });
  if (!response.ok) {
    writeLine(streams.stderr, `Error: ${await gatewayErrorMessage(response)}`);
    return 1;
  }
  const status = await response.json() as { inflight?: number; drainTimeoutMs?: number };
  const inflight = status.inflight ?? 0;
  const window = Math.round((status.drainTimeoutMs ?? 0) / 1000);
  writeLine(
    streams.stdout,
    `restart announced to the daemon at ${base} — new turns are refused; ${inflight} turn(s) in flight `
    + `get up to ${window}s to finish, then it comes back.`,
  );
  writeLine(streams.stdout, 'Watch it come back: stratus logs -f');
  return 0;
};
