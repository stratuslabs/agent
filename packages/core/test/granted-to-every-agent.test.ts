import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentRunner,
  InMemorySessionStore,
  ToolRegistry,
  type ModelProvider,
  type ProviderRequest,
  type ProviderResponse,
  type Tool,
  type ToolDescriptor,
} from '../src/index.ts';

const tool = (name: string): Tool => ({
  name,
  risk: 'safe',
  async execute() {
    return { ran: name };
  },
});

/** Calls each name in `calls` on turn 1, then answers. */
const callingProvider = (calls: string[]): { provider: ModelProvider; requests: ProviderRequest[] } => {
  const requests: ProviderRequest[] = [];
  let turn = 0;
  return {
    requests,
    provider: {
      name: 'scripted',
      async generate(request: ProviderRequest): Promise<ProviderResponse> {
        requests.push(request);
        turn += 1;
        return turn === 1
          ? { parts: calls.map((toolName, index) => ({ type: 'tool-call' as const, call: { id: `c${index}`, toolName, input: {} } })) }
          : { parts: [{ type: 'text', text: 'done' }] };
      },
    },
  };
};

const run = async (agentTools: string[] | undefined, granted: string[] | undefined) => {
  const tools = new ToolRegistry();
  tools.register(tool('credential.request'));
  tools.register(tool('shell.run'));
  const { provider, requests } = callingProvider(['credential.request', 'shell.run']);
  const runner = new AgentRunner({
    provider,
    tools,
    store: new InMemorySessionStore(),
    ...(granted !== undefined ? { grantedToEveryAgent: granted } : {}),
  });
  await runner.initialize();
  const session = await runner.run({
    sessionId: 's',
    agent: { id: 'kai', name: 'Kai', ...(agentTools !== undefined ? { tools: agentTools } : {}) },
    userMessage: 'go',
  });
  const advertised = (requests[0]?.tools ?? []).map((entry: ToolDescriptor) => entry.name);
  const results = session.messages.filter((message) => message.role === 'tool').map((message) => message.toolResult);
  const byName = (name: string) => results.find((result) => result?.toolName === name);
  return { advertised, byName };
};

test('a tool the host grants to every agent is advertised and runs without the soul listing it', async () => {
  const { advertised, byName } = await run(['fs.*'], ['credential.request']);
  assert.ok(advertised.includes('credential.request'));
  assert.equal(byName('credential.request')?.ok, true);
});

test('the grant names one tool and widens nothing else on the allowlist', async () => {
  const { advertised, byName } = await run(['fs.*'], ['credential.request']);
  assert.ok(!advertised.includes('shell.run'));
  assert.equal(byName('shell.run')?.ok, false);
  assert.match(byName('shell.run')?.error ?? '', /Tool not permitted for agent kai: shell\.run/);
});

test('an empty tools list still gets the granted tool', async () => {
  const { advertised, byName } = await run([], ['credential.request']);
  assert.deepEqual(advertised, ['credential.request']);
  assert.equal(byName('credential.request')?.ok, true);
  assert.equal(byName('shell.run')?.ok, false);
});

test('without the host option an allowlist still refuses the tool', async () => {
  const { advertised, byName } = await run(['fs.*'], undefined);
  assert.ok(!advertised.includes('credential.request'));
  assert.equal(byName('credential.request')?.ok, false);
});
