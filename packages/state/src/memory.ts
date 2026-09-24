import { createHash, randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { assertDerivedStatePath } from '@stratusagent/permissions';

import {
  assertMemoryContentWithinCap,
  boundMemoryList,
  boundMemoryRead,
  clampMemoryRecallLimit,
  compareMemoryChronology,
  isTrustLevel,
  tokenizeMemoryText,
  type AgentMemoryStore,
  type JsonObject,
  type MemoryAuditEntry,
  type MemoryEntry,
  type MemoryListOptions,
  type MemoryOrigin,
  type MemoryProvenance,
  type MemoryReadResult,
  type TrustLevel,
} from '@stratusagent/core';

// Agents keep the same memory across runs: every remembered fact lands in
// ~/.stratus/memory.jsonl (keyed by agent id), so the Ava you talk to
// tomorrow — from any directory or process — is the Ava you talked to
// today. One JSON entry per line, written with O_APPEND: concurrent runs
// each add their own line instead of re-writing the file, so no run can
// clobber another's remembered fact.
//
// The JSONL is the record and stays the record. `search` is served by a
// derived FTS5 index in a sibling file (`memory.jsonl.index`) that holds
// nothing which cannot be reconstructed: deleting it repairs it, a stale
// schema stamp rebuilds it, and a hand-edited JSONL wins over whatever the
// index believed. `list`, `forget`, and `audit` read the JSONL directly, so
// only a `search` ever touches the index — or `node:sqlite` at all, which
// must stay lazily imported: the CLI's Node version check has to run before
// anything asks for the builtin that old Nodes are missing.

/**
 * A forgotten entry is tombstoned, never deleted: the JSONL is append-only
 * (that is its whole concurrency model), so `forget` appends one of these
 * referencing the entry it retires. The entry stops being live — out of
 * `list`, `search`, and therefore the prompt — but stays in the record,
 * where the audit read shows what the agent chose to drop.
 */
interface MemoryTombstone {
  forgets: string;
  agentId: string;
  createdAt: string;
}

/**
 * An operator's re-assertion of an entry's trust — the third record type in
 * the lane, and the only way a label ever rises. A record rather than a
 * field write for the same reason a tombstone is: the file is append-only,
 * and rewriting a line would race every other writer. The latest
 * re-assertion in file order is the one that stands.
 */
interface MemoryReassertion {
  reasserts: string;
  agentId: string;
  trust: TrustLevel;
  createdAt: string;
}

type MemoryRecord = MemoryEntry | MemoryTombstone | MemoryReassertion;

interface MemoryFileRecords {
  entries: MemoryEntry[];
  tombstones: MemoryTombstone[];
  reassertions: MemoryReassertion[];
}

const isTombstoneRecord = (value: unknown): value is MemoryTombstone =>
  typeof value === 'object' && value !== null && typeof (value as MemoryTombstone).forgets === 'string'
  && typeof (value as MemoryTombstone).agentId === 'string'
  && typeof (value as MemoryTombstone).createdAt === 'string';

const isReassertionRecord = (value: unknown): value is MemoryReassertion =>
  typeof value === 'object' && value !== null && typeof (value as MemoryReassertion).reasserts === 'string'
  && typeof (value as MemoryReassertion).agentId === 'string'
  && isTrustLevel((value as MemoryReassertion).trust)
  && typeof (value as MemoryReassertion).createdAt === 'string';

// Exactly the four fields, still: a hand-added line carrying only these
// loads, is recallable, and reaches the prompt. `trust` and `origin` are
// additive — a line without them reads as `unknown`, which is what a line
// nobody labelled is.
const isEntryRecord = (value: unknown): value is MemoryEntry =>
  typeof value === 'object' && value !== null
  && typeof (value as MemoryEntry).id === 'string'
  && typeof (value as MemoryEntry).agentId === 'string'
  && typeof (value as MemoryEntry).content === 'string'
  && typeof (value as MemoryEntry).createdAt === 'string';

/**
 * An entry's optional provenance fields, as they are safe to read back: a
 * `trust` that is present but not a level — a hand edit, a label from a
 * newer build — reads as a *recorded* `unknown`, never as the misspelling
 * and never as absent: absence is the upgrade corpus that `stratus memory
 * reassert --all-unknown` sweeps, and a label somebody wrote is not that.
 * `origin` keeps only its two known string fields.
 */
const provenanceOf = (entry: MemoryEntry): Pick<MemoryEntry, 'trust' | 'origin'> => {
  const raw = entry as MemoryEntry & { trust?: unknown; origin?: unknown };
  const trust: TrustLevel | undefined = raw.trust === undefined ? undefined : isTrustLevel(raw.trust) ? raw.trust : 'unknown';
  let origin: MemoryOrigin | undefined;
  if (typeof raw.origin === 'object' && raw.origin !== null && !Array.isArray(raw.origin)) {
    const source = raw.origin as Record<string, unknown>;
    origin = {
      ...(typeof source.sessionId === 'string' ? { sessionId: source.sessionId } : {}),
      ...(typeof source.taintedBy === 'string' ? { taintedBy: source.taintedBy } : {}),
    };
  }
  return {
    ...(trust !== undefined ? { trust } : {}),
    ...(origin !== undefined ? { origin } : {}),
  };
};

/** Every record in the file, in file order — the shape the index applies. */
const parseOrderedRecords = (raw: string, filePath: string): MemoryRecord[] => {
  const ordered: MemoryRecord[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`Memory file has an invalid line: ${filePath}`);
    }
    // Shape-checked, not only parsed: hand-added JSON that is not a
    // well-formed record would otherwise surface later as a TypeError in a
    // read or an undefined bound into the index — errors that never name
    // the file the way this one does.
    if (!isTombstoneRecord(parsed) && !isReassertionRecord(parsed) && !isEntryRecord(parsed)) {
      throw new Error(`Memory file has an invalid line: ${filePath}`);
    }
    ordered.push(parsed);
  }
  return ordered;
};

const parseMemoryRecords = (raw: string, filePath: string): MemoryFileRecords => {
  const entries: MemoryEntry[] = [];
  const tombstones: MemoryTombstone[] = [];
  const reassertions: MemoryReassertion[] = [];
  for (const record of parseOrderedRecords(raw, filePath)) {
    if (isTombstoneRecord(record)) {
      tombstones.push(record);
    } else if (isReassertionRecord(record)) {
      reassertions.push(record);
    } else {
      entries.push(record);
    }
  }
  return { entries, tombstones, reassertions };
};

/**
 * The trust each re-asserted entry now carries: the one it was given last,
 * by `createdAt` rather than by position in the file.
 *
 * File order was the rule while one append-only file had one writer
 * discipline — every append landed after every earlier one, so the last
 * line was the latest intent. The per-agent move broke that: the drain
 * copies lines from the shared file into an agent's own, so a re-assertion
 * an operator made *after* the copy read the source can be followed by that
 * older line landing on top of it. Entries and tombstones survive a
 * duplicate because they are set membership; a re-assertion is a value, and
 * last-one-wins over a reordered file answers with the label the operator
 * replaced. Reading by recorded time makes a duplicate harmless again,
 * which is what the drain's "copy until it converges" already assumes.
 *
 * Unparseable or equal timestamps fall back to file order, so a
 * hand-written line with no real clock behaves exactly as it used to.
 * Scoped to the entry's own agent — a re-assertion naming another agent's
 * entry is inert, so the per-agent boundary the store rests on is not
 * breached by a record in a shared file.
 */
const recordedAt = (value: string): number | undefined => {
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : at;
};

const notOlderThan = (candidate: string, current: string): boolean => {
  const at = recordedAt(candidate);
  const against = recordedAt(current);
  return at === undefined || against === undefined ? true : at >= against;
};

const reassertedTrustFor = (records: MemoryFileRecords, agentId: string): Map<string, TrustLevel> => {
  const latest = new Map<string, MemoryReassertion>();
  for (const record of records.reassertions) {
    if (record.agentId !== agentId) {
      continue;
    }
    const current = latest.get(record.reasserts);
    if (current === undefined || notOlderThan(record.createdAt, current.createdAt)) {
      latest.set(record.reasserts, record);
    }
  }
  return new Map([...latest].map(([id, record]) => [id, record.trust]));
};

/** An entry as read back: provenance fields validated, any re-assertion applied. */
const presentEntry = (entry: MemoryEntry, reasserted: Map<string, TrustLevel>): MemoryEntry => {
  const { trust: _trust, origin: _origin, ...rest } = entry;
  const provenance = provenanceOf(entry);
  const reassertedTrust = reasserted.get(entry.id);
  return {
    ...rest,
    ...provenance,
    ...(reassertedTrust !== undefined ? { trust: reassertedTrust } : {}),
  };
};

/**
 * The live view of the record for one agent: deduped by id (first wins, as
 * `list` has always read), minus every entry a tombstone anywhere in the
 * file retires. Order-independent on purpose — a hand-edited file where a
 * tombstone precedes its entry still means the entry is forgotten.
 */
const liveEntriesFor = (records: MemoryFileRecords, agentId: string): MemoryEntry[] => {
  const forgotten = new Set(records.tombstones.map((tombstone) => tombstone.forgets));
  const reasserted = reassertedTrustFor(records, agentId);
  const seen = new Set<string>();
  const live: MemoryEntry[] = [];
  for (const entry of records.entries) {
    if (entry.agentId !== agentId || seen.has(entry.id) || forgotten.has(entry.id)) {
      continue;
    }
    seen.add(entry.id);
    live.push(presentEntry(entry, reasserted));
  }
  return live;
};

// ---- the derived FTS5 index ------------------------------------------------

// Bumped when the row shape changes: an index stamped with an older version
// is rebuilt from the record, which is the only cost a derived file has.
// '2' added `trust` and `origin` columns and the `reasserted` table.
const INDEX_SCHEMA_VERSION = '3';

// Loaded on first `search`, never at module load: see the note at the top.
type SqliteModule = typeof import('node:sqlite');
let sqliteModule: Promise<SqliteModule> | undefined;
const loadSqlite = (): Promise<SqliteModule> => {
  sqliteModule ??= import('node:sqlite');
  return sqliteModule;
};

type SqliteDatabase = InstanceType<SqliteModule['DatabaseSync']>;

// `remove_diacritics 0`: the in-memory implementation does not fold
// diacritics, so the index must not either — `café` and `cafe` are
// different words in both stores or the two implementations diverge.
// Only `tokens` is searchable; it holds the content re-tokenized by the
// shared tokenizer, so FTS5 sees exactly the token stream the in-memory
// store matches on rather than applying its own boundaries to raw text.
// `trust` and `origin` ride along unindexed so a search hit carries its
// label without a second read of the JSONL; `reasserted` mirrors
// `forgotten` for the record type that changes a label after the fact.
const INDEX_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS forgotten (id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS reasserted (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, trust TEXT NOT NULL, recorded_at INTEGER);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  tokens,
  id UNINDEXED,
  agent_id UNINDEXED,
  content UNINDEXED,
  created_at UNINDEXED,
  trust UNINDEXED,
  origin UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 0'
);
`;

interface IndexWatermark {
  /**
   * The byte offset the indexer actually consumed — never a fresh `stat`
   * after indexing. A second process can append while this one indexes;
   * recording the size found afterwards would claim bytes never read, and
   * every later open would trust the claim. With size ≡ consumed offset,
   * a concurrent append just leaves the file larger than the watermark and
   * the next search indexes the tail.
   */
  offset: number;
  /** SHA-256 of the consumed prefix — what catches an in-place edit an offset check passes. */
  digest: string;
  inode: string;
  mtimeMs: string;
}

const digestOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const readWatermark = (db: SqliteDatabase): IndexWatermark & { schema: string | undefined } => {
  const rows = db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[];
  const meta = new Map(rows.map((row) => [row.key, row.value]));
  return {
    schema: meta.get('schema_version'),
    offset: Number(meta.get('offset') ?? '0'),
    digest: meta.get('digest') ?? digestOf(new Uint8Array(0)),
    inode: meta.get('inode') ?? '',
    mtimeMs: meta.get('mtime_ms') ?? '',
  };
};

const writeWatermark = (db: SqliteDatabase, watermark: IndexWatermark): void => {
  const upsert = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  upsert.run('schema_version', INDEX_SCHEMA_VERSION);
  upsert.run('offset', String(watermark.offset));
  upsert.run('digest', watermark.digest);
  upsert.run('inode', watermark.inode);
  upsert.run('mtime_ms', watermark.mtimeMs);
};

const clearIndex = (db: SqliteDatabase): void => {
  db.exec('DELETE FROM memory_fts; DELETE FROM forgotten; DELETE FROM reasserted; DELETE FROM meta;');
};

/**
 * Apply one contiguous run of records. Sequential application with the
 * `forgotten` and `reasserted` tables makes the result order-independent:
 * an entry whose tombstone already passed is skipped, an entry already
 * indexed (a rare double-import the read path also dedupes) is skipped, a
 * tombstone retires its entry whether or not it is indexed yet, and a
 * re-assertion re-labels its entry whether it arrives before or after it.
 */
const applyRecords = (db: SqliteDatabase, ordered: MemoryRecord[]): void => {
  const hasEntry = db.prepare('SELECT 1 FROM memory_fts WHERE id = ?');
  const isForgotten = db.prepare('SELECT 1 FROM forgotten WHERE id = ?');
  const reassertedFor = db.prepare('SELECT trust FROM reasserted WHERE id = ? AND agent_id = ?');
  const insertEntry = db.prepare(
    'INSERT INTO memory_fts (tokens, id, agent_id, content, created_at, trust, origin) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const insertForgotten = db.prepare('INSERT OR IGNORE INTO forgotten (id) VALUES (?)');
  // The rule `notOlderThan` reads the file by, applied here too because
  // this index is incremental and cannot re-sort what it has already
  // applied: a re-assertion *older* than the one recorded must not take the
  // label back, however late in the file it arrives.
  //
  // The column holds `recordedAt`'s answer — the instant, already parsed by
  // the same function the file reader uses — rather than the timestamp
  // text. SQL date functions are a second parser with its own precision
  // (`unixepoch` truncates to the second, so two re-assertions made in the
  // same second compared equal and `list` disagreed with `search`), and one
  // rule read two ways is the defect this pair keeps producing. A NULL is a
  // timestamp neither reader can parse, which falls through to "the later
  // record wins" — the file order this read by before.
  const upsertReasserted = db.prepare(
    'INSERT INTO reasserted (id, agent_id, trust, recorded_at) VALUES (?, ?, ?, ?) '
    + 'ON CONFLICT(id) DO UPDATE SET agent_id = excluded.agent_id, trust = excluded.trust, recorded_at = excluded.recorded_at '
    + 'WHERE excluded.recorded_at IS NULL OR reasserted.recorded_at IS NULL '
    + 'OR excluded.recorded_at >= reasserted.recorded_at',
  );
  const relabelEntry = db.prepare('UPDATE memory_fts SET trust = ? WHERE id = ? AND agent_id = ?');
  const deleteEntry = db.prepare('DELETE FROM memory_fts WHERE id = ?');
  for (const record of ordered) {
    if (isTombstoneRecord(record)) {
      insertForgotten.run(record.forgets);
      deleteEntry.run(record.forgets);
      continue;
    }
    if (isReassertionRecord(record)) {
      upsertReasserted.run(record.reasserts, record.agentId, record.trust, recordedAt(record.createdAt) ?? null);
      // The label that won, which is not always this record's — see the
      // upsert above. Relabelling with this one unconditionally would let
      // an older re-assertion overwrite the entry it just lost to.
      const winner = reassertedFor.get(record.reasserts, record.agentId) as { trust: string } | undefined;
      if (winner !== undefined) {
        relabelEntry.run(winner.trust, record.reasserts, record.agentId);
      }
      continue;
    }
    if (hasEntry.get(record.id) !== undefined || isForgotten.get(record.id) !== undefined) {
      continue;
    }
    const provenance = provenanceOf(record);
    const reasserted = reassertedFor.get(record.id, record.agentId) as { trust: string } | undefined;
    const trust = reasserted?.trust ?? provenance.trust ?? null;
    insertEntry.run(
      tokenizeMemoryText(record.content).join(' '),
      record.id,
      record.agentId,
      record.content,
      record.createdAt,
      trust,
      provenance.origin ? JSON.stringify(provenance.origin) : null,
    );
  }
};

export interface FileMemoryStoreOptions {
  /**
   * Whether the file's directory is dedicated Stratus state and may be
   * created and tightened to owner-only.
   *
   * Left out by default, and for the reason the session store gives: a
   * caller-supplied path can sit in a shared parent — a project directory,
   * `/tmp` in a test — and a store must never chmod one of those out from
   * under whoever else uses it. Given for `agents/<id>/`, which is one
   * agent's own directory and is `0700` by contract; without it the first
   * write for an agent whose directory does not exist yet creates it under
   * the umask, so a home where memory happened before sessions had its
   * per-agent directory world-readable.
   *
   * The home rather than a boolean, so the same value says which components
   * are Stratus's to insist are real — see `assertDerivedStatePath`.
   */
  stateHome?: string;
}

/**
 * Whether an append to `filePath` has to start with a newline of its own.
 *
 * A JSONL file whose last byte is not a newline — a torn write, a
 * hand-edit, a process killed mid-append — fuses the next appended record
 * onto the last one and makes a line that is not JSON, which takes the
 * agent's *whole* memory file out of every list, search and audit until
 * someone repairs it. Prefixing a newline when the last byte needs one
 * keeps the record parseable, and if a concurrent append lands in between,
 * the false-positive prefix is only a blank line, which every reader skips.
 *
 * Exported because three writers append to these files and only one of them
 * is the store: the layout migration places the shared file's records
 * directly, and the cwd importer does the same for a project-local one.
 * Both wrote a bare `\n`-joined block, so either could be the append that
 * fuses — and a migration that corrupts the file it is rescuing is the
 * worst version of this bug.
 */
export const memoryAppendNeedsNewline = async (filePath: string): Promise<boolean> => {
  let handle;
  try {
    handle = await open(filePath, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) {
      return false;
    }
    const lastByte = new Uint8Array(1);
    await handle.read(lastByte, 0, 1, size - 1);
    return lastByte[0] !== 0x0a;
  } finally {
    await handle.close();
  }
};

export const createFileMemoryStore = (
  filePath: string,
  options: FileMemoryStoreOptions = {},
): AgentMemoryStore => {
  const indexPath = `${filePath}.index`;
  /**
   * The directory and the two files under it are this agent's own, never
   * links to somewhere else.
   *
   * Its own function rather than the opening of `ensureDirectory`, because
   * the reads never go through that one: `list` and `audit` call
   * `readRecords` directly. A guard on the write path alone is a store that
   * refuses to *place* a memory through a link while answering happily with
   * whatever is on the far side of one — another agent's memories, or a
   * file outside the home entirely. Which paths are this agent's is the
   * same question in both directions, so it is asked in both.
   *
   * Refused rather than quarantined, like the session store and for the
   * same reason: a memory this agent was told it had remembered must not
   * live through a link somewhere else, and the chmod in `ensureDirectory`
   * would tighten whatever it points at. A real directory says nothing
   * about the files in it — a linked `memory.jsonl` puts the whole history
   * outside the home, and a linked `.index` hands SQLite an external
   * database to open, write and chmod.
   */
  const assertOwnedPaths = async (): Promise<void> => {
    const home = options.stateHome;
    if (home === undefined) {
      return;
    }
    // See `assertDerivedStatePath`, which owns the rule itself — including
    // the components above these two, which a link at any one of redirects
    // just as completely as a link at the file.
    for (const candidate of [filePath, indexPath]) {
      await assertDerivedStatePath(home, candidate, 'file');
    }
  };

  /** The directory, made and held to the posture its owner asked for. */
  const ensureDirectory = async (): Promise<void> => {
    const dir = path.dirname(filePath);
    await assertOwnedPaths();
    await mkdir(dir, { recursive: true, ...(options.stateHome !== undefined ? { mode: 0o700 } : {}) });
    if (options.stateHome !== undefined) {
      // `mkdir` only applies its mode when it creates, so an upgrade over a
      // directory an earlier build left at 0755 would keep it.
      await chmod(dir, 0o700);
    }
  };
  let db: SqliteDatabase | undefined;

  // The IMMEDIATE transaction serializes catch-up across processes, but not
  // across concurrent calls inside one process — those share a connection,
  // where a second BEGIN is an error, not a wait. One catch-up at a time;
  // the searches themselves are plain reads and need no serializing.
  let indexLock: Promise<void> = Promise.resolve();
  const withIndexLock = <T>(work: () => Promise<T>): Promise<T> => {
    const run = indexLock.then(work, work);
    indexLock = run.then(() => undefined, () => undefined);
    return run;
  };

  const readRecords = async (): Promise<MemoryFileRecords> => {
    await assertOwnedPaths();
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { entries: [], tombstones: [], reassertions: [] };
      }
      throw error;
    }
    return parseMemoryRecords(raw, filePath);
  };

  // Long-term memory is conversation content — owner-only, like the
  // credentials and session files. A file created earlier under a looser
  // umask is tightened BEFORE new content lands in it; the mode option
  // covers fresh creation.
  // A hand-edited file may end without a newline; appending straight after
  // that would fuse two records into one invalid line and break every read
  // until someone repairs the file. Prefixing a newline when the last byte
  // needs one keeps the record parseable — and if a concurrent append lands
  // in between, the false-positive prefix is only a blank line, which every
  // reader skips.
  const needsLeadingNewline = (): Promise<boolean> => memoryAppendNeedsNewline(filePath);

  const appendRecord = async (record: MemoryRecord): Promise<void> => {
    await ensureDirectory();
    try {
      await chmod(filePath, 0o600);
    } catch (error) {
      // Only a missing file is fine (the append below creates it
      // owner-only). Any other failure means the file EXISTS but cannot
      // be tightened — never write conversation content into a file
      // that stays readable by others.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    const prefix = (await needsLeadingNewline()) ? '\n' : '';
    await appendFile(filePath, `${prefix}${JSON.stringify(record)}\n`, { mode: 0o600 });
  };

  const openIndex = async (): Promise<SqliteDatabase> => {
    if (db !== undefined) {
      return db;
    }
    const { DatabaseSync } = await loadSqlite();
    await ensureDirectory();
    const open = (): SqliteDatabase => {
      const opened = new DatabaseSync(indexPath);
      opened.exec('PRAGMA busy_timeout = 5000;');
      opened.exec(INDEX_SCHEMA);
      // `CREATE ... IF NOT EXISTS` leaves an older install's table standing
      // with its older columns, and the stale-stamp path below only empties
      // rows — so the first insert after an upgrade would fail on a column
      // the table does not have. Judged by the table's actual shape rather
      // than by the stamp, because an index created and never caught up
      // has the old shape and no stamp at all. Dropping everything makes
      // the next catch-up a full rebuild from the record, which is the
      // only cost a derived file can have.
      // Every column a later schema added, not just the first one: this
      // check is the *only* thing that rebuilds a table, and a new column
      // it does not name is an upgrade that empties the rows and then fails
      // on the first insert — which is this comment's own failure, missed
      // once already when `reasserted` grew a column and only `memory_fts`
      // was asked about.
      const hasColumn = (table: string, column: string): boolean =>
        (opened.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
          .some((found) => found.name === column);
      const hasCurrentShape = (): boolean =>
        hasColumn('memory_fts', 'trust') && hasColumn('reasserted', 'recorded_at');
      if (!hasCurrentShape()) {
        // Under the same write lock catch-up takes, and re-checked once it
        // is held: the daemon and a `stratus run` opening an upgraded
        // index at the same moment both see the old shape, and without the
        // lock the second's drops would empty the tables the first had
        // just rebuilt. With it, the second waits, looks again, and finds
        // nothing to do.
        opened.exec('BEGIN IMMEDIATE;');
        try {
          if (!hasCurrentShape()) {
            opened.exec('DROP TABLE memory_fts; DROP TABLE forgotten; DROP TABLE reasserted; DROP TABLE meta;');
            opened.exec(INDEX_SCHEMA);
          }
          opened.exec('COMMIT;');
        } catch (error) {
          try {
            opened.exec('ROLLBACK;');
          } catch {
            // The transaction may never have started; the original error
            // is the one worth reporting.
          }
          throw error;
        }
      }
      return opened;
    };
    try {
      db = open();
    } catch {
      // A corrupt index is repaired by deleting it — being derived means
      // that costs a rebuild, never data.
      await rm(indexPath, { force: true });
      await rm(`${indexPath}-journal`, { force: true });
      await rm(`${indexPath}-wal`, { force: true });
      await rm(`${indexPath}-shm`, { force: true });
      db = open();
    }
    // The index carries the same conversation content as the JSONL, so the
    // same owner-only rule applies, upgrade-over-looser-install included.
    await chmod(indexPath, 0o600);
    return db;
  };

  interface CatchUpPlan {
    /** 'none' — the index already matches the record; nothing to write. */
    action: 'none' | 'apply';
    /** Drop every row first (schema change, edit, shrink, replaced file). */
    clear: boolean;
    records: MemoryRecord[];
    watermark: IndexWatermark;
  }

  const emptyWatermark = (): IndexWatermark =>
    ({ offset: 0, digest: digestOf(new Uint8Array(0)), inode: '', mtimeMs: '' });

  const sameWatermark = (a: IndexWatermark & { schema?: string | undefined }, b: IndexWatermark & { schema?: string | undefined }): boolean =>
    a.offset === b.offset && a.digest === b.digest && a.inode === b.inode
    && a.mtimeMs === b.mtimeMs && a.schema === b.schema;

  /**
   * Decide what would bring the index up to date with the record, given the
   * watermark `snapshot` — all file I/O, digesting, and parsing, none of it
   * holding the database lock.
   *
   * - inode, mtime, and size (≡ recorded consumed offset) all match →
   *   nothing happened; O(1), no work.
   * - File grew and the prefix digest matches → a pure append, whoever
   *   wrote it; index the tail.
   * - Anything else — shrunk, edited in place, replaced, a stale schema
   *   stamp — → full rebuild. The failure direction is rebuild, never trust.
   */
  const planCatchUp = async (snapshot: IndexWatermark & { schema?: string | undefined }): Promise<CatchUpPlan> => {
    // A stamp from another schema is a rebuild trigger, not an error.
    const schemaStale = snapshot.schema !== undefined && snapshot.schema !== INDEX_SCHEMA_VERSION;
    const base = schemaStale ? emptyWatermark() : snapshot;

    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      if (sameWatermark(snapshot, { ...emptyWatermark(), schema: INDEX_SCHEMA_VERSION })) {
        return { action: 'none', clear: false, records: [], watermark: emptyWatermark() };
      }
      return { action: 'apply', clear: schemaStale || base.offset !== 0, records: [], watermark: emptyWatermark() };
    }

    if (
      snapshot.schema === INDEX_SCHEMA_VERSION
      && String(fileStat.ino) === base.inode
      && fileStat.size === base.offset
      && String(fileStat.mtimeMs) === base.mtimeMs
    ) {
      return { action: 'none', clear: false, records: [], watermark: base };
    }

    const buffer = await readFile(filePath);
    // Only complete lines are consumed: a line still being appended by
    // another process stays past the watermark until it has its newline,
    // instead of being half-read and then trusted forever.
    const lastNewline = buffer.lastIndexOf(0x0a);
    const consumedEnd = lastNewline === -1 ? 0 : lastNewline + 1;

    const sameFile = String(fileStat.ino) === base.inode || base.inode === '';
    const pureAppend = sameFile
      && consumedEnd >= base.offset
      && digestOf(buffer.subarray(0, base.offset)) === base.digest;

    const from = pureAppend ? base.offset : 0;
    const records = parseOrderedRecords(buffer.subarray(from, consumedEnd).toString('utf8'), filePath);
    return {
      action: 'apply',
      clear: schemaStale || !pureAppend,
      records,
      watermark: {
        offset: consumedEnd,
        digest: digestOf(buffer.subarray(0, consumedEnd)),
        inode: String(fileStat.ino),
        mtimeMs: String(fileStat.mtimeMs),
      },
    };
  };

  /**
   * Bring the index up to date with the record before a search reads it.
   *
   * Planned optimistically outside the transaction — the full-file read and
   * digest of a large record must not hold the write lock long enough for a
   * peer process's own catch-up to hit its busy timeout — then committed
   * under BEGIN IMMEDIATE only if the watermark is still the one the plan
   * was made against. A lost race means the peer indexed meanwhile: re-plan
   * against its watermark, which is usually 'none'. The last attempt
   * re-plans while holding the lock, so contention can delay a catch-up but
   * never starve it.
   */
  const ensureIndexCurrent = async (database: SqliteDatabase): Promise<void> => {
    const OPTIMISTIC_ATTEMPTS = 3;
    for (let attempt = 0; ; attempt += 1) {
      const snapshot = readWatermark(database);
      const plan = await planCatchUp(snapshot);
      if (plan.action === 'none') {
        return;
      }
      database.exec('BEGIN IMMEDIATE;');
      try {
        const current = readWatermark(database);
        const raced = !sameWatermark(current, snapshot);
        if (raced && attempt < OPTIMISTIC_ATTEMPTS) {
          database.exec('ROLLBACK;');
          continue;
        }
        const finalPlan = raced ? await planCatchUp(current) : plan;
        if (finalPlan.action === 'apply') {
          if (finalPlan.clear) {
            clearIndex(database);
          }
          applyRecords(database, finalPlan.records);
          writeWatermark(database, finalPlan.watermark);
        }
        database.exec('COMMIT;');
        return;
      } catch (error) {
        try {
          database.exec('ROLLBACK;');
        } catch {
          // The transaction may never have started or already died; the
          // original error is the one worth reporting.
        }
        throw error;
      }
    }
  };

  const parseOrigin = (raw: string | null): MemoryOrigin | undefined => {
    if (raw === null) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      return provenanceOf({ id: '', agentId: '', content: '', createdAt: '', origin: parsed } as MemoryEntry).origin;
    } catch {
      return undefined;
    }
  };

  return {
    async append(agentId: string, content: string, metadata?: JsonObject, provenance?: MemoryProvenance) {
      assertMemoryContentWithinCap(content);
      const entry: MemoryEntry = {
        id: `${agentId}:memory:${randomUUID()}`,
        agentId,
        content,
        createdAt: new Date().toISOString(),
        ...(metadata ? { metadata } : {}),
        ...(provenance ? { trust: provenance.trust } : {}),
        ...(provenance?.origin ? { origin: provenance.origin } : {}),
      };
      await appendRecord(entry);
      return entry;
    },

    async list(agentId: string, options: MemoryListOptions = {}) {
      const live = liveEntriesFor(await readRecords(), agentId);
      if (options.limit === undefined) {
        return { entries: live.sort(compareMemoryChronology), truncated: false };
      }
      // The bound applies after the tombstone filter — a store whose recent
      // entries are mostly forgotten still fills its slice with live ones.
      return boundMemoryList(live, options.limit);
    },

    async search(agentId: string, query: string, limit?: number): Promise<MemoryReadResult> {
      // The query means its literal text: tokenize and quote each term
      // rather than forwarding the string, so `C++`, an unmatched quote,
      // and a sentence containing AND are searches, never syntax errors.
      const tokens = tokenizeMemoryText(query);
      if (tokens.length === 0) {
        return { entries: [], truncated: false };
      }
      const database = await withIndexLock(async () => {
        const opened = await openIndex();
        await ensureIndexCurrent(opened);
        return opened;
      });
      const clamped = clampMemoryRecallLimit(limit);
      const match = tokens.map((token) => `"${token}"`).join(' ');
      const rows = database.prepare(
        'SELECT id, agent_id, content, created_at, trust, origin FROM memory_fts WHERE memory_fts MATCH ? AND agent_id = ? ORDER BY created_at DESC, id ASC LIMIT ?',
      ).all(match, agentId, clamped + 1) as {
        id: string;
        agent_id: string;
        content: string;
        created_at: string;
        trust: string | null;
        origin: string | null;
      }[];
      const candidates: MemoryEntry[] = rows.map((row) => {
        const origin = parseOrigin(row.origin);
        return {
          id: row.id,
          agentId: row.agent_id,
          content: row.content,
          createdAt: row.created_at,
          ...(isTrustLevel(row.trust) ? { trust: row.trust } : {}),
          ...(origin !== undefined ? { origin } : {}),
        };
      });
      return boundMemoryRead(candidates, clamped);
    },

    async forget(agentId: string, entryId: string) {
      const live = liveEntriesFor(await readRecords(), agentId);
      const entry = live.find((candidate) => candidate.id === entryId);
      if (!entry) {
        return false;
      }
      await appendRecord({ forgets: entry.id, agentId: entry.agentId, createdAt: new Date().toISOString() });
      return true;
    },

    async audit(agentId: string) {
      const records = await readRecords();
      const forgottenAt = new Map<string, string>();
      for (const tombstone of records.tombstones) {
        if (!forgottenAt.has(tombstone.forgets)) {
          forgottenAt.set(tombstone.forgets, tombstone.createdAt);
        }
      }
      const reasserted = reassertedTrustFor(records, agentId);
      const seen = new Set<string>();
      const audit: MemoryAuditEntry[] = [];
      for (const entry of records.entries) {
        if (entry.agentId !== agentId || seen.has(entry.id)) {
          continue;
        }
        seen.add(entry.id);
        const droppedAt = forgottenAt.get(entry.id);
        audit.push({ ...presentEntry(entry, reasserted), ...(droppedAt !== undefined ? { forgottenAt: droppedAt } : {}) });
      }
      return audit.sort(compareMemoryChronology);
    },

    async reassertTrust(agentId: string, entryId: string, trust: TrustLevel) {
      // Resolved from the caller's own live set first, like `forget`: the
      // record lane is shared, and a writer that skipped this would let one
      // agent's operator surface re-label another agent's memory by id.
      const live = liveEntriesFor(await readRecords(), agentId);
      const entry = live.find((candidate) => candidate.id === entryId);
      if (!entry) {
        return false;
      }
      await appendRecord({ reasserts: entry.id, agentId: entry.agentId, trust, createdAt: new Date().toISOString() });
      return true;
    },
  };
};

/**
 * The same file store, one file per agent — `agents/<id>/memory.jsonl`
 * rather than one `memory.jsonl` every agent's lines share.
 *
 * The routing is the isolation. Every method already takes the agent id, so
 * the shared file was never how an agent's memories were *found*; it was
 * only what made a mis-keyed read possible in the first place — a line whose
 * `agentId` was wrong (a hand edit, a future bug) was another agent's
 * memory sitting in the same file as yours. On its own path there is no
 * such line to filter out.
 *
 * One store per agent, cached for the life of the process, because the
 * store each one wraps holds a lazily-opened index connection: rebuilding
 * it per call would re-open and re-verify the FTS index on every search.
 * A roster is tens of agents, not thousands — and an id that never
 * appears costs nothing, since the file store touches no disk until it is
 * asked something.
 */
export const createShardedFileMemoryStore = (
  fileFor: (agentId: string) => string,
  stateHome: string,
): AgentMemoryStore => {
  const stores = new Map<string, AgentMemoryStore>();
  const storeFor = (agentId: string): AgentMemoryStore => {
    const existing = stores.get(agentId);
    if (existing !== undefined) {
      return existing;
    }
    // `fileFor` is what asserts the id can key a path — see
    // `assertPathSafeAgentId`. Throwing from here rather than returning an
    // empty store is deliberate: an unsafe id must not read as "this agent
    // remembers nothing".
    // The agent's own directory, owner-only like every other per-agent
    // resource — see `FileMemoryStoreOptions.stateHome`.
    const store = createFileMemoryStore(fileFor(agentId), { stateHome });
    stores.set(agentId, store);
    return store;
  };
  return {
    append: (agentId, content, metadata, provenance) => storeFor(agentId).append(agentId, content, metadata, provenance),
    list: (agentId, options) => storeFor(agentId).list(agentId, options),
    search: (agentId, query, limit) => storeFor(agentId).search(agentId, query, limit),
    forget: (agentId, entryId) => storeFor(agentId).forget(agentId, entryId),
    audit: (agentId) => storeFor(agentId).audit(agentId),
    async reassertTrust(agentId, entryId, trust) {
      const store = storeFor(agentId);
      // The file store always re-asserts; the guard is for the type, since
      // the method is optional on the interface.
      return store.reassertTrust ? store.reassertTrust(agentId, entryId, trust) : false;
    },
  };
};
