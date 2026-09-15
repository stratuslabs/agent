import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { InMemoryAgentMemoryStore, type AgentMemoryStore } from '@stratusagent/core';

import { createFileMemoryStore } from '../src/index.ts';
import { CORPUS_NOW, CORPUS_TURNS } from './memory-corpus.ts';
import {
  formatScores,
  loadCorpus,
  RECALL_K,
  scorePolicy,
  type InjectionPolicy,
  type PolicyScore,
} from './memory-harness.ts';

/**
 * The regression gate. These are the numbers the landing PR carried, kept
 * as floors rather than exact equalities so a tuning change that *improves*
 * selection does not fail the run — but a change that quietly injects more,
 * or lets a retired belief back into the prompt, does.
 *
 * Deliberately not clock-dependent: every store here is built on the
 * corpus's own instant, so a run in December scores what a run in June did.
 */
const BLOCKS_FLOOR = {
  precision: 0.21,
  stalenessRate: 0,
  negativesInjected: 0,
  recallAtK: 1,
} as const;

const storesUnderTest = async (): Promise<Array<[string, AgentMemoryStore]>> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stratus-memory-harness-'));
  return [
    ['in-memory', new InMemoryAgentMemoryStore({ now: () => CORPUS_NOW })],
    ['file', createFileMemoryStore(path.join(dir, 'memory.jsonl'), { now: () => CORPUS_NOW })],
  ];
};

test('the injection harness scores both stores identically, and the blocks policy beats the recency one it replaces', async (t) => {
  const measured: Array<[string, Record<InjectionPolicy, PolicyScore>]> = [];
  for (const [label, store] of await storesUnderTest()) {
    await loadCorpus(store);
    const scores = {
      recency: await scorePolicy(store, 'recency'),
      blocks: await scorePolicy(store, 'blocks'),
    };
    measured.push([label, scores]);
    // One line each: a diagnostic carrying newlines comes back escaped in
    // the TAP output, which is where these numbers are read from.
    t.diagnostic(`${label} store`);
    for (const line of formatScores(scores).split('\n')) {
      t.diagnostic(line);
    }
  }

  // Both implementations, same corpus, same numbers — a harness that scored
  // differently per store would be measuring the store, not the policy.
  const [first, second] = measured;
  assert.deepEqual(second?.[1], first?.[1], 'the two store implementations scored the corpus differently');

  const scores = first![1];
  // Better means: precision up and staleness down at no more tokens per
  // relevant fact. All three, or the claim is not made.
  assert.ok(
    scores.blocks.precision > scores.recency.precision,
    `precision ${scores.blocks.precision} did not beat ${scores.recency.precision}`,
  );
  assert.ok(
    scores.blocks.stalenessRate < scores.recency.stalenessRate,
    `staleness ${scores.blocks.stalenessRate} did not beat ${scores.recency.stalenessRate}`,
  );
  assert.ok(
    scores.blocks.tokensPerRelevantFact <= scores.recency.tokensPerRelevantFact,
    `tokens per relevant fact rose from ${scores.recency.tokensPerRelevantFact} to ${scores.blocks.tokensPerRelevantFact}`,
  );

  // The corpus has to be able to tell the policies apart, or the comparison
  // above is vacuous: the recency policy must really carry stale facts and
  // really leak the labelled negatives.
  assert.ok(scores.recency.stalenessRate > 0, 'the corpus never exercises staleness under the old policy');
  assert.ok(scores.recency.negativesInjected > 0, 'the corpus has no negative the old policy leaks');

  // The floors. A regression in injected-slice precision fails the run.
  assert.ok(scores.blocks.precision >= BLOCKS_FLOOR.precision, `precision fell to ${scores.blocks.precision}`);
  assert.equal(scores.blocks.stalenessRate, BLOCKS_FLOOR.stalenessRate, 'a stale fact reached the injected slice');
  assert.equal(scores.blocks.negativesInjected, BLOCKS_FLOOR.negativesInjected, 'a labelled negative reached the injected slice');
  assert.equal(scores.blocks.recallAtK, BLOCKS_FLOOR.recallAtK, `recall@${RECALL_K} fell below the whole labelled set`);
});

test('the corpus labels are self-consistent: every key exists, and no fact is both relevant and a negative', async () => {
  const [, store] = (await storesUnderTest())[0]!;
  await loadCorpus(store);
  const known = new Set((await store.audit('ava')).map((entry) => entry.id.replace('ava:memory:', '')));
  for (const turn of CORPUS_TURNS) {
    for (const key of [...turn.relevant, ...turn.negatives, ...turn.recall]) {
      assert.ok(known.has(key), `turn "${turn.prompt}" labels ${key}, which the corpus does not contain`);
    }
    for (const key of turn.relevant) {
      assert.ok(!turn.negatives.includes(key), `turn "${turn.prompt}" labels ${key} both ways`);
    }
  }
});
