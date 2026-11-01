import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rename, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  type StateBackup,
  STATE_SCHEMA_VERSION,
  backUpStateBeforeMigrating,
  backupsDirPath,
  readStateStamp,
  runStateMigrations,
  stateFilePath,
  stratusHomePath,
} from '../src/index.ts';
import { describeStateBackup, markMigrationBegun, settleFailedMigration } from '../src/state-backup.ts';

/**
 * A home a 0.12-era build left one migration short: per-agent sessions and
 * memory, the fleet database, a soul and its grants, plus the things a
 * backup must leave out. Its stamp has 0004 (the workspace move) pending,
 * which is a migration that changes data and so is backed up first.
 */
const seedHome = async (): Promise<{ home: string; stratus: string; stampBytes: string }> => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-backup-'));
  const stratus = stratusHomePath({ homeDir: home });
  await mkdir(path.join(stratus, 'agents', 'ava'), { recursive: true });
  const db = new DatabaseSync(path.join(stratus, 'agents', 'ava', 'sessions.db'));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE sessions (id TEXT PRIMARY KEY, body TEXT); INSERT INTO sessions VALUES ('s1', 'hello from ava')");
  db.close();
  const fleet = new DatabaseSync(path.join(stratus, 'fleet.db'));
  fleet.exec("CREATE TABLE schedules (id TEXT PRIMARY KEY); INSERT INTO schedules VALUES ('daily')");
  fleet.close();
  await writeFile(path.join(stratus, 'agents', 'ava', 'memory.jsonl'), '{"id":"m1","content":"ava likes tea"}\n');
  await writeFile(path.join(stratus, 'agents', 'ava', 'whitelist.json'), '{"version":1,"commands":["git status"]}\n');
  await writeFile(path.join(stratus, 'agents', 'ava.md'), '---\nname: Ava\n---\nYou are Ava.\n');
  await writeFile(path.join(stratus, 'config.json'), '{"provider":"demo"}\n');
  const stampBytes = `${JSON.stringify({
    schemaVersion: 3,
    applied: ['0001-owner-only-state-files', '0002-provenance-labels', '0003-per-agent-state-layout'],
  }, null, 2)}\n`;
  await writeFile(stateFilePath({ homeDir: home }), stampBytes);
  // Left out: secrets no migration rewrites, a daemon's address file, logs,
  // and workspaces (large, and moved rather than rewritten).
  await writeFile(path.join(stratus, 'credentials.json'), '{"anthropic":{"type":"api_key","value":"sk-ant-FIXTURE"}}\n');
  await writeFile(path.join(stratus, 'gateway-token'), 'token-FIXTURE\n');
  await writeFile(path.join(stratus, 'gateway.json'), '{"port":1}\n');
  await writeFile(path.join(stratus, 'grants.lock'), '');
  await mkdir(path.join(stratus, 'logs'), { recursive: true });
  await writeFile(path.join(stratus, 'logs', 'stratusd.jsonl'), '{}\n');
  await mkdir(path.join(stratus, 'workspaces', 'ava'), { recursive: true });
  await writeFile(path.join(stratus, 'workspaces', 'ava', 'notes.txt'), 'draft\n');
  return { home, stratus, stampBytes };
};

const listFiles = async (root: string, prefix = ''): Promise<string[]> => {
  const found: string[] = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      found.push(...await listFiles(root, relative));
    } else {
      found.push(relative);
    }
  }
  return found.sort();
};

test('a run that applies a data migration first copies the state files into a dated backup', async () => {
  const { home, stratus, stampBytes } = await seedHome();
  const env = { homeDir: home };
  const reported: StateBackup[] = [];
  // A row committed but not yet checkpointed: it is only in sessions.db-wal.
  const writer = new DatabaseSync(path.join(stratus, 'agents', 'ava', 'sessions.db'));
  writer.exec("PRAGMA wal_autocheckpoint=0; INSERT INTO sessions VALUES ('s2', 'still in the log')");

  try {
    await runStateMigrations(env, { exclusive: true, onBackup: (backup) => reported.push(backup) });
  } finally {
    writer.close();
  }

  assert.equal(reported.length, 1);
  const [backup] = reported;
  assert.equal(backup!.reused, false);
  assert.equal(path.dirname(backup!.path), backupsDirPath(env));
  const files = path.join(backup!.path, 'files');
  assert.deepEqual(await listFiles(files), [
    'agents/ava.md',
    'agents/ava/memory.jsonl',
    'agents/ava/sessions.db',
    'agents/ava/whitelist.json',
    'config.json',
    'fleet.db',
    'state.json',
  ]);
  assert.deepEqual([...backup!.files].sort(), await listFiles(files));
  // The stamp as it was before anything ran, so a restore hands the older
  // build a home it reads as its own.
  assert.equal(await readFile(path.join(files, 'state.json'), 'utf8'), stampBytes);
  assert.equal(await readFile(path.join(files, 'agents', 'ava', 'memory.jsonl'), 'utf8'), '{"id":"m1","content":"ava likes tea"}\n');
  // A database is copied through SQLite, so rows still in the WAL come too.
  const copied = new DatabaseSync(path.join(files, 'agents', 'ava', 'sessions.db'), { readOnly: true });
  assert.deepEqual({ ...copied.prepare('SELECT body FROM sessions WHERE id = ?').get('s1') }, { body: 'hello from ava' });
  assert.deepEqual({ ...copied.prepare('SELECT body FROM sessions WHERE id = ?').get('s2') }, { body: 'still in the log' });
  copied.close();

  const manifest = JSON.parse(await readFile(path.join(backup!.path, 'backup.json'), 'utf8'));
  assert.deepEqual(manifest.from, JSON.parse(stampBytes));
  assert.deepEqual(manifest.migrations, ['0004-per-agent-workspaces']);
  assert.equal(manifest.createdAt, backup!.createdAt);

  // Owner-only: it holds every agent's conversations and memories.
  assert.equal((await stat(backupsDirPath(env))).mode & 0o777, 0o700);
  assert.equal((await stat(backup!.path)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(files, 'agents', 'ava', 'memory.jsonl'))).mode & 0o777, 0o600);

  // And then the migration ran as before.
  assert.equal((await readStateStamp(env)).schemaVersion, STATE_SCHEMA_VERSION);
  assert.equal(await readFile(path.join(stratus, 'agents', 'ava', 'workspace', 'notes.txt'), 'utf8'), 'draft\n');
});

test('no backup when nothing that runs changes data, or the home holds no conversations or memories', async () => {
  // Fully migrated: nothing pending.
  const migrated = await seedHome();
  await runStateMigrations({ homeDir: migrated.home }, { exclusive: true });
  const before = await readdir(backupsDirPath({ homeDir: migrated.home }));
  const reported: StateBackup[] = [];
  await runStateMigrations({ homeDir: migrated.home }, { exclusive: true, onBackup: (backup) => reported.push(backup) });
  assert.equal(reported.length, 0);
  assert.deepEqual(await readdir(backupsDirPath({ homeDir: migrated.home })), before);

  // Only migrations that leave the data alone are pending: a permission
  // change and a stamp.
  const stampOnly = await seedHome();
  await writeFile(stateFilePath({ homeDir: stampOnly.home }), `${JSON.stringify({
    schemaVersion: 4,
    applied: ['0003-per-agent-state-layout', '0004-per-agent-workspaces'],
  })}\n`);
  await runStateMigrations({ homeDir: stampOnly.home }, { exclusive: true, onBackup: (backup) => reported.push(backup) });
  assert.equal(reported.length, 0);
  assert.ok((await readStateStamp({ homeDir: stampOnly.home })).applied.includes('0002-provenance-labels'));
  await assert.rejects(stat(backupsDirPath({ homeDir: stampOnly.home })), { code: 'ENOENT' });

  // An ordinary command defers 0004, so it applies nothing that needs one.
  const deferred = await seedHome();
  await runStateMigrations({ homeDir: deferred.home }, { onBackup: (backup) => reported.push(backup) });
  assert.equal(reported.length, 0);
  await assert.rejects(stat(backupsDirPath({ homeDir: deferred.home })), { code: 'ENOENT' });

  // A fresh install's first serve: every migration runs, but there is
  // nothing to lose, so no backups/ directory appears.
  const fresh = await mkdtemp(path.join(os.tmpdir(), 'stratus-backup-fresh-'));
  await mkdir(path.join(stratusHomePath({ homeDir: fresh }), 'agents'), { recursive: true });
  await writeFile(path.join(stratusHomePath({ homeDir: fresh }), 'config.json'), '{}\n');
  await runStateMigrations({ homeDir: fresh }, { exclusive: true, onBackup: (backup) => reported.push(backup) });
  assert.equal(reported.length, 0);
  await assert.rejects(stat(backupsDirPath({ homeDir: fresh })), { code: 'ENOENT' });
});

test('a retry of the same upgrade within a day reuses its backup rather than taking another', async () => {
  const { home } = await seedHome();
  const env = { homeDir: home };
  const stamp = await readStateStamp(env);
  const first = await backUpStateBeforeMigrating(env, stamp, ['0004-per-agent-workspaces'], new Date('2026-11-01T01:00:00Z'));
  assert.equal(first?.reused, false);
  // Copying a database leaves nothing beside the original.
  assert.deepEqual((await readdir(path.join(stratusHomePath(env), 'agents', 'ava'))).sort(), ['memory.jsonl', 'sessions.db', 'whitelist.json']);

  // A daemon restarting in a loop over a failing migration must not fill
  // the disk with copies of the same state.
  const again = await backUpStateBeforeMigrating(env, stamp, ['0004-per-agent-workspaces'], new Date('2026-11-01T20:00:00Z'));
  assert.equal(again?.reused, true);
  assert.equal(again?.path, first?.path);
  assert.equal((await readdir(backupsDirPath(env))).length, 1);

  // A day later the state may have moved on under the older build, so the
  // old copy is no longer the one to restore.
  const later = await backUpStateBeforeMigrating(env, stamp, ['0004-per-agent-workspaces'], new Date('2026-11-02T01:00:01Z'));
  assert.equal(later?.reused, false);
  assert.notEqual(later?.path, first?.path);

  // A different starting stamp is a different upgrade.
  const other = await backUpStateBeforeMigrating(
    env,
    { schemaVersion: 2, applied: ['0001-owner-only-state-files', '0002-provenance-labels'] },
    ['0003-per-agent-state-layout', '0004-per-agent-workspaces'],
    new Date('2026-11-02T01:00:02Z'),
  );
  assert.equal(other?.reused, false);
  assert.equal((await readdir(backupsDirPath(env))).length, 3);
});

test('a retry after the older build wrote more takes a fresh backup, so restoring it never drops what was written', async () => {
  // A migration failed after its backup, and `stratus update` started the
  // older daemon again, which went on working under the same stamp.
  const { home, stratus } = await seedHome();
  const env = { homeDir: home };
  const stamp = await readStateStamp(env);
  const migrations = ['0004-per-agent-workspaces'];
  const first = await backUpStateBeforeMigrating(env, stamp, migrations, new Date('2026-11-01T01:00:00Z'));
  assert.equal(first?.reused, false);

  // A conversation row the older daemon committed and has not checkpointed
  // yet: only sessions.db-wal changed, not sessions.db.
  const daemon = new DatabaseSync(path.join(stratus, 'agents', 'ava', 'sessions.db'));
  daemon.exec("PRAGMA wal_autocheckpoint=0; INSERT INTO sessions VALUES ('s3', 'written between the attempts')");
  let retry: StateBackup | undefined;
  try {
    retry = await backUpStateBeforeMigrating(env, stamp, migrations, new Date('2026-11-01T01:05:00Z'));
  } finally {
    daemon.close();
  }
  assert.equal(retry?.reused, false);
  assert.notEqual(retry?.path, first?.path);
  const copied = new DatabaseSync(path.join(retry!.path, 'files', 'agents', 'ava', 'sessions.db'), { readOnly: true });
  assert.deepEqual({ ...copied.prepare('SELECT body FROM sessions WHERE id = ?').get('s3') }, { body: 'written between the attempts' });
  copied.close();

  // A memory the older build saved, and a new file it wrote.
  await writeFile(path.join(stratus, 'agents', 'ava', 'memory.jsonl'), '{"id":"m1","content":"ava likes tea"}\n{"id":"m2","content":"and biscuits"}\n');
  const afterMemory = await backUpStateBeforeMigrating(env, stamp, migrations, new Date('2026-11-01T01:10:00Z'));
  assert.equal(afterMemory?.reused, false);
  await writeFile(path.join(stratus, 'agents', 'ava', 'notes.json'), '{}\n');
  const afterNewFile = await backUpStateBeforeMigrating(env, stamp, migrations, new Date('2026-11-01T01:15:00Z'));
  assert.equal(afterNewFile?.reused, false);

  // Nothing written since the newest copy: that one is kept, and every
  // earlier copy stays where it was.
  const unchanged = await backUpStateBeforeMigrating(env, stamp, migrations, new Date('2026-11-01T01:20:00Z'));
  assert.equal(unchanged?.reused, true);
  assert.equal(unchanged?.path, afterNewFile?.path);
  assert.equal((await readdir(backupsDirPath(env))).length, 4);
});

test('a retry after a migration that changed the state and did not finish keeps the copy from before it', async () => {
  // The run took its backup, a migration got partway (it set a database
  // aside and wrote a new one), and then failed. The stamp is still the
  // old one, so the next start runs the same upgrade again. A copy of the
  // state now holds neither the old layout nor the new one: an older build
  // restored from it would not find its conversations.
  const { home, stratus } = await seedHome();
  const env = { homeDir: home };
  const stamp = await readStateStamp(env);
  const migrations = ['0004-per-agent-workspaces'];
  const first = await backUpStateBeforeMigrating(env, stamp, migrations, new Date('2026-11-01T01:00:00Z'));
  const mark = await markMigrationBegun(env, first!);
  assert.equal(mark.placed, true);
  await rename(path.join(stratus, 'fleet.db'), path.join(stratus, 'fleet.db.migrated'));
  const moved = new DatabaseSync(path.join(stratus, 'agents', 'ava', 'fleet.db'));
  moved.exec("CREATE TABLE schedules (id TEXT PRIMARY KEY); INSERT INTO schedules VALUES ('daily')");
  moved.close();
  await settleFailedMigration(env, mark);

  for (const at of ['2026-11-01T01:05:00Z', '2026-11-03T01:00:00Z']) {
    const retry = await backUpStateBeforeMigrating(env, stamp, migrations, new Date(at));
    assert.equal(retry?.reused, true);
    assert.equal(retry?.changedSince, true);
    assert.equal(retry?.path, first?.path);
    assert.match(describeStateBackup(retry!), /before this upgrade first ran/);
    assert.match(describeStateBackup(retry!), /not in it/);
    // That retry's migration fails too, this time before changing anything.
    // The state is still the half-moved one the first run left, so the mark
    // that run left stays.
    const again = await markMigrationBegun(env, retry!);
    assert.equal(again.placed, false);
    await settleFailedMigration(env, again);
  }
  assert.equal((await readdir(backupsDirPath(env))).length, 1);
  assert.ok((await listFiles(path.join(first!.path, 'files'))).includes('fleet.db'));

  // The same holds when the failed run never got to say how it ended (it
  // was killed): a migration began, so the copy from before it is kept.
  const killed = await seedHome();
  const killedEnv = { homeDir: killed.home };
  const before = await backUpStateBeforeMigrating(killedEnv, stamp, migrations, new Date('2026-11-01T01:00:00Z'));
  await markMigrationBegun(killedEnv, before!);
  await writeFile(path.join(killed.stratus, 'agents', 'ava', 'memory.jsonl'), '');
  const afterKill = await backUpStateBeforeMigrating(killedEnv, stamp, migrations, new Date('2026-11-01T01:05:00Z'));
  assert.equal(afterKill?.path, before?.path);
  assert.equal(afterKill?.changedSince, true);
});

test('a migration that failed before changing anything leaves the copy free to be replaced once the older build writes more', async () => {
  const { home, stratus } = await seedHome();
  const env = { homeDir: home };
  const stamp = await readStateStamp(env);
  const migrations = ['0004-per-agent-workspaces'];
  const first = await backUpStateBeforeMigrating(env, stamp, migrations, new Date('2026-11-01T01:00:00Z'));
  await settleFailedMigration(env, await markMigrationBegun(env, first!));

  // Nothing written since: the same copy, and not marked as changed.
  const same = await backUpStateBeforeMigrating(env, stamp, migrations, new Date('2026-11-01T01:02:00Z'));
  assert.equal(same?.path, first?.path);
  assert.equal(same?.changedSince, false);

  await writeFile(path.join(stratus, 'agents', 'ava', 'memory.jsonl'), '{"id":"m1","content":"ava likes tea"}\n{"id":"m2","content":"and biscuits"}\n');
  const retry = await backUpStateBeforeMigrating(env, stamp, migrations, new Date('2026-11-01T01:05:00Z'));
  assert.equal(retry?.reused, false);
  assert.notEqual(retry?.path, first?.path);
  assert.match(await readFile(path.join(retry!.path, 'files', 'agents', 'ava', 'memory.jsonl'), 'utf8'), /biscuits/);
});

test('the run marks its backup before migrating, so a run that dies partway leaves the copy kept', async () => {
  // The run finished here, but it is the same mark a killed one leaves:
  // asked again from the stamp it started at, the copy is kept as the one
  // from before, though the state has moved on since.
  const { home } = await seedHome();
  const env = { homeDir: home };
  const reported: StateBackup[] = [];
  await runStateMigrations(env, { exclusive: true, onBackup: (backup) => reported.push(backup) });
  assert.equal(reported.length, 1);
  const { from } = JSON.parse(await readFile(path.join(reported[0]!.path, 'backup.json'), 'utf8'));
  const again = await backUpStateBeforeMigrating(env, from, ['0004-per-agent-workspaces'], new Date(Date.parse(reported[0]!.createdAt) + 60_000));
  assert.equal(again?.path, reported[0]!.path);
  assert.equal(again?.changedSince, true);
});

test('a run whose migration failed before changing anything lets the next run copy what the older build wrote since', async () => {
  const { home, stratus } = await seedHome();
  const env = { homeDir: home };
  const reported: StateBackup[] = [];
  const onBackup = (backup: StateBackup): void => { reported.push(backup); };
  // 0004 can't list the workspaces, so it fails before moving any of them.
  await chmod(path.join(stratus, 'workspaces'), 0o000);
  try {
    await assert.rejects(runStateMigrations(env, { exclusive: true, onBackup }), { code: 'EACCES' });
  } finally {
    await chmod(path.join(stratus, 'workspaces'), 0o700);
  }
  assert.equal(reported.length, 1);

  await writeFile(path.join(stratus, 'agents', 'ava', 'memory.jsonl'), '{"id":"m1","content":"ava likes tea"}\n{"id":"m2","content":"and biscuits"}\n');
  await runStateMigrations(env, { exclusive: true, onBackup });
  assert.equal(reported.length, 2);
  assert.equal(reported[1]!.reused, false);
  assert.notEqual(reported[1]!.path, reported[0]!.path);
  assert.match(await readFile(path.join(reported[1]!.path, 'files', 'agents', 'ava', 'memory.jsonl'), 'utf8'), /biscuits/);
});

test('a permission change an earlier migration made is not the failed migration changing the state', async () => {
  // 0001 is still pending and tightens a memory file an older install left
  // readable to others, which changes its ctime and nothing an older build
  // reads. Then 0004 fails before moving anything. The state is still the
  // older build's, so once that build writes more, a retry copies it again.
  const { home, stratus } = await seedHome();
  const env = { homeDir: home };
  await writeFile(stateFilePath(env), `${JSON.stringify({
    schemaVersion: 3,
    applied: ['0002-provenance-labels', '0003-per-agent-state-layout'],
  }, null, 2)}\n`);
  const loose = path.join(stratus, 'memory.jsonl');
  await writeFile(loose, '{"id":"m0","content":"from before the per-agent move"}\n');
  await chmod(loose, 0o644);
  const reported: StateBackup[] = [];
  const onBackup = (backup: StateBackup): void => { reported.push(backup); };
  await chmod(path.join(stratus, 'workspaces'), 0o000);
  try {
    await assert.rejects(runStateMigrations(env, { exclusive: true, onBackup }), { code: 'EACCES' });
  } finally {
    await chmod(path.join(stratus, 'workspaces'), 0o700);
  }
  assert.equal((await stat(loose)).mode & 0o777, 0o600);
  assert.equal(reported.length, 1);

  await writeFile(path.join(stratus, 'agents', 'ava', 'memory.jsonl'), '{"id":"m1","content":"ava likes tea"}\n{"id":"m2","content":"and biscuits"}\n');
  await runStateMigrations(env, { exclusive: true, onBackup });
  assert.equal(reported.length, 2);
  assert.equal(reported[1]!.reused, false);
  assert.notEqual(reported[1]!.path, reported[0]!.path);
  assert.match(await readFile(path.join(reported[1]!.path, 'files', 'agents', 'ava', 'memory.jsonl'), 'utf8'), /biscuits/);
});

test('a backup that cannot be taken stops the upgrade before anything changes, and leaves no partial copy', async () => {
  const { home, stratus, stampBytes } = await seedHome();
  const env = { homeDir: home };
  const unreadable = path.join(stratus, 'agents', 'ava', 'memory.jsonl');
  await chmod(unreadable, 0o000);
  try {
    await assert.rejects(
      runStateMigrations(env, { exclusive: true }),
      (error: Error) => {
        assert.match(error.message, /backing up/i);
        assert.match(error.message, /Nothing was changed/);
        assert.match(error.message, /agents\/ava\/memory\.jsonl/);
        return true;
      },
    );
  } finally {
    await chmod(unreadable, 0o600);
  }
  assert.equal(await readFile(stateFilePath(env), 'utf8'), stampBytes);
  assert.equal(await readFile(path.join(stratus, 'workspaces', 'ava', 'notes.txt'), 'utf8'), 'draft\n');
  assert.deepEqual(await readdir(backupsDirPath(env)), []);

  // Nowhere to write it: refused the same way.
  const blocked = await seedHome();
  await writeFile(backupsDirPath({ homeDir: blocked.home }), 'not a directory\n');
  await assert.rejects(runStateMigrations({ homeDir: blocked.home }, { exclusive: true }), /Nothing was changed/);
  assert.equal(await readFile(stateFilePath({ homeDir: blocked.home }), 'utf8'), blocked.stampBytes);
});

test('a link is copied as the link, never followed: a soul in the agents folder comes back pointing where it did', async () => {
  const { home, stratus } = await seedHome();
  const outside = await mkdtemp(path.join(os.tmpdir(), 'stratus-backup-outside-'));
  await writeFile(path.join(outside, 'soul.md'), 'You are Bob.\n');
  await symlink(path.join(outside, 'soul.md'), path.join(stratus, 'agents', 'bob.md'));
  await symlink(outside, path.join(stratus, 'agents', 'carol'));

  const reported: StateBackup[] = [];
  await runStateMigrations({ homeDir: home }, { exclusive: true, onBackup: (backup) => reported.push(backup) });
  const files = path.join(reported[0]!.path, 'files');
  assert.ok((await lstat(path.join(files, 'agents', 'bob.md'))).isSymbolicLink());
  assert.equal(await readlink(path.join(files, 'agents', 'bob.md')), path.join(outside, 'soul.md'));
  assert.ok((await lstat(path.join(files, 'agents', 'carol'))).isSymbolicLink());
  assert.equal(await readlink(path.join(files, 'agents', 'carol')), outside);
  assert.ok(reported[0]!.files.includes('agents/bob.md'));
  // Nothing was written through either link.
  assert.deepEqual(await readdir(outside), ['soul.md']);
});
