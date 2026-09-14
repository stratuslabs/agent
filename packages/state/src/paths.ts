import path from 'node:path';
import { type StateEnvironment, readHomeDirectory } from './environment.ts';

export const DEFAULT_CONFIG_FILENAME = 'stratus.config.json';

const STRATUS_HOME_DIRNAME = '.stratus';

const WORKSPACES_DIRNAME = 'workspaces';

const GLOBAL_CONFIG_FILENAME = 'config.json';

const CREDENTIALS_FILENAME = 'credentials.json';

const AGENTS_DIRNAME = 'agents';

const SKILLS_DIRNAME = 'skills';

export const MEMORY_FILENAME = 'memory.jsonl';

const LOGS_DIRNAME = 'logs';

const GATEWAY_TOKEN_FILENAME = 'gateway-token';

const GATEWAY_INFO_FILENAME = 'gateway.json';

export const stratusHomePath = (env: StateEnvironment): string =>
  path.join(readHomeDirectory(env), STRATUS_HOME_DIRNAME);

export const globalConfigPath = (env: StateEnvironment): string =>
  path.join(stratusHomePath(env), GLOBAL_CONFIG_FILENAME);

/** Where `stratus serve` keeps its structured log, and `stratus logs` reads it. */
export const logsDirPath = (env: StateEnvironment): string =>
  path.join(stratusHomePath(env), LOGS_DIRNAME);

export const credentialsPath = (env: StateEnvironment): string =>
  path.join(stratusHomePath(env), CREDENTIALS_FILENAME);

export const agentsDirPath = (env: StateEnvironment): string =>
  path.join(stratusHomePath(env), AGENTS_DIRNAME);

export const memoryFilePath = (env: StateEnvironment): string =>
  path.join(stratusHomePath(env), MEMORY_FILENAME);

/**
 * Where tools put files they produce — a screenshot a channel then uploads,
 * a report an agent wrote. One directory per agent, for the same reason
 * sessions, memory, and credentials are keyed that way: an agent's output
 * is that agent's, and a shared scratch directory is two agents reading
 * each other's work.
 *
 * The layout lives here because this package owns `~/.stratus`. Plugins do
 * not derive it — the host passes the resolved path in, so a plugin has no
 * copy of this repository's directory conventions to drift from.
 */
export const workspacesDirPath = (env: StateEnvironment): string =>
  path.join(stratusHomePath(env), WORKSPACES_DIRNAME);

/**
 * Where operator-installed skills live: one directory per skill, the
 * directory name is the id, `SKILL.md` inside it is the procedure. Plugins
 * contribute skills through their manifest instead; this directory is for
 * the ones an operator drops in by hand (or clones from a skill repo).
 */
export const skillsDirPath = (env: StateEnvironment): string =>
  path.join(stratusHomePath(env), SKILLS_DIRNAME);

export const agentWorkspacePath = (env: StateEnvironment, agentId: string): string =>
  path.join(workspacesDirPath(env), agentId);

/**
 * The control API's bearer token (0600). Programmatic clients — the CLI's
 * `--gateway` mode, the macOS app — read it from here rather than being told
 * it, so there is nothing to copy, paste, or leak into a shell history.
 */
export const gatewayTokenPath = (env: StateEnvironment): string =>
  path.join(stratusHomePath(env), GATEWAY_TOKEN_FILENAME);

/**
 * Where a running daemon says it can be reached (0600). Written when the
 * control API binds and removed when it stops, so a client discovers the
 * host and port instead of guessing at a default the operator may have
 * changed.
 */
export const gatewayInfoPath = (env: StateEnvironment): string =>
  path.join(stratusHomePath(env), GATEWAY_INFO_FILENAME);
