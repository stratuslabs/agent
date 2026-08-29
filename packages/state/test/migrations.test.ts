import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  assertStateCompatible,
  credentialsPath,
  pendingStateMigrations,
  readStateStamp,
  runStateMigrations,
  STATE_MIGRATIONS,
  STATE_SCHEMA_VERSION,
  stateFilePath,
} from '../src/index.ts';

const freshHome = () => mkdtemp(path.join(os.tmpdir(), 'stratus-migrations-'));

test('a home directory that predates versioning reads as schema 0 with everything pending', async () => {
  const env = { homeDir: await freshHome() };
  assert.deepEqual(await readStateStamp(env), { schemaVersion: 0, applied: [] });
  assert.deepEqual(
    (await pendingStateMigrations(env)).map((migration) => migration.id),
    STATE_MIGRATIONS.map((migration) => migration.id),
  );
});

test('running migrations stamps the home directory and a second run has nothing to do', async () => {
  const env = { homeDir: await freshHome() };
  const first = await runStateMigrations(env);
  assert.deepEqual(first.map((migration) => migration.id), STATE_MIGRATIONS.map((migration) => migration.id));

  const stamp = await readStateStamp(env);
  assert.equal(stamp.schemaVersion, STATE_SCHEMA_VERSION);
  assert.deepEqual(stamp.applied, STATE_MIGRATIONS.map((migration) => migration.id));
  // The stamp is a real file an operator can read.
  const onDisk = JSON.parse(await readFile(stateFilePath(env), 'utf8')) as { schemaVersion: number };
  assert.equal(onDisk.schemaVersion, STATE_SCHEMA_VERSION);
  // Written atomically via rename: no temp-file debris left behind.
  const stateDir = path.dirname(stateFilePath(env));
  assert.deepEqual((await readdir(stateDir)).filter((name) => name.includes('.tmp-')), []);

  assert.deepEqual(await runStateMigrations(env), []);
  assert.deepEqual(await pendingStateMigrations(env), []);
});

test('the owner-only migration tightens a loose pre-existing file and says which', async () => {
  const env = { homeDir: await freshHome() };
  const filePath = credentialsPath(env);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, '{}');
  // An older install under a looser umask: enforced on write today, but a
  // file nothing rewrites keeps its old mode forever — until this.
  await chmod(filePath, 0o644);

  const applied = await runStateMigrations(env);
  const ownerOnly = applied.find((migration) => migration.id === '0001-owner-only-state-files');
  assert.ok(ownerOnly?.detail?.includes('credentials.json'), `expected the detail to name credentials.json, got ${ownerOnly?.detail}`);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
});

test('a stamp from a newer build is refused, not guessed at', async () => {
  const env = { homeDir: await freshHome() };
  await mkdir(path.dirname(stateFilePath(env)), { recursive: true });
  await writeFile(stateFilePath(env), JSON.stringify({ schemaVersion: STATE_SCHEMA_VERSION + 1, applied: [] }));

  await assert.rejects(() => assertStateCompatible(env), /newer Stratus build/);
  await assert.rejects(() => runStateMigrations(env), /newer Stratus build/);
});

test('a corrupt stamp reads as unversioned and is rewritten, not an error', async () => {
  const env = { homeDir: await freshHome() };
  await mkdir(path.dirname(stateFilePath(env)), { recursive: true });
  await writeFile(stateFilePath(env), 'not json at all');

  assert.deepEqual(await readStateStamp(env), { schemaVersion: 0, applied: [] });
  await runStateMigrations(env);
  assert.equal((await readStateStamp(env)).schemaVersion, STATE_SCHEMA_VERSION);
});

test('every registered migration is idempotent: applying twice equals applying once', async () => {
  const env = { homeDir: await freshHome() };
  const filePath = credentialsPath(env);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, '{}');
  await chmod(filePath, 0o644);

  for (const migration of STATE_MIGRATIONS) {
    await migration.apply(env);
    // The second application must not throw and must leave state alone —
    // two processes can race the stamp, and a crash can lose the record
    // of a completed run.
    const second = await migration.apply(env);
    assert.equal(second, undefined, `${migration.id} found work on its second run`);
  }
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
});
