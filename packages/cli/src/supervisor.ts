import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type {
  CliStreams,
  CliEnvironment,
  DashboardSession,
  SupervisorMessage,
  SupervisorLink,
  RestartHandoff,
  RespawnResult,
} from './environment.ts';
import { writeLine } from './io.ts';
import type { ParsedServeCommand } from './parse.ts';

/**
 * `stratus serve` — run the gateway (stratusd) in the foreground: load the
 * roster, accept dispatches, print events, and drain cleanly on SIGTERM,
 * SIGINT, or the injected shutdown signal.
 */
/**
 * What a daemon exits with to ask for a fresh process. Only ever seen by the
 * supervisor below, which is the only thing that starts a daemon with the
 * environment marker that makes it exit this way instead of supervising.
 */
export const RESTART_EXIT_CODE = 75;

/**
 * What a daemon exits with when a restart could not drain — a turn that
 * ignored its abort, a plugin or channel that did not let go. Distinct from
 * the restart status on purpose: the supervisor answers this one by
 * exiting with it too, so the process the service manager started ends
 * and the manager restarts the whole unit — under systemd, cleaning the
 * cgroup of whatever the plugin left running. A supervisor that started
 * another daemon instead would keep that cgroup, and its leaks, alive.
 */
export const UNDRAINED_RESTART_EXIT_CODE = 76;

/** Set in a daemon the supervisor started, so its own restart is an exit, not a second supervisor. */
export const SUPERVISED_ENV = 'STRATUS_SERVE_SUPERVISED';

/**
 * The control API port the last daemon bound, handed to its replacement by
 * the supervisor. Honoured only where the replacement's own request — the
 * flag, else the config it reads afresh — is still for any free port: a
 * daemon that asked for port 0 comes back on the port it had, so a
 * dashboard page reconnects to it, while a config since edited to a fixed
 * port takes effect on that restart, as an `api` block change is meant to.
 * A hint, never a pin: passing the port back as `--api-port` would outrank
 * the config for every restart after.
 */
export const BOUND_API_PORT_ENV = 'STRATUS_SERVE_BOUND_API_PORT';

const isDashboardSession = (value: unknown): value is DashboardSession =>
  typeof value === 'object' && value !== null
  && typeof (value as { id?: unknown }).id === 'string'
  && typeof (value as { expiresAt?: unknown }).expiresAt === 'number'
  && typeof (value as { vouchedBy?: unknown }).vouchedBy === 'string';

/** Shape-checked, because the other end of an IPC channel is still another process. */
const isSupervisorMessage = (value: unknown): value is SupervisorMessage => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const message = value as { type?: unknown; port?: unknown; sessions?: unknown };
  if (message.type === 'stratusd.bound-api-port') {
    return typeof message.port === 'number' && Number.isInteger(message.port) && message.port > 0;
  }
  if (message.type === 'stratusd.sessions') {
    return Array.isArray(message.sessions) && message.sessions.every(isDashboardSession);
  }
  return false;
};

/**
 * The IPC channel a supervisor opens when it spawns a daemon: what a
 * supervised daemon says up it (the port it bound, so the supervisor
 * carries *that* port to the next daemon rather than the first one's; the
 * dashboard sessions it hands on) and what comes down it. Where there is
 * no channel — the first daemon, or one a service manager started — there
 * is no one to say it to, and nothing is said.
 */
export const defaultSupervisorLink: SupervisorLink = {
  send(message) {
    if (typeof process.send === 'function' && process.channel) {
      process.send(message);
    }
  },
  receive(handler) {
    const channel = process.channel;
    if (!channel) {
      return;
    }
    process.on('message', (message: unknown) => {
      if (isSupervisorMessage(message)) {
        handler(message);
      }
    });
    // A 'message' listener refs the channel, which would keep this process
    // alive after its drain; the daemon's own work is what holds it open.
    channel.unref?.();
  },
};

/**
 * The parsed serve command as arguments again — what the fresh daemon is
 * started with. From the command, not from `process.argv`: `stratus
 * dashboard` runs the daemon through `runServe` with a command it built,
 * and the process's own arguments would start a second dashboard.
 */
export const serveArgv = (command: ParsedServeCommand): string[] => [
  'serve',
  ...(command.configPath !== undefined ? ['--config', command.configPath] : []),
  ...(command.idleTimeoutMs !== undefined ? ['--idle-timeout', String(command.idleTimeoutMs / 1000)] : []),
  ...(command.approvals !== undefined ? ['--approvals', command.approvals] : []),
  ...(command.events ? [] : ['--no-events']),
  ...(command.logToFile === false ? ['--no-log-file'] : []),
  ...(command.api === false ? ['--no-api'] : command.api === true ? ['--api'] : []),
  ...(command.apiPort !== undefined ? ['--api-port', String(command.apiPort)] : []),
  ...(command.apiHost !== undefined ? ['--api-host', command.apiHost] : []),
];

/**
 * The `bin` beside the module at `moduleUrl`, with that module's own
 * extension: `dist/supervisor.js` respawns `dist/bin.js`, and a source checkout
 * running `src/supervisor.ts` under type stripping respawns `src/bin.ts` — the
 * flags that made that possible travel in `process.execArgv`. Assuming
 * compiled output would hand a source checkout a file that does not exist,
 * and a daemon that never comes back.
 */
export const restartEntrypoint = (moduleUrl: string): string => {
  const modulePath = fileURLToPath(moduleUrl);
  return path.join(path.dirname(modulePath), `bin${path.extname(modulePath)}`);
};

/**
 * Run this CLI's own entrypoint as a child with the daemon's streams and
 * exit code, forwarding the signals a supervisor would otherwise swallow.
 *
 * A child, and the parent waits, rather than a detached process and an
 * exit: under systemd and launchd the process the manager started is the
 * service, and its exit ends the job — cgroup and all, on Linux — so the
 * daemon that received the restart has to stay the manager's process and
 * become the supervisor of the next one. That is what makes the same path
 * hold in the foreground and under `--no-login`, where nothing else would
 * bring a clean exit back.
 */
const defaultServeRespawn = (env: CliEnvironment) => (argv: string[], handoff: RestartHandoff): Promise<RespawnResult> =>
  new Promise((resolve, reject) => {
    const entrypoint = restartEntrypoint(import.meta.url);
    // The daemon's own streams, plus an IPC channel for what it and its
    // supervisor have to tell each other. See SupervisorLink.
    const child = spawn(process.execPath, [...process.execArgv, entrypoint, ...argv], {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: {
        ...process.env,
        [SUPERVISED_ENV]: '1',
        ...(handoff.boundApiPort !== undefined ? { [BOUND_API_PORT_ENV]: String(handoff.boundApiPort) } : {}),
      },
    });
    if (handoff.sessions.length > 0 && child.connected) {
      // Queued in the channel until the daemon listens, which it does
      // before its API is up; the API holds them until it can adopt them.
      // A send that fails (the daemon died before reading) is not this
      // supervisor's failure: the exit below reports what happened, and a
      // daemon that never took them simply comes up signed out.
      const sessions: SupervisorMessage = { type: 'stratusd.sessions', sessions: handoff.sessions };
      child.send(sessions, () => undefined);
    }
    const forward = (signal: NodeJS.Signals) => (): void => {
      child.kill(signal);
    };
    const onTerm = forward('SIGTERM');
    const onInt = forward('SIGINT');
    const onAbort = (): void => {
      child.kill('SIGTERM');
    };
    process.on('SIGTERM', onTerm);
    process.on('SIGINT', onInt);
    env.shutdownSignal?.addEventListener('abort', onAbort, { once: true });
    const done = (): void => {
      process.off('SIGTERM', onTerm);
      process.off('SIGINT', onInt);
      env.shutdownSignal?.removeEventListener('abort', onAbort);
    };
    let reportedPort: number | undefined;
    let handedBack: DashboardSession[] | undefined;
    child.on('message', (message: unknown) => {
      if (!isSupervisorMessage(message)) {
        return;
      }
      if (message.type === 'stratusd.bound-api-port') {
        reportedPort = message.port;
      } else {
        handedBack = message.sessions;
      }
    });
    child.once('error', (error) => {
      done();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      done();
      // Killed by a signal is a stop, not a request to come back.
      resolve({
        code: code ?? (signal ? 1 : 0),
        ...(reportedPort !== undefined ? { boundApiPort: reportedPort } : {}),
        ...(handedBack !== undefined ? { sessions: handedBack } : {}),
      });
    });
  });

/**
 * Keep starting daemons for as long as they exit asking for another; the
 * first exit that does not is this process's own — an undrained restart's
 * status included, which ends the supervisor rather than starting a daemon
 * beside what the last one could not release.
 */
export const superviseRestarts = async (
  command: ParsedServeCommand,
  first: RestartHandoff,
  streams: CliStreams,
  env: CliEnvironment,
): Promise<number> => {
  const respawn = env.serveRespawn ?? defaultServeRespawn(env);
  // The hand-off follows the daemons: the port each one said it bound is
  // what the next one is told (so a config edited to a fixed port and
  // back hands on the last address, not the first), and the sessions are
  // whatever the last one handed back — a daemon that handed nothing
  // hands nothing on.
  let handoff = first;
  let result: RespawnResult;
  do {
    writeLine(streams.stdout, 'Restarting stratusd.');
    result = await respawn(serveArgv(command), handoff);
    handoff = {
      ...(result.boundApiPort !== undefined || handoff.boundApiPort !== undefined
        ? { boundApiPort: result.boundApiPort ?? handoff.boundApiPort }
        : {}),
      sessions: result.sessions ?? [],
    };
  } while (result.code === RESTART_EXIT_CODE);
  return result.code;
};
