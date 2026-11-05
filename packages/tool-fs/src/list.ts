/*
 * `fs.list`: the entries of one directory inside the agent's roots, each
 * with its kind, up to the entry cap.
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import type { JsonObject, Tool } from '@stratusagent/core';
import type { ProtectedPathGuard, TaintedWriteLedger } from '@stratusagent/plugins';

import { isRealDirectory, resolveWithinRoots } from './paths.ts';
import { refuseProtected, relativeTo, settingsFor } from './shared.ts';
import { recordedTrustAmong } from './trust.ts';

const entryKind = (entry: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }): string => {
  if (entry.isSymbolicLink()) return 'symlink';
  if (entry.isDirectory()) return 'directory';
  if (entry.isFile()) return 'file';
  return 'other';
};

export const createListTool = (
  config: JsonObject,
  ledger: TaintedWriteLedger,
  isProtected: () => Promise<ProtectedPathGuard>,
): Tool => ({
  name: 'fs.list',
  description: 'List a directory inside one of this agent’s roots.',
  risk: 'safe',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Defaults to the agent’s first root.' },
    },
  },
  async execute(input, session, context) {
    const settings = settingsFor(config, session);
    const requested = typeof input.path === 'string' && input.path.length > 0 ? input.path : '.';
    const resolved = await resolveWithinRoots(settings.roots, requested, { home: settings.home });
    await refuseProtected(isProtected, resolved, requested);
    if (!(await isRealDirectory(resolved.path))) {
      throw new Error(`${requested} is not a directory; use fs.read.`);
    }

    const ledgerBefore = await ledger.snapshot(session.agent.id);
    const entries = await readdir(resolved.path, { withFileTypes: true });
    const listed = entries.slice(0, settings.maxEntries);
    const detailed = await Promise.all(listed.map(async (entry) => {
      const full = path.join(resolved.path, entry.name);
      let size: number | undefined;
      if (entry.isFile()) {
        try {
          size = (await stat(full)).size;
        } catch {
          size = undefined;
        }
      }
      return {
        name: entry.name,
        // Symlinks are reported as symlinks and never followed here: a
        // listing that resolved them would describe files outside the root
        // as if they were inside it.
        type: entryKind(entry),
        ...(size === undefined ? {} : { size }),
      };
    }));

    // The names are what a tainted session chose to call its files, and the
    // listing puts them in front of the model.
    // The entries' names, and the listed directory's own — the result names
    // it in `path`.
    const recorded = await recordedTrustAmong(
      ledger,
      session.agent.id,
      [resolved.path, ...listed.map((entry) => path.join(resolved.path, entry.name))],
      resolved.root,
      ledgerBefore,
    );
    if (recorded !== undefined) {
      context?.markTrust?.(recorded);
    }

    return {
      path: relativeTo(resolved.root, resolved.path),
      entries: detailed,
      truncated: entries.length > listed.length,
    };
  },
});
