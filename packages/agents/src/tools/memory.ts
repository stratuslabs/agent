import {
  isMemoryEntryKind,
  isTaintedTrust,
  leastTrusted,
  MEMORY_ENTRY_KINDS,
  MEMORY_RECALL_TOOL_NAME,
  memoryEntryTrust,
  memoryValidityAt,
  sessionTaintedBy,
  sessionWriteTrust,
  type AgentMemoryStore,
  type JsonObject,
  type MemoryAppendOptions,
  type MemoryOrigin,
  type Session,
  type Tool,
} from '@stratusagent/core';

/** Test seam shared by every memory tool that has to decide what is true *now*. */
export interface MemoryToolOptions {
  now?: () => Date;
}

const clockOf = (options: MemoryToolOptions): (() => Date) => options.now ?? (() => new Date());

/** A trimmed string, or undefined — the shape every optional string parameter here reads as. */
const optionalString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * ISO-8601, and checked as ISO-8601 rather than as whatever `Date.parse`
 * will take. `Date.parse` accepts `04/01/2026` and `1` and gives each an
 * interpretation — one of them locale-shaped and one of them a year — so
 * parsing alone would quietly store a different window than the model
 * meant, and the fact would enter or leave the prompt on the wrong day.
 * A bound that silently failed to parse is the same hazard running the
 * other way: the fact reads as unbounded and outlives the thing it was
 * about. So the shape is asserted first, then the value.
 */
// A date alone is UTC midnight by specification, so it is unambiguous
// wherever the daemon runs. A *time* without an offset is not: it reads as
// the host's local zone, so the same requested bound would become a
// different instant in Los Angeles than in UTC, and a fact would activate
// or expire at a deployment-dependent hour. So the offset is required
// whenever a time is given.
const ISO_8601_INSTANT = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))?$/;

const validityBound = (value: unknown, field: string): string | undefined => {
  const raw = optionalString(value);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Date.parse(raw);
  if (!ISO_8601_INSTANT.test(raw) || Number.isNaN(parsed)) {
    throw new Error(`${field} must be an ISO-8601 instant such as 2026-04-01 or 2026-04-01T00:00:00Z — a time needs Z or an offset, `
      + `or it means something different on every machine. ${raw} is not one, and nothing was stored.`);
  }
  return new Date(parsed).toISOString();
};

const aboutKeys = (value: unknown): string[] | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((key) => typeof key !== 'string')) {
    throw new Error('"about" must be an array of entity names, as plain strings. Nothing was stored.');
  }
  const keys = (value as string[]).map((key) => key.trim()).filter((key) => key.length > 0);
  return keys.length > 0 ? keys : undefined;
};

export const MEMORY_TOOL_NAME = 'memory.remember';

/**
 * A tool that lets an agent write to its own long-term memory. Entries are
 * keyed by the session's agent id, so what one agent learns stays exclusively
 * that agent's knowledge — and follows it to every channel and thread.
 *
 * Everything past `fact` is optional, and the reason they are the model's to
 * write rather than extracted afterwards is that the party writing the fact
 * is the one that knows what it is about, when it stops being true, and
 * which older belief it replaces. Extraction would be a knowledge graph
 * arriving through a side door.
 */
export const createRememberTool = (store: AgentMemoryStore): Tool => ({
  name: MEMORY_TOOL_NAME,
  description: 'Save a fact to your long-term memory so you can recall it in future conversations on any channel.',
  // The agent's own memory, keyed to the agent and read by nobody else.
  risk: 'safe',
  parameters: {
    type: 'object',
    properties: {
      fact: { type: 'string', description: 'The fact to remember, phrased so it makes sense later without context.' },
      kind: {
        type: 'string',
        enum: [...MEMORY_ENTRY_KINDS],
        description: 'What sort of fact this is: semantic (about the world), episodic (something that happened), procedural (how something is done), or preference.',
      },
      about: {
        type: 'array',
        items: { type: 'string' },
        description: 'The people, systems, or projects this fact concerns. These are how you will find it later, so include the names you would search for — aliases included.',
      },
      validFrom: { type: 'string', description: 'ISO-8601 instant this becomes true, if it is not true yet. Optional.' },
      validUntil: { type: 'string', description: 'ISO-8601 instant this stops being true, if you know one. Optional.' },
      supersedes: {
        type: 'string',
        description: 'The id of a fact of yours this one replaces (from memory.recall). The old fact stops informing you once this one is in force, and stays visible to your operator.',
      },
    },
    required: ['fact'],
  },
  async execute(input: JsonObject, session: Session) {
    const fact = typeof input.fact === 'string' ? input.fact.trim() : '';
    if (!fact) {
      throw new Error('memory.remember requires a non-empty "fact" string.');
    }
    if (input.kind !== undefined && !isMemoryEntryKind(input.kind)) {
      throw new Error(`"kind" must be one of ${MEMORY_ENTRY_KINDS.join(', ')}. Nothing was stored.`);
    }
    // Per session, not per fact: the runner knows this session has seen
    // untrusted content and cannot know which words of the fact came from
    // it, so the write carries the least trusted label the session holds.
    // Coarse and over-marking — the safe direction.
    const taintedBy = sessionTaintedBy(session);
    const origin: MemoryOrigin = { sessionId: session.id, ...(taintedBy !== undefined ? { taintedBy } : {}) };
    const about = aboutKeys(input.about);
    const validFrom = validityBound(input.validFrom, 'validFrom');
    const validUntil = validityBound(input.validUntil, 'validUntil');
    // A window that closes before it opens describes nothing: the entry is
    // not-yet-valid before `validFrom` and expired after it, so it could
    // never be true and would never reach a prompt — stored, findable, and
    // silently inert. The record tolerates whatever a hand edit or an
    // import puts there; what a model writes is checked here.
    if (validFrom !== undefined && validUntil !== undefined && Date.parse(validFrom) >= Date.parse(validUntil)) {
      throw new Error(
        `validUntil (${validUntil}) must be after validFrom (${validFrom}); a fact whose window closes before it opens is never true. Nothing was stored.`,
      );
    }
    const supersedes = optionalString(input.supersedes);
    const options: MemoryAppendOptions = {
      metadata: { sessionId: session.id },
      provenance: { trust: sessionWriteTrust(session), origin },
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(about !== undefined ? { about } : {}),
      ...(validFrom !== undefined ? { validFrom } : {}),
      ...(validUntil !== undefined ? { validUntil } : {}),
      ...(supersedes !== undefined ? { supersedes } : {}),
    };
    // The store resolves `supersedes` against this agent's own live entries
    // and throws before appending anything, so naming a stranger's id is a
    // failed call rather than a retirement.
    const entry = await store.append(session.agent.id, fact, options);
    return {
      remembered: true,
      id: entry.id,
      trust: memoryEntryTrust(entry),
      ...(supersedes !== undefined ? { supersedes } : {}),
    };
  },
});

/** The kernel owns the name — the prompt's topic index points the agent at it. */
export const RECALL_TOOL_NAME = MEMORY_RECALL_TOOL_NAME;

/**
 * Searches the agent's own long-term memory. `safe` by the same rule as
 * `memory.remember`: reading what this agent already knows. The query is
 * literal text — the store does whatever escaping its backend needs, so no
 * query a model writes is ever a syntax error; matching nothing is a normal
 * result, because an agent that has learned nothing yet is the ordinary
 * starting state, not a broken tool.
 */
export const createRecallTool = (store: AgentMemoryStore, options: MemoryToolOptions = {}): Tool => {
  const now = clockOf(options);
  return {
    name: RECALL_TOOL_NAME,
    description: 'Search your long-term memory for facts you have remembered. Your prompt carries only the pinned facts and a short recent tail — use this to find everything else, including facts that have expired.',
    risk: 'safe',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, as plain words. Every word must appear in a fact — or in what the fact is about — for it to match.' },
        limit: { type: 'number', description: 'Maximum facts to return. Optional; the store bounds it either way.' },
      },
      required: ['query'],
    },
    async execute(input: JsonObject, session: Session, context) {
      if (typeof input.query !== 'string') {
        throw new Error('memory.recall requires a "query" string.');
      }
      const limit = typeof input.limit === 'number' ? input.limit : undefined;
      const result = await store.search(session.agent.id, input.query, { ...(limit !== undefined ? { limit } : {}) });
      // What enters the context taints the session, recalled as much as
      // injected: an `external` entry surfacing here is a stranger's text
      // in the prompt, and marking the call is what stops the store from
      // laundering its own contents through a fresh session.
      const lowest = leastTrusted(...result.entries.map(memoryEntryTrust));
      if (isTaintedTrust(lowest)) {
        context?.markTrust?.(lowest);
      }
      const at = now();
      return {
        results: result.entries.map((entry) => ({
          id: entry.id,
          content: entry.content,
          createdAt: entry.createdAt,
          trust: memoryEntryTrust(entry),
          // Search keeps an out-of-window entry findable, which is right —
          // returning it *unmarked* is not: an expired fact that reads
          // exactly like a current one is the confusion `validFrom` and
          // `validUntil` exist to prevent, arriving through the other door.
          validity: memoryValidityAt(entry, at),
          ...(entry.about ? { about: entry.about } : {}),
          ...(entry.kind ? { kind: entry.kind } : {}),
          ...(entry.validFrom ? { validFrom: entry.validFrom } : {}),
          ...(entry.validUntil ? { validUntil: entry.validUntil } : {}),
        })),
        truncated: result.truncated,
        // The ordering the store actually applied, which is not always the
        // one asked for — see `MemoryRankingStrategy`.
        ...(result.strategy !== undefined ? { strategy: result.strategy } : {}),
      };
    },
  };
};

export const FORGET_TOOL_NAME = 'memory.forget';

/**
 * Retires one of the agent's own memories, by id. Tombstoned rather than
 * deleted — which is what makes `safe` defensible for it: the entry stops
 * being live but does not stop existing, so an operator can still see what
 * an agent chose to drop.
 */
export const createForgetTool = (store: AgentMemoryStore): Tool => ({
  name: FORGET_TOOL_NAME,
  description: 'Forget one of your remembered facts by its id (from memory.recall or memory.remember). It stops informing future conversations.',
  risk: 'safe',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The id of the memory entry to forget.' },
    },
    required: ['id'],
  },
  async execute(input: JsonObject, session: Session) {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id) {
      throw new Error('memory.forget requires a non-empty "id" string.');
    }
    const forgotten = await store.forget(session.agent.id, id);
    if (!forgotten) {
      throw new Error(`No live memory entry with id ${id} belongs to this agent — nothing was forgotten.`);
    }
    return { forgotten: true, id };
  },
});

export const PIN_TOOL_NAME = 'memory.pin';

/**
 * Pins one of the agent's own facts into the core its prompt always
 * carries. `safe` by the rule that already covers `remember` and `forget`:
 * the agent's own notes, appended rather than destroyed, keyed to the
 * agent — a pin is a record naming an entry, never a field written onto
 * one, because a toggle on an append-only line is a rewrite.
 *
 * The cap refuses rather than evicts, and the refusal is a normal result
 * rather than a thrown error: nothing went wrong, the budget is full, and
 * the agent's next move is to unpin something.
 */
export const createPinTool = (store: AgentMemoryStore): Tool => ({
  name: PIN_TOOL_NAME,
  description: 'Keep one of your remembered facts in front of you every turn. The pinned set is small and capped — pin only what you always need.',
  risk: 'safe',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The id of the memory entry to pin.' },
      unpin: { type: 'boolean', description: 'Pass true to remove an existing pin instead of adding one.' },
    },
    required: ['id'],
  },
  async execute(input: JsonObject, session: Session) {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id) {
      throw new Error('memory.pin requires a non-empty "id" string.');
    }
    if (input.unpin === true) {
      if (!store.unpin) {
        throw new Error('This memory store does not support pinning, so there was nothing to unpin.');
      }
      const unpinned = await store.unpin(session.agent.id, id);
      if (!unpinned) {
        throw new Error(`No pin of yours names id ${id} — nothing was unpinned.`);
      }
      return { pinned: false, id };
    }
    if (!store.pin) {
      throw new Error('This memory store does not support pinning.');
    }
    const outcome = await store.pin(session.agent.id, id);
    return {
      pinned: outcome.pinned,
      id,
      bytes: outcome.bytes,
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
    };
  },
});
