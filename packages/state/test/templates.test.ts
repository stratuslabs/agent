import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, chown, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
  claimFileLock,
  claimSoulFile,
  configLockPath,
  FileLockUnsafeError,
  withFileLock,
  decidePluginConfig,
  findAgentTemplate,
  planAgentTemplate,
  createFileMemoryStore,
  planRiskCeiling,
  saveConfigFile,
  updateConfigFile,
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

/**
 * `applyAgentTemplate` with the seams a host supplies.
 *
 * `live` gives it a real `replan` over the fixture's packages — the commit
 * is built from a plan recomputed under the lock, so a test that changes the
 * config between planning and applying has to let that recomputation
 * happen. Without it the fixture just hands back the plan it was given,
 * which is what every test that changes nothing wants.
 */
const applyFixture = async (
  plan: TemplatePlan,
  home: string,
  overrides: Partial<Parameters<typeof applyAgentTemplate>[0]> = {},
  live?: { packagesRoot: string; packages: Record<string, JsonObject> },
) => {
  const configPath = path.join(home, '.stratus', 'config.json');
  return applyAgentTemplate({
    plan,
    replan: live
      ? (identity, current) => planAgentTemplate({
        template: plan.template,
        agent: identity,
        soulPath: path.join(home, '.stratus', 'agents', `${identity.id}.md`),
        configPath,
        config: current,
        workspacePath: path.join(home, '.stratus', 'workspaces', identity.id),
        host: fakeHost(live.packages, live.packagesRoot),
        credentials: { shared: {}, agents: {} },
        installedSkills: [],
      })
      : async () => plan,
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
    lockPath: await configLockPath(configPath),
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

  await applyFixture(plan, fixture.home, {}, { packagesRoot: fixture.packagesRoot, packages });
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

test('a template that proposes a schedule grants the tool the proposal needs', () => {
  // The allowlist is checked before the approval policy, so a soul without
  // `schedule.every` refuses the call outright and the "they will ask you to
  // approve it" the flow promises can never happen. Granting it is not
  // creating a schedule — it is gated, so the human still approves the
  // cadence — and the reporting half needs `message.send` for the same
  // reason.
  for (const template of AGENT_TEMPLATES) {
    if (!template.schedule) {
      continue;
    }
    assert.ok(template.tools.includes('schedule.every'), `${template.id} proposes a schedule it cannot set`);
    assert.ok(template.tools.includes('message.send'), `${template.id} would fire with nowhere to report`);
  }
  assert.ok(findAgentTemplate('triage')?.schedule, 'triage is the one whose agent is only useful on a cadence');
});

test('applying a template writes a soul and a config entry, and nothing else', async () => {
  const fixture = await newFixture();
  const schedule = findAgentTemplate('triage')?.schedule;
  assert.ok(schedule, 'the template that proposes one');
  // The format has no field a schedule could be written from and the apply
  // has no scheduler seam to write one through: the proposal reaches the
  // operator as text, and `schedule.every` is what turns it into a row.
  const plan = await planFor(templateWith({ schedule }), fixture, {});
  const applied = await applyFixture(plan, fixture.home);
  assert.deepEqual(Object.keys(applied).sort(), ['agent', 'configPath', 'configured', 'soulPath']);
  assert.deepEqual(applied.configured, []);
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

// ---- what the review promised, held under configuration that already exists

test('a per-agent entry the template contradicts is a conflict, not an overwrite', () => {
  const template = templateWith({
    plugins: [{
      package: 'p',
      reason: 'r',
      agentSettings: (context) => ({ roots: [context.workspacePath] }),
    }],
  });
  // Preconfigured before the soul existed, or left behind by one somebody
  // deleted. Either way the operator chose it, and the command promises a
  // conflict rather than a silent replacement.
  const decided = decidePluginConfig(
    template,
    { agentId: 'kit', agentName: 'Kit', workspacePath: '/ws/kit' },
    { p: { enabled: true, agents: { kit: { roots: ['/theirs'] } } } },
  );
  const outcome = decided.get('p');
  assert.equal(outcome?.status, 'conflict');
  assert.deepEqual(outcome?.status === 'conflict' ? outcome.conflicts : [], [
    { key: 'agents.kit.roots', existing: ['/theirs'], requested: ['/ws/kit'] },
  ]);
});

test('a per-agent entry that already says what the template needs is reused', () => {
  const decided = decidePluginConfig(
    templateWith({
      plugins: [{
        package: 'p',
        reason: 'r',
        agentSettings: (context) => ({ roots: [context.workspacePath] }),
      }],
    }),
    { agentId: 'kit', agentName: 'Kit', workspacePath: '/ws/kit' },
    { p: { enabled: true, agents: { kit: { roots: ['/ws/kit'], maxBytes: 10 } } } },
  );
  assert.equal(decided.get('p')?.status, 'reuse');
});

test('a per-agent entry another agent owns is merged, never replaced', () => {
  const decided = decidePluginConfig(
    templateWith({
      plugins: [{
        package: 'p',
        reason: 'r',
        agentSettings: (context) => ({ roots: [context.workspacePath] }),
      }],
    }),
    { agentId: 'kit', agentName: 'Kit', workspacePath: '/ws/kit' },
    { p: { enabled: true, agents: { elsewhere: { roots: ['/theirs'] } } } },
  );
  const outcome = decided.get('p');
  assert.equal(outcome?.status, 'amend');
  assert.deepEqual(outcome?.status === 'amend' ? outcome.adds : {}, {
    agents: { elsewhere: { roots: ['/theirs'] }, kit: { roots: ['/ws/kit'] } },
  });
});

test('a config block this host would refuse to load blocks the plan', async () => {
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
    // `loadPlugins` refuses the whole plugin over this. A plan that printed
    // the tool list and created the agent anyway would hand the operator a
    // soul whose tools stop existing at the next restart.
    { plugins: { '@stratusagent/tool-fs': { enabled: true, toolRisks: { 'fs.read': 'mostly-safe' } } } },
  );

  assert.equal(plan.plugins[0]?.status, 'unreadable');
  assert.equal(plan.blockers[0]?.kind, 'unreadable-plugin');
  assert.match(plan.blockers[0]?.message ?? '', /would refuse to load it as configured/);
  await assert.rejects(applyFixture(plan, fixture.home), TemplateApplyError);
});

// ---- what the daemon would do with the whole config, not just this bundle

test('a tool name another enabled plugin already owns blocks the plan', async () => {
  const fixture = await newFixture();
  const rival: JsonObject = {
    name: 'rival-fs',
    version: '1.0.0',
    stratus: { pluginVersion: 1, contributes: { tools: [{ name: 'fs.read', risk: 'gated' }] } },
  };
  const packages = { 'rival-fs': rival, '@stratusagent/tool-fs': firstPartyFs };
  await writeFixturePackages(fixture.packagesRoot, packages);

  const plan = await planFor(
    templateWith({
      tools: ['fs.read'],
      plugins: [{ package: '@stratusagent/tool-fs', reason: 'files' }],
    }),
    fixture,
    packages,
    // Listed first, so `loadPlugins` gives it the name and refuses tool-fs
    // whole. A plan that read only the template's own packages would show
    // `fs.read (safe) @stratusagent/tool-fs` — a different implementation
    // than the one the soul would actually reach, and one that never loads.
    { plugins: { 'rival-fs': { enabled: true } } },
  );

  assert.equal(plan.blockers[0]?.kind, 'tool-collision');
  assert.match(plan.blockers[0]?.message ?? '', /fs\.read is already contributed by rival-fs/);
  await assert.rejects(applyFixture(plan, fixture.home), TemplateApplyError);
});

test('a plugin the config disables owns no names, so it cannot collide', async () => {
  const fixture = await newFixture();
  const rival: JsonObject = {
    name: 'rival-fs',
    version: '1.0.0',
    stratus: { pluginVersion: 1, contributes: { tools: [{ name: 'fs.read', risk: 'gated' }] } },
  };
  const packages = { 'rival-fs': rival, '@stratusagent/tool-fs': firstPartyFs };
  await writeFixturePackages(fixture.packagesRoot, packages);

  const plan = await planFor(
    templateWith({
      tools: ['fs.read'],
      plugins: [{ package: '@stratusagent/tool-fs', reason: 'files' }],
    }),
    fixture,
    packages,
    { plugins: { 'rival-fs': { enabled: false } } },
  );

  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.tools[0]?.resolves[0]?.package, '@stratusagent/tool-fs');
});

test('a plugin block that violates its own manifest schema blocks the plan', async () => {
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
    // `loadConfigFile` accepts the host-level shape; `validatePluginConfig`
    // is what refuses it, and it runs in the daemon rather than here — so
    // without this check the agent is created and the plugin is refused at
    // the next restart.
    { plugins: { '@stratusagent/tool-fs': { enabled: true, roots: 'not-an-array' } } },
  );

  assert.equal(plan.plugins[0]?.status, 'unreadable');
  assert.equal(plan.blockers[0]?.kind, 'unreadable-plugin');
  assert.match(plan.blockers[0]?.message ?? '', /would refuse to load it as configured/);
});

test('a manifest requiring a host-supplied setting is not reported as invalid', async () => {
  const fixture = await newFixture();
  const needsWorkspace: JsonObject = {
    name: 'needs-workspace',
    version: '1.0.0',
    stratus: {
      pluginVersion: 1,
      contributes: { tools: [{ name: 'ws.read', risk: 'gated' }] },
      config: {
        type: 'object',
        properties: { workspaceRoot: { type: 'string' } },
        required: ['workspaceRoot'],
      },
    },
  };
  const packages = { 'needs-workspace': needsWorkspace };
  await writeFixturePackages(fixture.packagesRoot, packages);

  const plan = await planAgentTemplate({
    template: templateWith({
      tools: ['ws.read'],
      plugins: [{ package: 'needs-workspace', reason: 'a workspace' }],
    }),
    agent: fixture.agent,
    soulPath: path.join(fixture.home, 'soul.md'),
    configPath: path.join(fixture.home, 'config.json'),
    config: {},
    workspacePath: path.join(fixture.home, 'ws', fixture.agent.id),
    // The host's default, folded in before validation exactly as the loader
    // folds it. Without it this manifest reads as invalid here and loads
    // perfectly well in the daemon.
    workspaceRoot: path.join(fixture.home, 'ws'),
    host: fakeHost(packages, fixture.packagesRoot),
    credentials: { shared: {}, agents: {} },
    installedSkills: [],
  });

  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.tools[0]?.resolves[0]?.name, 'ws.read');
});

test('a workspace that cannot be created leaves no agent and no config entry', async () => {
  const fixture = await newFixture();
  const packages = { '@stratusagent/tool-fs': firstPartyFs };
  await writeFixturePackages(fixture.packagesRoot, packages);
  const plan = await planFor(
    templateWith({
      tools: ['fs.read'],
      plugins: [{
        package: '@stratusagent/tool-fs',
        reason: 'files',
        // The per-agent roots are what put the workspace path into the
        // config, and so what makes its creation part of the commit.
        agentSettings: (context) => ({ roots: [context.workspacePath] }),
      }],
    }),
    fixture,
    packages,
  );

  // `~/.stratus/workspaces` as a file: `mkdir -p` under it fails. A soul
  // whose configured root could never exist is a half-configured agent, so
  // it has to fail the way any other commit failure does.
  const workspaces = path.join(fixture.home, '.stratus', 'workspaces');
  await mkdir(path.dirname(workspaces), { recursive: true });
  await writeFile(workspaces, 'not a directory\n');

  await assert.rejects(applyFixture(plan, fixture.home));
  assert.deepEqual(await readdir(path.join(fixture.home, '.stratus', 'agents')), []);
  await assert.rejects(stat(path.join(fixture.home, '.stratus', 'config.json')), { code: 'ENOENT' });
});

test('a config write replaces the file rather than truncating it in place', async () => {
  const home = await newHome();
  const configPath = path.join(home, '.stratus', 'config.json');
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify({ provider: 'anthropic' }, null, 2)}\n`);
  const before = await stat(configPath);

  await saveConfigFile(configPath, { provider: 'anthropic', model: 'claude-opus-5' });

  // A different inode is the whole property: a write straight to the
  // destination opens it with O_TRUNC, so a failure partway through — a
  // full disk, a process killed mid-write — leaves the operator with half a
  // document, and a concurrent reader can see one. Written beside it and
  // renamed over, the old file is whole until the instant it is gone.
  const after = await stat(configPath);
  assert.notEqual(after.ino, before.ino);
  assert.equal(
    JSON.parse(await readFile(configPath, 'utf8')).model,
    'claude-opus-5',
  );
  assert.deepEqual(
    (await readdir(path.dirname(configPath))).filter((name) => name.endsWith('.tmp')),
    [],
    'no temporary left behind',
  );
});

test('a collision between two plugins the template does not need is not this command\'s business', async () => {
  const fixture = await newFixture();
  const first: JsonObject = {
    name: 'first-thing',
    version: '1.0.0',
    stratus: { pluginVersion: 1, contributes: { tools: [{ name: 'foo.read', risk: 'gated' }] } },
  };
  const second: JsonObject = {
    name: 'second-thing',
    version: '1.0.0',
    stratus: { pluginVersion: 1, contributes: { tools: [{ name: 'foo.read', risk: 'gated' }] } },
  };
  const packages = { 'first-thing': first, 'second-thing': second };
  await writeFixturePackages(fixture.packagesRoot, packages);

  // The daemon already refuses one of these, and has since before this
  // command existed. A plugin-free template touches no config and grants
  // only kernel tools, so refusing to create it over somebody else's
  // pre-existing problem would be failing for something it neither causes
  // nor can fix.
  const plan = await planFor(
    templateWith({ tools: ['memory.remember'] }),
    fixture,
    packages,
    { plugins: { 'first-thing': { enabled: true }, 'second-thing': { enabled: true } } },
  );

  assert.deepEqual(plan.blockers, []);
  const applied = await applyFixture(plan, fixture.home);
  assert.deepEqual(applied.configured, []);
});

test('two bridges declaring the same namespace do not read as a collision', async () => {
  const fixture = await newFixture();
  const bridge = (name: string): JsonObject => ({
    name,
    version: '1.0.0',
    stratus: {
      pluginVersion: 1,
      contributes: { toolsDiscovered: [{ namespace: 'mcp.*', risk: 'gated' }] },
    },
  });
  const packages = { 'bridge-one': bridge('bridge-one'), 'bridge-two': bridge('bridge-two') };
  await writeFixturePackages(fixture.packagesRoot, packages);

  // A `toolsDiscovered` namespace is a ceiling on what a bridge may
  // register later, not a reservation. The loader stages and checks the
  // concrete names each plugin registers, so these two collide only if they
  // discover the same tool — which nothing here can know, and which
  // treating the namespace string as a registered name would report as a
  // certainty before either has connected.
  const plan = await planFor(
    templateWith({
      tools: ['mcp.linear.create_issue'],
      plugins: [{ package: 'bridge-two', reason: 'a second server' }],
    }),
    fixture,
    packages,
    { plugins: { 'bridge-one': { enabled: true } } },
  );

  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.plugins[0]?.status, 'add');
});

test('a config file that does not exist yet is an empty merge base, not a failure', async () => {
  const home = await newHome();
  const configPath = path.join(home, 'chosen.json');
  const written = await updateConfigFile(configPath, { homeDir: home }, (current) => {
    assert.deepEqual(current, {}, 'nothing there yet');
    return { ...current, provider: 'anthropic' };
  });
  assert.equal(written.provider, 'anthropic');
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).provider, 'anthropic');
});

test('a config that exists and will not parse is never overwritten', async () => {
  const home = await newHome();
  const configPath = path.join(home, 'broken.json');
  await writeFile(configPath, '{ not json\n');
  await assert.rejects(updateConfigFile(configPath, { homeDir: home }, (current) => current));
  assert.equal(await readFile(configPath, 'utf8'), '{ not json\n', 'left exactly as found');
});

test('concurrent config updates serialize, so neither loses the other', async () => {
  const home = await newHome();
  const configPath = path.join(home, '.stratus', 'config.json');
  const env = { homeDir: home };

  // Both read an empty config if they run unserialized, and the second
  // write puts back a document without the first's key.
  await Promise.all([
    updateConfigFile(configPath, env, (current) => ({ ...current, provider: 'anthropic' })),
    updateConfigFile(configPath, env, (current) => ({ ...current, model: 'claude-opus-5' })),
  ]);

  const written = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
  assert.equal(written.provider, 'anthropic');
  assert.equal(written.model, 'claude-opus-5');
});

test('a config change between review and commit that breaks a required plugin stops the write', async () => {
  const fixture = await newFixture();
  const rival: JsonObject = {
    name: 'rival-fs',
    version: '1.0.0',
    stratus: { pluginVersion: 1, contributes: { tools: [{ name: 'fs.read', risk: 'gated' }] } },
  };
  const packages = { '@stratusagent/tool-fs': firstPartyFs, 'rival-fs': rival };
  await writeFixturePackages(fixture.packagesRoot, packages);

  const plan = await planFor(
    templateWith({
      tools: ['fs.read'],
      plugins: [{ package: '@stratusagent/tool-fs', reason: 'files' }],
    }),
    fixture,
    packages,
  );
  assert.deepEqual(plan.blockers, []);

  // Written after the review: it contradicts none of the template's keys, so
  // re-running only the merge decision would sail past it — and the daemon
  // would then refuse tool-fs whole, leaving a soul whose reviewed tools do
  // not exist.
  const configPath = path.join(fixture.home, '.stratus', 'config.json');
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({ plugins: { 'rival-fs': { enabled: true } } }));

  await assert.rejects(
    applyFixture(plan, fixture.home, {}, { packagesRoot: fixture.packagesRoot, packages }),
    (error: unknown) => error instanceof TemplateApplyError && /changed since this was reviewed/.test(error.message),
  );
  assert.deepEqual(await readdir(path.join(fixture.home, '.stratus', 'agents')), []);
});

test('a config change that moves what a granted tool resolves to stops the write', async () => {
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
  assert.equal(plan.tools[0]?.resolves[0]?.risk, 'safe');

  // An operator override raising fs.read, written after the review. Nothing
  // is blocked by it — the plan is perfectly valid — but it is no longer the
  // plan anybody said yes to.
  const configPath = path.join(fixture.home, '.stratus', 'config.json');
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({
    plugins: { '@stratusagent/tool-fs': { enabled: true, toolRisks: { 'fs.read': 'dangerous' } } },
  }));

  await assert.rejects(
    applyFixture(plan, fixture.home, {}, { packagesRoot: fixture.packagesRoot, packages }),
    (error: unknown) => error instanceof TemplateApplyError
      && /no longer the ones printed/.test(error.message),
  );
  assert.deepEqual(await readdir(path.join(fixture.home, '.stratus', 'agents')), []);
});

test('a config written through a symlink stays a symlink, and its target is updated', async () => {
  const home = await newHome();
  const real = path.join(home, 'dotfiles', 'config.json');
  const link = path.join(home, '.stratus', 'config.json');
  await mkdir(path.dirname(real), { recursive: true });
  await mkdir(path.dirname(link), { recursive: true });
  await writeFile(real, `${JSON.stringify({ provider: 'anthropic' })}\n`);
  await symlink(real, link);

  await saveConfigFile(link, { provider: 'demo' });

  // A rename replaces a directory entry, so renaming onto the link would
  // detach it and leave the dotfiles repository holding the old contents
  // forever. The direct write this replaced followed the link.
  assert.equal((await lstat(link)).isSymbolicLink(), true);
  assert.equal(JSON.parse(await readFile(real, 'utf8')).provider, 'demo');
  assert.deepEqual(
    (await readdir(path.dirname(real))).filter((name) => name.endsWith('.tmp')),
    [],
  );
});

test('a template with nothing pointing at a workspace does not need one', async () => {
  const fixture = await newFixture();
  const plan = await planFor(templateWith({ tools: ['memory.remember'] }), fixture, {});

  // Unusable, and irrelevant: this bundle configures no per-agent roots, so
  // nothing it writes names a workspace. Refusing the agent over it would
  // be failing for a directory the agent never reaches.
  const workspaces = path.join(fixture.home, '.stratus', 'workspaces');
  await mkdir(path.dirname(workspaces), { recursive: true });
  await writeFile(workspaces, 'not a directory\n');

  const applied = await applyFixture(plan, fixture.home);
  assert.equal(applied.agent.id, plan.agent.id);
});

test('a config written through a dangling symlink creates its target, not a file over the link', async () => {
  const home = await newHome();
  const real = path.join(home, 'dotfiles', 'config.json');
  const link = path.join(home, '.stratus', 'config.json');
  await mkdir(path.dirname(real), { recursive: true });
  await mkdir(path.dirname(link), { recursive: true });
  // The link in place before the file it names — what a dotfiles checkout
  // looks like on a machine that has not been set up yet. `realpath` throws
  // here, which is why the chain is followed by hand.
  await symlink(real, link);

  await saveConfigFile(link, { provider: 'demo' });

  assert.equal((await lstat(link)).isSymbolicLink(), true);
  assert.equal(JSON.parse(await readFile(real, 'utf8')).provider, 'demo');
});

test('replacing a config keeps the permissions it had', async () => {
  const home = await newHome();
  const configPath = path.join(home, '.stratus', 'config.json');
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify({ provider: 'anthropic' })}\n`);
  // Group-readable, as a shared-machine install has it so a daemon running
  // as another user can load it. A rename that took the umask's answer
  // instead would tighten it to 0600 and lock that daemon out — the setup
  // this function's "deliberately NOT 0600" note exists to protect.
  await chmod(configPath, 0o640);

  await saveConfigFile(configPath, { provider: 'demo' });

  assert.equal((await stat(configPath)).mode & 0o777, 0o640);
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).provider, 'demo');
});

test('replacing a config keeps the ownership it had', async (t) => {
  // A config chgrp'd to a shared group so a daemon running as another user
  // can read it. Renaming a temporary over it hands the file the writer's
  // own primary group, and the daemon loses access — the same failure as
  // the mode, arriving through the other half of the inode's metadata.
  //
  // Needs an alternate gid this process may set, which not every machine
  // gives a test. Skipped rather than weakened where there is none: an
  // assertion that cannot fail reads as coverage and is not.
  const alternateGid = process.getgroups?.().find((gid) => gid !== process.getgid?.())
    ?? (process.getuid?.() === 0 ? 1 : undefined);
  if (alternateGid === undefined) {
    t.skip('no alternate gid this process may set');
    return;
  }

  const home = await newHome();
  const configPath = path.join(home, '.stratus', 'config.json');
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify({ provider: 'anthropic' })}\n`);
  await chown(configPath, process.getuid?.() ?? 0, alternateGid);

  await saveConfigFile(configPath, { provider: 'demo' });

  assert.equal((await stat(configPath)).gid, alternateGid);
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).provider, 'demo');
});

test('every writer of one config file takes one lock, whatever home named it', async () => {
  const shared = await newHome();
  const configPath = path.join(shared, 'shared-config.json');
  // Two operators with different homes, one explicit `--config` between
  // them. A lock derived from the home would hand them a lock each, which
  // is no lock at all for the file they are both replacing.
  assert.equal(await configLockPath(configPath), `${configPath}.lock`);

  await Promise.all([
    updateConfigFile(configPath, { homeDir: await newHome() }, (current) => ({ ...current, provider: 'anthropic' })),
    updateConfigFile(configPath, { homeDir: await newHome() }, (current) => ({ ...current, model: 'claude-opus-5' })),
  ]);

  const written = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
  assert.equal(written.provider, 'anthropic');
  assert.equal(written.model, 'claude-opus-5');
});

test('a symlink chain too deep to follow refuses rather than replacing a link', async () => {
  const home = await newHome();
  const real = path.join(home, 'config.json');
  await writeFile(real, `${JSON.stringify({ provider: 'anthropic' })}\n`);

  // Longer than the bound. Returning the last link reached would hand the
  // rename an intermediate symlink to replace — the exact failure following
  // the chain exists to prevent, so the bound has to refuse rather than
  // silently do the wrong thing.
  let previous = real;
  for (let hop = 0; hop < 40; hop += 1) {
    const link = path.join(home, `link-${hop}.json`);
    await symlink(previous, link);
    previous = link;
  }

  await assert.rejects(saveConfigFile(previous, { provider: 'demo' }), /symlinks deep, or a loop/);
  assert.equal(JSON.parse(await readFile(real, 'utf8')).provider, 'anthropic', 'untouched');
});

test('a config addressed through a symlink takes the same lock as its target', async () => {
  const home = await newHome();
  const real = path.join(home, 'dotfiles', 'config.json');
  const link = path.join(home, '.stratus', 'config.json');
  await mkdir(path.dirname(real), { recursive: true });
  await mkdir(path.dirname(link), { recursive: true });
  await writeFile(real, '{}\n');
  await symlink(real, link);

  // The write resolves the chain before renaming, so these two spellings
  // replace the same file. A lock keyed to the spelling would let them past
  // each other, and the later save would discard the earlier one's change.
  assert.equal(await configLockPath(link), await configLockPath(real));

  await Promise.all([
    updateConfigFile(link, { homeDir: home }, (current) => ({ ...current, provider: 'anthropic' })),
    updateConfigFile(real, { homeDir: home }, (current) => ({ ...current, model: 'claude-opus-5' })),
  ]);

  const written = JSON.parse(await readFile(real, 'utf8')) as Record<string, unknown>;
  assert.equal(written.provider, 'anthropic');
  assert.equal(written.model, 'claude-opus-5');
});

test('a bundle with no plugin entries never touches the config lock', async () => {
  const fixture = await newFixture();
  const plan = await planFor(templateWith({ tools: ['memory.remember'] }), fixture, {});
  const lockPath = path.join(fixture.home, 'somewhere', 'config.json.lock');

  // Nothing to merge means no config transaction and so no lock — which is
  // what keeps a plugin-free creation from leaving a lock file beside
  // somebody's config, and from failing where that directory is read-only.
  // The soul claim is atomic on its own; the lock was only ever there so
  // the per-agent config key and the claimed id could not disagree.
  await applyFixture(plan, fixture.home, { lockPath });

  await assert.rejects(stat(path.dirname(lockPath)), { code: 'ENOENT' }, 'no lock, and no directory made for one');
  assert.deepEqual(await readdir(path.join(fixture.home, '.stratus', 'agents')), [`${plan.agent.id}.md`]);
});

test('a required plugin upgraded between review and commit stops the write', async () => {
  const fixture = await newFixture();
  const packages: Record<string, JsonObject> = { '@stratusagent/tool-fs': firstPartyFs };
  await writeFixturePackages(fixture.packagesRoot, packages);
  const plan = await planFor(
    templateWith({
      tools: ['fs.read'],
      plugins: [{ package: '@stratusagent/tool-fs', reason: 'files' }],
    }),
    fixture,
    packages,
  );
  assert.equal(plan.plugins[0]?.status === 'add' ? plan.plugins[0].version : undefined, '9.9.9');

  // Upgraded after the review. Same manifest, same tools, same risks — so
  // the grant comparison passes — but different code behind them, and the
  // summary named a version.
  const upgraded = { ...firstPartyFs, version: '10.0.0' };
  await writeFixturePackages(fixture.packagesRoot, { '@stratusagent/tool-fs': upgraded });

  await assert.rejects(
    applyFixture(plan, fixture.home, {}, {
      packagesRoot: fixture.packagesRoot,
      packages: { '@stratusagent/tool-fs': upgraded },
    }),
    (error: unknown) => error instanceof TemplateApplyError && /no longer the ones printed/.test(error.message),
  );
  assert.deepEqual(await readdir(path.join(fixture.home, '.stratus', 'agents')), []);
});

test('a lock path that is a symlink is refused, never followed and truncated', async () => {
  const home = await newHome();
  const victim = path.join(home, 'credentials.json');
  await writeFile(victim, `${JSON.stringify({ anthropic: { type: 'api_key' } })}\n`);
  const lockPath = path.join(home, 'config.json.lock');
  // A config lock lives beside the config, which can be a directory
  // somebody else may write. Planting a link there aimed the recovery
  // path — which truncates anything that is not a database — at a file of
  // the attacker's choosing that the operator can write.
  await symlink(victim, lockPath);

  assert.throws(() => claimFileLock(lockPath), (error: unknown) => (
    error instanceof FileLockUnsafeError && /symbolic link/.test(error.message)
  ));
  assert.notEqual((await stat(victim)).size, 0, 'the link target is untouched');
  await assert.rejects(
    withFileLock(lockPath, async () => undefined),
    FileLockUnsafeError,
    'and the waiting form refuses it too, rather than retrying forever',
  );
});

test('a damaged lock is emptied through one descriptor, so a swapped link cannot be truncated', async () => {
  const home = await newHome();
  const lockPath = path.join(home, 'config.json.lock');
  const victim = path.join(home, 'credentials.json');
  await writeFile(victim, `${JSON.stringify({ anthropic: { type: 'api_key' } })}\n`);
  // Damaged, so the recovery path runs. Owned by this process, so the
  // ownership check passes and the truncate is genuinely reached.
  await writeFile(lockPath, 'not a database at all\n');

  const claim = claimFileLock(lockPath);
  claim.release();
  assert.equal(await readFile(lockPath, 'utf8'), '', 'emptied in place, as before');
  assert.notEqual((await stat(victim)).size, 0);
});

test('the staged config write refuses a temporary somebody else planted', async () => {
  const home = await newHome();
  const configPath = path.join(home, 'config.json');
  await writeFile(configPath, `${JSON.stringify({ provider: 'anthropic' })}\n`);

  // The name is unguessable now, so this plants every temporary the old
  // predictable scheme could have produced and asserts the write does not
  // take any of them. `O_EXCL` is what makes that true regardless of the
  // name: this process creates what it writes to, or it fails.
  const victim = path.join(home, 'credentials.json');
  await writeFile(victim, `${JSON.stringify({ anthropic: { type: 'api_key' } })}\n`);
  await symlink(victim, `${configPath}.${process.pid}.tmp`);

  await saveConfigFile(configPath, { provider: 'demo' });

  assert.notEqual((await stat(victim)).size, 0, 'the planted target is untouched');
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).provider, 'demo');
  assert.equal((await lstat(configPath)).isSymbolicLink(), false, 'and the config is still a real file');
});

test('one config transaction locks, reads and writes the same resolved file', async () => {
  const home = await newHome();
  const first = path.join(home, 'first.json');
  const second = path.join(home, 'second.json');
  const link = path.join(home, 'config.json');
  await writeFile(first, `${JSON.stringify({ provider: 'anthropic' })}\n`);
  await writeFile(second, `${JSON.stringify({ provider: 'openai' })}\n`);
  await symlink(first, link);

  await updateConfigFile(link, { homeDir: home }, async (current) => {
    assert.equal(current.provider, 'anthropic', 'read through the link, from the first target');
    // Retargeted mid-transaction. Resolving again for the write would send
    // it to a file this holds no lock on, and leave the one it does hold
    // unchanged — a concurrent writer addressing the second target directly
    // would then interleave freely.
    await rm(link);
    await symlink(second, link);
    return { ...current, model: 'claude-opus-5' };
  });

  assert.equal(JSON.parse(await readFile(first, 'utf8')).model, 'claude-opus-5', 'written where the lock was taken');
  assert.equal(JSON.parse(await readFile(second, 'utf8')).model, undefined, 'and not where the link now points');
});
