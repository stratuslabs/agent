import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
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

  // It holds a pid and nothing more, and is still 0600 like everything
  // else under ~/.stratus that decides something.
  assert.equal((await stat(homeLockPath(env))).mode & 0o777, 0o600);
});
