import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { ConfigFileError, loadConfigFile } from './config-file.ts';
import type { StratusConfigFile, RuntimeSelection } from './config.ts';
import { type StateEnvironment, readProcessEnv, readWorkingDirectory } from './environment.ts';
import { DEFAULT_CONFIG_FILENAME, globalConfigPath } from './paths.ts';

export interface ResolvedConfigLocation {
  path: string;
  /**
   * Whether the config came from something the user chose themselves
   * (--config, STRATUS_CONFIG, or the global ~/.stratus/config.json written
   * by setup). Auto-discovered project-local files are untrusted: a cloned
   * repository can ship one, so stored credentials are never combined with
   * a custom endpoint it selects.
   */
  trusted: boolean;
}

export const resolveConfigLocation = async (
  selection: Pick<RuntimeSelection, 'configPath'>,
  env: StateEnvironment,
): Promise<ResolvedConfigLocation | undefined> => {
  const processEnv = readProcessEnv(env);
  const cwd = readWorkingDirectory(env);
  const explicit = selection.configPath ?? processEnv.STRATUS_CONFIG;

  if (explicit) {
    return { path: path.resolve(cwd, explicit), trusted: true };
  }

  // Project-local configs win; the global ~/.stratus/config.json written by
  // `stratus setup` is the fallback that makes the CLI work from anywhere.
  const candidates: ResolvedConfigLocation[] = [
    { path: path.join(cwd, DEFAULT_CONFIG_FILENAME), trusted: false },
    { path: globalConfigPath(env), trusted: true },
  ];
  for (const candidate of candidates) {
    try {
      await readFile(candidate.path, 'utf8');
      return candidate;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        // A config that exists but cannot be read is the same class of
        // failure as one that cannot be parsed — typed, so long-running
        // callers can degrade instead of failing every dispatch.
        throw new ConfigFileError(candidate.path, error);
      }
    }
  }

  return undefined;
};

// Tolerant config discovery for callers that only need the config as a
// hint (listing, agent creation): a config that exists but cannot be read
// or parsed degrades to a warning instead of blocking the command.
export const discoverActiveConfig = async (
  env: StateEnvironment,
  warn: (message: string) => void,
  /**
   * The file the caller was pinned to, if any. Without it a daemon started
   * with `--config custom.json` would have its roster, health, and model
   * catalog answered from the cwd or global config instead — describing a
   * configuration it is not running on.
   */
  configPath?: string,
): Promise<{ location?: ResolvedConfigLocation; config: StratusConfigFile }> => {
  let location: ResolvedConfigLocation | undefined;
  try {
    location = await resolveConfigLocation(configPath ? { configPath } : {}, env);
  } catch (error) {
    warn(`ignoring unreadable config (${error instanceof Error ? error.message : String(error)})`);
    return { config: {} };
  }
  if (!location) {
    return { config: {} };
  }
  try {
    return { location, config: await loadConfigFile(location.path) };
  } catch (error) {
    warn(`ignoring unreadable config ${location.path} (${error instanceof Error ? error.message : String(error)})`);
    return { location, config: {} };
  }
};

/**
 * What reading a trusted-config-only block found. Four outcomes because
 * they mean four different things to an operator, and collapsing any two
 * of them loses the one thing they need to know: nothing was configured, it
 * was configured somewhere that may not decide this, it could not be read,
 * or here it is.
 */
export type TrustedConfigBlock<T> =
  | { status: 'absent' }
  | { status: 'present'; value: T; path: string }
  | { status: 'untrusted'; path: string }
  | { status: 'unreadable'; error: unknown };

/**
 * Read one block of the daemon's own config, honouring the trust boundary.
 *
 * `api`, `approvals`, and `plugins` are all read this way: which interface
 * a daemon binds, who may approve its tool calls, and whose code runs
 * in-process with it are not decisions an auto-discovered project-local
 * `stratus.config.json` gets to make, because that file ships in any
 * repository somebody clones.
 *
 * The precedence is `resolveConfigLocation`'s, not a second copy of it —
 * `--config` and STRATUS_CONFIG both move the file, and a caller reading
 * `~/.stratus/config.json` directly would answer from a config the daemon
 * is not running on. Callers phrase their own warning: an ignored approver
 * list and an ignored plugin list are the same rule and very different
 * sentences.
 */
export const readTrustedConfigBlock = async <K extends keyof StratusConfigFile>(
  key: K,
  env: StateEnvironment,
  configPath?: string,
): Promise<TrustedConfigBlock<NonNullable<StratusConfigFile[K]>>> => {
  let location: ResolvedConfigLocation | undefined;
  try {
    location = await resolveConfigLocation(configPath ? { configPath } : {}, env);
    if (!location) {
      return { status: 'absent' };
    }
    // An untrusted file that fails to load is judged like one that says
    // nothing: it could not have set a trusted-only block whatever it
    // contained, and a malformed block in a clone must not be the reason
    // the operator's own policy is not read — refused is not the same as
    // unreadable. Its own errors reach the operator through `run` and
    // `doctor`, which read the file for what it may set.
    const value = location.trusted
      ? (await loadConfigFile(location.path))[key]
      : await loadConfigFile(location.path).then((config) => config[key], () => undefined);
    if (!location.trusted) {
      if (value !== undefined) {
        return { status: 'untrusted', path: location.path };
      }
      // The project file says nothing about this block, and it shadows
      // the global file in discovery: the trusted file is the answer, as
      // it would be were the project file not there. Otherwise a daemon
      // started inside any cloned repository would run with none of the
      // operator's policy — a clone that cannot set a policy must not be
      // able to make one disappear either.
      return readGlobalConfigBlock(key, env);
    }
    if (value === undefined) {
      return { status: 'absent' };
    }
    return { status: 'present', value: value as NonNullable<StratusConfigFile[K]>, path: location.path };
  } catch (error) {
    return { status: 'unreadable', error };
  }
};

/**
 * The global file's block, for a caller that has already refused the
 * discovered one. Absent only when the file does not exist: a global file
 * that exists and cannot be read (`EACCES`, a directory where a file
 * should be) is `unreadable`, so the caller's fail-closed handling applies
 * — an operator's `admit: "principals"` behind a permission error must not
 * read as no policy at all, which for the Slack door means `anyone`.
 */
export const readGlobalConfigBlock = async <K extends keyof StratusConfigFile>(
  key: K,
  env: StateEnvironment,
): Promise<TrustedConfigBlock<NonNullable<StratusConfigFile[K]>>> => {
  const globalPath = globalConfigPath(env);
  try {
    await stat(globalPath);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { status: 'absent' }
      : { status: 'unreadable', error };
  }
  return readTrustedConfigBlock(key, env, globalPath);
};
