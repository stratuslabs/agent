import test from 'node:test';
import assert from 'node:assert/strict';

import type { ApprovalContext, JsonObject, Session, Tool } from '@stratusagent/core';
import { createPermissionPolicy, type PermissionDecision } from '@stratusagent/permissions';

import { decisionLogLine, refusalLogLine } from '../src/commands/serve.ts';

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

test('review decisions log their verdict and code; shadow ones are marked and never logged as refusals', () => {
  const base = { mode: 'headless', risk: 'gated', toolName: 'notes.add', sessionId: 'sess-1', agentId: 'ava' } as const;
  const blocked: PermissionDecision = { ...base, allowed: false, layer: 'review', verdict: 'block', reviewCode: 'not-asked-for', reason: 'notes.add was blocked by the reviewer (not-asked-for)' };
  assert.deepEqual(decisionLogLine(blocked), {
    level: 'warn',
    line: 'ava: [review] notes.add was blocked by the reviewer (not-asked-for) verdict=block code=not-asked-for (session sess-1)',
  });
  const allowed: PermissionDecision = { ...base, allowed: true, layer: 'review', verdict: 'allow', reviewCode: 'asked-for', reason: 'notes.add was allowed by the reviewer (asked-for)' };
  assert.deepEqual(decisionLogLine(allowed), {
    level: 'log',
    line: 'ava: [review] notes.add was allowed by the reviewer (asked-for) verdict=allow code=asked-for (session sess-1)',
  });
  const shadow: PermissionDecision = { ...blocked, shadow: true };
  assert.deepEqual(decisionLogLine(shadow), {
    level: 'log',
    line: 'ava: shadow [review] notes.add was blocked by the reviewer (not-asked-for) verdict=block code=not-asked-for (session sess-1)',
  });
  const unreviewed: PermissionDecision = { ...base, allowed: true, layer: 'risk', shadow: true, reason: 'notes.add not reviewed: this conversation has read nothing from outside' };
  assert.equal(decisionLogLine(unreviewed)?.line, 'ava: shadow [risk] notes.add not reviewed: this conversation has read nothing from outside (session sess-1)');
  // An ordinary allowed call still logs nothing.
  assert.equal(decisionLogLine({ ...base, allowed: true, layer: 'risk', reason: 'notes.add runs without asking (approvals.posture is open)' }), undefined);
});
