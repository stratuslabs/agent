import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  AllowAllApprovalPolicy,
  carriesKey,
  SENDER_TRUST_METADATA_KEY,
  type AgentDefinition,
  type JsonObject,
  type Message,
  type PluginContext,
  type ProviderResponse,
  type Session,
  type SteeredMessage,
  type ToolResult,
} from '@stratusagent/core';
import { TASK_ID_METADATA_KEY } from '@stratusagent/agents';
import type { OptionalModuleHost } from '@stratusagent/plugins';
import { fleetDbIn } from '@stratusagent/state';

import { createBackgroundTasks } from '../src/background-tasks.ts';
import { createGateway } from '../src/index.ts';
import { ShardedSessionStore } from '../src/sessions.ts';
import { taskOutcomeKey } from '../src/task-settle.ts';
import { SqliteTaskStore, type TaskRow } from '../src/tasks.ts';
import type { DispatchInput, GatewayOptions } from '../src/types.ts';

// agent.messageTask: a follow-up from the conversation that started a
// background task reaches the task's running turn at its next tool step,
// through the steering path a person's follow-up takes. Only that
// conversation may send one. One the task never read is listed in its
// outcome notice. An ended task takes none, and one call is passed on once.

const until = async (what: string, check: () => Promise<boolean> | boolean, ms = 5_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const writeSoul = async (home: string, file: string, contents: string): Promise<void> => {
  const dir = path.join(home, '.stratus', 'agents');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, file), contents);
};

const hostFor = async (packages: Record<string, { manifest: unknown; module?: unknown }>): Promise<OptionalModuleHost> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-gw-task-message-pkgs-'));
  const entries = new Map<string, string>();
  for (const [name, entry] of Object.entries(packages)) {
    const directory = path.join(root, name.replace(/[@/]/g, '_'));
    await mkdir(path.join(directory, 'dist'), { recursive: true });
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, ...(entry.manifest as object) }));
    entries.set(name, pathToFileURL(path.join(directory, 'dist', 'index.js')).href);
  }
  return {
    resolve(specifier) {
      const resolved = entries.get(specifier);
      if (!resolved) {
        throw new Error(`Cannot find package '${specifier}'`);
      }
      return resolved;
    },
    async import(specifier) {
      return packages[specifier]?.module ?? {};
    },
  };
};

const manifest = (contributes: Record<string, unknown>) => ({ stratus: { pluginVersion: 1, contributes } });

const plugin = (name: string, setup: (context: PluginContext) => void | Promise<void>) => ({
  createPlugin: () => ({ name, setup }),
});

const lastUser = (session: Session): Message | undefined =>
  [...session.messages].reverse().find((candidate) => candidate.role === 'user');

/** One tool call an origin turn makes, as JSON in its message. */
interface Ask {
  tool: string;
  input: Record<string, unknown>;
}

/**
 * A gateway whose agents run on a scripted provider. An origin turn's
 * message is an `Ask`: it makes that one call, then says what came back.
 * A worker's prompt says what it does: STEP calls `fixture.wait`, which
 * holds until `releaseTool`, then answers with any follow-up that reached
 * it; HOLD holds in the provider until `releaseHold`, then answers with no
 * tool step at all; anything else answers at once.
 */
const messageGateway = async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-gw-task-message-'));
  await writeSoul(home, 'ava.md', [
    '---', 'name: Ava', 'id: ava', 'provider: scripted',
    'tools: [agent.delegate, agent.tasks, agent.cancelTask, agent.messageTask, fixture.wait]',
    '---', '', 'You are Ava.', '',
  ].join('\n'));
  const toolHeld: Array<() => void> = [];
  const providerHeld: Array<() => void> = [];
  const host = await hostFor({
    'stratus-plugin-fixture-chan': {
      manifest: manifest({ channels: [{ name: 'fixture' }] }),
      module: plugin('chan', (context) => {
        context.channels!.register({
          agents: ['ava'],
          adapter: {
            name: 'fixture',
            async start() {},
            async stop() {},
            sessionConversation(agentId: string, sessionId: string) {
              const match = /^fixture:([^:]+):(C[A-Z0-9]+)/.exec(sessionId);
              return match && match[1] === agentId ? match[2] : undefined;
            },
            async resolveOutbound() {
              return { async post() { return { channel: 'C', ts: '1.1' }; } };
            },
          },
        });
      }),
    },
    'stratus-plugin-scripted': {
      manifest: manifest({ providers: [{ name: 'scripted' }], tools: [{ name: 'fixture.wait', risk: 'safe' }] }),
      module: plugin('scripted', (context) => {
        context.tools.register({
          name: 'fixture.wait',
          risk: 'safe',
          async execute() {
            await new Promise<void>((resolve) => { toolHeld.push(resolve); });
            return 'waited';
          },
        });
        context.providers!.register({
          name: 'scripted',
          create: () => ({
            name: 'scripted',
            async generate({ session }): Promise<ProviderResponse> {
              const said = lastUser(session);
              const text = typeof said?.content === 'string' ? said.content : '';
              if (session.metadata?.[TASK_ID_METADATA_KEY] !== undefined) {
                const prompt = session.messages.find((message) => message.role === 'user')?.content ?? '';
                if (prompt === 'STEP') {
                  if (session.messages.at(-1)?.role === 'user' && session.messages.at(-1)?.steered !== true) {
                    return { parts: [{ type: 'tool-call', call: { id: 'wait-1', toolName: 'fixture.wait', input: {} } }] };
                  }
                  const steered = session.messages.filter((message) => message.steered === true).map((message) => message.content);
                  return { parts: [{ type: 'text', text: steered.length > 0 ? `heard: ${steered.join(' | ')}` : 'no follow-up' }] };
                }
                if (prompt === 'HOLD') {
                  await new Promise<void>((resolve) => { providerHeld.push(resolve); });
                  return { parts: [{ type: 'text', text: 'held and done' }] };
                }
                return { parts: [{ type: 'text', text: `did ${prompt}` }] };
              }
              if (text.startsWith('[Background task')) {
                return { parts: [{ type: 'text', text: 'noted' }] };
              }
              if (session.messages.at(-1)?.role === 'tool') {
                return { parts: [{ type: 'text', text: 'ok' }] };
              }
              const ask = JSON.parse(text) as Ask;
              return {
                parts: [{ type: 'tool-call', call: { id: `${session.id}:${session.messages.length}`, toolName: ask.tool, input: ask.input as JsonObject } }],
              };
            },
          }),
        });
      }),
    },
  });
  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: {} },
    idleTimeoutMs: 0,
    plugins: { 'stratus-plugin-fixture-chan': {}, 'stratus-plugin-scripted': {} },
    pluginHost: host,
    approvals: new AllowAllApprovalPolicy(),
    tasks: { enabled: true },
    log: () => {},
    warn: () => {},
  });
  await gateway.start();
  const rows = new SqliteTaskStore(fleetDbIn(path.join(home, '.stratus')), { stateHome: path.join(home, '.stratus') });
  const metadata = { channel: 'fixture', conversation: { kind: 'public', thread: true, threadRoot: '1700.1' } };
  /** One origin turn making `ask`, and that call's result. */
  const call = async (sessionId: string, ask: Ask, idempotencyKey?: string): Promise<ToolResult> => {
    const session = await gateway.dispatch({
      sessionId,
      agentId: 'ava',
      userMessage: JSON.stringify(ask),
      metadata,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    });
    const result = [...session.messages].reverse().find((message) => message.role === 'tool')?.toolResult;
    assert.ok(result, 'the turn made its call');
    return result;
  };
  const start = async (sessionId: string, prompt: string): Promise<string> => {
    const result = await call(sessionId, { tool: 'agent.delegate', input: { agent: 'ava', prompt, background: true } });
    assert.equal(result.ok, true, result.error);
    return (result.output as { task: string }).task;
  };
  const settled = (taskId: string): Promise<TaskRow> => until(`task ${taskId} to settle`, () => {
    const row = rows.get(taskId);
    return row !== undefined && row.delivery !== 'pending';
  }).then(() => rows.get(taskId)!);
  const notice = async (taskId: string, sessionId: string): Promise<string> =>
    (await gateway.store.get(sessionId))?.messages.find((message) => carriesKey(message, taskOutcomeKey(taskId)))?.content ?? '';
  const worker = async (taskId: string): Promise<Session> => (await gateway.store.get(rows.get(taskId)!.workerSessionId))!;
  return {
    gateway,
    call,
    start,
    settled,
    notice,
    worker,
    toolHeld: () => toolHeld.length,
    providerHeld: () => providerHeld.length,
    releaseTool: () => { for (const resolve of toolHeld.splice(0)) resolve(); },
    releaseHold: () => { for (const resolve of providerHeld.splice(0)) resolve(); },
    async stop() {
      for (const resolve of [...toolHeld.splice(0), ...providerHeld.splice(0)]) resolve();
      rows.close();
      await gateway.stop();
    },
  };
};

const message = (task: string, text: string): Ask => ({ tool: 'agent.messageTask', input: { task, message: text } });

test('a follow-up reaches the task\'s running turn at its next step, and its result shows it', async () => {
  const f = await messageGateway();
  try {
    const origin = 'fixture:ava:C1';
    const task = await f.start(origin, 'STEP');
    await until('the worker to be in its tool call', () => f.toolHeld() === 1);

    const sent = await f.call(origin, message(task, 'Change "Money:" to "Money planning:"'));
    assert.equal(sent.ok, true, sent.error);
    assert.deepEqual(
      [(sent.output as JsonObject).task, (sent.output as JsonObject).status, (sent.output as JsonObject).delivered],
      [task, 'running', 'at_next_step'],
    );

    f.releaseTool();
    assert.equal((await f.settled(task)).status, 'completed');
    const worker = await f.worker(task);
    const steered = worker.messages.filter((entry) => entry.steered === true);
    assert.equal(steered.length, 1, 'joined the running turn as a steered message');
    assert.equal(steered[0]!.content, 'A follow-up about this task, from the conversation that asked for it:\nChange "Money:" to "Money planning:"');
    assert.ok(worker.messages.indexOf(steered[0]!) > worker.messages.findIndex((entry) => entry.role === 'tool'), 'after the tool step it waited in');
    const text = await f.notice(task, origin);
    assert.match(text, /completed after 2 steps\.\nResult: heard: A follow-up about this task, from the conversation that asked for it:\nChange "Money:" to "Money planning:"\]$/);
    assert.doesNotMatch(text, /never reached it/, 'nothing went unread');
  } finally {
    await f.stop();
  }
});

test('another conversation with the same agent is refused, and nothing reaches the task', async () => {
  const f = await messageGateway();
  try {
    const task = await f.start('fixture:ava:C1', 'STEP');
    await until('the worker to be in its tool call', () => f.toolHeld() === 1);

    const refused = await f.call('fixture:ava:C2', message(task, 'stop that and do mine'));
    assert.equal(refused.ok, false);
    assert.match(refused.error ?? '', new RegExp(`Only the conversation that started background task ${task} can send it follow-ups`));
    assert.doesNotMatch(refused.error ?? '', /fixture:ava:C1/, 'the other conversation is not named');

    f.releaseTool();
    await f.settled(task);
    const worker = await f.worker(task);
    assert.equal(worker.messages.some((entry) => entry.steered === true), false);
    assert.match(await f.notice(task, 'fixture:ava:C1'), /Result: no follow-up\]$/);
  } finally {
    await f.stop();
  }
});

test('a follow-up the task ended before reading is listed in its outcome notice', async () => {
  const f = await messageGateway();
  try {
    const origin = 'fixture:ava:C3';
    const task = await f.start(origin, 'HOLD');
    await until('the worker to be in its provider call', () => f.providerHeld() === 1);

    const sent = await f.call(origin, message(task, 'also add the git chart'));
    assert.equal(sent.ok, true, sent.error);
    f.releaseHold();
    await f.settled(task);

    assert.equal((await f.worker(task)).messages.some((entry) => entry.steered === true), false, 'it took no step to read it at');
    const text = await f.notice(task, origin);
    assert.match(text, /completed after 1 step\.\nResult: held and done\n1 follow-up sent with agent\.messageTask never reached it, because it ended first:\n- also add the git chart\]$/);
  } finally {
    await f.stop();
  }
});

test('an ended task returns an error and takes nothing', async () => {
  const f = await messageGateway();
  try {
    const origin = 'fixture:ava:C4';
    const task = await f.start(origin, 'QUICK');
    assert.equal((await f.settled(task)).status, 'completed');

    const refused = await f.call(origin, message(task, 'one more thing'));
    assert.equal(refused.ok, false);
    assert.match(refused.error ?? '', new RegExp(`Background task ${task} isn't taking follow-ups any more \\(completed\\), so nothing was passed on`));
    const conversation = await f.gateway.store.get(origin);
    assert.equal(conversation!.messages.filter((entry) => carriesKey(entry, taskOutcomeKey(task))).length, 1, 'no second notice');
  } finally {
    await f.stop();
  }
});

test('a front turn delivered again under its key passes its follow-up once', async () => {
  const f = await messageGateway();
  try {
    const origin = 'fixture:ava:C5';
    const task = await f.start(origin, 'STEP');
    await until('the worker to be in its tool call', () => f.toolHeld() === 1);

    const first = await f.call(origin, message(task, 'rename it'), 'slack:evt-1');
    assert.equal(first.ok, true, first.error);
    // The channel delivers the same message again, as Slack does on a retry.
    const again = await f.call(origin, message(task, 'rename it'), 'slack:evt-1');
    assert.equal(again.ok, true);
    const conversation = await f.gateway.store.get(origin);
    assert.equal(conversation!.messages.filter((entry) => entry.toolCalls?.some((one) => one.toolName === 'agent.messageTask')).length, 1, 'the turn ran once');

    f.releaseTool();
    await f.settled(task);
    assert.equal((await f.worker(task)).messages.filter((entry) => entry.steered === true).length, 1);
  } finally {
    await f.stop();
  }
});

// The host alone, on stand-ins for the gateway's dispatch and chains, so
// the worker's steer hook can be asked directly.

const AVA = { id: 'ava', name: 'Ava', instructions: '', tools: [], skills: [], delegates: [] } as unknown as AgentDefinition;

const hostFixture = async ({ holdAfterFinish = false }: { holdAfterFinish?: boolean } = {}) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-task-message-host-'));
  const stateDir = path.join(home, '.stratus');
  await mkdir(stateDir, { recursive: true });
  const store = new ShardedSessionStore({ stateDir });
  const origin = 'fixture:ava:C1';
  await store.create({
    id: origin,
    agent: { id: 'ava', name: 'Ava' },
    status: 'completed',
    metadata: { channel: 'fixture' },
    messages: [{ id: 'u1', role: 'user', content: 'start', createdAt: '' }],
  } as unknown as Session);
  let steer: ((signal: AbortSignal) => Promise<SteeredMessage | undefined>) | undefined;
  let finish: () => void = () => {};
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  let release: () => void = () => {};
  const released = holdAfterFinish ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve();
  const chains = new Map<string, Promise<unknown>>();
  const onChain = <T>(sessionId: string, work: () => Promise<T>): Promise<T> => {
    const next = (chains.get(sessionId) ?? Promise.resolve()).then(work, work);
    chains.set(sessionId, next.catch(() => {}));
    return next;
  };
  const tasks = createBackgroundTasks({
    options: { tasks: { enabled: true } } as GatewayOptions,
    fleetDb: fleetDbIn(stateDir),
    stateHome: stateDir,
    store,
    bus: { emit: async () => {} },
    dispatchInternal: async (input: DispatchInput, _conversation?: boolean, workerSteer?: (signal: AbortSignal) => Promise<SteeredMessage | undefined>) => {
      if (input.sessionId === origin) {
        const session = (await store.get(origin))!;
        session.messages.push({ id: `n${session.messages.length}`, role: 'user', content: input.userMessage, createdAt: '', idempotencyKey: input.idempotencyKey! });
        session.messages.push({ id: `a${session.messages.length}`, role: 'assistant', content: 'noted', createdAt: '' });
        await store.save(session);
        return session;
      }
      steer = workerSteer;
      const worker = await store.create({
        id: input.sessionId,
        agent: { id: 'ava', name: 'Ava' },
        status: 'running',
        metadata: input.metadata ?? {},
        messages: [{ id: 'w1', role: 'user', content: input.userMessage, createdAt: '' }],
      } as unknown as Session);
      await finished;
      worker.messages.push({ id: 'w2', role: 'assistant', content: 'done', createdAt: '' });
      worker.status = 'completed';
      await store.save(worker);
      // Finished and saved, but its dispatch not yet back: not settled.
      await released;
      return worker;
    },
    onSessionChain: onChain,
    onWorkerChain: onChain,
    settleRepeat: async () => undefined,
    observe: async () => { throw new Error('no fallback expected'); },
    postToOrigin: async () => { throw new Error('no fallback expected'); },
    abortTurns: () => 0,
    isStopping: () => false,
    refusal: () => new Error('stopping'),
    log: () => {},
    warn: () => {},
  });
  const rows = new SqliteTaskStore(fleetDbIn(stateDir), { stateHome: stateDir });
  const started = await tasks.start!({
    origin: (await store.get(origin))!,
    agent: AVA,
    prompt: 'WORK',
    workerSessionId: (id) => `${origin}:delegate:ava:1:${id}`,
    metadata: {},
  });
  await until('the worker turn', () => steer !== undefined);
  return {
    tasks,
    task: started.task,
    origin,
    steer: (signal = new AbortController().signal) => steer!(signal),
    finish,
    release: () => release(),
    workerDone: () => until('the worker turn to finish', async () => (await store.get(rows.get(started.task)!.workerSessionId))?.status === 'completed'),
    settled: () => until('the task to settle', () => rows.get(started.task)?.delivery === 'delivered'),
    notice: async () => (await store.get(origin))?.messages.find((entry) => carriesKey(entry, taskOutcomeKey(started.task)))?.content ?? '',
    async close() {
      finish();
      release();
      await Promise.allSettled([...chains.values()]);
      rows.close();
      tasks.close();
      store.close();
    },
  };
};

test('the same call passed on twice is queued once, and the worker\'s next step takes it with its trust', async () => {
  const f = await hostFixture();
  try {
    const send = (key: string | undefined, text: string, trust: 'agent' | 'external' = 'agent') => f.tasks.toolsHost!.message({
      taskId: f.task, agentId: 'ava', originSessionId: f.origin, text, trust, ...(key !== undefined ? { key } : {}),
    });
    assert.deepEqual(await send('m3#call_0', 'rename it', 'external'), { kind: 'queued', status: 'running' });
    assert.deepEqual(await send('m3#call_0', 'rename it', 'external'), { kind: 'queued', status: 'running', already: true });
    // No key: never taken for a repeat.
    assert.deepEqual(await send(undefined, 'and the chart'), { kind: 'queued', status: 'running' });
    assert.deepEqual(await send(undefined, 'and the chart'), { kind: 'queued', status: 'running' });

    const stopped = new AbortController();
    stopped.abort();
    assert.equal(await f.steer(stopped.signal), undefined, 'a turn already stopping takes nothing');

    const taken = await f.steer();
    assert.ok(taken);
    assert.equal(taken.userMessage.split('rename it').length - 1, 1, 'the repeat was not queued');
    assert.equal(taken.userMessage.split('and the chart').length - 1, 2);
    assert.equal(taken.metadata?.[SENDER_TRUST_METADATA_KEY], 'external', 'the least trusted sender\'s label');
    assert.equal(taken.keys, undefined, 'no dispatch keys: a worker turn stays unkeyed, so a restart never continues it');
    assert.equal(await f.steer(), undefined, 'taken once');

    // After it was read, the same call again is still the one already passed on.
    assert.deepEqual(await send('m3#call_0', 'rename it'), { kind: 'queued', status: 'running', already: true });
    assert.equal(await f.steer(), undefined);

    f.finish();
    await f.settled();
    assert.doesNotMatch(await f.notice(), /never reached it/, 'everything queued was read');
  } finally {
    await f.close();
  }
});

test('the host refuses another agent\'s task, another conversation, and an unknown id before anything is queued', async () => {
  const f = await hostFixture();
  try {
    const base = { taskId: f.task, agentId: 'ava', originSessionId: f.origin, text: 'hi', trust: 'agent' as const };
    assert.deepEqual(await f.tasks.toolsHost!.message({ ...base, taskId: 't_unknown' }), { kind: 'missing' });
    assert.deepEqual(await f.tasks.toolsHost!.message({ ...base, agentId: 'mia' }), { kind: 'missing' });
    assert.deepEqual(await f.tasks.toolsHost!.message({ ...base, originSessionId: 'fixture:ava:C2' }), { kind: 'elsewhere' });
    assert.equal(await f.steer(), undefined, 'nothing was queued');

    await f.tasks.cancel(f.task, { stoppedBy: 'cli' });
    assert.deepEqual(await f.tasks.toolsHost!.message(base), { kind: 'stopping' });
    assert.equal(await f.steer(), undefined);
  } finally {
    await f.close();
  }
});

test('a task whose turn has ended takes nothing, even before it is settled', async () => {
  const f = await hostFixture({ holdAfterFinish: true });
  try {
    f.finish();
    await f.workerDone();
    const answer = await f.tasks.toolsHost!.message({ taskId: f.task, agentId: 'ava', originSessionId: f.origin, text: 'too late', trust: 'agent' });
    assert.deepEqual(answer, { kind: 'ended', status: 'completed' }, 'how it ended, from the worker, though the row still says running');
    f.release();
    await f.settled();
    assert.doesNotMatch(await f.notice(), /too late/, 'it was refused, not queued and listed');
  } finally {
    await f.close();
  }
});
