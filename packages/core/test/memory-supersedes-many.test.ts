import test from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryAgentMemoryStore,
  memoryEntryFields,
  memorySupersededIds,
  supersededMemoryIdsAt,
  type MemoryEntry,
} from '../src/index.ts';

const AT = new Date('2026-06-01T00:00:00.000Z');

const entry = (id: string, content: string, extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id,
  agentId: 'ava',
  content,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});

test('a successor naming a list of ids retires every one of them, scoped to its own window like a single id', () => {
  const merged = entry('m4', 'the deploy runs on Postgres', { supersedes: ['m1', 'm2', 'm3'] });
  assert.deepEqual([...supersededMemoryIdsAt([merged], AT)].sort(), ['m1', 'm2', 'm3']);
  const future = entry('m5', 'later', { supersedes: ['m1', 'm2'], validFrom: '2026-07-01T00:00:00.000Z' });
  assert.deepEqual([...supersededMemoryIdsAt([future], AT)], []);
});

test('the ids a record supersedes read the same from a string, a list, and a malformed field', () => {
  assert.deepEqual(memorySupersededIds({}), []);
  assert.deepEqual(memorySupersededIds({ supersedes: 'm1' }), ['m1']);
  assert.deepEqual(memorySupersededIds({ supersedes: ['m1', 'm2', 'm1'] }), ['m1', 'm2']);
  assert.deepEqual(memorySupersededIds({ supersedes: '' }), []);
  // A list with anything but non-empty strings in it is the wrong shape,
  // and the wrong shape is dropped whole: duplicates, never a retirement
  // nobody wrote.
  assert.deepEqual(memorySupersededIds({ supersedes: ['m1', 7] } as unknown as MemoryEntry), []);
  assert.deepEqual(memorySupersededIds({ supersedes: ['m1', ''] }), []);
});

test('read back from an unvalidated record, a list keeps its shape and one id is a plain string', () => {
  assert.deepEqual(memoryEntryFields({ supersedes: ['m1', 'm2'] }), { supersedes: ['m1', 'm2'] });
  assert.deepEqual(memoryEntryFields({ supersedes: ['m1', 'm2', 'm2'] }), { supersedes: ['m1', 'm2'] });
  // One id is written the way every older reader understands.
  assert.deepEqual(memoryEntryFields({ supersedes: ['m1'] }), { supersedes: 'm1' });
  assert.deepEqual(memoryEntryFields({ supersedes: 'm1' }), { supersedes: 'm1' });
  assert.deepEqual(memoryEntryFields({ supersedes: [] }), {});
  assert.deepEqual(memoryEntryFields({ supersedes: ['m1', 3] } as unknown as MemoryEntry), {});
});

test('one append merges three facts into one, and forgetting it brings all three back', async () => {
  let tick = AT.getTime();
  const store = new InMemoryAgentMemoryStore({ now: () => new Date((tick += 1000)) });
  const a = await store.append('ava', 'the deploy runs on Postgres');
  const b = await store.append('ava', 'deploys go to Postgres');
  const c = await store.append('ava', 'Postgres is the deploy database');
  const merged = await store.append('ava', 'the deploy runs on Postgres', { supersedes: [a.id, b.id, c.id] });

  assert.deepEqual(merged.supersedes, [a.id, b.id, c.id]);
  assert.deepEqual((await store.list('ava')).entries.map((found) => found.id), [merged.id]);
  assert.deepEqual((await store.search('ava', 'Postgres')).entries.map((found) => found.id), [merged.id]);

  assert.equal(await store.forget('ava', merged.id), true);
  assert.deepEqual((await store.list('ava')).entries.map((found) => found.id), [a.id, b.id, c.id]);
});

test('a list naming one id is stored as that id, and repeats are stored once', async () => {
  const store = new InMemoryAgentMemoryStore({ now: () => AT });
  const a = await store.append('ava', 'one');
  const b = await store.append('ava', 'two');
  assert.equal((await store.append('ava', 'one, again', { supersedes: [a.id] })).supersedes, a.id);
  const both = await store.append('ava', 'two, again', { supersedes: [b.id, b.id] });
  assert.equal(both.supersedes, b.id);
});

test('a list naming any id that is not a live entry of this agent stores nothing', async () => {
  const store = new InMemoryAgentMemoryStore({ now: () => AT });
  const mine = await store.append('ava', 'mine');
  const theirs = await store.append('bea', 'theirs');
  await assert.rejects(
    () => store.append('ava', 'merged', { supersedes: [mine.id, theirs.id] }),
    new RegExp(`No live memory entry with id ${theirs.id}`),
  );
  await assert.rejects(() => store.append('ava', 'merged', { supersedes: [mine.id, 'ava:memory:nope'] }), /ava:memory:nope/);
  assert.deepEqual((await store.list('ava')).entries.map((found) => found.id), [mine.id]);
  assert.deepEqual((await store.list('bea')).entries.map((found) => found.id), [theirs.id]);
});

test('an append that refuses protected facts stores nothing when any fact it supersedes is pinned or labeled user', async () => {
  const store = new InMemoryAgentMemoryStore({ now: () => AT });
  const plain = await store.append('ava', 'plain');
  const pinned = await store.append('ava', 'pinned');
  await store.pin('ava', pinned.id);
  const asserted = await store.append('ava', 'asserted', { provenance: { trust: 'user' } });
  const reasserted = await store.append('ava', 'reasserted', { provenance: { trust: 'agent' } });
  assert.equal(await store.reassertTrust('ava', reasserted.id, 'user'), true);

  for (const target of [pinned.id, asserted.id, reasserted.id]) {
    await assert.rejects(
      () => store.append('ava', 'merged', { supersedes: [plain.id, target], refuseProtected: true }),
      new RegExp(`${target} is (pinned|a fact the operator asserted)`),
    );
  }
  assert.equal((await store.list('ava')).entries.length, 4);
  // Unprotected facts are superseded as before, and without the option the
  // store applies no such rule.
  await store.append('ava', 'plain, again', { supersedes: plain.id, refuseProtected: true });
  await store.append('ava', 'pinned, again', { supersedes: pinned.id });
  assert.deepEqual((await store.list('ava')).entries.map((entry) => entry.content).sort(), ['asserted', 'pinned, again', 'plain, again', 'reasserted']);
});

test('an append whose supersedes is malformed stores nothing, rather than a plain fact beside the ones it meant to replace', async () => {
  const store = new InMemoryAgentMemoryStore({ now: () => AT });
  const a = await store.append('ava', 'one');
  for (const supersedes of ['', [], [a.id, ''], [a.id, 7]]) {
    await assert.rejects(
      () => store.append('ava', 'one, again', { supersedes } as unknown as Parameters<typeof store.append>[2]),
      /supersedes/,
      JSON.stringify(supersedes),
    );
  }
  assert.deepEqual((await store.list('ava')).entries.map((found) => found.id), [a.id]);
});
