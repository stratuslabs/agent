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

/**
 * A tool judged by destination, which is the one shape that still gets the
 * session-scoped "always": a durable grant there would be a standing yes to
 * every destination. Every other unscoped gated tool now gets a standing
 * grant instead, tested in grants.test.ts.
 */
const sendTool = (name: string): Tool => ({
  name,
  risk: 'gated',
  destinationFor: (input) => (typeof input.destination === 'string' ? input.destination : undefined),
  async execute() {
    return null;
  },
});

const sendContext = (name: string, sessionId = 'sess-1'): ApprovalContext => ({
  session: session(sessionId),
  call: { id: 'call-1', toolName: name, input: { destination: 'slack:C-ENG' } },
  tool: sendTool(name),
  risk: 'gated',
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

test('the interactive prompt renders a gated call\'s arguments, so a schedule shows what it sets up', async () => {
  const asked: string[] = [];
  const policy = createPermissionPolicy({
    mode: 'interactive',
    ask: async (question) => {
      asked.push(question);
      return 'n';
    },
  });

  // Approving schedule.every mints recurring unattended work and a standing
  // outbound grant — the operator must see the cadence, prompt, and
  // destination, not just the tool name.
  await policy.approve(context('schedule.every', 'gated', {
    call: {
      id: 'call-1',
      toolName: 'schedule.every',
      input: { every: '30m', prompt: 'check the repo', destination: { channel: 'slack', to: 'C-ENG' } },
    },
  }));
  assert.match(asked[0]!, /schedule\.every \(gated\):/);
  assert.match(asked[0]!, /30m/);
  assert.match(asked[0]!, /check the repo/);
  assert.match(asked[0]!, /C-ENG/);

  // A call with no arguments still reads exactly as before — no empty
  // "(): " tail.
  asked.length = 0;
  await policy.approve(context('memory.remember', 'gated'));
  assert.match(asked[0]!, /Allow memory\.remember \(gated\) for Ava\?/);

  // A long free-form prompt must not push the destination out of view: the
  // approver is authorizing where the schedule may post, and that field
  // stays visible however long the prompt is.
  asked.length = 0;
  await policy.approve(context('schedule.every', 'gated', {
    call: {
      id: 'call-1',
      toolName: 'schedule.every',
      input: {
        every: '30m',
        prompt: 'x'.repeat(500),
        destination: { channel: 'slack', to: 'C-SECRET-OPS' },
      },
    },
  }));
  assert.match(asked[0]!, /C-SECRET-OPS/, 'the destination survives a long prompt');
  assert.match(asked[0]!, /30m/);

  // When even the per-field-capped rendering overflows (many fields), the
  // cut announces itself rather than silently showing a partial call as if
  // it were whole — the honest-prompt property.
  asked.length = 0;
  const manyFields: Record<string, string> = {};
  for (let index = 0; index < 40; index += 1) {
    manyFields[`field_${index}`] = 'y'.repeat(100);
  }
  await policy.approve(context('schedule.every', 'gated', {
    call: { id: 'call-1', toolName: 'schedule.every', input: manyFields },
  }));
  assert.match(asked[0]!, /arguments truncated — inspect the call before approving/);
});

test('"always" on a destination-scoped tool lasts for the session that said it, and no longer', async () => {
  let asks = 0;
  const asked: string[] = [];
  const policy = createPermissionPolicy({
    mode: 'interactive',
    ask: async (question) => {
      asks += 1;
      asked.push(question);
      return 'always';
    },
  });

  assert.equal(await policy.approve(sendContext('message.send')), true);
  assert.match(asked[0]!, /always this session/, 'the prompt says which lifetime it is offering');
  assert.equal(await policy.approve(sendContext('message.send')), true);
  assert.equal(asks, 1, 'the second call in the same session did not ask again');

  // A different tool is a different question, even in the same session.
  assert.equal(await policy.approve(sendContext('message.post')), true);
  assert.equal(asks, 2);

  // And another session starts over: a yes to "send anywhere" must not
  // become a standing grant across conversations — no per-destination
  // grant exists yet, so the session is the widest honest lifetime.
  assert.equal(await policy.approve(sendContext('message.send', 'sess-2')), true);
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
  const first = sendContext('run', 'a b');
  const second = sendContext('b run', 'a');

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

test('a remote answer decides the call, and always on a destination-scoped tool covers the rest of the session', async () => {
  const asked: Array<[string, string | undefined]> = [];
  const answers: ApprovalAnswer[] = ['once', 'always', 'deny'];
  const decisions: PermissionDecision[] = [];
  const policy = createPermissionPolicy({
    mode: 'remote',
    request: async (request) => {
      asked.push([request.call.toolName, request.always]);
      return answers.shift() ?? 'deny';
    },
    onDecision: (decision) => decisions.push(decision),
  });

  assert.equal(await policy.approve(context('shell.run', 'gated')), true, 'allow once');
  assert.equal(await policy.approve(sendContext('message.send')), true, 'always allow');
  // The second send is covered by the "always" above and never reaches
  // the transport — that is what makes the button worth clicking.
  assert.equal(await policy.approve(sendContext('message.send')), true);
  assert.equal(await policy.approve(context('fs.delete', 'dangerous')), false, 'deny');

  // The request says in advance which lifetime "always" would create, so
  // the transport can word the button and the outcome without guessing.
  assert.deepEqual(asked, [['shell.run', 'tool'], ['message.send', 'session'], ['fs.delete', undefined]]);
  // A remote "always" is session-scoped exactly like the prompt's, so the
  // two surfaces cannot mean different things by the same word.
  assert.match(decisions[2]!.reason, /rest of this session/);
  assert.match(decisions[3]!.reason, /was not approved/);

  // Session-scoped means session-scoped: another session asks again.
  answers.push('deny');
  assert.equal(await policy.approve(sendContext('message.send', 'sess-2')), false);
  assert.deepEqual(asked.map(([name]) => name), ['shell.run', 'message.send', 'fs.delete', 'message.send']);
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
