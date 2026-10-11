import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { promotedVersionPath, type StateEnvironment } from '@stratusagent/state';

/**
 * The version last promoted on this home, or undefined when none was (or
 * the record cannot be read, which holds rather than serving a version
 * nobody vouched for).
 */
export const readPromotedVersion = async (env: StateEnvironment): Promise<string | undefined> => {
  try {
    const parsed = JSON.parse(await readFile(promotedVersionPath(env), 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : undefined;
  } catch {
    return undefined;
  }
};

/** Whether `--hold-new-version` holds this start: the running version has not been promoted here. */
export const holdsForVersion = async (env: StateEnvironment, version: string): Promise<boolean> =>
  (await readPromotedVersion(env)) !== version;

/** Record `version` as promoted on this home (0600, replaced atomically). */
export const recordPromotedVersion = async (env: StateEnvironment, version: string): Promise<void> => {
  const file = promotedVersionPath(env);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const staging = `${file}.${randomBytes(8).toString('hex')}`;
  try {
    await writeFile(staging, `${JSON.stringify({ version, promotedAt: new Date().toISOString() })}\n`, { flag: 'wx', mode: 0o600 });
    await rename(staging, file);
  } finally {
    await rm(staging, { force: true });
  }
};
