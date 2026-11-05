/*
 * How a ranked `search` orders its hits, and the derived FTS5 index that
 * serves it: the schema and its version stamp, the watermark that says
 * which bytes of the JSONL the index has seen, and how parsed records are
 * replayed into its rows. Nothing here is the record (see the note at the
 * top of `memory.ts`), and `node:sqlite` is still imported lazily, on the
 * first search, never when this module loads.
 */
import { createHash } from 'node:crypto';

import { memoryEntryFields, memoryEntryTokens, memorySupersededIds } from '@stratusagent/core';

import {
  isPinRecord,
  isReassertionRecord,
  isTombstoneRecord,
  type MemoryRecord,
  provenanceOf,
  recordedAt,
} from './memory-records.ts';

// ---- ranking ----------------------------------------------------------------

/**
 * How much a brand-new fact's relevance is multiplied by under `hybrid`,
 * and how fast that boost fades: 1.5x today, 1.25x at 30 days, 1.125x at
 * 90, approaching 1x for old facts. Multiplying rather than adding keeps
 * it independent of BM25's scale, and bounds what recency can do: a fact
 * passes an older one only if it is at least two thirds as relevant, and
 * between two that match about equally well the newer one wins.
 */
const HYBRID_RECENCY_BOOST = 0.5;
const HYBRID_RECENCY_HALF_LIFE_DAYS = 30;

const MS_PER_DAY = 86_400_000;
/** The Julian day of the Unix epoch, which is how SQLite's `julianday` counts. */
const UNIX_EPOCH_JULIAN_DAY = 2_440_587.5;

/**
 * The leading `ORDER BY` terms for a ranked search; the caller appends the
 * recency tie-break every read shares. `everyWord` is the query as an
 * all-words match.
 *
 * Facts holding every word come first, then the rest. BM25 alone can't
 * promise that: it discounts a word by the length of the fact around it,
 * so a near-cap fact with both words scores below a short one with only
 * one, and enough short ones would fill the limit and leave it out. Only
 * the all-words tier is lifted, not every extra word: a query written like
 * a sentence shares "the" and "is" with most long facts, and BM25's weight
 * for a word by its rarity is what keeps those from counting.
 *
 * `bm25()` is FTS5's relevance score, lower for a better match, so both
 * orders sort it ascending. A `createdAt` SQLite cannot read as a date (a
 * hand edit) gets no boost at all, so it ranks like the oldest fact rather
 * than, through a NULL, like the newest. One from the future (a skewed
 * clock) counts as today.
 */
export const rankedOrder = (
  strategy: 'relevance' | 'hybrid',
  everyWord: string,
  at: number,
): { sql: string; params: (string | number)[] } => {
  const tier = 'rowid IN (SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?) DESC, ';
  if (strategy === 'relevance') {
    return { sql: `${tier}bm25(memory_fts) ASC, `, params: [everyWord] };
  }
  const today = at / MS_PER_DAY + UNIX_EPOCH_JULIAN_DAY;
  return {
    sql: `${tier}bm25(memory_fts) * (1.0 + ? * coalesce(1.0 / (1.0 + max(0.0, ? - julianday(created_at)) / ?), 0.0)) ASC, `,
    params: [everyWord, HYBRID_RECENCY_BOOST, today, HYBRID_RECENCY_HALF_LIFE_DAYS],
  };
};

// ---- the derived FTS5 index ------------------------------------------------

// Bumped when the row shape changes: an index stamped with an older version
// is rebuilt from the record, which is the only cost a derived file has.
// '2' added `trust` and `origin` columns and the `reasserted` table.
// '3' added `recorded_at` to `reasserted`, so the label a re-assertion wins
// is decided by recorded time rather than by position in a file the
// per-agent drain can reorder.
// '4' added the `about`/`kind`/validity columns, tokenized `about` into the
// searchable column, agent-scoped `forgotten`, the `revisions` table
// supersession is computed from, and the `usage` counters.
// '5' keyed `revisions` by (successor, agent): import preserves entry ids
// while re-keying them to the importing agent, so one corpus imported for
// two agents legitimately produces the same successor id twice.
// '6' keyed `usage` the same way, for the same reason, and '7' `reasserted`
// — the last of the three id-keyed tables the same import makes ambiguous.
// '8' keyed `revisions` by (successor, target, agent): a merge is one
// successor naming several targets, one row each. An index an older build
// made also holds no row for a list it could not read, so it is rebuilt.
export const INDEX_SCHEMA_VERSION = '8';

// Loaded on first `search`, never at module load: see the note at the top.
type SqliteModule = typeof import('node:sqlite');
let sqliteModule: Promise<SqliteModule> | undefined;
export const loadSqlite = (): Promise<SqliteModule> => {
  sqliteModule ??= import('node:sqlite');
  return sqliteModule;
};

export type SqliteDatabase = InstanceType<SqliteModule['DatabaseSync']>;

// `remove_diacritics 0`: the in-memory implementation does not fold
// diacritics, so the index must not either — `café` and `cafe` are
// different words in both stores or the two implementations diverge.
// Only `tokens` is searchable; it holds `memoryEntryTokens` — the content
// *and* the `about` keys re-tokenized by the shared tokenizer — so FTS5
// sees exactly the token stream the in-memory store matches on rather than
// applying its own boundaries to raw text. An implementation that indexed
// one and not the other would be a divergence, not a preference: the topic
// index advertises `about` keys as things to search for.
// `trust`, `origin`, and `fields` (the optional entry shape, as stored)
// ride along unindexed so a search hit carries everything a caller needs
// without a second read of the JSONL; `reasserted` mirrors `forgotten` for
// the record type that changes a label after the fact.
//
// `revisions` is what supersession is computed from at query time rather
// than baked into the rows: which entries are retired depends on the clock,
// so the answer cannot be a deletion. The bounds are stored as epoch
// milliseconds — parsed by the same `Date.parse` the kernel's
// `memoryValidityAt` uses — because comparing ISO *strings* would disagree
// with it the moment a hand-edited line spells an offset instead of `Z`.
//
// `usage` is the one table here that is not reconstructible from the
// record, and that is the stated bargain: deleting the index loses your
// usage statistics, never your memories.
export const INDEX_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS forgotten (id TEXT NOT NULL, agent_id TEXT NOT NULL, PRIMARY KEY (id, agent_id));
CREATE TABLE IF NOT EXISTS reasserted (
  id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  trust TEXT NOT NULL,
  recorded_at INTEGER,
  PRIMARY KEY (id, agent_id)
);
CREATE TABLE IF NOT EXISTS revisions (
  successor_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  valid_from_ms INTEGER,
  valid_until_ms INTEGER,
  PRIMARY KEY (successor_id, target_id, agent_id)
);
CREATE TABLE IF NOT EXISTS usage (
  id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  recall_count INTEGER NOT NULL,
  last_recalled_at TEXT NOT NULL,
  PRIMARY KEY (id, agent_id)
);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  tokens,
  id UNINDEXED,
  agent_id UNINDEXED,
  content UNINDEXED,
  created_at UNINDEXED,
  trust UNINDEXED,
  origin UNINDEXED,
  fields UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 0'
);
`;

export interface IndexWatermark {
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

export const digestOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export const readWatermark = (db: SqliteDatabase): IndexWatermark & { schema: string | undefined } => {
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

export const writeWatermark = (db: SqliteDatabase, watermark: IndexWatermark): void => {
  const upsert = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  upsert.run('schema_version', INDEX_SCHEMA_VERSION);
  upsert.run('offset', String(watermark.offset));
  upsert.run('digest', watermark.digest);
  upsert.run('inode', watermark.inode);
  upsert.run('mtime_ms', watermark.mtimeMs);
};

// `usage` is deliberately spared: a rebuild re-derives everything the
// record holds, and the counters are not in the record. Clearing them
// because an unrelated line was hand-edited would lose the only data here
// a rebuild cannot restore.
export const clearIndex = (db: SqliteDatabase): void => {
  db.exec('DELETE FROM memory_fts; DELETE FROM forgotten; DELETE FROM reasserted; DELETE FROM revisions; DELETE FROM meta;');
};

/**
 * Apply one contiguous run of records. Sequential application with the
 * `forgotten` and `reasserted` tables makes the result order-independent:
 * an entry whose tombstone already passed is skipped, an entry already
 * indexed (a rare double-import the read path also dedupes) is skipped, a
 * tombstone retires its entry whether or not it is indexed yet, and a
 * re-assertion re-labels its entry whether it arrives before or after it.
 */
export const applyRecords = (db: SqliteDatabase, ordered: MemoryRecord[]): void => {
  const hasEntry = db.prepare('SELECT 1 FROM memory_fts WHERE id = ? AND agent_id = ?');
  const isForgotten = db.prepare('SELECT 1 FROM forgotten WHERE id = ? AND agent_id = ?');
  const reassertedFor = db.prepare('SELECT trust FROM reasserted WHERE id = ? AND agent_id = ?');
  const insertEntry = db.prepare(
    'INSERT INTO memory_fts (tokens, id, agent_id, content, created_at, trust, origin, fields) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const insertForgotten = db.prepare('INSERT OR IGNORE INTO forgotten (id, agent_id) VALUES (?, ?)');
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
    + 'ON CONFLICT(id, agent_id) DO UPDATE SET trust = excluded.trust, recorded_at = excluded.recorded_at '
    + 'WHERE excluded.recorded_at IS NULL OR reasserted.recorded_at IS NULL '
    + 'OR excluded.recorded_at >= reasserted.recorded_at',
  );
  const relabelEntry = db.prepare('UPDATE memory_fts SET trust = ? WHERE id = ? AND agent_id = ?');
  const deleteEntry = db.prepare('DELETE FROM memory_fts WHERE id = ? AND agent_id = ?');
  // Agent-scoped, like the `forgotten` table beside it: a tombstone naming a
  // stranger's successor must be as inert here as it is in the record read,
  // or `search` and `list` would disagree about whether a revision stands.
  const deleteRevision = db.prepare('DELETE FROM revisions WHERE successor_id = ? AND agent_id = ?');
  const insertRevision = db.prepare(
    'INSERT OR REPLACE INTO revisions (successor_id, target_id, agent_id, valid_from_ms, valid_until_ms) VALUES (?, ?, ?, ?, ?)',
  );
  for (const record of ordered) {
    if (isTombstoneRecord(record)) {
      insertForgotten.run(record.forgets, record.agentId);
      deleteEntry.run(record.forgets, record.agentId);
      // A forgotten successor stops retiring what it replaced, the same way
      // the record read does: a revision the agent took back leaves the
      // fact it replaced standing.
      deleteRevision.run(record.forgets, record.agentId);
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
    // Pins never reach the index: `pinned` reads the record directly, and a
    // budget replayed from a partially caught-up index would be a second
    // answer to a question that has one.
    if (isPinRecord(record)) {
      continue;
    }
    if (hasEntry.get(record.id, record.agentId) !== undefined || isForgotten.get(record.id, record.agentId) !== undefined) {
      continue;
    }
    const provenance = provenanceOf(record);
    const fields = memoryEntryFields(record);
    const reasserted = reassertedFor.get(record.id, record.agentId) as { trust: string } | undefined;
    const trust = reasserted?.trust ?? provenance.trust ?? null;
    insertEntry.run(
      memoryEntryTokens({ content: record.content, ...(fields.about ? { about: fields.about } : {}) }).join(' '),
      record.id,
      record.agentId,
      record.content,
      record.createdAt,
      trust,
      provenance.origin ? JSON.stringify(provenance.origin) : null,
      Object.keys(fields).length > 0 ? JSON.stringify(fields) : null,
    );
    for (const target of memorySupersededIds(fields)) {
      insertRevision.run(
        record.id,
        target,
        record.agentId,
        instantMs(fields.validFrom),
        instantMs(fields.validUntil),
      );
    }
  }
};

/** A bound as the index compares it: epoch millis, or null for absent and unparseable. */
const instantMs = (value: string | undefined): number | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};
