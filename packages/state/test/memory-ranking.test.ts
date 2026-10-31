import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MEMORY_READ_MAX_BYTES, memoryValidityAt, type MemoryEntry } from '@stratusagent/core';

import { createFileMemoryStore, DEFAULT_STRATUS_AGENT, withLegacyDefaultMemories } from '../src/index.ts';

const AT = new Date('2026-06-01T00:00:00.000Z');
const frozen = { now: () => AT };

const newFile = async (): Promise<string> =>
  path.join(await mkdtemp(path.join(os.tmpdir(), 'stratus-memory-ranking-')), 'memory.jsonl');

interface Line {
  id: string;
  content: string;
  createdAt: string;
  agentId?: string;
  validUntil?: string;
}

/** A record written by hand, so each fact's date is the test's to choose. */
const seed = async (lines: readonly Line[]): Promise<string> => {
  const filePath = await newFile();
  await writeFile(filePath, `${lines.map((line) => JSON.stringify({ agentId: 'ava', ...line })).join('\n')}\n`);
  return filePath;
};

/**
 * Facts that share none of the query words. BM25 weighs a word by how few
 * facts carry it, and FTS5 gives a word in half the corpus or more no
 * weight at all — so a test corpus of three facts measures nothing. These
 * keep the query words rare, the way they are in a real agent's memory.
 */
const FILLER: Line[] = [
  'the rookery survey is quarterly',
  'the hide needs repainting before spring',
  'the north path floods every March',
  'the office moved to Leeds in April',
  'the on call rota changes on Mondays',
  'the change freeze starts in December',
  'Ada prefers short written updates',
  'the heron count was eleven last week',
].map((content, index) => ({ id: `ava:memory:filler-${index}`, content, createdAt: '2026-01-15T00:00:00.000Z' }));

const ids = (entries: readonly MemoryEntry[]): string[] => entries.map((entry) => entry.id);

test('hybrid puts an older fact matching every word above a newer one matching only some', async () => {
  const store = createFileMemoryStore(await seed([
    ...FILLER,
    { id: 'ava:memory:old-exact', content: 'the deploy pipeline runs on Fridays', createdAt: '2026-02-01T00:00:00.000Z' },
    { id: 'ava:memory:new-partial', content: 'the refunds pipeline is manual', createdAt: '2026-05-31T00:00:00.000Z' },
  ]), frozen);

  const hybrid = await store.search('ava', 'deploy pipeline', { strategy: 'hybrid' });
  assert.equal(hybrid.strategy, 'hybrid');
  assert.deepEqual(ids(hybrid.entries), ['ava:memory:old-exact', 'ava:memory:new-partial']);
  assert.equal(hybrid.truncated, false);

  const relevance = await store.search('ava', 'deploy pipeline', { strategy: 'relevance' });
  assert.equal(relevance.strategy, 'relevance');
  assert.deepEqual(ids(relevance.entries), ['ava:memory:old-exact', 'ava:memory:new-partial']);

  // Recency is still there, unchanged: every word has to appear, newest
  // first. It is also what an ordering nobody defined gets, from a caller
  // the type system did not check.
  for (const recency of [
    await store.search('ava', 'deploy pipeline'),
    await store.search('ava', 'deploy pipeline', { strategy: 'recency' }),
    await store.search('ava', 'deploy pipeline', { strategy: 'semantic' as never }),
  ]) {
    assert.equal(recency.strategy, 'recency');
    assert.deepEqual(ids(recency.entries), ['ava:memory:old-exact']);
  }
});

test('hybrid lets a much newer match pass a slightly better older one, never a far better one', async () => {
  const store = createFileMemoryStore(await seed([
    ...FILLER,
    // Best match: both words, short. A year old.
    { id: 'ava:memory:old-best', content: 'gate code 4417', createdAt: '2025-06-01T00:00:00.000Z' },
    // Both words too, a little longer, so a little less relevant. Today.
    { id: 'ava:memory:new-close', content: 'the gate code is now 5521', createdAt: '2026-06-01T00:00:00.000Z' },
    // One word only. Today.
    { id: 'ava:memory:new-weak', content: 'the gate by the car park sticks', createdAt: '2026-06-01T00:00:00.000Z' },
  ]), frozen);

  const relevance = await store.search('ava', 'gate code', { strategy: 'relevance' });
  assert.deepEqual(ids(relevance.entries), ['ava:memory:old-best', 'ava:memory:new-close', 'ava:memory:new-weak']);

  const hybrid = await store.search('ava', 'gate code', { strategy: 'hybrid' });
  assert.deepEqual(ids(hybrid.entries), ['ava:memory:new-close', 'ava:memory:old-best', 'ava:memory:new-weak']);

  // Equal relevance, different days: the newer one first.
  const twins = createFileMemoryStore(await seed([
    ...FILLER,
    { id: 'ava:memory:twin-old', content: 'the boiler service is booked', createdAt: '2026-03-01T00:00:00.000Z' },
    { id: 'ava:memory:twin-new', content: 'the boiler service is booked', createdAt: '2026-05-01T00:00:00.000Z' },
  ]), frozen);
  assert.deepEqual(
    ids((await twins.search('ava', 'boiler service', { strategy: 'hybrid' })).entries),
    ['ava:memory:twin-new', 'ava:memory:twin-old'],
  );
});

test('a ranked search matches on any of its words', async () => {
  const store = createFileMemoryStore(await seed([
    ...FILLER,
    { id: 'ava:memory:kestrel', content: 'a kestrel nests on the water tower', createdAt: '2026-04-01T00:00:00.000Z' },
  ]), frozen);
  // No fact mentions an osprey, so the all-words read finds nothing.
  assert.deepEqual((await store.search('ava', 'osprey kestrel')).entries, []);
  assert.deepEqual(ids((await store.search('ava', 'osprey kestrel', { strategy: 'hybrid' })).entries), ['ava:memory:kestrel']);
  // Punctuation and operator words are still just words.
  assert.deepEqual(ids((await store.search('ava', 'kestrel OR "NOT AND', { strategy: 'hybrid' })).entries), ['ava:memory:kestrel']);
  const empty = await store.search('ava', '?!', { strategy: 'hybrid' });
  assert.deepEqual(empty, { entries: [], truncated: false, strategy: 'hybrid' });
});

test('a ranked search keeps forgotten and superseded facts out, and expired ones in and marked', async () => {
  const store = createFileMemoryStore(await seed([
    ...FILLER,
    { id: 'ava:memory:expired', content: 'the ferry leaves at nine', createdAt: '2026-01-01T00:00:00.000Z', validUntil: '2026-03-01T00:00:00.000Z' },
    { id: 'ava:memory:forgotten', content: 'the ferry leaves at ten', createdAt: '2026-02-01T00:00:00.000Z' },
    { id: 'ava:memory:replaced', content: 'the ferry leaves at eleven', createdAt: '2026-03-01T00:00:00.000Z' },
  ]), frozen);
  assert.equal(await store.forget('ava', 'ava:memory:forgotten'), true);
  const successor = await store.append('ava', 'the ferry leaves at noon', { supersedes: 'ava:memory:replaced' });

  for (const strategy of ['hybrid', 'relevance'] as const) {
    const found = await store.search('ava', 'ferry', { strategy });
    assert.deepEqual(new Set(ids(found.entries)), new Set(['ava:memory:expired', successor.id]), strategy);
    const expired = found.entries.find((entry) => entry.id === 'ava:memory:expired');
    assert.equal(expired && memoryValidityAt(expired, AT), 'expired');
  }
});

test('a ranked search keeps the limit and the byte budget, and says when more matched', async () => {
  const many = Array.from({ length: 12 }, (_, index) => ({
    id: `ava:memory:tern-${String(index).padStart(2, '0')}`,
    content: `tern sighting number ${index}`,
    createdAt: `2026-05-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
  }));
  const store = createFileMemoryStore(await seed([...FILLER, ...many]), frozen);
  const limited = await store.search('ava', 'tern', { strategy: 'hybrid', limit: 3 });
  assert.equal(limited.entries.length, 3);
  assert.equal(limited.truncated, true);
  // Equal relevance, so the newest three.
  assert.deepEqual(ids(limited.entries), ['ava:memory:tern-11', 'ava:memory:tern-10', 'ava:memory:tern-09']);

  // Five facts of just under 4 KiB each: the 16 KiB budget binds before the limit.
  const big = Array.from({ length: 5 }, (_, index) => ({
    id: `ava:memory:big-${index}`,
    content: `plover ${'x'.repeat(4000)}`,
    createdAt: `2026-04-0${index + 1}T00:00:00.000Z`,
  }));
  const budgeted = createFileMemoryStore(await seed([...FILLER, ...big]), frozen);
  const found = await budgeted.search('ava', 'plover', { strategy: 'hybrid', limit: 10 });
  assert.equal(found.entries.length, Math.floor(MEMORY_READ_MAX_BYTES / 4007));
  assert.equal(found.truncated, true);

  // An entry no budget could admit is skipped, not allowed to starve the rest.
  const oversized = createFileMemoryStore(await seed([
    ...FILLER,
    { id: 'ava:memory:huge', content: `grebe ${'grebe '.repeat(MEMORY_READ_MAX_BYTES / 6 + 10)}`, createdAt: '2026-05-01T00:00:00.000Z' },
    { id: 'ava:memory:small', content: 'a grebe on the lake', createdAt: '2026-01-01T00:00:00.000Z' },
  ]), frozen);
  const skipped = await oversized.search('ava', 'grebe', { strategy: 'hybrid', limit: 3 });
  assert.deepEqual(ids(skipped.entries), ['ava:memory:small']);
  assert.equal(skipped.truncated, true);
});

test('a fact with an unreadable date ranks as the oldest, not the newest', async () => {
  const store = createFileMemoryStore(await seed([
    ...FILLER,
    { id: 'ava:memory:a-undated', content: 'the dunlin flock roosts here', createdAt: 'last Tuesday' },
    { id: 'ava:memory:b-dated', content: 'the dunlin flock roosts here', createdAt: '2025-01-01T00:00:00.000Z' },
  ]), frozen);
  assert.deepEqual(
    ids((await store.search('ava', 'dunlin', { strategy: 'hybrid' })).entries),
    ['ava:memory:b-dated', 'ava:memory:a-undated'],
  );
});

test('the legacy alias wrapper keeps a ranked order instead of re-sorting it by date', async () => {
  const store = withLegacyDefaultMemories(createFileMemoryStore(await seed([
    ...FILLER.map((line) => ({ ...line, agentId: DEFAULT_STRATUS_AGENT.id })),
    { id: 'stratus:memory:old-exact', agentId: DEFAULT_STRATUS_AGENT.id, content: 'the deploy pipeline runs on Fridays', createdAt: '2026-02-01T00:00:00.000Z' },
    { id: 'stratus:memory:new-partial', agentId: DEFAULT_STRATUS_AGENT.id, content: 'the refunds pipeline is manual', createdAt: '2026-05-31T00:00:00.000Z' },
    { id: 'demo-agent:memory:legacy', agentId: 'demo-agent', content: 'the deploy pipeline needs a token', createdAt: '2025-12-01T00:00:00.000Z' },
  ]), frozen));

  const found = await store.search(DEFAULT_STRATUS_AGENT.id, 'deploy pipeline', { strategy: 'hybrid' });
  assert.equal(found.strategy, 'hybrid');
  // Each alias's best match ahead of either alias's weaker ones.
  assert.deepEqual(ids(found.entries), ['stratus:memory:old-exact', 'demo-agent:memory:legacy', 'stratus:memory:new-partial']);

  // And the recency read across aliases is what it always was.
  const recency = await store.search(DEFAULT_STRATUS_AGENT.id, 'deploy pipeline');
  assert.equal(recency.strategy, 'recency');
  assert.deepEqual(ids(recency.entries), ['stratus:memory:old-exact', 'demo-agent:memory:legacy']);
});
