import test from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryAgentMemoryStore,
  lowerSessionTrust,
  MEMORY_PASS_MAX_SAVES,
  type MemoryEntry,
  type Session,
} from '@stratusagent/core';
import { createMemoryPassTools, type MemoryPassToolState } from '../src/index.ts';

const passSession = (agentId = 'ava'): Session =>
  ({ id: 'pass-session', agent: { id: agentId, name: 'Test' }, messages: [], status: 'running' }) as unknown as Session;

const stateFor = (overrides: Partial<MemoryPassToolState> = {}): MemoryPassToolState => ({
  passId: 'p1',
  kind: 'save',
  sourceSessionId: 'conversation-1',
  trust: 'agent',
  ...overrides,
});

type Recalled = { results: { id: string }[] };
type Remembered = { remembered: boolean; id: string; trust: string };

test('a pass saves a marked fact under the source session, at the slice label', async () => {
  const store = new InMemoryAgentMemoryStore();
  const { recall, remember, tally } = createMemoryPassTools(store, stateFor({ trust: 'external' }));
  assert.equal(recall.name, 'memory.recall');
  assert.equal(remember.name, 'memory.remember');

  const saved = await remember.execute({ fact: 'Ava prefers short replies.', kind: 'preference', about: ['Ava'] }, passSession()) as Remembered;
  assert.equal(saved.trust, 'external', 'the slice label, never the pass session\'s own');
  const [entry] = (await store.list('ava')).entries as MemoryEntry[];
  assert.deepEqual(entry?.metadata?.memoryPass, { id: 'p1', kind: 'save' });
  assert.equal(entry?.origin?.sessionId, 'conversation-1');
  assert.deepEqual(tally(), { saved: 1, superseded: 0 });
});

test('a pass refuses episodic facts', async () => {
  const store = new InMemoryAgentMemoryStore();
  const { remember } = createMemoryPassTools(store, stateFor());
  await assert.rejects(
    () => remember.execute({ fact: 'Deployed 0.14.3 today.', kind: 'episodic' }, passSession()),
    /episodic/,
  );
  assert.equal((await store.list('ava')).entries.length, 0);
});

test('a pass saves at most its cap', async () => {
  const store = new InMemoryAgentMemoryStore();
  const { remember, tally } = createMemoryPassTools(store, stateFor());
  for (let index = 0; index < MEMORY_PASS_MAX_SAVES; index += 1) {
    await remember.execute({ fact: `Fact number ${index}.` }, passSession());
  }
  await assert.rejects(() => remember.execute({ fact: 'One too many.' }, passSession()), /at most/);
  assert.equal((await store.list('ava')).entries.length, MEMORY_PASS_MAX_SAVES);
  assert.deepEqual(tally(), { saved: MEMORY_PASS_MAX_SAVES, superseded: 0 });
});

test('a pass supersedes only a fact its own recall showed it', async () => {
  const store = new InMemoryAgentMemoryStore();
  const shown = await store.append('ava', 'Ava prefers short replies.');
  const unseen = await store.append('ava', 'The deploy runs on Tuesdays.');
  const { recall, remember, tally } = createMemoryPassTools(store, stateFor());

  await assert.rejects(
    () => remember.execute({ fact: 'The deploy runs on Mondays.', supersedes: unseen.id }, passSession()),
    /shown/,
    'a transcript naming an id cannot retire a fact the pass never saw',
  );
  const found = await recall.execute({ query: 'short replies' }, passSession()) as Recalled;
  assert.deepEqual(found.results.map((result) => result.id), [shown.id]);
  await remember.execute({ fact: 'Ava prefers short replies, answer first.', kind: 'preference', supersedes: shown.id }, passSession());
  const live = (await store.list('ava')).entries.map((entry) => entry.content).sort();
  assert.deepEqual(live, ['Ava prefers short replies, answer first.', 'The deploy runs on Tuesdays.']);
  assert.deepEqual(tally(), { saved: 1, superseded: 1 });
});

test('a pass never supersedes a pinned fact or one the operator asserted', async () => {
  const store = new InMemoryAgentMemoryStore();
  const pinned = await store.append('ava', 'Ava is the release owner.');
  await store.pin?.('ava', pinned.id);
  const asserted = await store.append('ava', 'Ava works in New York.', { provenance: { trust: 'user' } });
  const { recall, remember } = createMemoryPassTools(store, stateFor());
  await recall.execute({ query: 'Ava' }, passSession());

  await assert.rejects(() => remember.execute({ fact: 'Ava owns releases and CI.', supersedes: pinned.id }, passSession()), /pinned/);
  await assert.rejects(() => remember.execute({ fact: 'Ava works in Boston.', supersedes: asserted.id }, passSession()), /operator/);
  assert.equal((await store.list('ava')).entries.length, 2);
});

test('a fact the operator asserts after the recall is still never superseded: the label is read again at write time', async () => {
  const store = new InMemoryAgentMemoryStore();
  const fact = await store.append('ava', 'Ava works in New York.');
  const { recall, remember } = createMemoryPassTools(store, stateFor());
  await recall.execute({ query: 'Ava' }, passSession());
  // Between the pass's recall and its write, an operator reasserts it.
  assert.equal(await store.reassertTrust('ava', fact.id, 'user'), true);
  await assert.rejects(() => remember.execute({ fact: 'Ava works in Boston.', supersedes: fact.id }, passSession()), /operator/);
  assert.equal((await store.list('ava')).entries.length, 1);
});

test('a shadow pass writes through its own writer and leaves the store alone', async () => {
  const store = new InMemoryAgentMemoryStore();
  const written: { agentId: string; content: string; metadata: unknown }[] = [];
  const { remember, tally } = createMemoryPassTools(store, stateFor(), {
    write: async (agentId, content, options) => {
      written.push({ agentId, content, metadata: options.metadata });
      return { id: `shadow-${written.length}`, trust: options.provenance?.trust ?? 'unknown' };
    },
  });
  const saved = await remember.execute({ fact: 'Ava prefers short replies.' }, passSession()) as Remembered;
  assert.equal(saved.id, 'shadow-1');
  assert.deepEqual(written, [{ agentId: 'ava', content: 'Ava prefers short replies.', metadata: { memoryPass: { id: 'p1', kind: 'save' } } }]);
  assert.equal((await store.list('ava')).entries.length, 0);
  assert.deepEqual(tally(), { saved: 1, superseded: 0 });
});

test('a pass whose own recall read an outside fact writes at that lower label', async () => {
  const store = new InMemoryAgentMemoryStore();
  const { remember } = createMemoryPassTools(store, stateFor({ trust: 'agent' }));
  const session = passSession();
  lowerSessionTrust(session, 'external', 'memory');
  const saved = await remember.execute({ fact: 'The build host is mini-3.' }, session) as Remembered;
  assert.equal(saved.trust, 'external');
});

test('a pass merges duplicates its recall showed it into one fact, and the tally counts every fact retired', async () => {
  const store = new InMemoryAgentMemoryStore();
  const a = await store.append('ava', 'Ava prefers short replies.');
  const b = await store.append('ava', 'Ava likes replies short.');
  const c = await store.append('ava', 'Keep replies to Ava short.');
  const { recall, remember, tally } = createMemoryPassTools(store, stateFor(), { supersedesMany: true });
  await recall.execute({ query: 'Ava replies' }, passSession());

  const saved = await remember.execute(
    { fact: 'Ava prefers short replies.', kind: 'preference', supersedes: [a.id, b.id, c.id] },
    passSession(),
  ) as Remembered & { supersedes?: unknown };
  assert.deepEqual(saved.supersedes, [a.id, b.id, c.id]);
  assert.deepEqual((await store.list('ava')).entries.map((entry) => entry.id), [saved.id]);
  assert.deepEqual(tally(), { saved: 1, superseded: 3 });
  // One forget of what the pass wrote brings all three back.
  assert.equal(await store.forget('ava', saved.id), true);
  assert.deepEqual((await store.list('ava')).entries.map((entry) => entry.id), [a.id, b.id, c.id]);
});

test('a pass on a store that takes one id per fact refuses a merge of several and stores nothing', async () => {
  const store = new InMemoryAgentMemoryStore();
  const a = await store.append('ava', 'Ava prefers short replies.');
  const b = await store.append('ava', 'Ava likes replies short.');
  const { recall, remember, tally } = createMemoryPassTools(store, stateFor());
  await recall.execute({ query: 'Ava replies' }, passSession());

  await assert.rejects(
    () => remember.execute({ fact: 'Ava prefers short replies.', supersedes: [a.id, b.id] }, passSession()),
    /one fact at a time/,
  );
  assert.equal((await store.list('ava')).entries.length, 2);
  // One id, in either form, still works on such a store.
  await remember.execute({ fact: 'Ava prefers short replies, answer first.', supersedes: [a.id] }, passSession());
  assert.deepEqual(tally(), { saved: 1, superseded: 1 });
});

test('a merge naming any fact the pass may not supersede stores nothing', async () => {
  const store = new InMemoryAgentMemoryStore();
  const a = await store.append('ava', 'Ava prefers short replies.');
  const pinned = await store.append('ava', 'Ava likes replies short.');
  await store.pin?.('ava', pinned.id);
  const asserted = await store.append('ava', 'Keep replies to Ava short.', { provenance: { trust: 'user' } });
  const unseen = await store.append('ava', 'The deploy runs on Tuesdays.');
  const { recall, remember } = createMemoryPassTools(store, stateFor(), { supersedesMany: true });
  await recall.execute({ query: 'Ava replies' }, passSession());

  await assert.rejects(() => remember.execute({ fact: 'merged', supersedes: [a.id, unseen.id] }, passSession()), /shown/);
  await assert.rejects(() => remember.execute({ fact: 'merged', supersedes: [a.id, pinned.id] }, passSession()), /pinned/);
  await assert.rejects(() => remember.execute({ fact: 'merged', supersedes: [a.id, asserted.id] }, passSession()), /operator/);
  await assert.rejects(() => remember.execute({ fact: 'merged', supersedes: [a.id, 7] }, passSession()), /supersedes/);
  assert.equal((await store.list('ava')).entries.length, 4);
});

test('a tidy pass may supersede what it was handed, and recalls only facts with its own label, so no recall lowers it', async () => {
  const store = new InMemoryAgentMemoryStore();
  const handed = await store.append('ava', 'the deploy runs on Postgres', { provenance: { trust: 'agent' } });
  await store.append('ava', 'a page said the deploy runs on MySQL', { provenance: { trust: 'external' } });
  const tools = createMemoryPassTools(store, {
    passId: 'p1',
    kind: 'tidy',
    trust: 'agent',
    handed: [{ id: handed.id, trust: 'agent' }],
    recallOnly: 'agent',
  }, { supersedesMany: true });
  // The pass session starts at the group's label, as the host starts it.
  const session = { ...passSession(), metadata: { sessionTrust: 'agent' } } as Session;
  // Handed, so no recall is needed first.
  const merged = await tools.remember.execute({ fact: 'The deploy database is Postgres.', supersedes: [handed.id] }, session) as { supersedes?: unknown; trust?: string };
  assert.deepEqual([merged.supersedes, merged.trust], [handed.id, 'agent']);
  const marked: string[] = [];
  const result = await tools.recall.execute({ query: 'deploy' }, session, { markTrust: (trust: string) => marked.push(trust) } as never) as { results: Array<{ trust: string }> };
  assert.deepEqual(result.results.map((found) => found.trust), ['agent']);
  assert.deepEqual(marked, [], 'the external fact never reached the pass');
});

test('a tidy pass recalls only facts true now: one past its window is not shown, so it cannot be merged back to life', async () => {
  const store = new InMemoryAgentMemoryStore();
  const stale = await store.append('ava', 'the deploy ran on MySQL', { provenance: { trust: 'agent' }, validUntil: '2026-01-01T00:00:00.000Z' });
  await store.append('ava', 'the deploy runs on Postgres', { provenance: { trust: 'agent' } });
  const tools = createMemoryPassTools(store, { passId: 'p1', kind: 'tidy', trust: 'agent', recallOnly: 'agent' }, {
    supersedesMany: true,
    now: () => new Date('2026-11-01T00:00:00.000Z'),
  });
  const session = { ...passSession(), metadata: { sessionTrust: 'agent' } } as Session;
  const result = await tools.recall.execute({ query: 'deploy' }, session) as { results: Array<{ id: string }> };
  assert.equal(result.results.length, 1);
  assert.equal(result.results.some((found) => found.id === stale.id), false);
  await assert.rejects(() => tools.remember.execute({ fact: 'merged', supersedes: [stale.id] }, session), /shown/);
});

test('a fact the operator lowers while a pass runs lowers the fact that replaces it', async () => {
  const store = new InMemoryAgentMemoryStore();
  const handed = await store.append('ava', 'the deploy runs on Postgres', { provenance: { trust: 'agent' } });
  const other = await store.append('ava', 'deploys go to Postgres', { provenance: { trust: 'agent' } });
  const tools = createMemoryPassTools(store, {
    passId: 'p1',
    kind: 'tidy',
    trust: 'agent',
    handed: [{ id: handed.id, trust: 'agent' }, { id: other.id, trust: 'agent' }],
    recallOnly: 'agent',
  }, { supersedesMany: true });
  // After the chunk was taken, before the merge is written.
  assert.equal(await store.reassertTrust('ava', other.id, 'external'), true);
  const session = { ...passSession(), metadata: { sessionTrust: 'agent' } } as Session;
  const merged = await tools.remember.execute({ fact: 'The deploy database is Postgres.', supersedes: [handed.id, other.id] }, session) as { trust: string };
  assert.equal(merged.trust, 'external', 'never more trusted than a fact it replaces is now');
});

/** A shadow writer as the gateway's: its facts land outside the store, so the store's search never sees them. */
type Shown = { results: { id: string; content: string; trust: string; about?: string[] }[]; truncated: boolean };

const fakeShadowWriter = () => {
  const written: { id: string; content: string; supersedes?: unknown }[] = [];
  const write = async (_agentId: string, content: string, options: { provenance?: { trust: string }; supersedes?: unknown }) => {
    const id = `shadow-${written.length + 1}`;
    written.push({ id, content, ...(options.supersedes !== undefined ? { supersedes: options.supersedes } : {}) });
    return { id, trust: (options.provenance?.trust ?? 'unknown') as 'agent' };
  };
  return { written, write };
};

test('a shadow pass\'s recall shows the facts it wrote this pass, so it sees its own duplicate and may supersede it', async () => {
  const store = new InMemoryAgentMemoryStore();
  const shadow = fakeShadowWriter();
  const { recall, remember, tally } = createMemoryPassTools(store, stateFor(), { write: shadow.write });
  const first = await remember.execute({ fact: 'Ava prefers short replies.', kind: 'preference', about: ['Ava'] }, passSession()) as Remembered;

  const found = await recall.execute({ query: 'Ava replies' }, passSession()) as Shown;
  assert.deepEqual(found.results.map((fact) => [fact.id, fact.content, fact.trust, fact.about]), [[first.id, 'Ava prefers short replies.', first.trust, ['Ava']]]);
  assert.deepEqual((await recall.execute({ query: 'deploy' }, passSession()) as Recalled).results, [], 'a fact that does not match is not shown');

  const second = await remember.execute({ fact: 'Ava prefers short replies, answer first.', supersedes: first.id }, passSession()) as Remembered;
  assert.deepEqual((await recall.execute({ query: 'Ava replies' }, passSession()) as Recalled).results.map((fact) => fact.id), [second.id]);
  assert.deepEqual(tally(), { saved: 2, superseded: 1 });
  assert.equal((await store.list('ava')).entries.length, 0, 'the store is untouched');
});

test('a shadow pass\'s recall hides a fact it superseded, and the pass never supersedes one id twice, in either mode', async () => {
  for (const mode of ['shadow', 'write'] as const) {
    const store = new InMemoryAgentMemoryStore();
    const fact = await store.append('ava', 'Ava works in Boston.');
    const shadow = fakeShadowWriter();
    const { recall, remember, tally } = createMemoryPassTools(store, stateFor(), mode === 'shadow' ? { write: shadow.write } : {});
    await recall.execute({ query: 'Ava' }, passSession());
    await remember.execute({ fact: 'Ava works in Denver.', supersedes: fact.id }, passSession());

    const after = await recall.execute({ query: 'Ava' }, passSession()) as Shown;
    assert.deepEqual(after.results.map((found) => found.content), ['Ava works in Denver.'], `${mode}: the superseded fact is hidden`);
    await assert.rejects(
      () => remember.execute({ fact: 'Ava works in Austin.', supersedes: fact.id }, passSession()),
      mode === 'shadow' ? /already superseded/ : /No live memory entry/,
      `${mode}: a second supersede of one id is refused`,
    );
    assert.deepEqual(tally(), { saved: 1, superseded: 1 }, mode);
    assert.equal(shadow.written.length, mode === 'shadow' ? 1 : 0, mode);
  }
});

test('a successor not true yet retires nothing, in either mode: the fact it names is still shown and may be superseded again', async () => {
  for (const mode of ['shadow', 'write'] as const) {
    const store = new InMemoryAgentMemoryStore();
    const fact = await store.append('ava', 'Ava works in Boston.');
    const shadow = fakeShadowWriter();
    const { recall, remember, tally } = createMemoryPassTools(store, stateFor(), mode === 'shadow' ? { write: shadow.write } : {});
    await recall.execute({ query: 'Ava' }, passSession());
    await remember.execute({ fact: 'Ava works in Denver.', validFrom: '2099-01-01T00:00:00.000Z', supersedes: fact.id }, passSession());

    const after = await recall.execute({ query: 'Ava' }, passSession()) as Shown;
    assert.deepEqual(after.results.map((found) => found.content).sort(), ['Ava works in Boston.', 'Ava works in Denver.'], mode);
    await remember.execute({ fact: 'Ava works in Austin.', supersedes: fact.id }, passSession());
    assert.deepEqual(tally(), { saved: 2, superseded: 2 }, mode);
  }
});

test('a shadow pass\'s recall fills the limit past a fact it retired, as a write-mode recall would', async () => {
  const store = new InMemoryAgentMemoryStore();
  const older = await store.append('ava', 'Ava works in Boston.');
  const newer = await store.append('ava', 'Ava works in Chicago.');
  const shadow = fakeShadowWriter();
  const { recall, remember } = createMemoryPassTools(store, stateFor(), { write: shadow.write });
  await recall.execute({ query: 'Ava works' }, passSession());
  await remember.execute({ fact: 'Her home is Denver now.', supersedes: newer.id }, passSession());

  const one = await recall.execute({ query: 'Ava works', limit: 1 }, passSession()) as Shown;
  assert.deepEqual([one.results.map((found) => found.id), one.truncated], [[older.id], false]);
});

test('a shadow tidy recalls its merge in place of the facts it merged, and only at its own label', async () => {
  const store = new InMemoryAgentMemoryStore();
  const a = await store.append('ava', 'the deploy runs on Postgres', { provenance: { trust: 'agent' } });
  const b = await store.append('ava', 'deploys go to Postgres', { provenance: { trust: 'agent' } });
  const shadow = fakeShadowWriter();
  const tools = createMemoryPassTools(store, {
    passId: 'p1',
    kind: 'tidy',
    trust: 'agent',
    handed: [{ id: a.id, trust: 'agent' }, { id: b.id, trust: 'agent' }],
    recallOnly: 'agent',
  }, { supersedesMany: true, write: shadow.write });
  const session = { ...passSession(), metadata: { sessionTrust: 'agent' } } as Session;
  const merged = await tools.remember.execute({ fact: 'The deploy database is Postgres.', supersedes: [a.id, b.id] }, session) as Remembered;
  const external = await tools.remember.execute({ fact: 'Postgres is the deploy database, says a page.' }, { ...session, metadata: { sessionTrust: 'external' } } as Session) as Remembered;
  assert.equal(external.trust, 'external');

  const found = await tools.recall.execute({ query: 'Postgres' }, session) as Recalled;
  assert.deepEqual(found.results.map((fact) => fact.id), [merged.id], 'the merged facts are hidden, and the fact at another label is not shown');
});

test('a shadow pass ranks its own facts as a hybrid store does: every word ahead of the store, some words after it', async () => {
  class HybridStore extends InMemoryAgentMemoryStore {
    override async search(agentId: string, query: string, options?: Parameters<InMemoryAgentMemoryStore['search']>[2]) {
      return { ...await super.search(agentId, query, options), strategy: 'hybrid' as const };
    }
  }
  const store = new HybridStore();
  const stored = await store.append('ava', 'Ava replies before noon.');
  const shadow = fakeShadowWriter();
  const { recall, remember } = createMemoryPassTools(store, stateFor(), { write: shadow.write });
  const some = await remember.execute({ fact: 'Ava lives in Denver.' }, passSession()) as Remembered;
  const every = await remember.execute({ fact: 'Ava prefers short replies.' }, passSession()) as Remembered;

  const found = await recall.execute({ query: 'Ava replies' }, passSession()) as Recalled;
  assert.deepEqual(found.results.map((fact) => fact.id), [every.id, stored.id, some.id]);
  const one = await recall.execute({ query: 'Ava replies', limit: 1 }, passSession()) as Shown;
  assert.deepEqual([one.results.map((fact) => fact.id), one.truncated], [[every.id], true]);
});
