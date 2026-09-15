import path from 'node:path';
import { isValidAgentId } from '@stratusagent/agents';
import { type StateEnvironment, readHomeDirectory } from './environment.ts';

export const DEFAULT_CONFIG_FILENAME = 'stratus.config.json';

const STRATUS_HOME_DIRNAME = '.stratus';

const WORKSPACES_DIRNAME = 'workspaces';

const GLOBAL_CONFIG_FILENAME = 'config.json';

const CREDENTIALS_FILENAME = 'credentials.json';

const AGENTS_DIRNAME = 'agents';

const SKILLS_DIRNAME = 'skills';

export const MEMORY_FILENAME = 'memory.jsonl';

const SESSIONS_DB_FILENAME = 'sessions.db';

const FLEET_DB_FILENAME = 'fleet.db';

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

/**
 * The shared memory file every agent's entries used to share. Nothing reads
 * it any more — {@link agentMemoryFilePath} is where an agent's memories
 * live — and it survives as the migration's source and as the name the
 * archive it leaves behind is derived from.
 */
export const legacyMemoryFilePath = (env: StateEnvironment): string =>
  legacyMemoryFileIn(stratusHomePath(env));

/** {@link legacyMemoryFilePath} against an explicit state directory. */
export const legacyMemoryFileIn = (stateDir: string): string =>
  path.join(stateDir, MEMORY_FILENAME);

/**
 * The shared session database the whole fleet used to write to. Same story
 * as {@link legacyMemoryFilePath}: the migration reads it, and the schedule
 * rows it also held move to {@link fleetDbPath}.
 */
export const legacySessionDbPath = (env: StateEnvironment): string =>
  legacySessionDbIn(stratusHomePath(env));

/**
 * {@link legacySessionDbPath} against an explicit state directory — what a
 * host that pointed the stores somewhere other than `~/.stratus` has to ask
 * about, since that is the directory its sessions would be stranded in.
 */
export const legacySessionDbIn = (stateDir: string): string =>
  path.join(stateDir, SESSIONS_DB_FILENAME);

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

// ---- the per-agent state layout -------------------------------------------
//
// Every durable resource one agent owns lives under its own directory,
// `~/.stratus/agents/<id>/`, rather than in a shared file keyed by agent id.
// The point is structural: a store is opened on an agent's path, so there is
// no query another agent's rows could come back from — the handle does not
// exist rather than a filter having remembered to exclude them. See
// docs/roadmap/15-agent-isolation.md.
//
// Ids key these joins, which is why `isValidAgentId` refuses anything that
// is not a single path segment. The callers below take an id the roster (or
// a stored row) already carries and assert that rule rather than re-checking
// shapes: an id that reaches a join unvalidated is the escape the rule
// exists to stop.

/**
 * Where one agent's durable state lives — its sessions, its memories, its
 * grants. Owner-only, like `credentials.json`: the directory holds
 * conversation bodies and the list of what the agent may do unattended.
 *
 * The agent's soul stays a *file* in the parent directory
 * (`agents/<id>.md`), because a soul is the operator's input rather than
 * the agent's state: it is edited, copied between machines, and read by
 * `stratus agents` with no daemon anywhere near it.
 */
export const agentStateDirPath = (env: StateEnvironment, agentId: string): string =>
  agentStateDirIn(stratusHomePath(env), agentId);

/**
 * {@link agentStateDirPath} against an explicit state directory — what an
 * embedder pointing Stratus at somewhere other than `~/.stratus` passes,
 * and what every helper below is written in terms of so there is one join
 * to get wrong rather than five.
 */
export const agentStateDirIn = (stateDir: string, agentId: string): string => {
  assertPathSafeAgentId(agentId);
  return path.join(stateDir, AGENTS_DIRNAME, agentId);
};

/** The directory holding the souls and the per-agent state directories. */
export const agentsDirIn = (stateDir: string): string =>
  path.join(stateDir, AGENTS_DIRNAME);

/** One agent's session database. */
export const agentSessionDbPath = (env: StateEnvironment, agentId: string): string =>
  agentSessionDbIn(stratusHomePath(env), agentId);

/** {@link agentSessionDbPath} against an explicit state directory. */
export const agentSessionDbIn = (stateDir: string, agentId: string): string =>
  path.join(agentStateDirIn(stateDir, agentId), SESSIONS_DB_FILENAME);

/** One agent's long-term memory, and the FTS index derived beside it. */
export const agentMemoryFilePath = (env: StateEnvironment, agentId: string): string =>
  agentMemoryFileIn(stratusHomePath(env), agentId);

/** {@link agentMemoryFilePath} against an explicit state directory. */
export const agentMemoryFileIn = (stateDir: string, agentId: string): string =>
  path.join(agentStateDirIn(stateDir, agentId), MEMORY_FILENAME);

// One agent's persistent grants live in this directory too, at
// `whitelist.json`. The join is `whitelistPathFor` in
// `@stratusagent/permissions`, which owns the file's format and is the
// only place that spells its name — a second copy here would be the
// second implementation of a rule, and the daemon reading one path while
// the migration wrote another is exactly how a grant list goes quiet.

/**
 * The fleet's own database: the schedule rows, and the session index that
 * says which agent's store holds a given session id.
 *
 * Deliberately *not* sharded. A schedule is fleet infrastructure — the
 * scheduler ticks once for everyone, `stratus schedules` is the fleet's
 * audit list, and a bare-id cancel revokes the standing destination grant
 * riding on the row — so a schedule living in whichever per-agent file
 * happened to be open would neither fire, nor appear, nor be cancellable.
 * The session index is fleet-wide for the same kind of reason: session ids
 * are caller-chosen and the control API resolves them with no agent in
 * hand.
 */
export const fleetDbPath = (env: StateEnvironment): string =>
  fleetDbIn(stratusHomePath(env));

/** {@link fleetDbPath} against an explicit state directory. */
export const fleetDbIn = (stateDir: string): string =>
  path.join(stateDir, FLEET_DB_FILENAME);

/**
 * Thrown rather than sanitized: an id that cannot key a path is a bug or an
 * attack, and rewriting `../../escape` into `escape` hands back an agent
 * nobody asked for, keyed to resources nobody named.
 */
export const assertPathSafeAgentId = (agentId: string): void => {
  if (!isValidAgentId(agentId)) {
    throw new Error(
      `${JSON.stringify(agentId)} cannot key a per-agent directory — an agent id must be a single path segment. `
      + 'Fix the `id:` in the soul, or address the agent by the id `stratus agents` lists.',
    );
  }
};
