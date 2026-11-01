import {
  leastTrusted,
  MEMORY_PASS_KINDS,
  MEMORY_PASS_MAX_SAVES,
  MEMORY_PASS_METADATA_KEY,
  memoryEntryTrust,
  memorySupersedesField,
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
  /**
   * A tidy pass's chunk: the facts it was handed as input, which it may
   * supersede without recalling them first.
   */
  handed?: ReadonlyArray<{ id: string; trust: TrustLevel }>;
  /**
   * A tidy pass recalls only live facts with this label (its group's), so
   * no recall lowers its label and everything it writes carries the
   * group's label, never another one.
   */
  recallOnly?: TrustLevel;
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
  /**
   * The store takes a list in `supersedes` (its contribution declares
   * `supersedesMany`), so one fact may replace several. Off by default:
   * a store that never said so is handed one id at a time.
   */
  supersedesMany?: boolean;
}

/**
 * What a pass's `supersedes` names, as a list: one id or several, each a
 * non-empty string. Anything else is refused rather than read as none, so
 * a malformed merge never saves a duplicate the model meant to replace.
 */
const supersedesInput = (value: unknown): string[] | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  const ids = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === 'string' && id.trim().length > 0)) {
    throw new Error('"supersedes" must be the id of a fact, or a list of ids. Nothing was stored.');
  }
  return [...new Set(ids.map((id: string) => id.trim()))];
};

/**
 * A memory pass's only two tools (spec 962). Recall is the agent's own;
 * remember is held to rules the model's prompt cannot loosen:
 *
 * - kinds: semantic, procedural and preference, never episodic;
 * - at most `MEMORY_PASS_MAX_SAVES` facts;
 * - `supersedes` names only facts this pass's recall showed it, never a
 *   pinned one or one the operator asserted (`user`), so a transcript that
 *   names an id cannot retire a fact the pass never saw. It may name
 *   several (a merge) only when the store takes a list, and every id is
 *   checked before anything is stored;
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
  /** Every fact this pass was handed or a recall in it returned, with its label then. */
  const shown = new Map<string, TrustLevel>((state.handed ?? []).map((fact) => [fact.id, fact.trust]));
  let saved = 0;
  let superseded = 0;

  // Filtered before the recall tool sees the result, so a fact with another
  // label never reaches the model or lowers the pass session's label.
  const only = state.recallOnly;
  const searched: Pick<AgentMemoryStore, 'search'> = only === undefined ? store : {
    async search(agentId, query, searchOptions) {
      const result = await store.search(agentId, query, searchOptions);
      return { ...result, entries: result.entries.filter((entry) => memoryEntryTrust(entry) === only) };
    },
  };
  const ownRecall = createRecallTool(searched, options);
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
  /**
   * The fact's label now, not at the recall: an operator may have asserted
   * it since. Read right before the write, as the pin is, for the early
   * refusal; the store checks both again in the write itself
   * (`refuseProtected`).
   */
  const labelNow = async (agentId: string, entryId: string, recalled: TrustLevel): Promise<TrustLevel> => {
    const found = (await store.audit(agentId)).find((entry) => entry.id === entryId);
    return found !== undefined ? memoryEntryTrust(found) : recalled;
  };

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
        supersedes: options.supersedesMany === true
          ? {
            type: 'array',
            items: { type: 'string' },
            description: 'The ids of the facts memory.recall showed you that this one replaces. Name several to merge duplicates into this one fact.',
          }
          : { type: 'string', description: 'The id of a fact memory.recall showed you that this one replaces.' },
      },
      required: ['fact'],
    },
    async execute(input: JsonObject, session: Session) {
      const replaces = supersedesInput(input.supersedes);
      // Checked here, not by `rememberInput`, which reads one id only.
      const { fact, fields } = rememberInput({ ...input, supersedes: null });
      if (fields.kind !== undefined && !(MEMORY_PASS_KINDS as readonly string[]).includes(fields.kind)) {
        throw new Error(`A memory pass saves only ${MEMORY_PASS_KINDS.join(', ')} facts, never ${fields.kind}. Nothing was stored.`);
      }
      if (saved >= MEMORY_PASS_MAX_SAVES) {
        throw new Error(`A memory pass saves at most ${MEMORY_PASS_MAX_SAVES} facts, and this one has. Nothing was stored.`);
      }
      const agentId = session.agent.id;
      if (replaces !== undefined && replaces.length > 1 && options.supersedesMany !== true) {
        throw new Error(
          'This agent\'s memory store replaces one fact at a time, so a memory pass cannot merge several into one. '
          + 'Name one id in supersedes. Nothing was stored.',
        );
      }
      for (const replaced of replaces ?? []) {
        const label = shown.get(replaced);
        if (label === undefined) {
          throw new Error(`${replaced} is not a fact this pass was handed or memory.recall has shown in it, so it cannot be superseded. Nothing was stored.`);
        }
        if (label === 'user' || await labelNow(agentId, replaced, label) === 'user') {
          throw new Error(`${replaced} is a fact the operator asserted, and a memory pass never supersedes one. Nothing was stored.`);
        }
        if (await pinned(agentId, replaced)) {
          throw new Error(`${replaced} is pinned, and a memory pass never supersedes a pinned fact. Nothing was stored.`);
        }
      }
      const supersedes = memorySupersedesField(replaces ?? []);
      const taintedBy = sessionTaintedBy(session);
      const origin: MemoryOrigin = {
        ...(state.sourceSessionId !== undefined ? { sessionId: state.sourceSessionId } : {}),
        ...(taintedBy !== undefined ? { taintedBy } : {}),
      };
      const written = await write(agentId, fact, {
        metadata: { [MEMORY_PASS_METADATA_KEY]: { id: state.passId, kind: state.kind } },
        provenance: { trust: leastTrusted(state.trust, sessionWriteTrust(session)), origin },
        ...fields,
        ...supersedes,
        // The checks above give a clear refusal early; this one is the
        // store's, made in the same step as the write, so a pin or an
        // assertion that lands after them still wins.
        refuseProtected: true,
      });
      saved += 1;
      superseded += replaces?.length ?? 0;
      return { remembered: true, id: written.id, trust: written.trust, ...supersedes };
    },
  };

  return { recall, remember, tally: () => ({ saved, superseded }) };
};
