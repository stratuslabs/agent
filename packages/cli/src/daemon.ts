import { readFile } from 'node:fs/promises';
import {
  readNonEmptyString,
  readProcessEnv,
  readWorkingDirectory,
  gatewayInfoPath,
  gatewayTokenPath,
} from '@stratusagent/state';
import type { ServiceEnvironment } from './service.ts';
import type { CliEnvironment } from './environment.ts';

/**
 * The bearer token for a gateway: an explicit flag, the environment, or the
 * token file this machine's daemon wrote.
 *
 * The file is the normal case and the reason `--gateway` needs no ceremony
 * locally. It is not always right, though: a gateway reached through a tunnel
 * has its own token, which is what the flag and the variable are for.
 */
export const gatewayToken = async (
  env: CliEnvironment,
  explicit: string | undefined,
): Promise<string> => {
  const fromEnv = readNonEmptyString(readProcessEnv(env).STRATUS_GATEWAY_TOKEN);
  if (explicit || fromEnv) {
    return String(explicit ?? fromEnv);
  }
  try {
    return (await readFile(gatewayTokenPath(env), 'utf8')).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    throw new Error(
      `No gateway token: ${gatewayTokenPath(env)} does not exist, and neither --token nor STRATUS_GATEWAY_TOKEN was set. `
      + 'Start the daemon with `stratus serve` (or `stratus service install`) to create one, or pass the remote gateway\'s token.',
    );
  }
};

/** Builds the service view of the CLI environment (home, exec paths, runner). */
export const serviceEnvFor = (env: CliEnvironment): ServiceEnvironment => ({
  ...(env.homeDir !== undefined ? { homeDir: env.homeDir } : {}),
  cwd: readWorkingDirectory(env),
  // The shell this was typed in, so an injected processEnv (tests, the
  // control API) decides the unit's PATH rather than this process.
  ...(readProcessEnv(env).PATH !== undefined ? { path: String(readProcessEnv(env).PATH) } : {}),
  ...(env.serviceRunner !== undefined ? { run: env.serviceRunner } : {}),
  ...(env.serviceSleep !== undefined ? { sleep: env.serviceSleep } : {}),
  ...(env.servicePlatform !== undefined ? { platform: env.servicePlatform } : {}),
});

/** Where a command aimed at "the running daemon" is pointed. */
interface RunningGatewayTarget {
  gateway?: string;
  token?: string;
}

/**
 * The control API base a command should talk to: `--gateway` when given,
 * else whatever daemon `~/.stratus/gateway.json` says is serving, else
 * nothing — the file is written when the API binds and removed when it
 * stops, so its absence means no daemon has said where it is.
 */
export const runningGatewayBase = async (env: CliEnvironment, target: RunningGatewayTarget): Promise<string | undefined> => {
  if (target.gateway) {
    return target.gateway.replace(/\/+$/, '');
  }
  const info = await readGatewayInfo(env);
  return info?.url.replace(/\/+$/, '');
};

/** One authenticated call to a daemon's control API, with the network and auth failures said plainly. */
export const callRunningGateway = async (
  env: CliEnvironment,
  target: RunningGatewayTarget,
  base: string,
  pathname: string,
  body?: Record<string, unknown>,
  method: 'GET' | 'POST' = 'POST',
  /** Gives up on the call — a probe must answer in bounded time even when the daemon cannot. */
  signal?: AbortSignal,
): Promise<Response> => {
  const token = await gatewayToken(env, target.token);
  const fetchImpl = env.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is unavailable, so this runtime cannot reach a daemon.');
  }
  let response: Response;
  try {
    response = await fetchImpl(`${base}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...(signal !== undefined ? { signal } : {}),
    });
  } catch (error) {
    throw new Error(
      `Could not reach the gateway at ${base} (${error instanceof Error ? error.message : String(error)}). `
      + 'Is stratusd running, and does it have @stratusagent/control-api installed?',
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`The gateway at ${base} rejected this token. Check --token, STRATUS_GATEWAY_TOKEN, or ~/.stratus/gateway-token.`);
  }
  return response;
};

/** The API's own sentence for a failure, or the status when it sent none. */
export const gatewayErrorMessage = async (response: Response): Promise<string> => {
  try {
    const payload = await response.json() as { error?: { message?: string } };
    if (payload.error?.message) {
      return payload.error.message;
    }
  } catch {
    // Not JSON; the status is all there is to say.
  }
  return `HTTP ${response.status}`;
};

export const noRunningDaemonMessage = (env: CliEnvironment): string =>
  `no running daemon found — ${gatewayInfoPath(env)} does not exist, and no --gateway was given. `
  + 'Start one with `stratus serve` or `stratus service start`; a daemon loads ~/.stratus/skills at start.';

/** What a running daemon published about itself, if one is running. */
interface GatewayInfo {
  url: string;
  pid?: number;
}

export const readGatewayInfo = async (env: CliEnvironment): Promise<GatewayInfo | undefined> => {
  try {
    const parsed = JSON.parse(await readFile(gatewayInfoPath(env), 'utf8')) as Partial<GatewayInfo>;
    return typeof parsed.url === 'string' ? { url: parsed.url, ...(parsed.pid ? { pid: parsed.pid } : {}) } : undefined;
  } catch {
    // No file, or one left behind by a daemon that died without cleaning up.
    // Either way there is nothing to talk to until the health check says so.
    return undefined;
  }
};

/** Whether something is actually answering there, as opposed to a stale file. */
export const gatewayAnswering = async (
  env: CliEnvironment,
  base: string,
  fetchImpl: typeof fetch,
): Promise<boolean> => {
  try {
    const token = await gatewayToken(env, undefined);
    const response = await fetchImpl(`${base}/api/v1/health`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return response.ok;
  } catch {
    return false;
  }
};

/**
 * Whether a process with this pid exists. EPERM is an answer — the process
 * is there, it is just not ours to signal.
 */
const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * The error for a home another daemon holds (see `claimHome` in
 * @stratusagent/gateway — the claim is what decides; this only says who).
 *
 * The discovery file names the holder when it has one to name: a daemon
 * that has bound its API. Read for the message alone, and only trusted as
 * far as a live pid — a daemon still starting has not written it, a
 * daemon draining its last turn has already removed it, and a SIGKILLed
 * one leaves it behind for the next pid to inherit. Not probed over HTTP:
 * a `STRATUS_GATEWAY_TOKEN` exported for some remote gateway would answer
 * 401 for the local one, and the claim needs no second opinion.
 */
/**
 * `stratus serve` refused because another daemon holds the home. Its own
 * type so `stratus dashboard` can tell "a daemon is there, wait for it to
 * publish" from "the daemon could not start".
 */
export class HomeHeldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HomeHeldError';
  }
}

/**
 * Whether a daemon from before the lock existed is serving this home.
 *
 * Such a daemon — alive across an upgrade that did not stop it — never
 * took the claim, so the claim alone cannot see it. The discovery file it
 * published is its only trace, held to the two proofs the lock made
 * unnecessary for everything since: the pid it names is alive, and its
 * URL answers `/health` with this home's own token file — never the
 * `STRATUS_GATEWAY_TOKEN` override, which names some other gateway and
 * would make a live daemon read as absent. A stale file fails either
 * proof and refuses nothing.
 */
export const legacyDaemonServing = async (env: CliEnvironment): Promise<boolean> => {
  const info = await readGatewayInfo(env);
  if (info?.pid === undefined || info.pid === process.pid || !processAlive(info.pid)) {
    return false;
  }
  const fetchImpl = env.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return false;
  }
  try {
    const token = (await readFile(gatewayTokenPath(env), 'utf8')).trim();
    const response = await fetchImpl(`${info.url}/api/v1/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
};

export const describeHeldHome = async (env: CliEnvironment): Promise<string> => {
  const info = await readGatewayInfo(env);
  const holder = info?.pid !== undefined && processAlive(info.pid)
    ? ` (pid ${info.pid}, ${info.url})`
    : ' — one that is still starting, or still draining its last turns';
  return `stratusd is already running for this home${holder}. Two daemons on one ~/.stratus `
    + 'would each fire the other\'s schedules and re-ask its approvals. Stop it first: `stratus service stop` '
    + 'if it is the installed service, otherwise Ctrl+C where it runs — and let it finish; it holds the home until '
    + 'its last turn is written.';
};

/** What a running daemon said each channel did with a reload; see `reloadRunningDaemonChannels`. */
export interface DaemonChannelReload {
  base: string;
  channels: Array<{ name: string; outcome: string; reason?: string }>;
}

/**
 * After channel secrets were stored or removed: if a daemon says it is
 * running, reload its roster, which reloads every channel that can (card
 * 894), and return what each did. Undefined when no daemon says so, so the
 * caller keeps its own line about the next start. A daemon that answers
 * with an error gives a warning, never a failure: the secret is stored
 * either way.
 */
export const reloadRunningDaemonChannels = async (
  env: CliEnvironment,
): Promise<DaemonChannelReload | { warning: string } | undefined> => {
  const info = await readGatewayInfo(env);
  if (!info) {
    return undefined;
  }
  const base = info.url.replace(/\/+$/, '');
  try {
    const response = await callRunningGateway(env, {}, base, '/api/v1/roster/reload');
    if (!response.ok) {
      throw new Error(await gatewayErrorMessage(response));
    }
    const { channels } = await response.json() as { channels?: unknown };
    // A daemon from before reloadable channels answers with no list: it
    // reloads nothing, so it reads secrets at its next start.
    return {
      base,
      channels: Array.isArray(channels)
        ? channels.filter((entry): entry is { name: string; outcome: string; reason?: string } =>
          typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string'
          && typeof (entry as { outcome?: unknown }).outcome === 'string')
        : [],
    };
  } catch (error) {
    return {
      warning: `${gatewayInfoPath(env)} names a daemon at ${base}, but it did not reload: `
        + `${error instanceof Error ? error.message : String(error)} If it is running, apply this with: stratus restart`,
    };
  }
};

/** Whether `kind` picked up a reload, as one line for the operator. */
export const channelReloadLine = (reload: DaemonChannelReload, kind: string): string => {
  const entry = reload.channels.find((channel) => channel.name === kind);
  if (entry?.outcome === 'reloaded') {
    return `The running daemon (${reload.base}) reloaded ${kind}, so this applies now, with no restart. \`stratus logs\` shows each app as it connects.`;
  }
  if (entry?.outcome === 'still-reloading') {
    return `The running daemon (${reload.base}) is still reloading ${kind}; \`stratus logs\` shows when it's done, and \`stratus restart\` applies it if it doesn't finish.`;
  }
  if (entry?.outcome === 'failed') {
    return `The running daemon (${reload.base}) could not reload ${kind}${entry.reason ? ` (${entry.reason})` : ''}, so this applies at its next start: \`stratus restart\`.`;
  }
  return `The running daemon (${reload.base}) doesn't reload ${kind}, so this applies at its next start: \`stratus restart\`.`;
};
