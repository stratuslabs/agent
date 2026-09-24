import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { appendFile, chmod, mkdir, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { isValidAgentId } from '@stratusagent/agents';
import {
  LEGACY_WHITELIST_SUFFIX,
  assertDerivedStatePath,
  linkedDerivedComponent,
  whitelistPathFor,
} from '@stratusagent/permissions';
import { type StateEnvironment } from './environment.ts';
import { memoryAppendNeedsNewline } from './memory.ts';
import { DEFAULT_STRATUS_AGENT } from './souls.ts';
import {
  agentMemoryFilePath,
  agentSessionDbPath,
  agentStateDirPath,
  agentsDirIn,
  agentsDirPath,
  fleetDbPath,
  foldedAgentId,
  legacySessionDbIn,
  stratusHomePath,
  legacyMemoryFilePath,
  legacySessionDbPath,
} from './paths.ts';

// Everything one agent owns moves under `agents/<id>/`: its sessions, its
// memories, its grants. What stays fleet-level is the schedules, which move
// the other way — out of the shared session database and into `fleet.db`,
// because a schedule is infrastructure (the scheduler ticks once for
// everyone, `stratus schedules` is the fleet's audit list, and a bare-id
// cancel revokes the destination grant riding on the row) and a schedule
// living in whichever per-agent file happened to be open would neither
// fire, nor appear, nor be cancellable.
//
// Four properties this migration is written for, in the order they bite:
//
// - **Nothing is deleted.** The shared database and the shared memory file
//   are left in place under `.migrated` names. Repointing a store
//   constructor at a path the migration did not populate is how histories
//   and persistent approvals vanish silently, and an original on disk is
//   what makes that recoverable rather than terminal.
// - **It is staged and restartable.** Each resource is its own stage with
//   its own completion marker — the renamed source, the moved file — so a
//   kill at any boundary resumes rather than redoing, and a second start
//   finds nothing to do. No stage mistakes a renamed source for a missing
//   one.
// - **Nothing races a daemon of the older build.** That daemon is still
//   reading and writing this state, and each resource answers it
//   differently. The session database and the grant files *move* under an
//   exclusive bracket, because their writers cannot be reconciled after the
//   fact: a SQLite file is held open, and a grant file is a whole-state
//   document where a revocation written to the old path after the move
//   would leave the new one still granting. The memory file is *copied*
//   early and retired late: copying needs no bracket, because the JSONL is
//   an append-only log whose readers dedupe by entry id, and running the
//   copy on every command is what converges on a writer that has not
//   stopped — while taking the file away does need one, because that
//   daemon reads the pathname on every listing and would answer, mid
//   conversation, as though every agent had forgotten everything.
// - **It walks the data, not the roster.** The gateway deliberately keeps a
//   missing soul's sessions when it drops the soul, so owners come from the
//   stored `agent_id` values as well as from the souls on disk: an agent
//   restored later finds its history where the layout says it lives.
// - **It holds ids to path safety, not to the slug shape.** `isValidAgentId`
//   accepts the legacy `Ava_1`, `team.alpha`, and `AVA` that key real data
//   today, and holding them to `AGENT_ID_PATTERN` on upgrade would strand
//   their agents. An id that is genuinely unsafe to join is quarantined
//   loudly — named in the migration's report, its rows left in the
//   preserved original — never silently dropped.

/** Loaded here, never at module load: see the note in `memory.ts`. */
type SqliteModule = typeof import('node:sqlite');
let sqliteModule: Promise<SqliteModule> | undefined;
const loadSqlite = (): Promise<SqliteModule> => {
  sqliteModule ??= import('node:sqlite');
  return sqliteModule;
};

type SqliteDatabase = InstanceType<SqliteModule['DatabaseSync']>;

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};

/**
 * The `CREATE TABLE` the source database itself carries.
 *
 * Read from `sqlite_master` rather than written out here on purpose: the
 * per-agent stores and the fleet database must end up with exactly the
 * schema the store code creates, and a DDL string spelled a second time in
 * a migration is a copy that drifts the first time a column is added. The
 * database being migrated is the authority for its own shape.
 */
const tableSchemaOf = (db: SqliteDatabase, table: string): string | undefined => {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
    | { sql: string | null }
    | undefined;
  return row?.sql ?? undefined;
};

const hasTable = (db: SqliteDatabase, table: string): boolean => tableSchemaOf(db, table) !== undefined;

/**
 * The source table's own column names, quoted for a copy.
 *
 * `INSERT … SELECT *` would do, right up until the destination table has a
 * column the source does not — the next time this schema grows one, with a
 * store that creates the new shape and a database written by the build
 * before it. Naming the columns the *source* has copies exactly what is
 * there and leaves the rest to their defaults.
 */
const columnsOf = (db: SqliteDatabase, schema: string, table: string): string[] => {
  const rows = db.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as Array<{ name: string }>;
  return rows.map((row) => `"${row.name.replaceAll('"', '""')}"`);
};

/**
 * Owner-only, like the credentials file, and the sidecars with it: SQLite
 * derives their permissions from the main file's mode, and a chmod that
 * covered only the database would leave a WAL full of conversation bodies
 * readable by other local users.
 */
const tighten = async (filePath: string): Promise<void> => {
  for (const sensitive of [filePath, `${filePath}-wal`, `${filePath}-shm`, `${filePath}-journal`]) {
    try {
      await chmod(sensitive, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
};

/**
 * The errors that mean *this name* cannot be a directory, as opposed to
 * something being wrong with the whole operation.
 *
 * The split is the point. A name the filesystem refuses is one agent's
 * problem and is quarantined; a full disk or an unwritable `agents/`
 * directory is every agent's, and swallowing it would stamp the migration
 * as applied with the whole fleet quarantined. `EEXIST`/`ENOTDIR` is the
 * soul-filename collision; `EINVAL`, `EPERM` and `ENAMETOOLONG` are
 * Windows, where `CON`, `PRN` and a trailing dot are valid agent ids by
 * `isValidAgentId` — it answers path *safety*, which is not the same
 * question as whether every platform will take the name.
 */
const UNUSABLE_DIRECTORY_NAME = new Set(['EEXIST', 'ENOTDIR', 'EINVAL', 'EPERM', 'ENAMETOOLONG']);

/**
 * Make an agent's state directory, or say why it cannot exist.
 *
 * `isValidAgentId` answers whether an id is a safe path *segment*, which is
 * not the same question as whether that segment is free: an id is only held
 * to path safety on upgrade, deliberately, so `id: ava.md` is a legacy id
 * this build must keep — and `agents/ava.md` is where its own soul file
 * already sits. `mkdir` throws `EEXIST` on that, and an exception here
 * would abort the whole migration, leaving the shared database unarchived
 * and `stratus serve` unable to start over it. So a collision is
 * quarantined like an unsafe id: named, with its rows left in the preserved
 * original, and the rest of the fleet migrated around it.
 *
 * `ECASE` is this module's own code, not the filesystem's: it means the
 * directory exists but under a different spelling of this id — see the
 * `realpath` check below.
 */
export const makeAgentStateDirectory = async (
  env: StateEnvironment,
  agentId: string,
  onUnusable?: (code: string) => void,
): Promise<string | undefined> => {
  const directory = agentStateDirPath(env, agentId);
  // Never through a symlink, at any component below the home — see
  // `linkedDerivedComponent`, which owns that rule. Quarantined rather than
  // thrown here: this runs inside a migration that has a report to name the
  // agent in, and the rest of the fleet should still move.
  if (await linkedDerivedComponent(stratusHomePath(env), directory) !== undefined) {
    onUnusable?.('ELOOP');
    return undefined;
  }
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // `mkdir`'s mode applies only to what it creates, so an `agents/<id>/`
    // an older build or an operator already left is whatever it was — and
    // an agent whose migration moves only memories or grants passes through
    // no other chmod, so it would stay loose indefinitely with this agent's
    // state inside it.
    await chmod(directory, 0o700);
    // Last, and the only check here that does not depend on this process
    // having seen the other one. `StateDirectoryNames` holds names within
    // a run, and the exclusive migration is not the only process making
    // these directories: the memory drain runs on every ordinary command
    // *without* the home lock, deliberately, because the append-only copy
    // is designed to need no bracket. So two processes can both find a
    // name free and both `mkdir` it, and on a folding filesystem that is
    // one directory with two agents in it. Asking what the filesystem
    // actually named it settles that without a lock the memory half was
    // built not to take: `realpath` answers with the spelling on disk, so
    // a directory that was already there under another one says so.
    const stored = path.basename(await realpath(directory));
    if (stored !== agentId) {
      onUnusable?.('ECASE');
      return undefined;
    }
    return directory;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (!UNUSABLE_DIRECTORY_NAME.has(code)) {
      throw error;
    }
    onUnusable?.(code);
    return undefined;
  }
};

/**
 * Which id owns which state directory *name*, for one run.
 *
 * `foldedAgentId` owns the rule and the reason. What is left to this is
 * that the roster enforces it over *souls*, and this migration walks the
 * *data*: stored `agent_id` values and grant filenames, for agents whose
 * souls may be long gone, which no roster ever refused. Without a record
 * of which name is taken, the second of two spellings copies its sessions
 * into the first's store, appends its memories to the first's file, and
 * renames its grant file over the first's — two agents merged, silently,
 * by an upgrade.
 *
 * The loser is quarantined, not dropped: its rows stay in the preserved
 * original, which is what a rename makes recoverable.
 *
 * Seeded with the built-in agent's id, because `agents/stratus/` is spoken
 * for before any run starts and no roster refusal reaches this far: a
 * legacy `Stratus` in a stored row or a `Stratus.whitelist.json` is a valid
 * id this build must keep, and giving it that directory would hand the
 * built-in agent — the one every unconfigured run gets — another agent's
 * standing grants. Seeding in the factory rather than at the call sites so
 * that a third caller cannot forget; the real `stratus` still migrates,
 * since a name held by the same id it is asked for is not a collision.
 */
export interface StateDirectoryNames {
  /**
   * The id already holding the directory `agentId` would join to, when that
   * is a different spelling of it; undefined when the name is free or
   * already this agent's.
   */
  heldBy(agentId: string): Promise<string | undefined>;
  /** Record `agentId` as the owner of the name it joins to. */
  hold(agentId: string): void;
}

export const createStateDirectoryNames = (env: StateEnvironment): StateDirectoryNames => {
  const byName = new Map<string, string>([
    [foldedAgentId(DEFAULT_STRATUS_AGENT.id), DEFAULT_STRATUS_AGENT.id],
  ]);
  // Once per tracker, on first use rather than at construction, because the
  // factory is called from synchronous places and most runs never ask.
  let seeded: Promise<void> | undefined;
  /**
   * The directories that are already there, before this run names anything.
   *
   * Without this the tracker only knew what *it* had created, and the
   * dangerous case is the one that spans runs: the memory drain runs on
   * every ordinary command, so `agents/Ava/` can exist long before the
   * exclusive migration reaches `ava`'s legacy sessions and grant file.
   * A fresh tracker would find the name free, `mkdir` would be satisfied by
   * the directory that is already there, and `ava`'s `whitelist.json` would
   * land in what `Ava` resolves — one agent handed the other's unattended
   * grants by an upgrade.
   *
   * Directories only, by `Dirent`: `agents/` also holds the souls and, until
   * the move, the legacy `<id>.whitelist.json` files, and a `Dirent` reports
   * a symlink as a link rather than a directory — which is right, because a
   * linked `agents/<id>` is not a state directory and `makeAgentStateDirectory`
   * refuses it anyway.
   */
  const seed = async (): Promise<void> => {
    let found: Dirent[];
    try {
      found = await readdir(agentsDirPath(env), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
    for (const entry of found) {
      if (entry.isDirectory()) {
        // Never over a name already held — the built-in's, or one this run
        // has claimed: those answers are the ones to keep.
        const folded = foldedAgentId(entry.name);
        if (!byName.has(folded)) {
          byName.set(folded, entry.name);
        }
      }
    }
  };
  return {
    heldBy: async (agentId) => {
      seeded ??= seed();
      await seeded;
      const claimed = byName.get(foldedAgentId(agentId));
      return claimed === undefined || claimed === agentId ? undefined : claimed;
    },
    hold: (agentId) => {
      byName.set(foldedAgentId(agentId), agentId);
    },
  };
};

/**
 * The destination file, or undefined when it is a link.
 *
 * The migration writes its own way into these — `shardSessions` through its
 * local `openDatabase`, `placeRecords` by appending — so neither passes the
 * guard the live stores apply. A real `agents/<id>/` says nothing about the
 * files in it: a linked `sessions.db` is copied into whatever it points at
 * and then rejected by the startup sweep, leaving those conversations
 * unreachable, and a linked `memory.jsonl` takes an agent's whole history
 * outside the home.
 */
const usableStateFile = async (
  home: string,
  filePath: string,
  agentId: string,
  what: string,
  report: LayoutMigrationReport,
): Promise<string | undefined> => {
  const linked = await linkedDerivedComponent(home, filePath);
  if (linked === undefined) {
    return filePath;
  }
  report.quarantined.push(
    `${JSON.stringify(agentId)} (${what}) — ${path.relative(home, linked)} is a symlink, `
    + 'which is never a path this agent\'s state is written through',
  );
  return undefined;
};

/**
 * The two fields {@link agentDirectoryOrQuarantine} needs of a migration's
 * report. Named separately because 0004 has a report of its own and gets
 * this rule from here rather than writing a second copy of it.
 */
export interface DirectoryReport {
  /** Agent ids that could not be given a directory, and what held them back. */
  quarantined: string[];
  /** Which id owns which directory name in this run. */
  directoryNames: StateDirectoryNames;
}

/**
 * {@link makeAgentStateDirectory}, naming what it could not make in
 * `report` and holding the directory name against the rest of the run
 * (see {@link StateDirectoryNames}).
 *
 * The name is held only once the directory exists, so an id quarantined
 * for some other reason does not take the name away from a second
 * spelling that would have been fine.
 */
export const agentDirectoryOrQuarantine = async (
  env: StateEnvironment,
  agentId: string,
  what: string,
  report: DirectoryReport,
): Promise<string | undefined> => {
  const holder = await report.directoryNames.heldBy(agentId);
  if (holder !== undefined) {
    report.quarantined.push(
      `${JSON.stringify(agentId)} (${what}) — differs from ${JSON.stringify(holder)} only in case, and one `
      + 'directory cannot be both agents on macOS or Windows; rename one of the two ids',
    );
    return undefined;
  }
  const directory = await makeAgentStateDirectory(env, agentId, (code) => {
    report.quarantined.push(code === 'ECASE'
      ? `${JSON.stringify(agentId)} (${what}) — `
        + `${path.relative(stratusHomePath(env), agentStateDirPath(env, agentId))} is already another spelling of `
        + 'this id on this filesystem, so the two agents would share one directory; rename one of them'
      : `${JSON.stringify(agentId)} (${what}) — `
        + `${path.relative(stratusHomePath(env), agentStateDirPath(env, agentId))} cannot be a directory `
        + `(${code}); this agent has no directory to own, so rename its id`);
  });
  if (directory !== undefined) {
    report.directoryNames.hold(agentId);
  }
  return directory;
};

const openDatabase = async (filePath: string, own = true): Promise<SqliteDatabase> => {
  const { DatabaseSync } = await loadSqlite();
  if (!own) {
    // A source that is not ours — the legacy database behind a link — is
    // opened read-only, with no journal pragma: setting WAL is a write to
    // their file, and on a relocated read-only volume it fails the upgrade
    // outright. Reading is the whole of what this migration does to it.
    const db = new DatabaseSync(filePath, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 5000');
    return db;
  }
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  await tighten(filePath);
  return db;
};

/**
 * The legacy database as an `ATTACH` target that cannot be written through:
 * a `mode=ro` URI, which SQLite honours on the attached schema even from a
 * writable connection. Every attach of it here only reads.
 */
const readOnlyAttachTarget = (filePath: string): string => `${pathToFileURL(filePath).href}?mode=ro`;

/**
 * What one run of the migration changed, for the line it reports — plus
 * the bookkeeping its stages share, which rides here because the report is
 * already the one per-run object every stage is handed.
 */
interface LayoutMigrationReport {
  agentsWithSessions: number;
  sessionsMoved: number;
  schedulesMoved: number;
  agentsWithMemories: number;
  memoriesMoved: number;
  whitelistsMoved: number;
  /** Agent ids whose rows could not be given a directory, and what held them back. */
  quarantined: string[];
  /** Which id owns which directory name in this run. */
  directoryNames: StateDirectoryNames;
}

/**
 * Move the schedule rows out of the shared session database and into
 * `fleet.db`.
 *
 * Row-wise rather than by copying the file, because `fleet.db` may already
 * be there: a `stratus schedules` on a home whose migration is still
 * pending opens (and so creates) it, and a run killed after this stage
 * leaves it half-populated. `INSERT OR REPLACE` keyed on the schedule id
 * makes both cases the same case.
 */
const moveSchedules = async (legacyDb: SqliteDatabase, env: StateEnvironment, legacyReadOnly = false): Promise<number> => {
  if (!hasTable(legacyDb, 'schedules')) {
    return 0;
  }
  const schema = tableSchemaOf(legacyDb, 'schedules');
  // The destination table first, on its own connection, so the copy below
  // needs no rewriting of the source's `CREATE TABLE` to name an attached
  // schema.
  const fleetPath = fleetDbPath(env);
  // Before the open, because opening is already a write: `openDatabase`
  // creates the file, sets WAL and chmods it, and the copy below creates
  // the schedules table and the rows. The daemon's own store refuses a
  // linked `fleet.db`, but it is constructed long after this — a migration
  // runs first on the upgrade that introduces the file, so a guard only at
  // the store is a guard the migration walks past.
  //
  // Refused rather than quarantined: this is the fleet's index and its
  // schedule rows, not one agent's state, so there is no per-agent line to
  // report it on and nothing that could carry on without it.
  await assertDerivedStatePath(stratusHomePath(env), fleetPath, 'file');
  const fleet = await openDatabase(fleetPath);
  try {
    if (!hasTable(fleet, 'schedules') && schema !== undefined) {
      fleet.exec(schema);
    }
  } finally {
    fleet.close();
    await tighten(fleetPath);
  }

  // Copied from the *legacy* connection with the fleet database attached,
  // inside an IMMEDIATE transaction, because the direction decides who
  // waits. `stratus schedules cancel` is an ordinary CLI process — the home
  // claim does not exclude it — and it deletes the row from the legacy
  // database. Were that delete to land between this read and this write,
  // the row would be copied back into `fleet.db` after the operator was
  // told it was cancelled: a schedule that fires anyway, with the standing
  // destination grant it carries still live. IMMEDIATE takes the write lock
  // on the legacy database up front, so that delete waits its brief turn
  // (every store here sets a busy timeout for exactly this) and then runs
  // against a copy that has already happened — which the cancel finishes by
  // deleting from the fleet database too.
  if (legacyReadOnly) {
    return copySchedulesIntoFleet(env, fleetPath);
  }
  legacyDb.prepare('ATTACH ? AS fleet').run(fleetPath);
  try {
    const columns = columnsOf(legacyDb, 'main', 'schedules').join(', ');
    legacyDb.exec('BEGIN IMMEDIATE');
    try {
      legacyDb.exec(`INSERT OR REPLACE INTO fleet.schedules (${columns}) SELECT ${columns} FROM main.schedules`);
      const counted = legacyDb.prepare('SELECT COUNT(*) AS total FROM main.schedules').get() as { total: number };
      legacyDb.exec('COMMIT');
      return Number(counted.total);
    } catch (error) {
      legacyDb.exec('ROLLBACK');
      throw error;
    }
  } finally {
    legacyDb.exec('DETACH fleet');
    await tighten(fleetPath);
  }
};

/**
 * The schedule copy for a legacy database opened read-only, run from the
 * *fleet* side: a read-only connection cannot take the legacy write lock
 * `moveSchedules` otherwise holds, nor write through an attach. The cancel
 * race that lock closes stays closed from here, because `cancelEverywhere`
 * deletes from the legacy database *first* and `fleet.db` second: a legacy
 * delete before this read leaves nothing to copy, and one after it is
 * followed by a fleet delete that waits on this IMMEDIATE transaction and
 * so removes the copied row once it commits.
 */
const copySchedulesIntoFleet = async (env: StateEnvironment, fleetPath: string): Promise<number> => {
  const fleet = await openDatabase(fleetPath);
  try {
    fleet.prepare('ATTACH ? AS legacy').run(readOnlyAttachTarget(legacySessionDbPath(env)));
    try {
      const columns = columnsOf(fleet, 'legacy', 'schedules').join(', ');
      fleet.exec('BEGIN IMMEDIATE');
      try {
        fleet.exec(`INSERT OR REPLACE INTO main.schedules (${columns}) SELECT ${columns} FROM legacy.schedules`);
        const counted = fleet.prepare('SELECT COUNT(*) AS total FROM legacy.schedules').get() as { total: number };
        fleet.exec('COMMIT');
        return Number(counted.total);
      } catch (error) {
        fleet.exec('ROLLBACK');
        throw error;
      }
    } finally {
      fleet.exec('DETACH legacy');
    }
  } finally {
    fleet.close();
    await tighten(fleetPath);
  }
};

/**
 * Split the shared `sessions` table into one database per agent.
 *
 * The per-agent database is created from the source's own schema and filled
 * by an attached `INSERT OR REPLACE`, so a run killed part-way through an
 * agent — or between two agents — re-inserts the same rows under the same
 * primary key rather than duplicating them.
 */
const shardSessions = async (
  legacyDb: SqliteDatabase,
  env: StateEnvironment,
  report: LayoutMigrationReport,
): Promise<void> => {
  if (!hasTable(legacyDb, 'sessions')) {
    return;
  }
  const schema = tableSchemaOf(legacyDb, 'sessions');
  if (schema === undefined) {
    return;
  }
  const owners = legacyDb
    .prepare('SELECT agent_id, COUNT(*) AS total FROM sessions GROUP BY agent_id')
    .all() as Array<{ agent_id: string; total: number }>;
  for (const owner of owners) {
    if (!isValidAgentId(owner.agent_id)) {
      report.quarantined.push(
        `${JSON.stringify(owner.agent_id)} (${owner.total} session(s)) — not a single path segment, so it has no directory to own`,
      );
      continue;
    }
    if (!(await agentDirectoryOrQuarantine(env, owner.agent_id, `${owner.total} session(s)`, report))) {
      continue;
    }
    const shardPath = await usableStateFile(
      stratusHomePath(env),
      agentSessionDbPath(env, owner.agent_id),
      owner.agent_id,
      `${owner.total} session(s)`,
      report,
    );
    if (shardPath === undefined) {
      continue;
    }
    const shard = await openDatabase(shardPath);
    try {
      if (!hasTable(shard, 'sessions')) {
        shard.exec(schema);
      }
      shard.prepare('ATTACH ? AS legacy').run(readOnlyAttachTarget(legacySessionDbPath(env)));
      try {
        const columns = columnsOf(shard, 'legacy', 'sessions').join(', ');
        shard
          .prepare(`INSERT OR REPLACE INTO sessions (${columns}) SELECT ${columns} FROM legacy.sessions WHERE agent_id = ?`)
          .run(owner.agent_id);
      } finally {
        shard.exec('DETACH legacy');
      }
    } finally {
      shard.close();
      await tighten(shardPath);
    }
    report.agentsWithSessions += 1;
    report.sessionsMoved += Number(owner.total);
  }
};

/** Whether a line is a record this migration can attribute to an agent. */
const agentIdOfLine = (line: string): string | undefined => {
  try {
    const parsed = JSON.parse(line) as { agentId?: unknown } | null;
    return typeof parsed === 'object' && parsed !== null && typeof parsed.agentId === 'string'
      ? parsed.agentId
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Copy the shared memory file into one JSONL per agent, leaving the source
 * exactly where it is.
 *
 * Copy rather than move, because the source still has a reader: a daemon of
 * the older build is serving until something restarts it, and it reads this
 * pathname on every listing. Taking it away mid-upgrade would make its
 * agents answer as though they had forgotten everything. Retiring the file
 * is `retireSharedMemory`, under the exclusive bracket, where that reader
 * is by definition gone.
 *
 * Every record type goes by its `agentId` — entries, the tombstones that
 * retire them, and the re-assertions that re-label them — because a
 * tombstone parted from its entry is a forgotten fact that comes back.
 *
 * Deduped by line rather than by id: the file is append-only and the same
 * line written twice is the same record, so running this on every command
 * converges instead of doubling an agent's history. A line nobody can
 * attribute (a hand edit, a truncated write) stays in the source, where it
 * is recoverable, rather than being guessed into somebody's store.
 */
const copySharedMemory = async (
  env: StateEnvironment,
  report: LayoutMigrationReport,
  source: string = legacyMemoryFilePath(env),
): Promise<void> => {
  let raw: string;
  try {
    raw = await readFile(source, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  await placeRecords(env, report, raw, source);
};

/** Split `raw` by agent and append each agent's lines to its own file. */
const placeRecords = async (
  env: StateEnvironment,
  report: LayoutMigrationReport,
  raw: string,
  source: string,
): Promise<void> => {

  const byAgent = new Map<string, string[]>();
  const unsafe = new Map<string, number>();
  let unattributed = 0;
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    const agentId = agentIdOfLine(line);
    if (agentId === undefined) {
      unattributed += 1;
      continue;
    }
    if (!isValidAgentId(agentId)) {
      unsafe.set(agentId, (unsafe.get(agentId) ?? 0) + 1);
      continue;
    }
    const lines = byAgent.get(agentId) ?? [];
    lines.push(line);
    byAgent.set(agentId, lines);
  }
  for (const [agentId, count] of unsafe) {
    report.quarantined.push(
      `${JSON.stringify(agentId)} (${count} memory record(s)) — not a single path segment, so it has no directory to own`,
    );
  }
  for (const [agentId, lines] of byAgent) {
    // The directory first, before anything reads a path *under* it. An id
    // whose directory name is already a file makes the destination read
    // fail with ENOTDIR, and this copy runs before every CLI command — so
    // rethrowing that would refuse `serve` and every other state-writing
    // command indefinitely, over one agent's unusable name.
    if (!(await agentDirectoryOrQuarantine(env, agentId, `${lines.length} memory record(s)`, report))) {
      continue;
    }
    const destination = await usableStateFile(
      stratusHomePath(env),
      agentMemoryFilePath(env, agentId),
      agentId,
      `${lines.length} memory record(s)`,
      report,
    );
    if (destination === undefined) {
      continue;
    }
    let existing = new Set<string>();
    try {
      existing = new Set((await readFile(destination, 'utf8')).split('\n'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    const fresh = lines.filter((line) => !existing.has(line));
    if (fresh.length === 0) {
      continue;
    }
    // Appended, never rewritten: the JSONL is append-only because that is
    // its whole concurrency model, and a migration that rewrote the file
    // would be the one writer that could lose a line somebody else added.
    // Two copiers racing can each append the same line — which is what the
    // store's read-time dedupe by entry id is already for, and why this
    // needs no claim of its own.
    // A destination whose last byte is not a newline fuses the first
    // record onto it — see `memoryAppendNeedsNewline`, which owns the rule.
    const prefix = (await memoryAppendNeedsNewline(destination)) ? '\n' : '';
    await appendFile(destination, `${prefix}${fresh.join('\n')}\n`, { mode: 0o600 });
    await chmod(destination, 0o600);
    report.agentsWithMemories += 1;
    report.memoriesMoved += fresh.length;
  }
  if (unattributed > 0) {
    report.quarantined.push(
      `${unattributed} memory line(s) with no agent id — left in ${path.basename(source)}`,
    );
  }
};

/**
 * Retire the shared file, once nothing can be reading it any more.
 *
 * The one destructive step, and it belongs to the exclusive half for a
 * reason the copy above does not share: a daemon of the older build reads
 * `memory.jsonl` by pathname on every listing and takes `ENOENT` as an
 * empty store, so taking the file away while it serves makes every one of
 * its agents answer, mid-conversation, as though it had forgotten
 * everything. That is the same failure the copy runs early to avoid,
 * pointed at the old process instead of the new one.
 *
 * The derived FTS index goes with it: an index of a record that is no
 * longer there would only be rebuilt from nothing.
 */
const RETIRING_SUFFIX = '.retiring-';

/**
 * Take the shared file out of use, atomically, and place everything that was
 * in it.
 *
 * Through a uniquely named claim, which is the only way to get both of the
 * things this needs. The destructive step has to be **atomic**, because a
 * read-then-remove loses anything appended between the two — a writer that
 * does not honour the home claim is exactly what this window is about, and
 * "the record was never in the bytes we archived, and then we unlinked it"
 * is a fact the operator was told had been remembered. And it must **not
 * rename over the archive**, because the shared file comes back: the store
 * opens it by pathname on every append, so an older build recreates it, and
 * a second retirement would take the first one's archive with it.
 *
 * A rename to a claim gives both. After it, a late append either landed in
 * the claimed inode — where the copy below places it — or recreates the
 * source pathname, where the next command's drain takes it. Neither is lost,
 * and the archive is only ever appended to.
 *
 * The same protocol `migrateLegacyMemory` uses for the cwd-local file, and
 * for the same reason; a crash leaves a claim behind, which `drainRetiring`
 * finishes.
 */
const retireSharedMemory = async (env: StateEnvironment, report: LayoutMigrationReport): Promise<void> => {
  const source = legacyMemoryFilePath(env);
  const claim = `${source}${RETIRING_SUFFIX}${randomUUID()}`;
  try {
    await rename(source, claim);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    // Nothing there, or another process claimed it first — either way this
    // pass has nothing of its own to retire. Leftovers are finished below.
    await drainRetiring(env, report);
    return;
  }
  await placeClaim(env, claim, report);
  await drainRetiring(env, report);

  // The derived index goes last and may clobber: an index of records that
  // are no longer at that pathname is not worth keeping two of.
  if (await exists(`${source}.index`)) {
    await rename(`${source}.index`, `${source}.index.migrated`);
  }
};

/** Copy a claimed file into the agents' stores, fold it into the archive, and drop it. */
const placeClaim = async (env: StateEnvironment, claim: string, report: LayoutMigrationReport): Promise<void> => {
  // Read once, and place *those* bytes. Copying and then re-reading to
  // archive left a gap between the two: a handle opened before the rename
  // can still be writing into this inode, and anything landing in that gap
  // was archived without ever reaching an agent's store — recorded in a
  // file nothing reads back, which is indistinguishable from lost.
  let bytes: Buffer;
  try {
    bytes = await readFile(claim);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  // Held as bytes, not as the decoded string, because the comparison below
  // is against the file's size: decoding a torn append — a writer
  // interrupted mid multi-byte sequence, which is the very thing this
  // window is about — replaces the broken bytes with U+FFFD and makes the
  // decoded length longer than the file. Compared that way a claim would
  // never match its own size, never be unlinked, and be re-placed by every
  // command from then on.
  const raw = bytes.toString('utf8');
  await placeRecords(env, report, raw, claim);
  const archive = `${legacyMemoryFilePath(env)}.migrated`;
  if (raw.trim().length > 0) {
    // Appended, never renamed over — see `retireSharedMemory`. A crash
    // between this and the unlink leaves the claim behind, and `drainRetiring`
    // appends it a second time; the readers dedupe by entry id, and the
    // archive is a recovery artifact rather than anything that is read back.
    await appendFile(archive, raw.endsWith('\n') ? raw : `${raw}\n`, { mode: 0o600 });
    await chmod(archive, 0o600);
  }
  // Unlinked only when the file is still the size that was read.
  //
  // Truncating was worse and I should not have reached for it: `truncate(0)`
  // discards the *whole* inode, so a tail a stale handle appended after the
  // read — bytes nothing has placed — goes with it. Unlinking after a size
  // check loses only what arrives between the check and the unlink, which is
  // two adjacent syscalls.
  //
  // That window cannot be closed. There is no "remove only if unchanged",
  // and the only alternative is never reclaiming the file at all — which
  // means every upgraded home re-reads and re-places the whole claim on
  // every command, for ever, to cover a writer that in almost every case
  // never existed. This is the smallest destruction available, and a claim
  // that did grow is left for the next command's `drainRetiring` rather than
  // removed.
  let left;
  try {
    left = await stat(claim);
  } catch (error) {
    // Gone: another process finished this claim while we were placing it.
    // Both of us read the same bytes and both placed them, so the work is
    // done — and throwing here would abort a daemon start, or refuse an
    // unrelated command, over a peer having been helpful.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  if (left.size !== bytes.length) {
    return;
  }
  await rm(claim, { force: true });
};

/** Finish any claim a killed run left behind, including one from an older build. */
const drainRetiring = async (env: StateEnvironment, report: LayoutMigrationReport): Promise<void> => {
  const source = legacyMemoryFilePath(env);
  const directory = path.dirname(source);
  const prefix = `${path.basename(source)}${RETIRING_SUFFIX}`;
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.startsWith(prefix)) {
      await placeClaim(env, path.join(directory, entry.name), report);
    }
  }
};

/**
 * Move each `agents/<id>.whitelist.json` into `agents/<id>/whitelist.json`.
 *
 * A rename, which is atomic and therefore its own marker: the file is in
 * one place or the other, never both, and a second run finds nothing left
 * in the parent directory to move. Both paths come from
 * `@stratusagent/permissions`, which owns them — the daemon reading one
 * path while the migration wrote another is how a grant list goes quiet.
 *
 * Under the exclusive bracket, with the rest of this migration, and that is
 * the whole reason the bracket covers grants: a grant file is a
 * whole-state document, not a log. A daemon of the older build holds its
 * grants cached for the life of the process and writes the file back whole,
 * so a revocation made through it after the move would land on the old
 * path while the moved file still granted — a grant returning from the
 * dead, which is the ratchet the standing-grant work exists to prevent.
 * Nothing can merge those two afterwards, because "absent from the old
 * file" and "granted since the move" are the same shape.
 */
const moveWhitelists = async (env: StateEnvironment, report: LayoutMigrationReport): Promise<void> => {
  const directory = agentsDirPath(env);
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  /**
   * Take a grant file this migration cannot move out of the old *name*.
   *
   * Archived rather than left where it is, which is the difference between
   * one agent losing its grants and the whole home becoming unservable:
   * `hasBracketedLegacyState` reads any `<id>.whitelist.json` as a home the
   * move has not reached, and this migration records itself as applied
   * whether or not every file could be moved. A quarantined file left in
   * place therefore refuses every later `start()`, points the operator at a
   * `stratus update` that will not re-run a stamped migration, and does it
   * over a file no later run was ever going to pick up.
   *
   * Under `.migrated`, like every other original this migration preserves:
   * the grants are recoverable by hand, and the agent meanwhile has none,
   * which is the direction to fail in.
   */
  const archive = async (entry: string): Promise<string> => {
    const from = path.join(directory, entry);
    // Never over an archive that is already there, for the reason the
    // session database gives: a run killed before the stamp leaves one, an
    // older build recreates `<id>.whitelist.json` at the old name, and the
    // retry would rename that over the grants the first pass preserved.
    const to = await exists(`${from}.migrated`)
      ? `${from}.migrated-${randomUUID()}`
      : `${from}.migrated`;
    await rename(from, to);
    return path.basename(to);
  };

  for (const found of entries) {
    // Files only, for the reason `hasBracketedLegacyStateIn` gives: the
    // state directory of an agent whose id ends in `.whitelist.json` has
    // this suffix, and renaming *that* would move one agent's whole
    // directory inside another's.
    if (!found.isFile() || !found.name.endsWith(LEGACY_WHITELIST_SUFFIX)) {
      continue;
    }
    const entry = found.name;
    const agentId = entry.slice(0, -LEGACY_WHITELIST_SUFFIX.length);
    // A bare `.whitelist.json` names no agent at all. Skipping it left the
    // home unservable for good: `hasBracketedLegacyStateIn` counts every
    // regular file with this suffix, so the bracket predicate said "not
    // migrated" while 0003 recorded itself as done — every later start
    // refused the home, and `stratus update` had no pending migration to
    // retry. Archived like any other id with nowhere to land, which is
    // what clears the predicate.
    if (agentId.length === 0) {
      report.quarantined.push(
        `${JSON.stringify(entry)} — a grant file naming no agent; kept as ${await archive(entry)}`,
      );
      continue;
    }
    if (!isValidAgentId(agentId)) {
      report.quarantined.push(
        `${JSON.stringify(agentId)} (grants) — not a single path segment, so it has no directory to own; `
        + `kept as ${await archive(entry)}`,
      );
      continue;
    }
    // The directory before anything under it, for the reason the memory
    // copy gives: `exists` on a path beneath a regular file throws ENOTDIR,
    // and from here that would abort the whole migration and leave the
    // daemon unable to start.
    if (!(await agentDirectoryOrQuarantine(env, agentId, 'grants', report))) {
      report.quarantined.push(`${entry} — kept as ${await archive(entry)}`);
      continue;
    }
    const target = whitelistPathFor(directory, agentId);
    if (await exists(target)) {
      // Both spellings present: the agent's own directory is the one the
      // daemon reads, so the older file does not overwrite grants somebody
      // has since changed. Named, not silently skipped.
      report.quarantined.push(
        `${entry} — ${path.relative(directory, target)} already exists, so the old file was not moved over it; `
        + `kept as ${await archive(entry)}`,
      );
      continue;
    }
    await rename(path.join(directory, entry), target);
    await chmod(target, 0o600);
    report.whitelistsMoved += 1;
  }
};

/**
 * What the pre-15a session database still holds, or undefined when there is
 * no readable one.
 *
 * Rows rather than a filename, because a filename is not evidence. SQLite
 * creates a database on open, so any process that resolves the old
 * pathname a moment before the move renames it leaves an empty husk behind
 * it — `stratus schedules` is the one that can, since `DatabaseSync` has no
 * open-without-create. A husk answered as "this home is un-migrated" would
 * be a permanent refusal over a file with nothing in it, and the migration
 * that would clear it is already stamped as applied. Asking what is
 * actually in there is both the safer answer and the truer one: a home with
 * no sessions and no schedules has nothing the move could lose.
 *
 * A database that will not open or will not answer counts as holding
 * something, because "cannot tell" must not read as "nothing to lose".
 */
export const legacyStateHeldIn = async (
  stateDir: string,
): Promise<{ sessions: number; schedules: number } | undefined> => {
  const filePath = legacySessionDbIn(stateDir);
  if (!(await exists(filePath))) {
    return undefined;
  }
  const count = (db: SqliteDatabase, table: string): number => {
    if (!hasTable(db, table)) {
      return 0;
    }
    const row = db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number };
    return Number(row.total);
  };
  let db: SqliteDatabase;
  try {
    const { DatabaseSync } = await loadSqlite();
    db = new DatabaseSync(filePath);
  } catch {
    return { sessions: 1, schedules: 1 };
  }
  try {
    return { sessions: count(db, 'sessions'), schedules: count(db, 'schedules') };
  } catch {
    return { sessions: 1, schedules: 1 };
  } finally {
    db.close();
  }
};

/** {@link legacyStateHeldIn} against the state directory `env` names. */
export const legacyStateHeld = (
  env: StateEnvironment,
): Promise<{ sessions: number; schedules: number } | undefined> =>
  legacyStateHeldIn(stratusHomePath(env));

/**
 * Whether this state directory still holds state a daemon of the older
 * build is writing — and therefore whether the move needs it to itself.
 *
 * A pre-layout session database counts **whatever its row count**, because
 * an empty one is not the same as a spent one: a home initialized a minute
 * ago has no conversations yet and a daemon holding that very file open,
 * about to write the first. Letting an ordinary command migrate it without
 * the claim would send that first turn into a file already renamed out of
 * the way.
 *
 * What an empty database *can* mean is a husk — SQLite creates one on open,
 * and `stratus schedules` resolving the old pathname a moment before the
 * rename leaves one behind, since `DatabaseSync` has no open-without-create.
 * The archive beside it is what tells the two apart: a `.migrated` file
 * means the move already happened here, so an empty database at the old
 * name is something that came back afterwards and has nothing in it to
 * lose. Row count alone cannot make that distinction, and an archive alone
 * cannot either — a restored backup would have both — so this asks for both.
 */
export const hasBracketedLegacyStateIn = async (stateDir: string): Promise<boolean> => {
  const held = await legacyStateHeldIn(stateDir);
  if (held !== undefined) {
    const spent = await exists(`${legacySessionDbIn(stateDir)}.migrated`);
    if (!spent || held.sessions > 0 || held.schedules > 0) {
      return true;
    }
  }
  try {
    // With types, because a *directory* of that name is not a legacy grant
    // file: an agent whose id ends in `.whitelist.json` has a state
    // directory spelled exactly like one, and reading it as un-migrated
    // state would refuse the home for good — 0003 is stamped and would
    // never clear it. Held to path safety rather than a slug shape, such an
    // id is legal, so the distinction has to be made here.
    const entries = await readdir(agentsDirIn(stateDir), { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && entry.name.endsWith(LEGACY_WHITELIST_SUFFIX));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};

/** {@link hasBracketedLegacyStateIn} against the state directory `env` names. */
export const hasBracketedLegacyState = (env: StateEnvironment): Promise<boolean> =>
  hasBracketedLegacyStateIn(stratusHomePath(env));

const emptyReport = (env: StateEnvironment): LayoutMigrationReport => ({
  agentsWithSessions: 0,
  sessionsMoved: 0,
  schedulesMoved: 0,
  agentsWithMemories: 0,
  memoriesMoved: 0,
  whitelistsMoved: 0,
  quarantined: [],
  directoryNames: createStateDirectoryNames(env),
});

const describe = (report: LayoutMigrationReport): string | undefined => {
  const moved: string[] = [];
  if (report.sessionsMoved > 0) {
    moved.push(`${report.sessionsMoved} session(s) into ${report.agentsWithSessions} agent store(s)`);
  }
  if (report.schedulesMoved > 0) {
    moved.push(`${report.schedulesMoved} schedule(s) into fleet.db`);
  }
  if (report.memoriesMoved > 0) {
    moved.push(`${report.memoriesMoved} memory record(s) into ${report.agentsWithMemories} agent store(s)`);
  }
  if (report.whitelistsMoved > 0) {
    moved.push(`${report.whitelistsMoved} grant file(s)`);
  }
  if (moved.length === 0 && report.quarantined.length === 0) {
    return undefined;
  }
  const summary = moved.length > 0 ? `moved ${moved.join(', ')}` : 'moved nothing';
  // Deduped: the archive pass re-reads what the pass before it already saw,
  // so an id with nowhere to land would otherwise be named twice.
  const quarantined = [...new Set(report.quarantined)];
  return quarantined.length > 0
    ? `${summary}; QUARANTINED, left in the preserved originals: ${quarantined.join('; ')}`
    : summary;
};

/**
 * Fold whatever is in the shared `memory.jsonl` into the agents' own files.
 *
 * Not a migration and deliberately not stamped: run it on every command and
 * every daemon start, for as long as a home has been through an upgrade.
 * The reason is in `shardMemories` — the file store opens the JSONL by
 * pathname on every append, so a daemon of the older build can recreate the
 * shared file after any single pass, and a pass that recorded itself as
 * done would leave that last fact where nothing looks. A drain converges
 * instead: whatever comes back is taken on the next command.
 *
 * It is also why the memory half needs no exclusive bracket, which matters
 * more than it sounds — deferring it would leave every `stratus run`,
 * `stratus agents`, and `stratus memory` between the upgrade and the next
 * daemon start reading an agent that remembers nothing, and an upgrade must
 * never look like the agent forgot.
 *
 * Costs one `stat` once the file is gone for good.
 */
export const drainSharedMemory = async (env: StateEnvironment): Promise<string | undefined> => {
  const report = emptyReport(env);
  await copySharedMemory(env, report);
  // And any claim a retirement could not finish. `placeClaim` leaves one
  // behind when the file was still growing, and migration 0003 is stamped by
  // then — so without this the records it is holding are reachable by
  // nothing, which is the state the claim exists to avoid. Costs one
  // `readdir` of the home per command, and finds nothing on every home that
  // has finished upgrading.
  await drainRetiring(env, report);
  return describe(report);
};

/**
 * Sessions into `agents/<id>/sessions.db`, the schedule rows that shared
 * their database into `fleet.db`, and each agent's grant file into its own
 * directory. Idempotent and restartable at every resource boundary.
 *
 * The three that need the home to themselves — see `hasBracketedLegacyState`
 * and the note on `moveWhitelists`.
 */
export const applyPerAgentLayout = async (env: StateEnvironment): Promise<string | undefined> => {
  // A linked `agents/` first, before any stage reads or writes under it.
  // Each stage guards its own writes, but `moveWhitelists` archives the
  // grant files it cannot place by renaming them *in* `agents/`, and a
  // rename there goes through the link — a migration that then stamps
  // itself applied, having moved files outside the home. Refused rather
  // than quarantined: the link redirects every agent at once, so there is
  // no per-agent line to report it on, and the operator has one component
  // to replace before the upgrade can run.
  await assertDerivedStatePath(stratusHomePath(env), agentsDirPath(env), 'directory');
  const report = emptyReport(env);
  const legacyPath = legacySessionDbPath(env);
  if (await exists(legacyPath)) {
    // The one derived path this migration opens without insisting it is
    // real, and the asymmetry is deliberate. `fleet.db` and each shard are
    // files *this* build creates, so refusing a link there costs nothing;
    // the legacy database is one an operator may already have relocated,
    // under builds that had no such rule, and refusing it would strand that
    // home on an upgrade it can never complete — with every session in the
    // file it is being refused for.
    //
    // What the rule is actually about is not done to it: a link is read and
    // then *renamed* (which renames the link, leaving their file where it
    // is), and it is not tightened, so no mode of theirs is changed through
    // it, nor written at all: it is opened read-only, and every attach of
    // it is `mode=ro`. Reading an operator's own data is what this
    // migration is for.
    const legacyIsLink = await linkedDerivedComponent(stratusHomePath(env), legacyPath) !== undefined;
    const legacyDb = await openDatabase(legacyPath, !legacyIsLink);
    try {
      report.schedulesMoved = await moveSchedules(legacyDb, env, legacyIsLink);
      await shardSessions(legacyDb, env, report);
    } finally {
      legacyDb.close();
    }
    // Last, and only once both stages above have returned: the renamed
    // source is what says they are done, so a kill anywhere before this
    // line re-runs them — which is safe, because both are keyed writes. The
    // sidecars move with it; SQLite derives their names from the main
    // file's, so one left behind belongs to a database that is not there.
    // Never over an archive that is already there. A run killed after this
    // rename but before the stamp leaves one, and `stratus schedules` can
    // recreate an empty `sessions.db` husk at the old name in the meantime —
    // SQLite creates on open. The retry would then rename that husk over the
    // real archive and take with it every row this pass had quarantined,
    // which is the one copy of them left.
    const archive = await exists(`${legacyPath}.migrated`)
      ? `${legacyPath}.migrated-${randomUUID()}`
      : `${legacyPath}.migrated`;
    await rename(legacyPath, archive);
    for (const suffix of ['-wal', '-shm']) {
      if (await exists(`${legacyPath}${suffix}`)) {
        await rename(`${legacyPath}${suffix}`, `${archive}${suffix}`);
      }
    }
  }
  // The memories too, one last time and then for good: the copy is what
  // every command has been running, and this is the only caller that may
  // also take the source away.
  await copySharedMemory(env, report);
  await retireSharedMemory(env, report);
  await moveWhitelists(env, report);
  return describe(report);
};
