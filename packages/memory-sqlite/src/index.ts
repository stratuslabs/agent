import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
  MEMORY_PINNED_MAX_BYTES,
  memoryContentByteLength,
  MEMORY_STORE_CONTRACT_VERSION,
  memoryEntryFields,
  memoryQueryMatches,
  pinnedCapRefusal,
  pinnedInertRefusal,
  supersededMemoryIdsAt,
  tokenizeMemoryText,
  type AgentMemoryStore,
  type JsonObject,
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
  type Plugin,
  type TrustLevel,
} from '@stratusagent/core';
import { expandHome } from '@stratusagent/plugins';

/** The name a trusted config's `memoryStore` selects this store by. */
export const SQLITE_MEMORY_STORE_NAME = 'sqlite';

interface Row {
  seq: number;
  id: string;
  agent_id: string;
  content: string;
  created_at: string;
  metadata: string | null;
  trust: string | null;
  origin: string | null;
  /** The optional entry shape as JSON — kind, about, validity, supersedes. */
  fields: string | null;
  forgotten_at: string | null;
}

const parseJson = <T>(value: string | null): T | undefined => {
  if (value === null) {
    return undefined;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
};

const toEntry = (row: Row): MemoryAuditEntry => {
  const metadata = parseJson<JsonObject>(row.metadata);
  const origin = parseJson<MemoryOrigin>(row.origin);
  const fields = parseJson<MemoryEntry>(row.fields);
  return {
    id: row.id,
    agentId: row.agent_id,
    content: row.content,
    createdAt: row.created_at,
    ...(fields !== undefined ? memoryEntryFields(fields) : {}),
    ...(metadata !== undefined ? { metadata } : {}),
    ...(row.trust !== null ? { trust: row.trust as TrustLevel } : {}),
    ...(origin !== undefined ? { origin } : {}),
    ...(row.forgotten_at !== null ? { forgottenAt: row.forgotten_at } : {}),
  };
};

const live = (entry: MemoryAuditEntry): MemoryEntry => {
  const { forgottenAt: _forgotten, ...rest } = entry;
  return rest;
};

export interface SqliteMemoryStoreOptions {
  /** Test seam: the clock, so two entries can share a `createdAt` deterministically. */
  now?: () => Date;
}

/** The store, and the way to let go of the file it holds open. */
export interface SqliteMemoryStore extends AgentMemoryStore {
  close(): void;
}

/**
 * The kernel's memory contract on one SQLite file — and deliberately not
 * the file store's shape. No FTS index: every read selects an agent's live
 * rows and applies the contract's own matching and bounding rules from
 * `@stratusagent/core`, so this store and the two that came before it
 * cannot disagree about what a query matches or which entries a bounded
 * read keeps. That is slower than an index at a million entries and exact
 * at every size, which for a store that exists to prove the seam holds a
 * different shape is the right trade.
 *
 * Tombstones, not deletes: `forget` stamps `forgotten_at`, and `audit` is
 * where a forgotten entry stays visible. Ids are `<agent>:memory:<seq>`
 * with the sequence zero-padded, so the contract's tie-break — ascending
 * id on equal `createdAt` — is insertion order rather than lexical luck.
 */
export const createSqliteMemoryStore = (filePath: string, options: SqliteMemoryStoreOptions = {}): SqliteMemoryStore => {
  const now = options.now ?? (() => new Date());
  // Memories are an agent's private record — owner-only, the way the file
  // store and the session database are. The main file is tightened first,
  // since SQLite derives sidecar modes from it, and WAL keeps the sidecars
  // to a persistent pair this covers for the connection's lifetime (see
  // the session store for the journal-mode reasoning).
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filePath);
  chmodSync(filePath, 0o600);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  // `UNIQUE (agent_id, id)`, never `UNIQUE (id)`: the contract defines an
  // entry id inside its agent's namespace, and import preserves ids while
  // re-keying entries to the importing agent — so one exported corpus
  // imported for two agents legitimately holds the same id twice. A
  // database-wide constraint turned that into a failed transaction.
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      seq INTEGER PRIMARY KEY,
      id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      metadata TEXT,
      trust TEXT,
      origin TEXT,
      fields TEXT,
      forgotten_at TEXT,
      UNIQUE (agent_id, id)
    )
  `);
  // The pin lane, in arrival order — `seq`, not a timestamp, for the same
  // reason the file store replays `O_APPEND` order: a budget is allocated
  // by arrival, and a clock that skewed backwards would make an accepted
  // pin inert after the fact.
  db.exec(`
    CREATE TABLE IF NOT EXISTS pins (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      UNIQUE (id, agent_id)
    )
  `);
  // Derived, and the one table here a rebuild could not restore: usage is
  // an observation about reading, never a fact the agent learned. Dropping
  // it loses statistics, never memories.
  // Keyed by (agent, entry), never by entry alone: import preserves ids
  // while re-keying entries, so two agents legitimately hold the same id
  // and one agent's reads must not move the other's counters. An older
  // table keyed by id alone is dropped rather than migrated — these are
  // statistics, and losing them is the stated cost of a derived table.
  const usageKeyedByAgent = (db.prepare('PRAGMA table_info(usage)').all() as Array<{ name: string; pk: number }>)
    .some((column) => column.name === 'agent_id' && column.pk > 0);
  if (!usageKeyedByAgent) {
    db.exec('DROP TABLE IF EXISTS usage');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage (
      id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      recall_count INTEGER NOT NULL,
      last_recalled_at TEXT NOT NULL,
      PRIMARY KEY (id, agent_id)
    )
  `);
  // An upgrade over a store written before the wider entry shape: adding
  // the column is the whole migration, because everything it holds is
  // optional and an old row's NULL reads exactly as "nobody said".
  const columns = (db.prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>).map((column) => column.name);
  if (!columns.includes('fields')) {
    db.exec('ALTER TABLE entries ADD COLUMN fields TEXT');
  }
  // The constraint cannot be altered in place, so an older file is rebuilt
  // into the current shape — rows and all, under one transaction, which is
  // the only migration here that touches the record rather than adding to
  // it. Detected by the index SQLite created for the old `UNIQUE (id)`,
  // since the columns are identical either way.
  const singleColumnIdUnique = (db.prepare('PRAGMA index_list(entries)').all() as Array<{ name: string; unique: number }>)
    .filter((index) => index.unique === 1)
    .some((index) => {
      const on = (db.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all() as Array<{ name: string }>)
        .map((column) => column.name);
      return on.length === 1 && on[0] === 'id';
    });
  if (singleColumnIdUnique) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('ALTER TABLE entries RENAME TO entries_legacy');
      db.exec(`
        CREATE TABLE entries (
          seq INTEGER PRIMARY KEY,
          id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL,
          metadata TEXT,
          trust TEXT,
          origin TEXT,
          fields TEXT,
          forgotten_at TEXT,
          UNIQUE (agent_id, id)
        )
      `);
      db.exec(
        'INSERT INTO entries (seq, id, agent_id, content, created_at, metadata, trust, origin, fields, forgotten_at)'
        + ' SELECT seq, id, agent_id, content, created_at, metadata, trust, origin, fields, forgotten_at FROM entries_legacy',
      );
      db.exec('DROP TABLE entries_legacy');
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  // After the rebuild, never before it: `ALTER TABLE ... RENAME` carries an
  // existing index to the renamed table and `DROP TABLE` takes it away
  // again, so an index created above would leave every upgraded database
  // doing full scans for exactly the agent-scoped reads it exists to serve.
  db.exec('CREATE INDEX IF NOT EXISTS entries_by_agent ON entries (agent_id, forgotten_at)');
  for (const sidecar of [`${filePath}-wal`, `${filePath}-shm`]) {
    try {
      chmodSync(sidecar, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  const selectAgent = db.prepare('SELECT * FROM entries WHERE agent_id = ? ORDER BY seq');
  const selectLive = db.prepare('SELECT * FROM entries WHERE agent_id = ? AND forgotten_at IS NULL ORDER BY seq');
  const nextSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM entries');
  const insert = db.prepare(
    'INSERT INTO entries (seq, id, agent_id, content, created_at, metadata, trust, origin, fields) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const holdsId = db.prepare('SELECT 1 FROM entries WHERE agent_id = ? AND id = ?');
  const tombstone = db.prepare('UPDATE entries SET forgotten_at = ? WHERE agent_id = ? AND id = ? AND forgotten_at IS NULL');
  const relabel = db.prepare('UPDATE entries SET trust = ? WHERE agent_id = ? AND id = ? AND forgotten_at IS NULL');
  const selectPins = db.prepare('SELECT id FROM pins WHERE agent_id = ? ORDER BY seq');
  const insertPin = db.prepare('INSERT OR IGNORE INTO pins (id, agent_id) VALUES (?, ?)');
  const deletePin = db.prepare('DELETE FROM pins WHERE id = ? AND agent_id = ?');
  const selectUsage = db.prepare('SELECT recall_count, last_recalled_at FROM usage WHERE id = ? AND agent_id = ?');
  const bumpUsage = db.prepare(
    'INSERT INTO usage (id, agent_id, recall_count, last_recalled_at) VALUES (?, ?, 1, ?)'
    + ' ON CONFLICT(id, agent_id) DO UPDATE SET recall_count = recall_count + 1, last_recalled_at = excluded.last_recalled_at',
  );

  /** Un-tombstoned, minus everything a successor that is current at `at` retires. */
  const liveEntries = (agentId: string, at: Date): MemoryEntry[] => {
    const kept = (selectLive.all(agentId) as unknown as Row[]).map((row) => live(toEntry(row)));
    const superseded = supersededMemoryIdsAt(kept, at);
    return kept.filter((entry) => !superseded.has(entry.id));
  };

  /**
   * Allocated over un-tombstoned rows, never the live view: the budget is a
   * property of the record and must not move when a successor's window
   * opens. Sizing it from the live set would free a superseded pin's bytes,
   * admit a later pin, and make that later pin inert the moment the
   * successor was forgotten — an accepted pin dropped after the fact.
   */
  const pinBudget = (agentId: string): { effective: string[]; inert: string[]; bytes: number; allocated: Map<string, MemoryEntry> } => {
    const allocated = new Map(
      (selectLive.all(agentId) as unknown as Row[]).map((row) => [row.id, live(toEntry(row))]),
    );
    const ordered = (selectPins.all(agentId) as unknown as { id: string }[]).map((row) => row.id);
    const budget = applyMemoryPinBudget(
      ordered,
      (id) => (allocated.has(id) ? memoryContentByteLength(allocated.get(id)!.content) : undefined),
    );
    return { effective: budget.effective, inert: budget.inert, bytes: budget.bytes, allocated };
  };

  return {
    async append(agentId, content, appendOptions: MemoryAppendOptions = {}) {
      assertMemoryContentWithinCap(content);
      const at = now();
      // Same write-path check as every other store: an id a new record
      // names must resolve to a live entry the caller owns, or nothing is
      // stored. Skipping it would let one agent retire another's memory.
      if (appendOptions.supersedes !== undefined) {
        assertSupersedableMemoryEntry(liveEntries(agentId, at), appendOptions.supersedes);
      }
      const fields = memoryEntryFields(appendOptions);
      assertMemoryAboutWithinCap(fields.about ?? []);
      const createdAt = at.toISOString();
      const { metadata, provenance } = appendOptions;
      // The sequence is read and written in one transaction, so two
      // appends on one connection can never claim one id.
      db.exec('BEGIN IMMEDIATE');
      try {
        // The id encodes the sequence, and an import preserves ids from
        // wherever the corpus came from — so a corpus with gaps in it (an
        // export drops forgotten entries) can already hold the id this
        // sequence is about to mint. Skipping forward is the whole fix;
        // without it the insert fails the uniqueness constraint, the
        // transaction rolls back without advancing the maximum, and every
        // later write for that agent mints the same doomed id again.
        let seq = (nextSeq.get() as { next: number }).next;
        let id = `${agentId}:memory:${String(seq).padStart(12, '0')}`;
        while (holdsId.get(agentId, id) !== undefined) {
          seq += 1;
          id = `${agentId}:memory:${String(seq).padStart(12, '0')}`;
        }
        insert.run(
          seq,
          id,
          agentId,
          content,
          createdAt,
          metadata ? JSON.stringify(metadata) : null,
          provenance?.trust ?? null,
          provenance?.origin ? JSON.stringify(provenance.origin) : null,
          Object.keys(fields).length > 0 ? JSON.stringify(fields) : null,
        );
        db.exec('COMMIT');
        return {
          id,
          agentId,
          content,
          createdAt,
          ...fields,
          ...(metadata ? { metadata } : {}),
          ...(provenance ? { trust: provenance.trust } : {}),
          ...(provenance?.origin ? { origin: provenance.origin } : {}),
        };
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    async list(agentId, listOptions: MemoryListOptions = {}): Promise<MemoryReadResult> {
      const at = now();
      const entries = listOptions.validity === 'all'
        ? liveEntries(agentId, at)
        : liveEntries(agentId, at).filter((entry) => isMemoryEntryCurrent(entry, at));
      if (listOptions.limit === undefined) {
        return { entries: entries.sort(compareMemoryChronology), truncated: false };
      }
      return boundMemoryList(entries, listOptions.limit);
    },

    async search(agentId, query, searchOptions: MemorySearchOptions = {}) {
      const tokens = tokenizeMemoryText(query);
      // Recency only, declared: this store has no ranking machinery at all,
      // and serving the contract's mandatory ordering while saying so is
      // the negotiated answer rather than an error.
      const strategy: MemoryRankingStrategy = 'recency';
      if (tokens.length === 0) {
        return { entries: [], truncated: false, strategy };
      }
      // Out-of-window entries stay findable, marked by their own bounds —
      // that is what separates validity from supersession.
      const matches = liveEntries(agentId, now()).filter((entry) => memoryQueryMatches(entry, tokens));
      const bounded = boundMemoryRead(matches, clampMemoryRecallLimit(searchOptions.limit));
      const recalledAt = now().toISOString();
      const entries = bounded.entries.map((entry) => {
        bumpUsage.run(entry.id, agentId, recalledAt);
        const counted = selectUsage.get(entry.id, agentId) as { recall_count: number; last_recalled_at: string } | undefined;
        return counted === undefined
          ? entry
          : { ...entry, usage: { recallCount: counted.recall_count, lastRecalledAt: counted.last_recalled_at } };
      });
      return { entries, truncated: bounded.truncated, strategy };
    },

    async forget(agentId, entryId) {
      // Against the live view, not any un-tombstoned row: forgetting a
      // predecessor a current successor already retired would stick, and
      // forgetting that successor is documented to release it — which the
      // predecessor's own tombstone would then silently prevent. The file
      // store resolves the same way.
      if (!liveEntries(agentId, now()).some((entry) => entry.id === entryId)) {
        return false;
      }
      return tombstone.run(now().toISOString(), agentId, entryId).changes > 0;
    },

    async audit(agentId) {
      return (selectAgent.all(agentId) as unknown as Row[]).map(toEntry).sort(compareMemoryChronology);
    },

    async reassertTrust(agentId, entryId, trust) {
      if (!liveEntries(agentId, now()).some((entry) => entry.id === entryId)) {
        return false;
      }
      return relabel.run(trust, agentId, entryId).changes > 0;
    },

    async pin(agentId, entryId): Promise<MemoryPinOutcome> {
      const { effective, inert, bytes, allocated } = pinBudget(agentId);
      // Pinnable means live; the budget above is a different question.
      const entry = liveEntries(agentId, now()).find((candidate) => candidate.id === entryId);
      if (!entry || !allocated.has(entryId)) {
        throw new Error(`No live memory entry with id ${entryId} belongs to this agent — nothing was pinned.`);
      }
      if (effective.includes(entryId)) {
        return { pinned: true, bytes };
      }
      // An inert pin blocks everything after it whatever its size — the
      // budget is a prefix — and the effective total below cannot see that.
      if (inert[0] !== undefined) {
        return { pinned: false, reason: pinnedInertRefusal(inert[0]), bytes };
      }
      const size = memoryContentByteLength(entry.content);
      if (bytes + size > MEMORY_PINNED_MAX_BYTES) {
        return { pinned: false, reason: pinnedCapRefusal(bytes, size), bytes };
      }
      insertPin.run(entryId, agentId);
      return { pinned: true, bytes: bytes + size };
    },

    async unpin(agentId, entryId) {
      return deletePin.run(entryId, agentId).changes > 0;
    },

    async pinned(agentId, pinnedOptions: MemoryPinnedOptions = {}) {
      const at = now();
      const { effective, allocated } = pinBudget(agentId);
      const pins = effective.map((id) => allocated.get(id)).filter((entry): entry is MemoryEntry => entry !== undefined);
      if (pinnedOptions.include === 'allocated') {
        return pins.sort(compareMemoryChronology);
      }
      const alive = new Set(liveEntries(agentId, at).map((entry) => entry.id));
      return pins
        .filter((entry) => alive.has(entry.id) && isMemoryEntryCurrent(entry, at))
        .sort(compareMemoryChronology);
    },

    async topics(agentId): Promise<MemoryTopic[]> {
      const at = now();
      return collectMemoryTopics(liveEntries(agentId, at).filter((entry) => isMemoryEntryCurrent(entry, at)));
    },

    async importEntries(agentId, entries): Promise<MemoryImportResult> {
      // This agent's ids, which is the whole namespace an id lives in —
      // another agent holding the same id is not a collision here, and the
      // table's `UNIQUE (agent_id, id)` agrees.
      const held = new Set((selectAgent.all(agentId) as unknown as Row[]).map((row) => row.id));
      const skipped: string[] = [];
      let imported = 0;
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const candidate of entries) {
          if (held.has(candidate.id)) {
            skipped.push(candidate.id);
            continue;
          }
          held.add(candidate.id);
          const entry = importableMemoryEntry(candidate, agentId);
          const fields = memoryEntryFields(entry);
          const seq = (nextSeq.get() as { next: number }).next;
          insert.run(
            seq,
            entry.id,
            agentId,
            entry.content,
            entry.createdAt,
            entry.metadata ? JSON.stringify(entry.metadata) : null,
            entry.trust ?? null,
            entry.origin ? JSON.stringify(entry.origin) : null,
            Object.keys(fields).length > 0 ? JSON.stringify(fields) : null,
          );
          imported += 1;
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return { imported, skipped };
    },

    close() {
      db.close();
    },
  };
};

/**
 * The plugin: registers the store under `sqlite`, at the path its config
 * names, and closes the file on dispose. `path` is required rather than
 * defaulted, because the `~/.stratus` layout is the host's to own and a
 * plugin guessing a spot inside it would be a second copy of that layout.
 */
export const createSqliteMemoryPlugin = (config: JsonObject = {}): Plugin => {
  const configured = typeof config.path === 'string' && config.path.length > 0 ? config.path : undefined;
  let store: SqliteMemoryStore | undefined;
  return {
    name: 'memory-sqlite',
    setup(context) {
      if (!context.memory) {
        throw new Error(
          `This host hands plugins no memory handle, so @stratusagent/memory-sqlite cannot register ${SQLITE_MEMORY_STORE_NAME}.`,
        );
      }
      if (configured === undefined) {
        throw new Error('@stratusagent/memory-sqlite needs a path: set path under plugins["@stratusagent/memory-sqlite"] to where the database file should live.');
      }
      store = createSqliteMemoryStore(path.resolve(expandHome(configured)));
      context.memory.register({ name: SQLITE_MEMORY_STORE_NAME, store, contract: MEMORY_STORE_CONTRACT_VERSION });
    },
    dispose() {
      store?.close();
      store = undefined;
    },
  };
};

/** The loader's entry point. See docs/architecture/plugins.md. */
export const createPlugin = (config: JsonObject): Plugin => createSqliteMemoryPlugin(config);
