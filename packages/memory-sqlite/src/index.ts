import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  assertMemoryContentWithinCap,
  boundMemoryList,
  boundMemoryRead,
  clampMemoryRecallLimit,
  compareMemoryChronology,
  memoryQueryMatches,
  tokenizeMemoryText,
  type AgentMemoryStore,
  type JsonObject,
  type MemoryAuditEntry,
  type MemoryEntry,
  type MemoryListOptions,
  type MemoryOrigin,
  type MemoryProvenance,
  type MemoryReadResult,
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
  return {
    id: row.id,
    agentId: row.agent_id,
    content: row.content,
    createdAt: row.created_at,
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
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      seq INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      agent_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      metadata TEXT,
      trust TEXT,
      origin TEXT,
      forgotten_at TEXT
    )
  `);
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
    'INSERT INTO entries (seq, id, agent_id, content, created_at, metadata, trust, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const tombstone = db.prepare('UPDATE entries SET forgotten_at = ? WHERE agent_id = ? AND id = ? AND forgotten_at IS NULL');
  const relabel = db.prepare('UPDATE entries SET trust = ? WHERE agent_id = ? AND id = ? AND forgotten_at IS NULL');

  const liveEntries = (agentId: string): MemoryEntry[] =>
    (selectLive.all(agentId) as unknown as Row[]).map((row) => live(toEntry(row)));

  return {
    async append(agentId, content, metadata?, provenance?: MemoryProvenance) {
      assertMemoryContentWithinCap(content);
      const createdAt = now().toISOString();
      // The sequence is read and written in one transaction, so two
      // appends on one connection can never claim one id.
      db.exec('BEGIN IMMEDIATE');
      try {
        const seq = (nextSeq.get() as { next: number }).next;
        const id = `${agentId}:memory:${String(seq).padStart(12, '0')}`;
        insert.run(
          seq,
          id,
          agentId,
          content,
          createdAt,
          metadata ? JSON.stringify(metadata) : null,
          provenance?.trust ?? null,
          provenance?.origin ? JSON.stringify(provenance.origin) : null,
        );
        db.exec('COMMIT');
        return {
          id,
          agentId,
          content,
          createdAt,
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
      const entries = liveEntries(agentId);
      if (listOptions.limit === undefined) {
        return { entries: entries.sort(compareMemoryChronology), truncated: false };
      }
      return boundMemoryList(entries, listOptions.limit);
    },

    async search(agentId, query, limit?) {
      const tokens = tokenizeMemoryText(query);
      if (tokens.length === 0) {
        return { entries: [], truncated: false };
      }
      const matches = liveEntries(agentId).filter((entry) => memoryQueryMatches(entry.content, tokens));
      return boundMemoryRead(matches, clampMemoryRecallLimit(limit));
    },

    async forget(agentId, entryId) {
      return tombstone.run(now().toISOString(), agentId, entryId).changes > 0;
    },

    async audit(agentId) {
      return (selectAgent.all(agentId) as unknown as Row[]).map(toEntry).sort(compareMemoryChronology);
    },

    async reassertTrust(agentId, entryId, trust) {
      return relabel.run(trust, agentId, entryId).changes > 0;
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
      context.memory.register({ name: SQLITE_MEMORY_STORE_NAME, store });
    },
    dispose() {
      store?.close();
      store = undefined;
    },
  };
};

/** The loader's entry point. See docs/architecture/plugins.md. */
export const createPlugin = (config: JsonObject): Plugin => createSqliteMemoryPlugin(config);
