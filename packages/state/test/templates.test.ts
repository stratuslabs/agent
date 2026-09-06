import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createDelegateTool,
  createForgetTool,
  createMessageSendTool,
  createRecallTool,
  createRememberTool,
  createScheduleTools,
  defineAgent,
  type SchedulerHandle,
} from '@stratusagent/agents';
import {
  AgentRegistry,
  SkillRegistry,
  createSkillReadTool,
  resolveToolRisk,
  type AgentDefinition,
  type AgentRunner,
  type JsonObject,
  type JsonValue,
  type Tool,
} from '@stratusagent/core';

import {
  AGENT_TEMPLATES,
  AGENT_TEMPLATE_VERSION,
  KERNEL_TOOL_RISKS,
  TemplateApplyError,
  agentTemplateIds,
  applyAgentTemplate,
  claimSoulFile,
  configLockPath,
  decidePluginConfig,
  findAgentTemplate,
  planAgentTemplate,
  createFileMemoryStore,
  planRiskCeiling,
  type AgentTemplate,
  type TemplatePlan,
} from '../src/index.ts';

const newHome = async (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'stratus-template-'));

/**
 * A module host over package.json files written into a temp directory: the
 * planner reads manifests without importing anything, so a fixture package
 * is a directory with a package.json in it and nothing else.
 */
const fakeHost = (packages: Record<string, JsonObject>, root: string) => ({
  resolve(specifier: string): string {
    if (!(specifier in packages)) {
      throw new Error(`Cannot find package '${specifier}'`);
    }
    return `file://${path.join(root, specifier.replace(/\//g, '__'), 'index.js')}`;
  },
  async import(): Promise<unknown> {
    throw new Error('the planner must never import a plugin');
  },
});

const writeFixturePackages = async (
  root: string,
  packages: Record<string, JsonObject>,
): Promise<void> => {
  for (const [specifier, packageJson] of Object.entries(packages)) {
    const directory = path.join(root, specifier.replace(/\//g, '__'));
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'package.json'), JSON.stringify(packageJson));
  }
};

const firstPartyFs: JsonObject = {
  name: '@stratusagent/tool-fs',
  version: '9.9.9',
  stratus: {
    pluginVersion: 1,
    contributes: {
      tools: [
        { name: 'fs.read', risk: 'safe' },
        { name: 'fs.write', risk: 'gated' },
      ],
    },
    config: { type: 'object', properties: { roots: { type: 'array', items: { type: 'string' } } } },
  },
};

/** A third-party package whose manifest calls its own shell tool `safe`. */
const thirdPartyShell: JsonObject = {
  name: 'somebody-elses-shell',
  version: '1.0.0',
  stratus: {
    pluginVersion: 1,
    contributes: { tools: [{ name: 'shell.run', risk: 'safe' }] },
  },
};

const templateWith = (overrides: Partial<AgentTemplate>): AgentTemplate => ({
  templateVersion: AGENT_TEMPLATE_VERSION,
  id: 'fixture',
  title: 'Fixture',
  summary: 'A template written for a test.',
  defaultName: 'Fixie',
  persona: 'You exist to be planned.',
  tools: [],
  skills: [],
  credentials: [],
  plugins: [],
  ...overrides,
});

interface PlanFixture {
  home: string;
  packagesRoot: string;
  agent: AgentDefinition;
}

const planFor = async (
  template: AgentTemplate,
  fixture: PlanFixture,
  packages: Record<string, JsonObject>,
  config: { plugins?: Record<string, JsonObject> } = {},
): Promise<TemplatePlan> => planAgentTemplate({
  template,
  agent: fixture.agent,
  soulPath: path.join(fixture.home, '.stratus', 'agents', `${fixture.agent.id}.md`),
  configPath: path.join(fixture.home, '.stratus', 'config.json'),
  config,
  workspacePath: path.join(fixture.home, '.stratus', 'workspaces', fixture.agent.id),
  host: fakeHost(packages, fixture.packagesRoot),
  credentials: { shared: {}, agents: {} },
  installedSkills: [],
});

const newFixture = async (name = 'Fixie'): Promise<PlanFixture> => {
  const home = await newHome();
  const packagesRoot = path.join(home, 'node_modules');
  return { home, packagesRoot, agent: defineAgent({ name, instructions: 'persona' }) };
};

// ---- what the summary says --------------------------------------------------

test('the summary reports the floored risk, not the risk a manifest claims', async () => {
  const fixture = await newFixture();
  const packages = { 'somebody-elses-shell': thirdPartyShell };
  await writeFixturePackages(fixture.packagesRoot, packages);

  const plan = await planFor(
    templateWith({
      tools: ['shell.run'],
      plugins: [{ package: 'somebody-elses-shell', reason: 'running commands' }],
    }),
    fixture,
    packages,
  );

  const [grant] = plan.tools;
  const [tool] = grant?.resolves ?? [];
  assert.equal(tool?.name, 'shell.run');
  // The package's own manifest says `safe`. It is not a claim the code
  // being judged gets to make about itself.
  assert.equal(tool?.risk, 'gated');
  assert.equal(tool?.declaredRisk, 'safe');
  assert.equal(tool?.raisedBy, 'floor');
  assert.equal(planRiskCeiling(plan), 'gated');
});

test('a first-party manifest keeps the risks it declares', async () => {
  const fixture = await newFixture();
  const packages = { '@stratusagent/tool-fs': firstPartyFs };
  await writeFixturePackages(fixture.packagesRoot, packages);

  const plan = await planFor(
    templateWith({
      tools: ['fs.read', 'fs.write'],
      plugins: [{ package: '@stratusagent/tool-fs', reason: 'files' }],
    }),
    fixture,
    packages,
  );

  assert.deepEqual(
    plan.tools.flatMap((grant) => grant.resolves.map((tool) => [tool.name, tool.risk])),
    [['fs.read', 'safe'], ['fs.write', 'gated']],
  );
  assert.equal(plan.tools.every((grant) => grant.resolves[0]?.declaredRisk === undefined), true);
});

test('an operator risk override is what the summary reports, and says so', async () => {
  const fixture = await newFixture();
  const packages = { 'somebody-elses-shell': thirdPartyShell };
  await writeFixturePackages(fixture.packagesRoot, packages);

  const plan = await planFor(
    templateWith({
      tools: ['shell.run'],
      plugins: [{ package: 'somebody-elses-shell', reason: 'running commands' }],
    }),
    fixture,
    packages,
    { plugins: { 'somebody-elses-shell': { enabled: true, toolRisks: { 'shell.run': 'dangerous' } } } },
  );

  const tool = plan.tools[0]?.resolves[0];
  assert.equal(tool?.risk, 'dangerous');
  assert.equal(tool?.raisedBy, 'override');
  assert.equal(planRiskCeiling(plan), 'dangerous');
});

test('a wildcard is disclosed as a wildcard, never expanded and forgotten', async () => {
  const fixture = await newFixture();
  const packages = { '@stratusagent/tool-fs': firstPartyFs };
  await writeFixturePackages(fixture.packagesRoot, packages);

  const plan = await planFor(
    templateWith({
      tools: ['fs.*'],
      plugins: [{ package: '@stratusagent/tool-fs', reason: 'files' }],
    }),
    fixture,
    packages,
  );

  const [grant] = plan.tools;
  assert.equal(grant?.entry, 'fs.*', 'the entry the soul carries, not the list it reaches today');
  assert.equal(grant?.wildcard, true);
  assert.deepEqual(grant?.resolves.map((tool) => tool.name), ['fs.read', 'fs.write']);
});

test('no shipped template grants a glob', () => {
  for (const template of AGENT_TEMPLATES) {
    for (const entry of template.tools) {
      assert.ok(
        !entry.includes('*'),
        `${template.id} grants ${entry}: a glob keeps admitting tools a later plugin update adds`,
      );
    }
  }
});

test('an allowlist entry nothing answers is reported as granting nothing', async () => {
  const fixture = await newFixture();
  const plan = await planFor(templateWith({ tools: ['nowhere.at-all'] }), fixture, {});
  assert.equal(plan.tools[0]?.unresolved, true);
  assert.deepEqual(plan.tools[0]?.resolves, []);
});

test('kernel tools resolve with no plugin installed at all', async () => {
  const fixture = await newFixture();
  const plan = await planFor(templateWith({ tools: ['memory.remember', 'schedule.every'] }), fixture, {});
  assert.deepEqual(
    plan.tools.map((grant) => [grant.entry, grant.resolves[0]?.risk]),
    [['memory.remember', 'safe'], ['schedule.every', 'gated']],
  );
});

// ---- prerequisites and conflict --------------------------------------------

test('a template naming an uninstalled plugin blocks with the install command', async () => {
  const fixture = await newFixture();
  const plan = await planFor(
    templateWith({
      tools: ['fs.read'],
      plugins: [{ package: '@stratusagent/tool-fs', reason: 'files' }],
    }),
    fixture,
    {},
  );

  assert.equal(plan.plugins[0]?.status, 'missing');
  assert.equal(plan.blockers.length, 1);
  assert.match(plan.blockers[0]?.message ?? '', /npm install -g @stratusagent\/tool-fs/);
  assert.equal(plan.blockers[0]?.kind, 'missing-plugin');
});

test('settings the template contradicts are a conflict naming both values', async () => {
  const fixture = await newFixture();
  const packages = { '@stratusagent/tool-fs': firstPartyFs };
  await writeFixturePackages(fixture.packagesRoot, packages);

  const plan = await planFor(
    templateWith({
      tools: ['fs.read'],
      plugins: [{ package: '@stratusagent/tool-fs', reason: 'files', settings: { roots: ['/a'] } }],
    }),
    fixture,
    packages,
    { plugins: { '@stratusagent/tool-fs': { enabled: true, roots: ['/b'] } } },
  );

  const outcome = plan.plugins[0];
  assert.equal(outcome?.status, 'conflict');
  assert.deepEqual(outcome?.status === 'conflict' ? outcome.conflicts : [], [
    { key: 'roots', existing: ['/b'], requested: ['/a'] },
  ]);
  assert.match(plan.blockers[0]?.message ?? '', /yours is \["\/b"\], the template asks for \["\/a"\]/);
});

test('a block already saying what the template needs is reused, not rewritten', async () => {
  const fixture = await newFixture();
  const packages = { '@stratusagent/tool-fs': firstPartyFs };
  await writeFixturePackages(fixture.packagesRoot, packages);

  const plan = await planFor(
    templateWith({
      tools: ['fs.read'],
      plugins: [{ package: '@stratusagent/tool-fs', reason: 'files', settings: { roots: ['/a'] } }],
    }),
    fixture,
    packages,
    { plugins: { '@stratusagent/tool-fs': { enabled: true, roots: ['/a'], maxBytes: 10 } } },
  );

  assert.equal(plan.plugins[0]?.status, 'reuse', 'a setting the template does not mention is not a conflict');
  assert.deepEqual(plan.blockers, []);
});

test('an enabled:false block the template needs on is a conflict, never a silent flip', () => {
  const decided = decidePluginConfig(
    templateWith({ plugins: [{ package: 'p', reason: 'r' }] }),
    { agentId: 'a', agentName: 'A', workspacePath: '/w' },
    { p: { enabled: false } },
  );
  const outcome = decided.get('p');
  assert.equal(outcome?.status, 'conflict');
  assert.deepEqual(outcome?.status === 'conflict' ? outcome.conflicts : [], [
    { key: 'enabled', existing: false, requested: true },
  ]);
});

// ---- committing -------------------------------------------------------------

interface ApplyHarness {
  home: string;
  configPath: string;
  soulPath: string;
  claimed: AgentDefinition;
}

const applyFixture = async (
  plan: TemplatePlan,
  home: string,
  overrides: Partial<Parameters<typeof applyAgentTemplate>[0]> = {},
) => {
  const configPath = path.join(home, '.stratus', 'config.json');
  return applyAgentTemplate({
    plan,
    claimSoul: async (render) => {
      const soulPath = path.join(home, '.stratus', 'agents', `${plan.agent.id}.md`);
      await mkdir(path.dirname(soulPath), { recursive: true });
      await writeFile(soulPath, render(plan.agent), { flag: 'wx' });
      return { agent: plan.agent, soulPath };
    },
    renderSoul: (agent) => `soul for ${agent.id}\n`,
    workspacePathFor: (agentId) => path.join(home, '.stratus', 'workspaces', agentId),
    readConfig: async () => {
      try {
        return JSON.parse(await readFile(configPath, 'utf8')) as Record<string, JsonValue>;
      } catch {
        return {};
      }
    },
    writeConfig: async (config) => {
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    },
    removeSoul: (soulPath) => rm(soulPath, { force: true }),
    lockPath: configLockPath({ homeDir: home }),
    ...overrides,
  });
};

test('soul and configuration commit together, and a failure between them leaves neither', async () => {
  const fixture = await newFixture();
  const packages = { '@stratusagent/tool-fs': firstPartyFs };
  await writeFixturePackages(fixture.packagesRoot, packages);
  const plan = await planFor(
    templateWith({
      tools: ['fs.read'],
      plugins: [{ package: '@stratusagent/tool-fs', reason: 'files' }],
    }),
    fixture,
    packages,
  );

  // Forced, not inspected: the point is that the path which runs rolls
  // back, and a test asserting it by reading the code proves nothing.
  await assert.rejects(
    applyFixture(plan, fixture.home, {
      beforeConfigWrite: async () => {
        throw new Error('the disk went away');
      },
    }),
    /the disk went away/,
  );

  await assert.rejects(
    stat(path.join(fixture.home, '.stratus', 'agents', `${plan.agent.id}.md`)),
    { code: 'ENOENT' },
    'no soul',
  );
  await assert.rejects(
    stat(path.join(fixture.home, '.stratus', 'config.json')),
    { code: 'ENOENT' },
    'no config entry',
  );
});

test('a plan with blockers writes nothing at all', async () => {
  const fixture = await newFixture();
  const plan = await planFor(
    templateWith({
      tools: ['fs.read'],
      plugins: [{ package: '@stratusagent/tool-fs', reason: 'files' }],
    }),
    fixture,
    {},
  );

  await assert.rejects(applyFixture(plan, fixture.home), TemplateApplyError);
  await assert.rejects(stat(path.join(fixture.home, '.stratus', 'agents')), { code: 'ENOENT' });
});

test('two creations racing on one config file both land, and neither loses the other', async () => {
  const home = await newHome();
  const packagesRoot = path.join(home, 'node_modules');
  const packages = { '@stratusagent/tool-fs': firstPartyFs, 'somebody-elses-shell': thirdPartyShell };
  await writeFixturePackages(packagesRoot, packages);

  const plans = await Promise.all(['One', 'Two'].map(async (name, index) => {
    const agent = defineAgent({ name, instructions: 'persona' });
    return planAgentTemplate({
      template: templateWith({
        id: `fixture-${index}`,
        tools: [],
        plugins: [{
          package: index === 0 ? '@stratusagent/tool-fs' : 'somebody-elses-shell',
          reason: 'a distinct package each',
        }],
      }),
      agent,
      soulPath: path.join(home, '.stratus', 'agents', `${agent.id}.md`),
      configPath: path.join(home, '.stratus', 'config.json'),
      config: {},
      workspacePath: path.join(home, '.stratus', 'workspaces', agent.id),
      host: fakeHost(packages, packagesRoot),
      credentials: { shared: {}, agents: {} },
      installedSkills: [],
    });
  }));

  // Both plans were computed against an empty config, so a last-writer-wins
  // merge would drop one entry. The read that decides the merge happens
  // inside the lock, so the second one merges onto the first.
  const applied = await Promise.all(plans.map((plan) => applyFixture(plan, home)));
  assert.equal(applied.length, 2);

  const config = JSON.parse(await readFile(path.join(home, '.stratus', 'config.json'), 'utf8')) as {
    plugins: Record<string, JsonObject>;
  };
  assert.deepEqual(Object.keys(config.plugins).sort(), ['@stratusagent/tool-fs', 'somebody-elses-shell']);
});

test('two agents from the same template get distinct ids, palettes, and state', async () => {
  const fixture = await newFixture('Kit');
  const plan = await planFor(templateWith({ tools: ['memory.remember'] }), fixture, {});

  // The real claim, twice, through the path the CLI uses: the second one
  // finds the id taken and takes a suffixed one of its own.
  const claim = () => claimSoulFile(
    { homeDir: fixture.home, cwd: fixture.home, processEnv: {} },
    { name: 'Kit', instructions: plan.template.persona },
    (agent) => `soul for ${agent.id}\n`,
    () => {},
  );
  const first = await claim();
  const second = await claim();

  assert.notEqual(first.agent.id, second.agent.id);
  assert.notEqual(first.soulPath, second.soulPath);
  // Two agents sharing one name must not be drawn identically: memory,
  // credentials, and per-agent settings are all keyed by the id, so a
  // roster where they look the same is a roster nobody can read.
  assert.notDeepEqual(first.agent.avatar?.palette, second.agent.avatar?.palette);
  assert.equal(first.agent.avatar?.seed, 'Kit', 'the uncontested one keeps the palette its name gives it');
  assert.equal(second.agent.avatar?.seed, second.agent.id);
});

test('a per-agent block is merged into the entry a racing creation already wrote', async () => {
  const fixture = await newFixture();
  const packages = { '@stratusagent/tool-fs': firstPartyFs };
  await writeFixturePackages(fixture.packagesRoot, packages);
  const plan = await planFor(
    templateWith({
      tools: ['fs.read'],
      plugins: [{
        package: '@stratusagent/tool-fs',
        reason: 'files',
        agentSettings: (context) => ({ roots: [context.workspacePath] }),
      }],
    }),
    fixture,
    packages,
  );

  const configPath = path.join(fixture.home, '.stratus', 'config.json');
  await mkdir(path.dirname(configPath), { recursive: true });
  // Written after the plan: somebody else's agent, in the block this apply
  // is about to amend.
  await writeFile(configPath, JSON.stringify({
    plugins: { '@stratusagent/tool-fs': { enabled: true, agents: { elsewhere: { roots: ['/theirs'] } } } },
  }));

  await applyFixture(plan, fixture.home);
  const config = JSON.parse(await readFile(configPath, 'utf8')) as {
    plugins: { '@stratusagent/tool-fs': { agents: Record<string, JsonObject> } };
  };
  assert.deepEqual(
    Object.keys(config.plugins['@stratusagent/tool-fs'].agents).sort(),
    [plan.agent.id, 'elsewhere'].sort(),
  );
});

test('a template needing no plugin does not touch the config file', async () => {
  const fixture = await newFixture();
  const plan = await planFor(templateWith({ tools: ['memory.remember'] }), fixture, {});
  const applied = await applyFixture(plan, fixture.home);
  assert.deepEqual(applied.configured, []);
  await assert.rejects(stat(path.join(fixture.home, '.stratus', 'config.json')), { code: 'ENOENT' });
});

// ---- the format itself ------------------------------------------------------

test('every shipped template declares the version this host understands', () => {
  assert.equal(AGENT_TEMPLATES.length, agentTemplateIds().length);
  for (const template of AGENT_TEMPLATES) {
    assert.equal(template.templateVersion, AGENT_TEMPLATE_VERSION, template.id);
    assert.equal(findAgentTemplate(template.id), template);
  }
});

test('a template from a newer format is refused rather than read optimistically', async () => {
  const fixture = await newFixture();
  await assert.rejects(
    planFor(templateWith({ templateVersion: AGENT_TEMPLATE_VERSION + 1 }), fixture, {}),
    /this install understands/,
  );
});

test('a template names credentials and never carries one', async () => {
  const fixture = await newFixture();
  const plan = await planAgentTemplate({
    template: templateWith({ credentials: ['search.apiKey', 'other.key'] }),
    agent: fixture.agent,
    soulPath: path.join(fixture.home, 'soul.md'),
    configPath: path.join(fixture.home, 'config.json'),
    config: {},
    workspacePath: path.join(fixture.home, 'ws'),
    host: fakeHost({}, fixture.packagesRoot),
    credentials: { shared: { 'search.apiKey': 'sk-live' }, agents: {} },
    installedSkills: [],
  });

  assert.deepEqual(
    plan.credentials.map((need) => [need.name, need.provided]),
    [['search.apiKey', 'shared'], ['other.key', 'missing']],
  );
  // A missing credential is reported, not a blocker: the agent's other
  // tools work, and the flow says how to provide it.
  assert.deepEqual(plan.blockers, []);
  assert.ok(!JSON.stringify(plan).includes('sk-live'), 'no plan ever carries a value');
});

test('a template proposes a schedule and creates none', () => {
  const triage = findAgentTemplate('triage');
  assert.ok(triage?.schedule, 'triage is the one whose agent is only useful on a cadence');
  // Nothing in the format can write a schedule: it carries a proposal, and
  // `schedule.every` is gated so the operator approves it as its own step.
  for (const template of AGENT_TEMPLATES) {
    assert.ok(!template.tools.includes('schedule.every'), template.id);
    assert.ok(!template.tools.includes('schedule.at'), template.id);
  }
});

// ---- the kernel risk table stays true --------------------------------------

test('KERNEL_TOOL_RISKS says what the kernel tool factories say', () => {
  // The planner runs in a CLI with no gateway, so it cannot construct these
  // to ask. A table that drifted would tell an operator a tool is `safe`
  // that the daemon then gates, which is the one thing the review step must
  // never do — so the table is checked against the factories here instead.
  const memory = createFileMemoryStore(path.join(os.tmpdir(), 'stratus-parity-memory.jsonl'));
  const scheduler: SchedulerHandle = {
    async create() {
      throw new Error('not called');
    },
    async list() {
      return [];
    },
    async cancel() {
      return false;
    },
  };
  const registry = new AgentRegistry();
  const runner = { run: async () => { throw new Error('not called'); } } as unknown as AgentRunner;

  const tools: Tool[] = [
    createRememberTool(memory),
    createRecallTool(memory),
    createForgetTool(memory),
    createDelegateTool({ registry, runner }),
    createSkillReadTool(new SkillRegistry()),
    ...createScheduleTools(scheduler),
    createMessageSendTool(async () => undefined),
  ];

  assert.deepEqual(
    Object.fromEntries(tools.map((tool) => [tool.name, resolveToolRisk(tool)])),
    { ...KERNEL_TOOL_RISKS },
  );
});
