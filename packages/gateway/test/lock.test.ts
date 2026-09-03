import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DatabaseSync } from 'node:sqlite';

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
  assert.equal(await readFile(homeLockPath(env), 'utf8'), '', 'replaced with an empty database file');
});

test('replacing a damaged lock file is serialized, so two starters cannot each claim their own', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const damaged = 'not a database at all\n';
  await mkdir(path.dirname(homeLockPath(env)), { recursive: true });
  await writeFile(homeLockPath(env), damaged);

  // Another starter is mid-repair: it holds the sibling repair claim. This
  // one must not remove the file it saw — by now that may be the fresh
  // lock the other starter holds — and is refused as a daemon still
  // starting instead.
  const repairing = new DatabaseSync(`${homeLockPath(env)}.repair`);
  repairing.exec('BEGIN EXCLUSIVE');
  try {
    assert.throws(() => claimHome(env), HomeClaimedError);
    assert.equal(await readFile(homeLockPath(env), 'utf8'), damaged, 'nothing removed while another starter repairs');
  } finally {
    repairing.close();
  }

  // With the repair claim free, the replacement proceeds.
  const claim = claimHome(env);
  assert.equal(await readFile(homeLockPath(env), 'utf8'), '');
  claim.release();
});
