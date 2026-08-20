import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentRunner,
  InMemorySessionStore,
  matchesToolAllowlist,
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

test('a toolset glob selects its namespace and nothing that merely starts like it', () => {
  assert.equal(matchesToolAllowlist('fs.read', ['fs.read']), true);
  assert.equal(matchesToolAllowlist('fs.write', ['fs.read']), false);

  // The whole toolset, nested names included — the form the MCP bridge's
  // runtime-discovered names can be granted under at all.
  assert.equal(matchesToolAllowlist('fs.read', ['fs.*']), true);
  assert.equal(matchesToolAllowlist('mcp.linear.create_issue', ['mcp.*']), true);

  // The dot belongs to the prefix: a package cannot widen its way into
  // another's namespace by naming itself to look like one.
  assert.equal(matchesToolAllowlist('fsx.read', ['fs.*']), false);
  assert.equal(matchesToolAllowlist('fs', ['fs.*']), false);

  assert.equal(matchesToolAllowlist('anything.at.all', ['*']), true);
  assert.equal(matchesToolAllowlist('fs.read', []), false);
});

test('an agent allowed a toolset can call every tool in it, and nothing outside it', async () => {
  const tools = new ToolRegistry();
  tools.register(tool('fs.read'));
  tools.register(tool('fs.search'));
  tools.register(tool('shell.run'));

  const advertised: ToolDescriptor[][] = [];
  let turn = 0;
  const provider: ModelProvider = {
    name: 'scripted',
    async generate(request: ProviderRequest): Promise<ProviderResponse> {
      advertised.push(request.tools ?? []);
      turn += 1;
      if (turn === 1) {
        return { parts: [{ type: 'tool-call', call: { id: 'c1', toolName: 'fs.search', input: {} } }] };
      }
      if (turn === 2) {
        return { parts: [{ type: 'tool-call', call: { id: 'c2', toolName: 'shell.run', input: {} } }] };
      }
      return { parts: [{ type: 'text', text: 'done' }] };
    },
  };

  const runner = new AgentRunner({ provider, tools, store: new InMemorySessionStore() });
  await runner.initialize();

  const session = await runner.run({
    sessionId: 'glob-1',
    agent: { id: 'ava', name: 'Ava', tools: ['fs.*'] },
    userMessage: 'go',
  });

  // The provider is shown the toolset, not the tool the glob was written to
  // avoid: an agent that cannot call `shell.run` should not be told it can.
  assert.deepEqual(advertised[0]?.map((entry) => entry.name), ['fs.read', 'fs.search']);

  const results = session.messages.filter((message) => message.role === 'tool');
  assert.equal(results[0]?.toolResult?.ok, true);
  assert.deepEqual(results[0]?.toolResult?.output, { ran: 'fs.search' });

  // The gate is the allowlist's, not the provider's: a call the model
  // invented for a tool outside the glob is still refused.
  assert.equal(results[1]?.toolResult?.ok, false);
  assert.match(results[1]?.toolResult?.error ?? '', /not permitted for agent ava: shell\.run/);
});
