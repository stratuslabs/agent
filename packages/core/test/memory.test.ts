import test from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryAgentMemoryStore,
  MEMORY_ENTRY_MAX_BYTES,
  MEMORY_READ_MAX_BYTES,
  MEMORY_RECALL_DEFAULT_LIMIT,
  MEMORY_RECALL_MAX_LIMIT,
  boundMemoryRead,
  clampMemoryRecallLimit,
  memoryContentByteLength,
  tokenizeMemoryText,
} from '../src/index.ts';

test('search matches every term, case-insensitively and NFC-normalized, on whole tokens', async () => {
  const store = new InMemoryAgentMemoryStore();
  await store.append('ava', 'Postgres 16 runs on the staging box');
  await store.append('ava', 'The postgresql migration guide is bookmarked');

  // `Postgres` finds `postgres`; `postgres` does not find `postgresql`.
  const hits = await store.search('ava', 'POSTGRES');
  assert.equal(hits.entries.length, 1);
  assert.match(hits.entries[0]?.content ?? '', /staging box/);

  // Every term must be present, not any.
  assert.equal((await store.search('ava', 'postgres migration')).entries.length, 0);
  assert.equal((await store.search('ava', 'postgres staging')).entries.length, 1);

  // NFC: composed and decomposed é are the same word.
  await store.append('ava', 'café orders arrive on Fridays');
  assert.equal((await store.search('ava', 'café')).entries.length, 1);
  // ...but stripping the accent is a different word, in both stores or neither.
  assert.equal((await store.search('ava', 'cafe')).entries.length, 0);
});

test('queries a model actually writes are searches, never errors', async () => {
  const store = new InMemoryAgentMemoryStore();
  await store.append('ava', 'the C build uses clang');
  // None of these may throw; each returns results or nothing.
  const awkward = ['C++', 'what "did I say', "it's AND nothing", '"""', '   ', '(NOT a query)'];
  for (const query of awkward) {
    const result = await store.search('ava', query);
    assert.ok(Array.isArray(result.entries), `query ${JSON.stringify(query)} should search, not throw`);
  }
  // A query with no searchable terms matches nothing rather than everything.
  assert.equal((await store.search('ava', '!!!')).entries.length, 0);
});

test('search orders newest first with the id tie-break; bounded list presents oldest first', async () => {
  let tick = 0;
  const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, tick));
  const store = new InMemoryAgentMemoryStore({ now: clock });
  await store.append('ava', 'shared moment one');
  await store.append('ava', 'shared moment two'); // same millisecond — the tie
  tick = 1;
  await store.append('ava', 'later fact');

  const search = await store.search('ava', 'shared moment');
  assert.deepEqual(search.entries.map((entry) => entry.content), ['shared moment one', 'shared moment two']);

  const everything = await store.search('ava', 'moment fact', 10);
  assert.equal(everything.entries.length, 0);

  // Selection uses the same order: on the createdAt tie, id ascending wins,
  // so `one` outranks `two` — the rule, applied, not an accident of insertion.
  const bounded = await store.list('ava', { limit: 2 });
  assert.deepEqual(bounded.entries.map((entry) => entry.content), ['shared moment one', 'later fact']);
  assert.equal(bounded.truncated, true);
});

test('forget tombstones: gone from search and bounded list, still in audit', async () => {
  const store = new InMemoryAgentMemoryStore();
  const kept = await store.append('ava', 'the kept fact about llamas');
  const dropped = await store.append('ava', 'the dropped fact about llamas');

  assert.equal(await store.forget('ava', dropped.id), true);
  // A second forget of the same entry is a miss, not a second tombstone.
  assert.equal(await store.forget('ava', dropped.id), false);
  // Another agent cannot forget it either.
  assert.equal(await store.forget('scout', kept.id), false);

  assert.deepEqual((await store.search('ava', 'llamas')).entries.map((entry) => entry.id), [kept.id]);
  assert.deepEqual((await store.list('ava', { limit: 10 })).entries.map((entry) => entry.id), [kept.id]);

  const audit = await store.audit('ava');
  assert.equal(audit.length, 2);
  const auditDropped = audit.find((entry) => entry.id === dropped.id);
  assert.ok(auditDropped?.forgottenAt, 'the audit read keeps the tombstoned entry, marked');
  assert.equal(audit.find((entry) => entry.id === kept.id)?.forgottenAt, undefined);
});

test('the bound applies after the tombstone filter, not before', async () => {
  const store = new InMemoryAgentMemoryStore();
  const live: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    live.push((await store.append('ava', `old live fact ${i}`)).id);
  }
  for (let i = 0; i < 10; i += 1) {
    const entry = await store.append('ava', `recent forgotten fact ${i}`);
    await store.forget('ava', entry.id);
  }
  // Recent entries are mostly tombstoned; the slice must still be full of live ones.
  const bounded = await store.list('ava', { limit: 5 });
  assert.deepEqual(bounded.entries.map((entry) => entry.id), live);
  assert.equal(bounded.truncated, false);
});

test('agents cannot read each other: the per-agent key is the boundary', async () => {
  const store = new InMemoryAgentMemoryStore();
  await store.append('ava', 'the shared word is heliotrope');
  await store.append('scout', 'the shared word is heliotrope');
  const forAva = await store.search('ava', 'heliotrope');
  assert.equal(forAva.entries.length, 1);
  assert.equal(forAva.entries[0]?.agentId, 'ava');
});

test('append refuses an over-cap fact and stores nothing — never a truncated version', async () => {
  const store = new InMemoryAgentMemoryStore();
  const oversized = 'x'.repeat(MEMORY_ENTRY_MAX_BYTES + 1);
  await assert.rejects(() => store.append('ava', oversized), /capped at \d+ UTF-8 bytes/);
  assert.equal((await store.list('ava')).entries.length, 0);
  // The cap is bytes, not characters: a multi-byte string trips it earlier.
  await assert.rejects(() => store.append('ava', 'é'.repeat(MEMORY_ENTRY_MAX_BYTES)), /capped/);
  // At the cap exactly is fine.
  await store.append('ava', 'y'.repeat(MEMORY_ENTRY_MAX_BYTES));
});

test('a store of cap-size entries stays within the byte budget, marked truncated', async () => {
  const store = new InMemoryAgentMemoryStore();
  for (let i = 0; i < 8; i += 1) {
    await store.append('ava', `wombat${i} ${'x'.repeat(MEMORY_ENTRY_MAX_BYTES - 10)}`);
  }
  for (const result of [await store.search('ava', 'x'.repeat(MEMORY_ENTRY_MAX_BYTES - 10), 8), await store.list('ava', { limit: 8 })]) {
    const bytes = result.entries.reduce((sum, entry) => sum + memoryContentByteLength(entry.content), 0);
    assert.ok(bytes <= MEMORY_READ_MAX_BYTES, `returned ${bytes} bytes, over the ${MEMORY_READ_MAX_BYTES} budget`);
    assert.ok(result.entries.length > 0, 'the budget bounds the read, it does not empty it');
    assert.equal(result.truncated, true);
  }
});

test('the recall limit is the store’s to clamp', () => {
  assert.equal(clampMemoryRecallLimit(undefined), MEMORY_RECALL_DEFAULT_LIMIT);
  assert.equal(clampMemoryRecallLimit(Number.NaN), MEMORY_RECALL_DEFAULT_LIMIT);
  assert.equal(clampMemoryRecallLimit(0), 1);
  assert.equal(clampMemoryRecallLimit(-5), 1);
  assert.equal(clampMemoryRecallLimit(3.7), 3);
  assert.equal(clampMemoryRecallLimit(10_000), MEMORY_RECALL_MAX_LIMIT);
  // "As many as allowed" clamps to the ceiling like any over-large number.
  assert.equal(clampMemoryRecallLimit(Number.POSITIVE_INFINITY), MEMORY_RECALL_MAX_LIMIT);
});

test('one entry no budget could admit is skipped, never allowed to starve the read', () => {
  // Written before the per-entry cap existed, or by hand: larger than the
  // whole read budget, and the newest entry — first in recall order.
  const monster = { id: 'm', agentId: 'x', content: 'y'.repeat(MEMORY_READ_MAX_BYTES + 1), createdAt: '2026-01-02T00:00:00.000Z' };
  const small = [
    { id: 'a', agentId: 'x', content: 'small fact a', createdAt: '2026-01-01T00:00:00.001Z' },
    { id: 'b', agentId: 'x', content: 'small fact b', createdAt: '2026-01-01T00:00:00.002Z' },
  ];
  const result = boundMemoryRead([monster, ...small], 10);
  assert.deepEqual(result.entries.map((entry) => entry.id), ['b', 'a']);
  assert.equal(result.truncated, true);
});

test('tokenizer and bounding helpers hold their edges', () => {
  assert.deepEqual(tokenizeMemoryText('C++ and fs.read, naturally'), ['c', 'and', 'fs', 'read', 'naturally']);
  assert.deepEqual(tokenizeMemoryText('  '), []);

  // truncated is about what was left out, not which bound was configured.
  const entries = [
    { id: 'a', agentId: 'x', content: 'one', createdAt: '2026-01-01T00:00:00.001Z' },
    { id: 'b', agentId: 'x', content: 'two', createdAt: '2026-01-01T00:00:00.002Z' },
  ];
  assert.equal(boundMemoryRead(entries, 2).truncated, false);
  assert.equal(boundMemoryRead(entries, 1).truncated, true);
  assert.deepEqual(boundMemoryRead(entries, 1).entries.map((entry) => entry.id), ['b']);
});
