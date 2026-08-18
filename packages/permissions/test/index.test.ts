import test from 'node:test';
import assert from 'node:assert/strict';

import type { ApprovalAnswer, ApprovalContext, Session, Tool, ToolCall, ToolRisk } from '@stratusagent/core';

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

test('an "always" grant cannot leak between sessions with adjacent ids', async () => {
  let asks = 0;
  const policy = createPermissionPolicy({
    mode: 'interactive',
    ask: async () => {
      asks += 1;
      return 'always';
    },
  });

  // The session cache is keyed by (session, tool) joined on a separator.
  // Pick one that occurs in real ids — a space, a colon — and these two
  // pairs collapse onto the same key, so approving the first would silently
  // approve the second. Channel session ids are colon-delimited and can
  // carry spaces from a channel name, so the join uses NUL, which cannot
  // appear in either half.
  const first = context('run', 'gated', { session: session('a b') });
  const second = context('b run', 'gated', { session: session('a') });

  assert.equal(await policy.approve(first), true);
  assert.equal(asks, 1);

  assert.equal(await policy.approve(second), true);
  assert.equal(asks, 2, 'the second session had to ask for itself');
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

test('a prompt nobody answers does not outlive the turn', { timeout: 10_000 }, async () => {
  const controller = new AbortController();
  let resolvePrompt: ((answer: string) => void) | undefined;

  const policy = createPermissionPolicy({
    mode: 'interactive',
    // The terminal is gone: this never settles on its own. Checking
    // signal.aborted around the await would not help — the await in the
    // middle is where the cancelled turn would wait forever.
    ask: async () => new Promise<string>((resolve) => {
      resolvePrompt = resolve;
    }),
  });

  const decision = policy.approve(context('shell.run', 'gated', { signal: controller.signal }));
  // Gate on the prompt actually being outstanding rather than on a delay,
  // so a regression fails this assertion instead of hanging the suite.
  await new Promise<void>((resolve) => {
    const wait = (): void => {
      if (resolvePrompt) {
        resolve();
        return;
      }
      setImmediate(wait);
    };
    wait();
  });

  controller.abort();
  assert.equal(await decision, false, 'the abort released the wait');

  // And the answer arriving afterwards changes nothing.
  resolvePrompt?.('y');
  await new Promise((resolve) => setImmediate(resolve));
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

test('remote mode refuses to be constructed with no way to ask', () => {
  assert.throws(
    () => createPermissionPolicy({ mode: 'remote' }),
    /needs a `request` function/,
  );
});

test('a remote answer decides the call, and always covers the rest of the session', async () => {
  const asked: string[] = [];
  const answers: ApprovalAnswer[] = ['once', 'always', 'deny'];
  const decisions: PermissionDecision[] = [];
  const policy = createPermissionPolicy({
    mode: 'remote',
    request: async (request) => {
      asked.push(request.call.toolName);
      return answers.shift() ?? 'deny';
    },
    onDecision: (decision) => decisions.push(decision),
  });

  assert.equal(await policy.approve(context('shell.run', 'gated')), true, 'allow once');
  assert.equal(await policy.approve(context('fs.write', 'gated')), true, 'always allow');
  // The second fs.write is covered by the "always" above and never reaches
  // the transport — that is what makes the button worth clicking.
  assert.equal(await policy.approve(context('fs.write', 'gated')), true);
  assert.equal(await policy.approve(context('fs.delete', 'dangerous')), false, 'deny');

  assert.deepEqual(asked, ['shell.run', 'fs.write', 'fs.delete']);
  // A remote "always" is session-scoped exactly like the prompt's, so the
  // two surfaces cannot mean different things by the same word.
  assert.match(decisions[2]!.reason, /rest of this session/);
  assert.match(decisions[3]!.reason, /was not approved/);

  // Session-scoped means session-scoped: another session asks again.
  const other = context('fs.write', 'gated', { session: session('sess-2') });
  answers.push('deny');
  assert.equal(await policy.approve(other), false);
  assert.deepEqual(asked, ['shell.run', 'fs.write', 'fs.delete', 'fs.write']);
});

test('a transport that fails denies the call instead of failing the turn', async () => {
  const policy = createPermissionPolicy({
    mode: 'remote',
    request: async () => {
      throw new Error('slack is down');
    },
  });

  // The agent should be told its call was not approved and carry on — a
  // channel outage must not surface as a crashed turn.
  assert.equal(await policy.approve(context('shell.run', 'gated')), false);
});

test('an aborted turn releases a remote request nobody answered', async () => {
  const controller = new AbortController();
  let answer: ((value: ApprovalAnswer) => void) | undefined;
  const policy = createPermissionPolicy({
    mode: 'remote',
    request: () => new Promise<ApprovalAnswer>((resolve) => {
      answer = resolve;
    }),
  });

  const decision = policy.approve(context('shell.run', 'gated', { signal: controller.signal }));

  // Gate on the transport actually having been reached, so the abort below
  // races the wait it is meant to release rather than a not-yet-started one.
  await new Promise<void>((resolve) => {
    const wait = (): void => {
      if (answer) {
        resolve();
        return;
      }
      setImmediate(wait);
    };
    wait();
  });

  controller.abort();
  assert.equal(await decision, false, 'the abort released the wait');

  // An approval clicked after the turn is gone changes nothing here — the
  // gateway refuses it too, but the policy must not be relying on that.
  answer?.('always');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await policy.approve(context('shell.run', 'gated', { signal: controller.signal })), false);
});
