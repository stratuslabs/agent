import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** A path that is not inside anything this agent was given. */
export class PathOutsideRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathOutsideRootError';
  }
}

/** `~` and `~/x` mean the same thing here as they do in a shell. */
export const expandHome = (value: string, home = os.homedir()): string => {
  if (value === '~') {
    return home;
  }
  if (value.startsWith('~/')) {
    return path.join(home, value.slice(2));
  }
  return value;
};

/**
 * The roots an agent may reach, canonicalized.
 *
 * A root can itself be a symlink — `~/work` pointing at a volume is
 * ordinary — so containment is decided between real paths on both sides.
 * Comparing a real target against a symlinked root would refuse every
 * legitimate read; comparing a lexical target against a real root would
 * accept every escape.
 */
export const canonicalRoots = async (roots: readonly string[], home = os.homedir()): Promise<string[]> => {
  const resolved: string[] = [];
  for (const root of roots) {
    const absolute = path.resolve(expandHome(root, home));
    try {
      resolved.push(await realpath(absolute));
    } catch {
      // A root that does not exist yet grants nothing, rather than
      // granting its lexical prefix.
      continue;
    }
  }
  return resolved;
};

const contains = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${path.sep}`);

export interface ResolvedPath {
  /** The canonical path to act on. */
  path: string;
  /** The canonical root it was found inside. */
  root: string;
  /** True when something is already there. */
  exists: boolean;
  /**
   * The file this resolution was decided about, identified by inode rather
   * than by name — see `openContained`.
   */
  identity?: { dev: number; ino: number };
}

/**
 * Resolve a requested path to a real one inside a real root, or refuse it.
 *
 * Lexical checks are not enough and this is the reason the whole module
 * exists: `notes/../../.stratus/credentials.json` is caught by normalizing,
 * but a *symlink* inside an allowed root pointing at the credential store
 * is not — the string never leaves the root. So resolution canonicalizes
 * the deepest part of the path that exists, and requires **that** to be
 * inside the root.
 *
 * For a path that does not exist yet, the canonicalized part is its nearest
 * existing ancestor, which is what makes the write-through-parent case a
 * refusal: writing `root/link/passwd` where `link` points at `/etc`
 * resolves to `/etc`, and `/etc` is not inside the root however innocent
 * the requested string looks.
 */
export const resolveWithinRoots = async (
  roots: readonly string[],
  requested: string,
  options: { home?: string; allowMissing?: boolean } = {},
): Promise<ResolvedPath> => {
  const home = options.home ?? os.homedir();
  const canonical = await canonicalRoots(roots, home);
  if (canonical.length === 0) {
    throw new PathOutsideRootError(
      'No filesystem roots are configured for this agent, so nothing is readable. '
      + 'Set roots for it under plugins["@stratusagent/tool-fs"].',
    );
  }

  const expanded = expandHome(requested, home);
  // A relative path is relative to the agent's first root, which is what an
  // agent means by `notes/today.md`. It is normalized before anything else,
  // so `../` is spent against the root rather than against the daemon's cwd.
  const absolute = path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.resolve(canonical[0] as string, expanded);

  const missing: string[] = [];
  let cursor = absolute;
  let real: string | undefined;
  for (;;) {
    try {
      real = await realpath(cursor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        break;
      }
      missing.unshift(path.basename(cursor));
      cursor = parent;
    }
  }

  if (real === undefined) {
    throw new PathOutsideRootError(`Path does not resolve to anything inside an allowed root: ${requested}`);
  }

  const root = canonical.find((candidate) => contains(candidate, real as string));
  if (!root) {
    throw new PathOutsideRootError(
      `Refusing ${requested}: it resolves to ${real}${missing.length > 0 ? `/${missing.join('/')}` : ''}, `
      + `which is outside every root this agent may reach (${canonical.join(', ')}).`,
    );
  }

  if (missing.length > 0) {
    const resolved = path.join(real, ...missing);
    if (!options.allowMissing) {
      const error = new Error(`No such file or directory: ${requested}`) as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    return { path: resolved, root, exists: false };
  }
  const resolved = real;

  const info = await lstat(resolved);
  return { path: resolved, root, exists: true, identity: { dev: info.dev, ino: info.ino } };
};

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/**
 * Open a resolved path without following a symlink, and prove afterwards
 * that what opened is what was checked.
 *
 * Between resolution and open there is a window in which the name can be
 * repointed at something else — the classic symlink-swap race. Two things
 * close it as far as this platform allows: `O_NOFOLLOW`, so a name that
 * *became* a symlink fails instead of being followed, and an inode
 * comparison after the fact, because a name that was replaced with a
 * different real file is a different inode even though the string matches.
 *
 * What this cannot do is walk the path a directory at a time holding each
 * one open — that needs `openat`, which Node does not expose. A swap of an
 * intermediate directory therefore remains possible in principle, which is
 * why the roots themselves are the boundary and not this function alone.
 */
export const openContained = async (
  resolved: ResolvedPath,
  flags: number,
  mode?: number,
): Promise<Awaited<ReturnType<typeof open>>> => {
  const handle = await open(resolved.path, flags | O_NOFOLLOW, mode);
  if (resolved.identity) {
    const info = await handle.stat();
    if (info.dev !== resolved.identity.dev || info.ino !== resolved.identity.ino) {
      await handle.close();
      throw new PathOutsideRootError(
        `Refusing ${resolved.path}: it changed between the containment check and the open.`,
      );
    }
  }
  return handle;
};

/** Whether a directory entry is a real directory (never through a symlink). */
export const isRealDirectory = async (target: string): Promise<boolean> => {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
};
