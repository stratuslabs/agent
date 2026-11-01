import test from 'node:test';
import assert from 'node:assert/strict';

import type { ApprovalContext, JsonObject, Session, Tool } from '@stratusagent/core';
import { createPermissionPolicy, type PermissionDecision } from '@stratusagent/permissions';

import { refusalLogLine } from '../src/commands/serve.ts';

const shell: Tool = {
  name: 'shell.run',
  risk: 'gated',
  commandFor: (input: JsonObject) => (typeof input.command === 'string' ? input.command : undefined),
  async execute() { return null; },
};

const context = (command: string): ApprovalContext => ({
  session: { id: 'sess-1', agent: { id: 'ava', name: 'Ava' }, status: 'running', messages: [] } as unknown as Session,
  call: { id: 'call-1', toolName: 'shell.run', input: { command } },
  tool: shell,
  risk: 'gated',
});

test('a headless refusal is logged with the layer that refused it first', async () => {
  const decisions: PermissionDecision[] = [];
  const policy = createPermissionPolicy({ mode: 'headless', commands: {}, onDecision: (decision) => decisions.push(decision) });

  // The refusal carries the logged reason, which is what the agent is told.
  assert.deepEqual(await policy.approve(context('git push')), { allowed: false, reason: decisions[0]?.reason ?? 'not logged yet' });
  assert.equal(
    refusalLogLine(decisions[0]!),
    'ava: [scope] shell.run was called outside every approved scope (git) and nobody is available to approve it (session sess-1)',
  );
  assert.equal((await policy.approve(context('echo "unterminated'))) === true, false);
  assert.match(refusalLogLine(decisions[1]!), /^ava: \[parse\] shell\.run cannot run unattended: /);
});

test('a decision without a layer logs exactly as before', () => {
  const { layer: _layer, ...older } = {
    allowed: false,
    mode: 'headless',
    risk: 'gated',
    toolName: 'notes.write',
    sessionId: 'sess-1',
    agentId: 'ava',
    reason: 'notes.write is gated and nobody is available to approve it',
    layer: 'grant',
  } as PermissionDecision;
  assert.equal(refusalLogLine(older), 'ava: notes.write is gated and nobody is available to approve it (session sess-1)');
});
