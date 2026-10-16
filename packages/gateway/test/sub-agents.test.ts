import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { JsonObject, Session, StratusEvent, SubAgentHandle, SubAgentOutcome, ExecutionContext } from '@stratusagent/core';
import { createPermissionPolicy } from '@stratusagent/permissions';
import type { OptionalModuleHost } from '@stratusagent/plugins';
import { agentMemoryFilePath } from '@stratusagent/state';

import { createGateway, type ApprovalTransport } from '../src/index.ts';

// Roadmap 24: the host primitive a sub-agent plugin (`agent.spawn`) runs
// on. The plugin here is a stand-in that fans tasks out through it; what
// is under test is what the host enforces whatever a plugin asks for.

const newHome = async (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'stratus-gw-sub-'));

const SOUL = [
  '---',
  'id: ava',
  'name: Ava',
  'provider: openai',
  'model: model-a',
  'tools: [test.*, memory.*]',
  '---',
  '',
  'You are Ava, and your persona is PERSONA-MARKER.',
  '',
].join('\n');

const writeSoul = async (home: string, contents = SOUL): Promise<void> => {
  const dir = path.join(home, '.stratus', 'agents');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'ava.md'), contents);
};

const hostFor = async (module: unknown): Promise<OptionalModuleHost> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-gw-sub-pkgs-'));
  const directory = path.join(root, 'fanout');
  await mkdir(path.join(directory, 'dist'), { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({
    name: 'stratus-plugin-fanout',
    stratus: {
      pluginVersion: 1,
      contributes: {
        tools: [
          { name: 'test.fanout', risk: 'safe' },
          { name: 'test.echo', risk: 'safe' },
          { name: 'test.gated', risk: 'gated' },
        ],
      },
    },
  }));
  return {
    resolve(specifier) {
      if (specifier !== 'stratus-plugin-fanout') {
        throw new Error(`Cannot find package '${specifier}'`);
      }
      return pathToFileURL(path.join(directory, 'dist', 'index.js')).href;
    },
    async import() {
      return module;
    },
  };
};

const openAiText = (text: string): Response =>
  new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const openAiToolCall = (name: string, args: object, id = 'call-1'): Response =>
  new Response(JSON.stringify({
    choices: [{
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      },
    }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });

interface SeenRequest {
  system: string;
  firstUser: string;
  lastRole: string;
  tools: string[];
}

const readRequest = (init: RequestInit | undefined): SeenRequest => {
  const body = JSON.parse(String(init?.body ?? '{}')) as {
    messages?: Array<{ role: string; content?: unknown }>;
    tools?: Array<{ function?: { name?: string } }>;
  };
  const messages = body.messages ?? [];
  const text = (content: unknown): string => typeof content === 'string'
    ? content
    : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? '').join('') : '';
  return {
    system: messages.filter((message) => message.role === 'system').map((message) => text(message.content)).join('\n'),
    firstUser: text(messages.find((message) => message.role === 'user')?.content),
    lastRole: messages.at(-1)?.role ?? '',
    tools: (body.tools ?? []).map((tool) => tool.function?.name ?? ''),
  };
};

type Task = { instruction: string; tools?: string[]; model?: string };

/**
 * A gateway whose one agent, Ava, asks `test.fanout` to run `tasks` and
 * then says "done". Sub-agent requests are answered by `subAgent`.
 */
const fanoutGateway = async (options: {
  tasks: Task[];
  subAgent: (request: SeenRequest) => Promise<Response> | Response;
  soul?: string;
  approvals?: 'remote' | 'headless';
  subAgents?: { maxConcurrentPerTurn?: number };
  echo?: (input: JsonObject) => unknown;
  answer?: 'once' | 'always';
}) => {
  const home = await newHome();
  await writeSoul(home, options.soul);
  const parentRequests: SeenRequest[] = [];
  const subRequests: SeenRequest[] = [];
  const fetchFake = (async (_url: string | URL | Request, init?: RequestInit) => {
    const request = readRequest(init);
    if (request.firstUser.includes('PARENT-GATED')) {
      parentRequests.push(request);
      return request.lastRole === 'tool' ? openAiText('done') : openAiToolCall('test_gated', {}, 'gated-1');
    }
    if (request.firstUser.includes('PARENT-TASK')) {
      parentRequests.push(request);
      return request.lastRole === 'tool' ? openAiText('done') : openAiToolCall('test_fanout', { tasks: options.tasks });
    }
    subRequests.push(request);
    // As real fetch does: an aborted request rejects at once.
    const signal = init?.signal ?? undefined;
    if (!signal) {
      return options.subAgent(request);
    }
    return Promise.race([
      options.subAgent(request),
      new Promise<never>((_resolve, reject) => {
        const fail = (): void => reject(signal.reason ?? new Error('aborted'));
        if (signal.aborted) {
          fail();
        } else {
          signal.addEventListener('abort', fail, { once: true });
        }
      }),
    ]);
  }) as typeof fetch;

  const outcomes: Array<SubAgentOutcome | { refused: string }> = [];
  let handle: SubAgentHandle | undefined;
  const echoCalls: JsonObject[] = [];
  const module = {
    createPlugin: () => ({
      name: 'fanout',
      setup(context: { tools: { register(tool: unknown): void }; subAgents?: SubAgentHandle }) {
        handle = context.subAgents;
        context.tools.register({
          name: 'test.fanout',
          risk: 'safe',
          async execute(input: JsonObject, session: Session, toolContext?: ExecutionContext) {
            const tasks = (input.tasks ?? []) as Task[];
            const settled = await Promise.all(tasks.map(async (task) => {
              try {
                return await context.subAgents!.run({
                  parent: session,
                  instruction: task.instruction,
                  tools: task.tools ?? [],
                  ...(task.model !== undefined ? { model: task.model } : {}),
                  ...(toolContext?.signal ? { signal: toolContext.signal } : {}),
                });
              } catch (error) {
                return { refused: error instanceof Error ? error.message : String(error) };
              }
            }));
            outcomes.push(...settled);
            return settled as unknown as JsonObject[];
          },
        });
        context.tools.register({
          name: 'test.echo',
          risk: 'safe',
          async execute(input: JsonObject) {
            echoCalls.push(input);
            return options.echo ? options.echo(input) : 'echoed';
          },
        });
        context.tools.register({
          name: 'test.gated',
          risk: 'gated',
          async execute() {
            return 'gated ran';
          },
        });
      },
    }),
  };

  const asked: StratusEvent[] = [];
  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchFake },
    idleTimeoutMs: 0,
    plugins: { 'stratus-plugin-fanout': { enabled: true } },
    pluginHost: await hostFor(module),
    ...(options.subAgents ? { subAgents: options.subAgents } : {}),
    ...(options.approvals === 'remote'
      ? {
          approvals: (transport: ApprovalTransport) =>
            createPermissionPolicy({ mode: 'remote', request: transport.request, destinations: transport.destinations }),
        }
      : {}),
    log: () => undefined,
    warn: () => undefined,
  });
  gateway.bus.subscribe((event: StratusEvent) => {
    if (event.type === 'tool.approval-requested') {
      asked.push(event);
      gateway.resolveApproval({ requestId: event.requestId, answer: options.answer ?? 'once', actor: 'U-DYLAN' });
    }
  });
  return { home, gateway, parentRequests, subRequests, outcomes, handle: () => handle, echoCalls, asked };
};

test('a plugin is handed the sub-agent primitive, and sub-agents started together run together', async () => {
  let inFlight = 0;
  let peak = 0;
  let release!: () => void;
  const allThree = new Promise<void>((resolve) => {
    release = resolve;
  });
  const harness = await fanoutGateway({
    tasks: [{ instruction: 'say A' }, { instruction: 'say B' }, { instruction: 'say C' }],
    subAgent: async (request) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      if (inFlight === 3) {
        release();
      }
      // Each waits for all three: serial execution never gets here.
      await Promise.race([allThree, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      inFlight -= 1;
      return openAiText(request.firstUser.replace('say ', 'answer '));
    },
  });
  await harness.gateway.start();
  try {
    assert.ok(harness.handle(), 'the daemon gave the plugin no sub-agent handle');
    const parent = await harness.gateway.dispatch({ sessionId: 'parent-1', agentId: 'ava', userMessage: 'PARENT-TASK fan out' });
    assert.equal(parent.status, 'completed');
    assert.equal(peak, 3, 'the three sub-agents overlapped');
    assert.deepEqual(
      harness.outcomes.map((outcome) => ('status' in outcome ? [outcome.status, outcome.status === 'result' ? outcome.text : ''] : ['refused', outcome.refused])),
      [['result', 'answer A'], ['result', 'answer B'], ['result', 'answer C']],
    );
    // Each ran as a durable child of the parent's session, under Ava.
    for (const outcome of harness.outcomes) {
      assert.ok('sessionId' in outcome && typeof outcome.sessionId === 'string');
      const child = await harness.gateway.store.get(outcome.sessionId!);
      assert.equal(child?.agent.id, 'ava');
      assert.ok(child?.id.startsWith('parent-1:subagent:'), child?.id);
      assert.equal(child?.metadata?.rootSessionId, 'parent-1');
      assert.equal(child?.metadata?.delegationDepth, 1);
    }
  } finally {
    await harness.gateway.stop();
  }
});

test('a sub-agent gets its instruction and its slice: no persona, no memory, no tool it was not handed', async () => {
  const harness = await fanoutGateway({
    tasks: [{ instruction: 'look it up', tools: ['test.echo'] }],
    subAgent: () => openAiText('looked'),
  });
  // Something Ava remembers, so a memory section would show if it leaked.
  const memoryFile = agentMemoryFilePath({ homeDir: harness.home, cwd: harness.home, processEnv: {} }, 'ava');
  await mkdir(path.dirname(memoryFile), { recursive: true });
  await writeFile(memoryFile, `${JSON.stringify({ id: 'ava:memory:1', agentId: 'ava', content: 'MEMORY-MARKER', createdAt: '2026-01-01T00:00:00.000Z' })}\n`);
  await harness.gateway.start();
  try {
    await harness.gateway.dispatch({ sessionId: 'parent-2', agentId: 'ava', userMessage: 'PARENT-TASK fan out' });
  } finally {
    await harness.gateway.stop();
  }
  const [sub] = harness.subRequests;
  assert.ok(sub);
  assert.equal(sub.firstUser, 'look it up');
  assert.doesNotMatch(sub.system, /PERSONA-MARKER/, 'the parent persona reached the sub-agent');
  assert.doesNotMatch(sub.system, /MEMORY-MARKER/, 'the parent\'s memory reached the sub-agent');
  // The parent itself still has both.
  assert.match(harness.parentRequests[0]?.system ?? '', /PERSONA-MARKER/);
  assert.match(harness.parentRequests[0]?.system ?? '', /MEMORY-MARKER/);
  assert.deepEqual(sub.tools, ['test_echo']);
});

test('a slice is refused at the start, naming the tool, when it is not the parent\'s or is never a sub-agent\'s', async () => {
  const harness = await fanoutGateway({
    soul: SOUL.replace('tools: [test.*, memory.*]', 'tools: [test.echo, test.fanout, memory.*, agent.delegate]'),
    tasks: [
      { instruction: 'widen', tools: ['test.gated'] },
      { instruction: 'remember', tools: ['memory.remember'] },
      { instruction: 'escape', tools: ['agent.delegate'] },
      { instruction: 'recurse', tools: ['test.fanout', 'agent.spawn'] },
      { instruction: 'glob', tools: ['test.*'] },
      { instruction: 'model', model: 'model-z' },
    ],
    subAgent: () => openAiText('should not run'),
  });
  await harness.gateway.start();
  try {
    await harness.gateway.dispatch({ sessionId: 'parent-3', agentId: 'ava', userMessage: 'PARENT-TASK fan out' });
  } finally {
    await harness.gateway.stop();
  }
  assert.equal(harness.subRequests.length, 0, 'a refused sub-agent ran');
  const refusals = harness.outcomes.map((outcome) => ('refused' in outcome ? outcome.refused : `ran: ${outcome.status}`));
  assert.match(refusals[0] ?? '', /test\.gated.*not.*ava|ava.*test\.gated/i);
  assert.match(refusals[1] ?? '', /memory\.remember/);
  assert.match(refusals[2] ?? '', /agent\.delegate/);
  assert.match(refusals[3] ?? '', /agent\.spawn/);
  assert.match(refusals[4] ?? '', /test\.\*/);
  assert.match(refusals[5] ?? '', /model/);
});

test('a gated call inside a sub-agent fails there and asks no one', async () => {
  const harness = await fanoutGateway({
    approvals: 'remote',
    tasks: [{ instruction: 'try the gated tool', tools: ['test.gated'] }],
    subAgent: (request) => request.lastRole === 'tool' ? openAiText('could not') : openAiToolCall('test_gated', {}, 'sub-call-1'),
  });
  await harness.gateway.start();
  let child: Session | undefined;
  try {
    await harness.gateway.dispatch({ sessionId: 'parent-4', agentId: 'ava', userMessage: 'PARENT-TASK fan out' });
    const [outcome] = harness.outcomes;
    assert.ok(outcome && 'status' in outcome);
    child = await harness.gateway.store.get(outcome.sessionId!);
  } finally {
    await harness.gateway.stop();
  }
  // The parent's own call to the (untrusted, so gated) fan-out tool is
  // asked as usual; nothing is asked for the sub-agent.
  assert.deepEqual(
    harness.asked.filter((event) => 'sessionId' in event && event.sessionId.includes(':subagent:')),
    [],
    'a human was asked on a sub-agent\'s behalf',
  );
  assert.equal(harness.asked.length, 1);
  const result = child?.messages.find((message) => message.toolResult)?.toolResult;
  assert.equal(result?.ok, false);
  assert.match(result?.error ?? '', /denied/);
});

test('one failure is a result beside the others, and nothing comes back as empty', async () => {
  const harness = await fanoutGateway({
    tasks: [{ instruction: 'say A' }, { instruction: 'BREAK' }, { instruction: 'QUIET' }],
    subAgent: (request) => {
      if (request.firstUser === 'BREAK') {
        return new Response(JSON.stringify({ error: { message: 'bad request' } }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
      // Whitespace: an empty reply is the provider's error, not a quiet run.
      return openAiText(request.firstUser === 'QUIET' ? '   ' : 'answer A');
    },
  });
  await harness.gateway.start();
  try {
    const parent = await harness.gateway.dispatch({ sessionId: 'parent-5', agentId: 'ava', userMessage: 'PARENT-TASK fan out' });
    assert.equal(parent.status, 'completed', 'a failed sub-agent failed the parent turn');
  } finally {
    await harness.gateway.stop();
  }
  assert.deepEqual(harness.outcomes.map((outcome) => ('status' in outcome ? outcome.status : 'refused')), ['result', 'error', 'empty']);
  const failed = harness.outcomes[1] as Extract<SubAgentOutcome, { status: 'error' }>;
  assert.match(failed.error, /400|bad request/);
});

test('a standing grant the parent holds carries to a sub-agent handed that tool, which uses it unattended', async () => {
  const harness = await fanoutGateway({
    approvals: 'remote',
    answer: 'always',
    tasks: [{ instruction: 'use the gated tool', tools: ['test.gated'] }],
    subAgent: (request) => request.lastRole === 'tool' ? openAiText('used it') : openAiToolCall('test_gated', {}, 'sub-call-1'),
  });
  await harness.gateway.start();
  let child: Session | undefined;
  try {
    // Ava's own turn: the person answers Always allow.
    await harness.gateway.dispatch({ sessionId: 'grant-1', agentId: 'ava', userMessage: 'PARENT-GATED run it' });
    const askedBefore = harness.asked.length;
    await harness.gateway.dispatch({ sessionId: 'parent-9', agentId: 'ava', userMessage: 'PARENT-TASK fan out' });
    const [outcome] = harness.outcomes;
    assert.ok(outcome && 'status' in outcome);
    child = await harness.gateway.store.get(outcome.sessionId);
    assert.deepEqual(
      harness.asked.slice(askedBefore).filter((event) => 'sessionId' in event && event.sessionId.includes(':subagent:')),
      [],
    );
  } finally {
    await harness.gateway.stop();
  }
  const result = child?.messages.find((message) => message.toolResult)?.toolResult;
  assert.equal(result?.ok, true, result?.error);
  assert.equal(result?.output, 'gated ran');
});

test('sub-agents beyond the per-turn cap wait for a slot rather than run', async () => {
  let inFlight = 0;
  let peak = 0;
  const harness = await fanoutGateway({
    subAgents: { maxConcurrentPerTurn: 2 },
    tasks: [{ instruction: 'one' }, { instruction: 'two' }, { instruction: 'three' }, { instruction: 'four' }],
    subAgent: async (request) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 40));
      inFlight -= 1;
      return openAiText(`did ${request.firstUser}`);
    },
  });
  await harness.gateway.start();
  try {
    await harness.gateway.dispatch({ sessionId: 'parent-6', agentId: 'ava', userMessage: 'PARENT-TASK fan out' });
  } finally {
    await harness.gateway.stop();
  }
  assert.equal(peak, 2);
  assert.deepEqual(harness.outcomes.map((outcome) => ('status' in outcome ? outcome.status : 'refused')), ['result', 'result', 'result', 'result']);
});

test('cancelling the parent turn stops every sub-agent it started', async () => {
  let started = 0;
  const controller = new AbortController();
  const harness = await fanoutGateway({
    tasks: [{ instruction: 'slow one' }, { instruction: 'slow two' }],
    subAgent: async () => {
      started += 1;
      if (started === 2) {
        setTimeout(() => controller.abort(), 10);
      }
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      return openAiText('too late');
    },
  });
  await harness.gateway.start();
  const startedAt = Date.now();
  try {
    await assert.rejects(() => harness.gateway.dispatch({
      sessionId: 'parent-7',
      agentId: 'ava',
      userMessage: 'PARENT-TASK fan out',
      signal: controller.signal,
    }));
    assert.ok(Date.now() - startedAt < 2_500, 'the parent waited out its sub-agents');
    // Past the point the slow replies would have landed.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const children = harness.gateway.store.list('ava').filter((session) => session.id.startsWith('parent-7:subagent:'));
    assert.equal(children.length, 2);
    for (const child of children) {
      assert.notEqual(child.status, 'completed', `${child.id} ran on after the cancel`);
    }
  } finally {
    await harness.gateway.stop();
  }
});

test('the primitive answers only for a turn that is running, and never for a sub-agent', async () => {
  const harness = await fanoutGateway({
    tasks: [{ instruction: 'nested', tools: ['test.echo'] }],
    subAgent: () => openAiText('ok'),
  });
  await harness.gateway.start();
  try {
    await harness.gateway.dispatch({ sessionId: 'parent-8', agentId: 'ava', userMessage: 'PARENT-TASK fan out' });
    const handle = harness.handle()!;
    // The parent's turn is over.
    await assert.rejects(() => handle.run({ parent: { id: 'parent-8' }, instruction: 'late', tools: [] }), /running/);
    // A session nobody has.
    await assert.rejects(() => handle.run({ parent: { id: 'no-such-session' }, instruction: 'x', tools: [] }), /no-such-session/);
    // A sub-agent's own session cannot start more.
    const [outcome] = harness.outcomes;
    assert.ok(outcome && 'sessionId' in outcome);
    await assert.rejects(() => handle.run({ parent: { id: outcome.sessionId! }, instruction: 'x', tools: [] }), /sub-agent/);
  } finally {
    await harness.gateway.stop();
  }
});
