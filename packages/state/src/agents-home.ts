import { randomUUID } from 'node:crypto';
import { constants, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import {
  copyFile,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { isValidAgentId } from '@stratusagent/agents';
import { assertDerivedStatePath } from '@stratusagent/permissions';

import { type StateEnvironment, readHomeDirectory, readNonEmptyString, readProcessEnv } from './environment.ts';
import { agentStateDirPath, agentWorkspacePath, agentsDirPath, foldedAgentId, stratusHomePath } from './paths.ts';
import { DEFAULT_STRATUS_AGENT, loadSoulFile } from './souls.ts';
import { remapLedger } from './workspace-migration.ts';

// ---- the agents folder ----------------------------------------------------
//
// `~/.stratus` is the daemon's: config, credentials, sessions, memories,
// grants. What a person actually opens is an agent's soul and the files it
// produced, and those used to sit in the same hidden directory, so editing a
// soul meant showing hidden files first. They now live in a visible folder
// beside Documents and Downloads, `~/Agents/<id>/`, and the hidden paths the
// runtime has always read (`agents/<id>.md`, `agents/<id>/workspace`) are
// links into it.
//
// Links rather than a repointed layout, deliberately. Every reader of a soul
// or a workspace (the roster, grants, the provenance ledger's guard, the
// sandbox mounts, five plugins) addresses them through `paths.ts`, and both
// already allow a link at exactly those two leaves: a soul symlinked from a
// dotfiles checkout, a workspace relocated to another volume. Making the
// visible folder the target of links an older build already follows keeps
// every one of those contracts as it is, and means a downgrade still finds
// every agent.
//
// The folder is only ever one Stratus created. `Agents` is a generic name and
// somebody may already have one, so ownership is a marker file inside it: a
// folder with the marker is ours, a missing one is ours to create, and one
// that exists without the marker is somebody else's and is never written to.
// Then `Stratus`, by the same rule. When both are taken, nothing becomes
// visible and everything stays where it was: a missing convenience, not a
// failure.

/** The file that says a folder is Stratus's agents folder. */
export const AGENTS_HOME_MARKER = '.stratus-agents';

/** The environment variable naming the agents folder outright. */
export const AGENTS_DIR_ENV = 'STRATUS_AGENTS_DIR';

/** Tried in order: the first one that is ours, else the first one that is free. */
const AGENTS_HOME_NAMES = ['Agents', 'Stratus'] as const;

/** One agent's soul inside its visible folder. */
export const VISIBLE_SOUL_FILENAME = 'soul.md';

const VISIBLE_WORKSPACE_DIRNAME = 'workspace';

/**
 * Left in the agent's *state* directory while its workspace is between the
 * rename and the ledger remap, holding the old spellings the remap needs. A
 * start that finds one finishes the move instead of reading the absent
 * workspace as nothing to do.
 */
const SURFACING_MARKER = '.workspace-surfacing';

const MARKER_TEXT = [
  'This folder is managed by Stratus.',
  '',
  'Each folder in here is one agent: soul.md is the file that defines it (edit it freely),',
  'and workspace/ holds the files its tools produced.',
  'Stratus keeps its own state (sessions, memories, settings) in ~/.stratus.',
  '',
].join('\n');

type CandidateState = 'ours' | 'free' | 'taken';

/**
 * Followed rather than `lstat`ed: an operator who points `~/Agents` at a
 * synced folder made a layout decision, and the marker inside it still says
 * whether it is ours. Case is the filesystem's question, not this one's: on
 * a case-insensitive volume an existing `~/agents` *is* `~/Agents`, so it
 * reads as present here and, with no marker, as taken.
 */
const candidateState = (directory: string): CandidateState => {
  try {
    if (!statSync(directory).isDirectory()) {
      return 'taken';
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // A dangling link at the name is not free: creating the folder would
      // create it wherever that link points.
      try {
        lstatSync(directory);
        return 'taken';
      } catch {
        return 'free';
      }
    }
    if (code === 'ENOTDIR') {
      return 'taken';
    }
    throw error;
  }
  try {
    return statSync(path.join(directory, AGENTS_HOME_MARKER)).isFile() ? 'ours' : 'taken';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'taken';
    }
    throw error;
  }
};

/** The filesystem a path is on, following links; undefined when it does not exist. */
const deviceOf = (target: string): number | undefined => {
  try {
    return statSync(target).dev;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
};

const insideOrAt = (outer: string, candidate: string): boolean => {
  const relative = path.relative(outer, candidate);
  return relative.length === 0 || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

/**
 * The folder named by {@link AGENTS_DIR_ENV}, if one is. `~` expands to the
 * home this environment reads, so a test or a service unit naming it means
 * the same folder the rest of the state does.
 */
const configuredAgentsHome = (env: StateEnvironment): string | 'off' | undefined => {
  const raw = readNonEmptyString(readProcessEnv(env)[AGENTS_DIR_ENV]);
  if (typeof raw !== 'string') {
    return undefined;
  }
  if (raw === 'off') {
    return 'off';
  }
  const expanded = raw === '~' || raw.startsWith(`~${path.sep}`) || raw.startsWith('~/')
    ? path.join(readHomeDirectory(env), raw.slice(1))
    : raw;
  const resolved = path.resolve(expanded);
  // Inside the hidden home it would be a folder of links pointing at itself,
  // and everything in it is protected from the agents anyway.
  if (insideOrAt(stratusHomePath(env), resolved)) {
    throw new Error(
      `${AGENTS_DIR_ENV} names ${resolved}, which is inside ${stratusHomePath(env)}. `
      + 'Point it at a folder outside the Stratus home, or unset it to use ~/Agents.',
    );
  }
  return resolved;
};

/**
 * Where the agents folder is, without creating anything: the folder
 * {@link AGENTS_DIR_ENV} names, else `~/Agents` or `~/Stratus` — the first one
 * already marked as ours, else the first that does not exist yet. Undefined
 * when both exist and neither is ours.
 */
export const resolveAgentsHome = (env: StateEnvironment): string | undefined => {
  const configured = configuredAgentsHome(env);
  if (configured === 'off') {
    return undefined;
  }
  if (configured !== undefined) {
    return configured;
  }
  const home = readHomeDirectory(env);
  // Only beside a Stratus home on the same filesystem. The Docker image
  // keeps `~/.stratus` on a volume and the rest of the home in the
  // container's own layer, which is gone when the container is recreated:
  // a soul written to `~/Agents` there would be lost with it, and the link
  // left on the volume would point at nothing. Any host that mounts the
  // Stratus home separately (a Fly volume, a second disk) is the same case,
  // so the rule is the device rather than a list of platforms. An explicit
  // `STRATUS_AGENTS_DIR` is the operator's call and is not second-guessed.
  const stateDevice = deviceOf(stratusHomePath(env));
  if (stateDevice !== undefined && deviceOf(home) !== stateDevice) {
    return undefined;
  }
  const candidates = AGENTS_HOME_NAMES.map((name) => {
    const directory = path.join(home, name);
    return { directory, state: candidateState(directory) };
  });
  return (candidates.find((candidate) => candidate.state === 'ours')
    ?? candidates.find((candidate) => candidate.state === 'free'))?.directory;
};

const LINK_UNAVAILABLE = new Set(['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS', 'EOPNOTSUPP']);

/**
 * Whether symlinks can be created in `directory`, by making (and removing)
 * a dangling one. Only a refusal says no; any other failure is thrown.
 */
const canLinkFrom = (directory: string): boolean => {
  mkdirSync(directory, { recursive: true });
  const probe = path.join(directory, `.link-probe-${randomUUID()}`);
  try {
    symlinkSync(`${probe}.target`, probe, 'file');
  } catch (error) {
    if (LINK_UNAVAILABLE.has((error as NodeJS.ErrnoException).code ?? '')) {
      return false;
    }
    throw error;
  }
  rmSync(probe, { force: true });
  return true;
};

/**
 * {@link resolveAgentsHome}, creating the folder and its marker when it is
 * not there yet. Synchronous because its caller, `AgentWorkspaces.prepare`,
 * is.
 *
 * A free name is claimed by renaming a fully built folder onto it rather
 * than by `mkdir` and then the marker. Between those two steps a second
 * process would see a folder with no marker, read it as somebody else's,
 * and settle on `~/Stratus` — two processes, two agents folders. A rename
 * either lands a folder that already carries the marker or fails because
 * the name is taken, and the loop then asks again.
 */
export const claimAgentsHome = (env: StateEnvironment): string | undefined => {
  const configured = configuredAgentsHome(env);
  if (configured === 'off') {
    return undefined;
  }
  // Everything in the folder is reached through a link from the hidden
  // home. Where links cannot be made (Windows without Developer Mode or
  // Administrator), claim nothing and keep the hidden layout.
  if (!canLinkFrom(agentsDirPath(env))) {
    return undefined;
  }
  if (configured !== undefined) {
    mkdirSync(configured, { recursive: true, mode: 0o700 });
    try {
      writeFileSync(path.join(configured, AGENTS_HOME_MARKER), MARKER_TEXT, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
    return configured;
  }
  for (let attempt = 0; attempt < AGENTS_HOME_NAMES.length + 1; attempt += 1) {
    const resolved = resolveAgentsHome(env);
    if (resolved === undefined || candidateState(resolved) === 'ours') {
      return resolved;
    }
    const staging = path.join(path.dirname(resolved), `.stratus-agents-${randomUUID()}`);
    mkdirSync(staging, { mode: 0o700 });
    try {
      writeFileSync(path.join(staging, AGENTS_HOME_MARKER), MARKER_TEXT, { flag: 'wx', mode: 0o600 });
      // POSIX `rename` replaces an *empty* directory at the destination. A
      // folder somebody made and left empty is the one thing that could be
      // replaced that way, and it holds nothing to lose.
      renameSync(staging, resolved);
      return resolved;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY' && code !== 'ENOTDIR' && code !== 'EISDIR') {
        throw error;
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  return resolveAgentsHome(env);
};

/** One agent's visible folder. */
export const visibleAgentDirIn = (agentsHome: string, agentId: string): string => {
  if (!isValidAgentId(agentId)) {
    throw new Error(`${JSON.stringify(agentId)} cannot name an agent folder — an agent id must be a single path segment.`);
  }
  return path.join(agentsHome, agentId);
};

/** One agent's soul in its visible folder. */
export const visibleSoulPathIn = (agentsHome: string, agentId: string): string =>
  path.join(visibleAgentDirIn(agentsHome, agentId), VISIBLE_SOUL_FILENAME);

/** One agent's workspace in its visible folder. */
export const visibleWorkspacePathIn = (agentsHome: string, agentId: string): string =>
  path.join(visibleAgentDirIn(agentsHome, agentId), VISIBLE_WORKSPACE_DIRNAME);

const linkTextSync = (filePath: string): string | undefined => {
  try {
    return readlinkSync(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EINVAL') {
      return undefined;
    }
    throw error;
  }
};

/**
 * Called by `AgentWorkspaces.prepare` before it creates the workspace: a
 * workspace that does not exist yet is made in the agents folder and linked
 * from its hidden path, so a new agent's output is somewhere a person can
 * open. And a link of ours whose folder somebody deleted gets an empty
 * folder back, rather than every tool that writes a file failing on a
 * dangling link.
 *
 * Anything else at the hidden path is left exactly as it is: an existing
 * real workspace (moved later, by {@link surfaceAgentsHome}, which holds the
 * home), or a link an operator made to put the output on another volume.
 */
export const surfaceNewWorkspaceSync = (env: StateEnvironment, agentId: string): void => {
  const hidden = agentWorkspacePath(env, agentId);
  let present = true;
  try {
    lstatSync(hidden);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    present = false;
  }
  if (present) {
    const text = linkTextSync(hidden);
    if (text === undefined) {
      return;
    }
    const target = path.resolve(path.dirname(hidden), text);
    const agentsHome = resolveAgentsHome(env);
    if (agentsHome !== undefined && target === visibleWorkspacePathIn(agentsHome, agentId)) {
      mkdirSync(target, { recursive: true, mode: 0o700 });
    }
    return;
  }
  const agentsHome = claimAgentsHome(env);
  if (agentsHome === undefined) {
    return;
  }
  const visible = visibleWorkspacePathIn(agentsHome, agentId);
  mkdirSync(visible, { recursive: true, mode: 0o700 });
  try {
    symlinkSync(visible, hidden, 'dir');
  } catch (error) {
    // Another process linked it first; whatever is there now is the
    // workspace, and `prepare` goes on to use it.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
};

/**
 * Write a new agent's soul: into its folder in the agents folder, linked
 * from `agents/<file>` where the roster reads it. Exclusive at both ends, so
 * it fails with `EEXIST` exactly where an exclusive write of the hidden file
 * would, and callers keep the claim-or-retry logic they already have.
 *
 * `replace` is `template add --force`: an existing soul in that agent's
 * folder is replaced (atomically, so an editor holding it open sees one
 * file or the other), where without it the folder's soul counts as taken.
 *
 * With no agents folder available, the soul is written at the hidden path as
 * it always was.
 */
export const writeNewSoulFile = async (
  env: StateEnvironment,
  file: string,
  agentId: string,
  contents: string,
  options: { replace?: boolean } = {},
): Promise<string> => {
  const hidden = path.join(agentsDirPath(env), file);
  await assertDerivedStatePath(stratusHomePath(env), agentsDirPath(env), 'directory');
  await mkdir(agentsDirPath(env), { recursive: true });
  const agentsHome = isValidAgentId(agentId) && foldedAgentId(agentId) !== DEFAULT_STRATUS_AGENT.id
    ? claimAgentsHome(env)
    : undefined;
  if (agentsHome === undefined) {
    await writeFile(hidden, contents, { flag: 'wx' });
    return hidden;
  }
  const visible = visibleSoulPathIn(agentsHome, agentId);
  await mkdir(path.dirname(visible), { recursive: true, mode: 0o700 });
  if (options.replace === true) {
    // Claim the hidden name before touching the visible soul, so a name
    // taken meanwhile fails with the person's soul still as it was. Until
    // the rename the link serves the old soul, which is still a whole soul.
    const temporary = `${visible}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, contents, { flag: 'wx', mode: 0o644 });
      await symlink(visible, hidden, 'file');
      await rename(temporary, visible);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    return hidden;
  }
  await writeFile(visible, contents, { flag: 'wx', mode: 0o644 });
  try {
    await symlink(visible, hidden, 'file');
  } catch (error) {
    // The hidden name is taken after all: leave nothing behind that a later
    // claim of this id would trip over.
    await unlink(visible).catch(() => undefined);
    throw error;
  }
  return hidden;
};

// ---- moving what is already there ------------------------------------------

/** What one pass did, for the line `serve` and `update` log. */
interface SurfaceReport {
  souls: number;
  workspaces: number;
  skipped: string[];
}

const errnoOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

const lstatOrUndefined = async (filePath: string) => {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
};

/**
 * Replace a hidden file with a link to `target`, in one rename, so there is
 * no moment at which the roster lists the agent as missing.
 */
const replaceWithLink = async (hidden: string, target: string, kind: 'file' | 'dir'): Promise<void> => {
  const temporary = path.join(path.dirname(hidden), `.${path.basename(hidden)}.${randomUUID()}.link`);
  await symlink(target, temporary, kind);
  try {
    await rename(temporary, hidden);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
};

/**
 * One soul file: hard-linked into the agent's folder, then the hidden name
 * swapped for a symlink to it. A crash between the two leaves the same file
 * at both names, which the next pass recognises by inode and finishes; at no
 * point is the roster missing it. A copy stands in for the hard link only
 * where the filesystem refuses one.
 */
const surfaceSoul = async (env: StateEnvironment, agentsHome: string, file: string, report: SurfaceReport): Promise<void> => {
  const hidden = path.join(agentsDirPath(env), file);
  let agentId: string;
  try {
    agentId = (await loadSoulFile(hidden)).agent.id;
  } catch {
    // An unreadable soul is the roster's to report, and it does.
    return;
  }
  if (!isValidAgentId(agentId) || foldedAgentId(agentId) === DEFAULT_STRATUS_AGENT.id) {
    return;
  }
  const visible = visibleSoulPathIn(agentsHome, agentId);
  const hiddenInfo = await lstat(hidden);
  const visibleInfo = await lstatOrUndefined(visible);
  if (visibleInfo !== undefined) {
    if (visibleInfo.ino !== hiddenInfo.ino || visibleInfo.dev !== hiddenInfo.dev) {
      report.skipped.push(`${file} (${visible} already exists)`);
      return;
    }
  } else {
    await mkdir(path.dirname(visible), { recursive: true, mode: 0o700 });
    try {
      await link(hidden, visible);
    } catch (error) {
      const code = errnoOf(error);
      if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EMLINK') {
        throw error;
      }
      await copyFile(hidden, visible, constants.COPYFILE_EXCL);
    }
  }
  await replaceWithLink(hidden, visible, 'file');
  report.souls += 1;
};

interface SurfacingRecord {
  from: string[];
  to: string;
}

/** Re-record the ledger at the new path, then retire the marker. */
const finishWorkspace = async (hidden: string, marker: string, record: SurfacingRecord): Promise<void> => {
  const info = await lstatOrUndefined(hidden);
  if (info === undefined) {
    await symlink(record.to, hidden, 'dir');
  } else if (!info.isSymbolicLink() || path.resolve(path.dirname(hidden), await readlink(hidden)) !== record.to) {
    // Something else took the hidden name in the window; the moved folder
    // stays where it is and is still reachable by its visible path.
    throw new Error(
      `${hidden} was recreated while its workspace was moving to ${record.to}. `
      + `Move any files in it into ${record.to}, remove it, and restart; ${marker} records the move.`,
    );
  }
  const canonical = await realpath(record.to);
  await remapLedger(record.to, record.from, canonical);
  await rm(marker, { force: true });
};

/**
 * One workspace: renamed into the agent's folder and linked from its hidden
 * path, with its provenance ledger re-recorded at the new location. The
 * ledger keys records by canonical path, so without the remap every file a
 * fetch or an MCP server wrote would lose its "came from outside" label.
 *
 * A marker beside the workspace, written before the rename and removed after
 * the remap, is what makes the move finishable: the remap needs the old
 * spellings, and after the rename nothing on disk says what they were.
 */
const surfaceWorkspace = async (env: StateEnvironment, agentsHome: string, agentId: string, report: SurfaceReport): Promise<void> => {
  const hidden = agentWorkspacePath(env, agentId);
  const stateDir = agentStateDirPath(env, agentId);
  const marker = path.join(stateDir, SURFACING_MARKER);
  const pending = await readFile(marker, 'utf8').then((raw) => JSON.parse(raw) as SurfacingRecord, (error: unknown) => {
    if (errnoOf(error) === 'ENOENT') {
      return undefined;
    }
    throw error;
  });
  if (pending !== undefined) {
    await finishWorkspace(hidden, marker, pending);
    report.workspaces += 1;
    return;
  }
  const info = await lstatOrUndefined(hidden);
  if (info === undefined || !info.isDirectory()) {
    // Absent (prepare will make it in the folder), or a link: ours already,
    // or an operator's relocation, which is theirs.
    return;
  }
  const visible = visibleWorkspacePathIn(agentsHome, agentId);
  if (await lstatOrUndefined(visible) !== undefined) {
    report.skipped.push(`${agentId}'s workspace (${visible} already exists)`);
    return;
  }
  const from = [hidden];
  const canonical = path.join(await realpath(stateDir), VISIBLE_WORKSPACE_DIRNAME);
  if (canonical !== hidden) {
    from.push(canonical);
  }
  const record: SurfacingRecord = { from, to: visible };
  await mkdir(path.dirname(visible), { recursive: true, mode: 0o700 });
  await writeFile(marker, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  try {
    await rename(hidden, visible);
  } catch (error) {
    await rm(marker, { force: true });
    if (errnoOf(error) === 'EXDEV') {
      report.skipped.push(`${agentId}'s workspace (on another volume from ${agentsHome})`);
      return;
    }
    throw error;
  }
  await finishWorkspace(hidden, marker, record);
  report.workspaces += 1;
};

/**
 * Move every agent's soul and workspace that is still a real file in
 * `~/.stratus/agents` into the agents folder, leaving links behind. Run by
 * `stratus serve` and `stratus update` while they hold the home, beside the
 * workspace repair and for the same reason: this has no stamp, because a soul
 * dropped into `~/.stratus/agents/` by hand (or by an older build) should
 * become visible too, and asking costs one directory listing.
 *
 * Needs the home to itself. A daemon of an older build that wrote a file
 * into a workspace between its rename and its link would recreate the old
 * directory, and its provenance records with it, at a path this then finds
 * taken.
 *
 * Returns the line to log, or undefined when there was nothing to do.
 */
export const surfaceAgentsHome = async (env: StateEnvironment): Promise<string | undefined> => {
  let entries;
  try {
    entries = await readdir(agentsDirPath(env), { withFileTypes: true });
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  const souls = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md')).map((entry) => entry.name).sort();
  const agentDirs = entries.filter((entry) => entry.isDirectory() && isValidAgentId(entry.name)).map((entry) => entry.name).sort();
  const pendingWork = souls.length > 0 || (await Promise.all(agentDirs.map(async (agentId) => {
    const info = await lstatOrUndefined(agentWorkspacePath(env, agentId));
    return (info?.isDirectory() ?? false)
      || await lstatOrUndefined(path.join(agentStateDirPath(env, agentId), SURFACING_MARKER)) !== undefined;
  }))).some(Boolean);
  if (!pendingWork) {
    return undefined;
  }
  await assertDerivedStatePath(stratusHomePath(env), agentsDirPath(env), 'directory');
  const agentsHome = claimAgentsHome(env);
  if (agentsHome === undefined) {
    return undefined;
  }
  const report: SurfaceReport = { souls: 0, workspaces: 0, skipped: [] };
  // One agent's failure is that agent's line in the report, never a start
  // refused for the whole fleet: everything this does leaves the agent
  // working from wherever its files are now, and a workspace caught between
  // its rename and its link keeps the marker that lets the next start (or
  // `prepare`, which links it on the next write) finish it.
  const each = async (name: string, work: () => Promise<void>): Promise<void> => {
    try {
      await work();
    } catch (error) {
      report.skipped.push(`${name} (${error instanceof Error ? error.message : String(error)})`);
    }
  };
  for (const file of souls) {
    await each(file, () => surfaceSoul(env, agentsHome, file, report));
  }
  for (const agentId of agentDirs) {
    await each(`${agentId}'s workspace`, () => surfaceWorkspace(env, agentsHome, agentId, report));
  }
  const parts: string[] = [];
  if (report.souls > 0 || report.workspaces > 0) {
    parts.push(`moved ${report.souls} soul(s) and ${report.workspaces} workspace(s) into ${agentsHome}`);
  }
  if (report.skipped.length > 0) {
    parts.push(`left in place: ${report.skipped.join('; ')}`);
  }
  return parts.length > 0 ? parts.join('; ') : undefined;
};

/**
 * What `stratus doctor` says about the agents folder: where it is, and any
 * hidden soul or workspace link of ours whose target is gone (somebody
 * deleted or renamed the agent's folder). Reads only.
 */
export const inspectAgentsHome = async (env: StateEnvironment): Promise<{ agentsHome?: string; dangling: string[] }> => {
  const agentsHome = resolveAgentsHome(env);
  const dangling: string[] = [];
  let entries;
  try {
    entries = await readdir(agentsDirPath(env), { withFileTypes: true });
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') {
      return { ...(agentsHome !== undefined ? { agentsHome } : {}), dangling };
    }
    throw error;
  }
  const candidates = entries.flatMap((entry) => {
    if (entry.isSymbolicLink() && entry.name.endsWith('.md')) {
      return [path.join(agentsDirPath(env), entry.name)];
    }
    if (entry.isDirectory() && isValidAgentId(entry.name)) {
      return [agentWorkspacePath(env, entry.name)];
    }
    return [];
  });
  for (const candidate of candidates) {
    let text: string;
    try {
      text = await readlink(candidate);
    } catch {
      continue;
    }
    const target = path.resolve(path.dirname(candidate), text);
    if (agentsHome === undefined || !insideOrAt(agentsHome, target)) {
      continue;
    }
    if (await lstatOrUndefined(target) === undefined) {
      dangling.push(`${candidate} -> ${target}`);
    }
  }
  return { ...(agentsHome !== undefined ? { agentsHome } : {}), dangling };
};
