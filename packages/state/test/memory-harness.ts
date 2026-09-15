import {
  buildMemoryInjection,
  compareMemoryChronology,
  compareMemoryRecallOrder,
  memoryContentByteLength,
  memoryValidityAt,
  renderMemorySection,
  supersededMemoryIdsAt,
  type AgentMemoryStore,
  type MemoryEntry,
} from '@stratusagent/core';

import {
  CORPUS_AGENT_ID,
  CORPUS_ENTRIES,
  CORPUS_NOW,
  CORPUS_PINNED,
  CORPUS_TURNS,
  type CorpusTurn,
} from './memory-corpus.ts';

/**
 * The ruler. Two injection policies scored on one labelled corpus, so every
 * later tuning question — slice size, decay, automatic retrieval — is a
 * measurement instead of the same argument in another review.
 *
 * **Better means: precision up and staleness down at no more tokens per
 * relevant fact**, against the recency policy 29 replaces, on this corpus.
 * A policy that wins precision by injecting more has not won, which is why
 * the token number is paired with it and neither counts alone.
 */
export type InjectionPolicy = 'recency' | 'blocks';

export interface PolicyScore {
  /** Mean over turns of |injected ∩ relevant| / |injected| — the number 29 claims to improve. */
  precision: number;
  /** Mean over turns of rendered tokens / |injected ∩ relevant| — the paired number. */
  tokensPerRelevantFact: number;
  /** Share of injected facts that are superseded or outside their validity window. Goes to zero. */
  stalenessRate: number;
  /** Labelled facts that must not appear and did. A count, because one is a defect. */
  negativesInjected: number;
  /** Mean over turns of |search hits ∩ labelled recall set| / |labelled recall set|. */
  recallAtK: number;
  /** Mean rendered size of the memory section, in estimated tokens. */
  tokensPerTurn: number;
}

/**
 * A deterministic token estimate: four UTF-8 bytes to the token. It is a
 * proxy, not a tokenizer — no model runs in this path — and it only has to
 * be monotone in size for the comparison it serves. A real tokenizer would
 * make the numbers prettier and the harness a vendor dependency.
 */
export const estimateTokens = (text: string): number => Math.ceil(memoryContentByteLength(text) / 4);

/** The store id a corpus key lands under. Derived, so labels and entries cannot drift. */
export const corpusEntryId = (key: string): string => `${CORPUS_AGENT_ID}:memory:${key}`;

/**
 * Load the lifetime into a store and pin what it pinned. Uses the same
 * `importEntries` path `stratus memory import` does — which is the reason
 * the export half is in 29's scope at all: a harness needs a way to put a
 * corpus into a store that is not thirty `append` calls with invented ids.
 */
export const loadCorpus = async (store: AgentMemoryStore): Promise<void> => {
  await store.importEntries!(CORPUS_AGENT_ID, CORPUS_ENTRIES.map((entry) => ({
    id: corpusEntryId(entry.key),
    agentId: CORPUS_AGENT_ID,
    content: entry.content,
    createdAt: entry.createdAt,
    kind: entry.kind,
    ...(entry.about ? { about: entry.about } : {}),
    ...(entry.validFrom ? { validFrom: entry.validFrom } : {}),
    ...(entry.validUntil ? { validUntil: entry.validUntil } : {}),
    ...(entry.supersedes ? { supersedes: corpusEntryId(entry.supersedes) } : {}),
    ...(entry.trust ? { trust: entry.trust } : {}),
  })));
  for (const key of CORPUS_PINNED) {
    const outcome = await store.pin!(CORPUS_AGENT_ID, corpusEntryId(key));
    if (!outcome.pinned) {
      throw new Error(`The corpus could not pin ${key}: ${outcome.reason}`);
    }
  }
};

/** How many recent entries the policy 29 replaces injected. Frozen here, since the constant is gone. */
export const RECENCY_POLICY_LIMIT = 20;

/**
 * What each policy puts in front of the model, as the rendered section and
 * the facts it holds.
 *
 * `recency` is reproduced here rather than imported, because it no longer
 * exists in the source: it is the twenty most recent entries of the record,
 * oldest first, with no notion of supersession, validity, pinning, or
 * topics — which is exactly why it carries retired beliefs and expired
 * notices, and exactly what the numbers below are measured against.
 */
const injectionFor = async (
  store: AgentMemoryStore,
  policy: InjectionPolicy,
): Promise<{ facts: MemoryEntry[]; rendered: string }> => {
  if (policy === 'blocks') {
    const injection = await buildMemoryInjection(store, CORPUS_AGENT_ID);
    return {
      facts: [...injection.pinned, ...injection.recent],
      rendered: renderMemorySection(injection) ?? '',
    };
  }
  const everything = (await store.audit(CORPUS_AGENT_ID)).filter((entry) => entry.forgottenAt === undefined);
  const facts = [...everything]
    .sort(compareMemoryRecallOrder)
    .slice(0, RECENCY_POLICY_LIMIT)
    .sort(compareMemoryChronology);
  return { facts, rendered: renderMemorySection(facts) ?? '' };
};

/** Superseded now, or outside its validity window — the two ways an injected fact is stale. */
const staleIds = async (store: AgentMemoryStore): Promise<Set<string>> => {
  const everything = (await store.audit(CORPUS_AGENT_ID)).filter((entry) => entry.forgottenAt === undefined);
  const superseded = supersededMemoryIdsAt(everything, CORPUS_NOW);
  const stale = new Set(superseded);
  for (const entry of everything) {
    if (memoryValidityAt(entry, CORPUS_NOW) !== 'current') {
      stale.add(entry.id);
    }
  }
  return stale;
};

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

export const scorePolicy = async (store: AgentMemoryStore, policy: InjectionPolicy): Promise<PolicyScore> => {
  const { facts, rendered } = await injectionFor(store, policy);
  const stale = await staleIds(store);
  const injectedIds = new Set(facts.map((entry) => entry.id));
  const tokens = estimateTokens(rendered);

  const precisions: number[] = [];
  const tokenCosts: number[] = [];
  const recalls: number[] = [];
  let negativesInjected = 0;
  for (const turn of CORPUS_TURNS) {
    const hit = turn.relevant.filter((key) => injectedIds.has(corpusEntryId(key))).length;
    precisions.push(facts.length === 0 ? 0 : hit / facts.length);
    // A turn that injected nothing relevant costs its whole budget for
    // nothing: charging the full section rather than skipping the turn is
    // what keeps the paired number from rewarding a policy that misses.
    tokenCosts.push(hit === 0 ? tokens : tokens / hit);
    negativesInjected += turn.negatives.filter((key) => injectedIds.has(corpusEntryId(key))).length;
    recalls.push(await recallForTurn(store, turn));
  }
  return {
    precision: mean(precisions),
    tokensPerRelevantFact: mean(tokenCosts),
    stalenessRate: facts.length === 0 ? 0 : facts.filter((entry) => stale.has(entry.id)).length / facts.length,
    negativesInjected,
    recallAtK: mean(recalls),
    tokensPerTurn: tokens,
  };
};

/**
 * Recall@k over `search`, scored honestly. With `recency` mandatory this
 * tests the matching contract, the bounded-read rule, and parity between
 * the store implementations — it is not a measure of 29's selection policy,
 * and becomes the headline only when a `relevance` strategy lands.
 */
export const RECALL_K = 10;

const recallForTurn = async (store: AgentMemoryStore, turn: CorpusTurn): Promise<number> => {
  if (turn.recall.length === 0) {
    return 1;
  }
  const found = await store.search(CORPUS_AGENT_ID, turn.query, { limit: RECALL_K });
  const ids = new Set(found.entries.map((entry) => entry.id));
  return turn.recall.filter((key) => ids.has(corpusEntryId(key))).length / turn.recall.length;
};

/** The numbers as a PR body carries them: one row per policy, rounded once. */
export const formatScores = (scores: Record<InjectionPolicy, PolicyScore>): string => {
  const round = (value: number, places = 3): string => value.toFixed(places);
  const row = (policy: InjectionPolicy): string => {
    const score = scores[policy];
    return `${policy.padEnd(8)} precision=${round(score.precision)}`
      + `  tokens/relevant=${round(score.tokensPerRelevantFact, 1)}`
      + `  staleness=${round(score.stalenessRate)}`
      + `  negatives=${score.negativesInjected}`
      + `  recall@${RECALL_K}=${round(score.recallAtK)}`
      + `  tokens/turn=${score.tokensPerTurn}`;
  };
  return `${row('recency')}\n${row('blocks')}`;
};
