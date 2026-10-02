import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { claimFileLock, FileLockHeldError, grantReadSerializer, grantsLockPath } from '../src/index.ts';

const newHome = async (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'stratus-file-lock-'));

test('a file lock has one holder at a time, refused at once by default, and is free again on release', async () => {
  const lockPath = path.join(await newHome(), '.stratus', 'some.lock');
  const first = claimFileLock(lockPath);
  // Same process, but it is SQLite's own file lock, so another process is
  // refused the same way.
  assert.throws(() => claimFileLock(lockPath), (error: unknown) => error instanceof FileLockHeldError && error.lockPath === lockPath);
  first.release();
  first.release();
  claimFileLock(lockPath).release();
  // Nothing is written to it, and it is 0600 like the rest of ~/.stratus.
  assert.equal((await stat(lockPath)).size, 0);
  assert.equal((await stat(lockPath)).mode & 0o777, 0o600);
});

test('the grant read serializer holds the grants lock for exactly the read', async () => {
  // So a revoke taking the same lock lands wholly before or after a
  // daemon's read of the file, never between (#184).
  const env = { homeDir: await newHome() };
  const serialize = grantReadSerializer(env);
  const during = serialize(() => {
    try {
      claimFileLock(grantsLockPath(env)).release();
      return 'free';
    } catch (error) {
      return error instanceof FileLockHeldError ? 'held' : 'failed';
    }
  });
  assert.equal(during, 'held');
  // And let go afterwards, or the next revoke waits on a reader that is done.
  claimFileLock(grantsLockPath(env)).release();
});

test('a lock taken with a wait waits for another process\'s holder to let go', async () => {
  // The holder is a second process that releases on its own a moment after
  // it says it holds. Given a wait far longer than that, the claim has to
  // succeed. It used to fail at once: the journal-mode statement met the
  // held lock before the wait was set, so `waitMs` never applied and a
  // daemon's grant read went ahead without the lock (#184).
  const lockPath = path.join(await newHome(), '.stratus', 'held.lock');
  claimFileLock(lockPath).release();
  const holder = spawn(process.execPath, ['--no-warnings', '-e', `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(lockPath)});
    db.exec('PRAGMA journal_mode = MEMORY');
    db.exec('BEGIN EXCLUSIVE');
    process.stdout.write('held\\n');
    setTimeout(() => { db.close(); }, 200);
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  const [chunk] = await once(holder.stdout!, 'data') as [Buffer];
  assert.equal(chunk.toString().trim(), 'held');

  const lock = claimFileLock(lockPath, { waitMs: 10_000 });
  lock.release();
  await once(holder, 'exit');
});

test('a lock file that is a symlink is refused, and what it points at is left alone', async () => {
  // Opening, locking, chmodding and the damaged-file reclaim all follow a
  // link, so one planted at the lock's path would have emptied whatever it
  // named: here, a file that is not a database, exactly the case the
  // reclaim truncates.
  const home = await newHome();
  const victim = path.join(home, 'precious.txt');
  await writeFile(victim, 'keep me');
  const lockPath = path.join(home, '.stratus', 'grants.lock');
  claimFileLock(path.join(home, '.stratus', 'other.lock')).release();
  await symlink(victim, lockPath);

  assert.throws(() => claimFileLock(lockPath), /is a symbolic link/);
  assert.equal(await readFile(victim, 'utf8'), 'keep me');
});
