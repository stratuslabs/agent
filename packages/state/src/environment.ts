import os from 'node:os';
import type { ClaudeCodeQueryFn } from '@stratusagent/provider-claude-code';
import type { CodexRunTurn } from '@stratusagent/provider-codex';

/**
 * Where Stratus state lives and how the process environment is read. Every
 * function in this package takes one of these instead of touching process
 * globals directly, so the CLI, the gateway, and tests can each pin their
 * own home directory and environment.
 */
export interface StateEnvironment {
  processEnv?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Home directory override (tests). Defaults to os.homedir(). */
  homeDir?: string;
  fetch?: typeof fetch;
  /**
   * The Agent SDK transport, for the same reason `fetch` is here: an
   * environment can pin how a run reaches the outside world. Without it
   * the subscription path is the one runtime nothing can drive except by
   * launching Claude Code for real.
   */
  queryFn?: ClaudeCodeQueryFn;
  /**
   * The Codex harness transport — `queryFn`'s counterpart for the third
   * provider shape. Without it the codex runtime is the one nothing can
   * drive except by launching the codex binary for real.
   */
  codexRunTurn?: CodexRunTurn;
}

export const readProcessEnv = (env: StateEnvironment): NodeJS.ProcessEnv => env.processEnv ?? process.env;

export const readWorkingDirectory = (env: StateEnvironment): string => env.cwd ?? process.cwd();

export const readHomeDirectory = (env: StateEnvironment): string => env.homeDir ?? os.homedir();

export const readNonEmptyString = <T = string>(
  value: string | undefined,
  map?: (resolved: string) => T,
): T | string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  return map ? map(trimmed) : trimmed;
};
