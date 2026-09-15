import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  appendFile,
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type { MemoryEntry } from '@stratusagent/core';
import { isValidAgentId } from '@stratusagent/agents';
import { type StateEnvironment, readWorkingDirectory } from './environment.ts';
import { applyPerAgentLayout, hasBracketedLegacyState, makeAgentStateDirectory } from './layout-migration.ts';
import {
  MEMORY_FILENAME,
  stratusHomePath,
  logsDirPath,
  credentialsPath,
  agentMemoryFilePath,
  legacyMemoryFilePath,
  gatewayTokenPath,
  gatewayInfoPath,
} from './paths.ts';

// Memory used to live under the working directory. Fold any such file into
// the agents' own stores the first time a run happens from that directory,
// then archive it — an upgrade must never look like the agent forgot.
//
// Every import first takes exclusive ownership by atomically renaming its
// source to a unique claim file: of any competing processes, exactly one
// wins the rename and the rest see ENOENT. A crash mid-import leaves the
// claim file behind; later runs re-claim it the same way and finish the
// job, with entries deduped against the destination by id. Only records
// that parse as real memory entries are imported, and only for an agent id
// that can key a directory — malformed lines and an id that is not a path
// segment stay in the archive instead of poisoning somebody's store.
const isMemoryEntryLine = (line: string): boolean => {
  try {
    const parsed = JSON.parse(line) as Partial<MemoryEntry> | null;
    return typeof parsed === 'object' && parsed !== null
      && typeof parsed.id === 'string'
      && typeof parsed.agentId === 'string'
      && typeof parsed.content === 'string';
  } catch {
    return false;
  }
};

export const migrateLegacyMemory = async (env: StateEnvironment): Promise<void> => {
  const legacyPath = path.join(readWorkingDirectory(env), '.stratus', MEMORY_FILENAME);
  const legacyDir = path.dirname(legacyPath);
  // A run whose working directory *is* the home has nothing to fold in: the
  // source and the per-agent destinations are the same tree.
  if (legacyDir === stratusHomePath(env)) {
    return;
  }
  const archivePath = `${legacyPath}.migrated`;

  const claimAndImport = async (sourcePath: string): Promise<void> => {
    const claimPath = path.join(legacyDir, `${MEMORY_FILENAME}.migrating-${randomUUID()}`);
    try {
      await rename(sourcePath, claimPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return; // another process owns it, or there is nothing to migrate
      }
      throw error;
    }

    const claimed = await readFile(claimPath, 'utf8');

    // Grouped by agent, because the destination is per agent now: one read
    // of each agent's file for its existing ids, one append for its lines.
    const byAgent = new Map<string, string[]>();
    for (const line of claimed.split('\n')) {
      if (line.trim().length === 0 || !isMemoryEntryLine(line)) {
        continue;
      }
      const entry = JSON.parse(line) as MemoryEntry;
      if (!isValidAgentId(entry.agentId)) {
        // An id that cannot key a directory has no store to land in. Left
        // in the archive, like a malformed line — never written to a path
        // derived from it.
        continue;
      }
      const lines = byAgent.get(entry.agentId) ?? [];
      lines.push(line);
      byAgent.set(entry.agentId, lines);
    }

    for (const [agentId, lines] of byAgent) {
      // The directory before anything reads a path *under* it, and never
      // by throwing: an id whose directory name is already taken by its own
      // soul file (`id: ava.md` beside `agents/ava.md`) makes `mkdir` fail
      // with EEXIST, and this runs from `createAgentRuntime` and
      // `gateway.start()` — after the source has been renamed to a claim,
      // so the throw would come back on every later run and block the whole
      // fleet over one agent's name. Skipped instead: the lines stay in the
      // archive written below, which is where a quarantined record belongs.
      if (await makeAgentStateDirectory(env, agentId) === undefined) {
        continue;
      }
      const destination = agentMemoryFilePath(env, agentId);
      let existingIds: Set<string>;
      try {
        existingIds = new Set(
          (await readFile(destination, 'utf8'))
            .split('\n')
            .filter(isMemoryEntryLine)
            .map((line) => (JSON.parse(line) as MemoryEntry).id),
        );
      } catch {
        existingIds = new Set();
      }
      const fresh = lines.filter((line) => !existingIds.has((JSON.parse(line) as MemoryEntry).id));
      if (fresh.length === 0) {
        continue;
      }
      await appendFile(destination, `${fresh.join('\n')}\n`, { mode: 0o600 });
      await chmod(destination, 0o600);
    }

    // Archive by appending (never overwriting an earlier archive), then
    // drop the claim — its content is fully preserved in the archive.
    if (claimed.length > 0) {
      await appendFile(archivePath, claimed.endsWith('\n') || claimed.length === 0 ? claimed : `${claimed}\n`);
    }
    await unlink(claimPath);
  };

  await claimAndImport(legacyPath);

  // Finish any claims a crashed run left behind (both the current unique
  // names and the fixed .migrating name from earlier versions).
  let leftovers: string[];
  try {
    leftovers = await readdir(legacyDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  for (const name of leftovers) {
    if (name.startsWith(`${MEMORY_FILENAME}.migrating`)) {
      await claimAndImport(path.join(legacyDir, name));
    }
  }
};

// ---- versioned state and migrations ----------------------------------------
//
// ~/.stratus is a real on-disk format — config, credentials, souls, memory,
// the session database — and until now nothing stamped it with a version.
// Without a stamp, nothing can know which compatibility shims a given home
// directory has been through, no shim can ever be retired, and a build has
// no way to notice it is looking at state written by a NEWER build — the
// case most likely to corrupt something.
//
// `state.json` is that stamp: a schema version plus the ids of applied
// migrations. Migrations are ordered, idempotent, and record themselves as
// applied one at a time, so a crash mid-sequence re-runs only what never
// recorded itself. They run on first use of a newer build — every install
// path, not only `stratus update` — because state that migrates only
// sometimes is worse than state that never migrates: the two populations
// diverge silently.

const STATE_FILENAME = 'state.json';

/**
 * The schema version a *fully migrated* home is stamped with. Bump it when
 * a migration lands whose absence a newer build must be able to detect —
 * the daemon refuses to run against a HIGHER version than it understands.
 *
 * Fully migrated is the load-bearing word: a home with a deferred
 * migration still pending keeps its old version, because the version is
 * what an older build is refused on, and refusing one over a move that has
 * not happened yet would lock an operator out of the state they still have.
 *
 * 3 is the per-agent layout. An older build against a migrated home would
 * open the shared `sessions.db` that is no longer there, find no history,
 * and start a second one beside the real stores — two divergent
 * populations, which is exactly what the stamp exists to stop.
 */
export const STATE_SCHEMA_VERSION = 3;

export const stateFilePath = (env: StateEnvironment): string =>
  path.join(stratusHomePath(env), STATE_FILENAME);

export interface StateStamp {
  schemaVersion: number;
  /** Ids of migrations that have run to completion, in application order. */
  applied: string[];
}

export interface StateMigration {
  /** Stable id, never reused. Ordering comes from the registry, not the id. */
  id: string;
  /** What applying it does, present tense, for reports. */
  description: string;
  /**
   * Whether applying it to *this* home needs exclusive access to state a
   * serving daemon holds open — the SQLite session database above all.
   *
   * Migrations run automatically on the first command of a newer build,
   * and that path does not stop the managed service: it is the wrong place
   * for a migration that would move a file a daemon of the *older* build
   * is still writing. A migration that says yes is deferred there, and run
   * by the two callers that hold the home to themselves — `stratus
   * update`, which brackets with a stop and a restart, and `stratus
   * serve`, which has the home claim in hand and is about to open the
   * stores itself.
   *
   * A predicate rather than a flag, because most homes have nothing for it
   * to do: a fresh install has no shared database to move, needs no
   * bracket, and must not be left with its schema stamp held back waiting
   * for a daemon start it may not get for days. Answer from what is on
   * disk, not from what the migration would like.
   *
   * Where the answer is yes, the deferral is visible rather than silent:
   * while one is pending the stamp keeps its old schema version, so
   * nothing reads the home as fully migrated, and `stratus update` reports
   * it as pending.
   */
  requiresExclusive?(env: StateEnvironment): Promise<boolean>;
  /**
   * Idempotent: applying twice must equal applying once, because two
   * processes can race the stamp and a crash can lose the record of a
   * completed run. Returns a line describing what actually changed, or
   * undefined when there was nothing to do.
   */
  apply(env: StateEnvironment): Promise<string | undefined>;
}

/**
 * The first recorded migration retires a real class of drift: every file
 * mode in ~/.stratus is enforced on write, but a file created by an older
 * install under a looser umask keeps its old permissions until something
 * writes it again — which for a long-lived credentials file may be never.
 */
const OWNER_ONLY_STATE_FILES_MIGRATION: StateMigration = {
  id: '0001-owner-only-state-files',
  description: 'tighten pre-existing state files to owner-only permissions',
  async apply(env) {
    const tightened: string[] = [];
    const tightenFile = async (filePath: string): Promise<void> => {
      let info;
      try {
        info = await stat(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return;
        }
        throw error;
      }
      if (!info.isFile() || (info.mode & 0o077) === 0) {
        return;
      }
      await chmod(filePath, 0o600);
      tightened.push(path.basename(filePath));
    };
    await tightenFile(credentialsPath(env));
    await tightenFile(legacyMemoryFilePath(env));
    await tightenFile(`${legacyMemoryFilePath(env)}.index`);
    await tightenFile(gatewayTokenPath(env));
    await tightenFile(gatewayInfoPath(env));
    await tightenFile(path.join(logsDirPath(env), 'stratusd.jsonl'));
    try {
      const logs = await stat(logsDirPath(env));
      if (logs.isDirectory() && (logs.mode & 0o077) !== 0) {
        await chmod(logsDirPath(env), 0o700);
        tightened.push('logs/');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    return tightened.length > 0 ? `tightened ${tightened.join(', ')}` : undefined;
  },
};

/** Ordered. Append only — an id that has shipped is never reordered or reused. */
/**
 * Schema 2 changes nothing on disk and exists to be refused: memory
 * entries, sessions, schedules, and the filesystem provenance ledger now
 * carry trust labels, and a build that predates them would read an
 * `external` fact as the agent's own conclusion and keep writing unlabelled
 * state beside the labelled kind. Stamping the version is what makes a
 * downgraded daemon stop at the door instead.
 */
const PROVENANCE_LABELS_MIGRATION: StateMigration = {
  id: '0002-provenance-labels',
  description: 'stamp the state as carrying provenance labels, so an older build refuses it rather than ignoring them',
  async apply() {
    return undefined;
  },
};

/**
 * Step 15's layer A: the sessions shard into `agents/<id>/sessions.db`, the
 * schedule rows that shared their database move to `fleet.db`, and each
 * agent's grant file moves into its own directory.
 *
 * Exclusive wherever any of that is still in its old place, because a
 * daemon of the older build is writing it: moving a session database out
 * from under one loses every turn saved after the split, and moving a grant
 * file leaves a later revocation on the old path while the moved file still
 * grants. An agent's memories are the one resource that needs no bracket
 * and so are not here at all — `drainSharedMemory` converges on them
 * instead, and says why.
 */
const PER_AGENT_LAYOUT_MIGRATION: StateMigration = {
  id: '0003-per-agent-state-layout',
  description: "shard the session database into agents/<id>/sessions.db, move the grants beside it, and the schedules into fleet.db",
  requiresExclusive: hasBracketedLegacyState,
  apply: applyPerAgentLayout,
};

export const STATE_MIGRATIONS: readonly StateMigration[] = [
  OWNER_ONLY_STATE_FILES_MIGRATION,
  PROVENANCE_LABELS_MIGRATION,
  PER_AGENT_LAYOUT_MIGRATION,
];

const unversionedStamp = (): StateStamp => ({ schemaVersion: 0, applied: [] });

/**
 * Missing, or something other than a file where the stamp belongs (a
 * directory, a path through one): unversioned, like a corrupt stamp. The
 * write that follows fails on the same obstacle, and that failure is what
 * refuses a state-writing command — see the CLI.
 */
const isAbsentStamp = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR';
};

const parseStateStamp = (raw: string): StateStamp => {
  try {
    const parsed = JSON.parse(raw) as Partial<StateStamp> | null;
    if (typeof parsed === 'object' && parsed !== null && typeof parsed.schemaVersion === 'number') {
      return {
        schemaVersion: parsed.schemaVersion,
        applied: Array.isArray(parsed.applied) ? parsed.applied.filter((id): id is string => typeof id === 'string') : [],
      };
    }
  } catch {
    // Fall through: an unreadable stamp is treated as unversioned.
  }
  // A corrupt stamp reads as schema 0 rather than an error: every
  // migration is idempotent, so re-running them costs nothing, while
  // refusing to run would brick every command over a file this build can
  // simply rewrite.
  return unversionedStamp();
};

/**
 * The stamp as it stands. A missing file — every install that predates
 * versioning, and every fresh one — reads as schema 0 with nothing applied:
 * all migrations pending, each of which must therefore be a no-op on a home
 * directory it has nothing to do in.
 */
export const readStateStamp = async (env: StateEnvironment): Promise<StateStamp> => {
  let raw: string;
  try {
    raw = await readFile(stateFilePath(env), 'utf8');
  } catch (error) {
    if (isAbsentStamp(error)) {
      return unversionedStamp();
    }
    throw error;
  }
  return parseStateStamp(raw);
};

/**
 * The same stamp, read without yielding to the event loop. The gateway
 * checks it inside its start-up, between the control API announcing its
 * address and the daemon marking itself serving, and any I/O in that
 * stretch is a window in which a restart asked for the moment the address
 * appears is refused as "still starting" — CI's restart tests hit it twice.
 * One small file, read synchronously the way the SQLite stores already
 * read, keeps that stretch to microtasks.
 */
const readStateStampSync = (env: StateEnvironment): StateStamp => {
  let raw: string;
  try {
    raw = readFileSync(stateFilePath(env), 'utf8');
  } catch (error) {
    if (isAbsentStamp(error)) {
      return unversionedStamp();
    }
    throw error;
  }
  return parseStateStamp(raw);
};

/**
 * The stamp to write, given what is on disk now and what this run means to
 * record.
 *
 * Merged rather than replaced, because two processes reach here with
 * snapshots taken at different moments and only one of them holds anything.
 * An ordinary command and an exclusive `serve` or `update` both read the
 * stamp at start; the ordinary one runs no claim and defers 0003, so a
 * write of *its* snapshot after the exclusive process recorded 0003 would
 * take the home back to a schema that omits it — and the downgrade guard
 * would then wave an older build into an already-sharded home, where it
 * recreates exactly the legacy state the move just retired.
 *
 * Both writers only ever *add* ids, so a union converges whichever order
 * they land in. The version is derived from that union and floored at
 * whatever is already recorded, so it can only move forward: a stamp is a
 * claim about what has happened to this home, and nothing that has happened
 * un-happens.
 */
export const mergeStateStamp = (latest: StateStamp, next: StateStamp): StateStamp => {
  const applied = [...latest.applied];
  for (const id of next.applied) {
    if (!applied.includes(id)) {
      applied.push(id);
    }
  }
  const complete = STATE_MIGRATIONS.every((migration) => applied.includes(migration.id));
  return {
    schemaVersion: Math.max(latest.schemaVersion, complete ? STATE_SCHEMA_VERSION : next.schemaVersion),
    applied,
  };
};

const writeStateStamp = async (env: StateEnvironment, stamp: StateStamp): Promise<void> => {
  await mkdir(stratusHomePath(env), { recursive: true });
  // Against the stamp as it is *now*, not as this run found it — see
  // `mergeStateStamp`. An unreadable one is what this write repairs, so it
  // merges with nothing rather than refusing.
  let merged = stamp;
  try {
    merged = mergeStateStamp(await readStateStamp(env), stamp);
  } catch {
    merged = stamp;
  }
  // Atomically, via rename: `writeFile` truncates before it writes, so a
  // crash in between would leave partial JSON — which reads as schema 0,
  // exactly the state that lets an older binary past the newer-schema
  // refusal. A rename either lands the whole stamp or leaves the old one.
  const target = stateFilePath(env);
  const temp = `${target}.tmp-${randomUUID()}`;
  await writeFile(temp, `${JSON.stringify(merged, null, 2)}\n`);
  await rename(temp, target);
};

/** The refusal line, phrased for the person who just downgraded without meaning to. */
export const newerStateMessage = (found: number): string =>
  `~/.stratus was written by a newer Stratus build (state schema ${found}; this build understands ${STATE_SCHEMA_VERSION}).\n`
  + 'Running an older build against it risks corrupting state the newer format relies on.\n'
  + 'Upgrade this install (`npm install -g @stratusagent/cli`), or point STRATUS home at a different directory.';

/**
 * Throws when the stamp was written by a newer schema than this build knows.
 * Synchronous on purpose — see `readStateStampSync`.
 */
export const assertStateCompatible = (env: StateEnvironment): void => {
  const stamp = readStateStampSync(env);
  if (stamp.schemaVersion > STATE_SCHEMA_VERSION) {
    throw new Error(newerStateMessage(stamp.schemaVersion));
  }
};

/**
 * Who is asking to migrate, which decides whether the exclusive ones run.
 *
 * `exclusive: true` is a claim about the caller, not a preference: it says
 * no other process is serving this home. `stratus serve` holds the home
 * claim; `stratus update` has stopped the service. Every other path —
 * every ordinary command, on any install — leaves it false and the marked
 * migrations pending.
 */
export interface StateMigrationRunOptions {
  exclusive?: boolean;
}

const runnableNow = async (migration: StateMigration, env: StateEnvironment, options: StateMigrationRunOptions): Promise<boolean> =>
  options.exclusive === true || migration.requiresExclusive === undefined || !(await migration.requiresExclusive(env));

/** Migrations not yet recorded as applied, in the order they would run. */
export const pendingStateMigrations = async (env: StateEnvironment): Promise<StateMigration[]> => {
  const stamp = await readStateStamp(env);
  const applied = new Set(stamp.applied);
  return STATE_MIGRATIONS.filter((migration) => !applied.has(migration.id));
};

export interface AppliedStateMigration {
  id: string;
  description: string;
  /** What actually changed; absent when the migration had nothing to do. */
  detail?: string;
}

/**
 * Run every pending migration in order and stamp the result. Refuses a
 * stamp from a newer schema outright — migrating state this build does not
 * understand is the corruption path versioning exists to close.
 *
 * **One stamp write per run, at the end, and only for a run that applied
 * everything.** Both halves of that are load-bearing, and both are about
 * the same thing: two processes reach this with snapshots taken at
 * different moments, and the stamp is what arms the downgrade guard, so a
 * write that records *less* than has actually happened hands an older build
 * a home it will recreate legacy state in.
 *
 * A *partial* write is the vehicle. Rewriting after each migration — which
 * this used to do, to make a crash re-run only the migration that never
 * recorded itself — means a run is briefly claiming a truthful but
 * incomplete set, and a concurrent run that has already recorded the
 * complete one is the loser. Writing once, at the end, with everything,
 * means every writer writes the same bytes: whichever order they land in,
 * the home ends up with the same stamp, and the interleaving stops
 * mattering rather than being narrowed.
 *
 * A run that has to *defer* an exclusive migration writes nothing at all,
 * for the same reason turned around: it can only ever have a subset, so
 * there is no moment at which its write is the truth. The home stays
 * reading as un-migrated until a run that holds the claim finishes the job,
 * which is exactly what it is — and an older build reading it then is
 * reading it correctly.
 *
 * What this gives up is the incremental record: a crash mid-sequence
 * re-runs every migration rather than resuming after the last one that
 * stamped. That is affordable because migrations are required to be
 * idempotent and are written that way — 0001 re-stats a handful of files
 * and changes nothing once they are owner-only, 0002 does nothing at all,
 * and 0003 finds its sources already renamed and returns.
 */
export const runStateMigrations = async (
  env: StateEnvironment,
  options: StateMigrationRunOptions = {},
): Promise<AppliedStateMigration[]> => {
  const stamp = await readStateStamp(env);
  if (stamp.schemaVersion > STATE_SCHEMA_VERSION) {
    throw new Error(newerStateMessage(stamp.schemaVersion));
  }
  const results: AppliedStateMigration[] = [];
  const applied = new Set(stamp.applied);
  // Asked once, before anything runs, rather than per migration inside the
  // loop: `requiresExclusive` is a filesystem question, and 0003 is the
  // migration that changes its own answer — asking after it has run would
  // report a home as un-deferred because the deferral already happened.
  const runnable = new Map<string, boolean>();
  for (const migration of STATE_MIGRATIONS) {
    runnable.set(migration.id, applied.has(migration.id) || await runnableNow(migration, env, options));
  }
  const deferring = STATE_MIGRATIONS.some((migration) => runnable.get(migration.id) !== true);

  for (const migration of STATE_MIGRATIONS) {
    if (applied.has(migration.id) || runnable.get(migration.id) !== true) {
      continue;
    }
    const detail = await migration.apply(env);
    stamp.applied.push(migration.id);
    applied.add(migration.id);
    results.push({ id: migration.id, description: migration.description, ...(detail !== undefined ? { detail } : {}) });
  }
  if (!deferring && (results.length > 0 || stamp.schemaVersion !== STATE_SCHEMA_VERSION)) {
    await writeStateStamp(env, { schemaVersion: STATE_SCHEMA_VERSION, applied: stamp.applied });
  }
  return results;
};
