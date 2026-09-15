import { lstatSync } from 'node:fs';
import { lstat } from 'node:fs/promises';

/**
 * Whether a path under an agent's state is a symlink, which is the one shape
 * neither its directory nor its files may have.
 *
 * `mkdir` with `recursive: true` is satisfied by a symlink pointing at a
 * directory, so every writer that just makes its directory and carries on
 * will follow one. What follows is the failure the per-agent layout exists
 * to prevent: the agent's sessions, memories and grants are written wherever
 * the link points — outside the home, or inside another agent's directory,
 * where two identities resolve the same `whitelist.json` and inherit each
 * other's standing permissions. The `0700` tightening lands on the target
 * too. And the startup sweep reads entry types, so a shard behind a link is
 * not a directory to it: those sessions never reach the fleet index and
 * cannot be resumed.
 *
 * The same goes for the files inside it: a `sessions.db` that is a link has
 * its table created, its rows indexed and its mode tightened in whatever it
 * points at, and the directory holding it reads as a real shard to the
 * startup sweep.
 *
 * One home for the rule because it has five call sites — the migration, the
 * session store twice, the memory store, and the grant store — and five of
 * them spelled by hand is five chances for one to keep following links after
 * the rest stopped. `lstat` is the whole point: `stat` follows the link and
 * answers about the target, which is not the question.
 *
 * A path that is not there yet is not a symlink; the caller creates it.
 */
export const isSymlinkedStatePath = async (directory: string): Promise<boolean> => {
  try {
    return (await lstat(directory)).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};

/** {@link isSymlinkedStatePath}, for the callers that open their files synchronously. */
export const isSymlinkedStatePathSync = (directory: string): boolean => {
  try {
    return lstatSync(directory).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};

/** What to tell whoever has to fix it — one sentence that names the remedy. */
export const symlinkedStateDirectoryMessage = (directory: string): string =>
  `${directory} is a symlink, so it cannot be an agent's state directory — its sessions, memories and grants `
  + 'would be written outside the home, or into another agent\'s. Replace the link with a real directory, '
  + 'moving its contents in.';

/** The same, for a state file rather than the directory holding it. */
export const symlinkedStateFileMessage = (filePath: string): string =>
  `${filePath} is a symlink, so it cannot be an agent's state file — it would be created, filled and tightened `
  + 'outside the home. Replace the link with a real file, moving its contents in.';
