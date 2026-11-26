import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Gives a test home one agent, `stratus`, as the configured default: what
 * setup leaves, and what an upgrade writes for a home that used the agent
 * that once lived in code. A turn that names no agent then has one to
 * reach, with every tool, as that agent always had.
 */
export const STRATUS_SOUL = '---\nname: Stratus\nid: stratus\ntools: ["*"]\n---\n\nYou are Stratus, a personal agent on the Stratus Agent platform.\n';

export const withDefaultAgent = async (home: string): Promise<string> => {
  const dir = path.join(home, '.stratus', 'agents');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'stratus.md'), STRATUS_SOUL);
  await writeFile(path.join(home, '.stratus', 'config.json'), `${JSON.stringify({ soul: path.join(dir, 'stratus.md') })}\n`);
  return home;
};

/** A temporary home under `prefix` with the default `stratus` agent in it. */
export const agentHome = async (prefix: string): Promise<string> =>
  withDefaultAgent(await mkdtemp(path.join(os.tmpdir(), prefix)));

/**
 * Adds the default `stratus` agent to a home whose config a test already
 * wrote, keeping every key it set.
 */
export const addDefaultAgent = async (home: string): Promise<string> => {
  const dir = path.join(home, '.stratus', 'agents');
  await mkdir(dir, { recursive: true });
  const soul = path.join(dir, 'stratus.md');
  await writeFile(soul, STRATUS_SOUL);
  const configPath = path.join(home, '.stratus', 'config.json');
  const existing = await readFile(configPath, 'utf8').then((raw) => JSON.parse(raw) as Record<string, unknown>, () => ({}));
  await writeFile(configPath, `${JSON.stringify({ ...existing, soul })}\n`, { mode: 0o600 });
  return soul;
};
