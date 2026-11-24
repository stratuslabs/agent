/*
 * What every command family's parser shares: the provider and approval
 * names, the help result any of them returns for --help, and reading an
 * option's value.
 */
import type { StratusProviderName } from '@stratusagent/state';

import type { CliEnvironment } from '../environment.ts';

export type CliProviderName = StratusProviderName;

export type CliApprovalMode = 'always' | 'open' | 'ask' | 'gated' | 'never';

export interface ParsedHelpCommand {
  command: 'help';
}

export const readPromptFromEnvironment = (env: CliEnvironment): string => (env.stdin ?? '').trim();

export const readOptionValue = (tokens: string[], index: number, flag: string): string => {
  const value = tokens[index + 1];
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
};

export const readFormatValue = <T extends string>(tokens: string[], index: number, allowed: readonly T[]): T => {
  const value = readOptionValue(tokens, index, '--format');
  const format = allowed.find((candidate) => candidate === value);
  if (format === undefined) {
    const choices = `${allowed.slice(0, -1).join(', ')} or ${allowed.at(-1)}`;
    throw new Error(`Unsupported --format: ${value}. Use ${choices}.`);
  }
  return format;
};
