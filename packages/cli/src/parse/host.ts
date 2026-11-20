/*
 * `stratus doctor`, `stratus update`, `stratus service` and `stratus logs`:
 * this machine's install, its service and its logs.
 */
import { type ParsedHelpCommand, readFormatValue, readOptionValue } from './shared.ts';

export interface ParsedDoctorCommand {
  command: 'doctor';
  format: 'text' | 'json';
  configPath?: string;
  /** Also ask each provider a run uses whether it accepts the key (network). */
  live?: boolean;
}

export interface ParsedUpdateCommand {
  command: 'update';
  /** Report what an update would do — version, migrations, unit health — without doing any of it. */
  check: boolean;
}

export interface ParsedServiceCommand {
  command: 'service';
  action: 'install' | 'uninstall' | 'status' | 'start' | 'stop';
  /** install only: start automatically at login. Defaults to true. */
  runAtLogin?: boolean;
  /** install only: the config the managed daemon should load. */
  configPath?: string;
}

export interface ParsedLogsCommand {
  command: 'logs';
  /** Keep streaming new records instead of exiting after the backlog. */
  follow: boolean;
  /** How many recent records to show before following. */
  limit: number;
  agentId?: string;
  sessionId?: string;
  format: 'text' | 'json';
}

export const parseDoctorCommand = (rest: string[]): ParsedDoctorCommand | ParsedHelpCommand => {
  let format: 'text' | 'json' = 'text';
  let configPath: string | undefined;
  let live = false;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token) {
      continue;
    }
    if (token === '--help' || token === '-h') {
      return { command: 'help' };
    }
    if (token === '--format') {
      format = readFormatValue(rest, index, ['text', 'json']);
      index += 1;
      continue;
    }
    if (token === '--config') {
      configPath = readOptionValue(rest, index, '--config');
      index += 1;
      continue;
    }
    if (token === '--live') {
      live = true;
      continue;
    }
    throw new Error(`Unknown option: ${token}`);
  }
  return { command: 'doctor', format, ...(configPath ? { configPath } : {}), ...(live ? { live } : {}) };
};

export const parseUpdateCommand = (rest: string[]): ParsedUpdateCommand | ParsedHelpCommand => {
  let check = false;
  for (const token of rest) {
    if (!token) {
      continue;
    }
    if (token === '--help' || token === '-h') {
      return { command: 'help' };
    }
    if (token === '--check') {
      check = true;
      continue;
    }
    throw new Error(`Unknown option: ${token}`);
  }
  return { command: 'update', check };
};

export const parseServiceCommand = (rest: string[]): ParsedServiceCommand | ParsedHelpCommand => {
  const action = rest[0];
  if (action === '--help' || action === '-h' || action === undefined) {
    return { command: 'help' };
  }
  if (action !== 'install' && action !== 'uninstall' && action !== 'status' && action !== 'start' && action !== 'stop') {
    throw new Error(`Unknown service action: ${action} (expected install, uninstall, status, start, or stop)`);
  }
  const parsed: ParsedServiceCommand = { command: 'service', action };
  const serviceRest = rest.slice(1);
  for (let index = 0; index < serviceRest.length; index += 1) {
    const token = serviceRest[index];
    if (!token) {
      continue;
    }
    if (token === '--help' || token === '-h') {
      return { command: 'help' };
    }
    if (token === '--no-login') {
      if (action !== 'install') {
        throw new Error('--no-login applies to `stratus service install`.');
      }
      parsed.runAtLogin = false;
      continue;
    }
    if (token === '--config') {
      if (action !== 'install') {
        throw new Error('--config applies to `stratus service install`.');
      }
      parsed.configPath = readOptionValue(serviceRest, index, '--config');
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${token}`);
  }
  return parsed;
};

export const parseLogsCommand = (rest: string[]): ParsedLogsCommand | ParsedHelpCommand => {
  let follow = false;
  let limit = 50;
  let agentId: string | undefined;
  let sessionId: string | undefined;
  let format: 'text' | 'json' = 'text';
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token) {
      continue;
    }
    if (token === '--help' || token === '-h') {
      return { command: 'help' };
    }
    if (token === '--follow' || token === '-f') {
      follow = true;
      continue;
    }
    if (token === '--lines' || token === '-n') {
      const value = Number(readOptionValue(rest, index, token));
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`Invalid value for ${token}: ${rest[index + 1] ?? '(missing)'}`);
      }
      limit = Math.floor(value);
      index += 1;
      continue;
    }
    if (token === '--agent') {
      agentId = readOptionValue(rest, index, '--agent');
      index += 1;
      continue;
    }
    if (token === '--session') {
      sessionId = readOptionValue(rest, index, '--session');
      index += 1;
      continue;
    }
    if (token === '--format') {
      format = readFormatValue(rest, index, ['text', 'json']);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${token}`);
  }
  return {
    command: 'logs',
    follow,
    limit,
    format,
    ...(agentId ? { agentId } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
};
