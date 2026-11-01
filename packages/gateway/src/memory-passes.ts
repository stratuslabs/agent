import { createHash, randomUUID } from 'node:crypto';

import { createMemoryPassTools, isValidAgentId, type MemoryPassToolState, type MemoryPassWrite } from '@stratusagent/agents';
import {
  assertMemoryAboutWithinCap,
  conversationContextFrom,
  HostRefusalError,
  isMemoryPassSessionId,
  MEMORY_ENTRY_MAX_BYTES,
  MEMORY_PASS_SLICE_MAX_BYTES,
  MEMORY_SAVE_PASS_INSTRUCTION,
  MEMORY_SAVE_PASS_REQUEST,
  MEMORY_TIDY_CHUNK_MAX_BYTES,
  MEMORY_TIDY_GROUP_MIN,
  MEMORY_TIDY_PASS_INSTRUCTION,
  MEMORY_TIDY_PASS_REQUEST,
  memoryEntryAbout,
  memoryEntryFields,
  memoryEntryTrust,
  memoryPassSessionId,
  sessionWriteTrust,
  transcriptEntry,
  type AgentMemoryStore,
  type ConversationKind,
  type MemoryAuditEntry,
  type MemoryEntry,
  type MemoryPassHandle,
  type MemoryPassKind,
  type MemoryPassMode,
  type MemoryPassOutcome,
  type MemoryPassReason,
  type MemoryPassRequest,
  type Message,
  type Session,
  type StratusEvent,
  type Tool,
  type TrustLevel,
} from '@stratusagent/core';
import {
  agentMemoryPassesFileIn,
  agentMemoryShadowFileIn,
  createMemoryPassLedger,
  createMemoryShadowFile,
  memoryPassActivations,
  memoryPassEntries,
  memoryPassMessageCounts,
  memoryPassOpenClaims,
  memoryPassSettleRecord,
  memoryPassSummaries,
  memoryPassTidyClaimed,
  memoryPassWatermark,
  memoryShadowEntriesOf,
  type MemoryPassClaim,
  type MemoryPassEnd,
  type MemoryPassLedger,
  type MemoryPassSlice,
  type MemoryPassSummary,
  type MemoryShadowEntry,
  type MemoryShadowFile,
} from '@stratusagent/state';

/** What the host hands a pass's one model run. */
export interface MemoryPassModelRun {
  agentId: string;
  passId: string;
  /** The pass's own session, never stored: `memoryPassSessionId(passId)`. */
  sessionId: string;
  /** Exactly this model, with no fallback. */
  model: string | undefined;
  /** The one message: the request, the conversation, the instruction. */
  prompt: string;
  /** The label the pass session starts at: the slice's. */
  trust: TrustLevel;
  /** Only these: the pass's recall and remember. */
  tools: Tool[];
  signal: AbortSignal;
}

/** What the memory pass host needs from the gateway. */
export interface MemoryPassHostOptions {
  stateDir: string;
  /** The home, so the ledger and shadow files are owner-only. */
  stateHome?: string;
  /** This daemon run's id, written on every ledger record. */
  run: string;
  memory: AgentMemoryStore | undefined;
  /**
   * Whether the selected store takes a list in `supersedes`, so a pass may
   * merge several facts into one. Asked per pass: the store is chosen once
   * the plugins have loaded. Default: no.
   */
  supersedesMany?: () => boolean;
  sessions: { get(id: string): Promise<Session | undefined> };
  /**
   * The session's single-flight chain: whether it is idle now, and a way
   * to queue one step on it. The idle check and the queueing happen in
   * the same tick, so nothing gets between them.
   */
  chain: {
    idle(sessionId: string): boolean;
    queue<T>(sessionId: string, work: () => Promise<T>): Promise<T>;
  };
  hasAgent(agentId: string): boolean;
  isSubAgentSession(session: Session): boolean;
  /** The model the agent runs on, for a request that names none. */
  defaultModel(agentId: string): Promise<string | undefined>;
  /** Runs the pass's model turn; rejects when it fails. */
  runModel(run: MemoryPassModelRun): Promise<void>;
  emit(event: StratusEvent): void;
  log(line: string): void;
  now?: () => Date;
  passId?: () => string;
}

/** One pass and the facts it wrote, or in shadow would have, oldest first. */
export interface MemoryPassDetail {
  pass: MemoryPassSummary;
  /** Write mode: from the agent's memory, forgotten ones included. Shadow: from `memory-shadow.jsonl`. */
  entries: Array<MemoryAuditEntry | MemoryShadowEntry>;
}

export interface MemoryPassHost {
  handle: MemoryPassHandle;
  /** The agent's passes from its ledger, newest first. No ledger reads as none. */
  passes(agentId: string): Promise<MemoryPassSummary[]>;
  /** One pass and what it wrote; undefined when the ledger has no claim for it. */
  pass(agentId: string, passId: string): Promise<MemoryPassDetail | undefined>;
  /**
   * The daemon has loaded its agents and chosen its memory store. Plugins
   * are set up before either, and the spec has the upkeep plugin call
   * `start` from its setup, so until this a start takes any well-formed
   * agent id, writes its start record, and leaves the claims a crash left
   * open to be settled here: settling reads what a claim wrote, from the
   * store this daemon uses, which is not chosen until now. A save pass asked
   * for before this is skipped as `not-started`. Resolves once those
   * settles are written; never rejects.
   */
  ready(): Promise<void>;
  /**
   * The daemon is stopping: refuse new passes, abort running ones (they are
   * low priority and do not hold the drain), settle them, then write a stop
   * record for every agent and mode started in this run.
   */
  close(): Promise<void>;
}

const MODES: readonly string[] = ['write', 'shadow'];
const KINDS: readonly string[] = ['direct', 'group', 'private', 'public'];
const SCHEDULED_METADATA_KEY = 'scheduled';

/**
 * What a save pass shows the model of each message: whole, apart from a
 * tool call's input, which says what was done rather than what was learned.
 * The slice's byte cap is what bounds it.
 */
const SAVE_PASS_ENTRY_LIMITS = { message: Number.POSITIVE_INFINITY, toolResult: Number.POSITIVE_INFINITY, toolInput: 500 };

const utf8 = (text: string): number => Buffer.byteLength(text, 'utf8');

/** The first `bytes` of `text`, never splitting a character. */
const firstBytes = (text: string, bytes: number): string => {
  const cut = Buffer.from(text, 'utf8').subarray(0, Math.max(0, bytes)).toString('utf8');
  return cut.endsWith('�') && !text.startsWith(cut) ? cut.slice(0, -1) : cut;
};

export interface SaveSlice {
  /** The rendered entries, oldest first. */
  entries: string[];
  slice: MemoryPassSlice;
  /** Counted messages wait past this slice. */
  more: boolean;
}

/**
 * The messages a save pass reads next (spec 962): after the watermark,
 * written while upkeep was on, oldest first, up to about
 * `MEMORY_PASS_SLICE_MAX_BYTES`. A message alone over the cap goes in a
 * slice of its own, cut to fit, and the slice says how much was left out,
 * so the watermark always moves. Undefined when nothing is new.
 */
export const takeSaveSlice = (
  messages: readonly Message[],
  watermark: string | undefined,
  counts: (createdAt: string) => boolean,
  maxBytes: number = MEMORY_PASS_SLICE_MAX_BYTES,
): SaveSlice | undefined => {
  // A watermark that names no message in the session (it cannot happen
  // while messages are never deleted) reads from the start: the activation
  // filter still holds, and the rules have the pass recall before saving.
  const after = watermark === undefined ? 0 : messages.findIndex((message) => message.id === watermark) + 1;
  const pending = messages.slice(after).filter((message) => counts(message.createdAt));
  if (pending.length === 0) {
    return undefined;
  }
  const entries: string[] = [];
  let bytes = 0;
  let taken = 0;
  let cut: MemoryPassSlice['cut'];
  for (const message of pending) {
    const entry = transcriptEntry(message, SAVE_PASS_ENTRY_LIMITS);
    const size = utf8(entry) + (entries.length > 0 ? 1 : 0);
    if (taken === 0 && size > maxBytes) {
      const kept = firstBytes(entry, maxBytes);
      const omitted = utf8(entry) - utf8(kept);
      entries.push(`${kept}\n[The runtime left out the last ${omitted} bytes of this message.]`);
      cut = { messageId: message.id, bytesOmitted: omitted };
      taken = 1;
      break;
    }
    if (bytes + size > maxBytes) {
      break;
    }
    entries.push(entry);
    bytes += size;
    taken += 1;
  }
  const last = pending[taken - 1]!;
  return {
    entries,
    slice: { from: pending[0]!.id, to: last.id, count: taken, ...(cut !== undefined ? { cut } : {}) },
    more: taken < pending.length,
  };
};

/** The save pass's one message: the request, the conversation in tags, the instruction after it. */
export const saveSlicePrompt = (entries: readonly string[]): string =>
  `${MEMORY_SAVE_PASS_REQUEST}\n\n<conversation>\n${entries.join('\n')}\n</conversation>\n\n${MEMORY_SAVE_PASS_INSTRUCTION}`;

export interface TidyChunk {
  /** `kind/label/about`, the about key folded: what the ledger names the group by. */
  key: string;
  /** The group's label: the pass starts at it, recalls only it, and writes it. */
  trust: TrustLevel;
  /** The facts handed over, oldest first. */
  members: MemoryEntry[];
  /** One JSON object a line, for the `<facts>` tags. */
  lines: string[];
  /** SHA-256 of the sorted member ids: what a later pass of the mode skips. */
  hash: string;
  /** Another chunk, of this group or another, waits after this one. */
  more: boolean;
}

/**
 * A fact as a tidy pass reads it: data, not prose. `<` is escaped so no
 * fact's text can close the `<facts>` tag it is sent in; JSON reads it
 * back the same.
 */
const tidyLine = (entry: MemoryEntry): string =>
  JSON.stringify({
    id: entry.id,
    text: entry.content,
    ...(entry.kind !== undefined ? { kind: entry.kind } : {}),
    created: entry.createdAt,
    ...(entry.validFrom !== undefined ? { validFrom: entry.validFrom } : {}),
    ...(entry.validUntil !== undefined ? { validUntil: entry.validUntil } : {}),
  }).replace(/</g, '\\u003c');

const chunkHash = (members: readonly MemoryEntry[]): string =>
  createHash('sha256').update(members.map((entry) => entry.id).sort().join('\n')).digest('hex');

/** A group's facts in chunks of about `maxBytes`; a fact alone over it (its JSON escapes can grow it) still goes, by itself. */
const tidyChunks = (members: readonly MemoryEntry[], maxBytes: number): Array<{ members: MemoryEntry[]; lines: string[] }> => {
  const chunks: Array<{ members: MemoryEntry[]; lines: string[] }> = [];
  let current: { members: MemoryEntry[]; lines: string[] } = { members: [], lines: [] };
  let bytes = 0;
  for (const entry of members) {
    const line = tidyLine(entry);
    if (current.lines.length > 0 && bytes + 1 + utf8(line) > maxBytes) {
      chunks.push(current);
      current = { members: [], lines: [] };
      bytes = 0;
    }
    bytes += utf8(line) + (current.lines.length > 0 ? 1 : 0);
    current.members.push(entry);
    current.lines.push(line);
  }
  if (current.lines.length > 0) {
    chunks.push(current);
  }
  return chunks;
};

/**
 * The chunk a tidy pass is handed next (spec 962). A group is at least
 * `MEMORY_TIDY_GROUP_MIN` live facts sharing an about key, a kind and a
 * label, leaving out episodic facts (#961 retires those), pinned ones and
 * operator-asserted ones (no pass may supersede either). A fact with two
 * about keys counts in both groups. The largest group goes first; a group
 * over `MEMORY_TIDY_CHUNK_MAX_BYTES` goes in chunks, oldest facts first.
 * A chunk whose member ids a pass of this mode already looked at
 * (`claimed`) is passed over for the next, so a chunk that merges nothing
 * still moves the tidy on, while a merge changes the members and so the
 * chunks. Undefined when no chunk is left.
 */
export const takeTidyChunk = (
  live: readonly MemoryEntry[],
  pinned: ReadonlySet<string>,
  claimed: ReadonlySet<string>,
  maxBytes: number = MEMORY_TIDY_CHUNK_MAX_BYTES,
): TidyChunk | undefined => {
  const groups = new Map<string, { trust: TrustLevel; members: MemoryEntry[] }>();
  for (const entry of live) {
    const trust = memoryEntryTrust(entry);
    if (entry.kind === 'episodic' || trust === 'user' || pinned.has(entry.id)) {
      continue;
    }
    for (const about of memoryEntryAbout(entry)) {
      const key = `${entry.kind ?? 'none'}/${trust}/${about.normalize('NFC').toLowerCase()}`;
      const group = groups.get(key);
      if (group === undefined) {
        groups.set(key, { trust, members: [entry] });
      } else {
        group.members.push(entry);
      }
    }
  }
  const ordered = [...groups.entries()]
    .filter(([, group]) => group.members.length >= MEMORY_TIDY_GROUP_MIN)
    .sort(([a, x], [b, y]) => y.members.length - x.members.length || (a < b ? -1 : a > b ? 1 : 0));
  let taken: TidyChunk | undefined;
  for (const [key, group] of ordered) {
    const oldestFirst = group.members
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => (a.entry.createdAt < b.entry.createdAt ? -1 : a.entry.createdAt > b.entry.createdAt ? 1 : a.index - b.index))
      .map(({ entry }) => entry);
    for (const chunk of tidyChunks(oldestFirst, maxBytes)) {
      const hash = chunkHash(chunk.members);
      if (claimed.has(hash)) {
        continue;
      }
      if (taken === undefined) {
        taken = { key, trust: group.trust, ...chunk, hash, more: false };
      } else if (hash !== taken.hash) {
        taken.more = true;
        return taken;
      }
    }
  }
  return taken;
};

/** The tidy pass's one message: the request, the facts in tags, the instruction after them. */
export const tidyChunkPrompt = (lines: readonly string[]): string =>
  `${MEMORY_TIDY_PASS_REQUEST}\n\n<facts>\n${lines.join('\n')}\n</facts>\n\n${MEMORY_TIDY_PASS_INSTRUCTION}`;

class MalformedPassRequest extends Error {}

const malformed = (message: string): never => {
  throw new MalformedPassRequest(message);
};

/**
 * The gateway's `PluginContext.memoryPasses` (spec 962). A plugin decides
 * when to ask; everything a pass may read and write is decided here.
 */
export const createMemoryPassHost = (options: MemoryPassHostOptions): MemoryPassHost => {
  const now = (): string => (options.now?.() ?? new Date()).toISOString();
  const newPassId = options.passId ?? (() => randomUUID());
  const fileOptions = options.stateHome !== undefined ? { stateHome: options.stateHome } : {};
  const ledgers = new Map<string, MemoryPassLedger>();
  const shadows = new Map<string, MemoryShadowFile>();
  const ledgerFor = (agentId: string): MemoryPassLedger => {
    let ledger = ledgers.get(agentId);
    if (ledger === undefined) {
      ledger = createMemoryPassLedger(agentMemoryPassesFileIn(options.stateDir, agentId), fileOptions);
      ledgers.set(agentId, ledger);
    }
    return ledger;
  };
  const shadowFor = (agentId: string): MemoryShadowFile => {
    let shadow = shadows.get(agentId);
    if (shadow === undefined) {
      shadow = createMemoryShadowFile(agentMemoryShadowFileIn(options.stateDir, agentId), fileOptions);
      shadows.set(agentId, shadow);
    }
    return shadow;
  };

  /** `agentId\0mode` -> the start, written once per run. */
  const started = new Map<string, Promise<{ startedAt: string }>>();
  /**
   * `agentId\0mode` -> a start's settle of the claims a crash left open,
   * for a start made before `ready`. A pass for that agent and mode waits
   * for it, so it never reads a watermark the settle is about to move.
   */
  const settling = new Map<string, Promise<void>>();
  let isReady = false;
  let openReadiness!: (ready: boolean) => void;
  /** True at `ready`; false when the daemon stops first, and nothing settles. */
  const readiness = new Promise<boolean>((resolve) => {
    openReadiness = resolve;
  });
  /** Before `ready` the roster is not loaded yet, so only the id's form can be checked. */
  const knownAgent = (agentId: unknown): agentId is string =>
    typeof agentId === 'string' && (isReady ? options.hasAgent(agentId) : isValidAgentId(agentId));
  /** Agents with a pass running: one at a time each. */
  const busy = new Set<string>();
  const running = new Set<Promise<unknown>>();
  const stopAll = new AbortController();
  let closing = false;

  /** Entries a pass wrote, from the store it wrote to. */
  const writtenBy = async (
    agentId: string,
    mode: MemoryPassMode,
    passId: string,
  ): Promise<Array<MemoryAuditEntry | MemoryShadowEntry>> => {
    if (mode === 'shadow') {
      return memoryShadowEntriesOf(await shadowFor(agentId).read(), passId);
    }
    return options.memory === undefined ? [] : memoryPassEntries(options.memory, agentId, passId);
  };

  const settle = async (agentId: string, mode: MemoryPassMode, claim: MemoryPassClaim): Promise<void> => {
    const written = await writtenBy(agentId, mode, claim.passId);
    await ledgerFor(agentId).append(memoryPassSettleRecord(claim, written, { at: now(), run: options.run }));
  };

  const start: MemoryPassHandle['start'] = (agentId, mode) => {
    if (!knownAgent(agentId)) {
      return Promise.reject(new MalformedPassRequest(`memoryPasses.start: there is no agent ${String(agentId)}.`));
    }
    if (!MODES.includes(mode)) {
      return Promise.reject(new MalformedPassRequest(`memoryPasses.start: mode must be "write" or "shadow" (got ${String(mode)}).`));
    }
    if (closing) {
      return Promise.reject(new Error('memoryPasses.start: the daemon is stopping.'));
    }
    const key = `${agentId}\0${mode}`;
    const existing = started.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const begun = (async () => {
      const ledger = ledgerFor(agentId);
      // Open claims first, read before this run's start is written: the
      // settle comes after the start, so it does not stretch the crashed
      // run's span, which still ends at the claim.
      const open = memoryPassOpenClaims(await ledger.read(), mode);
      const startedAt = now();
      await ledger.append({ type: 'start', at: startedAt, run: options.run, mode });
      const settleOpen = async (): Promise<void> => {
        for (const claim of open) {
          await settle(agentId, mode, claim);
          options.log(`memory pass ${claim.passId} (${agentId}, ${mode}) was cut off by the last stop and is settled`);
        }
      };
      if (isReady) {
        await settleOpen();
        return { startedAt };
      }
      // From a plugin's setup: settled at `ready`. One that fails there
      // leaves its claims open, which reads as kept, so no slice is read
      // twice; the next start tries again.
      settling.set(key, readiness.then(async (ready) => {
        if (!ready) {
          return;
        }
        if (!options.hasAgent(agentId)) {
          options.log(`memory passes were started for ${agentId}, which this daemon has no agent for; its passes will be refused`);
        }
        await settleOpen().catch((error: unknown) => {
          options.log(`could not settle the memory passes a stop cut off for ${agentId} (${mode}): ${error instanceof Error ? error.message : String(error)}`);
        });
      }));
      return { startedAt };
    })();
    started.set(key, begun);
    // A start that failed (a ledger it could not write) can be asked again.
    begun.catch(() => {
      if (started.get(key) === begun) {
        started.delete(key);
      }
    });
    return begun;
  };

  const finish = (
    agentId: string,
    mode: MemoryPassMode,
    outcome: MemoryPassOutcome,
    kind: MemoryPassKind = 'save',
  ): MemoryPassOutcome => {
    options.emit({
      type: 'memory.pass-completed',
      sessionId: memoryPassSessionId(outcome.passId),
      agentId,
      passId: outcome.passId,
      kind,
      mode,
      status: outcome.status,
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
      saved: outcome.saved,
      superseded: outcome.superseded,
    });
    options.log(`memory pass ${outcome.passId} (${agentId}, ${kind}, ${mode}): ${outcome.status}`
      + `${outcome.reason !== undefined ? ` (${outcome.reason})` : ''}, saved ${outcome.saved}, superseded ${outcome.superseded}`);
    return outcome;
  };

  const skipped = (
    agentId: string,
    mode: MemoryPassMode,
    passId: string,
    reason: MemoryPassReason,
    kind: MemoryPassKind = 'save',
  ): MemoryPassOutcome =>
    finish(agentId, mode, { passId, status: 'skipped', reason, saved: 0, superseded: 0, more: false }, kind);

  const validSave = (request: Extract<MemoryPassRequest, { kind: 'save' }>): { from: ConversationKind[]; mode: MemoryPassMode } => {
    if (!knownAgent(request.agentId)) {
      malformed(`memoryPasses.run: there is no agent ${String(request.agentId)}.`);
    }
    if (typeof request.sessionId !== 'string' || request.sessionId.length === 0) {
      malformed('memoryPasses.run: a save pass needs a sessionId.');
    }
    if (request.reason !== 'quiet' && request.reason !== 'floor') {
      malformed(`memoryPasses.run: reason must be "quiet" or "floor" (got ${String(request.reason)}).`);
    }
    if (request.from !== undefined && (!Array.isArray(request.from) || request.from.some((kind) => !KINDS.includes(kind)))) {
      malformed(`memoryPasses.run: from may list only ${KINDS.join(', ')}.`);
    }
    if (request.model !== undefined && (typeof request.model !== 'string' || request.model.trim().length === 0)) {
      malformed('memoryPasses.run: model, when given, must name one.');
    }
    const mode = request.mode ?? 'write';
    if (!MODES.includes(mode)) {
      malformed(`memoryPasses.run: mode must be "write" or "shadow" (got ${String(mode)}).`);
    }
    return { from: request.from !== undefined ? [...request.from] : ['public'], mode };
  };

  const shadowWrite = (agentId: string): MemoryPassWrite => async (_agentId, content, appendOptions) => {
    if (utf8(content) > MEMORY_ENTRY_MAX_BYTES) {
      throw new Error(`A fact is at most ${MEMORY_ENTRY_MAX_BYTES} bytes. Nothing was stored.`);
    }
    // Normalized and capped the way the store's own append does it, so a
    // shadow fact is one a real write would have stored.
    const fields = memoryEntryFields(appendOptions);
    assertMemoryAboutWithinCap(fields.about ?? []);
    const id = `${agentId}:shadow:${randomUUID()}`;
    const trust = appendOptions.provenance?.trust ?? 'agent';
    const { provenance, metadata } = appendOptions;
    await shadowFor(agentId).append({
      id,
      agentId,
      createdAt: now(),
      content,
      trust,
      ...(provenance?.origin !== undefined ? { origin: provenance.origin } : {}),
      ...fields,
      metadata: metadata ?? {},
    });
    return { id, trust };
  };

  /**
   * An end record that cannot be written leaves its claim open, which the
   * next start settles from the entries, so the pass still answers.
   */
  const appendEnd = async (ledger: MemoryPassLedger, end: MemoryPassEnd): Promise<void> => {
    try {
      await ledger.append(end);
    } catch (error) {
      options.log(`memory pass ${end.passId}: could not write its end record (${error instanceof Error ? error.message : String(error)}); the next start settles it`);
    }
  };

  /**
   * A pass from its claim on: the one model run with only the pass's recall
   * and remember, then its end record. Shared by save and tidy.
   */
  const runClaimed = async (pass: {
    agentId: string;
    mode: MemoryPassMode;
    passId: string;
    /** Resolved once, for the claim; '' when the agent's config named none. */
    model: string;
    claim: MemoryPassClaim;
    prompt: string;
    more: boolean;
    tools: MemoryPassToolState;
    memory: AgentMemoryStore;
    signal?: AbortSignal;
  }): Promise<MemoryPassOutcome> => {
    const { agentId, mode, passId, model, claim, more } = pass;
    const kind = pass.tools.kind;
    const ledger = ledgerFor(agentId);
    const tools = createMemoryPassTools(pass.memory, pass.tools, {
      supersedesMany: options.supersedesMany?.() === true,
      ...(mode === 'shadow' ? { write: shadowWrite(agentId) } : {}),
    });
    const signal = pass.signal !== undefined ? AbortSignal.any([stopAll.signal, pass.signal]) : stopAll.signal;
    let failure: unknown;
    try {
      if (signal.aborted) {
        throw signal.reason;
      }
      await options.runModel({
        agentId,
        passId,
        sessionId: memoryPassSessionId(passId),
        // The model the claim records, resolved once: the agent's config
        // could change before this, and the ledger must name what ran.
        model: model !== '' ? model : undefined,
        prompt: pass.prompt,
        trust: pass.tools.trust,
        tools: [tools.recall, tools.remember],
        signal,
      });
    } catch (error) {
      failure = error;
    }
    if (failure !== undefined && signal.aborted) {
      // Cut off, by a stop or by the plugin's own signal: settled from
      // what it wrote, as a crash is, never from a counter.
      const reason: MemoryPassReason = stopAll.signal.aborted ? 'stopped' : 'cancelled';
      const written = await writtenBy(agentId, mode, passId);
      const end = memoryPassSettleRecord(claim, written, { at: now(), run: options.run });
      await appendEnd(ledger, { ...end, reason, more });
      return finish(agentId, mode, {
        passId, status: 'interrupted', reason, saved: end.saved, superseded: end.superseded, more,
      }, kind);
    }
    const { saved, superseded } = tools.tally();
    if (failure !== undefined) {
      const reason: MemoryPassReason = failure instanceof HostRefusalError ? 'budget' : 'model';
      options.log(`memory pass ${passId} (${agentId}) failed: ${failure instanceof Error ? failure.message : String(failure)}`);
      // Wrote nothing: what it was handed is given back, so it is read again.
      await appendEnd(ledger, {
        type: 'end', at: now(), run: options.run, passId, status: 'failed', reason, saved, superseded,
        more, released: saved === 0,
      });
      return finish(agentId, mode, { passId, status: 'failed', reason, saved, superseded, more }, kind);
    }
    await appendEnd(ledger, {
      type: 'end', at: now(), run: options.run, passId, status: 'done', saved, superseded, more, released: false,
    });
    return finish(agentId, mode, { passId, status: 'done', saved, superseded, more }, kind);
  };

  const runSave = async (request: Extract<MemoryPassRequest, { kind: 'save' }>): Promise<MemoryPassOutcome> => {
    const { from, mode } = validSave(request);
    const { agentId, sessionId } = request;
    const passId = newPassId();
    if (closing) {
      return skipped(agentId, mode, passId, 'stopped');
    }
    const begun = started.get(`${agentId}\0${mode}`);
    if (begun === undefined || !isReady) {
      return skipped(agentId, mode, passId, 'not-started');
    }
    // A start still being written counts once it has landed, and one that
    // failed never started anything.
    if (!await begun.then(() => true, () => false)) {
      return skipped(agentId, mode, passId, 'not-started');
    }
    await settling.get(`${agentId}\0${mode}`);
    if (options.memory === undefined) {
      return skipped(agentId, mode, passId, 'store-unsupported');
    }
    // For the claim. Resolved before the chain is checked, so nothing comes
    // between the check and the step; a config that cannot resolve now
    // fails the model run the same way, after the claim.
    const model = request.model ?? await options.defaultModel(agentId).catch(() => undefined) ?? '';
    if (isMemoryPassSessionId(sessionId)) {
      return skipped(agentId, mode, passId, 'sub-agent');
    }
    if (busy.has(agentId)) {
      return skipped(agentId, mode, passId, 'pass-running');
    }
    // The idle check and the queueing in one tick: a message that arrives
    // after this queues behind the step, the way it would behind a turn.
    if (!options.chain.idle(sessionId)) {
      return skipped(agentId, mode, passId, 'turn-running');
    }
    busy.add(agentId);
    const memory = options.memory;
    const ledger = ledgerFor(agentId);
    try {
      type Taken = { refused: MemoryPassReason } | { nothingNew: true } | {
        claim: MemoryPassClaim; prompt: string; trust: TrustLevel; more: boolean;
      };
      const step = options.chain.queue(sessionId, async (): Promise<Taken> => {
        const session = await options.sessions.get(sessionId);
        if (session === undefined) {
          return { refused: 'no-session' };
        }
        if (session.agent.id !== agentId) {
          malformed(`memoryPasses.run: session ${sessionId} is not ${agentId}'s.`);
        }
        if (options.isSubAgentSession(session)) {
          return { refused: 'sub-agent' };
        }
        if (session.metadata?.[SCHEDULED_METADATA_KEY] === true && request.scheduled !== true) {
          return { refused: 'unattended' };
        }
        if (typeof session.metadata?.channel === 'string') {
          const room = conversationContextFrom(session.metadata);
          if (room === undefined || !from.includes(room.kind)) {
            return { refused: 'conversation-kind' };
          }
        }
        const records = await ledger.read();
        const counts = memoryPassMessageCounts(memoryPassActivations(records, mode, options.run));
        const next = takeSaveSlice(session.messages, memoryPassWatermark(records, mode, sessionId), counts);
        if (next === undefined) {
          return { nothingNew: true };
        }
        const claim: MemoryPassClaim = {
          type: 'claim',
          at: now(),
          run: options.run,
          passId,
          kind: 'save',
          mode,
          model,
          sessionId,
          slice: next.slice,
        };
        await ledger.append(claim);
        return { claim, prompt: saveSlicePrompt(next.entries), trust: sessionWriteTrust(session), more: next.more };
      });
      let taken: Taken;
      try {
        taken = await step;
      } catch (error) {
        if (error instanceof MalformedPassRequest) {
          throw error;
        }
        // The session or the ledger could not be read or written: nothing
        // was claimed, or the claim is open and the next start settles it.
        options.log(`memory pass ${passId} (${agentId}) could not take its slice: ${error instanceof Error ? error.message : String(error)}`);
        return finish(agentId, mode, { passId, status: 'failed', reason: 'state', saved: 0, superseded: 0, more: false });
      }
      if ('refused' in taken) {
        return skipped(agentId, mode, passId, taken.refused);
      }
      if ('nothingNew' in taken) {
        return finish(agentId, mode, { passId, status: 'nothing-new', saved: 0, superseded: 0, more: false });
      }

      // The chain is released: a turn may run while the model thinks.
      return await runClaimed({
        agentId,
        mode,
        passId,
        model,
        claim: taken.claim,
        prompt: taken.prompt,
        more: taken.more,
        tools: { passId, kind: 'save', sourceSessionId: sessionId, trust: taken.trust },
        memory,
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      });
    } finally {
      busy.delete(agentId);
    }
  };

  const validTidy = (request: Extract<MemoryPassRequest, { kind: 'tidy' }>): { mode: MemoryPassMode } => {
    if (!knownAgent(request.agentId)) {
      malformed(`memoryPasses.run: there is no agent ${String(request.agentId)}.`);
    }
    if (request.model !== undefined && (typeof request.model !== 'string' || request.model.trim().length === 0)) {
      malformed('memoryPasses.run: model, when given, must name one.');
    }
    const mode = request.mode ?? 'write';
    if (!MODES.includes(mode)) {
      malformed(`memoryPasses.run: mode must be "write" or "shadow" (got ${String(mode)}).`);
    }
    return { mode };
  };

  /**
   * One tidy pass over one chunk of one group (spec 962). No session: it
   * starts at its group's label, recalls only that label, and may supersede
   * what it was handed or recalled, so a merge never moves a fact to
   * another label.
   */
  const runTidy = async (request: Extract<MemoryPassRequest, { kind: 'tidy' }>): Promise<MemoryPassOutcome> => {
    const { mode } = validTidy(request);
    const { agentId } = request;
    const passId = newPassId();
    if (closing) {
      return skipped(agentId, mode, passId, 'stopped', 'tidy');
    }
    const begun = started.get(`${agentId}\0${mode}`);
    if (begun === undefined || !isReady || !await begun.then(() => true, () => false)) {
      return skipped(agentId, mode, passId, 'not-started', 'tidy');
    }
    await settling.get(`${agentId}\0${mode}`);
    // A merge is one fact superseding several, which only a store that
    // takes a list can record as one undoable step.
    if (options.memory === undefined || options.supersedesMany?.() !== true) {
      return skipped(agentId, mode, passId, 'store-unsupported', 'tidy');
    }
    const model = request.model ?? await options.defaultModel(agentId).catch(() => undefined) ?? '';
    if (busy.has(agentId)) {
      return skipped(agentId, mode, passId, 'pass-running', 'tidy');
    }
    busy.add(agentId);
    const memory = options.memory;
    const ledger = ledgerFor(agentId);
    try {
      let chunk: TidyChunk | undefined;
      let claim: MemoryPassClaim;
      try {
        const records = await ledger.read();
        const live = (await memory.list(agentId)).entries;
        const pinned = new Set((await memory.pinned?.(agentId, { include: 'allocated' }) ?? []).map((entry) => entry.id));
        chunk = takeTidyChunk(live, pinned, memoryPassTidyClaimed(records, mode));
        if (chunk === undefined) {
          return finish(agentId, mode, { passId, status: 'nothing-new', saved: 0, superseded: 0, more: false }, 'tidy');
        }
        claim = {
          type: 'claim', at: now(), run: options.run, passId, kind: 'tidy', mode, model,
          group: { key: chunk.key, hash: chunk.hash },
        };
        await ledger.append(claim);
      } catch (error) {
        options.log(`memory pass ${passId} (${agentId}) could not take its chunk: ${error instanceof Error ? error.message : String(error)}`);
        return finish(agentId, mode, { passId, status: 'failed', reason: 'state', saved: 0, superseded: 0, more: false }, 'tidy');
      }
      const trust = chunk.trust;
      return await runClaimed({
        agentId,
        mode,
        passId,
        model,
        claim,
        prompt: tidyChunkPrompt(chunk.lines),
        more: chunk.more,
        tools: {
          passId,
          kind: 'tidy',
          trust,
          handed: chunk.members.map((entry) => ({ id: entry.id, trust })),
          recallOnly: trust,
        },
        memory,
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      });
    } finally {
      busy.delete(agentId);
    }
  };

  const run: MemoryPassHandle['run'] = async (request) => {
    if (typeof request !== 'object' || request === null) {
      throw new MalformedPassRequest('memoryPasses.run needs a request.');
    }
    if (request.kind !== 'save' && request.kind !== 'tidy') {
      throw new MalformedPassRequest(`memoryPasses.run: kind must be "save" or "tidy" (got ${String((request as { kind?: unknown }).kind)}).`);
    }
    const pass = request.kind === 'tidy' ? runTidy(request) : runSave(request);
    running.add(pass);
    try {
      return await pass;
    } finally {
      running.delete(pass);
    }
  };

  const close = async (): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    // Never ready: the settles stay for the next start. Ready: the stop
    // record comes after them.
    openReadiness(false);
    stopAll.abort(new Error('The daemon is stopping.'));
    await Promise.allSettled([...running, ...settling.values()]);
    const at = now();
    for (const [key, begun] of started) {
      const outcome = await begun.then(() => true, () => false);
      if (!outcome) {
        continue;
      }
      const [agentId, mode] = key.split('\0') as [string, MemoryPassMode];
      try {
        await ledgerFor(agentId).append({ type: 'stop', at, run: options.run, mode });
      } catch (error) {
        options.log(`could not write the memory pass stop record for ${agentId} (${mode}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  const passes = async (agentId: string): Promise<MemoryPassSummary[]> =>
    memoryPassSummaries(await ledgerFor(agentId).read());

  const pass = async (agentId: string, passId: string): Promise<MemoryPassDetail | undefined> => {
    const found = (await passes(agentId)).find((summary) => summary.passId === passId);
    return found === undefined ? undefined : { pass: found, entries: await writtenBy(agentId, found.mode, passId) };
  };

  const ready = async (): Promise<void> => {
    if (!closing) {
      isReady = true;
      openReadiness(true);
    }
    await Promise.allSettled([...settling.values()]);
  };

  return { handle: { start, run }, passes, pass, ready, close };
};
