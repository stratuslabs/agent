/*
 * `fs.move`: a file or directory moved or renamed within the agent's roots,
 * never over an existing entry. Its trust labels move with it, so content
 * from outside still reads as outside afterwards.
 */
import { lstat, mkdir, realpath, rename, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  isTaintedTrust,
  type JsonObject,
  leastTrusted,
  sessionTrustOf,
  type Tool,
  type TrustLevel,
} from '@stratusagent/core';
import type { LedgerGuard, ProtectedPathGuard, TaintedWriteLedger } from '@stratusagent/plugins';

import { type ResolvedPath, resolveWithinRoots } from './paths.ts';
import {
  type KeyedSerializer,
  refuseGitConfig,
  refuseProtected,
  relativeTo,
  requireString,
  settingsFor,
} from './shared.ts';
import { withAncestors } from './trust.ts';

/**
 * What the ledger guard needs, read once per look: the guard itself, and
 * every path that is or holds a ledger, so a directory move can be refused
 * when one is inside it. `fs.move` looks twice, once to decide and once
 * just before the rename, and each look reads the host's workspaces afresh.
 */
export interface LedgerView {
  guard: LedgerGuard;
  /** Ledger files and the directories whose children are agent workspaces, canonical where they exist. */
  holders: string[];
}

export const spellingsOf = async (paths: readonly string[]): Promise<string[]> => {
  const spellings: string[] = [];
  for (const named of paths) {
    spellings.push(path.resolve(named));
    try {
      const canonical = await realpath(named);
      if (canonical !== path.resolve(named)) {
        spellings.push(canonical);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw error;
      }
    }
  }
  return spellings;
};

const isAtOrUnder = (parent: string, candidate: string): boolean =>
  candidate === parent || candidate.startsWith(`${parent}${path.sep}`);

/**
 * The lowest label a read of `absolutePath` would carry: its own record and
 * those of the directories above it up to the root, which a read honours too
 * (see `withAncestors`). A move has to carry the label the file reads at, not
 * only the one recorded under its own name: a clean file inside a directory a
 * tainted session named reads as tainted, and moving it out of that directory
 * must not launder it.
 */
const readLabelOf = (
  snapshot: Record<string, TrustLevel>,
  absolutePath: string,
  root: string,
): TrustLevel | undefined => {
  const labels = withAncestors(absolutePath, root)
    .map((named) => snapshot[named])
    .filter((label): label is TrustLevel => label !== undefined);
  return labels.length > 0 ? leastTrusted(...labels) : undefined;
};

/**
 * The records a move of `source` to `destination` owes the ledger: the moved
 * entry at the label it reads at, and every recorded path beneath it at its
 * own label, re-rooted. Derived from the ledger rather than a walk of the
 * tree, because only a path the ledger names has a label to carry, and the
 * ledger is the thing that cannot be allowed to miss one.
 */
const carriedLabels = (
  snapshot: Record<string, TrustLevel>,
  source: string,
  sourceRoot: string,
  destination: string,
): Map<string, TrustLevel> => {
  const carried = new Map<string, TrustLevel>();
  const own = readLabelOf(snapshot, source, sourceRoot);
  if (own !== undefined) {
    carried.set(destination, own);
  }
  const prefix = `${source}${path.sep}`;
  for (const [named, label] of Object.entries(snapshot)) {
    if (named.startsWith(prefix)) {
      carried.set(path.join(destination, named.slice(prefix.length)), label);
    }
  }
  return carried;
};

/**
 * Resolve the entry a move acts on without following it. `resolveWithinRoots`
 * canonicalizes the whole path, so a symlink named as the source would
 * resolve to its target and the move would take the target, possibly from
 * another root. The parent is resolved instead and the final name is
 * inspected with `lstat`, so a link is seen as a link and refused.
 */
const resolveMoveSource = async (
  roots: readonly string[],
  requested: string,
  home: string,
): Promise<ResolvedPath> => {
  const name = path.basename(requested);
  if (name.length === 0 || name === '.' || name === '..') {
    throw new Error(`fs.move needs a file or directory name to move, not ${requested}.`);
  }
  const parent = await resolveWithinRoots(roots, path.dirname(requested), { home });
  if (parent.kind !== 'directory') {
    throw new Error(`${parent.path} is not a directory.`);
  }
  const source = path.join(parent.path, name);
  let info;
  try {
    info = await lstat(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const missing = new Error(`No such file or directory: ${requested}`) as NodeJS.ErrnoException;
      missing.code = 'ENOENT';
      throw missing;
    }
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw new Error(`${source} is a symlink. fs.move moves files and directories, not links.`);
  }
  if (!info.isFile() && !info.isDirectory()) {
    throw new Error(`${source} is not a regular file or directory.`);
  }
  return {
    path: source,
    root: parent.root,
    exists: true,
    identity: { dev: info.dev, ino: info.ino },
    kind: info.isFile() ? 'file' : 'directory',
  };
};

export const createMoveTool = (
  config: JsonObject,
  ledger: TaintedWriteLedger,
  ledgerView: () => Promise<LedgerView>,
  serialized: KeyedSerializer,
  isProtected: () => Promise<ProtectedPathGuard>,
  protectedHolders: () => Promise<string[]>,
): Tool => ({
  name: 'fs.move',
  description: 'Move or rename a file or directory inside this agent’s roots. Provenance labels move with it, so content from outside still reads as outside after the move. Refuses to overwrite.',
  // Gated like fs.write: it changes what is where, and outlives the turn.
  risk: 'gated',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'The file or directory to move.' },
      to: { type: 'string', description: 'Its new path. Nothing may exist there yet.' },
    },
    required: ['from', 'to'],
  },
  async execute(input, session) {
    const settings = settingsFor(config, session);
    const fromRequested = requireString(input, 'from');
    const toRequested = requireString(input, 'to');
    const source = await resolveMoveSource(settings.roots, fromRequested, settings.home);
    const destination = await resolveWithinRoots(settings.roots, toRequested, { home: settings.home, allowMissing: true });

    // Refused before anything is recorded or created. The ledger, and any
    // directory holding one, never moves: the ledger is found by its place in
    // the workspace, so a moved ledger is a lost one and every file it
    // labelled would read as the agent's own. A directory holding something
    // the host protects is refused for the same reason a read of it is.
    const refuseLedger = (target: string): Error =>
      new Error(`${target} is or holds the filesystem provenance ledger, which fs.move does not move.`);
    const checkGuards = async (): Promise<void> => {
      await refuseProtected(isProtected, source, fromRequested);
      await refuseProtected(isProtected, destination, toRequested);
      refuseGitConfig(source, fromRequested, settings.home);
      refuseGitConfig(destination, toRequested, settings.home, { receivesTree: true });
      const view = await ledgerView();
      if (await view.guard(source.path, source.identity)) {
        throw refuseLedger(source.path);
      }
      if (await view.guard(destination.path, destination.identity)) {
        throw refuseLedger(destination.path);
      }
      if (source.kind === 'directory') {
        if (view.holders.some((held) => isAtOrUnder(source.path, held))) {
          throw refuseLedger(source.path);
        }
        const guarded = (await protectedHolders()).find((held) => isAtOrUnder(source.path, held));
        if (guarded !== undefined) {
          throw new Error(
            `Refusing ${fromRequested}: it holds ${guarded}, which Stratus keeps from every agent whatever its roots allow.`,
          );
        }
      }
    };
    // `exists` from the resolver misses a dangling symlink, which realpath
    // reports as missing and rename would silently replace.
    const refuseExisting = async (): Promise<void> => {
      try {
        await lstat(destination.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return;
        }
        throw error;
      }
      throw new Error(`${destination.path} already exists. fs.move does not overwrite; choose another name or move that one first.`);
    };

    await checkGuards();
    await refuseExisting();
    if (isAtOrUnder(source.path, destination.path)) {
      throw new Error(`Cannot move ${source.path} into itself.`);
    }

    // The directories the move creates, deepest last — named by this
    // session, so recorded at its label like fs.write's.
    const missingParents: string[] = [];
    let existingParent = destination.root;
    for (let parent = path.dirname(destination.path); parent !== destination.root && parent !== path.dirname(parent); parent = path.dirname(parent)) {
      try {
        await stat(parent);
        existingParent = parent;
        break;
      } catch {
        missingParents.unshift(parent);
      }
    }
    // rename(2) cannot cross filesystems. Refused here, before any label is
    // recorded or directory made, rather than by EXDEV halfway through.
    const sourceDevice = source.identity?.dev ?? (await lstat(source.path)).dev;
    const crossDevice = (): Error => new Error(
      `${fromRequested} and ${toRequested} are on different filesystems, which fs.move does not cross; copy it with fs.read and fs.write instead.`,
    );
    if ((await stat(existingParent)).dev !== sourceDevice) {
      throw crossDevice();
    }

    const trust = sessionTrustOf(session);
    const tainted = isTaintedTrust(trust);
    // One ledger read for the whole tree: per-path records would read the
    // ledger again for every labelled descendant.
    const record = async (labels: Map<string, TrustLevel>): Promise<void> => {
      if (labels.size === 0) {
        return;
      }
      if (ledger.recordWrites !== undefined) {
        await ledger.recordWrites(session.agent.id, [...labels]);
        return;
      }
      for (const [named, label] of labels) {
        await ledger.recordWrite(session.agent.id, named, label);
      }
    };
    const owed = (snapshot: Record<string, TrustLevel>): Map<string, TrustLevel> => {
      const labels = carriedLabels(snapshot, source.path, source.root, destination.path);
      if (tainted) {
        // The new name is this session's choice, so it carries the session's
        // label too, whichever is lower.
        const carried = labels.get(destination.path);
        labels.set(destination.path, carried === undefined ? trust : leastTrusted(carried, trust));
      }
      return labels;
    };

    // Both names, in a fixed order so two moves in opposite directions
    // cannot each hold one and wait on the other.
    const [first, second] = [source.path, destination.path].sort();
    let carriedCount = 0;
    await serialized(first as string, () => serialized(second as string, async () => {
      // Recorded BEFORE the rename, like fs.write's labels before its bytes:
      // a move that dies or fails after this leaves labels on a path with
      // nothing there, which over-marks; the other order could leave a
      // tainted file at the new path with no label, which launders it. The
      // ledger is append-only, so the old paths' records stay and nothing a
      // concurrent writer appended is lost.
      const before = await ledger.snapshot(session.agent.id);
      const labels = owed(before);
      if (tainted) {
        for (const parent of missingParents) {
          labels.set(parent, labels.has(parent) ? leastTrusted(labels.get(parent)!, trust) : trust);
        }
      }
      await record(labels);

      // A second look just before the rename: what was decided about must
      // still be what is there. The ledger guard reads the host's
      // workspaces again, and the source is the same inode.
      await checkGuards();
      const now = await lstat(source.path);
      if (now.dev !== source.identity?.dev || now.ino !== source.identity?.ino) {
        throw new Error(`${source.path} changed while the move was being prepared; try again.`);
      }
      await refuseExisting();

      const destinationParent = path.dirname(destination.path);
      // What this call made, from mkdir's own answer (the first directory it
      // created): a peer can make one of `missingParents` in the meantime,
      // and that one is not this call's to take back.
      let created: string[] = [];
      if (missingParents.length > 0) {
        const first = await mkdir(destinationParent, { recursive: true });
        created = first === undefined ? [] : missingParents.filter((parent) => isAtOrUnder(first, parent));
      }
      // rename(2) resolves both names afresh, and Node has no renameat to
      // hold the checked parent open across it. So the parent is checked
      // once more right before, and the result is checked right after:
      // a parent swapped for a link in either window moves the entry
      // somewhere other than the name decided about, which shows as a
      // different real parent or a different inode at the destination.
      // That is undone and refused rather than reported as a move.
      const parentIsCheckedDirectory = async (): Promise<boolean> => {
        try {
          const info = await lstat(destinationParent);
          return info.isDirectory() && (await realpath(destinationParent)) === destinationParent;
        } catch {
          return false;
        }
      };
      if (!(await parentIsCheckedDirectory())) {
        throw new Error(`${destinationParent} changed while the move was being prepared; try again.`);
      }
      try {
        await rename(source.path, destination.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
          throw error;
        }
        // Two mounts of one filesystem share a device number, so the check
        // above can pass and rename still refuse. Nothing moved: the
        // directories this call made are taken back, deepest first and only
        // while empty. The labels recorded stay, which over-marks a path
        // with nothing there, the safe direction.
        for (const parent of [...created].reverse()) {
          await rmdir(parent).catch(() => undefined);
        }
        throw crossDevice();
      }
      let landed = false;
      try {
        const info = await lstat(destination.path);
        landed = info.dev === source.identity?.dev && info.ino === source.identity?.ino && (await parentIsCheckedDirectory());
      } catch {
        landed = false;
      }
      if (!landed) {
        // Best effort: the same names, reversed, reach the same entries.
        await rename(destination.path, source.path).catch(() => undefined);
        throw new Error(
          `Refusing to move ${source.path}: a directory on the way changed during the move, so it may not have landed at ${destination.path}. It was moved back where that was possible.`,
        );
      }

      // Another process (a `stratus run`, or plugin-mcp) may have recorded a
      // tainted write under the old path after the first snapshot and before
      // the rename; its bytes moved with the tree. Records never clear, so a
      // second snapshot sees every such record, and anything new is carried.
      const after = owed(await ledger.snapshot(session.agent.id));
      const late = new Map<string, TrustLevel>();
      for (const [named, label] of after) {
        if (labels.get(named) !== label) {
          late.set(named, label);
        }
      }
      await record(late);
      carriedCount = after.size;
    }));

    return {
      from: relativeTo(source.root, source.path),
      to: relativeTo(destination.root, destination.path),
      absolutePath: destination.path,
      labelsCarried: carriedCount,
    };
  },
});
