/*
 * `stratus restart`, `stratus health`, `stratus events` and
 * `stratus schedules`: asking the running gateway, or telling it.
 */
import { type ParsedHelpCommand, readOptionValue } from './shared.ts';

export interface ParsedRestartCommand {
  command: 'restart';
  /** For the daemon's log. */
  reason?: string;
  /** How long the daemon lets in-flight turns finish, in milliseconds. */
  drainTimeoutMs?: number;
  gateway?: string;
  token?: string;
}

export interface ParsedHealthCommand {
  command: 'health';
  /** A daemon's control API URL; default: the one `~/.stratus/gateway.json` names. */
  gateway?: string;
  token?: string;
  format: 'text' | 'json';
}

/** `stratus events`: what the running daemon's events port has been doing (card 590). */
export interface ParsedEventsCommand {
  command: 'events';
  gateway?: string;
  token?: string;
  format: 'text' | 'json';
}

export interface ParsedSchedulesCommand {
  command: 'schedules';
  action: 'list' | 'cancel';
  /** cancel only: which schedule. */
  scheduleId?: string;
  format: 'text' | 'json';
}

export const parseSchedulesCommand = (command: 'schedules' | 'schedule', rest: string[]): ParsedSchedulesCommand | ParsedHelpCommand => {
  const schedulesRest = command === 'schedules' ? rest : rest.slice(1);
  const action = (command === 'schedule' ? rest[0] : schedulesRest[0]) === 'cancel' ? 'cancel' : 'list';
  const tokens = action === 'cancel' && command === 'schedules' ? schedulesRest.slice(1) : schedulesRest;
  let format: 'text' | 'json' = 'text';
  let scheduleId: string | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || (action === 'list' && token === 'list' && index === 0)) {
      continue;
    }
    if (token === '--help' || token === '-h') {
      return { command: 'help' };
    }
    if (token === '--format') {
      const value = readOptionValue(tokens, index, '--format');
      if (value !== 'text' && value !== 'json') {
        throw new Error(`Unsupported format: ${value}`);
      }
      format = value;
      index += 1;
      continue;
    }
    if (token.startsWith('--')) {
      throw new Error(`Unknown option: ${token}`);
    }
    if (action === 'cancel' && scheduleId === undefined) {
      scheduleId = token;
      continue;
    }
    throw new Error(`Unexpected argument: ${token}. Try: stratus schedules, stratus schedules cancel <id>`);
  }
  if (action === 'cancel' && !scheduleId) {
    throw new Error('schedules cancel needs the schedule id: stratus schedules cancel <id>.');
  }
  return {
    command: 'schedules',
    action,
    ...(scheduleId ? { scheduleId } : {}),
    format,
  };
};

export const parseRestartCommand = (rest: string[]): ParsedRestartCommand | ParsedHelpCommand => {
  const parsed: ParsedRestartCommand = { command: 'restart' };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token) {
      continue;
    }
    if (token === '--help' || token === '-h') {
      return { command: 'help' };
    }
    if (token === '--reason') {
      parsed.reason = readOptionValue(rest, index, '--reason');
      index += 1;
      continue;
    }
    if (token === '--drain-timeout') {
      const seconds = Number(readOptionValue(rest, index, '--drain-timeout'));
      if (!Number.isFinite(seconds) || seconds < 0) {
        throw new Error(`Invalid value for --drain-timeout: ${rest[index + 1] ?? '(missing)'}`);
      }
      parsed.drainTimeoutMs = Math.round(seconds * 1000);
      index += 1;
      continue;
    }
    if (token === '--gateway') {
      parsed.gateway = readOptionValue(rest, index, '--gateway');
      index += 1;
      continue;
    }
    if (token === '--token') {
      parsed.token = readOptionValue(rest, index, '--token');
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${token}`);
  }
  return parsed;
};

export const parseHealthCommand = (command: 'health' | 'events', rest: string[]): ParsedHealthCommand | ParsedEventsCommand | ParsedHelpCommand => {
  // The same three options: both only ask the running daemon.
  const parsed: ParsedHealthCommand | ParsedEventsCommand = { command, format: 'text' };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token) {
      continue;
    }
    if (token === '--help' || token === '-h') {
      return { command: 'help' };
    }
    if (token === '--format') {
      const value = readOptionValue(rest, index, '--format');
      if (value !== 'text' && value !== 'json') {
        throw new Error(`Unsupported format: ${value}`);
      }
      parsed.format = value;
      index += 1;
      continue;
    }
    if (token === '--gateway') {
      parsed.gateway = readOptionValue(rest, index, '--gateway');
      index += 1;
      continue;
    }
    if (token === '--token') {
      parsed.token = readOptionValue(rest, index, '--token');
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${token}`);
  }
  return parsed;
};
