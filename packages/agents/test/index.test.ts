import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentRunner,
  InMemoryAgentMemoryStore,
  ToolRegistry,
  type ModelProvider,
  type Session,
} from '@stratusagent/core';
import {
  createAgentRouter,
  createAgentTeam,
  createDelegateTool,
  createRememberTool,
  defineAgent,
  generateAgentName,
  generateAvatarTheme,
} from '../src/index.ts';

test('generateAgentName is human-ish and deterministic for a seed', () => {
  const seeded = generateAgentName('fixed-seed');
  assert.equal(seeded, generateAgentName('fixed-seed'));
  assert.match(seeded, /^[A-Z][a-z]+ [A-Z][a-z]+/);

  const random = generateAgentName();
  assert.match(random, /^[A-Z][a-z]+ [A-Z]/);
});

test('generateAvatarTheme derives a stable palette from the name', () => {
  const theme = generateAvatarTheme('Nadia Okafor');
  assert.deepEqual(theme, generateAvatarTheme('Nadia Okafor'));
  assert.equal(theme.seed, 'Nadia Okafor');
  assert.ok(theme.hue >= 0 && theme.hue < 360);
  assert.equal(theme.palette.length, 3);
  for (const color of theme.palette) {
    assert.match(color, /^#[0-9a-f]{6}$/);
  }
  assert.ok(theme.style.length > 0);
});

test('defineAgent fills in identity, avatar, and slug id with zero input', () => {
  const agent = defineAgent({ seed: 'zero-input' });
  assert.match(agent.name, /^[A-Z][a-z]+ [A-Z]/);
  assert.match(agent.id, /^[a-z0-9-]+$/);
  assert.equal(agent.avatar?.seed, agent.name);

  const custom = defineAgent({
    name: 'Vera Thorne',
    instructions: 'Be kind.',
    tools: ['memory.remember'],
    credentials: ['SLACK_TOKEN'],
  });
  assert.equal(custom.id, 'vera-thorne');
  assert.equal(custom.instructions, 'Be kind.');
  assert.deepEqual(custom.tools, ['memory.remember']);
  assert.deepEqual(custom.credentials, ['SLACK_TOKEN']);
});

test('memory persists per agent across sessions and channels', async () => {
  const memory = new InMemoryAgentMemoryStore();
  const agent = defineAgent({ name: 'Juno Mercer', tools: ['memory.remember'] });
  const other = defineAgent({ name: 'Silas Vance' });

  const seenMemory: string[][] = [];
  const provider: ModelProvider = {
    name: 'memory-provider',
    async generate({ session, memory: entries }) {
      seenMemory.push((entries ?? []).map((entry) => entry.content));
      if (session.messages.at(-1)?.role === 'tool') {
        return { parts: [{ type: 'text', text: 'Noted.' }] };
      }
      if (session.messages.at(-1)?.content === 'remember this') {
        return {
          parts: [
            {
              type: 'tool-call',
              call: {
                id: 'call-remember',
                toolName: 'memory.remember',
                input: { fact: 'The user prefers dark mode.' },
              },
            },
          ],
        };
      }
      return { parts: [{ type: 'text', text: 'Hello again.' }] };
    },
  };

  const tools = new ToolRegistry();
  tools.register(createRememberTool(memory));

  const runner = new AgentRunner({
    provider,
    tools,
    memory,
    agents: createAgentTeam([agent, other]),
  });

  await runner.run({ sessionId: 'channel-slack-1', agent, userMessage: 'remember this' });

  // A brand-new session — different channel — for the same agent sees the memory.
  await runner.run({ sessionId: 'channel-email-9', agent, userMessage: 'hi' });
  // Another agent never sees it.
  await runner.run({ sessionId: 'channel-slack-2', agent: other, userMessage: 'hi' });

  const entries = await memory.list(agent.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.content, 'The user prefers dark mode.');
  assert.deepEqual(await memory.list(other.id), []);

  const lastTwoRequests = seenMemory.slice(-2);
  assert.deepEqual(lastTwoRequests[0], ['The user prefers dark mode.']);
  assert.deepEqual(lastTwoRequests[1], []);
});

test('orchestrators delegate to other agents and get their reply back', async () => {
  const orchestrator = defineAgent({
    name: 'August North',
    tools: ['agent.delegate'],
  });
  const specialist = defineAgent({
    name: 'Priya Salinger',
    instructions: 'You know the answer to everything.',
  });
  const registry = createAgentTeam([orchestrator, specialist]);

  const provider: ModelProvider = {
    name: 'team-provider',
    async generate({ session }) {
      if (session.agent.id === specialist.id) {
        return { parts: [{ type: 'text', text: 'The answer is 42.' }] };
      }

      if (session.messages.at(-1)?.role === 'tool') {
        const result = session.messages.at(-1)?.toolResult;
        const output = result?.output as { reply?: string } | null;
        return { parts: [{ type: 'text', text: `Priya says: ${output?.reply ?? ''}` }] };
      }

      return {
        parts: [
          {
            type: 'tool-call',
            call: {
              id: 'call-delegate',
              toolName: 'agent.delegate',
              input: { agent: 'Priya Salinger', prompt: 'What is the answer?' },
            },
          },
        ],
      };
    },
  };

  const tools = new ToolRegistry();
  const runner = new AgentRunner({ provider, tools, agents: registry });
  tools.register(createDelegateTool({ registry, runner }));

  const session = await runner.run({
    sessionId: 'root-1',
    agent: orchestrator,
    userMessage: 'Ask Priya for the answer.',
  });

  assert.equal(session.status, 'completed');
  assert.equal(session.messages.at(-1)?.content, 'Priya says: The answer is 42.');

  const subSession = await runner.store.get('root-1:delegate:priya-salinger:1');
  assert.equal(subSession?.status, 'completed');
  assert.equal(subSession?.metadata?.delegatedBy, orchestrator.id);
  assert.equal(subSession?.metadata?.rootSessionId, 'root-1');
});

test('delegate tool rejects self-delegation, unknown agents, and depth overruns', async () => {
  const orchestrator = defineAgent({ name: 'Kai Ibarra' });
  const registry = createAgentTeam([orchestrator]);
  const provider: ModelProvider = {
    name: 'noop',
    async generate() {
      return { parts: [{ type: 'text', text: 'ok' }] };
    },
  };
  const runner = new AgentRunner({ provider, agents: registry });
  const tool = createDelegateTool({ registry, runner, maxDepth: 2 });

  const sessionFor = (metadata?: Record<string, number>): Session => ({
    id: 's',
    agent: orchestrator,
    status: 'running',
    messages: [],
    createdAt: '',
    updatedAt: '',
    ...(metadata ? { metadata } : {}),
  });

  await assert.rejects(
    () => tool.execute({ agent: 'Kai Ibarra', prompt: 'hi' }, sessionFor()),
    /cannot delegate to itself/,
  );
  await assert.rejects(
    () => tool.execute({ agent: 'nobody', prompt: 'hi' }, sessionFor()),
    /Agent not found: nobody/,
  );
  await assert.rejects(
    () => tool.execute({ agent: 'anyone', prompt: 'hi' }, sessionFor({ delegationDepth: 2 })),
    /Delegation depth limit reached \(2\)/,
  );
});

test('per-agent tool allowlists stop agents using tools they were not given', async () => {
  const restricted = defineAgent({ name: 'Esme Dawes', tools: [] });
  const registry = createAgentTeam([restricted]);
  const memory = new InMemoryAgentMemoryStore();

  const provider: ModelProvider = {
    name: 'pushy-provider',
    async generate({ session, tools: offered }) {
      assert.deepEqual(offered, undefined, 'restricted agent should be offered no tools');
      if (session.messages.at(-1)?.role === 'tool') {
        const result = session.messages.at(-1)?.toolResult;
        assert.equal(result?.ok, false);
        assert.match(result?.error ?? '', /not permitted for agent esme-dawes/);
        return { parts: [{ type: 'text', text: 'Understood.' }] };
      }
      return {
        parts: [
          {
            type: 'tool-call',
            call: { id: 'call-x', toolName: 'memory.remember', input: { fact: 'nope' } },
          },
        ],
      };
    },
  };

  const tools = new ToolRegistry();
  tools.register(createRememberTool(memory));
  const runner = new AgentRunner({ provider, tools, agents: registry, memory });

  const session = await runner.run({
    sessionId: 'restricted-1',
    agent: restricted,
    userMessage: 'try to remember something',
  });

  assert.equal(session.status, 'completed');
  assert.deepEqual(await memory.list(restricted.id), []);
});

test('router sends inputs to the right agent with a fallback', () => {
  const support = defineAgent({ name: 'Mabel Greer' });
  const engineer = defineAgent({ name: 'Theo Castillo' });
  const general = defineAgent({ name: 'Uma Winslow' });

  const router = createAgentRouter(
    [
      { match: /^#support/, agent: support },
      { match: (input) => input.includes('deploy'), agent: engineer },
    ],
    general,
  );

  assert.equal(router.route('#support: my login is broken').id, support.id);
  assert.equal(router.route('can someone deploy the fix?').id, engineer.id);
  assert.equal(router.route('hello there').id, general.id);
});
