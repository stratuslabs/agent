import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { FleetReader, FleetSession, PluginContext } from '@stratusagent/core';
import type { ScheduleRecord } from '@stratusagent/agents';
import type { OptionalModuleHost } from '@stratusagent/plugins';

import { createFleetReader } from '../src/fleet.ts';
import { createGateway, type PendingApproval } from '../src/index.ts';

// Roadmap 26: the read-only fleet seam a fleet-report plugin runs on. What
// is under test is that metadata crosses it and content never does.

const schedule = (overrides: Partial<ScheduleRecord> = {}): ScheduleRecord => ({
  id: 'sch-1',
  agentId: 'ava',
  cadence: { kind: 'every', intervalMs: 7_200_000 },
  prompt: 'SECRET-PROMPT read the board',
  destination: { channel: 'Slack', to: 'C0123', thread: '1792.1' },
  createdAt: '2026-10-20T00:00:00.000Z',
  createdBy: 'session-x',
  trust: 'user',
  nextFireAt: '2026-10-23T22:00:00.000Z',
  lastFiredAt: '2026-10-23T20:00:00.000Z',
  lastSessionId: 'schedule:sch-1:1',
  ...overrides,
});

const parked: PendingApproval = {
  requestId: 'req-1',
  sessionId: 's-2',
  agentId: 'ava',
  call: { id: 'call-1', toolName: 'shell.run', input: { command: 'SECRET-INPUT' } },
  risk: 'gated',
  origin: 'https://example.com',
  parkedAt: '2026-10-23T20:01:00.000Z',
  expiresAt: '2026-10-23T21:01:00.000Z',
  metadata: { channel: 'slack', text: 'SECRET-METADATA' },
};

const fakeReader = (reads: string[] = []): FleetReader => createFleetReader({
  agents: () => [
    { id: 'ava', name: 'Ava', instructions: 'SECRET-PERSONA' },
    { id: 'ben', name: 'Ben', instructions: 'SECRET-PERSONA' },
  ],
  store: {
    list: (agentId, limit) => ([
      { id: 's-2', agentId: 'ava', status: 'pending_approval', createdAt: '2026-10-23T20:00:00.000Z', updatedAt: '2026-10-23T20:01:00.000Z' },
      { id: 's-1', agentId: agentId ?? 'ava', status: 'completed', createdAt: '2026-10-23T19:00:00.000Z', updatedAt: '2026-10-23T19:05:00.000Z' },
    ] satisfies FleetSession[]).slice(0, limit ?? 2),
    countByStatus: () => ({ completed: 1, pending_approval: 1 }),
    lastActivityByAgent: () => ({ ava: { lastActiveAt: '2026-10-23T20:01:00.000Z', activeSessions: 1 } }),
    statusOf: (id) => (id === 'schedule:sch-1:1' ? 'failed' : undefined),
  },
  schedules: () => [schedule(), schedule({ id: 'sch-2', lastSessionId: 'gone' }), (({ destination: _d, lastSessionId: _l, ...rest }) => rest)(schedule({ id: 'sch-3' }))],
  pendingApprovals: () => [parked],
  onRead: (method) => reads.push(method),
});

test('agents reports the roster with activity, never a persona', async () => {
  assert.deepEqual(await fakeReader().agents(), [
    { id: 'ava', name: 'Ava', lastActiveAt: '2026-10-23T20:01:00.000Z', activeSessions: 1 },
    { id: 'ben', name: 'Ben', activeSessions: 0 },
  ]);
});

test('sessions and counts are the index rows, with the filter and limit passed through', async () => {
  const reader = fakeReader();
  assert.deepEqual(await reader.sessions({ agentId: 'ben', limit: 1 }), [
    { id: 's-2', agentId: 'ava', status: 'pending_approval', createdAt: '2026-10-23T20:00:00.000Z', updatedAt: '2026-10-23T20:01:00.000Z' },
  ]);
  assert.equal((await reader.sessions({ agentId: 'ben' }))[1]?.agentId, 'ben');
  assert.deepEqual(await reader.countByStatus(), { completed: 1, pending_approval: 1 });
});

test('schedules carry their last firing status and never their prompt', async () => {
  const rows = await fakeReader().schedules();
  assert.deepEqual(rows, [
    {
      id: 'sch-1',
      agentId: 'ava',
      cadence: 'every 2h',
      destination: 'slack:C0123',
      createdAt: '2026-10-20T00:00:00.000Z',
      nextFireAt: '2026-10-23T22:00:00.000Z',
      lastFiredAt: '2026-10-23T20:00:00.000Z',
      lastSessionStatus: 'failed',
    },
    {
      id: 'sch-2',
      agentId: 'ava',
      cadence: 'every 2h',
      destination: 'slack:C0123',
      createdAt: '2026-10-20T00:00:00.000Z',
      nextFireAt: '2026-10-23T22:00:00.000Z',
      lastFiredAt: '2026-10-23T20:00:00.000Z',
    },
    {
      id: 'sch-3',
      agentId: 'ava',
      cadence: 'every 2h',
      createdAt: '2026-10-20T00:00:00.000Z',
      nextFireAt: '2026-10-23T22:00:00.000Z',
      lastFiredAt: '2026-10-23T20:00:00.000Z',
    },
  ]);
  assert.doesNotMatch(JSON.stringify(rows), /SECRET/);
});

test('pending approvals name the tool and never carry its input or the session metadata', async () => {
  const rows = await fakeReader().pendingApprovals();
  assert.deepEqual(rows, [{
    requestId: 'req-1',
    agentId: 'ava',
    sessionId: 's-2',
    toolName: 'shell.run',
    risk: 'gated',
    parkedAt: '2026-10-23T20:01:00.000Z',
    expiresAt: '2026-10-23T21:01:00.000Z',
  }]);
  assert.doesNotMatch(JSON.stringify(rows), /SECRET/);
});

test('every read is reported to the host, by method', async () => {
  const reads: string[] = [];
  const reader = fakeReader(reads);
  await reader.agents();
  await reader.sessions();
  await reader.countByStatus();
  await reader.schedules();
  await reader.pendingApprovals();
  assert.deepEqual(reads, ['agents', 'sessions', 'countByStatus', 'schedules', 'pendingApprovals']);
});

test('the daemon hands each plugin a fleet reader over its own store, and logs who read', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-gw-fleet-'));
  await mkdir(path.join(home, '.stratus', 'agents'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'agents', 'ava.md'), ['---', 'id: ava', 'name: Ava', 'provider: demo', '---', '', 'You are Ava.', ''].join('\n'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-gw-fleet-pkgs-'));
  const directory = path.join(root, 'fleet');
  await mkdir(path.join(directory, 'dist'), { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({
    name: 'stratus-plugin-fleettest',
    stratus: { pluginVersion: 1, contributes: { tools: [{ name: 'fleettest.read', risk: 'safe' }] } },
  }));
  let fleet: FleetReader | undefined;
  const module = {
    createPlugin: () => ({
      name: 'fleettest',
      setup(context: PluginContext) {
        fleet = context.fleet;
        context.tools.register({ name: 'fleettest.read', risk: 'safe', async execute() { return 'ok'; } });
      },
    }),
  };
  const host: OptionalModuleHost = {
    resolve(specifier) {
      if (specifier !== 'stratus-plugin-fleettest') {
        throw new Error(`Cannot find package '${specifier}'`);
      }
      return pathToFileURL(path.join(directory, 'dist', 'index.js')).href;
    },
    async import() {
      return module;
    },
  };
  const logged: string[] = [];
  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: {} },
    idleTimeoutMs: 0,
    plugins: { 'stratus-plugin-fleettest': { enabled: true } },
    pluginHost: host,
    log: (line) => logged.push(line),
    warn: () => undefined,
  });
  await gateway.start();
  try {
    assert.ok(fleet, 'the daemon gave the plugin no fleet reader');
    await gateway.dispatch({ sessionId: 'fleet-1', agentId: 'ava', userMessage: 'hello' });
    const sessions = await fleet.sessions({ agentId: 'ava' });
    assert.deepEqual(sessions.map((row) => [row.id, row.agentId, row.status]), [['fleet-1', 'ava', 'completed']]);
    assert.deepEqual(Object.keys(sessions[0]!).sort(), ['agentId', 'createdAt', 'id', 'status', 'updatedAt']);
    const ava = (await fleet.agents()).find((agent) => agent.id === 'ava');
    assert.equal(ava?.activeSessions, 0);
    assert.equal(ava?.lastActiveAt, sessions[0]!.updatedAt);
    assert.deepEqual(await fleet.countByStatus(), gateway.store.countByStatus());
    assert.ok(
      logged.includes('fleet read: sessions by plugin stratus-plugin-fleettest'),
      `no read line in ${JSON.stringify(logged.filter((line) => line.startsWith('fleet')))}`,
    );
  } finally {
    await gateway.stop();
  }
});
