import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentRunner,
  InMemorySessionStore,
  ToolRegistry,
  type ExecutionContext,
  type ModelProvider,
  type ProviderResponse,
} from '../src/index.ts';

// A tool learns which call it is running through `ExecutionContext.callId`:
// the id the transcript records for that call, on the kernel loop and on
// the hosted path a provider that runs its own loop goes through. A tool
// that must never act twice for one call keys on it.

const probe = (seen: Array<string | undefined>): ToolRegistry => {
  const tools = new ToolRegistry();
  tools.register({
    name: 'probe.run',
    risk: 'safe',
    async execute(_input, _session, context?: ExecutionContext) {
      seen.push(context?.callId);
      return { ran: true };
    },
  });
  return tools;
};

test('the kernel loop hands each call its own id', async () => {
  const seen: Array<string | undefined> = [];
  let turn = 0;
  const provider: ModelProvider = {
    name: 'scripted',
    async generate(): Promise<ProviderResponse> {
      turn += 1;
      return turn === 1
        ? {
            parts: [
              { type: 'tool-call', call: { id: 'call-a', toolName: 'probe.run', input: {} } },
              { type: 'tool-call', call: { id: 'call-b', toolName: 'probe.run', input: {} } },
            ],
          }
        : { parts: [{ type: 'text', text: 'done' }] };
    },
  };
  const runner = new AgentRunner({ provider, tools: probe(seen), store: new InMemorySessionStore() });
  await runner.initialize();
  await runner.run({ sessionId: 'call-id', agent: { id: 'ava', name: 'Ava', tools: ['*'] }, userMessage: 'go' });
  assert.deepEqual(seen, ['call-a', 'call-b']);
});

test('a hosted call is handed its id too', async () => {
  const seen: Array<string | undefined> = [];
  const store = new InMemorySessionStore();
  const runner = new AgentRunner({
    provider: {
      name: 'hosting',
      async generate({ session }): Promise<ProviderResponse> {
        await runner.executeHostedToolCall(session, { id: 'hosted-1', toolName: 'probe.run', input: {} });
        return { parts: [{ type: 'text', text: 'done' }] };
      },
    },
    tools: probe(seen),
    store,
  });
  await runner.initialize();
  await runner.run({ sessionId: 'hosted-call-id', agent: { id: 'ava', name: 'Ava', tools: ['*'] }, userMessage: 'go' });
  assert.deepEqual(seen, ['hosted-1']);
});
