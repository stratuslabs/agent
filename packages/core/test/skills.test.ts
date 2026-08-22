import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentRunner,
  DuplicateSkillIdError,
  InMemorySessionStore,
  SKILL_READ_TOOL_NAME,
  SkillRegistry,
  ToolRegistry,
  createSkillReadTool,
  matchesSkillAllowlist,
  renderSystemPrompt,
  toolAllowlistCovers,
  type ModelProvider,
  type ProviderRequest,
  type ProviderResponse,
  type Session,
  type Skill,
  type SkillDescriptor,
  type Tool,
  type ToolDescriptor,
} from '../src/index.ts';

const skill = (id: string, overrides: Partial<Skill> = {}): Skill => ({
  id,
  name: overrides.name ?? id,
  description: overrides.description ?? `Use when the task is ${id}.`,
  ...(overrides.requires ? { requires: overrides.requires } : {}),
  load: overrides.load ?? (async () => `# ${id}\n\nThe full procedure for ${id}.`),
});

const tool = (name: string): Tool => ({
  name,
  risk: 'safe',
  async execute() {
    return { ran: name };
  },
});

test('a skill glob selects its package and nothing that merely starts like it', () => {
  assert.equal(matchesSkillAllowlist('code-review', ['code-review']), true);
  assert.equal(matchesSkillAllowlist('web-research', ['code-review']), false);

  // The qualified form is what a package's skills are granted under.
  assert.equal(matchesSkillAllowlist('stratus-plugin-github:pr-review', ['stratus-plugin-github:*']), true);
  assert.equal(matchesSkillAllowlist('stratus-plugin-github:triage', ['stratus-plugin-github:*']), true);

  // The colon belongs to the prefix: a package cannot be widened into by
  // one that named itself to look like a prefix of it.
  assert.equal(matchesSkillAllowlist('stratus-plugin-github2:pr-review', ['stratus-plugin-github:*']), false);
  assert.equal(matchesSkillAllowlist('stratus-plugin-github', ['stratus-plugin-github:*']), false);

  assert.equal(matchesSkillAllowlist('anything', ['*']), true);
  assert.equal(matchesSkillAllowlist('anything', []), false);
});

test('a duplicate skill id is a load-time error, never a silent overwrite', () => {
  const registry = new SkillRegistry();
  registry.register(skill('code-review'));
  assert.throws(() => registry.register(skill('code-review')), DuplicateSkillIdError);
});

test('a bare alias yields to an operator skill and dies contested, staying reachable qualified', async () => {
  const registry = new SkillRegistry();
  // The operator's own skill owns the bare id.
  registry.register(skill('pr-review', { description: 'The operator copy.' }));
  registry.register(skill('stratus-plugin-github:pr-review', { description: 'The github copy.' }));
  registry.registerAlias('pr-review', 'stratus-plugin-github:pr-review');
  assert.equal(registry.resolve('pr-review')?.description, 'The operator copy.');
  assert.equal(registry.resolve('stratus-plugin-github:pr-review')?.description, 'The github copy.');

  // Two plugins both wanting a bare id leave it to neither — for good,
  // so which package loads first can never flip what the bare id selects.
  registry.register(skill('acme:triage'));
  registry.register(skill('other:triage'));
  registry.registerAlias('triage', 'acme:triage');
  registry.registerAlias('triage', 'other:triage');
  assert.equal(registry.resolve('triage'), undefined);
  registry.registerAlias('triage', 'acme:triage');
  assert.equal(registry.resolve('triage'), undefined);
  assert.equal(registry.resolve('acme:triage')?.id, 'acme:triage');
  assert.equal(registry.resolve('other:triage')?.id, 'other:triage');
});

test('a body read three times hits the loader once, by any of its ids', async () => {
  const registry = new SkillRegistry();
  let loads = 0;
  registry.register(skill('acme:review', {
    load: async () => {
      loads += 1;
      return 'the body';
    },
  }));
  registry.registerAlias('review', 'acme:review');

  assert.equal(await registry.read('acme:review'), 'the body');
  assert.equal(await registry.read('review'), 'the body');
  assert.equal(await registry.read('acme:review'), 'the body');
  assert.equal(loads, 1);
});

test('a failed read is not cached: the next attempt loads again', async () => {
  const registry = new SkillRegistry();
  let attempts = 0;
  registry.register(skill('flaky', {
    load: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('disk hiccup');
      }
      return 'recovered';
    },
  }));
  await assert.rejects(() => registry.read('flaky'), /disk hiccup/);
  assert.equal(await registry.read('flaky'), 'recovered');
});

test('twenty enabled skills send twenty lines, never a body', () => {
  const descriptors: SkillDescriptor[] = [];
  const bodies: string[] = [];
  for (let index = 0; index < 20; index += 1) {
    descriptors.push({
      id: `skill-${index}`,
      name: `Skill ${index}`,
      description: `Use when the task is number ${index}.`,
    });
    bodies.push(`BODY-SENTINEL-${index} ${'procedure detail. '.repeat(200)}`);
  }

  const prompt = renderSystemPrompt({
    session: {
      agent: { id: 'ava', name: 'Ava', instructions: 'Be sharp.' },
    } as Session,
    skills: descriptors,
  });

  assert.ok(prompt);
  for (const descriptor of descriptors) {
    assert.ok(prompt.includes(descriptor.description), `missing the line for ${descriptor.id}`);
  }
  // The whole point of the step: the prompt's size tracks the sum of the
  // description lines, not the bodies. A single leaked body (~3KB each
  // here) blows through this bound and fails the assertion.
  const descriptionBudget = descriptors.reduce(
    (total, entry) => total + entry.id.length + entry.name.length + entry.description.length + 16,
    0,
  );
  const structuralOverhead = 600; // persona line, headers, joins
  assert.ok(
    prompt.length <= descriptionBudget + structuralOverhead,
    `prompt is ${prompt.length} chars for a ${descriptionBudget}-char description budget — a body leaked in`,
  );
  assert.ok(!prompt.includes('BODY-SENTINEL'), 'a skill body leaked into the system prompt');
});

test('skill.read outside the soul allowlist is refused by the allowlist, not a second copy of it', async () => {
  const registry = new SkillRegistry();
  registry.register(skill('code-review'));
  registry.register(skill('deploy'));
  const reader = createSkillReadTool(registry);
  const session = {
    id: 's1',
    agent: { id: 'ava', name: 'Ava', skills: ['code-review'] },
  } as Session;

  const allowed = await reader.execute({ id: 'code-review' }, session) as { body: string };
  assert.match(allowed.body, /full procedure for code-review/);

  await assert.rejects(
    () => reader.execute({ id: 'deploy' }, session),
    /Skill not permitted for agent ava: deploy/,
  );
  // Permission answers before existence, so an agent with no grant learns
  // nothing about what is installed.
  await assert.rejects(
    () => reader.execute({ id: 'nonexistent' }, session),
    /Skill not permitted/,
  );
  await assert.rejects(
    () => reader.execute({ id: 'code-review' }, { ...session, agent: { id: 'kai', name: 'Kai' } } as Session),
    /Skill not permitted for agent kai/,
  );
});

test('a qualified grant covers a read by the bare alias — permission is about the skill', async () => {
  const registry = new SkillRegistry();
  registry.register(skill('stratus-plugin-github:pr-review'));
  registry.registerAlias('pr-review', 'stratus-plugin-github:pr-review');
  const reader = createSkillReadTool(registry);
  const session = {
    id: 's1',
    agent: { id: 'ava', name: 'Ava', skills: ['stratus-plugin-github:*'] },
  } as Session;

  const viaAlias = await reader.execute({ id: 'pr-review' }, session) as { id: string };
  assert.equal(viaAlias.id, 'stratus-plugin-github:pr-review');
});

// The two-gate acceptance tests. Two tests, not one, because there are two
// gates: the reader is *advertised* (descriptor filter) and the call
// *executes* (executeToolCall). Exempting only the first would pass a test
// that asserts the tool is offered while the agent is still refused when
// it uses it.

const capturingProvider = (
  script: (turn: number, request: ProviderRequest) => ProviderResponse,
): { provider: ModelProvider; requests: ProviderRequest[] } => {
  const requests: ProviderRequest[] = [];
  let turn = 0;
  return {
    requests,
    provider: {
      name: 'scripted',
      async generate(request: ProviderRequest): Promise<ProviderResponse> {
        requests.push(request);
        turn += 1;
        return script(turn, request);
      },
    },
  };
};

test('gate 1: skill.read is advertised to an agent whose tools list does not name it', async () => {
  const skills = new SkillRegistry();
  skills.register(skill('code-review'));
  const tools = new ToolRegistry();
  tools.register(tool('demo.echo'));

  const { provider, requests } = capturingProvider(() => ({ parts: [{ type: 'text', text: 'ok' }] }));
  const runner = new AgentRunner({ provider, tools, skills, store: new InMemorySessionStore() });
  await runner.initialize();

  await runner.run({
    sessionId: 'gate1',
    agent: { id: 'ava', name: 'Ava', tools: ['demo.echo'], skills: ['code-review'] },
    userMessage: 'go',
  });

  const advertised = (requests[0]?.tools ?? []).map((entry: ToolDescriptor) => entry.name);
  assert.ok(advertised.includes(SKILL_READ_TOOL_NAME), `skill.read missing from ${advertised.join(', ')}`);
  // And the enabled skills rode along as descriptors, one line each.
  assert.deepEqual(requests[0]?.skills?.map((entry) => entry.id), ['code-review']);
});

test('gate 2: skill.read executes for that same agent, and returns the body', async () => {
  const skills = new SkillRegistry();
  skills.register(skill('code-review'));
  const tools = new ToolRegistry();
  tools.register(tool('demo.echo'));

  const { provider } = capturingProvider((turn) => (turn === 1
    ? { parts: [{ type: 'tool-call', call: { id: 'c1', toolName: SKILL_READ_TOOL_NAME, input: { id: 'code-review' } } }] }
    : { parts: [{ type: 'text', text: 'done' }] }));
  const runner = new AgentRunner({ provider, tools, skills, store: new InMemorySessionStore() });
  await runner.initialize();

  const session = await runner.run({
    sessionId: 'gate2',
    agent: { id: 'ava', name: 'Ava', tools: ['demo.echo'], skills: ['code-review'] },
    userMessage: 'go',
  });

  const result = session.messages.find((message) => message.role === 'tool')?.toolResult;
  assert.equal(result?.ok, true);
  assert.match(JSON.stringify(result?.output), /full procedure for code-review/);
});

test('an agent with no skills key sees no reader, no skills, and gets refused if it calls anyway', async () => {
  const skills = new SkillRegistry();
  skills.register(skill('code-review'));
  const tools = new ToolRegistry();
  tools.register(tool('demo.echo'));

  const { provider, requests } = capturingProvider((turn) => (turn === 1
    // A model can call the reader by name without it being advertised —
    // from a remembered turn, or through a hosted provider's inner loop.
    ? { parts: [{ type: 'tool-call', call: { id: 'c1', toolName: SKILL_READ_TOOL_NAME, input: { id: 'code-review' } } }] }
    : { parts: [{ type: 'text', text: 'done' }] }));
  const runner = new AgentRunner({ provider, tools, skills, store: new InMemorySessionStore() });
  await runner.initialize();

  const session = await runner.run({
    sessionId: 'no-skills',
    // No skills: — and a tools list permissive enough to include the
    // reader if it were an ordinary tool.
    agent: { id: 'kai', name: 'Kai', tools: ['*'] },
    userMessage: 'go',
  });

  const advertised = (requests[0]?.tools ?? []).map((entry: ToolDescriptor) => entry.name);
  assert.ok(!advertised.includes(SKILL_READ_TOOL_NAME), 'an agent with no skills was shown the reader');
  assert.equal(requests[0]?.skills, undefined);

  const result = session.messages.find((message) => message.role === 'tool')?.toolResult;
  assert.equal(result?.ok, false);
  assert.match(result?.error ?? '', /Tool not permitted for agent kai: skill\.read/);
});

test('an empty skills list is the same as none', async () => {
  const skills = new SkillRegistry();
  skills.register(skill('code-review'));
  const { provider, requests } = capturingProvider(() => ({ parts: [{ type: 'text', text: 'ok' }] }));
  const runner = new AgentRunner({ provider, tools: new ToolRegistry(), skills, store: new InMemorySessionStore() });
  await runner.initialize();

  await runner.run({
    sessionId: 'empty-skills',
    agent: { id: 'kai', name: 'Kai', skills: [] },
    userMessage: 'go',
  });

  assert.equal(requests[0]?.skills, undefined);
  assert.ok(!(requests[0]?.tools ?? []).some((entry: ToolDescriptor) => entry.name === SKILL_READ_TOOL_NAME));
});

test('the descriptor an agent is shown carries the id its allowlist granted', async () => {
  const skills = new SkillRegistry();
  skills.register(skill('stratus-plugin-github:pr-review'));
  skills.registerAlias('pr-review', 'stratus-plugin-github:pr-review');
  const { provider, requests } = capturingProvider(() => ({ parts: [{ type: 'text', text: 'ok' }] }));
  const runner = new AgentRunner({ provider, tools: new ToolRegistry(), skills, store: new InMemorySessionStore() });
  await runner.initialize();

  // Granted by the qualified glob: the prompt names the qualified id.
  await runner.run({
    sessionId: 'granted-qualified',
    agent: { id: 'ava', name: 'Ava', skills: ['stratus-plugin-github:*'] },
    userMessage: 'go',
  });
  assert.deepEqual(requests[0]?.skills?.map((entry) => entry.id), ['stratus-plugin-github:pr-review']);

  // Granted by the bare alias: the prompt names the alias.
  await runner.run({
    sessionId: 'granted-bare',
    agent: { id: 'kai', name: 'Kai', skills: ['pr-review'] },
    userMessage: 'go',
  });
  assert.deepEqual(requests[1]?.skills?.map((entry) => entry.id), ['pr-review']);
});

test('toolAllowlistCovers reads requires entries the way the warning needs', () => {
  // No allowlist is every tool.
  assert.equal(toolAllowlistCovers('browser.*', undefined), true);
  assert.equal(toolAllowlistCovers('fs.read', ['fs.*']), true);
  assert.equal(toolAllowlistCovers('fs.read', ['shell.run']), false);
  // A glob requirement is covered by the glob, by *, or by anything inside it.
  assert.equal(toolAllowlistCovers('browser.*', ['browser.*']), true);
  assert.equal(toolAllowlistCovers('browser.*', ['*']), true);
  assert.equal(toolAllowlistCovers('browser.*', ['browser.goto']), true);
  assert.equal(toolAllowlistCovers('browser.*', ['fs.*']), false);
});
