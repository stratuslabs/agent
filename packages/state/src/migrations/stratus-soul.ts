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

const hasSlackApp = async (env: StateEnvironment): Promise<boolean> => {
  let credentials: Record<string, unknown> | undefined;
  try {
    credentials = await readJsonObject(credentialsPath(env));
  } catch {
    // An unreadable credentials file is reported by everything that reads
    // it; here it just can't say yes.
    return false;
  }
  const channels = credentials?.channels as Record<string, unknown> | undefined;
  const slack = channels?.slack as Record<string, unknown> | undefined;
  return typeof slack === 'object' && slack !== null
    && Object.keys(slack).some((agentId) => foldedAgentId(agentId) === LEGACY_DEFAULT_AGENT_ID);
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
 * as it, a Slack app, or a schedule.
 */
export const usedCodeDefinedAgent = async (env: StateEnvironment): Promise<boolean> => {
  // The legacy ids too: their memories already read as this agent's (see
  // `withLegacyDefaultMemories`), so a home holding only those used it.
  for (const agentId of [LEGACY_DEFAULT_AGENT_ID, ...LEGACY_DEFAULT_AGENT_IDS]) {
    if (await holdsAFile(agentStateDirPath(env, agentId))) {
      return true;
    }
  }
  return await hasSlackApp(env) || await hasSchedule(env);
};

const declaresStratus = async (soulPath: string): Promise<boolean> => {
  try {
    return foldedAgentId((await loadSoulFile(soulPath)).agent.id) === LEGACY_DEFAULT_AGENT_ID;
  } catch {
    // An unreadable soul is the roster's to report.
    return false;
  }
};

/**
 * A soul that already declares the id: one in `agents/` under any file
 * name, or the global config's default soul, which older builds let take
 * the id over. Writing a second would leave two souls on one state
 * directory, which the gateway refuses.
 */
const existingClaim = async (env: StateEnvironment, configSoul: string | undefined): Promise<string | undefined> => {
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
    if (await declaresStratus(soulPath)) {
      return soulPath;
    }
  }
  if (configSoul !== undefined && await declaresStratus(path.resolve(readWorkingDirectory(env), configSoul))) {
    return configSoul;
  }
  return undefined;
};

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
 * used the agent. Idempotent: the soul is written exclusively, and a second
 * run finds it.
 */
export const applyStratusSoul = async (env: StateEnvironment): Promise<string | undefined> => {
  if (!(await usedCodeDefinedAgent(env))) {
    return undefined;
  }
  const notes: string[] = [];
  const configPath = globalConfigPath(env);
  let config: Record<string, unknown> | undefined;
  try {
    config = (await readJsonObject(configPath)) ?? {};
  } catch (error) {
    notes.push(`could not read ${configPath} (${error instanceof Error ? error.message : String(error)}), so stratus was not made the default agent`);
  }
  const configSoul = typeof config?.soul === 'string' && config.soul.trim() !== '' ? config.soul : undefined;

  const ownPath = path.join(agentsDirPath(env), `${LEGACY_DEFAULT_AGENT_ID}.md`);
  const claimed = await existingClaim(env, configSoul);
  if (claimed === undefined) {
    const agent = {
      id: LEGACY_DEFAULT_AGENT_ID,
      name: 'Stratus',
      instructions: stratusPersona('Stratus'),
      tools: [...EVERY_TOOL],
    };
    try {
      await writeNewSoulFile(env, `${agent.id}.md`, agent.id, formatSoul({ agent }));
      notes.push(`wrote ${ownPath} for the stratus agent, which had lived in code`);
    } catch (error) {
      if (errnoOf(error) !== 'EEXIST') {
        throw error;
      }
    }
  } else if (claimed !== ownPath) {
    notes.push(`${claimed} already declares the id stratus, so it is that agent now`);
  }

  if (config !== undefined && configSoul === undefined) {
    // Every other key as it was: this adds one.
    await saveConfigFile(configPath, { ...config, soul: claimed ?? ownPath } as StratusConfigFile);
    notes.push('made it the default agent');
  }
  return notes.length > 0 ? notes.join('; ') : undefined;
};
