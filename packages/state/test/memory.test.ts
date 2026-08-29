import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  InMemoryAgentMemoryStore,
  MEMORY_ENTRY_MAX_BYTES,
  MEMORY_READ_MAX_BYTES,
  memoryContentByteLength,
  type AgentMemoryStore,
} from '@stratusagent/core';

import { createFileMemoryStore, withLegacyDefaultMemories } from '../src/index.ts';

const tempDir = () => mkdtemp(path.join(os.tmpdir(), 'stratus-memory-'));

const entryLine = (id: string, agentId: string, content: string, createdAt: string): string =>
  `${JSON.stringify({ id, agentId, content, createdAt })}\n`;

test('a fact remembered through one store is recalled through a fresh store over the same file', async () => {
  const filePath = path.join(await tempDir(), 'memory.jsonl');
  const first = createFileMemoryStore(filePath);
  await first.append('ava', 'the deploy password hint lives in the vault');

  // A new store instance is a daemon restart: no process-lifetime caching.
  const second = createFileMemoryStore(filePath);
  const found = await second.search('ava', 'vault deploy');
  assert.equal(found.entries.length, 1);
  assert.match(found.entries[0]?.content ?? '', /vault/);
});

test('a populated pre-existing JSONL is recallable with no import step', async () => {
  const filePath = path.join(await tempDir(), 'memory.jsonl');
  // Written by an older install — no store, no index, just the record.
  await writeFile(
    filePath,
    entryLine('ava:memory:one', 'ava', 'the staging cluster is named tortoise', '2026-01-01T00:00:00.000Z')
    + entryLine('ava:memory:two', 'ava', 'the prod cluster is named hare', '2026-01-02T00:00:00.000Z'),
  );
  const store = createFileMemoryStore(filePath);
  assert.equal((await store.search('ava', 'tortoise')).entries.length, 1);
  assert.equal((await store.search('ava', 'cluster')).entries.length, 2);
  assert.equal((await store.list('ava')).entries.length, 2);
});

test('deleting the index reproduces it; a stale schema stamp rebuilds rather than errors', async () => {
  const filePath = path.join(await tempDir(), 'memory.jsonl');
  const store = createFileMemoryStore(filePath);
  await store.append('ava', 'facts about the heron rookery');
  const before = await store.search('ava', 'heron');
  assert.equal(before.entries.length, 1);

  // Delete the index out from under a fresh store: same answers.
  await rm(`${filePath}.index`);
  const rebuilt = createFileMemoryStore(filePath);
  assert.deepEqual(await rebuilt.search('ava', 'heron'), before);

  // A wrong schema stamp is a rebuild trigger, not an error.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(`${filePath}.index`);
  db.exec("UPDATE meta SET value = '0' WHERE key = 'schema_version'");
  db.close();
  const restamped = createFileMemoryStore(filePath);
  assert.deepEqual(await restamped.search('ava', 'heron'), before);
});

test('an entry appended to the JSONL by hand — daemon stopped or crashed mid-write — is recallable', async () => {
  const filePath = path.join(await tempDir(), 'memory.jsonl');
  const store = createFileMemoryStore(filePath);
  await store.append('ava', 'the original fact about ospreys');
  assert.equal((await store.search('ava', 'ospreys')).entries.length, 1);

  // Appended outside any store — an operator with a text editor, or the
  // crash case: JSONL landed, index write never happened.
  await appendFile(filePath, entryLine('ava:memory:hand', 'ava', 'a hand-written fact about kestrels', new Date().toISOString()));
  const found = await store.search('ava', 'kestrels');
  assert.equal(found.entries.length, 1);
  assert.equal(found.entries[0]?.id, 'ava:memory:hand');
});

test('an in-place edit rebuilds the index rather than being half-believed — even with an append after it', async () => {
  const filePath = path.join(await tempDir(), 'memory.jsonl');
  const store = createFileMemoryStore(filePath);
  await store.append('ava', 'the alpha word');
  await store.append('ava', 'an unrelated anchor fact');
  assert.equal((await store.search('ava', 'alpha')).entries.length, 1);

  // Fix a "typo" in the earlier entry without changing its length — the
  // edit an offset-plus-last-id watermark passes right over.
  const raw = await readFile(filePath, 'utf8');
  await writeFile(filePath, raw.replace('the alpha word', 'the omega word'));
  // And a normal append on top, so the tail-index path is the tempting one.
  await appendFile(filePath, entryLine('ava:memory:after', 'ava', 'appended after the edit', new Date().toISOString()));

  assert.equal((await store.search('ava', 'alpha')).entries.length, 0);
  assert.equal((await store.search('ava', 'omega')).entries.length, 1);
  assert.equal((await store.search('ava', 'appended')).entries.length, 1);
});

test('a second process appending while the first searches is never lost', async () => {
  const filePath = path.join(await tempDir(), 'memory.jsonl');
  const indexer = createFileMemoryStore(filePath);
  const writer = createFileMemoryStore(filePath);
  for (let i = 0; i < 50; i += 1) {
    await writer.append('ava', `seed fact number ${i}`);
  }
  // Interleave a search (which indexes) with concurrent appends.
  await Promise.all([
    indexer.search('ava', 'seed fact'),
    writer.append('ava', 'the racing fact about swifts'),
    writer.append('ava', 'another racing fact about swallows'),
  ]);
  assert.equal((await indexer.search('ava', 'swifts')).entries.length, 1);
  assert.equal((await indexer.search('ava', 'swallows')).entries.length, 1);
});

test('forget appends a tombstone: out of recall, list, and the audit read still shows it', async () => {
  const filePath = path.join(await tempDir(), 'memory.jsonl');
  const store = createFileMemoryStore(filePath);
  const kept = await store.append('ava', 'the kept fact about badgers');
  const dropped = await store.append('ava', 'the dropped fact about badgers');
  assert.equal((await store.search('ava', 'badgers')).entries.length, 2);

  assert.equal(await store.forget('ava', dropped.id), true);
  assert.equal(await store.forget('ava', dropped.id), false);
  assert.equal(await store.forget('scout', kept.id), false, 'another agent cannot forget it');

  assert.deepEqual((await store.search('ava', 'badgers')).entries.map((entry) => entry.id), [kept.id]);
  assert.deepEqual((await store.list('ava', { limit: 10 })).entries.map((entry) => entry.id), [kept.id]);

  const audit = await store.audit('ava');
  assert.equal(audit.length, 2);
  assert.ok(audit.find((entry) => entry.id === dropped.id)?.forgottenAt);

  // The record is still append-only: both original lines are still there.
  const raw = await readFile(filePath, 'utf8');
  assert.match(raw, /the dropped fact about badgers/);
  assert.match(raw, /"forgets"/);
});

test('the built-in stratus agent recalls and forgets memories stored under a legacy default id', async () => {
  const filePath = path.join(await tempDir(), 'memory.jsonl');
  const raw = createFileMemoryStore(filePath);
  await raw.append('demo-agent', 'the legacy fact about foxes');
  await raw.append('anthropic-agent', 'the legacy fact about wolves');
  const store = withLegacyDefaultMemories(raw);
  await store.append('stratus', 'the new fact about foxes');

  const foxes = await store.search('stratus', 'foxes');
  assert.equal(foxes.entries.length, 2, 'inherited entries are findable, not only listable');

  const legacyId = foxes.entries.find((entry) => entry.agentId === 'demo-agent')?.id;
  assert.ok(legacyId);
  assert.equal(await store.forget('stratus', legacyId), true);
  assert.equal((await store.search('stratus', 'foxes')).entries.length, 1);
  assert.ok((await store.audit('stratus')).find((entry) => entry.id === legacyId)?.forgottenAt);

  // The bound applies after the merge: a busy legacy id cannot crowd the rest out.
  for (let i = 0; i < 10; i += 1) {
    await raw.append('demo-agent', `legacy filler ${i}`);
  }
  const bounded = await store.list('stratus', { limit: 3 });
  assert.equal(bounded.entries.length, 3);
  assert.equal(bounded.truncated, true);
});

test('agent A cannot recall agent B’s entries', async () => {
  const filePath = path.join(await tempDir(), 'memory.jsonl');
  const store = createFileMemoryStore(filePath);
  await store.append('ava', 'the shared word is periwinkle');
  await store.append('scout', 'the shared word is periwinkle');
  const forScout = await store.search('scout', 'periwinkle');
  assert.equal(forScout.entries.length, 1);
  assert.equal(forScout.entries[0]?.agentId, 'scout');
});

test('recall over thousands of entries returns bounded results, and both stores agree — ties included', async () => {
  const filePath = path.join(await tempDir(), 'memory.jsonl');
  const fileStore = createFileMemoryStore(filePath);
  let lines = '';
  for (let i = 0; i < 3000; i += 1) {
    // Ids match the in-memory store's counter ids exactly: the tie-break is
    // id comparison, so parity is only meaningful over identical ids.
    lines += entryLine(`ava:memory:${i + 1}`, 'ava', `numbered fact ${i} about the archive`, `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`);
  }
  await writeFile(filePath, lines);

  const clock = { value: new Date(0) };
  const memStore = new InMemoryAgentMemoryStore({ now: () => clock.value });
  const seeded: AgentMemoryStore = memStore;
  for (let i = 0; i < 3000; i += 1) {
    clock.value = new Date(`2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`);
    await seeded.append('ava', `numbered fact ${i} about the archive`);
  }

  const fromFile = await fileStore.search('ava', 'archive', 7);
  const fromMemory = await seeded.search('ava', 'archive', 7);
  assert.equal(fromFile.entries.length, 7);
  assert.equal(fromFile.truncated, true);
  // Same createdAt keys and plenty of ties: the ordering must match entry for
  // entry by (createdAt desc, id asc) — the case that separates a specified
  // ordering from an incidental one.
  assert.deepEqual(
    fromFile.entries.map((entry) => `${entry.createdAt} ${entry.content}`),
    fromMemory.entries.map((entry) => `${entry.createdAt} ${entry.content}`),
  );
  const bytes = fromFile.entries.reduce((sum, entry) => sum + memoryContentByteLength(entry.content), 0);
  assert.ok(bytes <= MEMORY_READ_MAX_BYTES);
});

test('awkward queries against the FTS index are searches, never syntax errors', async () => {
  const filePath = path.join(await tempDir(), 'memory.jsonl');
  const store = createFileMemoryStore(filePath);
  await store.append('ava', 'the C build AND the c runtime');
  for (const query of ['C++', 'what "did I say', "quote ' inside", 'this AND that', 'NEAR(x y)', '"""']) {
    const result = await store.search('ava', query);
    assert.ok(Array.isArray(result.entries), `query ${JSON.stringify(query)} should search, not throw`);
  }
  assert.equal((await store.search('ava', 'C++')).entries.length, 1, 'C++ finds the c token');
  assert.equal((await store.search('ava', 'this AND that')).entries.length, 0, 'AND is a word, not an operator');
});

test('the file store refuses an over-cap fact and the record stays clean', async () => {
  const filePath = path.join(await tempDir(), 'memory.jsonl');
  const store = createFileMemoryStore(filePath);
  await assert.rejects(() => store.append('ava', 'z'.repeat(MEMORY_ENTRY_MAX_BYTES + 1)), /capped/);
  await assert.rejects(async () => stat(filePath), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
});

test('the index file is owner-only, like the JSONL it derives from', async () => {
  const filePath = path.join(await tempDir(), 'memory.jsonl');
  const store = createFileMemoryStore(filePath);
  await store.append('ava', 'a private fact');
  await store.search('ava', 'private');
  const jsonlMode = (await stat(filePath)).mode & 0o777;
  const indexMode = (await stat(`${filePath}.index`)).mode & 0o777;
  assert.equal(jsonlMode, 0o600);
  assert.equal(indexMode, 0o600);
});
