import { appendFile, chmod, mkdir, readdir, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';

import { isValidAgentId } from '@stratusagent/agents';
import { LEGACY_WHITELIST_SUFFIX, whitelistPathFor } from '@stratusagent/permissions';
import { type StateEnvironment } from './environment.ts';
import {
  agentMemoryFilePath,
  agentSessionDbPath,
  agentStateDirPath,
  agentsDirIn,
  agentsDirPath,
  fleetDbPath,
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
 */
const agentDirectoryOrQuarantine = async (
  env: StateEnvironment,
  agentId: string,
  what: string,
  report: LayoutMigrationReport,
): Promise<string | undefined> => {
  const directory = agentStateDirPath(env, agentId);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return directory;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (!UNUSABLE_DIRECTORY_NAME.has(code)) {
      throw error;
    }
    report.quarantined.push(
      `${JSON.stringify(agentId)} (${what}) — ${path.relative(stratusHomePath(env), directory)} cannot be a directory `
      + `(${code}); this agent has no directory to own, so rename its id`,
    );
    return undefined;
  }
};

const openDatabase = async (filePath: string): Promise<SqliteDatabase> => {
  const { DatabaseSync } = await loadSqlite();
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  await tighten(filePath);
  return db;
};

/** What one run of the migration changed, for the line it reports. */
interface LayoutMigrationReport {
  agentsWithSessions: number;
  sessionsMoved: number;
  schedulesMoved: number;
  agentsWithMemories: number;
  memoriesMoved: number;
  whitelistsMoved: number;
  /** Agent ids whose rows could not be given a directory, and what held them back. */
  quarantined: string[];
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
const moveSchedules = async (legacyDb: SqliteDatabase, env: StateEnvironment): Promise<number> => {
  if (!hasTable(legacyDb, 'schedules')) {
    return 0;
  }
  const schema = tableSchemaOf(legacyDb, 'schedules');
  // The destination table first, on its own connection, so the copy below
  // needs no rewriting of the source's `CREATE TABLE` to name an attached
  // schema.
  const fleetPath = fleetDbPath(env);
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
    const shardPath = agentSessionDbPath(env, owner.agent_id);
    const shard = await openDatabase(shardPath);
    try {
      if (!hasTable(shard, 'sessions')) {
        shard.exec(schema);
      }
      shard.prepare('ATTACH ? AS legacy').run(legacySessionDbPath(env));
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
const copySharedMemory = async (env: StateEnvironment, report: LayoutMigrationReport): Promise<void> => {
  const source = legacyMemoryFilePath(env);
  let raw: string;
  try {
    raw = await readFile(source, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }

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
    const destination = agentMemoryFilePath(env, agentId);
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
    await appendFile(destination, `${fresh.join('\n')}\n`, { mode: 0o600 });
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
const retireSharedMemory = async (env: StateEnvironment): Promise<void> => {
  const source = legacyMemoryFilePath(env);
  if (!(await exists(source))) {
    return;
  }
  await rename(source, `${source}.migrated`);
  if (await exists(`${source}.index`)) {
    await rename(`${source}.index`, `${source}.index.migrated`);
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
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    if (!entry.endsWith(LEGACY_WHITELIST_SUFFIX) || entry === LEGACY_WHITELIST_SUFFIX) {
      continue;
    }
    const agentId = entry.slice(0, -LEGACY_WHITELIST_SUFFIX.length);
    if (!isValidAgentId(agentId)) {
      report.quarantined.push(`${JSON.stringify(agentId)} (grants) — not a single path segment, so it has no directory to own`);
      continue;
    }
    // The directory before anything under it, for the reason the memory
    // copy gives: `exists` on a path beneath a regular file throws ENOTDIR,
    // and from here that would abort the whole migration and leave the
    // daemon unable to start.
    if (!(await agentDirectoryOrQuarantine(env, agentId, 'grants', report))) {
      continue;
    }
    const target = whitelistPathFor(directory, agentId);
    if (await exists(target)) {
      // Both spellings present: the agent's own directory is the one the
      // daemon reads, so the older file stays put rather than overwriting
      // grants somebody has since changed. Named, not silently skipped.
      report.quarantined.push(`${entry} — ${path.relative(directory, target)} already exists, so the old file was left alone`);
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
    return (await readdir(agentsDirIn(stateDir))).some((entry) => entry.endsWith(LEGACY_WHITELIST_SUFFIX));
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

const emptyReport = (): LayoutMigrationReport => ({
  agentsWithSessions: 0,
  sessionsMoved: 0,
  schedulesMoved: 0,
  agentsWithMemories: 0,
  memoriesMoved: 0,
  whitelistsMoved: 0,
  quarantined: [],
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
  return report.quarantined.length > 0
    ? `${summary}; QUARANTINED, left in the preserved originals: ${report.quarantined.join('; ')}`
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
  const report = emptyReport();
  await copySharedMemory(env, report);
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
  const report = emptyReport();
  const legacyPath = legacySessionDbPath(env);
  if (await exists(legacyPath)) {
    const legacyDb = await openDatabase(legacyPath);
    try {
      report.schedulesMoved = await moveSchedules(legacyDb, env);
      await shardSessions(legacyDb, env, report);
    } finally {
      legacyDb.close();
    }
    // Last, and only once both stages above have returned: the renamed
    // source is what says they are done, so a kill anywhere before this
    // line re-runs them — which is safe, because both are keyed writes. The
    // sidecars move with it; SQLite derives their names from the main
    // file's, so one left behind belongs to a database that is not there.
    await rename(legacyPath, `${legacyPath}.migrated`);
    for (const suffix of ['-wal', '-shm']) {
      if (await exists(`${legacyPath}${suffix}`)) {
        await rename(`${legacyPath}${suffix}`, `${legacyPath}.migrated${suffix}`);
      }
    }
  }
  // The memories too, one last time and then for good: the copy is what
  // every command has been running, and this is the only caller that may
  // also take the source away.
  await copySharedMemory(env, report);
  await retireSharedMemory(env);
  await moveWhitelists(env, report);
  return describe(report);
};
