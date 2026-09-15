import { chmodSync, mkdirSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { Session, SessionStatus, SessionStore } from '@stratusagent/core';
import {
  agentSessionDbIn,
  agentStateDirIn,
  agentsDirIn,
  assertPathSafeAgentId,
  fleetDbIn,
  isSymlinkedStatePathSync,
  symlinkedStateDirectoryMessage,
  symlinkedStateFileMessage,
} from '@stratusagent/state';

/**
 * Sessions live one database per agent — `agents/<id>/sessions.db` — with
 * one fleet-wide index saying which agent's store holds a given session id.
 *
 * The sharding is the point (step 15's layer A): a store is opened on one
 * agent's path, so there is no query that could return another agent's
 * conversations. The index is what the sharding costs. Session ids are
 * caller-chosen and the control API resolves them *without* an agent —
 * `GET /sessions/:id`, a message to an existing session — which was
 * unambiguous only because one shared database's primary key made a
 * duplicate id unrepresentable. The index restores that: it is where an id
 * is claimed, and it is what a lookup with no agent in hand consults.
 *
 * It also carries `status`, `created_at`, and `updated_at`, because the
 * session surface is fleet-wide in more places than the point lookup: the
 * health counts, the roster's per-agent activity, the unfiltered listing,
 * and the restart sweep that resumes parked approvals and fails abandoned
 * turns. Answering those from the index rather than by fanning out over
 * every shard is what keeps a recovery sweep from walking only whichever
 * store happened to be open — an agent whose parked approval never
 * resumes.
 */
const SESSIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    status TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;

/**
 * The same columns minus the conversation body: the index is a routing
 * table and a set of claimed ids, never a second copy of the transcript.
 * Nothing about a conversation can be read out of the fleet database.
 */
const SESSION_INDEX_TABLE = `
  CREATE TABLE IF NOT EXISTS session_index (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;

/**
 * Sessions hold complete conversations (prompts, replies, tool output,
 * provider replay state) — owner-only, like the credentials file. The file
 * chmods cover databases created earlier under a looser umask too;
 * directories the stores create are born 0700.
 *
 * Exported because the layout migration writes the same files from
 * `@stratusagent/state` before any store is open, and a second hand-rolled
 * chmod loop is how one of the two ends up leaving a sidecar readable.
 */
export const tightenSqliteFile = (filePath: string): void => {
  // The database file is tightened FIRST: SQLite derives sidecar
  // permissions from the main file's mode, so everything created later
  // inherits owner-only.
  for (const sensitive of [filePath, `${filePath}-wal`, `${filePath}-shm`, `${filePath}-journal`]) {
    try {
      chmodSync(sensitive, 0o600);
    } catch (error) {
      // A sidecar that does not exist has nothing to tighten; anything
      // else means session data stays readable — refuse to run over it.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
};

/**
 * Durable session storage on node:sqlite (unflagged on Node 22.13+). The
 * whole session — messages, status, and metadata, including provider replay
 * state like the Anthropic raw-turn cache — round-trips as one JSON body,
 * so a conversation resumed after a daemon restart replays exactly.
 */
export interface SqliteSessionStoreOptions {
  /**
   * The database's parent directory is dedicated Stratus state (e.g. the
   * default ~/.stratus): tighten it to owner-only even when it already
   * exists, since mkdir's mode only applies to directories it creates and
   * an upgrade over a looser install must not stay world-readable. Leave
   * false for caller-supplied paths — a shared parent like /tmp or a
   * project directory must never be chmodded implicitly.
   */
  ownedDirectory?: boolean;
}

/**
 * Whether a real file is there — the sweep's test for "this directory holds
 * a shard".
 *
 * `lstat`, so a symlink is not one. `stat` follows it, which would classify
 * a directory holding a linked `sessions.db` as an agent's and hand the
 * sweep a store it then creates, indexes and tightens somewhere outside the
 * home. The old layout reserved none of these names, so an operator's
 * `agents/<something>/sessions.db` pointing elsewhere is theirs, not ours.
 */
const shardFileExists = async (filePath: string): Promise<boolean> => {
  try {
    return (await lstat(filePath)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};

/**
 * Opens the file, tightens it and its sidecars, and puts the connection in
 * the mode every Stratus database runs in. Shared by the per-agent store,
 * the fleet index, and the schedule store, because the posture is one rule:
 * WAL (a DELETE journal recreates a rollback file on every write, which a
 * one-time chmod could never cover), a busy timeout (these files have a
 * second writer — `stratus schedules cancel` opens its own connection —
 * and WAL serializes writers file-wide), and owner-only throughout.
 */
const openStratusDatabase = (filePath: string, options: SqliteSessionStoreOptions = {}): DatabaseSync => {
  const dir = path.dirname(filePath);
  if (options.ownedDirectory) {
    // Never a symlink — see `isSymlinkedStateDirectory`, which owns that
    // rule. Refused rather than quarantined, unlike the migration: at
    // runtime there is no report to name it in, and a turn that cannot be
    // stored must not read as stored.
    //
    // Only for a directory this store owns: `~/.stratus` itself is a symlink
    // on plenty of real installs (a home on another disk), and the fleet
    // index and the schedule store live directly in it.
    if (isSymlinkedStatePathSync(dir)) {
      throw new Error(symlinkedStateDirectoryMessage(dir));
    }
    // And the database itself. A link here is followed just as readily:
    // the table is created, the rows indexed and the mode tightened in
    // whatever it points at.
    if (isSymlinkedStatePathSync(filePath)) {
      throw new Error(symlinkedStateFileMessage(filePath));
    }
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (options.ownedDirectory) {
    chmodSync(dir, 0o700);
  }
  const db = new DatabaseSync(filePath);
  try {
    chmodSync(filePath, 0o600);
  } catch (error) {
    // A database that cannot be tightened must not be used: conversation
    // bodies would stay readable by other local users for the daemon's
    // whole lifetime, silently.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  // Forced into existence here (the user_version pragma is a real page-one
  // write) so the tightening below covers the WAL sidecars for the
  // connection's whole lifetime.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
};

export class SqliteSessionStore implements SessionStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string, options: SqliteSessionStoreOptions = {}) {
    this.db = openStratusDatabase(filePath, options);
    this.db.exec(SESSIONS_TABLE);
    this.db.exec('PRAGMA user_version = 0');
    tightenSqliteFile(filePath);
  }

  private write(session: Session): Session {
    this.db
      .prepare('INSERT OR REPLACE INTO sessions (id, agent_id, status, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(session.id, session.agent.id, session.status, JSON.stringify(session), session.createdAt, session.updatedAt);
    return session;
  }

  async create(input: Omit<Session, 'createdAt' | 'updatedAt'>): Promise<Session> {
    const now = new Date().toISOString();
    return this.write({ ...input, createdAt: now, updatedAt: now });
  }

  async get(id: string): Promise<Session | undefined> {
    const row = this.db.prepare('SELECT body FROM sessions WHERE id = ?').get(id) as
      | { body: string }
      | undefined;
    return row ? (JSON.parse(row.body) as Session) : undefined;
  }

  async save(session: Session): Promise<void> {
    await this.saveReturning(session);
  }

  /**
   * The same save, handing back the row as it was written.
   *
   * For a caller that has to mirror it: the sharded store keeps the fleet
   * index in step, and an index holding a timestamp the store does not is
   * drift the startup reconcile would have to clean up every boot.
   */
  async saveReturning(session: Session): Promise<Session> {
    return this.write({ ...session, updatedAt: new Date().toISOString() });
  }

  /**
   * Session ids in a state, oldest first — the index a restarting daemon
   * sweeps for turns parked on a human. The `status` column carries it, so
   * no conversation body is deserialized to answer the question.
   */
  async listIdsByStatus(status: SessionStatus): Promise<string[]> {
    const rows = this.db
      .prepare('SELECT id FROM sessions WHERE status = ? ORDER BY updated_at ASC')
      .all(status) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  /**
   * Every row's routing and lifecycle columns, no bodies — what the
   * startup reconcile compares this shard against the fleet index with.
   */
  rows(): SessionIndexRow[] {
    const rows = this.db
      .prepare('SELECT id, agent_id, status, created_at, updated_at FROM sessions')
      .all() as Array<{ id: string; agent_id: string; status: SessionStatus; created_at: string; updated_at: string }>;
    return rows.map((row) => ({
      id: row.id,
      agentId: row.agent_id,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  close(): void {
    this.db.close();
  }
}

/** One session's routing and lifecycle, as the fleet index holds it. */
export interface SessionIndexRow {
  id: string;
  agentId: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * Thrown when a session id another agent already holds is claimed.
 *
 * Sessions never cross agent identities — the dispatcher says so when it
 * finds the conversation, and this is the same rule at the durable seam,
 * where a shared database's primary key used to enforce it for free.
 */
export class SessionIdTakenError extends Error {
  constructor(sessionId: string, heldBy: string, claimedBy: string) {
    super(
      `Session ${sessionId} already belongs to agent ${heldBy}, so ${claimedBy} cannot open a conversation under that id — `
      + 'sessions never cross agent identities. Give the new conversation an id of its own.',
    );
    this.name = 'SessionIdTakenError';
  }
}

/**
 * The fleet's session index, in `fleet.db` beside the schedules.
 *
 * Its own connection rather than a table on the schedule store, for the
 * reason the schedule store gives for its own: `stratus schedules` opens
 * that file from another process, and WAL is what makes two connections on
 * one file routine.
 */
export class FleetSessionIndex {
  private readonly db: DatabaseSync;

  constructor(filePath: string, options: SqliteSessionStoreOptions = {}) {
    this.db = openStratusDatabase(filePath, options);
    this.db.exec(SESSION_INDEX_TABLE);
    tightenSqliteFile(filePath);
  }

  /**
   * Claim an id for an agent, or refuse it.
   *
   * The claim is the create's single transactional authority: it lands
   * before the shard write, so a crash between the two leaves a claim with
   * no conversation — which the reconcile releases — rather than a
   * conversation no lookup can reach. Re-claiming an id this agent already
   * holds is a no-op, because `create` on an existing id is how a caller
   * re-opens its own session.
   */
  claim(row: SessionIndexRow): void {
    const held = this.agentFor(row.id);
    if (held !== undefined && held !== row.agentId) {
      throw new SessionIdTakenError(row.id, held, row.agentId);
    }
    this.record(row);
  }

  /** Write the row as it now stands. Called after every shard write. */
  record(row: SessionIndexRow): void {
    this.db
      .prepare('INSERT OR REPLACE INTO session_index (id, agent_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(row.id, row.agentId, row.status, row.createdAt, row.updatedAt);
  }

  /** Drop a claim — a reconcile releasing an id whose conversation never landed. */
  release(id: string): void {
    this.db.prepare('DELETE FROM session_index WHERE id = ?').run(id);
  }

  agentFor(id: string): string | undefined {
    const row = this.db.prepare('SELECT agent_id FROM session_index WHERE id = ?').get(id) as
      | { agent_id: string }
      | undefined;
    return row?.agent_id;
  }

  rows(): SessionIndexRow[] {
    const rows = this.db
      .prepare('SELECT id, agent_id, status, created_at, updated_at FROM session_index')
      .all() as Array<{ id: string; agent_id: string; status: SessionStatus; created_at: string; updated_at: string }>;
    return rows.map((row) => ({
      id: row.id,
      agentId: row.agent_id,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  idsByStatus(status: SessionStatus): string[] {
    const rows = this.db
      .prepare('SELECT id FROM session_index WHERE status = ? ORDER BY updated_at ASC')
      .all(status) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  countByStatus(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS total FROM session_index GROUP BY status')
      .all() as Array<{ status: string; total: number }>;
    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.status] = Number(row.total);
    }
    return counts;
  }

  lastActivityByAgent(): Record<string, { lastActiveAt: string; activeSessions: number }> {
    const rows = this.db
      .prepare(`
        SELECT agent_id,
               MAX(updated_at) AS last_active_at,
               SUM(CASE WHEN status IN ('running', 'pending_approval') THEN 1 ELSE 0 END) AS active_sessions
        FROM session_index
        GROUP BY agent_id
      `)
      .all() as Array<{ agent_id: string; last_active_at: string; active_sessions: number }>;
    const activity: Record<string, { lastActiveAt: string; activeSessions: number }> = {};
    for (const row of rows) {
      activity[row.agent_id] = {
        lastActiveAt: row.last_active_at,
        activeSessions: Number(row.active_sessions),
      };
    }
    return activity;
  }

  list(agentId?: string, limit?: number): Array<Pick<Session, 'id' | 'status' | 'createdAt' | 'updatedAt'> & { agentId: string }> {
    // -1 is SQLite's "no limit", so one prepared statement serves both cases
    // rather than four.
    const bound = limit !== undefined && Number.isInteger(limit) && limit >= 0 ? limit : -1;
    const rows = (agentId
      ? this.db.prepare('SELECT id, agent_id, status, created_at, updated_at FROM session_index WHERE agent_id = ? ORDER BY updated_at DESC LIMIT ?').all(agentId, bound)
      : this.db.prepare('SELECT id, agent_id, status, created_at, updated_at FROM session_index ORDER BY updated_at DESC LIMIT ?').all(bound)) as Array<{
      id: string;
      agent_id: string;
      status: Session['status'];
      created_at: string;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      agentId: row.agent_id,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  close(): void {
    this.db.close();
  }
}

/** What a startup reconcile put back in step, for the daemon's log. */
export interface SessionReconcileReport {
  /** Claims released: an id in the index whose conversation never landed. */
  released: string[];
  /** Sessions re-indexed: a conversation the index had lost, or disagreed about. */
  reindexed: string[];
}

export interface ShardedSessionStoreOptions {
  /** Where `agents/` and `fleet.db` live. The default is `~/.stratus`. */
  stateDir: string;
  /**
   * Whether that directory is dedicated Stratus state and may be tightened
   * to owner-only — see {@link SqliteSessionStoreOptions}.
   */
  ownedDirectory?: boolean;
}

/**
 * The fleet's session store: one SQLite database per agent, behind the
 * `SessionStore` every runner already takes, with the fleet-wide reads the
 * control API and the restart sweeps need answered across all of them.
 *
 * A runner is handed *this* — and every write goes to the store opened on
 * its own agent's path. What the facade adds is the set of questions that
 * were never about one agent: which agent holds an id, how many sessions
 * are in each state, when each agent last did anything, and which ids are
 * parked or abandoned fleet-wide.
 */
export class ShardedSessionStore implements SessionStore {
  private readonly stateDir: string;
  private readonly ownedDirectory: boolean;
  private readonly index: FleetSessionIndex;
  private readonly shards = new Map<string, SqliteSessionStore>();

  constructor(options: ShardedSessionStoreOptions) {
    this.stateDir = options.stateDir;
    this.ownedDirectory = options.ownedDirectory ?? false;
    this.index = new FleetSessionIndex(
      fleetDbIn(options.stateDir),
      this.ownedDirectory ? { ownedDirectory: true } : {},
    );
  }

  /**
   * One agent's store, opened on first use and kept open.
   *
   * Opened lazily because a roster's agents are not all busy: a daemon
   * with forty souls should hold descriptors for the ones that have
   * conversations, not for every id on disk.
   */
  private shardFor(agentId: string): SqliteSessionStore {
    const existing = this.shards.get(agentId);
    if (existing !== undefined) {
      return existing;
    }
    // Always owner-only: a per-agent directory is state this repository
    // creates, never a path an embedder pointed at something shared.
    const shard = new SqliteSessionStore(agentSessionDbIn(this.stateDir, agentId), { ownedDirectory: true });
    this.shards.set(agentId, shard);
    return shard;
  }

  async create(input: Omit<Session, 'createdAt' | 'updatedAt'>): Promise<Session> {
    const agentId = input.agent.id;
    assertPathSafeAgentId(agentId);
    const now = new Date().toISOString();
    // The claim first, and it is what refuses a sibling's id: the store
    // write below is only reachable for an id this agent may have.
    this.index.claim({ id: input.id, agentId, status: input.status, createdAt: now, updatedAt: now });
    const session = await this.shardFor(agentId).create(input);
    this.index.record({
      id: session.id,
      agentId,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    });
    return session;
  }

  async get(id: string): Promise<Session | undefined> {
    const agentId = this.index.agentFor(id);
    // No claim, no conversation. The index is the authority for "which
    // agent's store holds this id" precisely so a lookup never has to
    // guess by opening stores until one answers.
    return agentId === undefined ? undefined : this.shardFor(agentId).get(id);
  }

  async save(session: Session): Promise<void> {
    const agentId = session.agent.id;
    assertPathSafeAgentId(agentId);
    // One id belongs to one agent, and this is the path that could change
    // that quietly. `create` claims the id, so a sibling is refused at the
    // seam; `save` takes whatever agent the session now names. A caller
    // handing back a session whose `agent.id` has changed would write a
    // second copy into the new agent's shard and then repoint the index at
    // it — the original transcript still on disk but in a store nothing
    // resolves to, and the next start refusing to serve at all, because the
    // reconcile finds one id in two shards and says so. Refused here, where
    // the error can still name the agent it belongs to.
    const heldBy = this.index.agentFor(session.id);
    if (heldBy !== undefined && heldBy !== agentId) {
      throw new SessionIdTakenError(session.id, heldBy, agentId);
    }
    // The conversation is the truth and the index is derived from it, so
    // the shard write goes first: a crash in between leaves an index row
    // one status behind, which the next start reconciles, rather than an
    // index pointing at a turn the store never took.
    const written = await this.shardFor(agentId).saveReturning(session);
    this.index.record({
      id: written.id,
      agentId,
      status: written.status,
      createdAt: written.createdAt,
      updatedAt: written.updatedAt,
    });
  }

  async listIdsByStatus(status: SessionStatus): Promise<string[]> {
    return this.index.idsByStatus(status);
  }

  countByStatus(): Record<string, number> {
    return this.index.countByStatus();
  }

  lastActivityByAgent(): Record<string, { lastActiveAt: string; activeSessions: number }> {
    return this.index.lastActivityByAgent();
  }

  list(agentId?: string, limit?: number): Array<Pick<Session, 'id' | 'status' | 'createdAt' | 'updatedAt'> & { agentId: string }> {
    return this.index.list(agentId, limit);
  }

  /**
   * Put the index and the shards back in step, before anything reads
   * either. Two durable writes stand where one atomic primary key used to,
   * and this is what makes a crash between them resolve one way rather
   * than leaving them to disagree:
   *
   * - a claim whose conversation never landed is released, freeing the id;
   * - a conversation the index has lost — or disagrees with — is
   *   re-indexed from the shard, which is the record;
   * - the same id in two agents' shards is refused loudly, naming both,
   *   because picking one would silently hand somebody else's conversation
   *   to whoever asks for that id next.
   */
  async reconcile(): Promise<SessionReconcileReport> {
    const report: SessionReconcileReport = { released: [], reindexed: [] };
    const owners = new Map<string, SessionIndexRow>();
    for (const agentId of await this.shardedAgentIds()) {
      // Read through a connection this reconcile owns, and let it go again
      // unless the store was already open: a roster's every agent has a
      // store on disk, and holding one descriptor per agent from start-up
      // would make a big roster pay at rest for a sweep that runs once.
      const cached = this.shards.get(agentId);
      const shard = cached ?? new SqliteSessionStore(agentSessionDbIn(this.stateDir, agentId), { ownedDirectory: true });
      try {
        for (const row of shard.rows()) {
          const seen = owners.get(row.id);
          if (seen !== undefined) {
            throw new Error(
              `Session ${row.id} exists in both ${seen.agentId}'s and ${agentId}'s store. `
              + 'Two agents cannot share a session id; move or remove one of the two `agents/<id>/sessions.db` rows before starting.',
            );
          }
          owners.set(row.id, row);
        }
      } finally {
        if (cached === undefined) {
          shard.close();
        }
      }
    }
    const indexed = new Map(this.index.rows().map((row) => [row.id, row]));
    for (const [id] of indexed) {
      if (!owners.has(id)) {
        this.index.release(id);
        report.released.push(id);
      }
    }
    for (const [id, row] of owners) {
      const claim = indexed.get(id);
      if (claim === undefined
        || claim.agentId !== row.agentId
        || claim.status !== row.status
        || claim.updatedAt !== row.updatedAt) {
        this.index.record(row);
        report.reindexed.push(id);
      }
    }
    return report;
  }

  /**
   * Which agents have a store on disk — the roster is not the answer, on
   * purpose: the gateway keeps a missing soul's sessions when it drops the
   * soul, and a recovery sweep that skipped those would strand exactly the
   * conversations nobody is watching.
   */
  private async shardedAgentIds(): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(agentsDirIn(this.stateDir), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
    const named = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => {
        try {
          // A directory whose name cannot key a path is not an agent's —
          // `agentStateDirIn` is what says so, and the reason it throws
          // rather than sanitizing.
          agentStateDirIn(this.stateDir, name);
          return true;
        } catch {
          return false;
        }
      });

    // And only the ones that already hold a shard. This sweep reads what is
    // there; opening a store *creates* the database and tightens the
    // directory around it, so treating every well-named subdirectory as an
    // agent means a start-up that writes `sessions.db` into whatever an
    // operator keeps under `agents/` — a `backups/` folder, an export — and
    // chmods it to 0700 on the way past. The old layout reserved no such
    // names, so nothing warned them. An agent with no conversations yet has
    // nothing to reconcile either, which is the same answer.
    const held: string[] = [];
    for (const name of named) {
      if (await shardFileExists(agentSessionDbIn(this.stateDir, name))) {
        held.push(name);
      }
    }
    return held;
  }

  close(): void {
    for (const shard of this.shards.values()) {
      shard.close();
    }
    this.shards.clear();
    this.index.close();
  }
}
