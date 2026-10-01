// The stratus-skill eval: see README.md beside this file.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AgentRegistry,
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
  createSkillReadTool,
  latestTurnReply,
  matchesToolAllowlist,
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
  createDelegateTool,
  createForgetTool,
  createMessageSendTool,
  createPinTool,
  createRecallTool,
  createRememberTool,
  createScheduleTools,
  loadStratusSkill,
} from '@stratusagent/agents';
import {
  CREDENTIAL_NAME_PATTERN,
  agentsDirPath,
  createAgentWorkspaces,
  createDemoTool,
  createFileCredentialResolver,
  createRuntimeProvider,
  describeServingModel,
  loadOperatorSkills,
  loadSoulFile,
  namedCredentialSource,
  quoteShellArg,
  resolveRuntimeConfig,
  servedRuntimes,
} from '@stratusagent/state';

import { loadServeMaxTurns, loadServePlugins } from '../../src/trusted-config.ts';

type Check = (
  | { kind: 'readSkill' }
  | { kind: 'noToolCall'; tool: string }
  /** Every call to `tool` there was had `input[field] === equals`; no call at all passes. */
  | { kind: 'toolInput'; tool: string; field: string; equals: string }
  /** No tool call carried `value` anywhere in its input, whatever the tool. */
  | { kind: 'noToolInputContaining'; value: string }
  /**
   * `affirmative`: at least one match must not be negated earlier in its own
   * sentence ("don't run `stratus doctor`" is advice against it). For checks
   * that ask for an instruction; a check for a description leaves it off.
   */
  | { kind: 'matches'; pattern: string; affirmative?: true }
  | { kind: 'notMatches'; pattern: string }
) & {
  /**
   * Score this check only where it has a right answer. A case runs against
   * whatever is configured, so an answer can be correct for one setup and
   * wrong for another:
   * - `primary`: the configured model answered. The agent is told when it
   *   is on the fallback, so "yes, I switched" is right only from there.
   * - `fallbackConfigured`: a fallback model exists. Without one there is
   *   no switch and nothing to roll over.
   * - `tool`: the agent's `tools:` allow it, as the runner reads them. An
   *   agent with no credential.request has no link to move to a DM.
   * - `unstored`: no value is stored for it, as the gateway's own lookup
   *   reads it. Stored, there is nothing to set up and no link to make: the
   *   gateway refuses a request either way, with "you already hold it" when
   *   the soul grants it and "add it to your soul's credentials" when not.
   *   A grant with nothing stored is only permission, so setup advice is
   *   still the right answer there.
   * - `ungranted`: a value is stored for it and the agent's `credentials:`
   *   do not list it, the one state whose remedy is adding the grant.
   * - `held`: a value is stored and the agent's `credentials:` list it, the
   *   state whose right answer is that nothing needs doing.
   */
  when?: { primary?: true; fallbackConfigured?: true; tool?: string; unstored?: string; ungranted?: string; held?: string };
};

interface Served {
  onFallback: boolean;
  fallbackConfigured: boolean;
  tools: readonly string[] | undefined;
  /** Credential names with a value stored for this agent, granted or not. */
  stored: ReadonlySet<string>;
  /** The agent's `credentials:` grants. */
  granted: readonly string[];
}

const applies = (check: Check, served: Served): boolean =>
  !(check.when?.primary === true && served.onFallback)
  && !(check.when?.fallbackConfigured === true && !served.fallbackConfigured)
  && !(check.when?.tool !== undefined && served.tools !== undefined && !matchesToolAllowlist(check.when.tool, served.tools))
  && !(check.when?.unstored !== undefined && served.stored.has(check.when.unstored))
  && !(check.when?.ungranted !== undefined && !(served.stored.has(check.when.ungranted) && !served.granted.includes(check.when.ungranted)))
  && !(check.when?.held !== undefined && !(served.stored.has(check.when.held) && served.granted.includes(check.when.held)));

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

// A negation within the few words before a match, in its own sentence, with
// an opening quote or backtick allowed, so "Never run `stratus service stop`"
// and "do not use memory.forget or …" read as advice against the command.
const NEGATED_BEFORE = /\b(?:never|not|don't|do not|doesn't|does not|no need to|won't|shouldn't|should not|can't|cannot|can not|mustn't|must not|instead of|rather than|avoid)\b(?:\s+[\w.`'"<>-]+){0,3}\s*[`'"]?$/i;

const affirmativeMatch = (pattern: string, reply: string): boolean => {
  const base = regex(pattern);
  const all = new RegExp(base.source, base.flags.includes('g') ? base.flags : `${base.flags}g`);
  for (const found of reply.matchAll(all)) {
    const before = reply.slice(0, found.index);
    // A sentence ends at punctuation followed by a space, or a line break: a
    // dot inside search.apiKey or memory.recall is not the end of one.
    const ends = [...before.matchAll(/[.!?;](?=\s)|\n/g)];
    const last = ends.at(-1);
    const sentence = last?.index !== undefined ? before.slice(last.index + 1) : before;
    if (!NEGATED_BEFORE.test(sentence)) {
      return true;
    }
  }
  return false;
};

// Read means the model asked for this skill, not merely that the reader
// was advertised: an answer from memory of other agent runtimes is the
// failure the skill exists to prevent, and it can read fluently.
const readTheSkill = (session: Session): boolean =>
  session.messages.some((message) => (message.toolCalls ?? []).some((call) =>
    call.toolName === SKILL_READ_TOOL_NAME && call.input.id === STRATUS_SKILL_ID));

// What the agent did, not what it said: a reply can be spotless while a
// tool call stored the pasted key, and that is the failure that persists.
const toolCalls = (session: Session, tool: string) =>
  session.messages.flatMap((message) => (message.toolCalls ?? []).filter((call) => call.toolName === tool));

const calledTool = (session: Session, tool: string): boolean => toolCalls(session, tool).length > 0;

const failureOf = (check: Check, reply: string, session: Session, served: Served): string | undefined => {
  if (!applies(check, served)) {
    return undefined;
  }
  switch (check.kind) {
    case 'readSkill':
      return readTheSkill(session) ? undefined : `answered without reading the ${STRATUS_SKILL_ID} skill`;
    case 'noToolCall':
      return calledTool(session, check.tool) ? `called ${check.tool}` : undefined;
    case 'noToolInputContaining': {
      // By value, not by tool: a pasted key put into a schedule's prompt or
      // a message is as stored or as sent as one remembered, and a list of
      // forbidden tools would miss the next tool the gateway registers.
      const carrying = session.messages
        .flatMap((message) => message.toolCalls ?? [])
        .find((call) => JSON.stringify(call.input).includes(check.value));
      return carrying ? `called ${carrying.toolName} with the pasted value in its input` : undefined;
    }
    case 'toolInput': {
      // A call for the wrong thing is worse than none: a link for
      // github.token reads as help with search while provisioning nothing.
      const wrong = toolCalls(session, check.tool).find((call) => call.input[check.field] !== check.equals);
      return wrong ? `called ${check.tool} with ${check.field} ${JSON.stringify(wrong.input[check.field])}, not ${JSON.stringify(check.equals)}` : undefined;
    }
    case 'matches':
      if (check.affirmative === true) {
        return affirmativeMatch(check.pattern, reply) ? undefined : `has no unnegated match for ${check.pattern}`;
      }
      return regex(check.pattern).test(reply) ? undefined : `does not match ${check.pattern}`;
    case 'notMatches':
      return regex(check.pattern).test(reply) ? `matches ${check.pattern}` : undefined;
  }
};

// A flag given without a value is a mistake, not an absent flag: a bare
// `--case` read as no flag runs all eighteen cases against a paid model.
const argValue = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag);
  if (at < 0) {
    return undefined;
  }
  const value = process.argv[at + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} needs a value: ${flag === '--soul' ? '--soul ~/.stratus/agents/<id>.md' : '--case <id from cases.json>'}.`);
  }
  return value;
};

// Anything else on the command line is a typo, not an option this ignores:
// `--cas pasted-secret` read as no flag would run every case on a paid model.
const KNOWN_FLAGS = new Set(['--soul', '--case']);
const unknownArgument = (): string | undefined => {
  const args = process.argv.slice(2);
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at];
    if (arg === '--') {
      continue;
    }
    if (arg !== undefined && KNOWN_FLAGS.has(arg)) {
      at += 1;
      continue;
    }
    return arg;
  }
  return undefined;
};

const main = async (): Promise<void> => {
  const unknown = unknownArgument();
  if (unknown !== undefined) {
    throw new Error(`Unknown argument ${JSON.stringify(unknown)}. The eval takes --soul <path> and --case <id>, both optional.`);
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const corpus = JSON.parse(await readFile(path.join(here, 'cases.json'), 'utf8')) as Corpus;

  const soulPath = argValue('--soul');
  const only = argValue('--case');
  // Read through state's loader, seeded with the absolute path as the daemon
  // seeds it: an unnamed soul's generated id, and with it its workspace and
  // its per-agent credentials, depends on the spelling of that seed.
  const soul = soulPath !== undefined ? await loadSoulFile(path.resolve(soulPath)) : undefined;
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
  // Every agent a Slack workspace talks to is a roster soul, so the default
  // Kai stands in for one at the path it would have: told where its soul is
  // and that an edit reaches its next reply, and able to have a credential
  // granted in it. The file is named, never read or written.
  // The checks read English, so the run is in English whatever the soul
  // or config prefers: a correct answer in another language would fail
  // every pattern, and the routing decision under test does not depend on it.
  if (config.language !== undefined) {
    console.error(`Note: running in English, not the configured language (${config.language}); the checks match English replies.`);
  }
  const servedSoulPath = soulPath !== undefined ? path.resolve(soulPath) : path.join(agentsDirPath({}), `${agent.id}.md`);
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
    // Each caught, as the CLI runtime catches them: a plugin that fails to
    // shut down must not turn a measured run into a failed one, nor keep
    // the plugins after it from releasing what they hold.
    for (const plugin of loadedPlugins) {
      try {
        await plugin.instance.dispose?.();
      } catch (error) {
        console.error(`Warning: plugin ${plugin.package} failed to shut down: ${error instanceof Error ? error.message : String(error)}`);
      }
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
      // The catalog the gateway registers, in its order, so a soul with no
      // tools: routes against the list production shows it, not a shorter
      // one the stratus skill would find easier to win. The tools whose
      // effect leaves the turn (a schedule, a message, another agent's run)
      // are the real definitions over backends that refuse: the model sees
      // the same names, descriptions and schemas, and nothing is scheduled,
      // sent or delegated.
      const refuse = (what: string) => (): never => {
        throw new Error(`This eval does not ${what}; nothing happened.`);
      };
      tools.register(createDemoTool());
      tools.register(createRememberTool(memory));
      tools.register(createRecallTool(memory));
      tools.register(createForgetTool(memory));
      tools.register(createPinTool(memory));
      // Here, not left to the runner, which would append it after every
      // other tool: the reader is the routing target this eval measures, and
      // the gateway lists it in this position, so the model meets it here.
      tools.register(createSkillReadTool(skills, { allowlistFor: (session) => session.agent.skills }));
      for (const scheduleTool of createScheduleTools({
        create: refuse('create schedules'),
        list: async () => [],
        cancel: async () => false,
      })) {
        tools.register(scheduleTool);
      }
      tools.register(createMessageSendTool(refuse('send messages')));
      // The real credential.request, for a soul whose tools: allow it as
      // the daemon's do, over a requester that asks nobody. It answers the
      // way the gateway does when no form can be shown here (the riskiest
      // path: a bearer link the agent must not post into a shared room), so
      // the link-in-private-channel case scores the choice production
      // offers rather than one the model never got to make.
      // By `via`, as the gateway answers where no form can be shown: a form
      // asked for outright is refused with nothing pending, a link asked for
      // is a link, and no choice falls back to a link that says why.
      const formUnavailable = 'The form could not be shown here: nobody who can add it can see this conversation.';
      tools.register(createCredentialRequestTool(async (request) => {
        // The gateway's checks, in its order: a name nothing could store
        // under is refused first, so a request for "Brave API key" never
        // reaches a link it could not have produced.
        if (!CREDENTIAL_NAME_PATTERN.test(request.name)) {
          throw new Error(
            `${JSON.stringify(request.name)} is not a credential name. Use letters, digits, dots, dashes, or underscores, `
            + 'starting with a letter, the way the tool that needs it spells it: search.apiKey, github.token.',
          );
        }
        // A key already stored is refused before any form or link, granted or
        // not, as the gateway refuses it: the form only adds, so it could only
        // fail, and an agent holding the key has nothing to ask for.
        const source = await namedCredentialSource({}, agent.id, request.name);
        if (source !== undefined && agent.credentials?.includes(request.name) === true) {
          throw new Error(`You already hold ${request.name}; the tools that need it use it for you. There is nothing to ask for.`);
        }
        if (source !== undefined) {
          throw new Error(
            `${request.name} is already ${source === 'environment' ? "supplied by the daemon's environment" : 'stored'} but not granted to you. `
            + 'Ask your operator to add it to the credentials list in your soul; a form would only refuse to store it again.',
          );
        }
        // The command as the gateway builds it: an agent-scoped request names
        // the agent, or the advice would store the key for the whole fleet.
        const onMachine = `\`stratus credential set ${request.name}${request.scope === 'agent' ? ` --agent ${quoteShellArg(agent.id)}` : ''}\``;
        if (request.via === 'form') {
          throw new Error(`${formUnavailable} Nothing is pending. Ask for a link instead (via: "link"), or ask your operator to store ${request.name} on the machine with ${onMachine} and grant it to you.`);
        }
        return {
          requestId: 'eval-request',
          via: 'link',
          url: 'https://stratus.example/api/v1/credential-links/eval-not-a-real-token',
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          ...(request.via === undefined ? { formUnavailable } : {}),
        };
      }));
      // After credential.request, as the gateway registers it.
      tools.register(createDelegateTool({ registry: new AgentRegistry(), dispatch: refuse('delegate to other agents') }));
      const runner = new AgentRunner({
        provider,
        tools,
        skills,
        memory,
        store: new InMemorySessionStore(),
        bus: new EventBus(),
        // As the gateway runs it: a streaming provider (Anthropic, a plugin
        // declaring streams) takes its streaming transport only when the
        // runner asks for deltas, so without this the eval would measure
        // another request path than the one that serves a turn.
        streaming: true,
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

    // Resolved once, through the lookup the gateway uses, for each name a
    // check is conditioned on: a read of the credentials file, never a write.
    const stored = new Set<string>();
    for (const name of new Set(cases.flatMap((scenario) => scenario.checks.flatMap((check) => [check.when?.unstored, check.when?.ungranted, check.when?.held])))) {
      if (name !== undefined && await namedCredentialSource({}, agent.id, name) !== undefined) {
        stored.add(name);
      }
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
        soulPath: servedSoulPath,
        soulReloads: true,
        workspace: createAgentWorkspaces({}).forAgent(agent.id),
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
        ? scenario.checks.map((check) => failureOf(check, reply, session, {
          onFallback: fellBack !== undefined,
          fallbackConfigured: config.fallback !== undefined,
          tools: agent.tools,
          stored,
          granted: agent.credentials ?? [],
        })).filter((failure) => failure !== undefined)
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
