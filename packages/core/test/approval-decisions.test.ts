import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentRunner,
  InMemorySessionStore,
  ToolRegistry,
  type ApprovalPolicy,
  type ModelProvider,
  type ProviderResponse,
  type StratusEvent,
  type ToolResult,
} from '../src/index.ts';

/** One call to `probe.run` with an input worth keeping out of events, then a closing text turn. */
const oneCall = (): ModelProvider => {
  let turn = 0;
  return {
    name: 'scripted',
    async generate(): Promise<ProviderResponse> {
      turn += 1;
      return turn === 1
        ? { parts: [{ type: 'tool-call', call: { id: 'c1', toolName: 'probe.run', input: { secret: 'sk-ant-do-not-log' } } }] }
        : { parts: [{ type: 'text', text: 'done' }] };
    },
  };
};

interface Outcome {
  ran: boolean;
  result: ToolResult | undefined;
  events: StratusEvent[];
}

const callWith = async (approvals: ApprovalPolicy): Promise<Outcome> => {
  const outcome: Outcome = { ran: false, result: undefined, events: [] };
  const tools = new ToolRegistry();
  tools.register({
    name: 'probe.run',
    description: 'probe',
    risk: 'gated',
    async execute() {
      outcome.ran = true;
      return { ran: true };
    },
  });
  const runner = new AgentRunner({ provider: oneCall(), tools, store: new InMemorySessionStore(), approvals });
  runner.bus.subscribe((event) => {
    outcome.events.push(event);
  });
  await runner.initialize();
  const session = await runner.run({ sessionId: 's1', agent: { id: 'ava', name: 'Ava' }, userMessage: 'go' });
  outcome.result = session.messages.find((message) => message.toolResult?.callId === 'c1')?.toolResult;
  return outcome;
};

test('a refusal with a reason reaches the agent as the tool error', async () => {
  const outcome = await callWith({
    approve: async () => ({ allowed: false, reason: 'probe.run is gated and nobody is available to approve it' }),
  });
  assert.equal(outcome.ran, false);
  assert.equal(outcome.result?.ok, false);
  assert.equal(outcome.result?.error, 'probe.run is gated and nobody is available to approve it');
  assert.ok(outcome.events.some((event) => event.type === 'tool.denied'));
});

test('a plain false keeps the policy-denied error, and a blank reason reads like one', async () => {
  for (const approvals of [
    { approve: async () => false },
    { approve: async () => ({ allowed: false as const, reason: '   ' }) },
  ]) {
    const outcome = await callWith(approvals);
    assert.equal(outcome.ran, false);
    assert.equal(outcome.result?.error, 'Tool call denied by approval policy: probe.run');
  }
});

test('only a plain true runs the call: an answer of any other shape is a refusal', async () => {
  // A policy written in plain JavaScript can hand back anything. Before
  // refusals carried a reason, any truthy answer ran the call; now that an
  // object is a refusal, reading one as a yes would run what it refused.
  for (const answer of [{ allowed: true }, { allowed: false }, 1, 'yes', undefined, null]) {
    const outcome = await callWith({ approve: async () => answer as never });
    assert.equal(outcome.ran, false, `${JSON.stringify(answer)} ran`);
    assert.equal(outcome.result?.ok, false);
  }
});

test('a decision the policy reports becomes permission.decided, ahead of the call, with no tool input', async () => {
  const outcome = await callWith({
    async approve(context) {
      context.decided?.({ allowed: true, layer: 'grant', reason: 'probe.run ran under a standing grant' });
      return true;
    },
  });
  assert.equal(outcome.ran, true);
  const decided = outcome.events.filter((event) => event.type === 'permission.decided');
  assert.equal(decided.length, 1);
  assert.deepEqual(decided[0], {
    type: 'permission.decided',
    sessionId: 's1',
    agentId: 'ava',
    callId: 'c1',
    toolName: 'probe.run',
    risk: 'gated',
    allowed: true,
    layer: 'grant',
    reason: 'probe.run ran under a standing grant',
  });
  assert.doesNotMatch(JSON.stringify(decided[0]), /sk-ant-do-not-log/);
  const order = outcome.events.map((event) => event.type);
  assert.ok(order.indexOf('permission.decided') < order.indexOf('tool.called'), order.join(', '));
});

test('permission.decided carries a verdict, review code and shadow mark when the policy gives them, and nothing else it adds', async () => {
  const outcome = await callWith({
    async approve(context) {
      context.decided?.({
        allowed: false,
        layer: 'review',
        reason: 'the call does not follow from the request',
        verdict: 'block',
        reviewCode: 'not-asked-for',
        shadow: true,
        // Not part of the event: a policy that passes the call along must
        // not get it onto the bus.
        input: { secret: 'sk-ant-do-not-log' },
      } as never);
      return { allowed: false, reason: 'probe.run was blocked' };
    },
  });
  const decided = outcome.events.find((event) => event.type === 'permission.decided');
  assert.equal(decided?.type, 'permission.decided');
  if (decided?.type !== 'permission.decided') {
    return;
  }
  assert.equal(decided.verdict, 'block');
  assert.equal(decided.reviewCode, 'not-asked-for');
  assert.equal(decided.shadow, true);
  assert.doesNotMatch(JSON.stringify(decided), /sk-ant-do-not-log/);
  const order = outcome.events.map((event) => event.type);
  assert.ok(order.indexOf('permission.decided') < order.indexOf('tool.denied'), order.join(', '));
});

test('a decision reported after the policy answered still reaches the bus', async () => {
  let report: ((decision: { allowed: boolean; layer: string; reason: string }) => void) | undefined;
  const outcome = await callWith({
    async approve(context) {
      report = context.decided;
      return true;
    },
  });
  assert.equal(outcome.ran, true);
  assert.equal(outcome.events.filter((event) => event.type === 'permission.decided').length, 0);
  report?.({ allowed: false, layer: 'review', reason: 'would have asked' });
  // The bus delivers to its first subscriber synchronously.
  const late = outcome.events.filter((event) => event.type === 'permission.decided');
  assert.equal(late.length, 1);
  assert.equal(late[0]?.type === 'permission.decided' ? late[0].callId : undefined, 'c1');
});
