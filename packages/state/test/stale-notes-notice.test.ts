import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  agentMemoryFilePath,
  agentsDirPath,
  createFileMemoryStore,
  readStateStamp,
  runStateMigrations,
  STATE_MIGRATIONS,
  STATE_SCHEMA_VERSION,
  stateFilePath,
  stratusHomePath,
} from '../src/index.ts';

const NOTICE_ID = '0006-task-notes-expiry-notice';
const DAY_MS = 24 * 60 * 60 * 1000;

const freshHome = () => mkdtemp(path.join(os.tmpdir(), 'stratus-stale-notes-'));

/**
 * A home as 0.14.1 left it: the per-agent layout in place and every
 * migration that build knew about recorded. Nothing newer has run.
 */
const homeFrom0141 = async (): Promise<{ homeDir: string }> => {
  const env = { homeDir: await freshHome() };
  await mkdir(stratusHomePath(env), { recursive: true });
  await writeFile(stateFilePath(env), JSON.stringify({
    schemaVersion: 4,
    applied: ['0001-owner-only-state-files', '0002-provenance-labels', '0003-per-agent-state-layout', '0004-per-agent-workspaces'],
  }));
  return env;
};

/** A store for one agent's own memory file, writing as if at `at`. */
const storeAt = async (env: { homeDir: string }, agentId: string, at: Date) => {
  const filePath = agentMemoryFilePath(env, agentId);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  return createFileMemoryStore(filePath, { now: () => at, stateHome: stratusHomePath(env) });
};

test('the expiry notice runs after the per-agent moves, on any command once they are done, and bumps no schema', async () => {
  const ids = STATE_MIGRATIONS.map((migration) => migration.id);
  assert.ok(ids.includes(NOTICE_ID));
  assert.ok(ids.indexOf(NOTICE_ID) > ids.indexOf('0004-per-agent-workspaces'));
  // A notice changes nothing on disk, so an older build can still run here.
  assert.equal(STATE_SCHEMA_VERSION, 4);
  const notice = STATE_MIGRATIONS.find((migration) => migration.id === NOTICE_ID);
  assert.equal(await notice?.requiresExclusive?.(await homeFrom0141()), false);
  assert.equal(await notice?.requiresExclusive?.({ homeDir: await freshHome() }), true);
});

test('a home upgraded from 0.14.1 names each agent with task notes past 14 days, once', async () => {
  const env = await homeFrom0141();
  const old = new Date(Date.now() - 30 * DAY_MS);

  const ava = await storeAt(env, 'ava', old);
  await ava.append('ava', 'PR 12 is waiting on review', { kind: 'episodic' });
  await ava.append('ava', 'loop status: idle', { kind: 'episodic' });
  // Not task notes past the default: a fact, an untyped line, and a note
  // whose own end date is still ahead.
  await ava.append('ava', 'the staging cluster is named tortoise', { kind: 'semantic' });
  await ava.append('ava', 'an untyped line');
  await ava.append('ava', 'the freeze lasts until next year', {
    kind: 'episodic',
    validUntil: new Date(Date.now() + 300 * DAY_MS).toISOString(),
  });
  // Nor one whose own window had already closed: the default did not
  // change what the prompt showed for it.
  await ava.append('ava', 'the freeze lasted a week', {
    kind: 'episodic',
    validUntil: new Date(Date.now() - 20 * DAY_MS).toISOString(),
  });
  // A pinned note stays in the pinned core, so it did not leave the prompt.
  const pinned = await ava.append('ava', 'still working card 7', { kind: 'episodic' });
  await ava.pin!('ava', pinned.id);
  // A recent note is still current.
  const avaNow = await storeAt(env, 'ava', new Date());
  await avaNow.append('ava', 'opened PR 13', { kind: 'episodic' });

  const blair = await storeAt(env, 'blair', old);
  await blair.append('blair', 'brief sent', { kind: 'episodic' });

  // An agent with nothing stale is left out of the line.
  const cleo = await storeAt(env, 'cleo', new Date());
  await cleo.append('cleo', 'started today', { kind: 'episodic' });

  const first = await runStateMigrations(env);
  const notice = first.find((migration) => migration.id === NOTICE_ID);
  assert.ok(notice, 'the notice runs on the first command of the new build');
  assert.ok(notice.detail);
  assert.match(notice.detail, /\bava 2\b/);
  assert.match(notice.detail, /\bblair 1\b/);
  assert.doesNotMatch(notice.detail, /cleo/);
  assert.match(notice.detail, /14 days/);
  assert.match(notice.detail, /stratus memory list/);
  assert.match(notice.detail, /memory\.recall/);
  assert.doesNotMatch(notice.detail, /\n/, 'one log line');

  assert.ok((await readStateStamp(env)).applied.includes(NOTICE_ID));
  // The next start has nothing to say.
  assert.deepEqual(await runStateMigrations(env), []);
  assert.deepEqual(await runStateMigrations(env, { exclusive: true }), []);
});

test('a home with no stale task notes records the notice without a line', async () => {
  const env = await homeFrom0141();
  const ava = await storeAt(env, 'ava', new Date());
  await ava.append('ava', 'opened PR 13', { kind: 'episodic' });

  const applied = await runStateMigrations(env);
  const notice = applied.find((migration) => migration.id === NOTICE_ID);
  assert.ok(notice);
  assert.equal(notice.detail, undefined);
  assert.ok((await readStateStamp(env)).applied.includes(NOTICE_ID));
});

test('a fresh home records the notice without a line', async () => {
  const env = { homeDir: await freshHome() };
  const applied = await runStateMigrations(env, { exclusive: true });
  const notice = applied.find((migration) => migration.id === NOTICE_ID);
  assert.ok(notice);
  assert.equal(notice.detail, undefined);
});

test('a memory file the notice cannot read does not stop the upgrade', async () => {
  const env = await homeFrom0141();
  const old = new Date(Date.now() - 30 * DAY_MS);
  const blair = await storeAt(env, 'blair', old);
  await blair.append('blair', 'brief sent', { kind: 'episodic' });
  // A memory file that is a directory: unreadable as JSONL.
  await mkdir(agentMemoryFilePath(env, 'ava'), { recursive: true });
  // A soul file and a stray file beside the agent directories.
  await writeFile(path.join(agentsDirPath(env), 'ava.md'), '---\nid: ava\n---\n');
  await writeFile(path.join(agentsDirPath(env), 'notes.txt'), 'x');

  const applied = await runStateMigrations(env);
  const notice = applied.find((migration) => migration.id === NOTICE_ID);
  assert.ok(notice?.detail);
  assert.match(notice.detail, /\bblair 1\b/);
  assert.doesNotMatch(notice.detail, /\bava\b/);
  assert.ok((await readStateStamp(env)).applied.includes(NOTICE_ID));
});

test('a second apply after the notice was recorded says nothing', async () => {
  const env = await homeFrom0141();
  const old = new Date(Date.now() - 30 * DAY_MS);
  const ava = await storeAt(env, 'ava', old);
  await ava.append('ava', 'PR 12 is waiting on review', { kind: 'episodic' });
  await runStateMigrations(env);
  const notice = STATE_MIGRATIONS.find((migration) => migration.id === NOTICE_ID);
  // Two commands can race the stamp: the one that loses reads the stamp the
  // winner wrote and does not repeat the line.
  assert.equal(await notice!.apply(env), undefined);
});

test('on a home still waiting for the per-agent move, the notice waits with it and says it once', async () => {
  const env = { homeDir: await freshHome() };
  await mkdir(stratusHomePath(env), { recursive: true });
  await writeFile(stateFilePath(env), JSON.stringify({
    schemaVersion: 2,
    applied: ['0001-owner-only-state-files', '0002-provenance-labels'],
  }));
  const ava = await storeAt(env, 'ava', new Date(Date.now() - 30 * DAY_MS));
  await ava.append('ava', 'PR 12 is waiting on review', { kind: 'episodic' });

  // Ordinary commands defer 0003 and record nothing, so a notice they ran
  // would repeat on each of them.
  for (let run = 0; run < 2; run += 1) {
    const ordinary = await runStateMigrations(env);
    assert.equal(ordinary.find((migration) => migration.id === NOTICE_ID), undefined);
  }
  const served = await runStateMigrations(env, { exclusive: true });
  assert.match(served.find((migration) => migration.id === NOTICE_ID)?.detail ?? '', /\bava 1\b/);
  assert.deepEqual(await runStateMigrations(env), []);
});
