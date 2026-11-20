/*
 * `stratus tasks`: the running daemon's background tasks, and cancelling one.
 */
import { type ParsedHelpCommand, readFormatValue, readOptionValue } from './shared.ts';

export interface ParsedTasksCommand {
  command: 'tasks';
  action: 'list' | 'cancel';
  /** The task to cancel, for `cancel`. */
  taskId?: string;
  /** Only the tasks this agent started, for `list`. */
  agentId?: string;
  format: 'text' | 'json';
  gateway?: string;
  token?: string;
}

const TRY = 'Try: stratus tasks [--agent <id>], stratus tasks cancel <id>';

export const parseTasksCommand = (rest: string[]): ParsedTasksCommand | ParsedHelpCommand => {
  const action = rest[0] === 'cancel' ? 'cancel' : 'list';
  const tokens = action === 'cancel' ? rest.slice(1) : rest;
  const parsed: ParsedTasksCommand = { command: 'tasks', action, format: 'text' };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }
    if (token === '--help' || token === '-h') {
      return { command: 'help' };
    }
    if (token === '--agent' && action === 'list') {
      parsed.agentId = readOptionValue(tokens, index, '--agent');
      index += 1;
      continue;
    }
    if (token === '--format') {
      parsed.format = readFormatValue(tokens, index, ['text', 'json']);
      index += 1;
      continue;
    }
    if (token === '--gateway') {
      parsed.gateway = readOptionValue(tokens, index, '--gateway');
      index += 1;
      continue;
    }
    if (token === '--token') {
      parsed.token = readOptionValue(tokens, index, '--token');
      index += 1;
      continue;
    }
    if (token.startsWith('-')) {
      throw new Error(`Unknown option: ${token}`);
    }
    if (action === 'cancel' && parsed.taskId === undefined) {
      parsed.taskId = token;
      continue;
    }
    throw new Error(`Unexpected argument: ${token}. ${TRY}`);
  }
  if (action === 'cancel' && parsed.taskId === undefined) {
    throw new Error('tasks cancel needs the task id: stratus tasks cancel <id>. `stratus tasks` lists them.');
  }
  return parsed;
};
