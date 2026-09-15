import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ContributionRegistry,
  EventBus,
  InMemoryAgentMemoryStore,
  MEMORY_ENTRY_MAX_BYTES,
  ToolRegistry,
  type AgentMemoryStore,
  type MemoryStoreContribution,
} from '@stratusagent/core';
import { loadPlugins } from '@stratusagent/plugins';

import { createSqliteMemoryPlugin, createSqliteMemoryStore } from '../src/index.ts';

const newFile = async (): Promise<string> => path.join(await mkdtemp(path.join(os.tmpdir(), 'stratus-memsql-')), 'memory.sqlite');

test('a fact remembered is recalled by whole-token AND matching, newest first, and survives reopening the file', async () => {
  const file = await newFile();
  // A clock that ticks per call: three appends inside one real
  // millisecond would tie on createdAt and order by id instead, which is
  // the contract's rule and not what this test is about.
  let tick = Date.parse('2026-03-01T00:00:00.000Z');
  const now = () => new Date((tick += 1));
  const first = createSqliteMemoryStore(file, { now });
  await first.append('ava', 'Postgres 16 runs on the staging box');
  await first.append('ava', 'The postgresql migration guide is bookmarked');
  await first.append('ava', 'staging box reboots on Sundays', { metadata: { source: 'ops' }, provenance: { trust: 'user', origin: { sessionId: 's1' } } });
  first.close();

  const reopened = createSqliteMemoryStore(file);
  const hits = await reopened.search('ava', 'STAGING box');
  assert.deepEqual(hits.entries.map((entry) => entry.content), [
    'staging box reboots on Sundays',
    'Postgres 16 runs on the staging box',
  ]);
  assert.equal(hits.truncated, false);
  // `postgres` does not find `postgresql`; a query with no tokens finds nothing.
  assert.equal((await reopened.search('ava', 'postgres')).entries.length, 1);
  assert.equal((await reopened.search('ava', '!!! ???')).entries.length, 0);
  const remembered = (await reopened.list('ava')).entries.at(-1);
  assert.deepEqual(remembered?.metadata, { source: 'ops' });
  assert.equal(remembered?.trust, 'user');
  assert.deepEqual(remembered?.origin, { sessionId: 's1' });
  reopened.close();
});

test('agents never see each other\'s entries, and forget tombstones rather than deletes', async () => {
  const store = createSqliteMemoryStore(await newFile());
  const avas = await store.append('ava', 'ava likes tea');
  await store.append('juno', 'juno likes coffee');

  assert.deepEqual((await store.search('juno', 'likes')).entries.map((entry) => entry.content), ['juno likes coffee']);
  assert.equal(await store.forget('juno', avas.id), false);
  assert.equal(await store.forget('ava', avas.id), true);
  assert.equal(await store.forget('ava', avas.id), false);
  assert.deepEqual((await store.list('ava')).entries, []);
  assert.deepEqual((await store.search('ava', 'tea')).entries, []);
  const audit = await store.audit('ava');
  assert.equal(audit.length, 1);
  assert.equal(typeof audit[0]?.forgottenAt, 'string');
  store.close();
});

test('bounded reads and the byte budget agree with the kernel\'s in-memory store, and ties break by id', async () => {
  // A clock that ticks once per call, shared by both stores, so the two
  // see the same timestamps and no ties — ids differ between stores, so a
  // tie would order by each store's own id shape rather than by the rule.
  let tick = Date.parse('2026-01-01T00:00:00.000Z');
  const now = () => new Date((tick += 1));
  const sqlite = createSqliteMemoryStore(await newFile(), { now });
  const reference = new InMemoryAgentMemoryStore({ now });
  for (let index = 0; index < 60; index += 1) {
    const content = `fact ${index} about the release ${'x'.repeat(index % 7 === 0 ? 3000 : 20)}`;
    await sqlite.append('ava', content);
    await reference.append('ava', content);
  }
  const fromSqlite = await sqlite.search('ava', 'release', { limit: 50 });
  const fromReference = await reference.search('ava', 'release', { limit: 50 });
  assert.deepEqual(fromSqlite.entries.map((entry) => entry.content), fromReference.entries.map((entry) => entry.content));
  assert.equal(fromSqlite.truncated, fromReference.truncated);
  const listed = await sqlite.list('ava', { limit: 5 });
  const listedReference = await reference.list('ava', { limit: 5 });
  assert.deepEqual(listed.entries.map((entry) => entry.content), listedReference.entries.map((entry) => entry.content));
  sqlite.close();

  // The tie-break itself: equal createdAt, ascending id — which for this
  // store's zero-padded ids is insertion order.
  const frozen = new Date('2026-02-01T00:00:00.000Z');
  const tied = createSqliteMemoryStore(await newFile(), { now: () => frozen });
  for (let index = 0; index < 12; index += 1) {
    await tied.append('ava', `tied fact ${index}`);
  }
  const recalled = await tied.search('ava', 'tied fact', { limit: 12 });
  assert.deepEqual(recalled.entries.map((entry) => entry.content), Array.from({ length: 12 }, (_, index) => `tied fact ${index}`));
  tied.close();
});

test('an over-cap fact is refused and nothing is stored; trust can be re-asserted on a live entry only', async () => {
  const store = createSqliteMemoryStore(await newFile());
  await assert.rejects(store.append('ava', 'x'.repeat(MEMORY_ENTRY_MAX_BYTES + 1)), /capped at/);
  assert.deepEqual(await store.audit('ava'), []);
  const entry = await store.append('ava', 'a fact of unknown origin');
  assert.equal(await store.reassertTrust?.('ava', entry.id, 'user'), true);
  assert.equal((await store.list('ava')).entries[0]?.trust, 'user');
  await store.forget('ava', entry.id);
  assert.equal(await store.reassertTrust?.('ava', entry.id, 'user'), false);
  store.close();
});

test('the database file is owner-only', async () => {
  const file = await newFile();
  const store = createSqliteMemoryStore(file);
  await store.append('ava', 'private');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  store.close();
});

test('the plugin registers the store at the configured path through the real loader, and closes it on dispose', async () => {
  const file = await newFile();
  const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const memory = new ContributionRegistry<MemoryStoreContribution>();
  const result = await loadPlugins({
    config: { '@stratusagent/memory-sqlite': { path: file } },
    host: {
      resolve: () => pathToFileURL(path.join(packageDirectory, 'dist', 'index.js')).href,
      import: () => import('../src/index.ts'),
    },
    tools: new ToolRegistry(),
    bus: new EventBus(),
    memory,
  });
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.loaded[0]?.contributions.memory, ['sqlite']);
  const store = memory.get('sqlite')?.store;
  assert.ok(store);
  await store.append('ava', 'through the plugin');
  await result.loaded[0]?.instance.dispose?.();
  // Closed: the next call fails rather than writing to a file nobody holds.
  await assert.rejects(store.append('ava', 'after dispose'));

  // A block with no path is refused at setup with the key named.
  const noPath = await createSqliteMemoryPlugin({});
  assert.throws(
    () => noPath.setup({ bus: new EventBus(), tools: new ToolRegistry(), memory: { register() {} } }),
    /needs a path/,
  );
});

test('the wider entry shape behaves the same here as in the kernel store: validity, supersession, pinning, topics', async () => {
  const at = new Date('2026-06-01T00:00:00.000Z');
  const sqlite = createSqliteMemoryStore(await newFile(), { now: () => at });
  const reference = new InMemoryAgentMemoryStore({ now: () => at });
  const seed = async (store: AgentMemoryStore): Promise<void> => {
    const old = await store.append('ava', 'the deploy runs on MySQL', { about: ['deploy'], kind: 'semantic' });
    await store.append('ava', 'the deploy runs on Postgres', { about: ['deploy'], supersedes: old.id });
    await store.append('ava', 'the hide is closed in winter', { about: ['hide'], validUntil: '2026-03-01T00:00:00.000Z' });
    await store.append('ava', 'Ada joins in September', { about: ['Ada'], validFrom: '2026-09-01T00:00:00.000Z' });
    await store.append('juno', 'Juno keeps the vault code', { about: ['vault'] });
  };
  await seed(sqlite);
  await seed(reference);

  for (const [label, store] of [['sqlite', sqlite], ['in-memory', reference]] as const) {
    // Superseded leaves everything; out of window leaves only what is true now.
    assert.deepEqual((await store.list('ava')).entries.map((entry) => entry.content), ['the deploy runs on Postgres'], label);
    assert.equal((await store.search('ava', 'MySQL')).entries.length, 0, label);
    assert.equal((await store.search('ava', 'winter')).entries.length, 1, label);
    assert.equal((await store.search('ava', 'September')).entries.length, 1, label);
    // `about` participates in matching in every store.
    assert.deepEqual((await store.search('ava', 'deploy')).entries.map((entry) => entry.content), ['the deploy runs on Postgres'], label);
    assert.deepEqual((await store.topics!('ava')).map((topic) => topic.name), ['deploy'], label);
    assert.equal((await store.search('ava', 'deploy')).strategy, 'recency', label);
    // The per-agent boundary holds across every new field.
    const junos = (await store.list('juno')).entries[0]!;
    await assert.rejects(
      () => store.append('ava', 'not mine to replace', { supersedes: junos.id }),
      /belongs to this agent/,
      label,
    );
    assert.deepEqual((await store.list('juno')).entries.map((entry) => entry.content), ['Juno keeps the vault code'], label);
  }

  // Pinning: a record, capped, refusing rather than evicting, and an
  // out-of-window pin does not reach the core.
  const live = (await sqlite.list('ava')).entries[0]!;
  assert.equal((await sqlite.pin!('ava', live.id)).pinned, true);
  const future = (await sqlite.search('ava', 'September')).entries[0]!;
  assert.equal((await sqlite.pin!('ava', future.id)).pinned, true);
  assert.deepEqual((await sqlite.pinned!('ava')).map((entry) => entry.id), [live.id]);
  assert.equal(await sqlite.unpin!('ava', live.id), true);
  assert.deepEqual(await sqlite.pinned!('ava'), []);
  sqlite.close();
});

test('usage counters live beside the record here, and never in it', async () => {
  const store = createSqliteMemoryStore(await newFile());
  const written = await store.append('ava', 'the heron rookery is on the north bank');
  assert.equal(written.usage, undefined);
  assert.equal((await store.list('ava')).entries[0]?.usage, undefined);
  assert.equal((await store.search('ava', 'heron')).entries[0]?.usage?.recallCount, 1);
  assert.equal((await store.search('ava', 'heron')).entries[0]?.usage?.recallCount, 2);
  assert.equal((await store.audit('ava'))[0]?.usage, undefined);
  store.close();
});

test('an import lands entries verbatim under the importing agent, and re-running one is a no-op', async () => {
  const store = createSqliteMemoryStore(await newFile());
  const entries = [
    { id: 'from-elsewhere:1', agentId: 'somewhere', content: 'the survey is quarterly', createdAt: '2026-01-01T00:00:00.000Z', about: ['rookery'], trust: 'external' as const },
    { id: 'from-elsewhere:2', agentId: 'somewhere', content: 'the hide needs repainting', createdAt: '2026-01-02T00:00:00.000Z', trust: 'external' as const },
  ];
  assert.deepEqual(await store.importEntries!('ava', entries), { imported: 2, skipped: [] });
  const back = (await store.list('ava')).entries;
  assert.deepEqual(back.map((entry) => entry.id), ['from-elsewhere:1', 'from-elsewhere:2']);
  // Re-keyed to the importing agent — the id is opaque, the ownership is not.
  assert.deepEqual(back.map((entry) => entry.agentId), ['ava', 'ava']);
  assert.deepEqual(back[0]?.about, ['rookery']);
  assert.deepEqual(await store.importEntries!('ava', entries), { imported: 0, skipped: ['from-elsewhere:1', 'from-elsewhere:2'] });
  assert.equal((await store.list('ava')).entries.length, 2);
  store.close();
});
