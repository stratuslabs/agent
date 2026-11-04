/*
 * `stratus serve` and `stratus dashboard`: the long-running processes.
 */
import { type ParsedHelpCommand, readOptionValue } from './shared.ts';

export interface ParsedDashboardCommand {
  command: 'dashboard';
  port?: number;
  /**
   * Present only when `--host` was actually given.
   *
   * A defaulted string here would be indistinguishable from an explicit
   * `--host 127.0.0.1`, and the two mean opposite things when a trusted
   * config says `api.host: "0.0.0.0"`: absent means "let the config decide",
   * while explicit means "bind loopback, whatever the config says". Collapsing
   * them exposed the API on every interface to an operator who had just asked
   * for the opposite.
   */
  host?: string;
  openBrowser: boolean;
}

export type ServeApprovalMode = 'headless' | 'remote';

export interface ParsedServeCommand {
  command: 'serve';
  configPath?: string;
  /** Overrides `approvals.mode` in the config file. */
  approvals?: ServeApprovalMode;
  /** Watchdog idle timeout in milliseconds. 0 disables. */
  idleTimeoutMs?: number;
  events: boolean;
  /** Write the structured log to ~/.stratus/logs. Defaults to true. */
  logToFile?: boolean;
  /**
   * What stdout carries. Absent means `text`: the human lines a terminal
   * wants. `json` writes every structured log record to stdout as one JSON
   * line instead, for a container runtime or journald that ships stdout —
   * and nothing else, since a stray human line is a parse error there.
   */
  logFormat?: 'text' | 'json';
  /** Start held: health only until `POST /api/v1/promote` (see `GatewayOptions.held`). */
  held?: boolean;
  /** Hold only a version this home has not promoted yet (see `promotion.ts`). */
  holdNewVersion?: boolean;
  /** Serve the control API. Defaults to true when the package is installed. */
  api?: boolean;
  /** Overrides `api.port` in the config file. */
  apiPort?: number;
  /** Overrides `api.host` in the config file. */
  apiHost?: string;
  /** Overrides `events.listen.host` in the config file. */
  eventsHost?: string;
}

export const parseDashboardCommand = (rest: string[]): ParsedDashboardCommand | ParsedHelpCommand => {
  let port: number | undefined;
  let host: string | undefined;
  let openBrowser = true;

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token) {
      continue;
    }
    if (token === '--help' || token === '-h') {
      return { command: 'help' };
    }
    if (token === '--port') {
      const value = Number(readOptionValue(rest, index, '--port'));
      if (!Number.isInteger(value) || value < 0 || value > 65535) {
        throw new Error(`Invalid value for --port: ${rest[index + 1] ?? '(missing)'}`);
      }
      port = value;
      index += 1;
      continue;
    }
    if (token === '--host') {
      host = readOptionValue(rest, index, '--host');
      index += 1;
      continue;
    }
    if (token === '--no-open') {
      openBrowser = false;
      continue;
    }
    throw new Error(`Unknown option: ${token}`);
  }

  return {
    command: 'dashboard',
    ...(port !== undefined ? { port } : {}),
    ...(host !== undefined ? { host } : {}),
    openBrowser,
  };
};

export const parseServeCommand = (rest: string[]): ParsedServeCommand | ParsedHelpCommand => {
  const parsed: ParsedServeCommand = { command: 'serve', events: true };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token) {
      continue;
    }
    if (token === '--help' || token === '-h') {
      return { command: 'help' };
    }
    if (token === '--config') {
      parsed.configPath = readOptionValue(rest, index, '--config');
      index += 1;
      continue;
    }
    if (token === '--idle-timeout') {
      const seconds = Number(readOptionValue(rest, index, '--idle-timeout'));
      if (!Number.isFinite(seconds) || seconds < 0) {
        throw new Error(`Invalid value for --idle-timeout: ${rest[index + 1] ?? '(missing)'}`);
      }
      parsed.idleTimeoutMs = Math.round(seconds * 1000);
      index += 1;
      continue;
    }
    if (token === '--approvals') {
      const value = readOptionValue(rest, index, '--approvals');
      if (value !== 'headless' && value !== 'remote') {
        throw new Error(`Unsupported approvals mode: ${value}. Use headless or remote.`);
      }
      parsed.approvals = value;
      index += 1;
      continue;
    }
    if (token === '--no-events') {
      parsed.events = false;
      continue;
    }
    if (token === '--no-log-file') {
      parsed.logToFile = false;
      continue;
    }
    if (token === '--log-format') {
      const value = readOptionValue(rest, index, '--log-format');
      if (value !== 'text' && value !== 'json') {
        throw new Error(`Unsupported --log-format: ${value}. Use text or json.`);
      }
      parsed.logFormat = value;
      index += 1;
      continue;
    }
    if (token === '--no-api') {
      parsed.api = false;
      continue;
    }
    if (token === '--held') {
      parsed.held = true;
      continue;
    }
    if (token === '--hold-new-version') {
      parsed.holdNewVersion = true;
      continue;
    }
    if (token === '--api') {
      parsed.api = true;
      continue;
    }
    if (token === '--api-port') {
      const port = Number(readOptionValue(rest, index, '--api-port'));
      if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        throw new Error(`Invalid value for --api-port: ${rest[index + 1] ?? '(missing)'}`);
      }
      parsed.apiPort = port;
      index += 1;
      continue;
    }
    if (token === '--api-host') {
      parsed.apiHost = readOptionValue(rest, index, '--api-host');
      index += 1;
      continue;
    }
    if (token === '--events-host') {
      parsed.eventsHost = readOptionValue(rest, index, '--events-host');
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${token}`);
  }
  return parsed;
};
