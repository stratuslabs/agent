/*
 * The memory file's record model: the four kinds of line a memory JSONL
 * holds (entries, tombstones, re-assertions and pins), how a file's text
 * parses into them, and how an agent's live entries, re-asserted trust and
 * pin budget are derived from them. Pure functions over parsed records:
 * the file store in `memory.ts` reads and appends, and the derived index in
 * `memory-index.ts` replays the same records into SQLite.
 */
import {
  applyMemoryPinBudget,
  isTrustLevel,
  memoryContentByteLength,
  type MemoryEntry,
  memoryEntryFields,
  type MemoryOrigin,
  supersededMemoryIdsAt,
  type TrustLevel,
} from '@stratusagent/core';

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

export type MemoryRecord = MemoryEntry | MemoryTombstone | MemoryReassertion | MemoryPin;

export interface MemoryFileRecords {
  entries: MemoryEntry[];
  tombstones: MemoryTombstone[];
  reassertions: MemoryReassertion[];
  /** In file order, which is the order the pin budget is allocated in. */
  pins: MemoryPin[];
}

export const isTombstoneRecord = (value: unknown): value is MemoryTombstone =>
  typeof value === 'object' && value !== null && typeof (value as MemoryTombstone).forgets === 'string'
  && typeof (value as MemoryTombstone).agentId === 'string'
  && typeof (value as MemoryTombstone).createdAt === 'string';

export const isPinRecord = (value: unknown): value is MemoryPin =>
  typeof value === 'object' && value !== null && typeof (value as MemoryPin).pins === 'string'
  && typeof (value as MemoryPin).agentId === 'string'
  && typeof (value as MemoryPin).pinned === 'boolean'
  && typeof (value as MemoryPin).createdAt === 'string';

export const isReassertionRecord = (value: unknown): value is MemoryReassertion =>
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
export const provenanceOf = (entry: MemoryEntry): Pick<MemoryEntry, 'trust' | 'origin'> => {
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

/** A whole record found between the zeros of a torn line, if the piece is one. */
const tornPieceRecord = (piece: string): MemoryRecord | undefined => {
  if (piece.trim().length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(piece);
  } catch {
    return undefined;
  }
  return isTombstoneRecord(parsed) || isReassertionRecord(parsed) || isPinRecord(parsed) || isEntryRecord(parsed)
    ? parsed
    : undefined;
};

/** Every record in the file, in file order — the shape the index applies. */
export const parseOrderedRecords = (raw: string, filePath: string): MemoryRecord[] => {
  const ordered: MemoryRecord[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    // A NUL byte is a torn write, never a record: JSON.stringify escapes
    // U+0000, and nobody types one. A crash, or a snapshot of a running
    // volume, can keep the size an append gave the file without the data,
    // which reads back as zeros. Refusing the line would take the agent's
    // whole memory out of every turn until someone repaired the file, for
    // a record that is gone either way. The zeros can also swallow a
    // newline while a later append did land, so each piece between them
    // that is a whole record is kept, and the rest is the damage.
    if (line.includes('\u0000')) {
      for (const piece of line.split(/\u0000+/)) {
        const record = tornPieceRecord(piece);
        if (record !== undefined) {
          ordered.push(record);
        }
      }
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

export const parseMemoryRecords = (raw: string, filePath: string): MemoryFileRecords => {
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
export const recordedAt = (value: string): number | undefined => {
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : at;
};

const notOlderThan = (candidate: string, current: string): boolean => {
  const at = recordedAt(candidate);
  const against = recordedAt(current);
  return at === undefined || against === undefined ? true : at >= against;
};

export const reassertedTrustFor = (records: MemoryFileRecords, agentId: string): Map<string, TrustLevel> => {
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
export const presentEntry = (entry: MemoryEntry, reasserted: Map<string, TrustLevel>): MemoryEntry => {
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
export const liveEntriesFor = (records: MemoryFileRecords, agentId: string, at: Date): MemoryEntry[] => {
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
export const pinnedIdsFor = (records: MemoryFileRecords, agentId: string): string[] => {
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
export const pinBudgetFor = (
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
