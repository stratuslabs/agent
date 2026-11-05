/*
 * `stratus run` and `stratus chat`: a prompt, or a conversation, against one
 * provider, and the approval mode either uses when none was given.
 */
import { parseProviderName } from '@stratusagent/state';

import type { CliEnvironment } from '../environment.ts';
import {
  type CliApprovalMode,
  type CliProviderName,
  type ParsedHelpCommand,
  readFormatValue,
  readOptionValue,
  readPromptFromEnvironment,
} from './shared.ts';

export interface ParsedRunCommand {
  command: 'run';
  prompt: string;
  provider?: CliProviderName;
  model?: string;
  baseUrl?: string;
  configPath?: string;
  /** Path to a soul file defining the agent to run as. */
  soul?: string;
  format: 'text' | 'json';
  events: boolean;
  /** Absent when `--approvals` was not given: see `defaultApprovalMode`. */
  approvals?: CliApprovalMode;
  maxTurns?: number;
}

export interface ParsedChatCommand {
  command: 'chat';
  provider?: CliProviderName;
  model?: string;
  baseUrl?: string;
  configPath?: string;
  /** Path to a soul file defining the agent to chat with. */
  soul?: string;
  events: boolean;
  /** Absent when `--approvals` was not given: see `defaultApprovalMode`. */
  approvals?: CliApprovalMode;
  maxTurns?: number;
}

export const parseChatCommand = (rest: string[]): ParsedChatCommand | ParsedHelpCommand => {
  const parsed: ParsedChatCommand = { command: 'chat', events: false };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token) {
      continue;
    }
    if (token === '--help' || token === '-h') {
      return { command: 'help' };
    }
    if (token === '--provider') {
      parsed.provider = parseProviderName(readOptionValue(rest, index, '--provider'), '--provider');
      index += 1;
      continue;
    }
    if (token === '--model') {
      parsed.model = readOptionValue(rest, index, '--model');
      index += 1;
      continue;
    }
    if (token === '--base-url') {
      parsed.baseUrl = readOptionValue(rest, index, '--base-url');
      index += 1;
      continue;
    }
    if (token === '--soul') {
      parsed.soul = readOptionValue(rest, index, '--soul');
      index += 1;
      continue;
    }
    if (token === '--config') {
      parsed.configPath = readOptionValue(rest, index, '--config');
      index += 1;
      continue;
    }
    if (token === '--approvals') {
      const value = readOptionValue(rest, index, '--approvals');
      if (value !== 'always' && value !== 'open' && value !== 'ask' && value !== 'gated' && value !== 'never') {
        throw new Error(`Invalid value for --approvals: ${value}`);
      }
      parsed.approvals = value;
      index += 1;
      continue;
    }
    if (token === '--max-turns') {
      const value = Number(readOptionValue(rest, index, '--max-turns'));
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`Invalid value for --max-turns: ${rest[index + 1] ?? '(missing)'}`);
      }
      parsed.maxTurns = value;
      index += 1;
      continue;
    }
    if (token === '--events') {
      parsed.events = true;
      continue;
    }
    throw new Error(`Unknown option: ${token}`);
  }
  return parsed;
};

export const parseRunCommand = (rest: string[], env: CliEnvironment): ParsedRunCommand | ParsedHelpCommand => {
  let prompt = '';
  let provider: CliProviderName | undefined;
  let model: string | undefined;
  let baseUrl: string | undefined;
  let configPath: string | undefined;
  let soul: string | undefined;
  let format: 'text' | 'json' = 'text';
  let events = true;
  let approvals: CliApprovalMode | undefined;
  let maxTurns: number | undefined;
  let useStdin = false;
  const positionals: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];

    if (!token) {
      continue;
    }

    if (token === '--help' || token === '-h') {
      return { command: 'help' };
    }

    if (token === '--prompt' || token === '-p') {
      prompt = readOptionValue(rest, index, '--prompt');
      index += 1;
      continue;
    }

    if (token === '--stdin') {
      useStdin = true;
      continue;
    }

    if (token === '--provider') {
      provider = parseProviderName(readOptionValue(rest, index, '--provider'), '--provider');
      index += 1;
      continue;
    }

    if (token === '--model') {
      model = readOptionValue(rest, index, '--model');
      index += 1;
      continue;
    }

    if (token === '--base-url') {
      baseUrl = readOptionValue(rest, index, '--base-url');
      index += 1;
      continue;
    }

    if (token === '--config') {
      configPath = readOptionValue(rest, index, '--config');
      index += 1;
      continue;
    }

    if (token === '--soul') {
      soul = readOptionValue(rest, index, '--soul');
      index += 1;
      continue;
    }

    if (token === '--format') {
      format = readFormatValue(rest, index, ['text', 'json']);
      index += 1;
      continue;
    }

    if (token === '--no-events') {
      events = false;
      continue;
    }

    if (token === '--approvals') {
      const value = readOptionValue(rest, index, '--approvals');
      if (value !== 'always' && value !== 'open' && value !== 'ask' && value !== 'gated' && value !== 'never') {
        throw new Error(`Unsupported approvals mode: ${value}. Use always, open, ask, gated, or never.`);
      }
      approvals = value;
      index += 1;
      continue;
    }

    if (token === '--max-turns') {
      const value = Number(readOptionValue(rest, index, '--max-turns'));
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`Invalid value for --max-turns: ${rest[index + 1] ?? '(missing)'}`);
      }
      maxTurns = value;
      index += 1;
      continue;
    }

    if (token.startsWith('-')) {
      throw new Error(`Unknown option: ${token}`);
    }

    positionals.push(token);
  }

  if (!prompt) {
    prompt = positionals.join(' ').trim();
  }

  if (!prompt && useStdin) {
    prompt = readPromptFromEnvironment(env);
  }

  if (!prompt) {
    throw new Error('A prompt is required. Pass it with --prompt, --stdin, or as a positional argument.');
  }

  if ((approvals === 'ask' || approvals === 'gated' || approvals === 'open') && useStdin) {
    throw new Error(`--approvals ${approvals} cannot be combined with --stdin because both read from standard input.`);
  }

  return {
    command: 'run',
    prompt,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(configPath ? { configPath } : {}),
    ...(soul ? { soul } : {}),
    format,
    events,
    ...(approvals !== undefined ? { approvals } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  };
};

/**
 * The approval mode a run or chat uses when `--approvals` was not given.
 *
 * At a terminal the person is right there, so a gated call asks and a
 * safe one runs, which is `gated` — the old default of `always` ran
 * `shell.run` on whatever a page or a soul talked the model into, with
 * nobody told. Anywhere else — a pipe, a script, `--stdin`, where the
 * prompt already consumed the terminal — nobody can answer a y/N, and the
 * run keeps its unattended behavior, saying so once on stderr when a
 * gated call runs (see `createApprovalPolicy`).
 */
export const defaultApprovalMode = (env: CliEnvironment, promptFromStdin = false): CliApprovalMode => {
  const terminal = env.terminal
    ?? (env.stdinStream === undefined && env.stdin === undefined && process.stdin.isTTY === true);
  return terminal && !promptFromStdin ? 'gated' : 'always';
};
