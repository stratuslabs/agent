/*
 * `stratus memory`: an agent's remembered facts, listed, searched, changed,
 * exported and imported, and the memory passes that changed them.
 */
import { isTrustLevel, TRUST_LEVELS, type TrustLevel } from '@stratusagent/core';

import { type ParsedHelpCommand, readOptionValue } from './shared.ts';

export interface ParsedMemoryCommand {
  command: 'memory';
  action: 'list' | 'search' | 'forget' | 'audit' | 'pin' | 'unpin' | 'export' | 'import' | 'reassert' | 'passes' | 'undo-pass';
  agentId: string;
  /** list: show only entries at this label. reassert: the label to record. */
  trust?: TrustLevel;
  /** reassert, forget, pin, unpin: the entries to act on, by id. */
  ids: string[];
  /** reassert: every live entry currently reading `unknown` — the upgrade case. */
  allUnknown: boolean;
  /** search: the literal words to look for. */
  query?: string;
  /** search: how many hits, before the store's own clamp. passes: how many, newest first. */
  limit?: number;
  /** list: only what this memory pass wrote. undo-pass: the pass to take back. */
  pass?: string;
  /** export: where the JSONL goes; omitted means stdout. import: where it comes from. */
  file?: string;
  /**
   * import: keep each entry's recorded trust instead of re-labelling it
   * `external`. The migration path — moving an agent to a new machine,
   * where a person vouches for the file.
   */
  preserveTrust: boolean;
  format: 'text' | 'json';
}

/**
 * Which `stratus memory` subcommands write state — the append-only record
 * or the derived index under `~/.stratus`.
 *
 * Exported because two places need the same answer and a second hand-rolled
 * list drifts immediately: `main.ts` refuses a writer against a state stamp
 * newer than this build understands, and `runMemory` folds a legacy
 * per-directory store in only for a writer. They disagreed for exactly as
 * long as this was spelled out twice.
 */
export const memoryCommandWritesState = (action: ParsedMemoryCommand['action']): boolean =>
  action !== 'list' && action !== 'search' && action !== 'audit' && action !== 'export' && action !== 'passes';

// `search` is a read despite touching `memory.jsonl.index`, and the
// distinction is the one the stamp is about: the index is *derived*. An
// older build that opens it finds a stamp it does not know, rebuilds from
// the record, and the next newer build does the same in reverse — the
// failure direction is a rebuild, never data. Nothing under the newer
// format is discarded by it, and refusing would take away a diagnostic
// read at exactly the moment someone is trying to understand what their
// store holds, which is what the read-only exemption exists for.

export const parseMemoryCommand = (rest: string[]): ParsedMemoryCommand | ParsedHelpCommand => {
  const [action, ...memoryRest] = rest;
  if (action === undefined || action === '--help' || action === '-h') {
    return { command: 'help' };
  }
  const actions = ['list', 'search', 'forget', 'audit', 'pin', 'unpin', 'export', 'import', 'reassert', 'passes', 'undo-pass'] as const;
  if (!(actions as readonly string[]).includes(action)) {
    throw new Error(
      `Unknown memory subcommand: ${action}. Try one of ${actions.join(', ')} — for example stratus memory list <agent>.`,
    );
  }
  const memoryAction = action as ParsedMemoryCommand['action'];
  // Which subcommands take bare arguments after the agent, and what they
  // mean. Named here rather than re-tested at each branch, so adding a
  // subcommand is one line and not four.
  const takesIds = memoryAction === 'reassert' || memoryAction === 'forget'
    || memoryAction === 'pin' || memoryAction === 'unpin';
  let agentId: string | undefined;
  let trust: TrustLevel | undefined;
  let format: 'text' | 'json' = 'text';
  let allUnknown = false;
  let limit: number | undefined;
  let file: string | undefined;
  let preserveTrust = false;
  let pass: string | undefined;
  const ids: string[] = [];
  const words: string[] = [];
  for (let index = 0; index < memoryRest.length; index += 1) {
    const token = memoryRest[index];
    if (!token) {
      continue;
    }
    if (token === '--help' || token === '-h') {
      return { command: 'help' };
    }
    if (token === '--trust') {
      const value = readOptionValue(memoryRest, index, '--trust');
      if (!isTrustLevel(value)) {
        throw new Error(`Unsupported trust level: ${value}. Use one of ${TRUST_LEVELS.join(', ')}.`);
      }
      trust = value;
      index += 1;
      continue;
    }
    if (token === '--format') {
      const value = readOptionValue(memoryRest, index, '--format');
      if (value !== 'text' && value !== 'json') {
        throw new Error(`Unsupported format: ${value}`);
      }
      format = value;
      index += 1;
      continue;
    }
    if (token === '--limit' && (memoryAction === 'search' || memoryAction === 'passes')) {
      const value = Number(readOptionValue(memoryRest, index, '--limit'));
      if (!Number.isFinite(value) || value < 1) {
        throw new Error('--limit needs a positive number of results.');
      }
      limit = Math.floor(value);
      index += 1;
      continue;
    }
    if (token === '--file' && (memoryAction === 'export' || memoryAction === 'import')) {
      file = readOptionValue(memoryRest, index, '--file');
      index += 1;
      continue;
    }
    if (token === '--pass' && memoryAction === 'list') {
      pass = readOptionValue(memoryRest, index, '--pass');
      index += 1;
      continue;
    }
    if (token === '--preserve-trust' && memoryAction === 'import') {
      preserveTrust = true;
      continue;
    }
    if (token === '--all-unknown' && memoryAction === 'reassert') {
      allUnknown = true;
      continue;
    }
    if (token.startsWith('--')) {
      throw new Error(`Unknown option: ${token}`);
    }
    if (agentId === undefined) {
      agentId = token;
      continue;
    }
    if (takesIds) {
      ids.push(token);
      continue;
    }
    if (memoryAction === 'search') {
      words.push(token);
      continue;
    }
    if (memoryAction === 'undo-pass') {
      if (pass !== undefined) {
        throw new Error(`memory undo-pass takes one pass id at a time: stratus memory undo-pass ${agentId} <pass-id>.`);
      }
      pass = token;
      continue;
    }
    throw new Error(`Unexpected argument: ${token}. Try: stratus memory ${memoryAction} <agent>`);
  }
  if (!agentId) {
    throw new Error(`memory ${memoryAction} needs the agent id: stratus memory ${memoryAction} <agent>${memoryAction === 'reassert' ? ' --trust user <id>...' : ''}.`);
  }
  if (memoryAction === 'reassert') {
    if (trust === undefined) {
      throw new Error('memory reassert needs --trust <user|agent|external|unknown>: the label you are vouching for.');
    }
    if (ids.length === 0 && !allUnknown) {
      throw new Error('memory reassert needs entry ids, or --all-unknown to re-label every entry that has no recorded origin.');
    }
  }
  if (takesIds && memoryAction !== 'reassert' && ids.length === 0) {
    throw new Error(`memory ${memoryAction} needs at least one entry id: stratus memory ${memoryAction} ${agentId} <id>...`);
  }
  if (memoryAction === 'search' && words.length === 0) {
    throw new Error(`memory search needs something to look for: stratus memory search ${agentId} deploy pipeline.`);
  }
  if (memoryAction === 'undo-pass' && pass === undefined) {
    throw new Error(`memory undo-pass needs the pass id: stratus memory undo-pass ${agentId} <pass-id>. stratus memory passes ${agentId} lists them.`);
  }
  if (memoryAction === 'import' && file === undefined) {
    throw new Error(`memory import needs --file <path>: the JSONL a stratus memory export wrote.`);
  }
  return {
    command: 'memory',
    action: memoryAction,
    agentId,
    ...(trust !== undefined ? { trust } : {}),
    ids,
    allUnknown,
    ...(words.length > 0 ? { query: words.join(' ') } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(pass !== undefined ? { pass } : {}),
    ...(file !== undefined ? { file } : {}),
    preserveTrust,
    format,
  };
};
