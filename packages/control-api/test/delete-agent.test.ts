import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createFileCommandWhitelist } from '@stratusagent/permissions';
import { createHomeMemoryStore, fleetDbPath } from '@stratusagent/state';

import { newHome, startApi, writeSoul } from './harness.ts';

// `DELETE /agents/:id`: the agent leaves the roster, its soul moves aside,
// its schedules and grants go, and its conversations and memory stay.

const json = async <T>(response: Response): Promise<T> => response.json() as Promise<T>;

const AVA = '---\nname: Ava\nid: ava\n---\n\nYou are Ava.\n';

const scheduleFor = async (home: string, id: string, agentId: string): Promise<void> => {
  const { SqliteScheduleStore } = await import('@stratusagent/gateway');
  const store = new SqliteScheduleStore(fleetDbPath({ homeDir: home }));
  store.insert({
    id,
    agentId,
    cadence: { kind: 'every', intervalMs: 3_600_000 },
    prompt: 'check the repo and report',
    createdAt: new Date().toISOString(),
    nextFireAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  store.close();
};

test('DELETE /agents/:id moves the soul aside, cancels its schedules and grants, and keeps its memory', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', AVA);
  const agents = path.join(home, '.stratus', 'agents');
  const grants = createFileCommandWhitelist({ directory: agents, stateHome: path.join(home, '.stratus') });
  await grants.rememberTool('ava', { tool: 'demo.echo', grantedAt: '2026-11-24T00:00:00.000Z' });
  await grants.rememberOrigin('ava', { origin: 'https://app.example.com' });
  await createHomeMemoryStore({ homeDir: home }).append('ava', 'Ava remembers this.');

  const harness = await startApi({ home, options: { grants } });
  try {
    await scheduleFor(home, 'sched-ava', 'ava');
    await scheduleFor(home, 'sched-stratus', 'stratus');

    const removed = await harness.call('/api/v1/agents/ava', { method: 'DELETE' });
    assert.equal(removed.status, 200);
    const body = await json<{ agentId: string; soulMovedTo: string; schedulesCancelled: string[]; grantsRevoked: number }>(removed);
    assert.equal(body.agentId, 'ava');
    assert.deepEqual(body.schedulesCancelled, ['sched-ava']);
    assert.equal(body.grantsRevoked, 2);

    // Off the roster at once, and nothing dispatches to it.
    const roster = await json<{ agents: Array<{ id: string }> }>(await harness.call('/api/v1/agents'));
    assert.ok(!roster.agents.some((agent) => agent.id === 'ava'));
    const message = await harness.call('/api/v1/sessions/web%3Aava%3Ax/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello', agentId: 'ava' }),
    });
    assert.equal(message.status, 404);

    // The soul is moved, byte for byte, not deleted.
    assert.equal(path.dirname(body.soulMovedTo), path.join(home, '.stratus', 'removed-agents'));
    assert.equal(await readFile(body.soulMovedTo, 'utf8'), AVA);
    assert.ok(!(await readdir(agents)).includes('ava.md'));

    // Its schedule is gone, another agent's is not.
    const schedules = await json<{ schedules: Array<{ id: string }> }>(await harness.call('/api/v1/schedules'));
    assert.deepEqual(schedules.schedules.map((schedule) => schedule.id), ['sched-stratus']);
    // Its grants are revoked through the store, so the cache drops them too.
    const after = await json<{ tools: unknown[]; origins: unknown[] }>(await harness.call('/api/v1/agents/ava/grants'));
    assert.deepEqual([after.tools, after.origins], [[], []]);
    // Its memory stays, for whoever restores it.
    const memory = await createHomeMemoryStore({ homeDir: home }).list('ava');
    assert.equal(memory.entries.length, 1);
  } finally {
    await harness.stop();
  }
});

test('a soul linked into the agents folder moves out of it, its workspace stays, and a soul linked from elsewhere only loses its link', async () => {
  const home = await newHome();
  const agentsFolder = path.join(home, 'Agents');
  const agents = path.join(home, '.stratus', 'agents');
  await mkdir(path.join(agentsFolder, 'ava', 'workspace'), { recursive: true });
  await writeFile(path.join(agentsFolder, '.stratus-agents'), 'This folder is managed by Stratus.\n');
  await writeFile(path.join(agentsFolder, 'ava', 'soul.md'), AVA);
  await writeFile(path.join(agentsFolder, 'ava', 'workspace', 'notes.txt'), 'kept');
  await mkdir(agents, { recursive: true });
  await symlink(path.join(agentsFolder, 'ava', 'soul.md'), path.join(agents, 'ava.md'));
  // A soul the operator keeps in their own checkout.
  const dotfiles = path.join(home, 'dotfiles');
  await mkdir(dotfiles, { recursive: true });
  await writeFile(path.join(dotfiles, 'ben.md'), '---\nname: Ben\nid: ben\n---\n\nYou are Ben.\n');
  await symlink(path.join(dotfiles, 'ben.md'), path.join(agents, 'ben.md'));

  const harness = await startApi({ home, env: { processEnv: { STRATUS_PROVIDER: 'demo', STRATUS_AGENTS_DIR: agentsFolder } } });
  try {
    const ava = await json<{ soulMovedTo: string }>(await harness.call('/api/v1/agents/ava', { method: 'DELETE' }));
    assert.equal(await readFile(ava.soulMovedTo, 'utf8'), AVA);
    assert.equal((await lstat(ava.soulMovedTo)).isFile(), true, 'the soul itself moved, not a link to it');
    assert.ok(!(await readdir(path.join(agentsFolder, 'ava'))).includes('soul.md'));
    assert.equal(await readFile(path.join(agentsFolder, 'ava', 'workspace', 'notes.txt'), 'utf8'), 'kept');

    // A folder that held only the soul goes with it.
    await mkdir(path.join(agentsFolder, 'cleo'), { recursive: true });
    await writeFile(path.join(agentsFolder, 'cleo', 'soul.md'), '---\nname: Cleo\nid: cleo\n---\n\nYou are Cleo.\n');
    await symlink(path.join(agentsFolder, 'cleo', 'soul.md'), path.join(agents, 'cleo.md'));
    await harness.call('/api/v1/roster/reload', { method: 'POST' });
    assert.equal((await harness.call('/api/v1/agents/cleo', { method: 'DELETE' })).status, 200);
    assert.ok(!(await readdir(agentsFolder)).includes('cleo'));

    const ben = await json<{ soulMovedTo: string }>(await harness.call('/api/v1/agents/ben', { method: 'DELETE' }));
    assert.equal((await lstat(ben.soulMovedTo)).isSymbolicLink(), true, 'only the link moved');
    assert.ok((await readFile(path.join(dotfiles, 'ben.md'), 'utf8')).includes('You are Ben.'), "the operator's file is untouched");
    const roster = await json<{ agents: Array<{ id: string }> }>(await harness.call('/api/v1/agents'));
    assert.deepEqual(roster.agents.map((agent) => agent.id), ['stratus']);
  } finally {
    await harness.stop();
  }
});

test('the built-in agent, an unknown one and a busy one are refused, and nothing moves', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', AVA);
  const harness = await startApi({ home });
  try {
    const builtIn = await harness.call('/api/v1/agents/stratus', { method: 'DELETE' });
    assert.equal(builtIn.status, 409);
    assert.equal((await json<{ error: { code: string } }>(builtIn)).error.code, 'agent_not_removable');
    assert.equal((await harness.call('/api/v1/agents/nobody', { method: 'DELETE' })).status, 404);

    // A conversation parked on an approval is somebody waiting.
    await harness.gateway.store.create({ id: 'web:ava:waiting', agent: { id: 'ava', name: 'Ava' }, status: 'pending_approval', messages: [] } as never);
    const busy = await harness.call('/api/v1/agents/ava', { method: 'DELETE' });
    assert.equal(busy.status, 409);
    assert.equal((await json<{ error: { code: string } }>(busy)).error.code, 'agent_busy');
    assert.ok((await readdir(path.join(home, '.stratus', 'agents'))).includes('ava.md'), 'the soul is where it was');
  } finally {
    await harness.stop();
  }
});

test('an agent with a very long id is archived under a name that still fits', async () => {
  const home = await newHome();
  const longId = 'a'.repeat(230);
  await writeSoul(home, 'long.md', `---\nname: Long\nid: ${longId}\n---\n\nA long id.\n`);
  const harness = await startApi({ home });
  try {
    const removed = await harness.call(`/api/v1/agents/${longId}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    const { soulMovedTo } = await json<{ soulMovedTo: string }>(removed);
    assert.ok(Buffer.byteLength(path.basename(soulMovedTo)) < 200, path.basename(soulMovedTo));
    assert.match(path.basename(soulMovedTo), /^a{100}-[0-9a-f]{12}-/);
    assert.ok((await readFile(soulMovedTo, 'utf8')).includes('A long id.'));
  } finally {
    await harness.stop();
  }
});

test('a new agent can claim a deleted id only once the old one is cleaned up, and starts without its grants', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', AVA);
  const agents = path.join(home, '.stratus', 'agents');
  const grants = createFileCommandWhitelist({ directory: agents, stateHome: path.join(home, '.stratus') });
  await grants.rememberTool('ava', { tool: 'demo.echo', grantedAt: '2026-11-24T00:00:00.000Z' });
  // Holds the delete inside its grant cleanup, the slowest step, once.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  let block = true;
  const held = new Proxy(grants, {
    get(target, key) {
      const value = Reflect.get(target, key) as unknown;
      if (key === 'grantsFor' && block) {
        return async (agentId: string) => {
          block = false;
          entered();
          await gate;
          return target.grantsFor(agentId);
        };
      }
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });

  const harness = await startApi({ home, options: { grants: held } });
  try {
    await scheduleFor(home, 'sched-ava', 'ava');
    const deleting = harness.call('/api/v1/agents/ava', { method: 'DELETE' });
    await reached;
    const creating = harness.call('/api/v1/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ava', instructions: 'You are the new Ava.' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    // The id isn't free while the old Ava's schedules and grants are still
    // being taken back: a new soul now would be the one they were taken from.
    assert.ok(!(await readdir(agents)).includes('ava.md'), 'no new soul under the id mid-delete');
    release();
    const [removed, created] = await Promise.all([deleting, creating]);
    assert.equal(removed.status, 200);
    assert.deepEqual((await json<{ schedulesCancelled: string[] }>(removed)).schedulesCancelled, ['sched-ava']);
    assert.equal(created.status, 201);
    assert.equal((await json<{ agent: { id: string } }>(created)).agent.id, 'ava');

    // The new Ava is on the roster, and asks for what the old one had.
    const roster = await json<{ agents: Array<{ id: string }> }>(await harness.call('/api/v1/agents'));
    assert.ok(roster.agents.some((agent) => agent.id === 'ava'));
    const after = await json<{ tools: unknown[] }>(await harness.call('/api/v1/agents/ava/grants'));
    assert.deepEqual(after.tools, []);
  } finally {
    release();
    await harness.stop();
  }
});

test('a delete whose grants could not be revoked still answers, and says so', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', AVA);
  const agents = path.join(home, '.stratus', 'agents');
  const grants = createFileCommandWhitelist({ directory: agents, stateHome: path.join(home, '.stratus') });
  await grants.rememberTool('ava', { tool: 'demo.echo', grantedAt: '2026-11-24T00:00:00.000Z' });
  const { WhitelistUnreadableError } = await import('@stratusagent/permissions');
  // The file went bad after the daemon read it: the revoke's write is refused.
  const refusing = new Proxy(grants, {
    get(target, key) {
      if (key === 'forgetTool') {
        return async () => { throw new WhitelistUnreadableError(path.join(agents, 'ava', 'whitelist.json'), 'Unexpected token'); };
      }
      const value = Reflect.get(target, key) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  const harness = await startApi({ home, options: { grants: refusing } });
  try {
    const removed = await harness.call('/api/v1/agents/ava', { method: 'DELETE' });
    assert.equal(removed.status, 200);
    const body = await json<{ grantsRevoked?: number; grantsNote?: string }>(removed);
    assert.equal(body.grantsRevoked, undefined);
    assert.match(body.grantsNote ?? '', /could not be read/);
    // The soul still moved and the roster still reloaded.
    const roster = await json<{ agents: Array<{ id: string }> }>(await harness.call('/api/v1/agents'));
    assert.ok(!roster.agents.some((agent) => agent.id === 'ava'));
  } finally {
    await harness.stop();
  }
});
