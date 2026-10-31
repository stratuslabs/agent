import { readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { parseSoul, type ParsedSoul } from '@stratusagent/agents';

import { loadConfigFile } from './config-file.ts';
import { readNonEmptyString, readProcessEnv, readWorkingDirectory, type StateEnvironment } from './environment.ts';
import { agentsDirPath, globalConfigPath } from './paths.ts';
import { replaceSoulFile, withSoulFileLock } from './souls.ts';

/**
 * The line that keeps an agent on every tool. An omitted `tools:` list used
 * to mean every registered tool and now means only the tools registered as
 * safe, so a soul an install already had gets this written in on upgrade
 * rather than losing its shell, files and messages without a word.
 */
export const EVERY_TOOL_LINE = 'tools: ["*"]';

const EVERY_TOOL_NOTE = '# Added on upgrade so this agent keeps every tool. Without a tools: list it would get only safe tools.';

/** Everything but the tools list, in a form two parses can be compared by. */
const withoutTools = (soul: ParsedSoul): string => {
  const { tools: _tools, ...agent } = soul.agent;
  return JSON.stringify({ ...soul, agent });
};

/**
 * The soul with {@link EVERY_TOOL_LINE} added and nothing else changed, or
 * undefined when it has a `tools:` list already or the edit cannot be shown
 * to be only that.
 *
 * A text edit, not a render through `formatSoul`: this runs on files an
 * operator wrote by hand, and the writer canonicalizes, so it would drop
 * their comments and reorder their keys on an upgrade they never asked to
 * touch their prose. One comment and one key go in right under the opening
 * fence, or a fence pair goes on top of a soul that had none, in the file's
 * own line ending. Then both versions are parsed with the seed the loader
 * uses, and the edit stands only if they differ in `tools` alone, so a
 * soul the parser reads in some way this did not foresee is left as it was
 * instead of being changed into a different agent.
 */
export const withEveryToolLine = (raw: string, seed: string): string | undefined => {
  let before: ParsedSoul;
  try {
    before = parseSoul(raw, { seed });
  } catch {
    // A soul that does not load is no agent today, and editing it would be
    // guessing at what its author meant.
    return undefined;
  }
  if (before.agent.tools !== undefined) {
    return undefined;
  }
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const added = `${EVERY_TOOL_NOTE}${eol}${EVERY_TOOL_LINE}${eol}`;
  const opener = /^---[ \t]*\r?\n/.exec(raw);
  const next = opener
    ? `${opener[0]}${added}${raw.slice(opener[0].length)}`
    : `---${eol}${added}---${eol}${raw}`;
  let after: ParsedSoul;
  try {
    after = parseSoul(next, { seed });
  } catch {
    return undefined;
  }
  if (after.agent.tools?.length !== 1 || after.agent.tools[0] !== '*' || withoutTools(after) !== withoutTools(before)) {
    return undefined;
  }
  return next;
};

/**
 * The souls a daemon on this home serves from files: every `*.md` in the
 * agents directory, keyed by the path the loader seeds identity with, plus
 * the `soul:` of the global config and of the config the daemon is started
 * on (`configPath`, else `STRATUS_CONFIG`, resolved from the working
 * directory as the CLI resolves it) when that is an absolute path.
 *
 * Absolute only. The loader resolves a relative `soul:` against the
 * working directory of whatever process reads it, and the one running this
 * may stand somewhere else, where the same name is another file. Setup and
 * `agent new` write absolute paths, so this is only a hand-written config,
 * and for that one the daemon's startup line says what to add. Souls named
 * by `--soul` or `STRATUS_SOUL` are not knowable from here at all, and nor
 * is a `--config` the command that first runs this build was not given.
 */
const servedSoulPaths = async (env: StateEnvironment, configPath?: string): Promise<string[]> => {
  const paths: string[] = [];
  try {
    for (const file of (await readdir(agentsDirPath(env))).filter((name) => name.endsWith('.md')).sort()) {
      paths.push(path.join(agentsDirPath(env), file));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  const explicit = configPath ?? readNonEmptyString(readProcessEnv(env).STRATUS_CONFIG);
  const configs = [globalConfigPath(env)];
  if (explicit !== undefined) {
    configs.push(path.resolve(readWorkingDirectory(env), String(explicit)));
  }
  for (const config of configs) {
    try {
      const configured = (await loadConfigFile(config)).soul;
      if (typeof configured === 'string' && path.isAbsolute(configured)) {
        paths.push(configured);
      }
    } catch {
      // No config, or one that does not parse: the daemon will not start on
      // the second either, and a soul it names is not one to edit blind.
    }
  }
  return paths;
};

/**
 * Write {@link EVERY_TOOL_LINE} into every served soul with no `tools:`
 * list. Idempotent: a soul that has the line has a list, and is skipped.
 * Returns what changed, for the migration report, or undefined.
 */
export const applyEveryToolLines = async (env: StateEnvironment, configPath?: string): Promise<string | undefined> => {
  const written: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const soulPath of await servedSoulPaths(env, configPath)) {
    let target: string;
    try {
      target = await realpath(soulPath);
    } catch {
      // A link into a home this one was copied from, say. Named rather
      // than passed over, because once it is restored the agent comes back
      // with safe tools only, and this report is where that is said first.
      skipped.push(soulPath);
      continue;
    }
    // One file reached two ways (a configured soul that is also in the
    // agents directory) is one edit.
    if (seen.has(target)) {
      continue;
    }
    seen.add(target);
    await withSoulFileLock(async () => {
      let raw: string;
      try {
        raw = await readFile(soulPath, 'utf8');
      } catch {
        // A directory named like a soul, or a file this user cannot read.
        // The roster loader skips it and starts the rest, so an upgrade
        // that stopped here would keep the daemon down over one bad entry.
        skipped.push(soulPath);
        return;
      }
      let soul: ParsedSoul;
      try {
        soul = parseSoul(raw, { seed: soulPath });
      } catch {
        skipped.push(soulPath);
        return;
      }
      if (soul.agent.tools !== undefined) {
        return;
      }
      const next = withEveryToolLine(raw, soulPath);
      if (next === undefined) {
        skipped.push(soulPath);
        return;
      }
      await replaceSoulFile(soulPath, next);
      written.push(soul.agent.id);
    });
  }
  const parts: string[] = [];
  if (written.length > 0) {
    parts.push(`wrote ${EVERY_TOOL_LINE} into the soul of ${written.join(', ')}, so ${written.length === 1 ? 'it keeps' : 'they keep'} every tool`);
  }
  if (skipped.length > 0) {
    parts.push(`left ${skipped.join(', ')} as ${skipped.length === 1 ? 'it was' : 'they were'} (unreadable, or not a soul that loads), so ${skipped.length === 1 ? 'it gets' : 'they get'} only safe tools until given a tools: list`);
  }
  return parts.length > 0 ? parts.join('; ') : undefined;
};
