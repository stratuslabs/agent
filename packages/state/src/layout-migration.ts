import { randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { isValidAgentId } from '@stratusagent/agents';
import { LEGACY_WHITELIST_SUFFIX, whitelistPathFor } from '@stratusagent/permissions';
import { type StateEnvironment } from './environment.ts';
import {
  agentMemoryFilePath,
  agentSessionDbPath,
  agentStateDirPath,
  agentsDirPath,
  fleetDbPath,
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
//   writing this state, and each resource answers it differently. The
//   session database and the grant files move under an exclusive bracket,
//   because their writers cannot be reconciled after the fact: a SQLite
//   file is held open, and a grant file is a whole-state document where a
//   revocation written to the old path after the move would leave the new
//   one still granting. The memory file needs no bracket, because it is an
//   append-only log and a *drain* can converge on it — which is why the
//   memory half is not a stamped migration at all (see
//   `drainSharedMemory`): stamping it would declare the job done while a
//   process that has not restarted can still append one more line.
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
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST' && code !== 'ENOTDIR') {
      throw error;
    }
    report.quarantined.push(
      `${JSON.stringify(agentId)} (${what}) — ${path.relative(stratusHomePath(env), directory)} is already a file, `
      + 'so this agent has no directory to own; rename its id to free the name',
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
  const fleet = await openDatabase(fleetDbPath(env));
  try {
    if (!hasTable(fleet, 'schedules') && schema !== undefined) {
      fleet.exec(schema);
    }
    // Attached rather than read-then-write: one statement, inside SQLite,
    // with no schedule body making a round trip through this process.
    fleet.prepare('ATTACH ? AS legacy').run(legacySessionDbPath(env));
    try {
      const columns = columnsOf(fleet, 'legacy', 'schedules').join(', ');
      fleet.exec(`INSERT OR REPLACE INTO schedules (${columns}) SELECT ${columns} FROM legacy.schedules`);
      const counted = fleet.prepare('SELECT COUNT(*) AS total FROM legacy.schedules').get() as { total: number };
      return Number(counted.total);
    } finally {
      fleet.exec('DETACH legacy');
    }
  } finally {
    fleet.close();
    await tighten(fleetDbPath(env));
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
 * Split the shared memory file into one JSONL per agent.
 *
 * Every record type goes by its `agentId` — entries, the tombstones that
 * retire them, and the re-assertions that re-label them — because a
 * tombstone parted from its entry is a forgotten fact that comes back.
 *
 * Deduped by line rather than by id: the file is append-only and the same
 * line written twice is the same record, so a re-run after a kill converges
 * instead of doubling an agent's history. A line nobody can attribute (a
 * hand edit, a truncated write) stays in the preserved original, where it
 * is recoverable, rather than being guessed into somebody's store.
 */
const shardMemories = async (env: StateEnvironment, report: LayoutMigrationReport): Promise<void> => {
  const source = legacyMemoryFilePath(env);
  const archive = `${source}.migrated`;

  // Taken by rename before a byte is read, the way the per-directory import
  // already claims its source: of any processes racing, exactly one wins the
  // rename and the rest see ENOENT.
  //
  // The rename is not the end of it, and this is the part that decides the
  // shape of the whole memory half. The file store opens the JSONL *by
  // pathname* on every append, so a daemon of the older build writing one
  // more fact after the rename does not land in the claimed inode — it
  // recreates `memory.jsonl`, where nothing would ever look again if this
  // ran once and recorded itself as done. So it does not: it is a drain
  // that every command and every daemon start runs until the file stops
  // coming back, and only a process still running the older build can make
  // it come back.
  const claimAndSplit = async (sourcePath: string): Promise<void> => {
    const claimPath = path.join(path.dirname(source), `${path.basename(source)}.migrating-${randomUUID()}`);
    try {
      await rename(sourcePath, claimPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return; // another process owns it, or there is nothing to migrate
      }
      throw error;
    }
    const claimed = await readFile(claimPath, 'utf8');
    const byAgent = new Map<string, string[]>();
    const unsafe = new Map<string, number>();
    let unattributed = 0;
    for (const line of claimed.split('\n')) {
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
      const destination = agentMemoryFilePath(env, agentId);
      let existing = new Set<string>();
      try {
        existing = new Set((await readFile(destination, 'utf8')).split('\n'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
      // Deduped by line rather than by id: the file is append-only and the
      // same line written twice is the same record, so a re-run after a kill
      // converges instead of doubling an agent's history.
      const fresh = lines.filter((line) => !existing.has(line));
      if (fresh.length === 0) {
        continue;
      }
      if (!(await agentDirectoryOrQuarantine(env, agentId, `${fresh.length} memory record(s)`, report))) {
        continue;
      }
      // Appended, never rewritten: the JSONL is append-only because that is
      // its whole concurrency model, and a migration that rewrote the file
      // would be the one writer that could lose a line somebody else added.
      await appendFile(destination, `${fresh.join('\n')}\n`, { mode: 0o600 });
      await chmod(destination, 0o600);
      report.agentsWithMemories += 1;
      report.memoriesMoved += fresh.length;
    }
    if (unattributed > 0) {
      report.quarantined.push(
        `${unattributed} memory line(s) with no agent id — left in the preserved ${path.basename(archive)}`,
      );
    }
    // Archived by appending, never overwriting an earlier archive, and the
    // claim dropped only once its content is preserved there.
    if (claimed.length > 0) {
      await appendFile(archive, claimed.endsWith('\n') ? claimed : `${claimed}\n`, { mode: 0o600 });
      await chmod(archive, 0o600);
    }
    await rm(claimPath);
  };

  await claimAndSplit(source);

  // Finish any claim a crashed run left behind.
  let leftovers: string[];
  try {
    leftovers = await readdir(path.dirname(source));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  for (const name of leftovers) {
    if (name.startsWith(`${path.basename(source)}.migrating`)) {
      await claimAndSplit(path.join(path.dirname(source), name));
    }
  }

  // The derived FTS index of a record that is no longer there: renamed with
  // it, so nothing rebuilds an index for a file this migration emptied.
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
    const target = whitelistPathFor(directory, agentId);
    if (await exists(target)) {
      // Both spellings present: the agent's own directory is the one the
      // daemon reads, so the older file stays put rather than overwriting
      // grants somebody has since changed. Named, not silently skipped.
      report.quarantined.push(`${entry} — ${path.relative(directory, target)} already exists, so the old file was left alone`);
      continue;
    }
    if (!(await agentDirectoryOrQuarantine(env, agentId, 'grants', report))) {
      continue;
    }
    await rename(path.join(directory, entry), target);
    await chmod(target, 0o600);
    report.whitelistsMoved += 1;
  }
};

/**
 * Whether this home still holds state a daemon of the older build is
 * writing — and therefore whether the move needs the home to itself.
 *
 * The shared session database, or a grant file under its old name. A fresh
 * install has neither, needs no bracket, and gets the migration applied as
 * the no-op it is on the next ordinary command rather than being left with
 * an old schema stamp waiting for a daemon start it may not get for days.
 */
export const hasBracketedLegacyState = async (env: StateEnvironment): Promise<boolean> => {
  if (await exists(legacySessionDbPath(env))) {
    return true;
  }
  try {
    return (await readdir(agentsDirPath(env))).some((entry) => entry.endsWith(LEGACY_WHITELIST_SUFFIX));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};

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
  await shardMemories(env, report);
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
  await moveWhitelists(env, report);
  return describe(report);
};
