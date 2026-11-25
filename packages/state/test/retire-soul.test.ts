import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { agentsDirPath, retireSoulFile, type StateEnvironment } from '../src/index.ts';

// `retireSoulFile` moves a deleted agent's soul aside and never deletes it,
// so an archive must never land on top of an earlier one.

test('retiring the same id twice in one millisecond keeps both archived souls', async () => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'stratus-retire-')));
  const env: StateEnvironment = { homeDir: home, cwd: home, processEnv: {} };
  const agents = agentsDirPath(env);
  await mkdir(agents, { recursive: true });
  const now = new Date('2026-11-25T05:00:00.000Z');
  const soulPath = path.join(agents, 'ava.md');

  await writeFile(soulPath, '---\nid: ava\nname: Ava\n---\nThe first Ava.\n');
  const first = await retireSoulFile(env, soulPath, 'ava', now);
  await writeFile(soulPath, '---\nid: ava\nname: Ava\n---\nThe second Ava.\n');
  const second = await retireSoulFile(env, soulPath, 'ava', now);

  assert.notEqual(second, first);
  assert.match(await readFile(first, 'utf8'), /The first Ava/);
  assert.match(await readFile(second, 'utf8'), /The second Ava/);
  assert.equal((await readdir(path.dirname(first))).length, 2);
});
