import { createHash, randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { isSymlinkedStatePath, symlinkedStateDirectoryMessage, symlinkedStateFileMessage } from '@stratusagent/permissions';

import {
  applyMemoryPinBudget,
  assertMemoryAboutWithinCap,
  assertMemoryContentWithinCap,
  assertSupersedableMemoryEntry,
  boundMemoryList,
  boundMemoryRead,
  clampMemoryRecallLimit,
  collectMemoryTopics,
  compareMemoryChronology,
  importableMemoryEntry,
  isMemoryEntryCurrent,
  isTrustLevel,
  memoryContentByteLength,
  memoryEntryFields,
  MEMORY_PINNED_MAX_BYTES,
  MEMORY_READ_MAX_BYTES,
  memoryEntryTokens,
  pinnedCapRefusal,
  pinnedInertRefusal,
  supersededMemoryIdsAt,
  tokenizeMemoryText,
  type AgentMemoryStore,
  type MemoryAppendOptions,
  type MemoryAuditEntry,
  type MemoryEntry,
  type MemoryImportResult,
  type MemoryListOptions,
  type MemoryOrigin,
  type MemoryPinnedOptions,
  type MemoryPinOutcome,
  type MemoryRankingStrategy,
  type MemoryReadResult,
  type MemorySearchOptions,
  type MemoryTopic,
  type MemoryUsage,
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

/**
 * A pin, or its undo. `pinned` cannot be a field on the entry: pinning is a
 * toggle, from the agent and from the operator's CLI and console alike, and
 * a toggle on an append-only line is a rewrite. So it is a record naming
 * the entry, and the entry's own line stays byte-identical forever.
 */
interface MemoryPin {
  pins: string;
  agentId: string;
  /** False for the undo. Spelled out rather than a second record type: one shape, one replay. */
  pinned: boolean;
  createdAt: string;
}

type MemoryRecord = MemoryEntry | MemoryTombstone | MemoryReassertion | MemoryPin;

interface MemoryFileRecords {
  entries: MemoryEntry[];
  tombstones: MemoryTombstone[];
  reassertions: MemoryReassertion[];
  /** In file order, which is the order the pin budget is allocated in. */
  pins: MemoryPin[];
}

const isTombstoneRecord = (value: unknown): value is MemoryTombstone =>
  typeof value === 'object' && value !== null && typeof (value as MemoryTombstone).forgets === 'string'
  && typeof (value as MemoryTombstone).agentId === 'string'
  && typeof (value as MemoryTombstone).createdAt === 'string';

const isPinRecord = (value: unknown): value is MemoryPin =>
  typeof value === 'object' && value !== null && typeof (value as MemoryPin).pins === 'string'
  && typeof (value as MemoryPin).agentId === 'string'
  && typeof (value as MemoryPin).pinned === 'boolean'
  && typeof (value as MemoryPin).createdAt === 'string';

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
    if (!isTombstoneRecord(parsed) && !isReassertionRecord(parsed) && !isPinRecord(parsed) && !isEntryRecord(parsed)) {
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
  const pins: MemoryPin[] = [];
  for (const record of parseOrderedRecords(raw, filePath)) {
    if (isTombstoneRecord(record)) {
      tombstones.push(record);
    } else if (isReassertionRecord(record)) {
      reassertions.push(record);
    } else if (isPinRecord(record)) {
      pins.push(record);
    } else {
      entries.push(record);
    }
  }
  return { entries, tombstones, reassertions, pins };
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

/**
 * An entry as read back: optional fields validated, any re-assertion
 * applied. The four required fields pass through untouched, so a
 * hand-added line carrying only those is exactly what comes back.
 */
const presentEntry = (entry: MemoryEntry, reasserted: Map<string, TrustLevel>): MemoryEntry => {
  const {
    trust: _trust, origin: _origin, kind: _kind, about: _about,
    validFrom: _validFrom, validUntil: _validUntil, supersedes: _supersedes,
    usage: _usage, ...rest
  } = entry;
  const provenance = provenanceOf(entry);
  const reassertedTrust = reasserted.get(entry.id);
  return {
    ...rest,
    ...memoryEntryFields(entry),
    ...provenance,
    ...(reassertedTrust !== undefined ? { trust: reassertedTrust } : {}),
  };
};

/**
 * Every entry of one agent that no tombstone retires: deduped by id (first
 * wins, as `list` has always read).
 *
 * The tombstone filter is **scoped to the entry's own agent**, which makes
 * the per-agent boundary structural rather than a rule every future writer
 * has to remember: a record naming a stranger's id is inert wherever it
 * came from, not merely refused by the one write path that checks. The
 * order-independence the original filter protected survives — a hand-edited
 * file where a tombstone precedes its entry still means forgotten, as long
 * as the two agree about whose entry it is.
 */
const untombstonedEntriesFor = (records: MemoryFileRecords, agentId: string): MemoryEntry[] => {
  const forgotten = new Set(
    records.tombstones.filter((tombstone) => tombstone.agentId === agentId).map((tombstone) => tombstone.forgets),
  );
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

/**
 * The live view: un-tombstoned, minus everything a *current* successor
 * supersedes. Supersession is scoped to the agent for free — the successors
 * considered are this agent's own entries — and to the clock deliberately,
 * so a future-dated revision leaves the fact it replaces standing until it
 * takes effect.
 */
const liveEntriesFor = (records: MemoryFileRecords, agentId: string, at: Date): MemoryEntry[] => {
  const kept = untombstonedEntriesFor(records, agentId);
  const superseded = supersededMemoryIdsAt(kept, at);
  return kept.filter((entry) => !superseded.has(entry.id));
};

/**
 * The pin lane replayed in file order — `O_APPEND`'s total order, which is
 * the one no later writer can insert itself into. A pin already held is not
 * re-added (so re-pinning cannot move an entry to the back of the budget),
 * and an unpin removes it. Scoped to the agent for the same structural
 * reason the tombstone filter is.
 */
const pinnedIdsFor = (records: MemoryFileRecords, agentId: string): string[] => {
  const ordered: string[] = [];
  for (const record of records.pins) {
    if (record.agentId !== agentId) {
      continue;
    }
    const held = ordered.indexOf(record.pins);
    if (record.pinned && held === -1) {
      ordered.push(record.pins);
    } else if (!record.pinned && held !== -1) {
      ordered.splice(held, 1);
    }
  }
  return ordered;
};

/**
 * The effective pinned set and what it costs.
 *
 * Allocated over **un-tombstoned** entries, never the live view: the budget
 * is a property of the record, so it must not move when a clock ticks past
 * a `validUntil` or a successor's window opens. Sizing it from the live set
 * would free a superseded pin's bytes, let a later pin be accepted into the
 * space, and then make that later pin inert the moment the successor was
 * forgotten — an accepted pin dropped after the fact, which is the eviction
 * the cap promises never happens. What is *live* decides only what renders.
 */
const pinBudgetFor = (
  records: MemoryFileRecords,
  agentId: string,
): { effective: string[]; inert: string[]; bytes: number; allocated: Map<string, MemoryEntry> } => {
  const allocated = new Map(untombstonedEntriesFor(records, agentId).map((entry) => [entry.id, entry]));
  const budget = applyMemoryPinBudget(
    pinnedIdsFor(records, agentId),
    (id) => (allocated.has(id) ? memoryContentByteLength(allocated.get(id)!.content) : undefined),
  );
  return { effective: budget.effective, inert: budget.inert, bytes: budget.bytes, allocated };
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
const INDEX_SCHEMA_VERSION = '7';

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
const INDEX_SCHEMA = `
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
  PRIMARY KEY (successor_id, agent_id)
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

// `usage` is deliberately spared: a rebuild re-derives everything the
// record holds, and the counters are not in the record. Clearing them
// because an unrelated line was hand-edited would lose the only data here
// a rebuild cannot restore.
const clearIndex = (db: SqliteDatabase): void => {
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
const applyRecords = (db: SqliteDatabase, ordered: MemoryRecord[]): void => {
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
    if (fields.supersedes !== undefined) {
      insertRevision.run(
        record.id,
        fields.supersedes,
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

export interface FileMemoryStoreOptions {
  /**
   * Test seam: the clock every validity and supersession question is
   * answered against. A window asserted against a fixed date is not
   * testable otherwise, and neither is a `createdAt` tie.
   */
  now?: () => Date;
  /**
   * Whether the file's directory is dedicated Stratus state and may be
   * created and tightened to owner-only.
   *
   * Off by default, and for the reason the session store gives: a
   * caller-supplied path can sit in a shared parent — a project directory,
   * `/tmp` in a test — and a store must never chmod one of those out from
   * under whoever else uses it. On for `agents/<id>/`, which is one agent's
   * own directory and is `0700` by contract; without it the first write for
   * an agent whose directory does not exist yet creates it under the umask,
   * so a home where memory happened before sessions had its per-agent
   * directory world-readable.
   */
  ownedDirectory?: boolean;
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
  const now = options.now ?? (() => new Date());
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
    if (!options.ownedDirectory) {
      return;
    }
    // See `isSymlinkedStateDirectory`, which owns the rule itself.
    const dir = path.dirname(filePath);
    if (await isSymlinkedStatePath(dir)) {
      throw new Error(symlinkedStateDirectoryMessage(dir));
    }
    for (const candidate of [filePath, indexPath]) {
      if (await isSymlinkedStatePath(candidate)) {
        throw new Error(symlinkedStateFileMessage(candidate));
      }
    }
  };

  /** The directory, made and held to the posture its owner asked for. */
  const ensureDirectory = async (): Promise<void> => {
    const dir = path.dirname(filePath);
    await assertOwnedPaths();
    await mkdir(dir, { recursive: true, ...(options.ownedDirectory ? { mode: 0o700 } : {}) });
    if (options.ownedDirectory) {
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
        return { entries: [], tombstones: [], reassertions: [], pins: [] };
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
      // Both tables whose *shape* has changed, not only the widest one: a
      // `revisions` keyed by successor alone silently collapses two agents'
      // revisions into one row, and no column is added or removed by the
      // fix, so only the key tells them apart.
      const hasCurrentShape = (): boolean => {
        const columns = (name: string): Array<{ name: string; pk: number }> =>
          opened.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string; pk: number }>;
        return columns('memory_fts').some((column) => column.name === 'fields')
          && columns('reasserted').some((column) => column.name === 'recorded_at')
          && columns('revisions').some((column) => column.name === 'agent_id' && column.pk > 0)
          && columns('usage').some((column) => column.name === 'agent_id' && column.pk > 0)
          && columns('reasserted').some((column) => column.name === 'agent_id' && column.pk > 0);
      };
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
            opened.exec('DROP TABLE IF EXISTS revisions;');
            // The one table a rebuild cannot restore, dropped anyway when
            // its *key* is wrong: a counter attributed to the wrong agent
            // is worse than no counter, and losing statistics is the stated
            // cost of a derived file.
            opened.exec('DROP TABLE IF EXISTS usage;');
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
    async append(agentId: string, content: string, appendOptions: MemoryAppendOptions = {}) {
      assertMemoryContentWithinCap(content);
      // Resolved against the caller's own live set *before* anything is
      // appended. `untombstonedEntriesFor` computes its forgotten set from
      // the file, and this is the second writer into that lane: without the
      // check, agent A could retire agent B's memory by naming its id — gone
      // from B's list, its search, and its prompt, with B's own `forget`
      // never called.
      if (appendOptions.supersedes !== undefined) {
        assertSupersedableMemoryEntry(liveEntriesFor(await readRecords(), agentId, now()), appendOptions.supersedes);
      }
      const fields = memoryEntryFields(appendOptions);
      assertMemoryAboutWithinCap(fields.about ?? []);
      const entry: MemoryEntry = {
        id: `${agentId}:memory:${randomUUID()}`,
        agentId,
        content,
        createdAt: now().toISOString(),
        ...fields,
        ...(appendOptions.metadata ? { metadata: appendOptions.metadata } : {}),
        ...(appendOptions.provenance ? { trust: appendOptions.provenance.trust } : {}),
        ...(appendOptions.provenance?.origin ? { origin: appendOptions.provenance.origin } : {}),
      };
      await appendRecord(entry);
      return entry;
    },

    async list(agentId: string, listOptions: MemoryListOptions = {}) {
      const at = now();
      const live = liveEntriesFor(await readRecords(), agentId, at);
      // Out of its validity window is not out of the record: `all` is what
      // the operator's views read, so an expired fact can be shown *as*
      // expired rather than vanishing.
      const current = listOptions.validity === 'all'
        ? live
        : live.filter((entry) => isMemoryEntryCurrent(entry, at));
      if (listOptions.limit === undefined) {
        return { entries: current.sort(compareMemoryChronology), truncated: false };
      }
      // The bound applies after the tombstone filter — a store whose recent
      // entries are mostly forgotten still fills its slice with live ones.
      return boundMemoryList(current, listOptions.limit);
    },

    async search(agentId: string, query: string, searchOptions: MemorySearchOptions = {}): Promise<MemoryReadResult> {
      // The query means its literal text: tokenize and quote each term
      // rather than forwarding the string, so `C++`, an unmatched quote,
      // and a sentence containing AND are searches, never syntax errors.
      const tokens = tokenizeMemoryText(query);
      // BM25 is right there in FTS5 and the in-memory store cannot
      // reproduce it, so this store implements `recency` only and says so.
      // A caller asking for another ordering is served, not refused.
      const strategy: MemoryRankingStrategy = 'recency';
      if (tokens.length === 0) {
        return { entries: [], truncated: false, strategy };
      }
      const database = await withIndexLock(async () => {
        const opened = await openIndex();
        await ensureIndexCurrent(opened);
        return opened;
      });
      const clamped = clampMemoryRecallLimit(searchOptions.limit);
      const match = tokens.map((token) => `"${token}"`).join(' ');
      const at = now().getTime();
      // Superseded entries leave `search` exactly as forgotten ones do, and
      // which are superseded depends on the clock — hence a join against
      // `revisions` rather than a deletion. Entries outside their *own*
      // validity window stay: keeping an expired fact findable is the point
      // of separating validity from supersession, and the caller reads its
      // status from the bounds that come back with it.
      // The retirement join, and the oversized filter, spelled once: both
      // reads below have to select from exactly the same candidates.
      const liveMatch = 'FROM memory_fts'
        + ' WHERE memory_fts MATCH ? AND agent_id = ?'
        + ' AND id NOT IN ('
        + '   SELECT target_id FROM revisions WHERE agent_id = ?'
        + '     AND (valid_from_ms IS NULL OR valid_from_ms <= ?)'
        + '     AND (valid_until_ms IS NULL OR valid_until_ms > ?)'
        + ' )';
      // An entry no budget could ever admit is skipped by `boundMemoryRead`
      // rather than allowed to starve everything behind it — but that
      // helper can only skip what it was handed, and a `LIMIT` that filled
      // with oversized matches would hand it nothing else. Filtered in SQL
      // by the same rule, on bytes (`length` over TEXT counts characters),
      // so the bounded read sees the admissible ones it would have kept.
      const admissible = `${liveMatch} AND length(CAST(content AS BLOB)) <= ?`;
      const rows = database.prepare(
        `SELECT id, agent_id, content, created_at, trust, origin, fields ${admissible}`
        + ' ORDER BY created_at DESC, id ASC LIMIT ?',
      ).all(match, agentId, agentId, at, at, MEMORY_READ_MAX_BYTES, clamped + 1) as {
        id: string;
        agent_id: string;
        content: string;
        created_at: string;
        trust: string | null;
        origin: string | null;
        fields: string | null;
      }[];
      const candidates: MemoryEntry[] = rows.map((row) => {
        const origin = parseOrigin(row.origin);
        return {
          id: row.id,
          agentId: row.agent_id,
          content: row.content,
          createdAt: row.created_at,
          ...parseFields(row.fields),
          ...(isTrustLevel(row.trust) ? { trust: row.trust } : {}),
          ...(origin !== undefined ? { origin } : {}),
        };
      });
      const bounded = boundMemoryRead(candidates, clamped);
      // A match the filter above removed is still a live entry beyond what
      // came back, which is what `truncated` means — so it is asked for
      // rather than inferred, and the flag says the same thing it would
      // have said had `boundMemoryRead` done the skipping itself.
      const oversized = bounded.truncated
        ? undefined
        : database.prepare(`SELECT 1 ${liveMatch} AND length(CAST(content AS BLOB)) > ? LIMIT 1`)
          .get(match, agentId, agentId, at, at, MEMORY_READ_MAX_BYTES);
      // Counted for the entries actually returned, never for everything the
      // match found: usage is meant to say what reached a prompt.
      const counted = noteRecalled(database, agentId, bounded.entries, now().toISOString());
      return {
        entries: bounded.entries.map((entry) => {
          const usage = counted.get(entry.id);
          return usage === undefined ? entry : { ...entry, usage };
        }),
        truncated: bounded.truncated || oversized !== undefined,
        strategy,
      };
    },

    async forget(agentId: string, entryId: string) {
      const live = liveEntriesFor(await readRecords(), agentId, now());
      const entry = live.find((candidate) => candidate.id === entryId);
      if (!entry) {
        return false;
      }
      await appendRecord({ forgets: entry.id, agentId: entry.agentId, createdAt: now().toISOString() });
      return true;
    },

    async audit(agentId: string) {
      const records = await readRecords();
      const forgottenAt = new Map<string, string>();
      for (const tombstone of records.tombstones) {
        if (tombstone.agentId === agentId && !forgottenAt.has(tombstone.forgets)) {
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
      const live = liveEntriesFor(await readRecords(), agentId, now());
      const entry = live.find((candidate) => candidate.id === entryId);
      if (!entry) {
        return false;
      }
      await appendRecord({ reasserts: entry.id, agentId: entry.agentId, trust, createdAt: now().toISOString() });
      return true;
    },

    async pin(agentId: string, entryId: string): Promise<MemoryPinOutcome> {
      const records = await readRecords();
      const { effective, inert, bytes, allocated } = pinBudgetFor(records, agentId);
      // Pinnable means live — a superseded or forgotten entry is not the
      // agent's to pin — while the *budget* above is allocated over the
      // record, which is a different question.
      const entry = liveEntriesFor(records, agentId, now()).find((candidate) => candidate.id === entryId);
      if (!entry || !allocated.has(entryId)) {
        throw new Error(`No live memory entry with id ${entryId} belongs to this agent — nothing was pinned.`);
      }
      if (effective.includes(entryId)) {
        return { pinned: true, bytes };
      }
      // The inert pin the race below can leave behind blocks everything
      // after it, whatever its size, because the budget is a prefix. Tested
      // before the byte total and not instead of it: the effective set is
      // under the cap in exactly this case, so the total would wave a small
      // pin through and `pinned` would drop it on the next read.
      if (inert[0] !== undefined) {
        return { pinned: false, reason: pinnedInertRefusal(inert[0]), bytes };
      }
      const size = memoryContentByteLength(entry.content);
      // The write path refusing is the rule, and it is not the whole story:
      // two processes at the limit can both read this total and both
      // append. `applyMemoryPinBudget` decides that race deterministically
      // on replay, so the losing pin is recorded and inert rather than
      // silently evicting one that was already effective.
      if (bytes + size > MEMORY_PINNED_MAX_BYTES) {
        return { pinned: false, reason: pinnedCapRefusal(bytes, size), bytes };
      }
      await appendRecord({ pins: entry.id, agentId: entry.agentId, pinned: true, createdAt: now().toISOString() });
      return { pinned: true, bytes: bytes + size };
    },

    async unpin(agentId: string, entryId: string) {
      const records = await readRecords();
      if (!pinnedIdsFor(records, agentId).includes(entryId)) {
        return false;
      }
      await appendRecord({ pins: entryId, agentId, pinned: false, createdAt: now().toISOString() });
      return true;
    },

    async pinned(agentId: string, pinnedOptions: MemoryPinnedOptions = {}) {
      const at = now();
      const records = await readRecords();
      const { effective, allocated } = pinBudgetFor(records, agentId);
      const pins = effective.map((id) => allocated.get(id)).filter((entry): entry is MemoryEntry => entry !== undefined);
      // `allocated` is everything holding budget, which is what a caller
      // re-allocating a merged budget and an operator hunting the entry
      // behind a refusal both need.
      if (pinnedOptions.include === 'allocated') {
        return pins.sort(compareMemoryChronology);
      }
      // A pinned fact that is not true now does not reach the prompt — one
      // rule, both bounds, the pinned core included. It keeps its place in
      // the budget, which is a property of the record rather than of the
      // clock, and comes back the moment its window opens.
      const live = new Set(liveEntriesFor(records, agentId, at).map((entry) => entry.id));
      return pins
        .filter((entry) => live.has(entry.id) && isMemoryEntryCurrent(entry, at))
        .sort(compareMemoryChronology);
    },

    async topics(agentId: string): Promise<MemoryTopic[]> {
      const at = now();
      const live = liveEntriesFor(await readRecords(), agentId, at);
      return collectMemoryTopics(live.filter((entry) => isMemoryEntryCurrent(entry, at)));
    },

    async importEntries(agentId: string, entries: readonly MemoryEntry[]): Promise<MemoryImportResult> {
      // Against the record, not the live set: an id this agent forgot is
      // still an id it holds, and re-importing it would resurrect a fact
      // under a line the tombstone already names.
      const held = new Set(
        (await readRecords()).entries.filter((entry) => entry.agentId === agentId).map((entry) => entry.id),
      );
      const skipped: string[] = [];
      let imported = 0;
      for (const entry of entries) {
        if (held.has(entry.id)) {
          skipped.push(entry.id);
          continue;
        }
        held.add(entry.id);
        await appendRecord(importableMemoryEntry(entry, agentId));
        imported += 1;
      }
      return { imported, skipped };
    },
  };
};

/** The optional fields as the index stored them, validated on the way back out. */
const parseFields = (raw: string | null): Pick<MemoryEntry, 'kind' | 'about' | 'validFrom' | 'validUntil' | 'supersedes'> => {
  if (raw === null) {
    return {};
  }
  try {
    return memoryEntryFields(JSON.parse(raw) as MemoryEntry);
  } catch {
    return {};
  }
};

/**
 * Count a read. Usage lives only here, in the derived index, because
 * `lastRecalledAt` and `recallCount` are observations about reading rather
 * than facts the agent learned — putting them in the JSONL would make every
 * recall a write to the record.
 */
const noteRecalled = (
  db: SqliteDatabase,
  agentId: string,
  entries: readonly MemoryEntry[],
  at: string,
): Map<string, MemoryUsage> => {
  const counted = new Map<string, MemoryUsage>();
  if (entries.length === 0) {
    return counted;
  }
  const bump = db.prepare(
    'INSERT INTO usage (id, agent_id, recall_count, last_recalled_at) VALUES (?, ?, 1, ?)'
    + ' ON CONFLICT(id, agent_id) DO UPDATE SET recall_count = recall_count + 1, last_recalled_at = excluded.last_recalled_at'
    + ' RETURNING recall_count, last_recalled_at',
  );
  for (const entry of entries) {
    const row = bump.get(entry.id, agentId, at) as { recall_count: number; last_recalled_at: string } | undefined;
    if (row !== undefined) {
      counted.set(entry.id, { recallCount: row.recall_count, lastRecalledAt: row.last_recalled_at });
    }
  }
  return counted;
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
 *
 * **Every method is forwarded, including the optional ones**, and a test
 * asserts that against the wrapped store's own surface rather than against
 * a list written here. The optional half is the trap: `pin`, `pinned`,
 * `topics`, and `importEntries` are `?` on `AgentMemoryStore`, so a facade
 * that omits one still satisfies the interface and still type-checks, and
 * `withLegacyDefaultMemories` above spreads them only when it finds them.
 * Omitting them here would leave the pinned core and the topic index
 * permanently empty on the per-agent layout — two of the three injected
 * blocks gone, with nothing failing.
 */
export const createShardedFileMemoryStore = (fileFor: (agentId: string) => string): AgentMemoryStore => {
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
    // resource — see `FileMemoryStoreOptions.ownedDirectory`.
    const store = createFileMemoryStore(fileFor(agentId), { ownedDirectory: true });
    stores.set(agentId, store);
    return store;
  };
  return {
    append: (agentId, content, options) => storeFor(agentId).append(agentId, content, options),
    list: (agentId, options) => storeFor(agentId).list(agentId, options),
    search: (agentId, query, options) => storeFor(agentId).search(agentId, query, options),
    forget: (agentId, entryId) => storeFor(agentId).forget(agentId, entryId),
    audit: (agentId) => storeFor(agentId).audit(agentId),
    // The file store implements all of these unconditionally; the `!` is for
    // the type, since each is optional on the interface.
    reassertTrust: (agentId, entryId, trust) => storeFor(agentId).reassertTrust!(agentId, entryId, trust),
    pin: (agentId, entryId) => storeFor(agentId).pin!(agentId, entryId),
    unpin: (agentId, entryId) => storeFor(agentId).unpin!(agentId, entryId),
    pinned: (agentId, options) => storeFor(agentId).pinned!(agentId, options),
    topics: (agentId) => storeFor(agentId).topics!(agentId),
    importEntries: (agentId, entries) => storeFor(agentId).importEntries!(agentId, entries),
  };
};
