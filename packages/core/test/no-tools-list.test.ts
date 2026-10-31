import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentRunner,
  InMemorySessionStore,
  ToolRegistry,
  type AgentDefinition,
  type ModelProvider,
  type ProviderRequest,
  type ProviderResponse,
  type Tool,
  type ToolDescriptor,
  type ToolRisk,
} from '../src/index.ts';

// A soul with no `tools:` key used to be allowed every registered tool,
// so enabling a plugin handed its tools to every such agent at once. It now
// gets the tools registered at risk `safe` and nothing else; `tools: ["*"]`
// is how a soul says "everything", and the upgrade writes that line into
// the souls an existing install already has.

const tool = (name: string, risk: ToolRisk): Tool => ({
  name,
  risk,
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

const run = async (
  agent: Pick<AgentDefinition, 'tools'>,
  calls: string[],
  options: { granted?: string[] } = {},
) => {
  const tools = new ToolRegistry();
  tools.register(tool('memory.recall', 'safe'));
  tools.register(tool('fs.read', 'safe'));
  tools.register(tool('fs.write', 'gated'));
  tools.register(tool('shell.run', 'gated'));
  tools.register(tool('fs.delete', 'dangerous'));
  const { provider, requests } = callingProvider(calls);
  const runner = new AgentRunner({
    provider,
    tools,
    store: new InMemorySessionStore(),
    ...(options.granted !== undefined ? { grantedToEveryAgent: options.granted } : {}),
  });
  await runner.initialize();
  const session = await runner.run({
    sessionId: 's',
    agent: { id: 'kai', name: 'Kai', ...agent },
    userMessage: 'go',
  });
  const advertised = (requests[0]?.tools ?? []).map((entry: ToolDescriptor) => entry.name).sort();
  const results = session.messages.filter((message) => message.role === 'tool').map((message) => message.toolResult);
  const byName = (name: string) => results.find((result) => result?.toolName === name);
  return { advertised, byName };
};

test('an agent with no tools list is shown only the tools registered as safe', async () => {
  const { advertised } = await run({}, []);
  assert.deepEqual(advertised, ['fs.read', 'memory.recall']);
});

test('an agent with no tools list may call a safe tool', async () => {
  const { byName } = await run({}, ['memory.recall']);
  assert.equal(byName('memory.recall')?.ok, true);
});

test('an agent with no tools list is refused a gated or dangerous tool it names anyway, and told how to grant it', async () => {
  const { byName } = await run({}, ['shell.run', 'fs.delete']);
  for (const name of ['shell.run', 'fs.delete']) {
    const result = byName(name);
    assert.equal(result?.ok, false, name);
    assert.match(result?.error ?? '', new RegExp(`Tool not permitted for agent kai: ${name.replace('.', '\\.')}`));
    // The refusal says why and what to change, because the model relays it
    // and the operator is the one who has to edit the soul.
    assert.match(result?.error ?? '', /no tools: list/);
    assert.match(result?.error ?? '', /safe tools/);
  }
});

test('tools: ["*"] still grants every registered tool', async () => {
  const { advertised, byName } = await run({ tools: ['*'] }, ['shell.run', 'fs.delete']);
  assert.deepEqual(advertised, ['fs.delete', 'fs.read', 'fs.write', 'memory.recall', 'shell.run']);
  assert.equal(byName('shell.run')?.ok, true);
  assert.equal(byName('fs.delete')?.ok, true);
});

test('an explicit list is unchanged: it grants what it names, safe or not, and only that', async () => {
  const { advertised } = await run({ tools: ['fs.*'] }, []);
  assert.deepEqual(advertised, ['fs.delete', 'fs.read', 'fs.write']);
});

test('a tool the host grants to every agent still reaches an agent with no tools list', async () => {
  const { advertised, byName } = await run({}, ['fs.write'], { granted: ['fs.write'] });
  assert.ok(advertised.includes('fs.write'));
  assert.equal(byName('fs.write')?.ok, true);
});

test('a call naming no registered tool is still "not found", not "not permitted"', async () => {
  const { byName } = await run({}, ['nope.nothing']);
  assert.match(byName('nope.nothing')?.error ?? '', /Tool not found: nope\.nothing/);
});
