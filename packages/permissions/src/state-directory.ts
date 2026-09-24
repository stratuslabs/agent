import { lstatSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

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
 *
 * This is the *leaf* question. A path Stratus derived is only safe when
 * every component below the home is real, which is what
 * {@link assertDerivedStatePath} asks — reach for this one only where the
 * components above have already been established.
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

/**
 * Every component of `target` below `home`, outermost first.
 *
 * Undefined when `target` is not under `home` at all. That is not a
 * judgement about the path — it is the caller passing a boundary the path
 * does not sit inside, which no amount of `lstat` makes safe to answer, so
 * it is the caller's error rather than this rule's verdict.
 *
 * Both are compared as given. Neither is canonicalized, deliberately: the
 * question is whether *this* spelling walks through a link, and `realpath`
 * answers by removing the very links being asked about.
 */
const componentsBelow = (home: string, target: string): string[] | undefined => {
  const relative = path.relative(home, target);
  if (relative.length === 0) {
    return [];
  }
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    return undefined;
  }
  const segments = relative.split(path.sep);
  return segments.map((_, index) => path.join(home, ...segments.slice(0, index + 1)));
};

/**
 * The invariant, in one place: a path Stratus *derived* may not pass through
 * a symlink at any component below the state home.
 *
 * The asymmetry is the whole rule. `~/.stratus` itself is the operator's own
 * path — a home on another disk is a supported layout — so it is followed.
 * Everything below it is a name Stratus chose, and a link there is somebody
 * redirecting state this process is about to create, tighten and trust:
 * `mkdir` with `recursive: true` is satisfied by a link pointing at a
 * directory, `chmod` follows it, and the sweep that reads entry types sees a
 * link rather than the shard it names.
 *
 * Checking only the leaf — which is what this rule was, at eight call sites
 * — answers "not a symlink" for every path under a linked `agents/`, and
 * then every agent's sessions, memories and grants are written wherever that
 * link points. One component is as good as another to redirect: the rule is
 * about the walk, not the last name in it.
 *
 * The first such component, or undefined when the walk is clean. A component
 * is returned rather than a boolean because the *offending* one is what a
 * caller has to name — to the operator who must replace it, or in the
 * migration report that quarantines around it.
 */
const notInside = (home: string, target: string): Error =>
  new Error(`${target} is not inside ${home}, so it is not a path Stratus derives.`);

export const linkedDerivedComponent = async (home: string, target: string): Promise<string | undefined> => {
  const components = componentsBelow(home, target);
  if (components === undefined) {
    throw notInside(home, target);
  }
  for (const component of components) {
    if (await isSymlinkedStatePath(component)) {
      return component;
    }
  }
  return undefined;
};

/** {@link linkedDerivedComponent}, for the callers that open their files synchronously. */
export const linkedDerivedComponentSync = (home: string, target: string): string | undefined => {
  const components = componentsBelow(home, target);
  if (components === undefined) {
    throw notInside(home, target);
  }
  for (const component of components) {
    if (isSymlinkedStatePathSync(component)) {
      return component;
    }
  }
  return undefined;
};

/**
 * Which sentence a linked component earns. A link found *above* the leaf is
 * reported as itself whatever the leaf was going to be, because that
 * component is the one that has to be replaced.
 */
export const linkedDerivedComponentMessage = (
  component: string,
  target: string,
  kind: 'directory' | 'file',
): string => (component === target && kind === 'file'
  ? symlinkedStateFileMessage(component)
  : symlinkedStateDirectoryMessage(component));

/** {@link linkedDerivedComponent}, for the callers that must refuse rather than report. */
export const assertDerivedStatePath = async (
  home: string,
  target: string,
  kind: 'directory' | 'file',
): Promise<void> => {
  const linked = await linkedDerivedComponent(home, target);
  if (linked !== undefined) {
    throw new Error(linkedDerivedComponentMessage(linked, target, kind));
  }
};

/** {@link assertDerivedStatePath}, for the callers that open their files synchronously. */
export const assertDerivedStatePathSync = (home: string, target: string, kind: 'directory' | 'file'): void => {
  const linked = linkedDerivedComponentSync(home, target);
  if (linked !== undefined) {
    throw new Error(linkedDerivedComponentMessage(linked, target, kind));
  }
};
