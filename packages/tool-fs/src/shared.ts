/*
 * What the fs tools share: the settings each call resolves from its session
 * (roots, caps, home), input checks, the refusals that hold whatever the
 * roots allow (paths the host protects, and git's configuration), and the
 * per-key serializer that `fs.read`, `fs.write` and `fs.move` queue their
 * ledger work on.
 */
import { constants, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { JsonObject, JsonValue, Session } from '@stratusagent/core';
import { type ProtectedPathGuard, resolvePluginAgentConfig } from '@stratusagent/plugins';

import type { ResolvedPath } from './paths.ts';

/** Defaults chosen so a tool result is something a model can actually read. */
export const O_NOFOLLOW_FLAG = constants.O_NOFOLLOW ?? 0;
const DEFAULT_MAX_BYTES = 64_000;
const DEFAULT_MAX_MATCHES = 100;
export const DEFAULT_MAX_SEARCH_FILE_BYTES = 1_000_000;
const DEFAULT_MAX_ENTRIES = 500;

const asStrings = (value: JsonValue | undefined): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

const asNumber = (value: JsonValue | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

/**
 * A per-call limit may narrow the operator's cap, never raise it. The
 * README calls `maxBytes` and `maxMatches` caps, and a cap the model can
 * lift by naming a bigger number is a suggestion: one `fs.read` of a log
 * file asked for `maxBytes: 1e10` and got the whole 6.7 MB of it into the
 * transcript.
 */
export const narrowed = (requested: JsonValue | undefined, cap: number): number => Math.min(asNumber(requested, cap), cap);

export const requireString = (input: JsonObject, key: string): string => {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${key} is required and must be a string.`);
  }
  return value;
};

/**
 * What this agent may reach — resolved **per call**, from the session.
 *
 * Not a convenience: two agents with different roots is the whole point of
 * the per-agent block, and a plugin that read its roots once at setup would
 * hand every agent whichever set happened to be resolved first. That is one
 * agent reading another's files, and it is the failure this signature
 * exists to make impossible to write.
 */
export const settingsFor = (config: JsonObject, session: Session) => {
  const resolved = resolvePluginAgentConfig(config, session.agent.id);
  return {
    roots: asStrings(resolved.roots),
    maxBytes: asNumber(resolved.maxBytes, DEFAULT_MAX_BYTES),
    maxMatches: asNumber(resolved.maxMatches, DEFAULT_MAX_MATCHES),
    maxEntries: asNumber(resolved.maxEntries, DEFAULT_MAX_ENTRIES),
    home: typeof resolved.home === 'string' ? resolved.home : os.homedir(),
  };
};

/**
 * Whether a buffer is text, decided the way `grep` decides it: a NUL byte
 * means binary. Returning a megabyte of mojibake to a model helps nobody,
 * and returning "this is binary" is an answer it can act on.
 */
export const looksBinary = (buffer: Buffer): boolean => buffer.includes(0);

export const relativeTo = (root: string, target: string): string => path.relative(root, target) || '.';

/**
 * Refuse a resolved path the host keeps from every agent, whatever this
 * agent's roots say. Roots are the operator's choice of where an agent
 * works, and a broad one (`~`) is an ordinary choice. It should not also
 * hand over the credential store inside it. See `ProtectedPaths`.
 */
export const refuseProtected = async (
  isProtected: () => Promise<ProtectedPathGuard>,
  resolved: ResolvedPath,
  requested: string,
): Promise<void> => {
  const match = await (await isProtected())(resolved.path, resolved.identity);
  if (match !== undefined) {
    throw new Error(
      `Refusing ${requested}: it is inside ${match}, which Stratus keeps from every agent whatever its roots allow. `
      + 'Work in a workspace or another directory under your roots instead.',
    );
  }
};

/** A path through its symlinks as far as it exists, lexical past that. */
const canonicalOrSelf = (target: string): string => {
  let existing = target;
  const rest: string[] = [];
  while (existing !== path.dirname(existing)) {
    try {
      return path.join(realpathSync(existing), ...rest);
    } catch {
      rest.unshift(path.basename(existing));
      existing = path.dirname(existing);
    }
  }
  return target;
};

/**
 * Whether git would take this directory for a git directory, whatever its
 * name: a `HEAD` file beside an `objects` directory, or beside a
 * `commondir` file for a linked worktree's. A `.git` file can name one
 * anywhere (`gitdir: ../metadata`), so the name alone doesn't say.
 */
const isGitDirectory = (dir: string): boolean => {
  const kind = (name: string): 'file' | 'directory' | undefined => {
    try {
      const found = statSync(path.join(dir, name));
      return found.isFile() ? 'file' : found.isDirectory() ? 'directory' : undefined;
    } catch {
      return undefined;
    }
  };
  return kind('HEAD') === 'file' && (kind('objects') === 'directory' || kind('commondir') === 'file');
};

/** Whether the target or any directory above it is a git directory. */
const withinGitDirectory = (target: string): boolean => {
  for (let dir = target; ; dir = path.dirname(dir)) {
    if (isGitDirectory(dir)) {
      return true;
    }
    if (dir === path.dirname(dir)) {
      return false;
    }
  }
};

/**
 * Refuse a write or move that touches git's config. Git runs programs its
 * config names (`core.fsmonitor`, diff and filter drivers) even for `git
 * status`, so an agent that could write it would turn any git command it
 * is allowed into any command. That is any `.git`, directory or file (a
 * `.git` file names a git directory anywhere), anything inside a directory
 * git takes for a git directory whatever its name, any `.gitconfig`, git's
 * XDG directory, and a `GIT_CONFIG_GLOBAL` or `GIT_CONFIG_SYSTEM` the daemon
 * was given. Checked on the
 * path as asked and as resolved, root included, because a link resolves to
 * a name that doesn't say so.
 */
export const refuseGitConfig = (resolved: ResolvedPath, requested: string, home: string, options: { receivesTree?: boolean } = {}): void => {
  const segments = (target: string): string[] => target.split(/[\\/]/).map((segment) => segment.normalize('NFC').toLowerCase());
  const named = (target: string): boolean => {
    const parts = segments(target);
    return parts.includes('.git') || parts.at(-1) === '.gitconfig';
  };
  const xdg = process.env.XDG_CONFIG_HOME && path.isAbsolute(process.env.XDG_CONFIG_HOME)
    ? process.env.XDG_CONFIG_HOME
    : path.join(home, '.config');
  const configDirs = [path.join(xdg, 'git'), path.join(home, '.config', 'git')]
    .flatMap((dir) => [dir, canonicalOrSelf(dir)]);
  const configFiles = [process.env.GIT_CONFIG_GLOBAL, process.env.GIT_CONFIG_SYSTEM]
    .filter((file): file is string => typeof file === 'string' && path.isAbsolute(file))
    .flatMap((file) => [file, canonicalOrSelf(file)]);
  const inside = (dir: string, target: string): boolean => {
    const relative = path.relative(dir, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };
  const asked = path.resolve(resolved.root, requested.startsWith('~/') ? path.join(home, requested.slice(2)) : requested);
  // A move's destination also receives everything under its source: moving
  // a directory to `~/.config` would put whatever `git/config` it holds in
  // place, though neither path names it. So a move may not land on any
  // directory above a config location either.
  const hits = [asked, resolved.path].some((target) => named(target)
    || withinGitDirectory(canonicalOrSelf(target))
    || configDirs.some((dir) => inside(dir, target) || (options.receivesTree === true && inside(target, dir)))
    || configFiles.some((file) => file === target || (options.receivesTree === true && inside(target, file))));
  if (named(requested) || hits) {
    throw new Error(
      `Refusing ${requested}: it is git configuration (a .git or other git directory, a .gitconfig, git's config directory or a GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM file), which the fs tools don't change. `
      + 'Git runs programs its config names, so this is left to git itself and to you.',
    );
  }
};

/**
 * Run `work` after every earlier piece of work queued under `key` has
 * settled — one chain per key, dropped when it drains. `fs.write` queues
 * each write under its absolute path, so the ledger transition and the
 * bytes it describes land as one step, and `fs.read` queues its read and
 * its ledger lookup under the same key: two sessions of the same agent on
 * one file interleaved could otherwise pair tainted bytes with a record a
 * clean write had just cleared, in either tool.
 */
export type KeyedSerializer = <T>(key: string, work: () => Promise<T>) => Promise<T>;

export const createKeyedSerializer = (): KeyedSerializer => {
  const chains = new Map<string, Promise<void>>();
  return <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const previous = chains.get(key) ?? Promise.resolve();
    const run = previous.then(work, work);
    const settled = run.then(() => undefined, () => undefined);
    chains.set(key, settled);
    void settled.then(() => {
      if (chains.get(key) === settled) {
        chains.delete(key);
      }
    });
    return run;
  };
};
