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

/**
 * An auto-discovered project config that discovery passed over because it
 * cannot be read, parsed, or validated. Only a discovered file is ever
 * skipped: one somebody named with --config or STRATUS_CONFIG is what they
 * asked for, so a run on it fails instead.
 */
export interface SkippedConfigFile {
  path: string;
  /** What went wrong, as the loader said it, without the path. */
  reason: string;
}

export interface ConfigDiscovery {
  location?: ResolvedConfigLocation;
  skipped?: SkippedConfigFile;
}

/**
 * Which config a run started here uses, and the project file it passed
 * over, if any.
 *
 * A project-local `stratus.config.json` is untrusted, so it can't be a
 * reason the operator's own config stops working: one that won't load is
 * skipped, and discovery goes on to the global file, the same answer the
 * trusted readers (`readTrustedConfigBlock`, `trustedConfigError`) give. A
 * global file that exists and can't be read still throws: it is the
 * operator's, and running on built-in defaults instead would describe a
 * configuration they never chose. Callers that talk to someone say the
 * skip; the rest get `resolveConfigLocation`.
 */
export const discoverConfigLocation = async (
  selection: Pick<RuntimeSelection, 'configPath'>,
  env: StateEnvironment,
): Promise<ConfigDiscovery> => {
  const processEnv = readProcessEnv(env);
  const cwd = readWorkingDirectory(env);
  const explicit = selection.configPath ?? processEnv.STRATUS_CONFIG;

  if (explicit) {
    return { location: { path: path.resolve(cwd, explicit), trusted: true } };
  }

  // Project-local configs win; the global ~/.stratus/config.json written by
  // `stratus setup` is the fallback that makes the CLI work from anywhere.
  // The project file is loaded in full, not only read, because a file that
  // reads but won't parse fails every run just the same.
  let skipped: SkippedConfigFile | undefined;
  const projectPath = path.join(cwd, DEFAULT_CONFIG_FILENAME);
  try {
    await loadConfigFile(projectPath);
    return { location: { path: projectPath, trusted: false } };
  } catch (error) {
    if ((error as ConfigFileError).code !== 'ENOENT') {
      const cause = error instanceof ConfigFileError ? error.cause : error;
      skipped = { path: projectPath, reason: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  const globalPath = globalConfigPath(env);
  try {
    await readFile(globalPath, 'utf8');
    return { location: { path: globalPath, trusted: true }, ...(skipped ? { skipped } : {}) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // A config that exists but cannot be read is the same class of
      // failure as one that cannot be parsed — typed, so long-running
      // callers can degrade instead of failing every dispatch.
      throw new ConfigFileError(globalPath, error);
    }
  }

  return skipped ? { skipped } : {};
};

/** {@link discoverConfigLocation}'s answer, for callers with nobody to tell about a skipped file. */
export const resolveConfigLocation = async (
  selection: Pick<RuntimeSelection, 'configPath'>,
  env: StateEnvironment,
): Promise<ResolvedConfigLocation | undefined> => (await discoverConfigLocation(selection, env)).location;

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
  let discovery: ConfigDiscovery;
  try {
    discovery = await discoverConfigLocation(configPath ? { configPath } : {}, env);
  } catch (error) {
    warn(`ignoring unreadable config (${error instanceof Error ? error.message : String(error)})`);
    return { config: {} };
  }
  const { location, skipped } = discovery;
  if (skipped) {
    warn(`ignoring unreadable config ${skipped.path} (${skipped.reason})`);
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

/**
 * Why the trusted config a daemon would read cannot be used, if it cannot.
 *
 * Exactly the files `readTrustedConfigBlock` reads, so it answers "would a
 * block come back `unreadable`": the file discovery picks when that file is
 * trusted, and the global one behind an untrusted project file. A project
 * file that fails to parse is not a reason, by the same rule the block
 * reader follows — it could not have set a trusted block whatever it said,
 * and a malformed file in a clone must not keep the operator's daemon down.
 * Nor is one that cannot be read at all: discovery skips both kinds.
 *
 * Exists for `stratus serve`'s start (#214). Each block degrades on its own
 * when the file will not load — no plugins, the built-in soul, no
 * approvers, every Slack sender refused — so a daemon on a broken file
 * comes up answering in Slack as nobody, with no tools, and looks healthy.
 * A daemon already running keeps its last good config instead; that is the
 * gateway's call, and this is not consulted there.
 */
export const trustedConfigError = async (
  env: StateEnvironment,
  configPath?: string,
): Promise<ConfigFileError | undefined> => {
  const asConfigError = (filePath: string, error: unknown): ConfigFileError =>
    error instanceof ConfigFileError ? error : new ConfigFileError(filePath, error);
  let location: ResolvedConfigLocation | undefined;
  try {
    location = await resolveConfigLocation(configPath ? { configPath } : {}, env);
  } catch (error) {
    return asConfigError(configPath ?? globalConfigPath(env), error);
  }
  if (location === undefined) {
    return undefined;
  }
  let trustedPath = location.path;
  if (!location.trusted) {
    trustedPath = globalConfigPath(env);
    try {
      await stat(trustedPath);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : asConfigError(trustedPath, error);
    }
  }
  try {
    await loadConfigFile(trustedPath);
    return undefined;
  } catch (error) {
    return asConfigError(trustedPath, error);
  }
};
