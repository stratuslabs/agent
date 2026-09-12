import { escapeControlCharacters, memoryEntryTrust, type MemoryEntry } from '@stratusagent/core';
import {
  createFileMemoryStore,
  memoryFilePath,
  migrateLegacyMemory,
  withLegacyDefaultMemories,
} from '@stratusagent/state';
import type { CliStreams, CliEnvironment } from '../environment.ts';
import { writeLine } from '../io.ts';
import type { ParsedMemoryCommand } from '../parse.ts';

/**
 * `stratus memory list|reassert` — the operator's half of provenance.
 *
 * `list` shows what an agent's store holds with the label each entry
 * carries, because an operator cannot re-assert what they cannot see.
 * `reassert` is the one way a label ever rises: it appends a re-assertion
 * record to the JSONL (never rewrites a line), so a running daemon — which
 * re-reads the file on every read — sees it at once. Operator only, on
 * purpose: no tool exposes this, because an agent re-labelling its own
 * memory as trusted is the attack writing its own permission slip.
 *
 * `--all-unknown` exists for the upgrade: every entry written before labels
 * existed reads `unknown`, and the injected slice of such a store makes
 * every session `unknown` on its first turn. Re-asserting the entries the
 * agent actually surfaces, once, is the bounded work that drains it.
 */
export const runMemory = async (
  command: ParsedMemoryCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  // Only the writer folds a legacy per-directory store in: `list` is the
  // read-only command a downgraded build is allowed to run against newer
  // state, and a migration is a write.
  if (command.action === 'reassert') {
    await migrateLegacyMemory(env);
  }
  const store = withLegacyDefaultMemories(createFileMemoryStore(memoryFilePath(env)));
  // Two ways an entry reads `unknown`, and only one is the upgrade case:
  // no label at all (written before labels existed, or added by hand), or a
  // recorded `unknown` — a session that heard from a sender nobody vouched
  // for, or ran a shell command. The bulk re-assertion is for the first;
  // the second may hold a stranger's text and is named by id, once read.
  const unlabelled = (entry: MemoryEntry): boolean => entry.trust === undefined;
  const describeEntry = (entry: MemoryEntry): Record<string, unknown> => ({
    id: entry.id,
    trust: memoryEntryTrust(entry),
    content: entry.content,
    createdAt: entry.createdAt,
    ...(entry.origin ? { origin: entry.origin } : {}),
  });

  if (command.action === 'list') {
    const live = (await store.list(command.agentId)).entries
      .filter((entry) => command.trust === undefined || memoryEntryTrust(entry) === command.trust);
    if (command.format === 'json') {
      writeLine(streams.stdout, JSON.stringify({ agentId: command.agentId, entries: live.map(describeEntry) }, null, 2));
      return 0;
    }
    if (live.length === 0) {
      writeLine(
        streams.stdout,
        command.trust === undefined
          ? `${command.agentId} has no live memory entries in ${memoryFilePath(env)}.`
          : `${command.agentId} has no live memory entries at ${command.trust}.`,
      );
      return 0;
    }
    for (const entry of live) {
      const taintedBy = entry.origin?.taintedBy ? `  (tainted by ${entry.origin.taintedBy})` : '';
      const unrecorded = unlabelled(entry) ? '  (no recorded origin)' : '';
      writeLine(streams.stdout, `${entry.id}  [${memoryEntryTrust(entry)}]${taintedBy}${unrecorded}`);
      writeLine(streams.stdout, `  ${escapeControlCharacters(entry.content)}`);
    }
    if (command.trust === undefined) {
      const unlabelledCount = live.filter(unlabelled).length;
      const recordedUnknown = live.filter((entry) => !unlabelled(entry) && memoryEntryTrust(entry) === 'unknown').length;
      if (unlabelledCount > 0) {
        writeLine(streams.stdout, '');
        writeLine(
          streams.stdout,
          `${unlabelledCount} entr${unlabelledCount === 1 ? 'y has' : 'ies have'} no recorded origin, so any session that reads one writes unknown. `
          + `Review them, then: stratus memory reassert ${command.agentId} --trust user --all-unknown (or name ids).`,
        );
      }
      if (recordedUnknown > 0) {
        writeLine(streams.stdout, '');
        writeLine(
          streams.stdout,
          `${recordedUnknown} entr${recordedUnknown === 1 ? 'y was' : 'ies were'} recorded unknown — written after a message from someone not configured as a principal, or after a shell command — `
          + 'and may repeat what a stranger said. --all-unknown leaves these alone; re-assert one by id once you have read it.',
        );
      }
    }
    return 0;
  }

  if (!store.reassertTrust) {
    writeLine(streams.stderr, 'Error: this memory store cannot re-assert trust.');
    return 1;
  }
  const trust = command.trust ?? 'user';
  const live = (await store.list(command.agentId)).entries;
  const targets = command.allUnknown
    ? [...new Set([...live.filter(unlabelled).map((entry) => entry.id), ...command.ids])]
    : command.ids;
  if (targets.length === 0) {
    writeLine(streams.stdout, `${command.agentId} has no live entries with no recorded origin; nothing to re-assert. An entry recorded unknown is named by id.`);
    return 0;
  }
  const missing: string[] = [];
  let changed = 0;
  for (const id of targets) {
    if (await store.reassertTrust(command.agentId, id, trust)) {
      changed += 1;
    } else {
      missing.push(id);
    }
  }
  if (command.format === 'json') {
    writeLine(streams.stdout, JSON.stringify({ agentId: command.agentId, trust, reasserted: changed, missing }, null, 2));
  } else {
    writeLine(streams.stdout, `Re-asserted ${changed} entr${changed === 1 ? 'y' : 'ies'} of ${command.agentId} as ${trust}. A running daemon reads the change on its next turn.`);
  }
  for (const id of missing) {
    writeLine(streams.stderr, `No live memory entry with id ${id} belongs to ${command.agentId}; nothing was re-asserted for it.`);
  }
  return missing.length === 0 ? 0 : 1;
};
