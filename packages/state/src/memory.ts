import { createHash, randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  assertMemoryContentWithinCap,
  boundMemoryList,
  boundMemoryRead,
  clampMemoryRecallLimit,
  compareMemoryChronology,
  tokenizeMemoryText,
  type AgentMemoryStore,
  type JsonObject,
  type MemoryAuditEntry,
  type MemoryEntry,
  type MemoryListOptions,
  type MemoryReadResult,
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

interface MemoryFileRecords {
  entries: MemoryEntry[];
  tombstones: MemoryTombstone[];
}

const isTombstoneRecord = (value: unknown): value is MemoryTombstone =>
  typeof value === 'object' && value !== null && typeof (value as MemoryTombstone).forgets === 'string'
  && typeof (value as MemoryTombstone).agentId === 'string'
  && typeof (value as MemoryTombstone).createdAt === 'string';

const isEntryRecord = (value: unknown): value is MemoryEntry =>
  typeof value === 'object' && value !== null
  && typeof (value as MemoryEntry).id === 'string'
  && typeof (value as MemoryEntry).agentId === 'string'
  && typeof (value as MemoryEntry).content === 'string'
  && typeof (value as MemoryEntry).createdAt === 'string';

/** Every record in the file, in file order — the shape the index applies. */
const parseOrderedRecords = (raw: string, filePath: string): (MemoryEntry | MemoryTombstone)[] => {
  const ordered: (MemoryEntry | MemoryTombstone)[] = [];
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
    if (!isTombstoneRecord(parsed) && !isEntryRecord(parsed)) {
      throw new Error(`Memory file has an invalid line: ${filePath}`);
    }
    ordered.push(parsed);
  }
  return ordered;
};

const parseMemoryRecords = (raw: string, filePath: string): MemoryFileRecords => {
  const entries: MemoryEntry[] = [];
  const tombstones: MemoryTombstone[] = [];
  for (const record of parseOrderedRecords(raw, filePath)) {
    if (isTombstoneRecord(record)) {
      tombstones.push(record);
    } else {
      entries.push(record);
    }
  }
  return { entries, tombstones };
};

/**
 * The live view of the record for one agent: deduped by id (first wins, as
 * `list` has always read), minus every entry a tombstone anywhere in the
 * file retires. Order-independent on purpose — a hand-edited file where a
 * tombstone precedes its entry still means the entry is forgotten.
 */
const liveEntriesFor = (records: MemoryFileRecords, agentId: string): MemoryEntry[] => {
  const forgotten = new Set(records.tombstones.map((tombstone) => tombstone.forgets));
  const seen = new Set<string>();
  return records.entries.filter((entry) => {
    if (entry.agentId !== agentId || seen.has(entry.id) || forgotten.has(entry.id)) {
      return false;
    }
    seen.add(entry.id);
    return true;
  });
};

// ---- the derived FTS5 index ------------------------------------------------

const INDEX_SCHEMA_VERSION = '1';

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
const INDEX_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS forgotten (id TEXT PRIMARY KEY);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  tokens,
  id UNINDEXED,
  agent_id UNINDEXED,
  content UNINDEXED,
  created_at UNINDEXED,
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
  db.exec('DELETE FROM memory_fts; DELETE FROM forgotten; DELETE FROM meta;');
};

/**
 * Apply one contiguous run of records. Sequential application with the
 * `forgotten` table makes the result order-independent: an entry whose
 * tombstone already passed is skipped, an entry already indexed (a rare
 * double-import the read path also dedupes) is skipped, and a tombstone
 * retires its entry whether or not it is indexed yet.
 */
const applyRecords = (db: SqliteDatabase, ordered: (MemoryEntry | MemoryTombstone)[]): void => {
  const hasEntry = db.prepare('SELECT 1 FROM memory_fts WHERE id = ?');
  const isForgotten = db.prepare('SELECT 1 FROM forgotten WHERE id = ?');
  const insertEntry = db.prepare('INSERT INTO memory_fts (tokens, id, agent_id, content, created_at) VALUES (?, ?, ?, ?, ?)');
  const insertForgotten = db.prepare('INSERT OR IGNORE INTO forgotten (id) VALUES (?)');
  const deleteEntry = db.prepare('DELETE FROM memory_fts WHERE id = ?');
  for (const record of ordered) {
    if (isTombstoneRecord(record)) {
      insertForgotten.run(record.forgets);
      deleteEntry.run(record.forgets);
      continue;
    }
    if (hasEntry.get(record.id) !== undefined || isForgotten.get(record.id) !== undefined) {
      continue;
    }
    insertEntry.run(tokenizeMemoryText(record.content).join(' '), record.id, record.agentId, record.content, record.createdAt);
  }
};

export const createFileMemoryStore = (filePath: string): AgentMemoryStore => {
  const indexPath = `${filePath}.index`;
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
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { entries: [], tombstones: [] };
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
  const needsLeadingNewline = async (): Promise<boolean> => {
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

  const appendRecord = async (record: MemoryEntry | MemoryTombstone): Promise<void> => {
    await mkdir(path.dirname(filePath), { recursive: true });
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
    await mkdir(path.dirname(indexPath), { recursive: true });
    const open = (): SqliteDatabase => {
      const opened = new DatabaseSync(indexPath);
      opened.exec('PRAGMA busy_timeout = 5000;');
      opened.exec(INDEX_SCHEMA);
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
    records: (MemoryEntry | MemoryTombstone)[];
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

  return {
    async append(agentId: string, content: string, metadata?: JsonObject) {
      assertMemoryContentWithinCap(content);
      const entry: MemoryEntry = {
        id: `${agentId}:memory:${randomUUID()}`,
        agentId,
        content,
        createdAt: new Date().toISOString(),
        ...(metadata ? { metadata } : {}),
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
        'SELECT id, agent_id, content, created_at FROM memory_fts WHERE memory_fts MATCH ? AND agent_id = ? ORDER BY created_at DESC, id ASC LIMIT ?',
      ).all(match, agentId, clamped + 1) as { id: string; agent_id: string; content: string; created_at: string }[];
      const candidates: MemoryEntry[] = rows.map((row) => ({
        id: row.id,
        agentId: row.agent_id,
        content: row.content,
        createdAt: row.created_at,
      }));
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
      const seen = new Set<string>();
      const audit: MemoryAuditEntry[] = [];
      for (const entry of records.entries) {
        if (entry.agentId !== agentId || seen.has(entry.id)) {
          continue;
        }
        seen.add(entry.id);
        const droppedAt = forgottenAt.get(entry.id);
        audit.push({ ...entry, ...(droppedAt !== undefined ? { forgottenAt: droppedAt } : {}) });
      }
      return audit.sort(compareMemoryChronology);
    },
  };
};
