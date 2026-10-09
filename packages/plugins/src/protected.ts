import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { ProtectedPaths } from '@stratusagent/core';

import type { FileIdentity } from './provenance.ts';

/**
 * Which protected path, if any, `absolutePath` is or lies under. Answers
 * with the host's own spelling of what matched, so a refusal can name it.
 *
 * `identity` is the inode the caller is about to act on, when it has one;
 * without it the guard looks the path up itself.
 */
export type ProtectedPathGuard = (absolutePath: string, identity?: FileIdentity) => Promise<string | undefined>;

const identityKey = (identity: FileIdentity): string => `${identity.dev}:${identity.ino}`;

const within = (outer: string, candidate: string): boolean =>
  candidate === outer || candidate.startsWith(outer.endsWith(path.sep) ? outer : `${outer}${path.sep}`);

/**
 * The same split as the provenance ledger's guard: nothing there, or a path
 * that leads nowhere, is an answer. Anything else is the guard failing to
 * ask, and it must not pass a path because it could not look.
 */
const answersMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP';
};

/**
 * The canonical spelling of a path that may not exist yet: its deepest
 * existing ancestor resolved, the rest joined on. That is the spelling the
 * root resolver hands a caller, so the two sides compare alike.
 */
const canonicalOf = async (target: string): Promise<string> => {
  const missing: string[] = [];
  let cursor = target;
  for (;;) {
    try {
      return path.join(await realpath(cursor), ...missing);
    } catch (error) {
      if (!answersMissing(error)) {
        throw error;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        return target;
      }
      missing.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
};

/** Both spellings of each path: the one given, and the canonical one. */
const spellingsOf = async (listed: readonly string[]): Promise<Array<{ spelling: string; named: string }>> => {
  const spellings: Array<{ spelling: string; named: string }> = [];
  for (const named of listed) {
    const absolute = path.resolve(named);
    spellings.push({ spelling: absolute, named: absolute });
    const canonical = await canonicalOf(absolute);
    if (canonical !== absolute) {
      spellings.push({ spelling: canonical, named: absolute });
    }
  }
  return spellings;
};

/**
 * Both spellings of each exemption, where the canonical one resolves the
 * exemption's *ancestors* and never the exemption itself. A home behind a
 * link still needs its workspaces exempt under the real spelling, but a
 * workspace that is itself a link names wherever it points, and if that is
 * `agents/juno` inside the protected home, following it would exempt Juno's
 * sessions, memory, and grants. A link pointing outside the home needs no
 * exemption, since nothing there is protected.
 */
const exemptSpellingsOf = async (listed: readonly string[]): Promise<Array<{ spelling: string; named: string }>> => {
  const spellings: Array<{ spelling: string; named: string }> = [];
  for (const named of listed) {
    const absolute = path.resolve(named);
    spellings.push({ spelling: absolute, named: absolute });
    const parent = path.dirname(absolute);
    const canonical = parent === absolute ? absolute : path.join(await canonicalOf(parent), path.basename(absolute));
    if (canonical !== absolute) {
      spellings.push({ spelling: canonical, named: absolute });
    }
  }
  return spellings;
};

/** The deepest of `spellings` that `candidate` lies within, if any. */
const deepestMatch = (
  spellings: ReadonlyArray<{ spelling: string; named: string }>,
  candidate: string,
): { spelling: string; named: string } | undefined => {
  let best: { spelling: string; named: string } | undefined;
  for (const entry of spellings) {
    if (within(entry.spelling, candidate) && (best === undefined || entry.spelling.length > best.spelling.length)) {
      best = entry;
    }
  }
  return best;
};

/**
 * Build the guard for one call from what the host protects right now.
 *
 * Each path counts under two spellings, the host's and the canonical one,
 * because the path being judged arrives canonical from the root resolver,
 * and `~/.stratus` behind a link would otherwise compare as somewhere else.
 *
 * An exemption wins only where it is deeper than the protection it sits
 * in: a workspace inside the protected home is reachable, and a protected
 * path inside a workspace would still not be.
 *
 * A protected *file* also counts by inode, exemption or not: a hard link
 * to `credentials.json` from inside a workspace is a different name for
 * the same bytes, and no spelling reaches it. Files inside a protected
 * directory are matched by path only, since enumerating them on every call
 * is not worth it. Making a hard link to one takes a capability that could
 * already read it, such as an approved shell command.
 *
 * A host that supplies nothing gets a guard that protects nothing. That is
 * what `PluginContext.protectedPaths` says an omitting host gives up.
 */
export const protectedPathGuard = async (paths: ProtectedPaths | undefined): Promise<ProtectedPathGuard> => {
  const listed = paths === undefined ? [] : await paths.all();
  if (listed.length === 0) {
    return async () => undefined;
  }
  const protectedSpellings = await spellingsOf(listed);
  const exemptSpellings = await exemptSpellingsOf(await (paths as ProtectedPaths).exempt());
  const identities = new Map<string, string>();
  for (const named of listed) {
    try {
      const info = await stat(named);
      if (info.isFile()) {
        identities.set(identityKey(info), path.resolve(named));
      }
    } catch (error) {
      if (!answersMissing(error)) {
        throw error;
      }
    }
  }
  return async (absolutePath, identity) => {
    const guarded = deepestMatch(protectedSpellings, absolutePath);
    if (guarded !== undefined) {
      const exempted = deepestMatch(exemptSpellings, absolutePath);
      if (exempted === undefined || exempted.spelling.length <= guarded.spelling.length) {
        return guarded.named;
      }
    }
    if (identities.size === 0) {
      return undefined;
    }
    if (identity !== undefined) {
      return identities.get(identityKey(identity));
    }
    try {
      return identities.get(identityKey(await stat(absolutePath)));
    } catch (error) {
      if (answersMissing(error)) {
        // Nothing there: a write about to create a file is not a protected one.
        return undefined;
      }
      throw error;
    }
  };
};
