import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  agentMemoryFilePath,
  agentsDirPath,
  assertStateCompatible,
  credentialsPath,
  mergeStateStamp,
  migrateLegacyMemory,
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

  // Thrown, not rejected: the gateway runs this check between the control
  // API announcing its address and the daemon marking itself serving, and a
  // check that yielded for I/O there was the window in which CI's restart
  // tests were refused as "still starting".
  assert.throws(() => assertStateCompatible(env), /newer Stratus build/);
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

test('provenance labels are a schema bump with nothing to rewrite, so a downgraded build refuses the home', async () => {
  // The labels live inside records older builds already read — memory
  // entries, sessions, schedules — and in a ledger they never open. Nothing
  // needs rewriting; what needs to happen is that a build without the
  // labels stops at the stamp instead of writing unlabelled state beside
  // the labelled kind.
  const migration = STATE_MIGRATIONS.find((candidate) => candidate.id === '0002-provenance-labels');
  assert.ok(migration);
  const env = { homeDir: await freshHome() };
  const applied = await runStateMigrations(env);
  assert.equal(applied.find((result) => result.id === '0002-provenance-labels')?.detail, undefined);
  // A home with nothing shared to move is fully migrated by the ordinary
  // path, so the stamp reaches this build's version without a daemon start.
  assert.equal((await readStateStamp(env)).schemaVersion, STATE_SCHEMA_VERSION);
});

test('a cwd memory file for an id whose directory is a file does not block every later run', async () => {
  const home = await freshHome();
  const project = await freshHome();
  const env = { homeDir: home, cwd: project };
  await mkdir(agentsDirPath(env), { recursive: true });
  await mkdir(path.join(project, '.stratus'), { recursive: true });
  // `agents/blocked.md` is a file and `blocked.md` is a valid legacy id, so
  // this agent's state directory cannot be made. This import runs from
  // `createAgentRuntime` and `gateway.start()`, and it has already renamed
  // its source to a claim by the time the directory is needed — so throwing
  // here comes back on every later run and blocks the whole fleet.
  await writeFile(path.join(agentsDirPath(env), 'blocked.md'), 'a soul file in the way');
  const at = '2026-01-01T00:00:00.000Z';
  await writeFile(path.join(project, '.stratus', 'memory.jsonl'), [
    JSON.stringify({ id: 'ava:memory:1', agentId: 'ava', content: 'likes jazz', createdAt: at }),
    JSON.stringify({ id: 'blocked:memory:1', agentId: 'blocked.md', content: 'nowhere to go', createdAt: at }),
  ].join('\n') + '\n');

  await migrateLegacyMemory(env);
  // And again, the way the next command would: nothing is left half-claimed.
  await migrateLegacyMemory(env);

  // The agents that can move, moved.
  assert.match(await readFile(agentMemoryFilePath(env, 'ava'), 'utf8'), /likes jazz/);
  // The quarantined one is in the archive, which is where a record with
  // nowhere to land belongs — not lost, and not blocking anyone.
  assert.match(await readFile(path.join(project, '.stratus', 'memory.jsonl.migrated'), 'utf8'), /nowhere to go/);
  const left = (await readdir(path.join(project, '.stratus'))).filter((name) => name.includes('migrating'));
  assert.deepEqual(left, []);
});

test('a stamp write merges with what is on disk, so a stale snapshot cannot un-apply a migration', () => {
  const everything = STATE_MIGRATIONS.map((migration) => migration.id);
  // What the exclusive `serve` or `update` recorded while an ordinary
  // command was mid-run, and what that ordinary command is about to write
  // from the snapshot it took before any of it happened.
  const recorded = { schemaVersion: STATE_SCHEMA_VERSION, applied: everything };
  const stale = { schemaVersion: 0, applied: everything.slice(0, 1) };

  const merged = mergeStateStamp(recorded, stale);
  // Neither the ids nor the version may go backwards: an older build let
  // past the downgrade guard recreates the legacy state the move retired.
  assert.deepEqual(merged.applied, everything);
  assert.equal(merged.schemaVersion, STATE_SCHEMA_VERSION);

  // Forwards still moves, or nothing would ever be recorded at all.
  assert.deepEqual(
    mergeStateStamp({ schemaVersion: 0, applied: [] }, { schemaVersion: 0, applied: everything }),
    { schemaVersion: STATE_SCHEMA_VERSION, applied: everything },
  );

  // And a stamp a NEWER build left is not lowered to this build's schema
  // just because everything this build knows about has run: the
  // newer-schema refusal is the guard over state this build cannot read,
  // and it is the recorded version that arms it.
  const fromNewer = { schemaVersion: STATE_SCHEMA_VERSION + 1, applied: [...everything, '0004-from-a-later-build'] };
  assert.equal(
    mergeStateStamp(fromNewer, { schemaVersion: STATE_SCHEMA_VERSION, applied: everything }).schemaVersion,
    STATE_SCHEMA_VERSION + 1,
  );
});
