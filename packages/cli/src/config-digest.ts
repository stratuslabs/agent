import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_CONFIG_FILENAME,
  globalConfigPath,
  readNonEmptyString,
  readProcessEnv,
  readWorkingDirectory,
  type StateEnvironment,
} from '@stratusagent/state';

/**
 * A digest of a config file's bytes, or undefined when it cannot be read.
 * The daemon takes one at start and `stratus doctor` takes one now; the two
 * differing is how doctor knows the running daemon is on an older config.
 * Content rather than mtime, so saving a file unchanged is not a reason to
 * restart.
 */
export const configDigest = async (configPath: string): Promise<string | undefined> => {
  try {
    return createHash('sha256').update(await readFile(configPath)).digest('hex');
  } catch {
    return undefined;
  }
};

/** One config file a daemon could have read at start, and its digest then: null when it was not there. */
export interface StartupConfigFile {
  path: string;
  sha256: string | null;
}

/**
 * Every config file a start in this environment consults, in precedence
 * order: the named one alone, or the project file then the global one.
 * Both of the second pair and not only the winner, because the trusted
 * blocks (principals, Slack policy, plugins) fall through an untrusted
 * project file to the global one, and because a file that was absent at
 * start and exists now changes what a restart would load. Same rule as
 * `resolveConfigLocation`, which this must follow.
 */
export const startupConfigFiles = async (
  explicitConfigPath: string | undefined,
  env: StateEnvironment,
): Promise<StartupConfigFile[]> => {
  const cwd = readWorkingDirectory(env);
  const explicit = explicitConfigPath ?? readNonEmptyString(readProcessEnv(env).STRATUS_CONFIG);
  const paths = explicit
    ? [path.resolve(cwd, String(explicit))]
    : [path.join(cwd, DEFAULT_CONFIG_FILENAME), globalConfigPath(env)];
  return Promise.all(paths.map(async (file) => ({ path: file, sha256: (await configDigest(file)) ?? null })));
};
