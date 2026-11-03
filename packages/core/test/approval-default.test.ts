import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentRunner,
  AllowAllApprovalPolicy,
  InMemorySessionStore,
  ToolRegistry,
  type AgentRunnerOptions,
  type ModelProvider,
  type ProviderResponse,
  type ToolRisk,
} from '../src/index.ts';

/** One call to the named tool, then a closing text turn. */
const oneCall = (toolName: string): ModelProvider => {
  let turn = 0;
  return {
    name: 'scripted',
    async generate(): Promise<ProviderResponse> {
      turn += 1;
      return turn === 1
        ? { parts: [{ type: 'tool-call', call: { id: 'c1', toolName, input: {} } }] }
        : { parts: [{ type: 'text', text: 'done' }] };
    },
  };
};

interface Outcome {
  ran: boolean;
  denied: boolean;
  ok: boolean | undefined;
  error: string | undefined;
}

/**
 * Runs one call to a `probe.run` tool at `risk` (none given: the tool
 * declares no risk) on a runner built with `extra`, which is where the
 * approval policy goes or does not.
 */
const callAt = async (risk: ToolRisk | undefined, extra: Partial<AgentRunnerOptions> = {}): Promise<Outcome> => {
  const outcome: Outcome = { ran: false, denied: false, ok: undefined, error: undefined };
  const tools = new ToolRegistry();
  tools.register({
    name: 'probe.run',
    description: 'probe',
    ...(risk !== undefined ? { risk } : {}),
    async execute() {
      outcome.ran = true;
      return { ran: true };
    },
  });
  const runner = new AgentRunner({ provider: oneCall('probe.run'), tools, store: new InMemorySessionStore(), ...extra });
  runner.bus.subscribe((event) => {
    if (event.type === 'tool.denied') {
      outcome.denied = true;
    }
  });
  await runner.initialize();
  const session = await runner.run({ sessionId: `default-${risk ?? 'none'}`, agent: { id: 'ava', name: 'Ava', tools: ['*'] }, userMessage: 'go' });
  const result = session.messages.find((message) => message.toolResult?.callId === 'c1')?.toolResult;
  outcome.ok = result?.ok;
  outcome.error = result?.error;
  return outcome;
};

test('a runner built without an approval policy runs a safe call', async () => {
  const outcome = await callAt('safe');
  assert.equal(outcome.ran, true);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.denied, false);
});

test('a runner built without an approval policy refuses a gated or dangerous call, and says which option allows it', async () => {
  // No declared risk reads as gated, so a tool that never thought about
  // risk is refused too.
  for (const risk of ['gated', 'dangerous', undefined] as const) {
    const outcome = await callAt(risk);
    assert.equal(outcome.ran, false, `${risk ?? 'no risk'} ran`);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.denied, true);
    assert.match(outcome.error ?? '', /^probe\.run did not run: /);
    assert.match(outcome.error ?? '', /no `approvals` policy/);
    assert.match(outcome.error ?? '', /AllowAllApprovalPolicy/);
  }
});

test('AllowAllApprovalPolicy, passed explicitly, runs gated and dangerous calls unasked', async () => {
  for (const risk of ['gated', 'dangerous'] as const) {
    const outcome = await callAt(risk, { approvals: new AllowAllApprovalPolicy() });
    assert.equal(outcome.ran, true, `${risk} did not run`);
    assert.equal(outcome.ok, true);
  }
});

test('a policy the app passed that says no keeps the policy-denied error', async () => {
  const outcome = await callAt('gated', { approvals: { approve: async () => false } });
  assert.equal(outcome.ran, false);
  assert.equal(outcome.error, 'Tool call denied by approval policy: probe.run');
});
