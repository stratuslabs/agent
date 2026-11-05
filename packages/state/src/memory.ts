import { randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { assertDerivedStatePath } from '@stratusagent/permissions';

import {
  assertMemoryAboutWithinCap,
  assertMemoryContentWithinCap,
  assertSupersedableMemoryEntry,
  boundMemoryList,
  boundMemoryRead,
  boundRankedMemoryRead,
  clampMemoryRecallLimit,
  collectMemoryTopics,
  compareMemoryChronology,
  effectiveMemoryValidityAt,
  importableMemoryEntry,
  isMemoryEntryCurrent,
  isMemoryRankingStrategy,
  isTrustLevel,
  memoryContentByteLength,
  memoryEntryFields,
  memorySupersedesWriteIds,
  assertUnprotectedMemoryTargets,
  MEMORY_PINNED_MAX_BYTES,
  MEMORY_READ_MAX_BYTES,
  pinnedCapRefusal,
  pinnedInertRefusal,
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

import { serializeFileWrite } from './file-lock.ts';
import {
  applyRecords,
  clearIndex,
  digestOf,
  INDEX_SCHEMA,
  INDEX_SCHEMA_VERSION,
  type IndexWatermark,
  loadSqlite,
  rankedOrder,
  readWatermark,
  type SqliteDatabase,
  writeWatermark,
} from './memory-index.ts';
import {
  liveEntriesFor,
  type MemoryFileRecords,
  type MemoryRecord,
  parseMemoryRecords,
  parseOrderedRecords,
  pinBudgetFor,
  pinnedIdsFor,
  presentEntry,
  provenanceOf,
  reassertedTrustFor,
} from './memory-records.ts';

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
  /**
   * How long a guarded append, a pin or a re-assertion waits for another
   * process holding the memory write lock before giving up and writing
   * nothing. Default `MEMORY_WRITE_LOCK_WAIT_MS`.
   */
  lockWaitMs?: number;
}

/**
 * The longest a memory write waits on another process's. Each holds the
 * lock for one read of the file and one append, so anything longer is a
 * stuck process, and the daemon's thread waits with it.
 */
export const MEMORY_WRITE_LOCK_WAIT_MS = 2_000;

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

  /**
   * The memory write lock, beside the file: a guarded append, a pin and a
   * re-assertion each read the record and append under it, so none of them
   * decides from a record another is about to change. That is what lets a
   * memory pass's merge and an operator's `stratus memory pin` (another
   * process) land one wholly before the other. Ordinary appends and
   * forgets don't take it: they change nothing these three check.
   */
  const lockPath = `${filePath}.lock`;
  const underWriteLock = async <T>(work: () => Promise<T>): Promise<T> => {
    await ensureDirectory();
    return serializeFileWrite(lockPath, work, { waitMs: options.lockWaitMs ?? MEMORY_WRITE_LOCK_WAIT_MS });
  };

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
      const columns = (name: string): Array<{ name: string; pk: number }> =>
        opened.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string; pk: number }>;
      const hasCurrentShape = (): boolean => {
        return columns('memory_fts').some((column) => column.name === 'fields')
          && columns('reasserted').some((column) => column.name === 'recorded_at')
          && columns('revisions').some((column) => column.name === 'agent_id' && column.pk > 0)
          && columns('usage').some((column) => column.name === 'agent_id' && column.pk > 0)
          && columns('reasserted').some((column) => column.name === 'agent_id' && column.pk > 0);
      };
      // A merge names several targets, one row each, which a key without
      // `target_id` collapses into one (schema '8').
      const revisionsKeyedByTarget = (): boolean =>
        columns('revisions').some((column) => column.name === 'target_id' && column.pk > 0);
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
      } else if (!revisionsKeyedByTarget()) {
        // Only `revisions` changed, so only it is replaced: `usage`, the one
        // table a rebuild cannot restore, is kept. The stale stamp makes the
        // next catch-up clear the derived rows and re-read the whole record,
        // which fills the new table. Locked and re-checked like the drop above.
        opened.exec('BEGIN IMMEDIATE;');
        try {
          if (!revisionsKeyedByTarget()) {
            opened.exec('DROP TABLE revisions;');
            opened.exec(INDEX_SCHEMA);
            opened.exec(`UPDATE meta SET value = '0' WHERE key = 'schema_version';`);
          }
          opened.exec('COMMIT;');
        } catch (error) {
          try {
            opened.exec('ROLLBACK;');
          } catch {
            // As above: the original error is the one worth reporting.
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
  // The stat-only shortcut trusts that bytes with an unchanged inode, size
  // and mtime are the bytes indexed. Within one process that holds. Across
  // a crash or a restored snapshot it need not: SQLite flushes the index,
  // the JSONL append may not have reached the disk, and the lost bytes read
  // back as zeros under the same stat. So the first catch-up in a process
  // reads and digests the file before it trusts the index.
  let digestChecked = false;

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
      digestChecked
      && snapshot.schema === INDEX_SCHEMA_VERSION
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

    if (
      pureAppend
      && consumedEnd === base.offset
      && snapshot.schema === INDEX_SCHEMA_VERSION
      && String(fileStat.ino) === base.inode
      && String(fileStat.mtimeMs) === base.mtimeMs
    ) {
      // The first look this process takes, and the bytes are the ones indexed.
      return { action: 'none', clear: false, records: [], watermark: base };
    }
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
        digestChecked = true;
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
        digestChecked = true;
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

  /** `pin`'s check and write, run under the memory write lock. */
  const pinUnderLock = async (agentId: string, entryId: string): Promise<MemoryPinOutcome> => {
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
    // under the write lock two pins from this build cannot both read this
    // total, but a build older than the lock takes none, and two processes
    // at the limit could both append. `applyMemoryPinBudget` decides that
    // race deterministically on replay, so the losing pin is recorded and
    // inert rather than silently evicting one that was already effective.
    if (bytes + size > MEMORY_PINNED_MAX_BYTES) {
      return { pinned: false, reason: pinnedCapRefusal(bytes, size), bytes };
    }
    await appendRecord({ pins: entry.id, agentId: entry.agentId, pinned: true, createdAt: now().toISOString() });
    return { pinned: true, bytes: bytes + size };
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
      const supersedes = memorySupersedesWriteIds(appendOptions);
      const fields = memoryEntryFields(appendOptions);
      assertMemoryAboutWithinCap(fields.about ?? []);
      const write = async (): Promise<MemoryEntry> => {
        if (supersedes.length > 0) {
          const records = await readRecords();
          const live = liveEntriesFor(records, agentId, now());
          for (const id of supersedes) {
            assertSupersedableMemoryEntry(live, id);
          }
          if (appendOptions.refuseProtected === true) {
            assertUnprotectedMemoryTargets(supersedes, live, new Set(pinnedIdsFor(records, agentId)));
          }
        }
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
      };
      return appendOptions.refuseProtected === true && supersedes.length > 0 ? underWriteLock(write) : write();
    },

    async list(agentId: string, listOptions: MemoryListOptions = {}) {
      const at = now();
      const live = liveEntriesFor(await readRecords(), agentId, at);
      // Out of its validity window is not out of the record: `all` is what
      // the operator's views read, so an expired fact can be shown *as*
      // expired rather than vanishing.
      const current = listOptions.validity === 'all'
        ? live
        : live.filter((entry) => effectiveMemoryValidityAt(entry, at) === 'current');
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
      const tokens = [...new Set(tokenizeMemoryText(query))];
      // All three orderings are served here; see `rankedOrder` for what
      // `relevance` and `hybrid` mean. `recency` stays the default and the
      // one the parity tests hold the two stores to.
      // Checked, not trusted: a plugin or a hand-written caller passing some
      // other string gets the default rather than an ordering nobody named.
      const strategy: MemoryRankingStrategy = isMemoryRankingStrategy(searchOptions.strategy) ? searchOptions.strategy : 'recency';
      if (tokens.length === 0) {
        return { entries: [], truncated: false, strategy };
      }
      const database = await withIndexLock(async () => {
        const opened = await openIndex();
        await ensureIndexCurrent(opened);
        return opened;
      });
      const clamped = clampMemoryRecallLimit(searchOptions.limit);
      // A recency read needs every word, or a query with one common word in
      // it would return the newest fact that happens to share it. A ranked
      // read takes any of them, because the ranking is what puts the facts
      // holding every word first, then those carrying more of the words and
      // the rarer ones.
      const quoted = tokens.map((token) => `"${token}"`);
      const everyWord = quoted.join(' ');
      const match = strategy === 'recency' ? everyWord : quoted.join(' OR ');
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
      const order = strategy === 'recency' ? { sql: '', params: [] } : rankedOrder(strategy, everyWord, at);
      const rows = database.prepare(
        `SELECT id, agent_id, content, created_at, trust, origin, fields ${admissible}`
        + ` ORDER BY ${order.sql}created_at DESC, id ASC LIMIT ?`,
      ).all(match, agentId, agentId, at, at, MEMORY_READ_MAX_BYTES, ...order.params, clamped + 1) as {
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
      // The rows are already in the order asked for; a recency read is
      // re-sorted by the shared rule anyway, which is what it always did.
      const bounded = strategy === 'recency' ? boundMemoryRead(candidates, clamped) : boundRankedMemoryRead(candidates, clamped);
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
      return underWriteLock(async () => {
        const live = liveEntriesFor(await readRecords(), agentId, now());
        const entry = live.find((candidate) => candidate.id === entryId);
        if (!entry) {
          return false;
        }
        await appendRecord({ reasserts: entry.id, agentId: entry.agentId, trust, createdAt: now().toISOString() });
        return true;
      });
    },

    pin(agentId: string, entryId: string): Promise<MemoryPinOutcome> {
      return underWriteLock(() => pinUnderLock(agentId, entryId));
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
      // clock, and comes back the moment its window opens. The pin's own
      // window, not the episodic default: pinning is how an agent says a
      // note is still current.
      const live = new Set(liveEntriesFor(records, agentId, at).map((entry) => entry.id));
      return pins
        .filter((entry) => live.has(entry.id) && isMemoryEntryCurrent(entry, at))
        .sort(compareMemoryChronology);
    },

    async topics(agentId: string): Promise<MemoryTopic[]> {
      const at = now();
      const live = liveEntriesFor(await readRecords(), agentId, at);
      return collectMemoryTopics(live.filter((entry) => effectiveMemoryValidityAt(entry, at) === 'current'));
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
