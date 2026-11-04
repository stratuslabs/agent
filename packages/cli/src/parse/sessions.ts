/*
 * `stratus sessions` and `stratus session`: listing sessions by status and
 * acting on one.
 */
import type { SessionStatus } from '@stratusagent/core';

import { type ParsedHelpCommand, readOptionValue } from './shared.ts';

export interface ParsedSessionCommand {
  command: 'session';
  action: 'rollover';
  sessionId: string;
  gateway?: string;
  token?: string;
}

export interface ParsedSessionsCommand {
  command: 'sessions';
  agentId?: string;
  /**
   * A session status, or `stopped-early`: completed sessions whose message
   * ended in a wrap-up (`Session.stoppedEarly`). Not a status, because
   * `completed` is still true of them.
   */
  status?: SessionStatus | typeof STOPPED_EARLY_FILTER;
  /** How many to show, newest first; the command's default when unset. */
  limit?: number;
  format: 'text' | 'json';
  gateway?: string;
  token?: string;
}

// A record rather than a list, so a status added to `SessionStatus` fails
// the build here instead of being refused as a typo at the command line.
const SESSION_STATUS_NAMES: Record<SessionStatus, true> = {
  idle: true,
  running: true,
  pending_approval: true,
  completed: true,
  failed: true,
};

export const SESSION_STATUSES = Object.keys(SESSION_STATUS_NAMES) as SessionStatus[];

const isSessionStatus = (value: string): value is SessionStatus => Object.hasOwn(SESSION_STATUS_NAMES, value);

/** `stratus sessions --status stopped-early`; see `ParsedSessionsCommand.status`. */
export const STOPPED_EARLY_FILTER = 'stopped-early';

export const parseSessionsCommand = (command: 'sessions' | 'session', rest: string[]): ParsedSessionsCommand | ParsedHelpCommand => {
  const sessionsRest = command === 'sessions' ? rest : rest.slice(1);
  const parsed: ParsedSessionsCommand = { command: 'sessions', format: 'text' };
  for (let index = 0; index < sessionsRest.length; index += 1) {
    const token = sessionsRest[index];
    if (!token) {
      continue;
    }
    if (token === '--help' || token === '-h') {
      return { command: 'help' };
    }
    if (token === '--agent') {
      parsed.agentId = readOptionValue(sessionsRest, index, '--agent');
      index += 1;
      continue;
    }
    if (token === '--status') {
      const value = readOptionValue(sessionsRest, index, '--status');
      if (!isSessionStatus(value) && value !== STOPPED_EARLY_FILTER) {
        throw new Error(`Unknown status: ${value}. One of: ${[...SESSION_STATUSES, STOPPED_EARLY_FILTER].join(', ')}`);
      }
      parsed.status = value;
      index += 1;
      continue;
    }
    if (token === '--limit') {
      const value = readOptionValue(sessionsRest, index, '--limit');
      if (!/^\d+$/.test(value) || Number(value) < 1) {
        throw new Error(`--limit takes a whole number of 1 or more, not ${value}`);
      }
      parsed.limit = Number(value);
      index += 1;
      continue;
    }
    if (token === '--format') {
      const value = readOptionValue(sessionsRest, index, '--format');
      if (value !== 'text' && value !== 'json') {
        throw new Error(`Unsupported format: ${value}`);
      }
      parsed.format = value;
      index += 1;
      continue;
    }
    if (token === '--gateway') {
      parsed.gateway = readOptionValue(sessionsRest, index, '--gateway');
      index += 1;
      continue;
    }
    if (token === '--token') {
      parsed.token = readOptionValue(sessionsRest, index, '--token');
      index += 1;
      continue;
    }
    if (token.startsWith('-')) {
      throw new Error(`Unknown option: ${token}`);
    }
    throw new Error(`Unexpected argument: ${token}. Try: stratus sessions [--agent <id>] [--status <status>]`);
  }
  return parsed;
};

export const parseSessionCommand = (rest: string[]): ParsedSessionCommand | ParsedHelpCommand => {
  const [action, ...sessionRest] = rest;
  if (action === undefined || action === '--help' || action === '-h') {
    return { command: 'help' };
  }
  if (action !== 'rollover') {
    throw new Error(`Unknown session subcommand: ${action}. Try: stratus session rollover <session-id>, stratus sessions`);
  }
  const parsed: ParsedSessionCommand = { command: 'session', action: 'rollover', sessionId: '' };
  for (let index = 0; index < sessionRest.length; index += 1) {
    const token = sessionRest[index];
    if (!token) {
      continue;
    }
    if (token === '--help' || token === '-h') {
      return { command: 'help' };
    }
    if (token === '--gateway') {
      parsed.gateway = readOptionValue(sessionRest, index, '--gateway');
      index += 1;
      continue;
    }
    if (token === '--token') {
      parsed.token = readOptionValue(sessionRest, index, '--token');
      index += 1;
      continue;
    }
    if (token.startsWith('--')) {
      throw new Error(`Unknown option: ${token}`);
    }
    if (parsed.sessionId.length > 0) {
      throw new Error(`Unexpected argument: ${token}. Try: stratus session rollover <session-id>`);
    }
    parsed.sessionId = token;
  }
  if (parsed.sessionId.length === 0) {
    throw new Error('session rollover needs the session id: stratus session rollover <session-id>. `stratus logs` shows ids in its last column.');
  }
  return parsed;
};
