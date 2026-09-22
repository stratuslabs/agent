import path from 'node:path';
import { isValidAgentId } from '@stratusagent/agents';
import { type StateEnvironment, readHomeDirectory } from './environment.ts';

export const DEFAULT_CONFIG_FILENAME = 'stratus.config.json';

const STRATUS_HOME_DIRNAME = '.stratus';

const WORKSPACES_DIRNAME = 'workspaces';

const WORKSPACE_DIRNAME = 'workspace';

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
 * The shared directory the workspaces used to live in, one subdirectory per
 * agent. Nothing writes here any more — {@link agentWorkspacePath} is where
 * an agent's output goes — and it survives as the migration's source.
 *
 * Kept under its own name rather than repointed, because a plugin handed
 * this path joins the agent id onto it: that is the documented
 * `workspaceRoot` contract, and it is still how a hand-wired host that
 * supplies no `AgentWorkspaces` seam addresses an agent's files.
 */
export const legacyWorkspacesDirPath = (env: StateEnvironment): string =>
  legacyWorkspacesDirIn(stratusHomePath(env));

/** {@link legacyWorkspacesDirPath} against an explicit state directory. */
export const legacyWorkspacesDirIn = (stateDir: string): string =>
  path.join(stateDir, WORKSPACES_DIRNAME);

/**
 * Where operator-installed skills live: one directory per skill, the
 * directory name is the id, `SKILL.md` inside it is the procedure. Plugins
 * contribute skills through their manifest instead; this directory is for
 * the ones an operator drops in by hand (or clones from a skill repo).
 */
export const skillsDirPath = (env: StateEnvironment): string =>
  path.join(stratusHomePath(env), SKILLS_DIRNAME);

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

/**
 * Where tools put files they produce for one agent — a screenshot a channel
 * then uploads, a report the agent wrote. Inside the agent's own state
 * directory, for the same reason its sessions and memories are: an agent's
 * output is that agent's, and a shared scratch directory is two agents
 * reading each other's work.
 *
 * A `workspace` subdirectory rather than the state directory itself, and
 * the extra segment is load-bearing: this path is what `tool-fs` uses as
 * its default root, so an agent can read and write everything under it. Its
 * own sessions, memories and — the one that matters — the `whitelist.json`
 * saying what it may do unattended are siblings of this directory, not
 * descendants, so no canonicalized path inside it reaches them.
 *
 * The layout lives here because this package owns `~/.stratus`. Plugins do
 * not derive it: they ask the host through `AgentWorkspaces`, which
 * {@link createAgentWorkspaces} implements from this join.
 */
export const agentWorkspacePath = (env: StateEnvironment, agentId: string): string =>
  agentWorkspaceIn(stratusHomePath(env), agentId);

/** {@link agentWorkspacePath} against an explicit state directory. */
export const agentWorkspaceIn = (stateDir: string, agentId: string): string =>
  path.join(agentStateDirIn(stateDir, agentId), WORKSPACE_DIRNAME);

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
 * The name two ids collide on, when a filesystem is the one deciding.
 *
 * An id is a *directory name* — `agents/<id>/` holds that agent's sessions,
 * its memories, and the grant file saying what it may do unattended — and
 * macOS and Windows resolve `Ava` and `ava` to one directory. Two agents
 * that are distinct by every other rule here would share all three, so one
 * could act unattended on grants the operator gave the other.
 *
 * Case is not the only thing a filesystem folds. APFS is normalization-
 * insensitive too, so `é` written as one code point and `é` written as `e`
 * followed by a combining acute are one directory there and two distinct
 * strings in JavaScript — a pair that would pass a case-only check and
 * then share every file. Normalizing to NFC first collapses them; the
 * second normalize catches the handful of case mappings whose output is
 * not itself NFC, so that the key does not depend on which of an
 * equivalent pair was written down.
 *
 * Callers refuse a collision on every platform, not only where the
 * filesystem folds: a souls directory is copied between machines, and a
 * roster that loads on the Linux server and refuses on the operator's
 * laptop finds the problem at the worst moment. This is still not any one
 * filesystem's folding table — APFS and NTFS each have their own — but it
 * is deterministic, and where it and a real filesystem disagree the answer
 * to want is the one that refuses, because what the two agents would be
 * sharing is a list of what may run unattended.
 *
 * Exported so `loadRosterSouls` and the layout migration ask the same
 * question: the roster is what stops two *souls* colliding, and the
 * migration walks stored ids no roster ever saw.
 */
export const foldedAgentId = (agentId: string): string =>
  agentId.normalize('NFC').toLowerCase().normalize('NFC');

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
