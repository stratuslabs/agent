import test from 'node:test';
import assert from 'node:assert/strict';

import type { ApprovalContext, Session, Tool, ToolRisk } from '@stratusagent/core';
import { createPermissionPolicy, type PermissionDecision } from '../src/index.ts';

const sessionWith = (metadata?: Session['metadata']): Session => {
  const now = new Date().toISOString();
  return {
    id: 'schedule:sched-1:2026-08-29T07:00:00.000Z',
    agent: { id: 'ava', name: 'Ava' },
    status: 'running',
    messages: [],
    createdAt: now,
    updatedAt: now,
    ...(metadata ? { metadata } : {}),
  };
};

const sendTool = (risk: ToolRisk = 'gated'): Tool => ({
  name: 'message.send',
  risk,
  destinationFor(input) {
    const destination = input.destination;
    return typeof destination === 'string' ? destination : undefined;
  },
  async execute() {
    return null;
  },
});

const contextFor = (tool: Tool, destination: string, risk?: ToolRisk): ApprovalContext => ({
  session: sessionWith({ scheduled: true, scheduleId: 'sched-1' }),
  call: { id: 'call-1', toolName: tool.name, input: { destination, text: 'report' } },
  tool,
  risk: risk ?? tool.risk ?? 'gated',
});

test('headless allows a gated send to a pre-authorized destination — the schedule carve-out', async () => {
  const decisions: PermissionDecision[] = [];
  const policy = createPermissionPolicy({
    mode: 'headless',
    onDecision: (decision) => decisions.push(decision),
    destinations: {
      isPreauthorized: (session, destination) =>
        session.metadata?.scheduleId === 'sched-1' && destination === 'slack:C-ENG',
    },
  });

  const tool = sendTool();
  assert.equal(await policy.approve(contextFor(tool, 'slack:C-ENG')), true);
  assert.equal(decisions[0]?.allowed, true);
  assert.equal(decisions[0]?.destination, 'slack:C-ENG');
  assert.match(decisions[0]?.reason ?? '', /pre-authorized/);
});

test('headless still refuses a send anywhere the schedule did not declare', async () => {
  const policy = createPermissionPolicy({
    mode: 'headless',
    destinations: { isPreauthorized: (_session, destination) => destination === 'slack:C-ENG' },
  });
  assert.equal(await policy.approve(contextFor(sendTool(), 'slack:C-OTHER')), false);
});

test('without the destinations option every gated send needs a human, exactly as before', async () => {
  const policy = createPermissionPolicy({ mode: 'headless' });
  assert.equal(await policy.approve(contextFor(sendTool(), 'slack:C-ENG')), false);
});

test('a destination cannot launder a dangerous call', async () => {
  let consulted = false;
  const policy = createPermissionPolicy({
    mode: 'headless',
    destinations: {
      isPreauthorized: () => {
        consulted = true;
        return true;
      },
    },
  });
  const tool = sendTool('dangerous');
  assert.equal(await policy.approve(contextFor(tool, 'slack:C-ENG', 'dangerous')), false);
  assert.equal(consulted, false, 'the carve-out must not even be asked about a dangerous call');
});

test('the carve-out check may be async, and is consulted per call', async () => {
  let allowed = true;
  const policy = createPermissionPolicy({
    mode: 'headless',
    destinations: { isPreauthorized: async () => allowed },
  });
  const tool = sendTool();
  assert.equal(await policy.approve(contextFor(tool, 'slack:C-ENG')), true);
  // The schedule was cancelled between two sends: the very next call gates.
  allowed = false;
  assert.equal(await policy.approve(contextFor(tool, 'slack:C-ENG')), false);
});
