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
  formatSoul,
  generateAgentName,
  generateAvatarTheme,
  parseSoul,
  isValidAgentId,
} from '../src/index.ts';

test('generateAgentName is a human-ish first name, deterministic for a seed', () => {
  const seeded = generateAgentName('fixed-seed');
  assert.equal(seeded, generateAgentName('fixed-seed'));
  assert.match(seeded, /^[A-Z][a-z]+$/);

  const random = generateAgentName();
  assert.match(random, /^[A-Z][a-z]+$/);
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
  // Every Stratus agent shares the one house style.
  assert.equal(theme.style, 'stratus');
  assert.equal(generateAvatarTheme('Uma').style, 'stratus');
});

test('defineAgent fills in identity, avatar, and slug id with zero input', () => {
  const agent = defineAgent({ seed: 'zero-input' });
  assert.match(agent.name, /^[A-Z][a-z]+$/);
  assert.match(agent.id, /^[a-z0-9-]+-[0-9a-z]{4}$/);
  assert.equal(agent.avatar?.seed, agent.name);

  // Generated ids are deterministic per seed, distinct across seeds, and
  // unique even for two unseeded agents that could share a display name.
  assert.equal(agent.id, defineAgent({ seed: 'zero-input' }).id);
  assert.notEqual(agent.id, defineAgent({ seed: 'other-seed' }).id);
  assert.notEqual(defineAgent().id, defineAgent().id);

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

  const toolMessage = session.messages.find((message) => message.role === 'tool');
  const output = toolMessage?.toolResult?.output as { sessionId?: string } | null;
  assert.match(output?.sessionId ?? '', /^root-1:delegate:priya-salinger:1:/);
  const subSession = await runner.store.get(output?.sessionId ?? '');
  assert.equal(subSession?.status, 'completed');
  assert.equal(subSession?.metadata?.delegatedBy, orchestrator.id);
  assert.equal(subSession?.metadata?.rootSessionId, 'root-1');

  // Repeated delegation to the same target must never collide on session id.
  const delegate = createDelegateTool({ registry, runner });
  const first = (await delegate.execute(
    { agent: 'Priya Salinger', prompt: 'once more' },
    session,
  )) as { sessionId: string };
  const second = (await delegate.execute(
    { agent: 'Priya Salinger', prompt: 'and again' },
    session,
  )) as { sessionId: string };
  assert.notEqual(first.sessionId, second.sessionId);
  assert.ok(await runner.store.get(first.sessionId));
  assert.ok(await runner.store.get(second.sessionId));
});

test('delegation by an ambiguous display name fails instead of picking an agent', async () => {
  const umaOne = defineAgent({ name: 'Uma', id: 'uma-one' });
  const umaTwo = defineAgent({ name: 'Uma', id: 'uma-two' });
  const orchestrator = defineAgent({ name: 'Theo' });
  const registry = createAgentTeam([umaOne, umaTwo, orchestrator]);

  const provider: ModelProvider = {
    name: 'noop',
    async generate() {
      return { parts: [{ type: 'text', text: 'ok' }] };
    },
  };
  const runner = new AgentRunner({ provider, agents: registry });
  const tool = createDelegateTool({ registry, runner });

  const session: Session = {
    id: 's',
    agent: orchestrator,
    status: 'running',
    messages: [],
    createdAt: '',
    updatedAt: '',
  };

  await assert.rejects(
    () => tool.execute({ agent: 'Uma', prompt: 'hi' }, session),
    /Agent name is ambiguous: Uma \(ids: uma-one, uma-two\)/,
  );

  // Ids always stay unambiguous.
  const result = (await tool.execute({ agent: 'uma-two', prompt: 'hi' }, session)) as {
    agent: string;
  };
  assert.equal(result.agent, 'Uma');
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

  // Global/sticky regexes must not alternate between hit and miss.
  const statefulRouter = createAgentRouter([{ match: /^#support/g, agent: support }], general);
  assert.equal(statefulRouter.route('#support: one').id, support.id);
  assert.equal(statefulRouter.route('#support: two').id, support.id);
  assert.equal(statefulRouter.route('#support: three').id, support.id);

  // Sticky regexes keep their anchored-at-start semantics.
  const stickyRouter = createAgentRouter([{ match: /support/y, agent: support }], general);
  assert.equal(stickyRouter.route('support ticket').id, support.id);
  assert.equal(stickyRouter.route('please contact support').id, general.id);
  assert.equal(stickyRouter.route('support again').id, support.id);
});

test('parseSoul turns a full soul file into an agent definition', () => {
  const soul = parseSoul(`---
name: Ava
provider: anthropic
model: claude-opus-5
tools:
  - demo.echo
  - memory.remember
credentials:
  - ANTHROPIC_API_KEY
---

You are warm and precise. You keep replies short and never use jargon.
`);

  assert.equal(soul.agent.name, 'Ava');
  assert.equal(soul.agent.id, 'ava');
  assert.equal(soul.provider, 'anthropic');
  assert.equal(soul.model, 'claude-opus-5');
  assert.deepEqual(soul.agent.tools, ['demo.echo', 'memory.remember']);
  assert.deepEqual(soul.agent.credentials, ['ANTHROPIC_API_KEY']);
  assert.equal(
    soul.agent.instructions,
    'You are warm and precise. You keep replies short and never use jargon.',
  );
  assert.equal(soul.agent.avatar?.seed, 'Ava');
});

test('parseSoul treats a file without frontmatter as pure persona', () => {
  const soul = parseSoul('Always answer in haiku.\n', { seed: 'haiku-soul' });

  assert.equal(soul.agent.instructions, 'Always answer in haiku.');
  assert.equal(soul.provider, undefined);
  assert.equal(soul.model, undefined);
  // No name in the soul: one is generated, deterministically under a seed.
  assert.equal(soul.agent.name, parseSoul('Other prose', { seed: 'haiku-soul' }).agent.name);
});

test('parseSoul supports inline lists, quotes, comments, and explicit ids', () => {
  const soul = parseSoul(`---
# identity
name: "Kai"
id: kai-prod
tools: [demo.echo, 'memory.remember']
---
Be direct.`);

  assert.equal(soul.agent.name, 'Kai');
  assert.equal(soul.agent.id, 'kai-prod');
  assert.deepEqual(soul.agent.tools, ['demo.echo', 'memory.remember']);
  assert.equal(soul.agent.instructions, 'Be direct.');
});

test('parseSoul rejects malformed frontmatter with helpful errors', () => {
  assert.throws(() => parseSoul('---\nname: Ava\n'), /never closed/);
  assert.throws(() => parseSoul('---\nnickname: Av\n---\nHi'), /Unknown soul frontmatter key/);
  assert.throws(() => parseSoul('---\nname:\n---\nHi'), /has no value/);
  assert.throws(() => parseSoul('---\n  - stray\n---\nHi'), /outside a list/);
  assert.throws(() => parseSoul('---\nnot a mapping\n---\nHi'), /key: value/);
});

test('formatSoul round-trips through parseSoul', () => {
  const original = parseSoul(`---
name: Wren
provider: anthropic
model: claude-opus-5
tools:
  - demo.echo
---
Curious, a little playful, always cites sources.`);

  const reparsed = parseSoul(formatSoul(original));

  assert.equal(reparsed.agent.name, original.agent.name);
  assert.equal(reparsed.agent.id, original.agent.id);
  assert.equal(reparsed.provider, original.provider);
  assert.equal(reparsed.model, original.model);
  assert.deepEqual(reparsed.agent.tools, original.agent.tools);
  assert.equal(reparsed.agent.instructions, original.agent.instructions);
});

test('delegation forwards the parent turn abort signal into the dispatcher', async () => {
  const orchestrator = defineAgent({ name: 'Orchestrator', instructions: 'You orchestrate.' });
  const target = defineAgent({ name: 'Target', instructions: 'You help.' });
  const registry = createAgentTeam([orchestrator, target]);

  let receivedSignal: AbortSignal | undefined;
  const tool = createDelegateTool({
    registry,
    dispatch: async (input) => {
      receivedSignal = input.signal;
      return {
        id: input.sessionId,
        agent: input.agent,
        status: 'completed',
        messages: [
          { id: 'm1', role: 'assistant', content: 'done', createdAt: new Date().toISOString() },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    },
  });

  const controller = new AbortController();
  const session = {
    id: 'parent-1',
    agent: orchestrator,
    status: 'running' as const,
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await tool.execute({ agent: 'Target', prompt: 'go' }, session, { signal: controller.signal });
  assert.equal(receivedSignal, controller.signal);
});

test('an explicit agent id must be a slug, because ids become paths', async () => {
  // A soul file travels with a repository, and in the hosted profile the
  // id comes from a tenant. It keys sessions, memory, credentials, Slack
  // tokens, and per-agent paths — so the shape is enforced once, here,
  // rather than defended at every join.
  const rejected = [
    '../../escape',
    'a/b',
    'a\\b',
    '.hidden',
    '-leading',
    'Upper',
    'has space',
    'trailing.',
    '',
    'x'.repeat(65),
  ];
  for (const id of rejected) {
    assert.throws(
      () => defineAgent({ name: 'Ava', id }),
      /Invalid agent id/,
      `expected ${JSON.stringify(id)} to be rejected`,
    );
  }

  // Rejected, never sanitized: quietly rewriting `../../escape` to
  // `escape` would hand back an agent nobody asked for, keyed to
  // resources nobody named.
  for (const id of ['ava', 'ava-2', 'a', '0', 'a-b-c', 'x'.repeat(64)]) {
    assert.equal(defineAgent({ name: 'Ava', id }).id, id);
  }

  // Derived ids come out of slugify and cannot be anything else.
  assert.equal(isValidAgentId(defineAgent({ name: 'Ava Löf!' }).id), true);
  assert.equal(isValidAgentId(defineAgent({ seed: 'x' }).id), true);
});

test('a soul declaring a path-capable id is rejected at parse', async () => {
  assert.throws(
    () => parseSoul('---\nname: Ava\nid: ../../escape\n---\n\nYou are Ava.\n'),
    /Invalid agent id/,
  );
  // The rule lives in one place; parseSoul inherits it rather than
  // repeating it.
  assert.equal(parseSoul('---\nname: Ava\nid: ava\n---\n\nYou are Ava.\n').agent.id, 'ava');
});
