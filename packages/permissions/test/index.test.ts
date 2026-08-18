import test from 'node:test';
import assert from 'node:assert/strict';

import type { ApprovalContext, Session, Tool, ToolCall, ToolRisk } from '@stratusagent/core';

import { atLeastAsRisky, createPermissionPolicy, type PermissionDecision } from '../src/index.ts';

const session = (id = 'sess-1'): Session => ({
  id,
  agent: { id: 'ava', name: 'Ava', instructions: 'be useful' },
  status: 'running',
  messages: [],
  createdAt: '2026-08-18T00:00:00.000Z',
  updatedAt: '2026-08-18T00:00:00.000Z',
}) as unknown as Session;

const call = (toolName: string, id = 'call-1'): ToolCall => ({ id, toolName, input: {} });

const tool = (name: string, risk?: ToolRisk): Tool => ({
  name,
  ...(risk ? { risk } : {}),
  async execute() {
    return null;
  },
});

const context = (
  toolName: string,
  risk: ToolRisk,
  extra: Partial<ApprovalContext> = {},
): ApprovalContext => ({
  session: session(),
  call: call(toolName),
  tool: tool(toolName, risk),
  risk,
  ...extra,
});

test('safe calls run unattended and riskier ones do not', async () => {
  const decisions: PermissionDecision[] = [];
  const policy = createPermissionPolicy({
    mode: 'headless',
    onDecision: (decision) => decisions.push(decision),
  });

  assert.equal(await policy.approve(context('memory.remember', 'safe')), true);
  assert.equal(await policy.approve(context('shell.run', 'gated')), false);
  assert.equal(await policy.approve(context('fs.delete', 'dangerous')), false);

  // A refusal nobody can see is indistinguishable from an agent that chose
  // not to act, which is the whole reason the daemon logs these.
  assert.deepEqual(decisions.map((decision) => decision.allowed), [true, false, false]);
  assert.match(decisions[1]!.reason, /nobody is available to approve it/);
  assert.equal(decisions[2]!.risk, 'dangerous');
  assert.equal(decisions[1]!.agentId, 'ava');
});

test('an interactive prompt takes yes, always, and anything else as no', async () => {
  const answers = ['y', 'n', '', 'nope', 'YES'];
  const asked: string[] = [];
  const policy = createPermissionPolicy({
    mode: 'interactive',
    ask: async (question) => {
      asked.push(question);
      return answers.shift() ?? 'n';
    },
  });

  assert.equal(await policy.approve(context('shell.run', 'gated')), true);
  assert.equal(await policy.approve(context('shell.run', 'gated')), false);
  assert.equal(await policy.approve(context('shell.run', 'gated')), false, 'empty input is not consent');
  assert.equal(await policy.approve(context('shell.run', 'gated')), false);
  assert.equal(await policy.approve(context('shell.run', 'gated')), true, 'case does not change the answer');

  assert.equal(asked.length, 5, 'every gated call asked, since none said always');
  assert.match(asked[0]!, /Allow shell\.run \(gated\) for Ava\?/);
});

test('"always" lasts for the session that said it, and no longer', async () => {
  let asks = 0;
  const policy = createPermissionPolicy({
    mode: 'interactive',
    ask: async () => {
      asks += 1;
      return 'always';
    },
  });

  const first = context('shell.run', 'gated');
  assert.equal(await policy.approve(first), true);
  assert.equal(await policy.approve(context('shell.run', 'gated')), true);
  assert.equal(asks, 1, 'the second call in the same session did not ask again');

  // A different tool is a different question, even in the same session.
  assert.equal(await policy.approve(context('fs.write', 'gated')), true);
  assert.equal(asks, 2);

  // And another session starts over: one impatient yes must not become a
  // standing grant across conversations.
  const later = context('shell.run', 'gated', { session: session('sess-2') });
  assert.equal(await policy.approve(later), true);
  assert.equal(asks, 3);
});

test('an aborted turn is never approved, before or during the prompt', async () => {
  const controller = new AbortController();
  const preAborted = new AbortController();
  preAborted.abort();

  const policy = createPermissionPolicy({
    mode: 'interactive',
    // The human answers yes — after the turn has already been cancelled.
    ask: async () => {
      controller.abort();
      return 'y';
    },
  });

  assert.equal(
    await policy.approve(context('shell.run', 'gated', { signal: preAborted.signal })),
    false,
    'a turn cancelled before the prompt never reaches a human',
  );

  assert.equal(
    await policy.approve(context('shell.run', 'gated', { signal: controller.signal })),
    false,
    'an answer arriving after the abort does not execute a tool for a dead turn',
  );
});

test('interactive mode refuses to be constructed with no way to ask', () => {
  assert.throws(
    () => createPermissionPolicy({ mode: 'interactive' }),
    /needs an `ask` function/,
  );
});

test('risk ordering puts dangerous above gated above safe', () => {
  assert.equal(atLeastAsRisky('dangerous', 'gated'), true);
  assert.equal(atLeastAsRisky('gated', 'gated'), true);
  assert.equal(atLeastAsRisky('safe', 'gated'), false);
});
