import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createHostProtectedPaths } from '../src/index.ts';

const newHome = async (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'stratus-protected-paths-'));

test('the host protects its whole home and names the secret files in it, and exempts each agent’s workspace', async () => {
  const home = await newHome();
  const stratus = path.join(home, '.stratus');
  await mkdir(path.join(stratus, 'agents', 'ava'), { recursive: true });
  await mkdir(path.join(stratus, 'agents', 'juno'), { recursive: true });
  const env = { homeDir: home, cwd: home, processEnv: {} };

  const protectedPaths = createHostProtectedPaths(env);
  const all = await protectedPaths.all();
  for (const expected of [
    stratus,
    path.join(stratus, 'credentials.json'),
    path.join(stratus, 'gateway-token'),
    path.join(stratus, 'gateway.json'),
    path.join(stratus, 'config.json'),
  ]) {
    assert.ok(all.includes(expected), expected);
  }
  assert.deepEqual(
    [...(await protectedPaths.exempt())].sort(),
    [path.join(stratus, 'agents', 'ava', 'workspace'), path.join(stratus, 'agents', 'juno', 'workspace')],
  );
});

test('a trusted config chosen outside the home is protected where it is; a project-local one is not', async () => {
  const home = await newHome();
  const elsewhere = path.join(home, 'etc', 'stratus.json');
  await mkdir(path.dirname(elsewhere), { recursive: true });
  await writeFile(elsewhere, '{}');

  const byFlag = await createHostProtectedPaths({ homeDir: home, cwd: home, processEnv: {} }, { configPath: elsewhere }).all();
  assert.ok(byFlag.includes(elsewhere));
  const byEnv = await createHostProtectedPaths({ homeDir: home, cwd: home, processEnv: { STRATUS_CONFIG: elsewhere } }).all();
  assert.ok(byEnv.includes(elsewhere));

  // An auto-discovered project config ships in a repository and is the
  // agent's to read like the rest of it.
  const project = path.join(home, 'repo');
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, 'stratus.config.json'), '{}');
  const local = await createHostProtectedPaths({ homeDir: home, cwd: project, processEnv: {} }).all();
  assert.equal(local.includes(path.join(project, 'stratus.config.json')), false);
});
