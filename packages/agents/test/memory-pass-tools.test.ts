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
