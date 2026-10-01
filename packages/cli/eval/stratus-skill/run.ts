// The stratus-skill eval: see README.md beside this file.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AgentRunner,
  CONVERSATION_METADATA_KEY,
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
  type JsonObject,
  type Session,
} from '@stratusagent/core';
import {
  createForgetTool,
  createPinTool,
  createRecallTool,
  createRememberTool,
  loadStratusSkill,
  parseSoul,
} from '@stratusagent/agents';
import { createRuntimeProvider, describeServingModel, loadOperatorSkills, resolveRuntimeConfig } from '@stratusagent/state';

type Check =
  | { kind: 'readSkill' }
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

const failureOf = (check: Check, reply: string, session: Session): string | undefined => {
  switch (check.kind) {
    case 'readSkill':
      return readTheSkill(session) ? undefined : `answered without reading the ${STRATUS_SKILL_ID} skill`;
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
  const agent: AgentDefinition = soulPath
    ? parseSoul(await readFile(soulPath, 'utf8'), { seed: soulPath }).agent
    : { id: 'kai', name: corpus.agent.name, instructions: corpus.agent.instructions };
  const config = await resolveRuntimeConfig(soulPath ? { soul: soulPath } : {});
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
  // The memory tools every agent has, over a store that dies with the run:
  // a case like forget-me would otherwise recall and retire a real fact
  // from the soul's own memory. Plugins are not loaded, because a plugin is
  // code with side effects; README.md says what that leaves out.
  const memory = new InMemoryAgentMemoryStore();
  const tools = new ToolRegistry();
  tools.register(createRememberTool(memory));
  tools.register(createRecallTool(memory));
  tools.register(createForgetTool(memory));
  tools.register(createPinTool(memory));
  // Hosted runtimes (Codex, a Claude subscription) reach kernel tools only
  // through this callback, late-bound because the runner needs the provider
  // first, as the CLI runtime and the gateway bind it. Without it they have
  // no skill.read, and every readSkill case fails whatever the model does.
  let hostedRunner: AgentRunner | undefined;
  const provider = createRuntimeProvider(config, undefined, async (session, call, context) => {
    if (!hostedRunner) {
      throw new Error('The eval runner is not ready to execute tools yet.');
    }
    return hostedRunner.executeHostedToolCall(session, call, context);
  });
  const runner = new AgentRunner({ provider, tools, skills, memory, store: new InMemorySessionStore(), bus: new EventBus() });
  hostedRunner = runner;

  const cases = only !== undefined ? corpus.cases.filter((scenario) => scenario.id === only) : corpus.cases;
  if (cases.length === 0) {
    console.error(`No case has id ${JSON.stringify(only)}. cases.json lists them.`);
    process.exitCode = 2;
    return;
  }

  let passed = 0;
  let failed = 0;
  for (const scenario of cases) {
    // The room a Slack turn carries, on the session and on the runtime
    // alike, so the room line under test is the one production renders.
    const metadata: JsonObject = { channel: 'slack', [CONVERSATION_METADATA_KEY]: scenario.room };
    const conversation = conversationContextFrom(metadata);
    const runtime = {
      ...(config.language !== undefined ? { language: config.language } : {}),
      model: describeServingModel(config, false),
      ...(conversation !== undefined ? { conversation } : {}),
    };
    const session = await runner.run({ sessionId: `eval:${scenario.id}`, agent, userMessage: scenario.user, metadata, runtime });
    const reply = latestTurnReply(session) ?? '';
    const failures = scenario.checks.map((check) => failureOf(check, reply, session)).filter((failure) => failure !== undefined);
    if (failures.length === 0) {
      passed += 1;
    } else {
      failed += 1;
    }
    console.log(`${failures.length === 0 ? '✓' : '✗'} ${scenario.id} — ${scenario.title}`);
    if (failures.length > 0) {
      console.log(`  ${failures.join('; ')}`);
    }
    console.log(`    → ${reply.replace(/\s+/g, ' ').slice(0, 200)}`);
  }
  console.log(`\nTOTAL: ${passed} passed, ${failed} failed, on ${config.provider}${'model' in config && config.model ? ` ${config.model}` : ''}`);
  if (failed > 0) {
    process.exitCode = 1;
  }
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
