import { appendFile, chmod, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  MEMORY_PASS_METADATA_KEY,
  type AgentMemoryStore,
  type MemoryAuditEntry,
  type MemoryEntry,
  type MemoryPassKind,
  type MemoryPassMode,
  type MemoryPassStatus,
} from '@stratusagent/core';
import { assertDerivedStatePath } from '@stratusagent/permissions';

import { memoryAppendNeedsNewline } from './memory.ts';
import { agentStateDirIn } from './paths.ts';

/**
 * The memory pass ledger (spec 962): what upkeep did for one agent, and the
 * only place its watermarks live. Append-only JSONL beside `memory.jsonl`,
 * one record per line, and never any content: ids, times, counts.
 *
 * Watermarks live here rather than in session metadata so a pass never
 * competes with a turn saving its session.
 */
export const MEMORY_PASSES_FILENAME = 'memory-passes.jsonl';
/** What a shadow pass would have written. Facts, the same class as `memory.jsonl`. */
export const MEMORY_SHADOW_FILENAME = 'memory-shadow.jsonl';

export const agentMemoryPassesFileIn = (stateDir: string, agentId: string): string =>
  path.join(agentStateDirIn(stateDir, agentId), MEMORY_PASSES_FILENAME);

export const agentMemoryShadowFileIn = (stateDir: string, agentId: string): string =>
  path.join(agentStateDirIn(stateDir, agentId), MEMORY_SHADOW_FILENAME);

/**
 * The messages a save pass was handed, by message id, oldest first. `cut`
 * names a message too big for a slice that went in cut to fit, and how many
 * bytes of it were left out, so the loss is visible and the watermark still
 * moves past it.
 */
export interface MemoryPassSlice {
  from: string;
  to: string;
  count: number;
  cut?: { messageId: string; bytesOmitted: number };
}

/**
 * - `start` / `stop`: one pair per daemon run per mode, the span upkeep was
 *   on (an activation). A crash writes no stop.
 * - `claim`: written before a pass's first model call. A save pass names its
 *   session and slice; a tidy pass its group key and a hash of the chunk's
 *   member ids.
 * - `end`: how the pass ended. `released` gives the claim back, so the next
 *   pass reads that slice again; only a pass that wrote nothing releases.
 *
 * `run` is the daemon run that wrote the record, so a crashed run's span can
 * be told from the run that settled it afterwards.
 */
export type MemoryPassRecord =
  | { type: 'start'; at: string; run: string; mode: MemoryPassMode }
  | { type: 'stop'; at: string; run: string; mode: MemoryPassMode }
  | {
    type: 'claim';
    at: string;
    run: string;
    passId: string;
    kind: MemoryPassKind;
    mode: MemoryPassMode;
    model: string;
    sessionId?: string;
    slice?: MemoryPassSlice;
    group?: { key: string; hash: string };
  }
  | {
    type: 'end';
    at: string;
    run: string;
    passId: string;
    status: MemoryPassStatus;
    reason?: string;
    saved: number;
    superseded: number;
    more?: boolean;
    tokens?: { input: number; output: number };
    released: boolean;
  };

export type MemoryPassClaim = Extract<MemoryPassRecord, { type: 'claim' }>;
export type MemoryPassEnd = Extract<MemoryPassRecord, { type: 'end' }>;

const MODES: readonly string[] = ['write', 'shadow'];
const KINDS: readonly string[] = ['save', 'tidy'];
const STATUSES: readonly string[] = ['done', 'nothing-new', 'skipped', 'failed', 'interrupted'];

const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

/**
 * Whether a parsed line is a record this build wrote. Anything else (a
 * hand-edit, a torn line, a record from a newer build) is skipped rather than
 * half-read: a claim missing its slice must not read as one that moved a
 * watermark.
 */
const isRecord = (value: unknown): value is MemoryPassRecord => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (!isString(record.at) || !isString(record.run)) {
    return false;
  }
  switch (record.type) {
    case 'start':
    case 'stop':
      return MODES.includes(record.mode as string);
    case 'claim': {
      if (!isString(record.passId) || !KINDS.includes(record.kind as string)
        || !MODES.includes(record.mode as string) || typeof record.model !== 'string') {
        return false;
      }
      const slice = record.slice as Record<string, unknown> | undefined;
      if (slice !== undefined && (typeof slice !== 'object' || slice === null
        || !isString(slice.from) || !isString(slice.to) || !isCount(slice.count))) {
        return false;
      }
      return record.kind !== 'save' || (isString(record.sessionId) && slice !== undefined);
    }
    case 'end':
      return isString(record.passId) && STATUSES.includes(record.status as string)
        && isCount(record.saved) && isCount(record.superseded) && typeof record.released === 'boolean';
    default:
      return false;
  }
};

export interface MemoryPassLedgerOptions {
  /**
   * The home, when the file sits in an agent's own directory: the directory
   * is then made owner-only and no component may be a link. See
   * `FileMemoryStoreOptions.stateHome`.
   */
  stateHome?: string;
}

export interface MemoryPassLedger {
  /** Every record, in the order written. No file reads as nothing run. */
  read(): Promise<MemoryPassRecord[]>;
  /** One record, one `O_APPEND` line. */
  append(record: MemoryPassRecord): Promise<void>;
}

export const createMemoryPassLedger = (filePath: string, options: MemoryPassLedgerOptions = {}): MemoryPassLedger => {
  const assertOwned = async (): Promise<void> => {
    if (options.stateHome !== undefined) {
      await assertDerivedStatePath(options.stateHome, filePath, 'file');
    }
  };
  return {
    async read() {
      await assertOwned();
      let raw: string;
      try {
        raw = await readFile(filePath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return [];
        }
        throw error;
      }
      const records: MemoryPassRecord[] = [];
      for (const line of raw.split('\n')) {
        if (line.trim().length === 0) {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (isRecord(parsed)) {
          records.push(parsed);
        }
      }
      return records;
    },
    async append(record) {
      await assertOwned();
      const dir = path.dirname(filePath);
      await mkdir(dir, { recursive: true, ...(options.stateHome !== undefined ? { mode: 0o700 } : {}) });
      if (options.stateHome !== undefined) {
        await chmod(dir, 0o700);
      }
      try {
        await chmod(filePath, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
      // A torn last line would fuse with this record; see memoryAppendNeedsNewline.
      const prefix = (await memoryAppendNeedsNewline(filePath)) ? '\n' : '';
      await appendFile(filePath, `${prefix}${JSON.stringify(record)}\n`, { mode: 0o600 });
    },
  };
};

/** A span when upkeep was on for one mode. No `to`: still on, in the current run. */
export interface MemoryPassActivation {
  mode: MemoryPassMode;
  run: string;
  from: string;
  to?: string;
}

/**
 * The activations of one mode, oldest first. A start and its stop make one.
 * A run with a start and no stop crashed (or is `currentRun`, still going):
 * a crashed run's span ends at the last record that run wrote, in either
 * mode, since that is the last time anything proves the daemon was up. A
 * settle the next run writes carries the next run's id, so it does not
 * stretch the crashed span. Without `currentRun` (a reader outside the
 * daemon) every run counts as ended.
 */
export const memoryPassActivations = (
  records: readonly MemoryPassRecord[],
  mode: MemoryPassMode,
  currentRun?: string,
): MemoryPassActivation[] => {
  const lastAt = new Map<string, string>();
  for (const record of records) {
    lastAt.set(record.run, record.at);
  }
  const activations: MemoryPassActivation[] = [];
  const open = new Map<string, MemoryPassActivation>();
  for (const record of records) {
    if ((record.type !== 'start' && record.type !== 'stop') || record.mode !== mode) {
      continue;
    }
    if (record.type === 'start') {
      if (!open.has(record.run)) {
        const activation: MemoryPassActivation = { mode, run: record.run, from: record.at };
        open.set(record.run, activation);
        activations.push(activation);
      }
      continue;
    }
    const activation = open.get(record.run);
    if (activation !== undefined && activation.to === undefined) {
      activation.to = record.at;
    }
  }
  for (const activation of activations) {
    if (activation.to === undefined && activation.run !== currentRun) {
      activation.to = lastAt.get(activation.run) ?? activation.from;
    }
  }
  return activations;
};

/**
 * Whether a message, by its `createdAt`, was written while upkeep was on.
 * A time that does not parse is outside every activation: fail closed.
 */
export const memoryPassMessageCounts = (
  activations: readonly MemoryPassActivation[],
): ((createdAt: string) => boolean) => {
  const spans = activations.map((activation) => ({
    from: Date.parse(activation.from),
    to: activation.to === undefined ? Number.POSITIVE_INFINITY : Date.parse(activation.to),
  }));
  return (createdAt) => {
    const at = Date.parse(createdAt);
    if (Number.isNaN(at)) {
      return false;
    }
    return spans.some((span) => at >= span.from && at <= span.to);
  };
};

const endsByPass = (records: readonly MemoryPassRecord[]): Map<string, MemoryPassEnd> => {
  const ends = new Map<string, MemoryPassEnd>();
  for (const record of records) {
    if (record.type === 'end' && !ends.has(record.passId)) {
      ends.set(record.passId, record);
    }
  }
  return ends;
};

/**
 * The id of the last message a save pass of this mode has taken from the
 * session, or undefined when none has. Taken means a claim that was kept:
 * its pass wrote something or finished, or it has no end yet (running, or
 * left by a crash and not settled). A released claim gave its slice back.
 */
export const memoryPassWatermark = (
  records: readonly MemoryPassRecord[],
  mode: MemoryPassMode,
  sessionId: string,
): string | undefined => {
  const ends = endsByPass(records);
  let watermark: string | undefined;
  for (const record of records) {
    if (record.type !== 'claim' || record.mode !== mode || record.kind !== 'save'
      || record.sessionId !== sessionId || record.slice === undefined) {
      continue;
    }
    if (ends.get(record.passId)?.released === true) {
      continue;
    }
    watermark = record.slice.to;
  }
  return watermark;
};

/** Claims of this mode with no end: a pass running now, or one a crash cut off. */
export const memoryPassOpenClaims = (
  records: readonly MemoryPassRecord[],
  mode: MemoryPassMode,
): MemoryPassClaim[] => {
  const ends = endsByPass(records);
  return records.filter((record): record is MemoryPassClaim =>
    record.type === 'claim' && record.mode === mode && !ends.has(record.passId));
};

/**
 * The end record that settles a claim a stop or crash left open, from the
 * entries carrying its pass id (`memoryPassEntries`), never from a counter:
 * any entry means the slice was used and the claim is kept, so it is never
 * re-run; none means it is released, so a routine restart drops nothing.
 */
export const memoryPassSettleRecord = (
  claim: MemoryPassClaim,
  written: readonly MemoryEntry[],
  at: { at: string; run: string },
): MemoryPassEnd => ({
  type: 'end',
  at: at.at,
  run: at.run,
  passId: claim.passId,
  status: 'interrupted',
  saved: written.length,
  superseded: written.filter((entry) => typeof entry.supersedes === 'string').length,
  released: written.length === 0,
});

const passIdOf = (entry: MemoryAuditEntry): string | undefined => {
  const marker = entry.metadata?.[MEMORY_PASS_METADATA_KEY];
  if (typeof marker !== 'object' || marker === null || Array.isArray(marker)) {
    return undefined;
  }
  const id = (marker as Record<string, unknown>).id;
  return typeof id === 'string' ? id : undefined;
};

/** Every entry a pass wrote, forgotten ones included, oldest first. */
export const memoryPassEntries = async (
  store: AgentMemoryStore,
  agentId: string,
  passId: string,
): Promise<MemoryAuditEntry[]> =>
  (await store.audit(agentId)).filter((entry) => passIdOf(entry) === passId);

/**
 * `stratus memory undo-pass`: forget every live entry the pass wrote. A
 * forget is append-only, and supersession is computed from entries that
 * are not forgotten, so whatever a forgotten entry replaced is live again.
 *
 * Newest first, and again until a round forgets nothing: a store forgets
 * only a live entry, so when the pass superseded its own earlier entry,
 * that one can be forgotten only after its successor is.
 */
export const undoMemoryPass = async (
  store: AgentMemoryStore,
  agentId: string,
  passId: string,
): Promise<{ forgotten: string[] }> => {
  const forgotten: string[] = [];
  for (;;) {
    const remaining = (await memoryPassEntries(store, agentId, passId))
      .filter((entry) => entry.forgottenAt === undefined)
      .reverse();
    let progressed = false;
    for (const entry of remaining) {
      if (await store.forget(agentId, entry.id)) {
        forgotten.push(entry.id);
        progressed = true;
      }
    }
    if (!progressed) {
      return { forgotten };
    }
  }
};
