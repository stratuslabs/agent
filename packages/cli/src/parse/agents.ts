/*
 * `stratus setup`, `stratus agent new` and `stratus agents`: making agents
 * and listing them.
 */
import { type ParsedHelpCommand, readOptionValue } from './shared.ts';

export interface ParsedSetupCommand {
  command: 'setup';
  configPath?: string;
}

export interface ParsedAgentNewCommand {
  command: 'agent-new';
  name?: string;
  instructions?: string;
  format: 'text' | 'json' | 'soul';
}

export interface ParsedAgentsCommand {
  command: 'agents';
  format: 'text' | 'json';
  /**
   * Ask a running gateway instead of resolving locally. The first
   * remote-consuming command: the same listing, rendered from the control
   * API's answer rather than from this machine's files.
   */
  gateway?: string;
  /** Bearer token override, for a gateway whose token file is not local. */
  token?: string;
}

export const parseAgentsCommand = (command: 'agents' | 'agent', rest: string[]): ParsedAgentsCommand | ParsedHelpCommand => {
  const agentsRest = command === 'agents' ? rest : rest.slice(1);
  let format: 'text' | 'json' = 'text';
  let gateway: string | undefined;
  let token: string | undefined;
  for (let index = 0; index < agentsRest.length; index += 1) {
    const argument = agentsRest[index];
    if (!argument) {
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      return { command: 'help' };
    }
    if (argument === '--format') {
      const value = readOptionValue(agentsRest, index, '--format');
      if (value !== 'text' && value !== 'json') {
        throw new Error(`Unsupported format: ${value}`);
      }
      format = value;
      index += 1;
      continue;
    }
    if (argument === '--gateway') {
      gateway = readOptionValue(agentsRest, index, '--gateway');
      index += 1;
      continue;
    }
    if (argument === '--token') {
      token = readOptionValue(agentsRest, index, '--token');
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  if (token !== undefined && gateway === undefined) {
    throw new Error('--token only applies with --gateway.');
  }
  return {
    command: 'agents',
    format,
    ...(gateway ? { gateway } : {}),
    ...(token ? { token } : {}),
  };
};

export const parseAgentCommand = (rest: string[]): ParsedAgentNewCommand | ParsedHelpCommand => {
  const [subcommand, ...agentRest] = rest;
  if (subcommand === '--help' || subcommand === '-h') {
    return { command: 'help' };
  }
  if (subcommand !== 'new') {
    throw new Error(`Unknown agent subcommand: ${subcommand ?? '(missing)'}. Try: stratus agent new, stratus agent list`);
  }

  let name: string | undefined;
  let instructions: string | undefined;
  let format: 'text' | 'json' | 'soul' = 'text';

  for (let index = 0; index < agentRest.length; index += 1) {
    const token = agentRest[index];
    if (!token) {
      continue;
    }
    if (token === '--help' || token === '-h') {
      return { command: 'help' };
    }
    if (token === '--name') {
      name = readOptionValue(agentRest, index, '--name');
      index += 1;
      continue;
    }
    if (token === '--instructions') {
      instructions = readOptionValue(agentRest, index, '--instructions');
      index += 1;
      continue;
    }
    if (token === '--format') {
      const value = readOptionValue(agentRest, index, '--format');
      if (value !== 'text' && value !== 'json' && value !== 'soul') {
        throw new Error(`Unsupported format: ${value}`);
      }
      format = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${token}`);
  }

  return {
    command: 'agent-new',
    ...(name ? { name } : {}),
    ...(instructions ? { instructions } : {}),
    format,
  };
};

export const parseSetupCommand = (rest: string[]): ParsedSetupCommand | ParsedHelpCommand => {
  let configPath: string | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token) {
      continue;
    }
    if (token === '--help' || token === '-h') {
      return { command: 'help' };
    }
    if (token === '--config') {
      configPath = readOptionValue(rest, index, '--config');
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${token}`);
  }

  return { command: 'setup', ...(configPath ? { configPath } : {}) };
};
