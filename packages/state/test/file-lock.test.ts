import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, chmod, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { claimFileLock, fileLockHeld, FileLockHeldError, grantReadSerializer, grantsLockPath, grantWriteSerializer } from '../src/index.ts';

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

test('a grant write holds the lock against others, and reads inside it do not wait on it', async () => {
  // The daemon's write re-reads the file under the lock; that read runs
  // in the same process and must not block on the lock its own write holds.
  const env = { homeDir: await newHome() };
  const write = grantWriteSerializer(env);
  // No wait, so a read that did try to claim the held lock fails here
  // rather than blocking the thread for the whole default wait.
  const read = grantReadSerializer(env, { waitMs: 0 });
  const seen = await write(async () => {
    assert.throws(() => claimFileLock(grantsLockPath(env)), FileLockHeldError);
    await Promise.resolve();
    return read(() => 'read inside');
  });
  assert.equal(seen, 'read inside');
  // Let go afterwards.
  claimFileLock(grantsLockPath(env)).release();
});

test('a grant read or write whose lock is still held after the wait is refused, never run without it', async () => {
  // Running through is the race the lock closes: a read caching the grant
  // a revoke is removing, a write landing over the revoke's (#184).
  const env = { homeDir: await newHome() };
  const holder = claimFileLock(grantsLockPath(env));
  let ran = false;
  try {
    assert.throws(
      () => grantReadSerializer(env, { waitMs: 0 })(() => { ran = true; }),
      FileLockHeldError,
    );
    await assert.rejects(
      grantWriteSerializer(env, { waitMs: 0 })(async () => { ran = true; }),
      FileLockHeldError,
    );
  } finally {
    holder.release();
  }
  assert.equal(ran, false);
});

test('asking whether a lock is held answers without taking it or creating the file', async () => {
  const lockPath = path.join(await newHome(), '.stratus', 'stratusd.lock');
  // No file: nobody holds it, and asking made nothing.
  assert.equal(fileLockHeld(lockPath), false);
  await assert.rejects(access(lockPath), { code: 'ENOENT' });
  await assert.rejects(access(path.dirname(lockPath)), { code: 'ENOENT' });

  const held = claimFileLock(lockPath);
  assert.equal(fileLockHeld(lockPath), true);
  // Asking twice changes nothing for the holder or the next claimant.
  assert.equal(fileLockHeld(lockPath), true);
  held.release();
  assert.equal(fileLockHeld(lockPath), false);
  // Asking left nothing behind that stops a claim.
  claimFileLock(lockPath).release();

  // Something else at the path, never a holder.
  await writeFile(lockPath, 'not a database at all, and longer than a header would be: '.repeat(4));
  assert.equal(fileLockHeld(lockPath), false);
  const link = path.join(path.dirname(lockPath), 'linked.lock');
  await symlink(lockPath, link);
  assert.equal(fileLockHeld(link), false);

  // There, but not ours to read: no holder seen is not no holder.
  await writeFile(lockPath, '');
  await chmod(lockPath, 0o000);
  try {
    assert.equal(fileLockHeld(lockPath), process.getuid?.() === 0 ? false : undefined);
  } finally {
    await chmod(lockPath, 0o600);
  }
});

test('a lock another process holds reads as held, and free once that process lets go', async () => {
  // The case doctor and health ask about: the daemon is another process.
  const lockPath = path.join(await newHome(), '.stratus', 'stratusd.lock');
  claimFileLock(lockPath).release();
  const holder = spawn(process.execPath, ['--no-warnings', '-e', `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(lockPath)});
    db.exec('PRAGMA journal_mode = MEMORY');
    db.exec('BEGIN EXCLUSIVE');
    process.stdout.write('held\\n');
    process.stdin.once('data', () => { db.close(); process.exit(0); });
  `], { stdio: ['pipe', 'pipe', 'inherit'] });
  const [chunk] = await once(holder.stdout!, 'data') as [Buffer];
  assert.equal(chunk.toString().trim(), 'held');
  assert.equal(fileLockHeld(lockPath), true);
  holder.stdin!.write('go\n');
  await once(holder, 'exit');
  assert.equal(fileLockHeld(lockPath), false);
});
