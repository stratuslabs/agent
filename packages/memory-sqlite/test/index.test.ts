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
  type MemoryStoreContribution,
} from '@stratusagent/core';
import { loadPlugins } from '@stratusagent/plugins';

import { createSqliteMemoryPlugin, createSqliteMemoryStore } from '../src/index.ts';

const newFile = async (): Promise<string> => path.join(await mkdtemp(path.join(os.tmpdir(), 'stratus-memsql-')), 'memory.sqlite');

test('a fact remembered is recalled by whole-token AND matching, newest first, and survives reopening the file', async () => {
  const file = await newFile();
  const first = createSqliteMemoryStore(file);
  await first.append('ava', 'Postgres 16 runs on the staging box');
  await first.append('ava', 'The postgresql migration guide is bookmarked');
  await first.append('ava', 'staging box reboots on Sundays', { source: 'ops' }, { trust: 'user', origin: { sessionId: 's1' } });
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
  const fromSqlite = await sqlite.search('ava', 'release', 50);
  const fromReference = await reference.search('ava', 'release', 50);
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
  const recalled = await tied.search('ava', 'tied fact', 12);
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
