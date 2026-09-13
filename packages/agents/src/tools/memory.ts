import {
  isTaintedTrust,
  leastTrusted,
  memoryEntryTrust,
  sessionTaintedBy,
  sessionWriteTrust,
  type AgentMemoryStore,
  type JsonObject,
  type MemoryOrigin,
  type Session,
  type Tool,
} from '@stratusagent/core';

export const MEMORY_TOOL_NAME = 'memory.remember';

/**
 * A tool that lets an agent write to its own long-term memory. Entries are
 * keyed by the session's agent id, so what one agent learns stays exclusively
 * that agent's knowledge — and follows it to every channel and thread.
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
    },
    required: ['fact'],
  },
  async execute(input: JsonObject, session: Session) {
    const fact = typeof input.fact === 'string' ? input.fact.trim() : '';
    if (!fact) {
      throw new Error('memory.remember requires a non-empty "fact" string.');
    }
    // Per session, not per fact: the runner knows this session has seen
    // untrusted content and cannot know which words of the fact came from
    // it, so the write carries the least trusted label the session holds.
    // Coarse and over-marking — the safe direction.
    const taintedBy = sessionTaintedBy(session);
    const origin: MemoryOrigin = { sessionId: session.id, ...(taintedBy !== undefined ? { taintedBy } : {}) };
    const entry = await store.append(session.agent.id, fact, { sessionId: session.id }, {
      trust: sessionWriteTrust(session),
      origin,
    });
    return { remembered: true, id: entry.id, trust: memoryEntryTrust(entry) };
  },
});

export const RECALL_TOOL_NAME = 'memory.recall';

/**
 * Searches the agent's own long-term memory. `safe` by the same rule as
 * `memory.remember`: reading what this agent already knows. The query is
 * literal text — the store does whatever escaping its backend needs, so no
 * query a model writes is ever a syntax error; matching nothing is a normal
 * result, because an agent that has learned nothing yet is the ordinary
 * starting state, not a broken tool.
 */
export const createRecallTool = (store: AgentMemoryStore): Tool => ({
  name: RECALL_TOOL_NAME,
  description: 'Search your long-term memory for facts you have remembered. Only your most recent memories appear in your prompt automatically — use this to find everything older.',
  risk: 'safe',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look for, as plain words. Every word must appear in a fact for it to match.' },
      limit: { type: 'number', description: 'Maximum facts to return. Optional; the store bounds it either way.' },
    },
    required: ['query'],
  },
  async execute(input: JsonObject, session: Session, context) {
    if (typeof input.query !== 'string') {
      throw new Error('memory.recall requires a "query" string.');
    }
    const limit = typeof input.limit === 'number' ? input.limit : undefined;
    const result = await store.search(session.agent.id, input.query, limit);
    // What enters the context taints the session, recalled as much as
    // injected: an `external` entry surfacing here is a stranger's text
    // in the prompt, and marking the call is what stops the store from
    // laundering its own contents through a fresh session.
    const lowest = leastTrusted(...result.entries.map(memoryEntryTrust));
    if (isTaintedTrust(lowest)) {
      context?.markTrust?.(lowest);
    }
    return {
      results: result.entries.map((entry) => ({
        id: entry.id,
        content: entry.content,
        createdAt: entry.createdAt,
        trust: memoryEntryTrust(entry),
      })),
      truncated: result.truncated,
    };
  },
});

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
