import { gatewayInfoPath } from '@stratusagent/state';
import { callRunningGateway, gatewayErrorMessage, runningGatewayBase } from '../daemon.ts';
import type { CliStreams, CliEnvironment } from '../environment.ts';
import { writeLine } from '../io.ts';
import type { ParsedHealthCommand } from '../parse.ts';

/**
 * How long a probe waits for the daemon before calling it unhealthy.
 *
 * A container `HEALTHCHECK`, a systemd `ExecStartPost`, and a Kubernetes
 * exec probe each have a timeout of their own, but they differ, and one that
 * fires first kills the process with no sentence at all. Giving up here says
 * why. A healthy daemon answers in milliseconds: the route counts sessions
 * in the database rather than listing them for exactly this reason.
 */
const HEALTH_TIMEOUT_MS = 5_000;

/** The fields of `GET /api/v1/health` a one-line summary needs; the rest pass through to `--format json`. */
interface HealthPayload {
  ok?: boolean;
  version?: string;
  uptimeMs?: number;
  agents?: unknown[];
  sessions?: { total?: number; byStatus?: Record<string, number> };
  approvals?: { pending?: number };
}

const formatUptime = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h${minutes % 60 > 0 ? ` ${minutes % 60}m` : ''}`;
  }
  return `${Math.floor(hours / 24)}d`;
};

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * `stratus health` — is the daemon serving, asked of the daemon itself.
 *
 * For whatever supervises it from outside: a container `HEALTHCHECK`, a
 * Kubernetes probe, a monitoring script. Exit status is the answer — 0 when
 * the control API says `ok`, 1 for everything else — and the output is one
 * line either way, because a probe's output ends up in `docker inspect` and
 * a paragraph there is unreadable. `stratus service status` answers a
 * different question (does the service manager think the process is
 * alive?), and cannot see a daemon that is alive but wedged.
 *
 * Every failure is caught here rather than thrown to `runCli`, which would
 * append the whole help text to the probe's output.
 */
export const runHealth = async (
  command: ParsedHealthCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  const fail = (message: string): number => {
    if (command.format === 'json') {
      writeLine(streams.stdout, JSON.stringify({ ok: false, error: message }));
    } else {
      writeLine(streams.stderr, `Error: ${message}`);
    }
    return 1;
  };

  const base = await runningGatewayBase(env, command);
  if (!base) {
    return fail(
      `stratusd is not running — ${gatewayInfoPath(env)} does not exist, so no daemon has said where it is `
      + 'serving, and no --gateway was given. Start it with `stratus serve` or `stratus service start`; '
      + 'a daemon started with --no-api has no control API to ask.',
    );
  }

  let payload: HealthPayload;
  try {
    const response = await callRunningGateway(
      env,
      command,
      base,
      '/api/v1/health',
      undefined,
      'GET',
      AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    );
    if (!response.ok) {
      return fail(`The gateway at ${base} answered /health with ${await gatewayErrorMessage(response)}. Check \`stratus logs\` for why.`);
    }
    payload = await response.json() as HealthPayload;
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  if (payload.ok !== true) {
    return fail(`The gateway at ${base} answered /health without ok: true. Check \`stratus logs\` for why.`);
  }

  if (command.format === 'json') {
    writeLine(streams.stdout, JSON.stringify({ gateway: base, ...payload }));
    return 0;
  }

  const running = payload.sessions?.byStatus?.running ?? 0;
  const pending = payload.approvals?.pending ?? 0;
  const facts = [
    ...(payload.version !== undefined ? [`version ${payload.version}`] : []),
    ...(payload.uptimeMs !== undefined ? [`up ${formatUptime(payload.uptimeMs)}`] : []),
    plural(payload.agents?.length ?? 0, 'agent'),
    `${plural(payload.sessions?.total ?? 0, 'session')}${running > 0 ? ` (${running} running)` : ''}`,
    `${plural(pending, 'approval')} pending`,
  ];
  writeLine(streams.stdout, `stratusd ok at ${base} — ${facts.join(', ')}`);
  return 0;
};
