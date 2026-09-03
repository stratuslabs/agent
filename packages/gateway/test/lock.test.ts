import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { HomeClaimedError, claimHome, homeLockPath } from '../src/index.ts';

const newHome = async (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'stratus-lock-'));

test('a home is held by one claim at a time, until it is released', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };

  const first = claimHome(env);
  // Refused at once, by type: the caller says who holds it, this only
  // says that someone does. Same process here, but the lock is SQLite's
  // own file lock, so a second process is refused the same way.
  assert.throws(() => claimHome(env), (error: unknown) => error instanceof HomeClaimedError && error.name === 'HomeClaimedError');
  assert.throws(() => claimHome(env), HomeClaimedError, 'still held: a refusal releases nothing');

  first.release();
  first.release();
  const second = claimHome(env);
  second.release();

  // Nothing is ever written to it — the claim is an open transaction, so a
  // crash mid-claim has nothing to tear — and it is 0600 like everything
  // else under ~/.stratus that decides something.
  assert.equal((await stat(homeLockPath(env))).size, 0);
  assert.equal((await stat(homeLockPath(env))).mode & 0o777, 0o600);
});

test('a lock file that is not a database any more is replaced, not obeyed', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  // Damaged from outside — nothing of ours writes it. Nobody can be
  // holding it: holding it needed the header this read refuses. Refusing
  // to start over it would take the file's removal to bring a daemon up.
  await mkdir(path.dirname(homeLockPath(env)), { recursive: true });
  await writeFile(homeLockPath(env), 'not a database at all\n');

  const claim = claimHome(env);
  assert.throws(() => claimHome(env), HomeClaimedError, 'the rebuilt file is the lock');
  claim.release();
  assert.equal(await readFile(homeLockPath(env), 'utf8'), '', 'emptied in place: a valid, empty database');
});

test('a damaged lock file is emptied where it stands, never replaced', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  await mkdir(path.dirname(homeLockPath(env)), { recursive: true });
  await writeFile(homeLockPath(env), 'not a database at all\n');

  // The OS lock lives on the inode. A repair that removed and recreated
  // the file would hand a starter acting on a stale read an inode of its
  // own to hold beside the first's; emptied in place, two starters that
  // read the same damage both empty the one file and then contend for the
  // one lock. So the inode must survive the repair.
  // Observed through a descriptor opened on the damaged file: a file that
  // was unlinked and recreated leaves this descriptor's inode with no
  // links, whatever number the new file was given.
  const handle = await open(homeLockPath(env), 'r');
  const claim = claimHome(env);
  try {
    assert.equal((await handle.stat()).nlink, 1, 'the same inode, emptied — not a new file');
    assert.equal(await readFile(homeLockPath(env), 'utf8'), '');
  } finally {
    claim.release();
    await handle.close();
  }
});
