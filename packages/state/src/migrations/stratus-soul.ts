import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { formatSoul } from '@stratusagent/agents';
import { writeNewSoulFile } from '../agents-home.ts';
import { saveConfigFile } from '../config-file.ts';
import type { StratusConfigFile } from '../config.ts';
import { type StateEnvironment, readWorkingDirectory } from '../environment.ts';
import { LEGACY_DEFAULT_AGENT_IDS } from '../home-memory.ts';
import { loadSqlite } from '../memory-index.ts';
import {
  agentStateDirPath,
  agentsDirPath,
  credentialsPath,
  fleetDbPath,
  foldedAgentId,
  globalConfigPath,
} from '../paths.ts';
import { EVERY_TOOL, LEGACY_DEFAULT_AGENT_ID, loadSoulFile, stratusPersona } from '../souls.ts';

const errnoOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

/** Whether a directory holds at least one file anywhere below it. */
const holdsAFile = async (directory: string, depth = 0): Promise<boolean> => {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (errnoOf(error) === 'ENOENT' || errnoOf(error) === 'ENOTDIR') {
      return false;
    }
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      return true;
    }
    // Bounded: a workspace can be deep, and one file anywhere is enough,
    // which a real agent directory shows near the top (its sessions and
    // memory files).
    if (depth < 4 && await holdsAFile(path.join(directory, entry.name), depth + 1)) {
      return true;
    }
  }
  return false;
};

const readJsonObject = async (filePath: string): Promise<Record<string, unknown> | undefined> => {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined;
};

/**
 * The global config for adding one key to: `{}` when there is no file, and
 * an error for anything that is not a JSON object, which is the operator's
 * to repair rather than this migration's to replace with one key.
 */
const readConfigObject = async (filePath: string): Promise<Record<string, unknown>> => {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') {
      return {};
    }
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('it is not a JSON object');
  }
  return parsed as Record<string, unknown>;
};

/** Whether any channel, Slack or one a plugin contributes, has a binding stored for the agent. */
const hasChannelBinding = async (env: StateEnvironment): Promise<boolean> => {
  let credentials: Record<string, unknown> | undefined;
  try {
    credentials = await readJsonObject(credentialsPath(env));
  } catch {
    // An unreadable credentials file is reported by everything that reads
    // it; here it just can't say yes.
    return false;
  }
  const channels = credentials?.channels;
  if (typeof channels !== 'object' || channels === null) {
    return false;
  }
  return Object.values(channels).some((byAgent) => typeof byAgent === 'object' && byAgent !== null
    && Object.keys(byAgent).some((agentId) => foldedAgentId(agentId) === LEGACY_DEFAULT_AGENT_ID));
};

const hasSchedule = async (env: StateEnvironment): Promise<boolean> => {
  const filePath = fleetDbPath(env);
  try {
    await stat(filePath);
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') {
      return false;
    }
    throw error;
  }
  const { DatabaseSync } = await loadSqlite();
  // Read-only: a daemon of the older build may have it open, and reading
  // is all this needs.
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    // No table, or one without the column (a test double, a hand-made
    // file): nothing to find, never a reason to fail every command.
    const columns = db.prepare('PRAGMA table_info(schedules)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'agent_id')) {
      return false;
    }
    return db.prepare('SELECT 1 FROM schedules WHERE lower(agent_id) = ? LIMIT 1').get(LEGACY_DEFAULT_AGENT_ID) !== undefined;
  } finally {
    db.close();
  }
};

/**
 * Whether this home used the agent that once lived in code: it has its
 * sessions, memory, grants or workspace, memories under the ids that read
 * as it, a channel binding (Slack or a plugin's), or a schedule.
 */
export const usedCodeDefinedAgent = async (env: StateEnvironment): Promise<boolean> => {
  // The legacy ids too: their memories already read as this agent's (see
  // `withLegacyDefaultMemories`), so a home holding only those used it.
  for (const agentId of [LEGACY_DEFAULT_AGENT_ID, ...LEGACY_DEFAULT_AGENT_IDS]) {
    if (await holdsAFile(agentStateDirPath(env, agentId))) {
      return true;
    }
  }
  return await hasChannelBinding(env) || await hasSchedule(env);
};

/**
 * The id a soul declares when it names the agent's state directory: the
 * exact id, or one that differs only in case, which shares it only where
 * the filesystem folds case. Undefined for any other id, or a soul that
 * cannot be read, which is the roster's to report.
 */
const stratusIdOf = async (soulPath: string): Promise<string | undefined> => {
  try {
    const id = (await loadSoulFile(soulPath)).agent.id;
    return foldedAgentId(id) === LEGACY_DEFAULT_AGENT_ID ? id : undefined;
  } catch {
    return undefined;
  }
};

/**
 * A soul that already declares the id, in any case: one in `agents/` under
 * any file name, or the global config's default soul, which older builds
 * let take the id over. Writing a second would leave two souls the roster
 * refuses as one id.
 */
const existingClaim = async (
  env: StateEnvironment,
  configSoul: string | undefined,
): Promise<{ path: string; id: string } | undefined> => {
  let files: string[] = [];
  try {
    files = (await readdir(agentsDirPath(env))).filter((file) => file.endsWith('.md')).sort();
  } catch (error) {
    if (errnoOf(error) !== 'ENOENT') {
      throw error;
    }
  }
  for (const file of files) {
    const soulPath = path.join(agentsDirPath(env), file);
    const id = await stratusIdOf(soulPath);
    if (id !== undefined) {
      return { path: soulPath, id };
    }
  }
  if (configSoul !== undefined) {
    const id = await stratusIdOf(path.resolve(readWorkingDirectory(env), configSoul));
    if (id !== undefined) {
      return { path: configSoul, id };
    }
  }
  return undefined;
};

/**
 * File names the soul may take, in order. The first is the one a person
 * would look for; the second is for a home where `stratus.md` is some
 * other agent's, which older builds allowed because only the id was held
 * back.
 */
const SOUL_FILE_NAMES = [`${LEGACY_DEFAULT_AGENT_ID}.md`, `${LEGACY_DEFAULT_AGENT_ID}-agent.md`] as const;

/**
 * Gives a home that used the code-defined `stratus` agent a real soul for
 * it, so its sessions, memory, grants, schedules and Slack app carry on
 * under an agent the person can see, edit and narrow.
 *
 * The soul is the old definition written out: the same id, name and
 * persona, and every tool, which is what the code gave it. With no default
 * soul in the global config, it also becomes the default, so turns that
 * name no agent keep reaching it.
 *
 * Writes nothing when a soul already declares the id (that file takes the
 * state over now that the id is no longer held back) or the home never
 * used the agent. A soul whose id differs only in case, or soul file names
 * that are all somebody else's, also get nothing written and no default:
 * the note says where the state is and what to change. Idempotent: the
 * soul is written exclusively, and a second run finds it.
 */
export const applyStratusSoul = async (env: StateEnvironment): Promise<string | undefined> => {
  if (!(await usedCodeDefinedAgent(env))) {
    return undefined;
  }
  const notes: string[] = [];
  const configPath = globalConfigPath(env);
  let config: Record<string, unknown> | undefined;
  try {
    config = await readConfigObject(configPath);
  } catch (error) {
    notes.push(`could not read ${configPath} (${error instanceof Error ? error.message : String(error)}), so stratus was not made the default agent`);
  }
  const configSoul = typeof config?.soul === 'string' && config.soul.trim() !== '' ? config.soul : undefined;

  const stateDir = agentStateDirPath(env, LEGACY_DEFAULT_AGENT_ID);
  const claimed = await existingClaim(env, configSoul);
  let soulPath: string | undefined;
  if (claimed === undefined) {
    const agent = {
      id: LEGACY_DEFAULT_AGENT_ID,
      name: 'Stratus',
      instructions: stratusPersona('Stratus'),
      tools: [...EVERY_TOOL],
    };
    for (const file of SOUL_FILE_NAMES) {
      const target = path.join(agentsDirPath(env), file);
      try {
        await writeNewSoulFile(env, file, agent.id, formatSoul({ agent }));
        notes.push(`wrote ${target} for the stratus agent, which had lived in code`);
        soulPath = target;
        break;
      } catch (error) {
        if (errnoOf(error) !== 'EEXIST') {
          throw error;
        }
      }
      // Taken. A run beside this one that wrote the soul first is done;
      // anything else is somebody's file, left as it is.
      if (await stratusIdOf(target) === LEGACY_DEFAULT_AGENT_ID) {
        soulPath = target;
        break;
      }
    }
    if (soulPath === undefined) {
      notes.push(
        `${SOUL_FILE_NAMES.map((file) => path.join(agentsDirPath(env), file)).join(' and ')} are taken, so no soul was `
        + `written for the stratus agent. Its sessions and memory are kept in ${stateDir}: add a soul with id: stratus `
        + 'to use them again',
      );
    }
  } else if (claimed.id !== LEGACY_DEFAULT_AGENT_ID) {
    // Not adopted: its state directory is agents/<its id>, which is this
    // one only where case folds. Not a second soul either: the roster
    // refuses two ids that differ only in case.
    notes.push(
      `${claimed.path} declares the id ${claimed.id}, so no soul was written for the stratus agent. Its sessions and `
      + `memory are kept in ${stateDir}: change that soul to id: stratus to use them, or to another id to keep it apart`,
    );
  } else {
    soulPath = claimed.path;
    if (!SOUL_FILE_NAMES.some((file) => path.join(agentsDirPath(env), file) === claimed.path)) {
      notes.push(`${claimed.path} already declares the id stratus, so it is that agent now`);
    }
  }

  if (soulPath !== undefined && config !== undefined && configSoul === undefined) {
    // Every other key as it was: this adds one.
    await saveConfigFile(configPath, { ...config, soul: soulPath } as StratusConfigFile);
    notes.push('made it the default agent');
  }
  return notes.length > 0 ? notes.join('; ') : undefined;
};
