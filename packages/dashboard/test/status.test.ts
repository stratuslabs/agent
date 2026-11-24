import test from 'node:test';
import assert from 'node:assert/strict';

import { agentStatus, statusLine } from '../ui/lib/status.js';

const ava = { id: 'ava', name: 'Ava', runsOn: { provider: 'anthropic', model: 'claude' }, activeSessions: 0 };

test('an agent with nothing running and nothing waiting is idle', () => {
  assert.deepEqual(agentStatus(ava), { kind: 'idle', label: 'Idle' });
});

test('a running turn makes an agent working', () => {
  assert.equal(agentStatus({ ...ava, activeSessions: 2 }).kind, 'working');
});

test('an approval waiting on the agent outranks a running turn', () => {
  const status = agentStatus({ ...ava, activeSessions: 1 }, { approvals: [{ agentId: 'ava' }] });
  assert.deepEqual(status, { kind: 'needs', label: 'Needs you' });
});

test("someone else's approval does not change this agent", () => {
  assert.equal(agentStatus(ava, { approvals: [{ agentId: 'ben' }] }).kind, 'idle');
});

test('an agent with no provider it can reach says so, with the reason', () => {
  const runtimes = [{ provider: 'none', credentials: 'none', problem: 'No provider is configured. Run stratus setup.' }];
  const status = agentStatus({ id: 'cleo', name: 'Cleo', runsOn: { provider: 'none' }, activeSessions: 0 }, { runtimes });
  assert.deepEqual(status, { kind: 'provider', label: "Can't reach provider", detail: 'No provider is configured. Run stratus setup.' });
});

test('a provider problem does not touch an agent that runs on a provider', () => {
  const runtimes = [{ provider: 'none', credentials: 'none', problem: 'No provider is configured.' }];
  assert.equal(agentStatus(ava, { runtimes }).kind, 'idle');
});

test('an agent whose runtime the daemon cannot say is not called provider-less', () => {
  // `/agents` leaves runsOn out when the soul file became unreadable while
  // the daemon keeps serving its cached soul, which may pin a provider.
  const runtimes = [{ provider: 'none', credentials: 'none', problem: 'No provider is configured.' }];
  assert.equal(agentStatus({ id: 'cleo', name: 'Cleo', activeSessions: 0 }, { runtimes }).kind, 'idle');
});

test('an approval still outranks a provider problem', () => {
  const runtimes = [{ provider: 'none', credentials: 'none', problem: 'No provider.' }];
  const status = agentStatus({ id: 'cleo', name: 'Cleo', runsOn: { provider: 'none' } }, { runtimes, approvals: [{ agentId: 'cleo' }] });
  assert.equal(status.kind, 'needs');
});

test('the status line counts working agents and what waits on you', () => {
  const agents = [ava, { ...ava, id: 'ben', activeSessions: 1 }, { ...ava, id: 'cleo' }];
  assert.equal(statusLine(agents, { approvals: [] }), '1 of 3 agents working');
  assert.equal(statusLine(agents, { approvals: [{ agentId: 'cleo' }, { agentId: 'cleo' }] }), '1 of 3 agents working · 2 need you');
  assert.equal(statusLine(agents, { approvals: [{ agentId: 'cleo' }] }), '1 of 3 agents working · 1 needs you');
  assert.equal(statusLine([ava], {}), '1 agent · nothing running');
});
