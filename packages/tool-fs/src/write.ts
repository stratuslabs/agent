/*
 * `fs.write`: one UTF-8 text file inside the agent's roots. The bytes and
 * the ledger record of who wrote them are queued as one step under the
 * file's path.
 */
import { constants } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { isTaintedTrust, type JsonObject, sessionTrustOf, type Tool } from '@stratusagent/core';
import type { LedgerGuard, ProtectedPathGuard, TaintedWriteLedger } from '@stratusagent/plugins';

import { openContained, resolveWithinRoots } from './paths.ts';
import {
  type KeyedSerializer,
  refuseGitConfig,
  refuseProtected,
  relativeTo,
  requireString,
  settingsFor,
} from './shared.ts';

export const createWriteTool = (
  config: JsonObject,
  ledger: TaintedWriteLedger,
  isLedger: () => Promise<LedgerGuard>,
  serialized: KeyedSerializer,
  isProtected: () => Promise<ProtectedPathGuard>,
): Tool => ({
  name: 'fs.write',
  description: 'Write a UTF-8 text file inside one of this agent’s roots.',
  // Gated, not safe: it acts on the world outside Stratus and outlives the
  // turn. Reading inside a root a human chose is the thing that does not.
  risk: 'gated',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
      append: { type: 'boolean' },
    },
    required: ['path', 'content'],
  },
  async execute(input, session) {
    const settings = settingsFor(config, session);
    const requested = requireString(input, 'path');
    const content = typeof input.content === 'string' ? input.content : '';
    const resolved = await resolveWithinRoots(settings.roots, requested, {
      home: settings.home,
      allowMissing: true,
    });
    await refuseProtected(isProtected, resolved, requested);
    refuseGitConfig(resolved, requested, settings.home);

    // The ledger is the daemon's record of what this agent wrote while
    // tainted. An agent whose roots cover its own workspace could otherwise
    // rewrite that record through this very tool — the attack writing its
    // own permission slip — so the one file the tool never writes is it.
    const ledgerRefusal = (target: string): Error =>
      new Error(`${target} is the filesystem provenance ledger, which fs.write does not edit.`);
    if (await (await isLedger())(resolved.path, resolved.identity)) {
      throw ledgerRefusal(resolved.path);
    }

    // The directories a write would create, deepest last. A directory's
    // name is text the writing session chose too, and a listing shows it,
    // so a tainted session's new directories are recorded like its file.
    const missingParents: string[] = [];
    if (!resolved.exists) {
      for (let parent = path.dirname(resolved.path); parent !== resolved.root && parent !== path.dirname(parent); parent = path.dirname(parent)) {
        try {
          await stat(parent);
          break;
        } catch {
          missingParents.unshift(parent);
        }
      }
    } else if (resolved.kind !== 'file') {
      // Same reason as the read path: writing into a directory is a mistake
      // worth naming, and writing into a fifo or a device blocks forever.
      throw new Error(
        resolved.kind === 'directory'
          ? `${resolved.path} is a directory.`
          : `${resolved.path} is not a regular file.`,
      );
    }

    const flags = input.append === true
      ? constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND
      : constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC;

    const trust = sessionTrustOf(session);
    // One step per path, ledger and bytes together — see the serializer.
    await serialized(resolved.path, async () => {
      // A write from a session at `external` or `unknown` records the path
      // at that label BEFORE anything lands — the directories it creates
      // included: a daemon that dies between the two, or a ledger that
      // cannot be written, must leave labelled paths with nothing behind
      // them rather than a durable file or directory with no label — the
      // second is exactly the laundering this ledger exists to close, and
      // the first over-marks, which is the safe direction. A clean
      // session's write records nothing, and clears nothing: the ledger
      // is monotonic per path, so no interleaving with another process
      // can pair tainted bytes with a cleared record.
      if (isTaintedTrust(trust)) {
        for (const parent of missingParents) {
          await ledger.recordWrite(session.agent.id, parent, trust);
        }
        await ledger.recordWrite(session.agent.id, resolved.path, trust);
      }

      if (!resolved.exists) {
        // The parent is created only after the resolution above put it
        // inside a root — `root/link/notes/x.md` through a symlinked `link`
        // never gets this far, so nothing is created outside the boundary
        // either.
        await mkdir(path.dirname(resolved.path), { recursive: true });
      }

      // O_NOFOLLOW is applied by openContained: a symlink sitting at the
      // destination must fail rather than write through to its target,
      // which is the write half of the escape a read-only check would miss.
      // A destination resolved as empty is opened exclusively there too.
      let handle;
      try {
        handle = await openContained(resolved, flags | (constants.O_NONBLOCK ?? 0), 0o644);
      } catch (error) {
        if (resolved.exists || (error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
        // Something appeared under a name that was empty when the
        // containment check ran: a peer writing the same new file, or a
        // hard link of the ledger put there to be truncated — which
        // O_NOFOLLOW cannot see and an exclusive create refuses. Decide
        // again about what is there now, ledger guard included, and open
        // it with its identity checked, so the honest case still lands.
        const present = await resolveWithinRoots(settings.roots, requested, { home: settings.home, allowMissing: true });
        if (!present.exists || present.kind !== 'file') {
          throw new Error(`${present.path} is not a regular file.`);
        }
        // The path the ledger recorded a moment ago is the only one this
        // write may land on: a symlink planted under the empty name would
        // resolve somewhere else, and tainted bytes would land unrecorded.
        if (present.path !== resolved.path) {
          throw new Error(`${resolved.path} changed between the containment check and the open; try again.`);
        }
        // A hard link to a protected file planted under the empty name is the
        // same trap as one to the ledger, so it gets the same second look.
        await refuseProtected(isProtected, present, requested);
        refuseGitConfig(present, requested, settings.home);
        if (await (await isLedger())(present.path, present.identity)) {
          throw ledgerRefusal(present.path);
        }
        handle = await openContained(present, flags | (constants.O_NONBLOCK ?? 0), 0o644);
      }
      try {
        await handle.writeFile(content, 'utf8');
      } finally {
        await handle.close();
      }
    });

    return {
      path: relativeTo(resolved.root, resolved.path),
      absolutePath: resolved.path,
      bytes: Buffer.byteLength(content, 'utf8'),
      appended: input.append === true,
    };
  },
});
