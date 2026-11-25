import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createFileCommandWhitelist, type AgentGrantStore } from '@stratusagent/permissions';

import { newHome, startApi } from './harness.ts';

// `GET /grants`: whose grants exist, so an operator can find the ones that
// outlived their agent.

const json = async <T>(response: Response): Promise<T> => response.json() as Promise<T>;

test('GET /grants lists every agent with a grant file, on the roster or not, and nothing that is not one', async () => {
  const home = await newHome();
  const agents = path.join(home, '.stratus', 'agents');
  const store = createFileCommandWhitelist({ directory: agents, stateHome: path.join(home, '.stratus') });
  await store.rememberTool('stratus', { tool: 'demo.echo', grantedAt: '2026-11-24T00:00:00.000Z' });
  // An agent whose soul is gone: no soul file, its grants still on disk.
  await store.rememberOrigin('retired', { origin: 'https://app.example.com' });
  // Not grants: a state directory with none, a link standing in for one,
  // and a name no agent id can have.
  await mkdir(path.join(agents, 'no-grants'), { recursive: true });
  const elsewhere = path.join(home, 'elsewhere');
  await mkdir(elsewhere, { recursive: true });
  await writeFile(path.join(elsewhere, 'whitelist.json'), JSON.stringify({ version: 1, scopes: [] }));
  await symlink(elsewhere, path.join(agents, 'linked'));
  await mkdir(path.join(agents, '.hidden'), { recursive: true });
  await writeFile(path.join(agents, '.hidden', 'whitelist.json'), JSON.stringify({ version: 1, scopes: [] }));

  const harness = await startApi({ home, options: { grants: store } });
  try {
    const listed = await harness.call('/api/v1/grants');
    assert.equal(listed.status, 200);
    assert.deepEqual(await json(listed), { agents: ['retired', 'stratus'] });
    // And each one answers for its grants, off the roster as well.
    const retired = await json<{ origins: Array<{ origin: string }> }>(await harness.call('/api/v1/agents/retired/grants'));
    assert.deepEqual(retired.origins.map((origin) => origin.origin), ['https://app.example.com']);
  } finally {
    await harness.stop();
  }
});

test('a grant store that cannot list owners says so, rather than reporting nobody', async () => {
  const home = await newHome();
  const full = createFileCommandWhitelist({ directory: path.join(home, '.stratus', 'agents'), stateHome: path.join(home, '.stratus') });
  const { owners: _omitted, ...withoutOwners } = full;
  const harness = await startApi({ home, options: { grants: withoutOwners as AgentGrantStore } });
  try {
    const listed = await harness.call('/api/v1/grants');
    assert.equal(listed.status, 501);
    assert.equal((await json<{ error: { code: string } }>(listed)).error.code, 'grant_owners_unavailable');
  } finally {
    await harness.stop();
  }
  const none = await startApi();
  try {
    assert.equal((await none.call('/api/v1/grants')).status, 501);
  } finally {
    await none.stop();
  }
});
