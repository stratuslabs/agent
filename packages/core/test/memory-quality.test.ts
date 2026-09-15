import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyMemoryPinBudget,
  asMemoryInjection,
  buildMemoryInjection,
  collectMemoryTopics,
  InMemoryAgentMemoryStore,
  isMemoryEntryCurrent,
  MEMORY_PINNED_MAX_BYTES,
  MEMORY_RECENCY_INJECTION_LIMIT,
  memoryContentByteLength,
  memoryEntryTokens,
  memoryQueryMatches,
  memoryValidityAt,
  mergeMemoryTopics,
  renderMemorySection,
  selectMemoryInjection,
  supersededMemoryIdsAt,
  tokenizeMemoryText,
  type MemoryEntry,
  type MemoryTopic,
} from '../src/index.ts';

const AT = new Date('2026-06-01T00:00:00.000Z');

const entry = (id: string, content: string, extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id,
  agentId: 'ava',
  content,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});

test('a query matches an entry’s about keys, not only its content', () => {
  const aliased = entry('m1', 'it now runs on Postgres', { about: ['deploy pipeline', 'Hermes'] });
  assert.ok(memoryQueryMatches(aliased, tokenizeMemoryText('deploy pipeline')));
  assert.ok(memoryQueryMatches(aliased, tokenizeMemoryText('hermes postgres')));
  // The entity alias against a pronoun in the content is the case the field
  // exists for: neither half alone would find it.
  assert.ok(!memoryQueryMatches(entry('m2', 'it now runs on Postgres'), tokenizeMemoryText('deploy pipeline')));
  // And the token stream the index has to mirror is content plus about.
  assert.deepEqual(memoryEntryTokens(aliased), ['it', 'now', 'runs', 'on', 'postgres', 'deploy', 'pipeline', 'hermes']);
  // A hand-edited `about` that is not an array of strings costs nothing.
  const mangled = { ...entry('m3', 'a fact'), about: 'deploy' as unknown as string[] };
  assert.deepEqual(memoryEntryTokens(mangled), ['a', 'fact']);
});

test('validity is one rule for both bounds, and an unparseable bound is no bound', () => {
  assert.equal(memoryValidityAt(entry('m1', 'x'), AT), 'current');
  assert.equal(memoryValidityAt(entry('m1', 'x', { validUntil: '2026-05-01T00:00:00.000Z' }), AT), 'expired');
  assert.equal(memoryValidityAt(entry('m1', 'x', { validFrom: '2026-07-01T00:00:00.000Z' }), AT), 'not-yet-valid');
  assert.equal(memoryValidityAt(entry('m1', 'x', { validFrom: '2026-05-01T00:00:00.000Z' }), AT), 'current');
  // `validUntil` is the instant it stops holding, exclusive.
  assert.equal(memoryValidityAt(entry('m1', 'x', { validUntil: AT.toISOString() }), AT), 'expired');
  assert.equal(memoryValidityAt(entry('m1', 'x', { validFrom: AT.toISOString() }), AT), 'current');
  // A bound somebody hand-wrote as prose must not retire the fact it is on.
  assert.ok(isMemoryEntryCurrent(entry('m1', 'x', { validUntil: 'soon' }), AT));
});

test('supersession retires a fact exactly while its successor is current', () => {
  const old = entry('m1', 'the deploy runs on MySQL');
  const future = entry('m2', 'the deploy runs on Postgres', { supersedes: 'm1', validFrom: '2026-07-01T00:00:00.000Z' });
  // Before the successor takes effect the old fact still stands — the
  // failure this catches is both vanishing from the prompt at once.
  assert.deepEqual([...supersededMemoryIdsAt([old, future], AT)], []);
  assert.deepEqual([...supersededMemoryIdsAt([old, future], new Date('2026-08-01T00:00:00.000Z'))], ['m1']);
  // An already-expired successor displaces nothing.
  const expired = entry('m3', 'the deploy runs on Oracle', { supersedes: 'm1', validUntil: '2026-02-01T00:00:00.000Z' });
  assert.deepEqual([...supersededMemoryIdsAt([old, expired], AT)], []);
  // Two successors retire it once and both stay live: the invariant is the
  // retirement, not a unique replacement.
  const a = entry('m4', 'Postgres', { supersedes: 'm1' });
  const b = entry('m5', 'CockroachDB', { supersedes: 'm1' });
  assert.deepEqual([...supersededMemoryIdsAt([old, a, b], AT)], ['m1']);
  assert.deepEqual([...supersededMemoryIdsAt([old, b, a], AT)], ['m1']);
});

test('the pin budget is a prefix in append order, and a later record cannot displace an effective pin', () => {
  const size = (id: string): number | undefined => ({ a: 1500, b: 600, c: 100 } as Record<string, number>)[id];
  // `a` then `b`: `a` fits, `b` does not, and `c` behind it is inert too —
  // "the remainder" is a prefix rule, so an effective set never depends on
  // how large the next pin happens to be.
  assert.deepEqual(applyMemoryPinBudget(['a', 'b', 'c'], size), { effective: ['a'], inert: ['b', 'c'], bytes: 1500 });
  // Arrival order, not size order: the same three the other way round.
  assert.deepEqual(applyMemoryPinBudget(['c', 'b', 'a'], size), { effective: ['c', 'b'], inert: ['a'], bytes: 700 });
  // A pin naming an entry that is no longer live costs nothing and does not
  // make the rest of the lane inert.
  assert.deepEqual(applyMemoryPinBudget(['gone', 'c'], size), { effective: ['c'], inert: [], bytes: 100 });
});

test('the topic index counts entities, orders by weight, and never rises above the least trusted entry', () => {
  const topics = collectMemoryTopics([
    entry('m1', 'one', { about: ['Deploy Pipeline'], trust: 'user', createdAt: '2026-01-01T00:00:00.000Z' }),
    entry('m2', 'two', { about: ['deploy pipeline'], trust: 'external', createdAt: '2026-03-01T00:00:00.000Z' }),
    entry('m3', 'three', { about: ['Hermes'], trust: 'user' }),
  ]);
  assert.deepEqual(topics, [
    // The first spelling wins, the count is the fold, and the label is the
    // lowest of the contributing entries — a topic is a view derived from
    // entries and renders under the same invariant they do.
    { name: 'Deploy Pipeline', count: 2, lastUpdatedAt: '2026-03-01T00:00:00.000Z', trust: 'external' },
    { name: 'Hermes', count: 1, lastUpdatedAt: '2026-01-01T00:00:00.000Z', trust: 'user' },
  ]);
  // Merging two stores' lists gives what reading them together would have.
  assert.deepEqual(
    mergeMemoryTopics(topics, [{ name: 'hermes', count: 3, lastUpdatedAt: '2026-04-01T00:00:00.000Z', trust: 'agent' }]),
    [
      { name: 'Hermes', count: 4, lastUpdatedAt: '2026-04-01T00:00:00.000Z', trust: 'agent' },
      { name: 'Deploy Pipeline', count: 2, lastUpdatedAt: '2026-03-01T00:00:00.000Z', trust: 'external' },
    ],
  );
});

test('the injected slice keeps its blocks disjoint and never lets volume push the pinned core out', async () => {
  // A ticking clock: ten thousand appends inside one real millisecond
  // would all tie on `createdAt` and order by id, which is the contract's
  // tie-break and not what this test is about.
  let tick = AT.getTime();
  const store = new InMemoryAgentMemoryStore({ now: () => new Date((tick += 1)) });
  const anchor = await store.append('ava', 'The operator is Dylan and prefers terse answers.', { about: ['Dylan'] });
  assert.equal((await store.pin!('ava', anchor.id)).pinned, true);
  // Ten thousand entries is the volume case: the tail is what shrinks.
  for (let index = 0; index < 10_000; index += 1) {
    await store.append('ava', `numbered fact ${index}`, { about: [`topic ${index % 7}`] });
  }
  const injection = await buildMemoryInjection(store, 'ava');
  assert.deepEqual(injection.pinned.map((pinned) => pinned.id), [anchor.id]);
  assert.equal(injection.recent.length, MEMORY_RECENCY_INJECTION_LIMIT);
  // The pinned entry is not paid for twice.
  assert.ok(!injection.recent.some((recent) => recent.id === anchor.id));
  assert.equal(injection.topics.length, 8);
  const pinnedBytes = injection.pinned.reduce((sum, pinned) => sum + memoryContentByteLength(pinned.content), 0);
  assert.ok(pinnedBytes <= MEMORY_PINNED_MAX_BYTES);
});

test('the memory section renders three blocks as one section, each grouped by trust', () => {
  const rendered = renderMemorySection({
    pinned: [entry('m1', 'The operator is Dylan.', { trust: 'user' })],
    topics: [
      { name: 'deploy pipeline', count: 4, lastUpdatedAt: '2026-03-02T00:00:00.000Z', trust: 'external' },
      { name: 'Dylan', count: 2, lastUpdatedAt: '2026-01-05T00:00:00.000Z', trust: 'user' },
    ],
    recent: [entry('m2', 'A page said refunds are automatic.', { trust: 'external' })],
  }) ?? '';
  assert.match(rendered, /Kept in front of you on purpose/);
  assert.match(rendered, /by topic/);
  assert.match(rendered, /- deploy pipeline \(4 facts, last 2026-03-02\)/);
  assert.match(rendered, /- Dylan \(2 facts, last 2026-01-05\)/);
  assert.match(rendered, /Recently remembered:/);
  // The external topic renders under the external heading, not the
  // operator's: an entity name a stranger's text supplied is still a
  // stranger's words.
  const externalHeading = rendered.indexOf('Facts you recorded after reading content from outside');
  const userHeading = rendered.indexOf('Facts your operator told you');
  assert.ok(rendered.indexOf('- deploy pipeline') > externalHeading);
  assert.ok(rendered.indexOf('- Dylan') > userHeading && rendered.indexOf('- Dylan') < externalHeading);

  // A bare array is still the recency tail alone, rendered exactly as it
  // was before the three blocks existed — no block intro at all.
  const tailOnly = renderMemorySection([entry('m3', 'Just a fact.', { trust: 'agent' })]) ?? '';
  assert.equal(tailOnly, 'Things you remember from previous conversations (your own long-term memory):\n- Just a fact.');
  assert.deepEqual(asMemoryInjection(undefined), { pinned: [], topics: [], recent: [] });
  assert.equal(renderMemorySection(undefined), undefined);
  assert.equal(renderMemorySection(selectMemoryInjection({ pinned: [], topics: [], recent: [] })), undefined);
});

test('an out-of-window entry leaves what is true now and stays findable, in the in-memory store', async () => {
  const store = new InMemoryAgentMemoryStore({ now: () => AT });
  const expired = await store.append('ava', 'Ada works at Northwind', { validUntil: '2026-02-01T00:00:00.000Z' });
  const future = await store.append('ava', 'Ada works at Contoso', { validFrom: '2026-09-01T00:00:00.000Z' });
  const current = await store.append('ava', 'Ada lives in Leeds');

  assert.deepEqual((await store.list('ava', { limit: 10 })).entries.map((found) => found.id), [current.id]);
  assert.deepEqual(
    (await store.list('ava', { limit: 10, validity: 'all' })).entries.map((found) => found.id).sort(),
    [expired.id, future.id, current.id].sort(),
  );
  // Both stay findable — that is what separates validity from supersession.
  assert.equal((await store.search('ava', 'Ada')).entries.length, 3);
  // And a pinned entry that is not true yet does not reach the pinned core.
  assert.equal((await store.pin!('ava', future.id)).pinned, true);
  assert.deepEqual(await store.pinned!('ava'), []);
  // Nor the topic index.
  await store.append('ava', 'Ada is on leave', { about: ['Ada'], validFrom: '2026-09-01T00:00:00.000Z' });
  assert.deepEqual(await store.topics!('ava'), []);
});

test('the pinned cap refuses naming itself and drops nothing already pinned', async () => {
  const store = new InMemoryAgentMemoryStore({ now: () => AT });
  const first = await store.append('ava', 'a'.repeat(MEMORY_PINNED_MAX_BYTES - 100));
  const second = await store.append('ava', 'b'.repeat(200));
  assert.equal((await store.pin!('ava', first.id)).pinned, true);
  const refused = await store.pin!('ava', second.id);
  assert.equal(refused.pinned, false);
  assert.match(refused.reason ?? '', new RegExp(String(MEMORY_PINNED_MAX_BYTES)));
  assert.match(refused.reason ?? '', /nothing was dropped/);
  assert.deepEqual((await store.pinned!('ava')).map((pinned) => pinned.id), [first.id]);
  // Unpinning frees the budget, and re-pinning the first now refuses.
  assert.equal(await store.unpin!('ava', first.id), true);
  assert.equal((await store.pin!('ava', second.id)).pinned, true);
  assert.deepEqual((await store.pinned!('ava')).map((pinned) => pinned.id), [second.id]);
});

test('an agent cannot supersede or pin an entry that is not its own', async () => {
  const store = new InMemoryAgentMemoryStore({ now: () => AT });
  const victim = await store.append('juno', 'Juno knows the release password hint.');
  await assert.rejects(
    () => store.append('ava', 'that is out of date', { supersedes: victim.id }),
    /No live memory entry with id .* belongs to this agent/,
  );
  await assert.rejects(() => store.pin!('ava', victim.id), /belongs to this agent/);
  // Asserted against the victim's reads, not the attacker's error: a
  // refusal that still appended the record would pass an error-message test.
  assert.deepEqual((await store.list('juno', { limit: 10 })).entries.map((found) => found.id), [victim.id]);
  assert.equal((await store.search('juno', 'password')).entries.length, 1);
  assert.deepEqual(await buildMemoryInjection(store, 'juno').then((slice) => slice.recent.map((found) => found.id)), [victim.id]);
  // And nothing of the attacker's was written.
  assert.deepEqual((await store.audit('ava')).map((found) => found.id), []);
});

test('usage counters ride the read, never the record', async () => {
  const store = new InMemoryAgentMemoryStore({ now: () => AT });
  const written = await store.append('ava', 'the heron rookery is on the north bank');
  assert.equal(written.usage, undefined);
  assert.equal((await store.list('ava', { limit: 5 })).entries[0]?.usage, undefined);
  assert.deepEqual((await store.search('ava', 'heron')).entries[0]?.usage, { recallCount: 1, lastRecalledAt: AT.toISOString() });
  assert.deepEqual((await store.search('ava', 'heron')).entries[0]?.usage, { recallCount: 2, lastRecalledAt: AT.toISOString() });
  // The audit read is the record, so it carries none either.
  assert.equal((await store.audit('ava'))[0]?.usage, undefined);
});

test('a store asked for a strategy it does not implement serves recency and says so', async () => {
  const store = new InMemoryAgentMemoryStore({ now: () => AT });
  await store.append('ava', 'the rookery survey is quarterly');
  for (const strategy of ['recency', 'relevance', 'hybrid'] as const) {
    const found = await store.search('ava', 'rookery', { strategy });
    assert.equal(found.strategy, 'recency', `${strategy} should fall back, reported, rather than error`);
    assert.equal(found.entries.length, 1);
  }
});

test('the topic index the prompt carries is bounded, and the biggest topics survive', () => {
  const topics: MemoryTopic[] = Array.from({ length: 400 }, (_, index) => ({
    name: `topic-${String(index).padStart(3, '0')}-${'x'.repeat(40)}`,
    count: 400 - index,
    lastUpdatedAt: '2026-01-01T00:00:00.000Z',
    trust: 'agent' as const,
  }));
  const selected = selectMemoryInjection({ pinned: [], topics, recent: [] });
  assert.ok(selected.topics.length < topics.length, 'the budget has to bite for this to mean anything');
  assert.equal(selected.topics[0]?.count, 400);
  const rendered = renderMemorySection(selected) ?? '';
  assert.ok(memoryContentByteLength(rendered) < 8192, `the index block ran to ${memoryContentByteLength(rendered)} bytes`);
});
