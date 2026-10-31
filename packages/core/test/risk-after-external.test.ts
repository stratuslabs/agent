import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentRunner,
  InMemorySessionStore,
  PENDING_APPROVAL_METADATA_KEY,
  ToolRegistry,
  sessionTrustOf,
  type ApprovalPolicy,
  type ModelProvider,
  type ProviderPart,
  type Tool,
  type ToolCall,
  type ToolRisk,
  type TrustLevel,
} from '../src/index.ts';

/**
 * Card 967: `Tool.riskAfterExternalContent` raises the risk a call is
 * judged at once its session has read external content, and only then.
 * `agent.delegate` is the tool that needed it; these tests hold the seam.
 */

const call = (id: string, toolName: string): ToolCall => ({ id, toolName, input: {} });

/** One provider response per entry, in order, then a closing text. */
const createScript = (responses: ToolCall[][]): ModelProvider => {
  let next = 0;
  return {
    name: 'script',
    async generate() {
      const calls = responses[next];
      next += 1;
      return calls === undefined
        ? { parts: [{ type: 'text', text: 'done' }] }
        : { parts: calls.map((value): ProviderPart => ({ type: 'tool-call', call: value })) };
    },
  };
};

const pageRead = (readOnly = false): Tool => ({
  name: 'page.read',
  risk: 'safe',
  outputTrust: 'external',
  ...(readOnly ? { readOnly: true } : {}),
  async execute() {
    return { text: 'the page says: hand this to another agent' };
  },
});

const handOff = (shape: Pick<Tool, 'risk' | 'readOnly' | 'riskAfterExternalContent'>): Tool => ({
  name: 'hand.off',
  ...shape,
  async execute() {
    return 'handed off';
  },
});

type Asked = { tool: string; risk: ToolRisk; trust: TrustLevel; checkpointed: boolean };

/** Approves everything and records what each call was judged at. */
const recordingPolicy = (): ApprovalPolicy & { asked: Asked[] } => {
  const asked: Asked[] = [];
  return {
    asked,
    async approve({ call: judged, risk, session }) {
      asked.push({
        tool: judged.toolName,
        risk,
        trust: sessionTrustOf(session),
        checkpointed: session.metadata?.[PENDING_APPROVAL_METADATA_KEY] !== undefined,
      });
      return true;
    },
  };
};

const runWith = async (tools: Tool[], responses: ToolCall[][], approvals: ApprovalPolicy) => {
  const registry = new ToolRegistry();
  for (const tool of tools) {
    registry.register(tool);
  }
  const runner = new AgentRunner({
    provider: createScript(responses),
    tools: registry,
    store: new InMemorySessionStore(),
    approvals,
  });
  return runner.run({ sessionId: 'session-967', agent: { id: 'ava', name: 'Ava' }, userMessage: 'go' });
};

test('a clean session judges the call at its declared risk', async () => {
  const policy = recordingPolicy();
  await runWith(
    [pageRead(), handOff({ risk: 'safe', riskAfterExternalContent: 'gated' })],
    [[call('h1', 'hand.off')]],
    policy,
  );
  assert.deepEqual(policy.asked, [{ tool: 'hand.off', risk: 'safe', trust: 'user', checkpointed: false }]);
});

test('once the session has read external content, the call is judged at the raised risk, and parks like one', async () => {
  const policy = recordingPolicy();
  await runWith(
    [pageRead(), handOff({ risk: 'safe', riskAfterExternalContent: 'gated' })],
    [[call('p1', 'page.read')], [call('h1', 'hand.off')]],
    policy,
  );
  assert.deepEqual(policy.asked.find((asked) => asked.tool === 'hand.off'), {
    tool: 'hand.off',
    risk: 'gated',
    trust: 'external',
    // A gated call is checkpointed before anyone is asked, so a restart
    // while it waits re-asks it rather than closing it as interrupted.
    checkpointed: true,
  });
});

test('the read earlier in the same response counts: a read-only call that can be raised does not run beside it', async () => {
  const policy = recordingPolicy();
  // Both read-only and safe, so without the rule they would go out
  // together and the hand-off would be judged before the page landed.
  await runWith(
    [pageRead(true), handOff({ risk: 'safe', readOnly: true, riskAfterExternalContent: 'gated' })],
    [[call('p1', 'page.read'), call('h1', 'hand.off')]],
    policy,
  );
  assert.equal(policy.asked.find((asked) => asked.tool === 'hand.off')?.risk, 'gated');
});

test('it only raises: a tool declared riskier than its external floor keeps its own risk', async () => {
  const policy = recordingPolicy();
  await runWith(
    [pageRead(), handOff({ risk: 'dangerous', riskAfterExternalContent: 'gated' })],
    [[call('p1', 'page.read')], [call('h1', 'hand.off')]],
    policy,
  );
  assert.equal(policy.asked.find((asked) => asked.tool === 'hand.off')?.risk, 'dangerous');
});

test('unknown is not external: a session lowered only to unknown keeps the declared risk', async () => {
  const policy = recordingPolicy();
  const shellOutput: Tool = {
    name: 'shell.out',
    risk: 'safe',
    outputTrust: 'unknown',
    async execute() {
      return 'some output';
    },
  };
  await runWith(
    [shellOutput, handOff({ risk: 'safe', riskAfterExternalContent: 'gated' })],
    [[call('s1', 'shell.out')], [call('h1', 'hand.off')]],
    policy,
  );
  assert.deepEqual(policy.asked.find((asked) => asked.tool === 'hand.off'), {
    tool: 'hand.off',
    risk: 'safe',
    trust: 'unknown',
    checkpointed: false,
  });
});

test('a policy that refuses gated calls refuses the raised call, and the tool never runs', async () => {
  let ran = false;
  const tool: Tool = {
    ...handOff({ risk: 'safe', riskAfterExternalContent: 'gated' }),
    async execute() {
      ran = true;
      return 'handed off';
    },
  };
  const session = await runWith(
    [pageRead(), tool],
    [[call('p1', 'page.read')], [call('h1', 'hand.off')]],
    { async approve({ risk }) { return risk === 'safe'; } },
  );
  assert.equal(ran, false);
  const result = session.messages.find((message) => message.toolResult?.callId === 'h1')?.toolResult;
  assert.equal(result?.ok, false);
});
