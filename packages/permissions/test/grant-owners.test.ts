import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createFileCommandWhitelist, legacyWhitelistPathFor } from '../src/index.ts';

// `owners()`: every agent id with a grant file, read the way a grant read
// reads paths, so a link never adds an id.

const freshHome = async (): Promise<{ home: string; agents: string }> => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-owners-'));
  return { home, agents: path.join(home, 'agents') };
};

test('owners lists agents with a grant file in either layout, sorted, and skips links and empty directories', async () => {
  const { home, agents } = await freshHome();
  const store = createFileCommandWhitelist({ directory: agents, stateHome: home });
  await store.rememberTool('zed', { tool: 'demo.echo', grantedAt: '2026-11-24T00:00:00.000Z' });
  await store.rememberOrigin('ava', { origin: 'https://app.example.com' });
  // The older layout, authoritative until the migration moves it.
  await writeFile(legacyWhitelistPathFor(agents, 'old-timer'), JSON.stringify({ version: 1, scopes: [] }));
  await mkdir(path.join(agents, 'no-grants'), { recursive: true });
  // A directory link to somewhere holding a grant file, and a grant file
  // that is itself a link: neither is this fleet's.
  const elsewhere = path.join(home, '..', `${path.basename(home)}-elsewhere`);
  await mkdir(elsewhere, { recursive: true });
  await writeFile(path.join(elsewhere, 'whitelist.json'), JSON.stringify({ version: 1, scopes: [] }));
  await symlink(elsewhere, path.join(agents, 'linked-dir'));
  await mkdir(path.join(agents, 'linked-file'), { recursive: true });
  await symlink(path.join(elsewhere, 'whitelist.json'), path.join(agents, 'linked-file', 'whitelist.json'));

  assert.deepEqual(await store.owners?.(), ['ava', 'old-timer', 'zed']);
});

test('owners is empty before any agent has a directory, and refuses a linked agents directory', async () => {
  const { home, agents } = await freshHome();
  assert.deepEqual(await createFileCommandWhitelist({ directory: agents, stateHome: home }).owners?.(), []);

  const real = await mkdtemp(path.join(os.tmpdir(), 'stratus-owners-real-'));
  await mkdir(path.join(real, 'ava'), { recursive: true });
  await writeFile(path.join(real, 'ava', 'whitelist.json'), JSON.stringify({ version: 1, scopes: [] }));
  await symlink(real, agents);
  await assert.rejects(createFileCommandWhitelist({ directory: agents, stateHome: home }).owners?.() ?? Promise.resolve());
});

test('a grant file owners cannot inspect fails the listing rather than leaving that agent out', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root reads through permissions');
    return;
  }
  const { home, agents } = await freshHome();
  const store = createFileCommandWhitelist({ directory: agents, stateHome: home });
  await store.rememberTool('ava', { tool: 'demo.echo', grantedAt: '2026-11-24T00:00:00.000Z' });
  await store.rememberTool('ben', { tool: 'demo.echo', grantedAt: '2026-11-24T00:00:00.000Z' });
  // Listed by the parent, but nothing inside it can be looked at.
  await chmod(path.join(agents, 'ben'), 0o000);
  try {
    await assert.rejects(store.owners?.() ?? Promise.resolve(), /EACCES|EPERM/);
  } finally {
    await chmod(path.join(agents, 'ben'), 0o700);
  }
});
