import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { claimFileLock, createFileMemoryStore, FileLockHeldError } from '../src/index.ts';

const AT = new Date('2026-06-01T00:00:00.000Z');

const newFile = async (): Promise<string> =>
  path.join(await mkdtemp(path.join(os.tmpdir(), 'stratus-supersede-guard-')), 'memory.jsonl');

const ticking = () => {
  let tick = AT.getTime();
  return { now: () => new Date((tick += 1000)) };
};

const lineCount = async (filePath: string): Promise<number> =>
  (await readFile(filePath, 'utf8')).split('\n').filter((line) => line.trim().length > 0).length;

test('an append that refuses protected facts stores nothing when a fact it supersedes is pinned or labeled user', async () => {
  const filePath = await newFile();
  const store = createFileMemoryStore(filePath, ticking());
  const plain = await store.append('ava', 'plain');
  const pinned = await store.append('ava', 'pinned');
  assert.equal((await store.pin!('ava', pinned.id)).pinned, true);
  const asserted = await store.append('ava', 'asserted', { provenance: { trust: 'user' } });
  const reasserted = await store.append('ava', 'reasserted', { provenance: { trust: 'agent' } });
  assert.equal(await store.reassertTrust!('ava', reasserted.id, 'user'), true);
  const before = await lineCount(filePath);

  for (const target of [pinned.id, asserted.id, reasserted.id]) {
    await assert.rejects(
      () => store.append('ava', 'merged', { supersedes: [plain.id, target], refuseProtected: true }),
      new RegExp(`${target} is (pinned|a fact the operator asserted)`),
    );
  }
  assert.equal(await lineCount(filePath), before);
  const next = await store.append('ava', 'plain, again', { supersedes: plain.id, refuseProtected: true });
  assert.equal(next.supersedes, plain.id);
});

test('a guarded append, a pin and a re-assertion each check and write under the memory lock, which another process may hold', async () => {
  const filePath = await newFile();
  const store = createFileMemoryStore(filePath, { ...ticking(), lockWaitMs: 50 });
  const fact = await store.append('ava', 'the deploy runs on Postgres');
  const before = await lineCount(filePath);

  const held = claimFileLock(`${filePath}.lock`);
  try {
    await assert.rejects(
      () => store.append('ava', 'the deploy database is Postgres', { supersedes: fact.id, refuseProtected: true }),
      (error: unknown) => error instanceof FileLockHeldError,
    );
    await assert.rejects(() => store.pin!('ava', fact.id), (error: unknown) => error instanceof FileLockHeldError);
    await assert.rejects(() => store.reassertTrust!('ava', fact.id, 'user'), (error: unknown) => error instanceof FileLockHeldError);
    assert.equal(await lineCount(filePath), before, 'nothing written while another holder had the lock');
    // An ordinary append retires nothing protected-sensitive and takes no lock.
    await store.append('ava', 'an unrelated fact');
  } finally {
    held.release();
  }
  assert.equal((await store.pin!('ava', fact.id)).pinned, true);
  // Pinned now, so the guarded append that waited is refused on its merits.
  await assert.rejects(
    () => store.append('ava', 'the deploy database is Postgres', { supersedes: fact.id, refuseProtected: true }),
    /is pinned/,
  );
});

test('two stores over one file in one process take turns at the lock rather than waiting on each other', async () => {
  const filePath = await newFile();
  const clock = ticking();
  const first = createFileMemoryStore(filePath, clock);
  const second = createFileMemoryStore(filePath, clock);
  const a = await first.append('ava', 'fact a');
  const b = await first.append('ava', 'fact b');
  const started = Date.now();
  const [merged, pinned] = await Promise.all([
    first.append('ava', 'fact a, again', { supersedes: a.id, refuseProtected: true }),
    second.pin!('ava', b.id),
  ]);
  assert.equal(merged.supersedes, a.id);
  assert.equal(pinned.pinned, true);
  assert.ok(Date.now() - started < 1000, 'no wait on a lock this process already holds');
});
