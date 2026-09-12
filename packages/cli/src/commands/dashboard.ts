import { spawn } from 'node:child_process';
import { gatewayToken, readGatewayInfo, gatewayAnswering, HomeHeldError } from '../daemon.ts';
import type { CliStreams, CliEnvironment } from '../environment.ts';
import { writeLine } from '../io.ts';
import type { ParsedDashboardCommand } from '../parse.ts';
import { runServe } from './serve.ts';

const DASHBOARD_TITLE = 'Stratus Agent Dashboard';

export const openExternalUrl = async (url: string): Promise<void> => {
  const platform = process.platform;
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: platform !== 'win32' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
};

/**
 * A one-time URL for the browser.
 *
 * This is the whole reason the exchange exists: the CLI can read the token
 * file and a page cannot, so the CLI lends its authority for exactly one
 * short-lived trip.
 */
const mintDashboardUrl = async (
  env: CliEnvironment,
  base: string,
  fetchImpl: typeof fetch,
): Promise<string> => {
  const token = await gatewayToken(env, undefined);
  const response = await fetchImpl(`${base}/api/v1/auth/ott`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`The gateway at ${base} refused to open a dashboard session (HTTP ${response.status}).`);
  }
  const payload = await response.json() as { url?: string; path?: string };
  // The relative form joined to the base we already reached, in preference to
  // the absolute one: this command knows exactly which address answered, and
  // the daemon can only infer it from headers.
  if (payload.path) {
    return `${base.replace(/\/+$/, '')}${payload.path}`;
  }
  if (!payload.url) {
    throw new Error(`The gateway at ${base} did not return a dashboard URL.`);
  }
  return payload.url;
};

/**
 * `stratus dashboard` — open the web UI against a running daemon, starting
 * one in the foreground when there is none.
 *
 * The daemon is started by calling `runServe`, not by rebuilding its wiring:
 * channels, approvals, the credential preflight, and the log writer are all
 * decisions `serve` already makes, and a second copy of them here would drift
 * the first time either side gained a rule.
 */
export const runDashboard = async (
  command: ParsedDashboardCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  const fetchImpl = env.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    writeLine(streams.stderr, 'Error: fetch is unavailable, so the dashboard cannot reach a gateway.');
    return 1;
  }

  const existing = await readGatewayInfo(env);
  let base = existing && await gatewayAnswering(env, existing.url, fetchImpl) ? existing.url : undefined;

  const ownDaemon = new AbortController();
  let serving: Promise<number> | undefined;

  if (!base) {
    writeLine(streams.stdout, 'No daemon is running — starting one. It stops when you do.');
    writeLine(streams.stdout, 'Run `stratus service install` to keep one running instead.');

    // One attempt at a daemon of our own. `runServe` can reject before it
    // publishes anything — an unreadable roster, a session store that will
    // not open — and a rejected promise nobody is watching for fifteen
    // seconds is an unhandled rejection, which terminates the process
    // instead of reaching the message below. Captured rather than
    // swallowed, so the reason the daemon gave is the reason this command
    // reports.
    let daemonFailure: unknown;
    let daemonSettled = false;
    let daemonExit: Promise<void> = Promise.resolve();
    let attemptedAt = 0;
    const attempt = (): void => {
      daemonFailure = undefined;
      daemonSettled = false;
      attemptedAt = Date.now();
      serving = runServe(
        {
          command: 'serve',
          events: false,
          // Explicitly on. A trusted config may set `api.enabled: false` —
          // a reasonable thing for a headless box — but this command exists
          // to open the dashboard, and honouring it here would start a
          // daemon with no API and then time out waiting for the one it
          // promised.
          api: true,
          ...(command.port !== undefined ? { apiPort: command.port } : {}),
          // Passed whenever it was asked for, including when it is the
          // default. `--host 127.0.0.1` against a config saying `0.0.0.0`
          // is an operator narrowing the bind, and dropping it because it
          // matched the default did the reverse of what they typed.
          ...(command.host !== undefined ? { apiHost: command.host } : {}),
        },
        // The daemon's own chatter belongs on stderr here: stdout is where
        // this command says where to point a browser, and interleaving the
        // two makes the one line that matters hard to find.
        { stdout: streams.stderr, stderr: streams.stderr },
        { ...env, shutdownSignal: ownDaemon.signal },
      );
      daemonExit = serving.then(
        () => { daemonSettled = true; },
        (error: unknown) => { daemonFailure = error; daemonSettled = true; },
      );
    };
    attempt();

    // Gated on a daemon actually answering, not on a delay: one publishes
    // where it bound the moment it binds, and anything less would be a race
    // dressed up as a timeout. It also stops the moment our daemon gives up
    // — except when it gave up because another one holds the home. An
    // installed service still starting has not published its address yet
    // and is about to: that is the daemon to wait for. And a daemon still
    // draining may simply exit, with nothing replacing it — so while the
    // home is held, our own attempt is repeated about once a second, and
    // takes the home the moment it is free.
    const startedBy = Date.now() + 15_000;
    while (!base && Date.now() < startedBy) {
      const info = await readGatewayInfo(env);
      if (info && await gatewayAnswering(env, info.url, fetchImpl)) {
        base = info.url;
        break;
      }
      if (daemonSettled) {
        if (!(daemonFailure instanceof HomeHeldError)) {
          break;
        }
        if (Date.now() - attemptedAt >= 1_000) {
          attempt();
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (!base) {
      ownDaemon.abort();
      await daemonExit;
      writeLine(
        streams.stderr,
        daemonFailure instanceof HomeHeldError
          ? 'Error: another daemon holds this home but never published its address. It may still be starting or '
            + 'draining — try again in a moment, or check `stratus service status`.'
          : daemonFailure
            ? `Error: the daemon could not start: ${daemonFailure instanceof Error ? daemonFailure.message : String(daemonFailure)}`
            : 'Error: the daemon did not start serving its control API. Is @stratusagent/control-api installed?',
      );
      return 1;
    }
    if (daemonFailure instanceof HomeHeldError) {
      // The daemon that answered is the one that held the home. Ours never
      // started, so there is nothing of ours to wait for or to stop: from
      // here this is the found-a-running-daemon case.
      serving = undefined;
    }
  }

  let url: string;
  try {
    url = await mintDashboardUrl(env, base, fetchImpl);
  } catch (error) {
    ownDaemon.abort();
    await serving?.catch(() => 0);
    writeLine(streams.stderr, `Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  writeLine(streams.stdout, `${DASHBOARD_TITLE} ready at ${base}`);
  writeLine(streams.stdout, 'That link signs one browser in and can only be used once.');

  if (command.openBrowser) {
    try {
      await (env.openExternal ?? openExternalUrl)(url);
      writeLine(streams.stdout, 'Opened your default browser.');
    } catch (error) {
      writeLine(streams.stderr, `Warning: Could not open the browser automatically: ${error instanceof Error ? error.message : String(error)}`);
      writeLine(streams.stdout, `Open this yourself: ${url}`);
    }
  } else {
    writeLine(streams.stdout, `Open this to sign in: ${url}`);
  }

  if (!serving) {
    // Someone else owns the daemon; this command's job is done.
    return 0;
  }

  writeLine(streams.stdout, 'Press Ctrl+C to stop the daemon.');
  if (env.dashboardAutoShutdownMs !== undefined) {
    await new Promise((resolve) => setTimeout(resolve, env.dashboardAutoShutdownMs));
    ownDaemon.abort();
  }
  // An attempt still in flight when the daemon answered may yet be refused
  // — the holder published while ours was claiming. The dashboard found a
  // daemon; that refusal is not its failure.
  return serving.catch((error: unknown) => {
    if (error instanceof HomeHeldError) {
      return 0;
    }
    throw error;
  });
};
