import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
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
