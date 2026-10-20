import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_TAINTED_BY_METADATA_KEY,
  SESSION_TRUST_METADATA_KEY,
  type ApprovalContext,
  type JsonObject,
  type Session,
  type Tool,
  type ToolRisk,
} from '@stratusagent/core';

import { createPermissionPolicy, type PermissionDecision } from '../src/index.ts';

const sessionFor = (agentId: string, external = false): Session => {
  const now = new Date().toISOString();
  return {
    id: `session-${agentId}`,
    agent: { id: agentId, name: agentId },
    status: 'running',
    messages: [],
    createdAt: now,
    updatedAt: now,
    ...(external ? { metadata: { [SESSION_TRUST_METADATA_KEY]: 'external', [SESSION_TAINTED_BY_METADATA_KEY]: 'web.fetch' } } : {}),
  };
};

const toolAt = (name: string, risk: ToolRisk, extra: Partial<Tool> = {}): Tool => ({
  name,
  risk,
  async execute() {
    return null;
  },
  ...extra,
});

const contextFor = (tool: Tool, session: Session, input: JsonObject = {}): ApprovalContext => ({
  call: { id: `call-${tool.name}`, toolName: tool.name, input },
  tool,
  risk: tool.risk ?? 'gated',
  session,
});

const shell = toolAt('shell.run', 'gated', { commandFor: (input) => (typeof input.command === 'string' ? input.command : undefined) });
const send = toolAt('message.send', 'gated', { destinationFor: (input) => (typeof input.destination === 'string' ? input.destination : undefined) });
const schedule = toolAt('schedule.every', 'gated');
const fetch = toolAt('web.fetch', 'gated', { originFor: () => 'https://example.com' });
const wipe = toolAt('ops.wipe', 'dangerous');

test('under the open posture a gated call runs unasked, headless and scope-less alike', async () => {
  const decisions: PermissionDecision[] = [];
  const policy = createPermissionPolicy({ mode: 'headless', openFor: () => true, onDecision: (d) => decisions.push(d) });
  const ava = sessionFor('ava');
  assert.equal(await policy.approve(contextFor(shell, ava, { command: 'rm -rf build && npm install' })), true);
  assert.equal(await policy.approve(contextFor(send, ava, { destination: 'slack:C0123' })), true);
  assert.equal(await policy.approve(contextFor(schedule, ava)), true);
  assert.equal(await policy.approve(contextFor(fetch, ava, { url: 'https://example.com' })), true);
  assert.ok(decisions.every((d) => d.allowed && /approvals\.posture is open/.test(d.reason)));
});

test('the open posture asks a person for a remote call only when the tool is dangerous', async () => {
  const asked: string[] = [];
  const policy = createPermissionPolicy({
    mode: 'remote',
    openFor: () => true,
    request: async (request) => {
      asked.push(request.call.toolName);
      return 'deny';
    },
  });
  const ava = sessionFor('ava');
  assert.equal(await policy.approve(contextFor(shell, ava, { command: 'make' })), true);
  assert.equal(await policy.approve(contextFor(wipe, ava)), false);
  assert.deepEqual(asked, ['ops.wipe']);
});

test('a dangerous call is still refused headless under the open posture', async () => {
  const policy = createPermissionPolicy({ mode: 'headless', openFor: () => true });
  assert.equal(await policy.approve(contextFor(wipe, sessionFor('ava'))), false);
});

test('the posture is per agent: a guarded agent beside an open one still asks', async () => {
  const policy = createPermissionPolicy({ mode: 'headless', openFor: (agentId) => agentId === 'ava' });
  assert.equal(await policy.approve(contextFor(shell, sessionFor('ava'), { command: 'make' })), true);
  assert.equal(await policy.approve(contextFor(shell, sessionFor('bea'), { command: 'make' })), false);
});

test('with the external-content gate on, a conversation that read the web goes back to asking', async () => {
  const policy = createPermissionPolicy({ mode: 'headless', openFor: () => true, gateExternalContent: () => true });
  assert.equal(await policy.approve(contextFor(shell, sessionFor('ava', false), { command: 'make' })), true);
  assert.equal(await policy.approve(contextFor(shell, sessionFor('ava', true), { command: 'make' })), false);
  // Without the gate, reading the web changes nothing under the open posture.
  const ungated = createPermissionPolicy({ mode: 'headless', openFor: () => true });
  assert.equal(await ungated.approve(contextFor(shell, sessionFor('ava', true), { command: 'make' })), true);
});

test('no posture hook is the guarded behavior: a scope-less gated call is refused headless', async () => {
  const policy = createPermissionPolicy({ mode: 'headless' });
  assert.equal(await policy.approve(contextFor(schedule, sessionFor('ava'))), false);
});
