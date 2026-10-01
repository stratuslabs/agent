// The stratus-skill eval: see README.md beside this file.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AgentRunner,
  CONVERSATION_METADATA_KEY,
  ContributionRegistry,
  EventBus,
  InMemoryAgentMemoryStore,
  InMemorySessionStore,
  SKILL_READ_TOOL_NAME,
  STRATUS_SKILL_ID,
  SkillRegistry,
  ToolRegistry,
  conversationContextFrom,
  latestTurnReply,
  type AgentDefinition,
  type ExecutorContribution,
  type JsonObject,
  type MemoryStoreContribution,
  type ProviderContribution,
  type Session,
} from '@stratusagent/core';
import { loadPlugins, type LoadedPlugin } from '@stratusagent/plugins';
import {
  createCredentialRequestTool,
  createForgetTool,
  createPinTool,
  createRecallTool,
  createRememberTool,
  loadStratusSkill,
  parseSoul,
} from '@stratusagent/agents';
import {
  createAgentWorkspaces,
  createFileCredentialResolver,
  createRuntimeProvider,
  describeServingModel,
  loadOperatorSkills,
  resolveRuntimeConfig,
  servedRuntimes,
} from '@stratusagent/state';

import { loadServeMaxTurns, loadServePlugins } from '../../src/trusted-config.ts';

type Check =
  | { kind: 'readSkill' }
  | { kind: 'noToolCall'; tool: string }
  | { kind: 'matches'; pattern: string }
  | { kind: 'notMatches'; pattern: string };

interface Corpus {
  agent: { name: string; instructions: string };
  cases: Array<{
    id: string;
    title: string;
    /** The room the turn is in, as the Slack adapter would record it. */
    room: JsonObject;
    user: string;
    checks: Check[];
  }>;
}

// JSON cannot carry regex flags, so a pattern may open with `(?i)`.
const regex = (pattern: string): RegExp =>
  pattern.startsWith('(?i)') ? new RegExp(pattern.slice(4), 'i') : new RegExp(pattern);

// Read means the model asked for this skill, not merely that the reader
// was advertised: an answer from memory of other agent runtimes is the
// failure the skill exists to prevent, and it can read fluently.
const readTheSkill = (session: Session): boolean =>
  session.messages.some((message) => (message.toolCalls ?? []).some((call) =>
    call.toolName === SKILL_READ_TOOL_NAME && call.input.id === STRATUS_SKILL_ID));

// What the agent did, not what it said: a reply can be spotless while a
// tool call stored the pasted key, and that is the failure that persists.
const calledTool = (session: Session, tool: string): boolean =>
  session.messages.some((message) => (message.toolCalls ?? []).some((call) => call.toolName === tool));

const failureOf = (check: Check, reply: string, session: Session): string | undefined => {
  switch (check.kind) {
    case 'readSkill':
      return readTheSkill(session) ? undefined : `answered without reading the ${STRATUS_SKILL_ID} skill`;
    case 'noToolCall':
      return calledTool(session, check.tool) ? `called ${check.tool}` : undefined;
    case 'matches':
      return regex(check.pattern).test(reply) ? undefined : `does not match ${check.pattern}`;
    case 'notMatches':
      return regex(check.pattern).test(reply) ? `matches ${check.pattern}` : undefined;
  }
};

const argValue = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

const main = async (): Promise<void> => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const corpus = JSON.parse(await readFile(path.join(here, 'cases.json'), 'utf8')) as Corpus;

  const soulPath = argValue('--soul');
  const only = argValue('--case');
  const soul = soulPath !== undefined ? parseSoul(await readFile(soulPath, 'utf8'), { seed: soulPath }) : undefined;
  const agent: AgentDefinition = soul
    ? soul.agent
    : { id: 'kai', name: corpus.agent.name, instructions: corpus.agent.instructions };
  // A soul resolves the way a dispatch resolves it, through applySoulPins
  // (servedRuntimes runs it): a soul pinning a provider or model beats
  // STRATUS_PROVIDER and STRATUS_MODEL there, where a direct
  // resolveRuntimeConfig would let the shell win and score another model.
  const served = soul ? await servedRuntimes({}, undefined, [soul]) : undefined;
  if (served !== undefined && served.length === 0) {
    console.error(`Not run: the runtime for ${soulPath} does not resolve. \`stratus doctor\` says which provider or key it is missing.`);
    process.exitCode = 2;
    return;
  }
  const config = served?.[0]?.runtime ?? await resolveRuntimeConfig({});
  // The demo provider answers from a script, so a pass against it would be
  // a pass nobody earned. Refuse, and say what is missing.
  if (config.provider === 'demo') {
    console.error('Not run: no model is configured (the demo provider would answer). Run `stratus setup`, or set STRATUS_PROVIDER and a key, then run this again.');
    process.exitCode = 2;
    return;
  }
  // The shipped skill first, then the operator's installed skills, the way
  // the daemon loads them: the routing decision is the model choosing this
  // description among the others its soul enables, and a lone skill would
  // make that choice easier than production does. Read, never written.
  const skills = new SkillRegistry();
  skills.register(await loadStratusSkill());
  await loadOperatorSkills({}, skills, (line) => console.error(`Warning: ${line}`));

  // The plugins the daemon would load, from the same trusted config, for
  // two of the three things they contribute: a provider the config names
  // (`openai-compatible` is one), which nothing else can construct, and the
  // skills the soul may enable, which the routing decision is made among.
  // Their tools go to a registry nothing reads: this runner has no approval
  // policy, so a plugin tool here would run unattended, shell.run included.
  const pluginsConfig = await loadServePlugins({}, undefined, (line) => console.error(`Warning: ${line}`));
  const providers = new ContributionRegistry<ProviderContribution>();
  const loadedPlugins: LoadedPlugin[] = [];
  if (Object.keys(pluginsConfig).length > 0) {
    const result = await loadPlugins({
      config: pluginsConfig,
      host: {
        resolve: (specifier) => import.meta.resolve(specifier),
        import: (specifier) => import(specifier),
      },
      tools: new ToolRegistry(),
      skills,
      bus: new EventBus(),
      providers,
      memory: new ContributionRegistry<MemoryStoreContribution>(),
      executors: new ContributionRegistry<ExecutorContribution>(),
      credentials: createFileCredentialResolver({}),
      workspaces: createAgentWorkspaces({}),
    });
    loadedPlugins.push(...result.loaded);
    for (const failure of result.failures) {
      console.error(`Warning: plugin ${failure.package} did not load: ${failure.reason}`);
    }
  }
  const disposePlugins = async (): Promise<void> => {
    for (const plugin of loadedPlugins) {
      await plugin.instance.dispose?.();
    }
  };
  // The daemon's turn budget, from the same trusted config: a case that
  // needs skill.read and then credential.request spends two calls, and a
  // pass on the kernel's default says nothing about a daemon set lower.
  const maxTurns = await loadServeMaxTurns({}, undefined, (line) => console.error(`Warning: ${line}`));
  // Which cases the fallback was tried on. The wrapper switches silently
  // unless told, and a pass it earned must not be scored as the primary's.
  // It reports the switch before trying the fallback, so only a turn that
  // then completed was answered by it.
  let fellBack: string | undefined;
  try {
    // Hosted runtimes (Codex, a Claude subscription) reach kernel tools only
    // through this callback, late-bound because the runner needs the provider
    // first, as the CLI runtime and the gateway bind it. Without it they have
    // no skill.read, and every readSkill case fails whatever the model does.
    let hostedRunner: AgentRunner | undefined;
    const provider = createRuntimeProvider(config, (error) => {
      fellBack = error instanceof Error ? error.message : String(error);
    }, async (session, call, context) => {
      if (!hostedRunner) {
        throw new Error('The eval runner is not ready to execute tools yet.');
      }
      return hostedRunner.executeHostedToolCall(session, call, context);
    }, maxTurns, undefined, providers);
    // A runner per case, each with the memory tools every agent has over a
    // store of its own: never the soul's (a case like forget-me would
    // recall and retire a real fact), and never the last case's (a key the
    // pasted-secret case remembered would reach every later prompt, and the
    // cases would stop being independent).
    const runnerFor = (): AgentRunner => {
      const memory = new InMemoryAgentMemoryStore();
      const tools = new ToolRegistry();
      tools.register(createRememberTool(memory));
      tools.register(createRecallTool(memory));
      tools.register(createForgetTool(memory));
      tools.register(createPinTool(memory));
      // The real credential.request, for a soul whose tools: allow it as
      // the daemon's do, over a requester that asks nobody. It answers the
      // way the gateway does when no form can be shown here (the riskiest
      // path: a bearer link the agent must not post into a shared room), so
      // the link-in-private-channel case scores the choice production
      // offers rather than one the model never got to make.
      tools.register(createCredentialRequestTool(async () => ({
        requestId: 'eval-request',
        via: 'link',
        url: 'https://stratus.example/api/v1/credential-links/eval-not-a-real-token',
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        formUnavailable: 'The form could not be shown here: nobody who can add it can see this conversation.',
      })));
      const runner = new AgentRunner({
        provider,
        tools,
        skills,
        memory,
        store: new InMemorySessionStore(),
        bus: new EventBus(),
        ...(maxTurns !== undefined ? { maxTurns } : {}),
      });
      hostedRunner = runner;
      return runner;
    };

    const cases = only !== undefined ? corpus.cases.filter((scenario) => scenario.id === only) : corpus.cases;
    if (cases.length === 0) {
      console.error(`No case has id ${JSON.stringify(only)}. cases.json lists them.`);
      process.exitCode = 2;
      return;
    }

    let passed = 0;
    let failed = 0;
    let onFallback = 0;
    for (const scenario of cases) {
      fellBack = undefined;
      // The room a Slack turn carries, on the session and on the runtime
      // alike, so the room line under test is the one production renders.
      const metadata: JsonObject = { channel: 'slack', [CONVERSATION_METADATA_KEY]: scenario.room };
      const conversation = conversationContextFrom(metadata);
      // The runtime facts the gateway hands a served turn
      // (`runtimeContextFor`): an agent there is told where its soul is
      // and that an edit reaches its next reply, and a question this
      // answers must not be scored as though the agent had to look it up.
      const runtime = {
        ...(soulPath !== undefined ? { soulPath: path.resolve(soulPath), soulReloads: true } : {}),
        workspace: createAgentWorkspaces({}).forAgent(agent.id),
        ...(config.language !== undefined ? { language: config.language } : {}),
        model: describeServingModel(config, false),
        ...(conversation !== undefined ? { conversation } : {}),
      };
      // A turn that throws (the budget spent, the provider down) is this
      // case's failure, not the end of the run: the cases after it still
      // say something, and the total has to count it.
      let session: Session | undefined;
      let threw: string | undefined;
      try {
        session = await runnerFor().run({ sessionId: `eval:${scenario.id}`, agent, userMessage: scenario.user, metadata, runtime });
      } catch (error) {
        threw = error instanceof Error ? error.message : String(error);
      }
      const reply = session !== undefined ? latestTurnReply(session) ?? '' : '';
      const failures = session !== undefined
        ? scenario.checks.map((check) => failureOf(check, reply, session)).filter((failure) => failure !== undefined)
        : [`the turn failed: ${threw}`];
      if (failures.length === 0) {
        passed += 1;
      } else {
        failed += 1;
      }
      console.log(`${failures.length === 0 ? '✓' : '✗'} ${scenario.id} — ${scenario.title}`);
      if (failures.length > 0) {
        console.log(`  ${failures.join('; ')}`);
      }
      if (fellBack !== undefined && session !== undefined) {
        onFallback += 1;
        console.log(`  answered by the fallback, ${config.fallback?.provider} ${config.fallback?.model}: ${fellBack}`);
      } else if (fellBack !== undefined) {
        console.log(`  the primary failed (${fellBack}), and the fallback, ${config.fallback?.provider} ${config.fallback?.model}, failed too`);
      }
      console.log(`    → ${reply.replace(/\s+/g, ' ').slice(0, 200)}`);
    }
    console.log(`\nTOTAL: ${passed} passed, ${failed} failed, on ${config.provider}${'model' in config && config.model ? ` ${config.model}` : ''}${onFallback > 0 ? ` (${onFallback} answered by the fallback, ${config.fallback?.provider} ${config.fallback?.model})` : ''}`);
    if (failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await disposePlugins();
  }
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
