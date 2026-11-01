import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { buildMemoryInjection, renderMemorySection } from '@stratusagent/core';
import { createFileMemoryStore, DEFAULT_STRATUS_AGENT, withLegacyDefaultMemories } from '../src/index.ts';

const AT = new Date('2026-06-01T00:00:00.000Z');

const newFile = async (): Promise<string> =>
  path.join(await mkdtemp(path.join(os.tmpdir(), 'stratus-supersedes-many-')), 'memory.jsonl');

const ticking = () => {
  let tick = AT.getTime();
  return { now: () => new Date((tick += 1000)) };
};

const lines = async (filePath: string): Promise<Record<string, unknown>[]> =>
  (await readFile(filePath, 'utf8')).split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));

test('one record merges three facts: list, search, topics and the prompt show only the merged one, and forgetting it brings all three back', async () => {
  const filePath = await newFile();
  const store = createFileMemoryStore(filePath, ticking());
  const a = await store.append('ava', 'the deploy runs on Postgres', { about: ['deploy'] });
  const b = await store.append('ava', 'deploys go to Postgres', { about: ['deploy'] });
  const c = await store.append('ava', 'Postgres is the deploy database', { about: ['deploy'] });
  // Indexed before the merge, so the merge lands as an incremental catch-up.
  assert.equal((await store.search('ava', 'Postgres')).entries.length, 3);

  const merged = await store.append('ava', 'the deploy database is Postgres', { about: ['deploy'], supersedes: [a.id, b.id, c.id] });

  assert.deepEqual((await store.list('ava')).entries.map((entry) => entry.id), [merged.id]);
  assert.deepEqual((await store.search('ava', 'Postgres')).entries.map((entry) => entry.id), [merged.id]);
  assert.deepEqual((await store.topics!('ava')).map((topic) => `${topic.name}:${topic.count}`), ['deploy:1']);
  const prompt = renderMemorySection(await buildMemoryInjection(store, 'ava')) ?? '';
  assert.match(prompt, /the deploy database is Postgres/);
  assert.doesNotMatch(prompt, /deploys go to Postgres/);

  // One appended record, carrying the whole list.
  const written = await lines(filePath);
  assert.equal(written.length, 4);
  assert.deepEqual(written[3]?.supersedes, [a.id, b.id, c.id]);

  assert.equal(await store.forget('ava', merged.id), true);
  assert.deepEqual((await store.list('ava')).entries.map((entry) => entry.id), [a.id, b.id, c.id]);
  assert.deepEqual((await store.search('ava', 'Postgres')).entries.map((entry) => entry.id).sort(), [a.id, b.id, c.id].sort());

  // A fresh store over the same file reads it the same way: the index is
  // rebuilt from the record, list form included.
  const reread = createFileMemoryStore(filePath, ticking());
  assert.deepEqual((await reread.search('ava', 'Postgres')).entries.map((entry) => entry.id).sort(), [a.id, b.id, c.id].sort());
});

test('one id is written as a plain string, the form every older reader understands', async () => {
  const filePath = await newFile();
  const store = createFileMemoryStore(filePath, ticking());
  const a = await store.append('ava', 'one');
  const b = await store.append('ava', 'two');
  await store.append('ava', 'one, again', { supersedes: [a.id] });
  await store.append('ava', 'two, again', { supersedes: b.id });
  const written = await lines(filePath);
  assert.equal(written[2]?.supersedes, a.id);
  assert.equal(written[3]?.supersedes, b.id);
});

test('a merge naming any id that is not a live entry of this agent stores nothing', async () => {
  const filePath = await newFile();
  const store = createFileMemoryStore(filePath, ticking());
  const mine = await store.append('ava', 'mine');
  const theirs = await store.append('bea', 'theirs');
  await assert.rejects(() => store.append('ava', 'merged', { supersedes: [mine.id, theirs.id] }), /belongs to this agent/);
  assert.equal((await lines(filePath)).length, 2);
  assert.deepEqual((await store.search('bea', 'theirs')).entries.map((entry) => entry.id), [theirs.id]);
});

test('an index an older build made, one revision per successor, is rebuilt so a merge retires every fact it names', async () => {
  const filePath = await newFile();
  const store = createFileMemoryStore(filePath, ticking());
  const a = await store.append('ava', 'the deploy runs on Postgres');
  const b = await store.append('ava', 'deploys go to Postgres');
  const merged = await store.append('ava', 'the deploy database is Postgres', { supersedes: [a.id, b.id] });
  assert.deepEqual((await store.search('ava', 'Postgres')).entries.map((entry) => entry.id), [merged.id]);

  // What 0.14.x leaves behind: `revisions` keyed by (successor, agent), its
  // schema stamp, and no revision for a list it could not read.
  const index = new DatabaseSync(`${filePath}.index`);
  index.exec('DROP TABLE revisions;');
  index.exec(`CREATE TABLE revisions (
    successor_id TEXT NOT NULL, target_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    valid_from_ms INTEGER, valid_until_ms INTEGER, PRIMARY KEY (successor_id, agent_id));`);
  index.exec(`UPDATE meta SET value = '7' WHERE key = 'schema_version';`);
  index.close();

  const upgraded = createFileMemoryStore(filePath, ticking());
  assert.deepEqual((await upgraded.search('ava', 'Postgres')).entries.map((entry) => entry.id), [merged.id]);

  // And what an older build leaves when it reuses a table this one made:
  // the new key, its own stamp, and still no row for the list.
  const reused = new DatabaseSync(`${filePath}.index`);
  reused.exec('DELETE FROM revisions;');
  reused.exec(`UPDATE meta SET value = '7' WHERE key = 'schema_version';`);
  reused.close();
  const again = createFileMemoryStore(filePath, ticking());
  assert.deepEqual((await again.search('ava', 'Postgres')).entries.map((entry) => entry.id), [merged.id]);
});

test('a merge of inherited facts is filed where they live, by the ids recall handed out', async () => {
  const filePath = await newFile();
  await writeFile(filePath, [
    { id: 'demo-agent:memory:1', agentId: 'demo-agent', content: 'the deploy runs on MySQL', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'demo-agent:memory:2', agentId: 'demo-agent', content: 'deploys go to MySQL', createdAt: '2026-01-02T00:00:00.000Z' },
  ].map((line) => `${JSON.stringify(line)}\n`).join(''));
  const store = withLegacyDefaultMemories(createFileMemoryStore(filePath, ticking()));
  const recalled = (await store.search(DEFAULT_STRATUS_AGENT.id, 'MySQL')).entries.map((entry) => entry.id).sort();
  assert.deepEqual(recalled, ['demo-agent:memory:1', 'demo-agent:memory:2']);

  const merged = await store.append(DEFAULT_STRATUS_AGENT.id, 'the deploy runs on MySQL', { supersedes: recalled });
  assert.deepEqual((await store.search(DEFAULT_STRATUS_AGENT.id, 'MySQL')).entries.map((entry) => entry.id), [merged.id]);
  assert.deepEqual((await store.list(DEFAULT_STRATUS_AGENT.id)).entries.map((entry) => entry.id), [merged.id]);
});

test('the upgrade to a revisions table keyed by target keeps the usage counters, which no rebuild can restore', async () => {
  const filePath = await newFile();
  const store = createFileMemoryStore(filePath, ticking());
  const kept = await store.append('ava', 'the survey is quarterly');
  assert.equal((await store.search('ava', 'survey')).entries[0]?.usage?.recallCount, 1);
  assert.equal((await store.search('ava', 'survey')).entries[0]?.usage?.recallCount, 2);

  const index = new DatabaseSync(`${filePath}.index`);
  index.exec('DROP TABLE revisions;');
  index.exec(`CREATE TABLE revisions (
    successor_id TEXT NOT NULL, target_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    valid_from_ms INTEGER, valid_until_ms INTEGER, PRIMARY KEY (successor_id, agent_id));`);
  index.exec(`UPDATE meta SET value = '7' WHERE key = 'schema_version';`);
  index.close();

  const upgraded = createFileMemoryStore(filePath, ticking());
  const [found] = (await upgraded.search('ava', 'survey')).entries;
  assert.equal(found?.id, kept.id);
  assert.equal(found?.usage?.recallCount, 3);
});

test('an append whose supersedes is malformed stores nothing', async () => {
  const filePath = await newFile();
  const store = createFileMemoryStore(filePath, ticking());
  const a = await store.append('ava', 'one');
  for (const supersedes of ['', [], [a.id, ''], [a.id, 7]]) {
    await assert.rejects(
      () => store.append('ava', 'one, again', { supersedes } as unknown as Parameters<typeof store.append>[2]),
      /supersedes/,
      JSON.stringify(supersedes),
    );
  }
  assert.equal((await lines(filePath)).length, 1);
});
