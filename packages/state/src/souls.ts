import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseSoul, type ParsedSoul } from '@stratusagent/agents';
import { loadConfigFile } from './config-file.ts';
import { resolveConfigLocation } from './config-location.ts';
import type { StratusConfigFile, RuntimeSelection } from './config.ts';
import {
  type StateEnvironment,
  readProcessEnv,
  readWorkingDirectory,
  readNonEmptyString,
} from './environment.ts';
import { agentsDirPath, foldedAgentId } from './paths.ts';

// The agent every run uses when no soul is configured. A Stratus agent is
// a Stratus agent — never "the model" — whichever provider serves it.
export const DEFAULT_STRATUS_AGENT = {
  id: 'stratus',
  name: 'Stratus',
  instructions: 'You are Stratus, a personal agent on the Stratus Agent platform. Be warm, direct, and concise. When asked who or what you are, you are Stratus — a Stratus agent — regardless of which model is serving the conversation.',
};

// A soul travels with the run: an explicit soul path outranks STRATUS_SOUL,
// which outranks the config file's "soul" key.
//
// **An untrusted config does not get to name the soul.** The soul is what
// the model is told it is and what it may do, and an auto-discovered
// `stratus.config.json` ships in any repository somebody clones — a
// `soul: ./AGENT.md` in a cloned repo is not a persona setting, it is a
// system prompt written by whoever pushed the repo, taking effect on
// `stratus run` in that directory. `--soul` and `STRATUS_SOUL` still name
// one, because the flag and the environment are the operator's own.
export const resolveSoulPath = (
  selection: RuntimeSelection,
  env: StateEnvironment,
  fileConfig: StratusConfigFile,
  configTrusted?: boolean,
): string | undefined => {
  const processEnv = readProcessEnv(env);
  const soulPath = selection.soul
    ?? readNonEmptyString(processEnv.STRATUS_SOUL)
    ?? (configTrusted === false ? undefined : fileConfig.soul);

  if (!soulPath) {
    return undefined;
  }

  return path.resolve(readWorkingDirectory(env), String(soulPath));
};

export const resolveSoul = async (
  selection: RuntimeSelection,
  env: StateEnvironment,
  fileConfig: StratusConfigFile,
  configTrusted?: boolean,
): Promise<ParsedSoul | undefined> => {
  const resolvedPath = resolveSoulPath(selection, env, fileConfig, configTrusted);
  if (!resolvedPath) {
    return undefined;
  }
  return loadSoulFile(resolvedPath);
};

/**
 * Resolves and loads just the soul a selection points at (explicit path,
 * env var, or the config file's default) WITHOUT resolving providers or
 * credentials — for callers that need the agent's identity even when full
 * runtime resolution would fail validation (e.g. a daemon default
 * provider whose credentials are absent while the soul pins another).
 */
export const resolveConfiguredSoul = async (
  selection: RuntimeSelection,
  env: StateEnvironment = {},
): Promise<{ soul: ParsedSoul; path: string } | undefined> => {
  const configLocation = await resolveConfigLocation(selection, env);
  const fileConfig = configLocation ? await loadConfigFile(configLocation.path) : {};
  const soulPath = resolveSoulPath(selection, env, fileConfig, configLocation?.trusted);
  if (!soulPath) {
    return undefined;
  }
  return { soul: await loadSoulFile(soulPath), path: soulPath };
};

/** Reads and parses one soul file, with identity seeded by its path. */
export const loadSoulFile = async (resolvedPath: string): Promise<ParsedSoul> => {
  let raw: string;
  try {
    raw = await readFile(resolvedPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Soul file not found: ${resolvedPath}`);
    }
    throw error;
  }

  try {
    // Seeding with the resolved path keeps an unnamed soul's generated
    // identity (name, id, avatar) stable across runs — persisted memory is
    // keyed by that id, so it must not change between invocations.
    return parseSoul(raw, { seed: resolvedPath });
  } catch (error) {
    throw new Error(
      `Could not parse soul file ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export interface RosterEntry {
  soul: ParsedSoul;
  /** Absolute path of the soul file this entry came from. */
  path: string;
}

/**
 * Two soul files claiming the same agent id — or claiming two ids that a
 * filesystem would make the same.
 *
 * Typed so diagnostic callers can report it as a finding rather than
 * surfacing a stack trace, while the daemon lets it stop a start.
 */
export class DuplicateAgentIdError extends Error {
  readonly agentId: string;
  readonly paths: [string, string];
  /**
   * The id the second file declared: the same string as {@link agentId} for
   * an exact duplicate, the other spelling when the two collide by case.
   */
  readonly conflictingId: string;

  constructor(agentId: string, paths: [string, string], conflictingId: string = agentId) {
    super(
      agentId === conflictingId
        ? `Two soul files declare the agent id ${agentId}: ${paths[0]} and ${paths[1]}. `
          + 'Ids key sessions, memory, and credentials, so one of them has to change.'
        : `The agent ids ${agentId} and ${conflictingId} differ only in case: ${paths[0]} and ${paths[1]}. `
          + 'An id names a directory under ~/.stratus/agents, and macOS and Windows fold those two names onto '
          + 'one — the agents would share their sessions, their memories, and the grant file that says what '
          + 'may run unattended. One of them has to change.',
    );
    this.name = 'DuplicateAgentIdError';
    this.agentId = agentId;
    this.paths = paths;
    this.conflictingId = conflictingId;
  }
}

/**
 * Loads the soul roster from ~/.stratus/agents. Unreadable files degrade
 * to a warning: one broken soul must never take the rest of the team down.
 *
 * A duplicate id does NOT degrade, and the difference is the point.
 * Skipping an unreadable file loses one agent, and which one is obvious.
 * Picking a winner between two files claiming one id makes an agent
 * silently inherit another's sessions, memory, and credentials, with the
 * winner decided by filename sort order — there is no degraded behaviour
 * that is right, so this refuses instead of guessing. Two ids that differ
 * only in case are that same collision on the filesystems most operators
 * run, so they count as duplicates here too — `foldedAgentId` in
 * `paths.ts` carries the reason.
 */
export const loadRosterSouls = async (
  env: StateEnvironment,
  warn: (message: string) => void = () => {},
): Promise<RosterEntry[]> => {
  let rosterFiles: string[] = [];
  try {
    rosterFiles = (await readdir(agentsDirPath(env)))
      .filter((file) => file.endsWith('.md'))
      .sort()
      .map((file) => path.join(agentsDirPath(env), file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  const entries: RosterEntry[] = [];
  const byId = new Map<string, { id: string; path: string }>();
  for (const soulPath of rosterFiles) {
    let entry: RosterEntry;
    try {
      entry = { soul: await loadSoulFile(soulPath), path: soulPath };
    } catch (error) {
      warn(`skipping ${soulPath}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    // Reserved ids are dropped BEFORE collision detection, and the order
    // matters. A soul claiming the built-in id — in whatever case, since
    // `agents/Stratus/` is the built-in agent's own state directory
    // wherever case folds — is skipped either way, because it may not take
    // the documented fallback over. So two of them are not an ambiguity to
    // refuse over: neither was going to get the id. Left
    // after the check, a repository could take a daemon down simply by
    // shipping two souls named `stratus`, turning a guard against hijack
    // into a way to deny service.
    if (foldedAgentId(entry.soul.agent.id) === DEFAULT_STRATUS_AGENT.id) {
      warn(`agent id ${entry.soul.agent.id} is reserved for the built-in agent; ignoring ${soulPath}`);
      continue;
    }

    const claimed = byId.get(foldedAgentId(entry.soul.agent.id));
    if (claimed !== undefined) {
      throw new DuplicateAgentIdError(claimed.id, [claimed.path, soulPath], entry.soul.agent.id);
    }
    byId.set(foldedAgentId(entry.soul.agent.id), { id: entry.soul.agent.id, path: soulPath });
    entries.push(entry);
  }
  return entries;
};
