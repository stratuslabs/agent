import {
  leastTrusted,
  MEMORY_PASS_KINDS,
  MEMORY_PASS_MAX_SAVES,
  MEMORY_PASS_METADATA_KEY,
  memoryEntryTrust,
  sessionTaintedBy,
  sessionWriteTrust,
  type AgentMemoryStore,
  type JsonObject,
  type MemoryAppendOptions,
  type MemoryOrigin,
  type MemoryPassKind,
  type Session,
  type Tool,
  type TrustLevel,
} from '@stratusagent/core';

import { createRecallTool, MEMORY_TOOL_NAME, rememberInput, type MemoryToolOptions } from './memory.ts';

/** One pass, as its two tools see it. Fixed by the host before the first model call. */
export interface MemoryPassToolState {
  passId: string;
  kind: MemoryPassKind;
  /** A save pass's conversation: what its facts carry in `origin.sessionId`. */
  sourceSessionId?: string;
  /**
   * The label the pass writes at, taken with its slice (spec 962): the
   * source session's write label for a save pass, the group's for a tidy.
   * A recall that lowers the pass session's own label lowers it further.
   */
  trust: TrustLevel;
}

/**
 * Where a pass's facts go: the agent's store in write mode, the shadow file
 * in shadow mode. Returns the new fact's id and label.
 */
export type MemoryPassWrite = (
  agentId: string,
  content: string,
  options: MemoryAppendOptions,
) => Promise<{ id: string; trust: TrustLevel }>;

export interface MemoryPassToolOptions extends MemoryToolOptions {
  /** Default: `store.append`. */
  write?: MemoryPassWrite;
}

/**
 * A memory pass's only two tools (spec 962). Recall is the agent's own;
 * remember is held to rules the model's prompt cannot loosen:
 *
 * - kinds: semantic, procedural and preference, never episodic;
 * - at most `MEMORY_PASS_MAX_SAVES` facts;
 * - `supersedes` names only a fact this pass's recall showed it, never a
 *   pinned one or one the operator asserted (`user`), so a transcript that
 *   names an id cannot retire a fact the pass never saw;
 * - every fact carries `metadata.memoryPass` so it can be found and undone.
 *
 * No forget, no pin: forgetting what a pass wrote undoes all of it.
 */
export const createMemoryPassTools = (
  store: AgentMemoryStore,
  state: MemoryPassToolState,
  options: MemoryPassToolOptions = {},
): { recall: Tool; remember: Tool; tally: () => { saved: number; superseded: number } } => {
  const write: MemoryPassWrite = options.write ?? (async (agentId, content, appendOptions) => {
    const entry = await store.append(agentId, content, appendOptions);
    return { id: entry.id, trust: memoryEntryTrust(entry) };
  });
  /** Every fact a recall in this pass returned, with its label then. */
  const shown = new Map<string, TrustLevel>();
  let saved = 0;
  let superseded = 0;

  const ownRecall = createRecallTool(store, options);
  const recall: Tool = {
    ...ownRecall,
    async execute(input, session, context) {
      const result = await ownRecall.execute(input, session, context) as { results?: { id: string; trust: TrustLevel }[] };
      for (const found of result.results ?? []) {
        shown.set(found.id, found.trust);
      }
      return result as unknown as JsonObject;
    },
  };

  const pinned = async (agentId: string, entryId: string): Promise<boolean> =>
    (await store.pinned?.(agentId, { include: 'allocated' }) ?? []).some((entry) => entry.id === entryId);

  const remember: Tool = {
    name: MEMORY_TOOL_NAME,
    description: 'Save one lasting fact to your long-term memory. Use supersedes to replace a fact memory.recall showed you.',
    risk: 'safe',
    parameters: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: 'The fact, phrased so it makes sense later without context.' },
        kind: {
          type: 'string',
          enum: [...MEMORY_PASS_KINDS],
          description: 'semantic (about the world), procedural (how something is done), or preference.',
        },
        about: {
          type: 'array',
          items: { type: 'string' },
          description: 'The people, systems, or projects this fact concerns, aliases included.',
        },
        validFrom: { type: 'string', description: 'ISO-8601 instant this becomes true, if it is not true yet. Optional.' },
        validUntil: { type: 'string', description: 'ISO-8601 instant this stops being true, if you know one. Optional.' },
        supersedes: { type: 'string', description: 'The id of a fact memory.recall showed you that this one replaces.' },
      },
      required: ['fact'],
    },
    async execute(input: JsonObject, session: Session) {
      const { fact, fields } = rememberInput(input);
      if (fields.kind !== undefined && !(MEMORY_PASS_KINDS as readonly string[]).includes(fields.kind)) {
        throw new Error(`A memory pass saves only ${MEMORY_PASS_KINDS.join(', ')} facts, never ${fields.kind}. Nothing was stored.`);
      }
      if (saved >= MEMORY_PASS_MAX_SAVES) {
        throw new Error(`A memory pass saves at most ${MEMORY_PASS_MAX_SAVES} facts, and this one has. Nothing was stored.`);
      }
      const agentId = session.agent.id;
      const replaces = fields.supersedes;
      if (replaces !== undefined) {
        const label = shown.get(replaces);
        if (label === undefined) {
          throw new Error(`${replaces} is not a fact memory.recall has shown in this pass, so it cannot be superseded. Nothing was stored.`);
        }
        if (label === 'user') {
          throw new Error(`${replaces} is a fact the operator asserted, and a memory pass never supersedes one. Nothing was stored.`);
        }
        if (await pinned(agentId, replaces)) {
          throw new Error(`${replaces} is pinned, and a memory pass never supersedes a pinned fact. Nothing was stored.`);
        }
      }
      const taintedBy = sessionTaintedBy(session);
      const origin: MemoryOrigin = {
        ...(state.sourceSessionId !== undefined ? { sessionId: state.sourceSessionId } : {}),
        ...(taintedBy !== undefined ? { taintedBy } : {}),
      };
      const written = await write(agentId, fact, {
        metadata: { [MEMORY_PASS_METADATA_KEY]: { id: state.passId, kind: state.kind } },
        provenance: { trust: leastTrusted(state.trust, sessionWriteTrust(session)), origin },
        ...fields,
      });
      saved += 1;
      if (replaces !== undefined) {
        superseded += 1;
      }
      return { remembered: true, id: written.id, trust: written.trust, ...(replaces !== undefined ? { supersedes: replaces } : {}) };
    },
  };

  return { recall, remember, tally: () => ({ saved, superseded }) };
};
