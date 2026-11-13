import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import {
  AllowAllApprovalPolicy,
  carriesKey,
  PENDING_APPROVAL_METADATA_KEY,
  type JsonObject,
  type PluginContext,
  type ProviderResponse,
  type Session,
} from '@stratusagent/core';
import { TASK_ID_METADATA_KEY } from '@stratusagent/agents';
import type { OptionalModuleHost } from '@stratusagent/plugins';
import { fleetDbIn } from '@stratusagent/state';

import { ABANDONED_TURN_ERROR, createGateway } from '../src/index.ts';
import { ShardedSessionStore } from '../src/sessions.ts';
import { TASK_CUT_OFF_ERROR, taskFallbackKey, taskOutcomeKey } from '../src/task-settle.ts';
import { newTaskId, SqliteTaskStore, taskPromptDigest, type TaskRow } from '../src/tasks.ts';

// AGT-356 PR 4b: the gateway's side of `agent.delegate`'s background mode.
// The row is claimed against the cap, the worker runs on its own session
// without the turn that asked waiting for it, and its outcome lands in the
// origin session once, as a keyed turn or, when that turn fails, as the
// keyed fallback posted to the origin's conversation.

const newHome = async (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'stratus-gw-tasks-'));

const writeSoul = async (home: string, file: string, contents: string): Promise<void> => {
  const dir = path.join(home, '.stratus', 'agents');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, file), contents);
};

const hostFor = async (packages: Record<string, { manifest: unknown; module?: unknown }>): Promise<OptionalModuleHost> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-gw-tasks-pkgs-'));
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

/** What an origin turn asks for: one `agent.delegate` call, or one call of `tool` with `input`. */
interface Ask {
  to?: string;
  prompt?: string;
  background?: boolean;
  tool?: string;
  input?: Record<string, unknown>;
}

const lastUser = (session: Session): string => {
  const message = [...session.messages].reverse().find((candidate) => candidate.role === 'user');
  return typeof message?.content === 'string' ? message.content : '';
};

const until = async (what: string, check: () => Promise<boolean> | boolean, ms = 5_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/**
 * A gateway whose agents run on a scripted provider. An origin turn's
 * message is an `Ask` as JSON: the turn calls `agent.delegate` with it,
 * then says what the tool returned. A worker (a session carrying a task
 * id) answers `did <prompt>`, or waits for `release` first when its prompt
 * starts with BLOCK. A turn whose message is a task notice answers
 * `noted`, or fails when `noticeTurn` is 'fails'.
 */
const taskGateway = async (options: {
  tasks?: { enabled?: boolean; maxRunningPerAgent?: Record<string, number> };
  noticeTurn?: 'answers' | 'fails';
  /** The fixture channel refuses posts. */
  postRefused?: boolean;
  /** A home the last process left behind (`crashCopy`), instead of a new one. */
  home?: string;
  /** Written into the state directory before the gateway starts. */
  seed?: (stateDir: string) => Promise<void>;
  held?: boolean;
  stopDrainTimeoutMs?: number;
} = {}) => {
  const home = options.home ?? await newHome();
  if (options.home === undefined) {
    await writeSoul(home, 'ava.md', [
      '---', 'name: Ava', 'id: ava', 'provider: scripted', 'tools: [agent.delegate, agent.tasks, agent.cancelTask]', 'delegates: [mia]',
      '---', '', 'You are Ava.', '',
    ].join('\n'));
    await writeSoul(home, 'mia.md', '---\nname: Mia\nid: mia\nprovider: scripted\ntools: []\n---\n\nYou are Mia.\n');
  }
  const stateDir = path.join(home, '.stratus');
  await options.seed?.(stateDir);
  /** Every session the provider was asked to answer for, in order. */
  const calls: string[] = [];
  const posts: Array<{ agentId: string; to: string; thread?: string; speaker?: unknown; text: string }> = [];
  const blocked: Array<() => void> = [];
  /** Ordinary turns waiting (a message of WAIT), released by `releaseOrdinary`. */
  const waiting: Array<() => void> = [];
  /** Wait for `release`, or end with the signal's reason when the turn is aborted first, as a provider does. */
  const hold = (into: Array<() => void>, signal: AbortSignal | undefined): Promise<void> => new Promise<void>((resolve, reject) => {
    into.push(resolve);
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const workerSignals: AbortSignal[] = [];
  const host = await hostFor({
    'stratus-plugin-fixture-chan': {
      manifest: manifest({ channels: [{ name: 'fixture' }] }),
      module: plugin('chan', (context) => {
        context.channels!.register({
          agents: ['ava', 'mia'],
          adapter: {
            name: 'fixture',
            async start() {},
            async stop() {},
            sessionConversation(agentId: string, sessionId: string) {
              const match = /^fixture:([^:]+):(C[A-Z0-9]+)/.exec(sessionId);
              return match && match[1] === agentId ? match[2] : undefined;
            },
            async resolveOutbound(address: { agentId: string; to: string; thread?: string; speaker?: unknown }) {
              return {
                async post(text: string) {
                  if (options.postRefused) {
                    throw new Error('fixture: not_in_channel');
                  }
                  posts.push({ ...address, text });
                  return { channel: address.to, ts: '1.1' };
                },
              };
            },
          },
        });
      }),
    },
    'stratus-plugin-scripted': {
      manifest: manifest({ providers: [{ name: 'scripted' }] }),
      module: plugin('scripted', (context) => {
        context.providers!.register({
          name: 'scripted',
          create: () => ({
            name: 'scripted',
            async generate({ session, signal }): Promise<ProviderResponse> {
              calls.push(session.id);
              const said = lastUser(session);
              if (session.metadata?.[TASK_ID_METADATA_KEY] !== undefined) {
                if (said.startsWith('BLOCK')) {
                  if (signal) {
                    workerSignals.push(signal);
                  }
                  await hold(blocked, signal);
                }
                if (said.startsWith('STUBBORN')) {
                  // A provider that doesn't heed the abort: once let go it
                  // answers with a tool call, a foreground delegation to mia.
                  if (session.messages.at(-1)?.role === 'tool') {
                    return { parts: [{ type: 'text', text: 'side done' }] };
                  }
                  await hold(blocked, undefined);
                  return {
                    parts: [{
                      type: 'tool-call',
                      call: { id: `${session.id}:${session.messages.length}`, toolName: 'agent.delegate', input: { agent: 'mia', prompt: 'SIDE' } },
                    }],
                  };
                }
                return { parts: [{ type: 'text', text: `did ${said}` }] };
              }
              if (said.startsWith('[Background task')) {
                if (options.noticeTurn === 'fails') {
                  throw new Error('the provider is down');
                }
                return { parts: [{ type: 'text', text: 'noted' }] };
              }
              if (said === 'WAIT') {
                await hold(waiting, signal);
                return { parts: [{ type: 'text', text: 'waited' }] };
              }
              const last = session.messages.at(-1);
              if (last?.role === 'tool') {
                return { parts: [{ type: 'text', text: `tool said: ${JSON.stringify(last.toolResult ?? null)}` }] };
              }
              const ask = JSON.parse(said) as Ask;
              if (ask.tool !== undefined) {
                return {
                  parts: [{ type: 'tool-call', call: { id: `${session.id}:${session.messages.length}`, toolName: ask.tool, input: (ask.input ?? {}) as JsonObject } }],
                };
              }
              return {
                parts: [{
                  type: 'tool-call',
                  call: { id: `${session.id}:${session.messages.length}`, toolName: 'agent.delegate', input: { agent: ask.to ?? '', prompt: ask.prompt ?? '', ...(ask.background !== undefined ? { background: ask.background } : {}) } },
                }],
              };
            },
          }),
        });
      }),
    },
  });
  const warnings: string[] = [];
  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: {} },
    idleTimeoutMs: 0,
    plugins: { 'stratus-plugin-fixture-chan': {}, 'stratus-plugin-scripted': {} },
    pluginHost: host,
    approvals: new AllowAllApprovalPolicy(),
    ...(options.tasks !== undefined ? { tasks: options.tasks } : {}),
    ...(options.held === true ? { held: true } : {}),
    ...(options.stopDrainTimeoutMs !== undefined ? { stopDrainTimeoutMs: options.stopDrainTimeoutMs } : {}),
    log: () => {},
    warn: (line) => warnings.push(line),
  });
  await gateway.start();
  const rows = new SqliteTaskStore(fleetDbIn(stateDir), { stateHome: stateDir });
  const ask = async (sessionId: string, request: Ask): Promise<Session> => gateway.dispatch({
    sessionId,
    agentId: 'ava',
    userMessage: JSON.stringify(request),
    metadata: { channel: 'fixture', conversation: { kind: 'public', thread: true, threadRoot: '1700.1' } },
  });
  /** What the origin turn's agent.delegate call returned. */
  const delegated = (session: Session) => {
    const result = [...session.messages].reverse().find((message) => message.role === 'tool')?.toolResult;
    assert.ok(result, 'the turn called agent.delegate');
    return result;
  };
  const settled = (taskId: string): Promise<TaskRow> => until(`task ${taskId} to settle`, () => {
    const row = rows.get(taskId);
    return row !== undefined && row.delivery !== 'pending';
  }).then(() => rows.get(taskId)!);
  return {
    home,
    gateway,
    rows,
    calls,
    ask,
    delegated,
    settled,
    posts,
    warnings,
    workerSignals,
    release: () => {
      for (const resolve of blocked.splice(0)) {
        resolve();
      }
    },
    blockedCount: () => blocked.length,
    waitingCount: () => waiting.length,
    releaseOrdinary: () => {
      for (const resolve of waiting.splice(0)) {
        resolve();
      }
    },
    async stop() {
      rows.close();
      await gateway.stop();
    },
  };
};

test('tasks are off by default: background: true is refused and nothing runs or is written', async () => {
  const fixture = await taskGateway();
  try {
    const session = await fixture.ask('fixture:ava:C1', { to: 'ava', prompt: 'WORK', background: true });
    const result = fixture.delegated(session);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /Background delegation isn't available here/);
    assert.equal((await fixture.gateway.store.list()).some((item) => item.id.includes(':delegate:')), false);
  } finally {
    await fixture.stop();
  }
});

test('a background task of its own: the turn gets the id at once, the worker runs as a delegated session, and its result lands once', async () => {
  const fixture = await taskGateway({ tasks: { enabled: true } });
  try {
    const origin = 'fixture:ava:C1';
    const started = await fixture.ask(origin, { to: 'ava', prompt: 'WORK-1', background: true });
    const result = fixture.delegated(started);
    assert.equal(result.ok, true, result.error);
    const output = result.output as { task: string; status: string; agent: string };
    assert.match(output.task, /^t_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal(output.status, 'running');
    assert.equal(output.agent, 'Ava');

    const row = await fixture.settled(output.task);
    assert.equal(row.status, 'completed');
    assert.equal(row.delivery, 'delivered');
    assert.equal(row.agentId, 'ava');
    assert.equal(row.workerAgentId, 'ava');
    assert.equal(row.originSessionId, origin);
    assert.equal(row.workerSessionId, `${origin}:delegate:ava:1:${output.task}`);

    const worker = await fixture.gateway.store.get(row.workerSessionId);
    assert.equal(worker?.metadata?.[TASK_ID_METADATA_KEY], output.task);
    assert.equal(worker?.metadata?.delegatedBy, 'ava');
    assert.equal(worker?.metadata?.rootSessionId, origin);

    const conversation = await fixture.gateway.store.get(origin);
    const notices = conversation!.messages.filter((message) => carriesKey(message, taskOutcomeKey(output.task)));
    assert.equal(notices.length, 1);
    assert.match(notices[0]!.content, new RegExp(`^\\[Background task ${output.task} \\(ava\\) completed after 1 step\\.\\nResult: did WORK-1\\]$`));
    assert.equal(conversation!.messages.at(-1)?.content, 'noted');
    // The outcome turn's reply is posted by the channel like any reply; the
    // gateway posts only a fallback.
    assert.deepEqual(fixture.posts, []);
  } finally {
    await fixture.stop();
  }
});

test('a task for another agent runs as that agent, and the notice names it', async () => {
  const fixture = await taskGateway({ tasks: { enabled: true } });
  try {
    const started = await fixture.ask('fixture:ava:C2', { to: 'mia', prompt: 'WORK-2', background: true });
    const output = fixture.delegated(started).output as { task: string };
    const row = await fixture.settled(output.task);
    assert.equal(row.workerAgentId, 'mia');
    assert.equal(row.workerSessionId, `fixture:ava:C2:delegate:mia:1:${output.task}`);
    assert.equal((await fixture.gateway.store.get(row.workerSessionId))?.agent.id, 'mia');
    const conversation = await fixture.gateway.store.get('fixture:ava:C2');
    const notice = conversation!.messages.find((message) => carriesKey(message, taskOutcomeKey(output.task)));
    assert.match(notice?.content ?? '', /\(mia\) completed after 1 step\.\nResult: did WORK-2\]$/);
  } finally {
    await fixture.stop();
  }
});

test('the cap: past maxRunningPerAgent a start is refused, and the same job again is the running task', async () => {
  const fixture = await taskGateway({ tasks: { enabled: true, maxRunningPerAgent: { ava: 1 } } });
  try {
    const first = fixture.delegated(await fixture.ask('fixture:ava:C3', { to: 'ava', prompt: 'BLOCK-A', background: true }));
    assert.equal(first.ok, true, first.error);
    const task = (first.output as { task: string }).task;
    await until('the worker to start', () => fixture.blockedCount() === 1);

    // Another job from another conversation: over the cap.
    const second = fixture.delegated(await fixture.ask('fixture:ava:C4', { to: 'ava', prompt: 'BLOCK-B', background: true }));
    assert.equal(second.ok, false);
    assert.match(second.error ?? '', /already has 1 background tasks running.*tasks\.maxRunningPerAgent is 1/);

    // The same job from the same conversation: that task, not a refusal.
    const again = fixture.delegated(await fixture.ask('fixture:ava:C3', { to: 'ava', prompt: 'BLOCK-A', background: true }));
    assert.equal(again.ok, true, again.error);
    assert.deepEqual(
      { task: (again.output as { task: string }).task, existing: (again.output as { existing?: boolean }).existing },
      { task, existing: true },
    );
    assert.equal(fixture.blockedCount(), 1, 'no second worker ran');

    fixture.release();
    assert.equal((await fixture.settled(task)).status, 'completed');
    // Under the cap again.
    const third = fixture.delegated(await fixture.ask('fixture:ava:C4', { to: 'ava', prompt: 'WORK-C', background: true }));
    assert.equal(third.ok, true, third.error);
    await fixture.settled((third.output as { task: string }).task);
  } finally {
    fixture.release();
    await fixture.stop();
  }
});

test('the worker gets the task\'s own signal, not the asking turn\'s: the task outlives that turn', async () => {
  const fixture = await taskGateway({ tasks: { enabled: true } });
  try {
    const started = await fixture.ask('fixture:ava:C5', { to: 'ava', prompt: 'BLOCK-D', background: true });
    assert.equal(started.status, 'completed', 'the asking turn ended while its task runs');
    await until('the worker to start', () => fixture.blockedCount() === 1);
    assert.equal(fixture.workerSignals[0]?.aborted, false);
    fixture.release();
    const row = await fixture.settled((fixture.delegated(started).output as { task: string }).task);
    assert.equal(row.status, 'completed');
  } finally {
    fixture.release();
    await fixture.stop();
  }
});

test('when the outcome turn fails, the fallback is written under its key and posted once to the origin conversation', async () => {
  const fixture = await taskGateway({ tasks: { enabled: true }, noticeTurn: 'fails' });
  try {
    const origin = 'fixture:ava:C6';
    const started = await fixture.ask(origin, { to: 'ava', prompt: 'WORK-6', background: true });
    const task = (fixture.delegated(started).output as { task: string }).task;
    const row = await fixture.settled(task);
    assert.equal(row.delivery, 'delivered');

    const conversation = await fixture.gateway.store.get(origin);
    const fallbacks = conversation!.messages.filter((message) => carriesKey(message, taskFallbackKey(task)));
    assert.equal(fallbacks.length, 1);
    assert.match(fallbacks[0]!.content, /completed after 1 step\.\nResult: did WORK-6\]$/);
    assert.deepEqual(fixture.posts, [{
      agentId: 'ava',
      to: 'C6',
      thread: '1700.1',
      speaker: { sessionId: origin, trust: 'agent' },
      text: fallbacks[0]!.content,
    }]);
  } finally {
    await fixture.stop();
  }
});

test('a fallback the channel refuses stays in the transcript, is logged with the task id, and is not posted again', async () => {
  const fixture = await taskGateway({ tasks: { enabled: true }, noticeTurn: 'fails', postRefused: true });
  try {
    const origin = 'fixture:ava:C7';
    const task = (fixture.delegated(await fixture.ask(origin, { to: 'ava', prompt: 'WORK-7', background: true })).output as { task: string }).task;
    const row = await fixture.settled(task);
    assert.equal(row.delivery, 'delivered');
    const conversation = await fixture.gateway.store.get(origin);
    assert.equal(conversation!.messages.filter((message) => carriesKey(message, taskFallbackKey(task))).length, 1);
    assert.ok(
      fixture.warnings.some((line) => line.includes(`task ${task}`) && line.includes('posting it to the conversation failed') && line.includes('not_in_channel')),
      fixture.warnings.join('\n'),
    );
  } finally {
    await fixture.stop();
  }
});

test('taskId is the daemon\'s own key: a dispatch or an observe that supplies it is refused', async () => {
  const fixture = await taskGateway({ tasks: { enabled: true } });
  try {
    await assert.rejects(
      () => fixture.gateway.dispatch({ sessionId: 'fixture:ava:C8', agentId: 'ava', userMessage: 'hi', metadata: { [TASK_ID_METADATA_KEY]: 't_X' } }),
      /Session metadata key "taskId" is reserved/,
    );
    await fixture.ask('fixture:ava:C8', { to: 'mia', prompt: 'WORK-8' });
    await assert.rejects(
      async () => fixture.gateway.observe({ sessionId: 'fixture:ava:C8', agentId: 'ava', message: 'Bo: hi', metadata: { [TASK_ID_METADATA_KEY]: 't_X' } }),
      /Session metadata key "taskId" is reserved/,
    );
  } finally {
    await fixture.stop();
  }
});

test('an agent tasks.maxRunningPerAgent doesn\'t list keeps the default of 3', async () => {
  const fixture = await taskGateway({ tasks: { enabled: true, maxRunningPerAgent: { mia: 1 } } });
  try {
    const started: string[] = [];
    for (const [conversation, prompt] of [['C5', 'BLOCK-D'], ['C6', 'BLOCK-E'], ['C7', 'BLOCK-F']] as const) {
      const result = fixture.delegated(await fixture.ask(`fixture:ava:${conversation}`, { to: 'ava', prompt, background: true }));
      assert.equal(result.ok, true, result.error);
      started.push((result.output as { task: string }).task);
    }
    await until('three workers to start', () => fixture.blockedCount() === 3);
    const fourth = fixture.delegated(await fixture.ask('fixture:ava:C8', { to: 'ava', prompt: 'BLOCK-G', background: true }));
    assert.equal(fourth.ok, false);
    assert.match(fourth.error ?? '', /already has 3 background tasks running.*tasks\.maxRunningPerAgent is 3/);
    fixture.release();
    for (const task of started) {
      await fixture.settled(task);
    }
  } finally {
    fixture.release();
    await fixture.stop();
  }
});

test('each tasks.maxRunningPerAgent entry must be a whole number of at least 1, whether or not tasks are on', () => {
  for (const tasks of [
    { maxRunningPerAgent: { ava: 0 } },
    { enabled: true, maxRunningPerAgent: { ava: 1.5 } },
    { maxRunningPerAgent: { ava: Number.NaN } },
    { maxRunningPerAgent: 3 as unknown as Record<string, number> },
  ]) {
    assert.throws(
      () => createGateway({ env: { homeDir: os.tmpdir(), cwd: os.tmpdir(), processEnv: {} }, tasks }),
      /tasks\.maxRunningPerAgent/,
    );
  }
});

// AGT-356 PR 5: the restart sweep. Each crash point from spec test 7 is the
// state on disk at that moment: a copy of a live home (`crashCopy`), taken
// while the first process is at that point, edited only where no live
// process can stop on the point. The second process starts on the copy.

/** What a process killed right now would leave: a copy of its home. */
const crashCopy = async (home: string): Promise<string> => {
  const copy = await newHome();
  await cp(home, copy, { recursive: true });
  return copy;
};

const stateOf = (home: string): string => path.join(home, '.stratus');

/** Edit the sessions a crash left, with the gateway's own store. */
const editSessions = async (home: string, edit: (store: ShardedSessionStore) => Promise<void>): Promise<void> => {
  const store = new ShardedSessionStore({ stateDir: stateOf(home) });
  try {
    await edit(store);
  } finally {
    store.close();
  }
};

/** Put a row back to `delivery = 'pending'`, as a crash before `setDelivery` leaves it. */
const undeliver = (home: string, taskId: string): void => {
  const db = new DatabaseSync(fleetDbIn(stateOf(home)));
  try {
    db.prepare(`UPDATE tasks SET delivery = 'pending' WHERE id = ?`).run(taskId);
  } finally {
    db.close();
  }
};

const keyed = (session: Session | undefined, key: string) => (session?.messages ?? []).filter((message) => carriesKey(message, key));

/**
 * A worker the first process had mid-turn: its home, copied while the
 * worker waits on its provider. The first process is let go and stopped.
 * `finished` is that worker's session once it did finish, for the crash
 * points after the worker's turn.
 */
const crashedMidTask = async (origin: string) => {
  const first = await taskGateway({ tasks: { enabled: true } });
  try {
    const task = (first.delegated(await first.ask(origin, { to: 'ava', prompt: 'BLOCK-R', background: true })).output as { task: string }).task;
    await until('the worker to start', () => first.blockedCount() === 1);
    const home = await crashCopy(first.home);
    const workerSessionId = first.rows.get(task)!.workerSessionId;
    first.release();
    await first.settled(task);
    const finished = (await first.gateway.store.get(workerSessionId))!;
    return { home, task, workerSessionId, finished };
  } finally {
    first.release();
    await first.stop();
  }
};

/** A task the first process settled all the way, and a copy of its home taken then. */
const crashedAfterSettling = async (origin: string, noticeTurn: 'answers' | 'fails' = 'answers') => {
  const first = await taskGateway({ tasks: { enabled: true }, noticeTurn });
  try {
    const task = (first.delegated(await first.ask(origin, { to: 'ava', prompt: 'WORK-R', background: true })).output as { task: string }).task;
    await first.settled(task);
    return { home: await crashCopy(first.home), task, posted: first.posts.length };
  } finally {
    await first.stop();
  }
};

test('restart: a row written before its worker was dispatched is reported as never started, once', async () => {
  const origin = 'fixture:ava:C20';
  const task = newTaskId();
  const fixture = await taskGateway({
    tasks: { enabled: true },
    async seed(stateDir) {
      const sessions = new ShardedSessionStore({ stateDir });
      await sessions.create({
        id: origin,
        agent: { id: 'ava', name: 'Ava' },
        status: 'idle',
        metadata: { channel: 'fixture', conversation: { kind: 'public', thread: true, threadRoot: '1700.1' } },
        messages: [{ id: 'u1', role: 'user', content: 'start it', createdAt: new Date().toISOString() }],
      });
      sessions.close();
      const rows = new SqliteTaskStore(fleetDbIn(stateDir), { stateHome: stateDir });
      rows.claim({
        id: task,
        agentId: 'ava',
        workerAgentId: 'ava',
        originSessionId: origin,
        workerSessionId: `${origin}:delegate:ava:1:${task}`,
        promptDigest: taskPromptDigest('ava', 'WORK'),
      }, 3, new Date().toISOString());
      rows.close();
    },
  });
  try {
    const row = await fixture.settled(task);
    assert.deepEqual([row.status, row.delivery], ['interrupted', 'delivered']);
    const notices = keyed(await fixture.gateway.store.get(origin), taskOutcomeKey(task));
    assert.equal(notices.length, 1);
    assert.match(notices[0]!.content, /never started: its turn did not begin\. It was not run\.\]$/);
    assert.equal(await fixture.gateway.store.get(row.workerSessionId), undefined, 'no worker turn was started');
  } finally {
    await fixture.stop();
  }
});

test('restart: a worker cut off mid-turn is failed by the task sweep, not the abandoned-turn sweep, and is not run again', async () => {
  const origin = 'fixture:ava:C21';
  const crashed = await crashedMidTask(origin);
  const fixture = await taskGateway({ tasks: { enabled: true }, home: crashed.home });
  try {
    const row = await fixture.settled(crashed.task);
    assert.deepEqual([row.status, row.delivery], ['interrupted', 'delivered']);
    const worker = await fixture.gateway.store.get(crashed.workerSessionId);
    assert.equal(worker?.status, 'failed');
    assert.equal(worker?.lastError, TASK_CUT_OFF_ERROR);
    assert.notEqual(worker?.lastError, ABANDONED_TURN_ERROR);
    assert.equal(fixture.calls.includes(crashed.workerSessionId), false, 'the worker was not run again');
    const notices = keyed(await fixture.gateway.store.get(origin), taskOutcomeKey(crashed.task));
    assert.equal(notices.length, 1);
    assert.match(notices[0]!.content, /was interrupted after .*: a restart cut it off, and it was not run again\.\]$/);
  } finally {
    await fixture.stop();
  }
});

test('restart: a worker parked on an approval is failed, not re-asked, and its checkpoint is spent', async () => {
  const origin = 'fixture:ava:C22';
  const crashed = await crashedMidTask(origin);
  await editSessions(crashed.home, async (store) => {
    const worker = (await store.get(crashed.workerSessionId))!;
    const now = new Date().toISOString();
    const call = { id: 'park-1', toolName: 'agent.delegate', input: { agent: 'mia', prompt: 'gated' } };
    worker.messages.push({ id: 'park-a', role: 'assistant', content: '', createdAt: now, toolCalls: [call] });
    worker.status = 'pending_approval';
    worker.metadata = { ...worker.metadata, [PENDING_APPROVAL_METADATA_KEY]: { call, remaining: [], parkedAt: now } };
    await store.save(worker);
  });
  // Allow-all approvals: re-asked, the parked call would run and the worker
  // carry on to `completed`, so the provider call and the status both show it.
  const fixture = await taskGateway({ tasks: { enabled: true }, home: crashed.home });
  try {
    const row = await fixture.settled(crashed.task);
    assert.deepEqual([row.status, row.delivery], ['interrupted', 'delivered']);
    const worker = await fixture.gateway.store.get(crashed.workerSessionId);
    assert.equal(worker?.status, 'failed');
    assert.equal(worker?.lastError, TASK_CUT_OFF_ERROR);
    assert.equal(worker?.metadata?.[PENDING_APPROVAL_METADATA_KEY], undefined);
    assert.equal(fixture.calls.includes(crashed.workerSessionId), false, 'the worker was not re-asked or run again');
    assert.equal(keyed(await fixture.gateway.store.get(origin), taskOutcomeKey(crashed.task)).length, 1);
  } finally {
    await fixture.stop();
  }
});

test('restart: a worker that finished before the row said so is reported completed with its result', async () => {
  const origin = 'fixture:ava:C23';
  const crashed = await crashedMidTask(origin);
  await editSessions(crashed.home, (store) => store.save(crashed.finished));
  const fixture = await taskGateway({ tasks: { enabled: true }, home: crashed.home });
  try {
    const row = await fixture.settled(crashed.task);
    assert.deepEqual([row.status, row.delivery], ['completed', 'delivered']);
    const notices = keyed(await fixture.gateway.store.get(origin), taskOutcomeKey(crashed.task));
    assert.equal(notices.length, 1);
    assert.match(notices[0]!.content, /completed after 1 step\.\nResult: did BLOCK-R\]$/);
    assert.equal(fixture.calls.includes(crashed.workerSessionId), false);
  } finally {
    await fixture.stop();
  }
});

test('restart: a final row whose notice never went out gets it once', async () => {
  const origin = 'fixture:ava:C24';
  const crashed = await crashedMidTask(origin);
  await editSessions(crashed.home, (store) => store.save(crashed.finished));
  const rows = new SqliteTaskStore(fleetDbIn(stateOf(crashed.home)), { stateHome: stateOf(crashed.home) });
  rows.setStatus(crashed.task, 'completed', new Date().toISOString());
  rows.close();
  const fixture = await taskGateway({ tasks: { enabled: true }, home: crashed.home });
  try {
    const row = await fixture.settled(crashed.task);
    assert.deepEqual([row.status, row.delivery], ['completed', 'delivered']);
    assert.equal(keyed(await fixture.gateway.store.get(origin), taskOutcomeKey(crashed.task)).length, 1);
  } finally {
    await fixture.stop();
  }
});

test('restart: a notice that landed before delivery was set is not sent again', async () => {
  const origin = 'fixture:ava:C25';
  const crashed = await crashedAfterSettling(origin);
  undeliver(crashed.home, crashed.task);
  const fixture = await taskGateway({ tasks: { enabled: true }, home: crashed.home });
  try {
    const row = await fixture.settled(crashed.task);
    assert.equal(row.delivery, 'delivered');
    const conversation = await fixture.gateway.store.get(origin);
    assert.equal(keyed(conversation, taskOutcomeKey(crashed.task)).length, 1);
    assert.equal(conversation?.messages.filter((message) => message.role === 'assistant' && message.content === 'noted').length, 1);
    assert.equal(fixture.calls.includes(origin), false, 'no second outcome turn ran');
  } finally {
    await fixture.stop();
  }
});

test('restart: an outcome turn the crash cut off is finished once, never sent twice', async () => {
  const origin = 'fixture:ava:C26';
  const crashed = await crashedAfterSettling(origin);
  undeliver(crashed.home, crashed.task);
  await editSessions(crashed.home, async (store) => {
    const conversation = (await store.get(origin))!;
    const at = conversation.messages.findIndex((message) => carriesKey(message, taskOutcomeKey(crashed.task)));
    conversation.messages = conversation.messages.slice(0, at + 1);
    conversation.status = 'running';
    await store.save(conversation);
  });
  const fixture = await taskGateway({ tasks: { enabled: true }, home: crashed.home });
  try {
    const row = await fixture.settled(crashed.task);
    assert.equal(row.delivery, 'delivered');
    await until('the outcome turn to finish', async () => (await fixture.gateway.store.get(origin))?.status !== 'running');
    const conversation = await fixture.gateway.store.get(origin);
    assert.equal(keyed(conversation, taskOutcomeKey(crashed.task)).length, 1);
    assert.equal(conversation?.messages.filter((message) => message.role === 'assistant' && message.content === 'noted').length, 1);
    assert.deepEqual(fixture.calls.filter((id) => id === origin), [origin], 'the cut-off outcome turn ran once more, to finish');
  } finally {
    await fixture.stop();
  }
});

test('restart: a fallback already written is not written or posted again', async () => {
  // Written and posted, or written and not yet posted: the disk is the same,
  // because nothing records what a channel took. Either way it is not posted
  // again (spec: posted at most once).
  const origin = 'fixture:ava:C27';
  const crashed = await crashedAfterSettling(origin, 'fails');
  assert.equal(crashed.posted, 1);
  undeliver(crashed.home, crashed.task);
  const fixture = await taskGateway({ tasks: { enabled: true }, home: crashed.home });
  try {
    const row = await fixture.settled(crashed.task);
    assert.equal(row.delivery, 'delivered');
    const conversation = await fixture.gateway.store.get(origin);
    assert.equal(keyed(conversation, taskFallbackKey(crashed.task)).length, 1);
    assert.equal(keyed(conversation, taskOutcomeKey(crashed.task)).length, 1);
    assert.deepEqual(fixture.posts, []);
    assert.equal(fixture.calls.includes(origin), false);
  } finally {
    await fixture.stop();
  }
});

test('restart: a worker whose row is gone is left to the abandoned-turn sweep', async () => {
  // Only the task sweep's own rows are skipped by the generic sweeps; a
  // worker with no row (a fleet.db restored from before it) is failed as
  // any abandoned turn, not left running for good.
  const origin = 'fixture:ava:C28';
  const crashed = await crashedMidTask(origin);
  const db = new DatabaseSync(fleetDbIn(stateOf(crashed.home)));
  db.prepare('DELETE FROM tasks WHERE id = ?').run(crashed.task);
  db.close();
  const fixture = await taskGateway({ tasks: { enabled: true }, home: crashed.home });
  try {
    await until('the worker to be failed', async () => (await fixture.gateway.store.get(crashed.workerSessionId))?.status === 'failed');
    assert.equal((await fixture.gateway.store.get(crashed.workerSessionId))?.lastError, ABANDONED_TURN_ERROR);
    assert.equal(fixture.calls.includes(crashed.workerSessionId), false);
  } finally {
    await fixture.stop();
  }
});

test('restart: the sweep settles what the last process left even with tasks turned off since', async () => {
  const origin = 'fixture:ava:C29';
  const crashed = await crashedMidTask(origin);
  const fixture = await taskGateway({ home: crashed.home });
  try {
    const row = await fixture.settled(crashed.task);
    assert.deepEqual([row.status, row.delivery], ['interrupted', 'delivered']);
    assert.equal((await fixture.gateway.store.get(crashed.workerSessionId))?.lastError, TASK_CUT_OFF_ERROR);
  } finally {
    await fixture.stop();
  }
});

test('restart: a held daemon sweeps nothing until it is promoted', async () => {
  const origin = 'fixture:ava:C30';
  const crashed = await crashedMidTask(origin);
  const fixture = await taskGateway({ tasks: { enabled: true }, home: crashed.home, held: true });
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fixture.rows.get(crashed.task)?.status, 'running');
    assert.equal((await fixture.gateway.store.get(crashed.workerSessionId))?.status, 'running');
    await fixture.gateway.promote();
    const row = await fixture.settled(crashed.task);
    assert.deepEqual([row.status, row.delivery], ['interrupted', 'delivered']);
    assert.equal((await fixture.gateway.store.get(crashed.workerSessionId))?.lastError, TASK_CUT_OFF_ERROR);
  } finally {
    await fixture.stop();
  }
});

test('restart: the sweep prunes settled rows past retention and keeps the rest', async () => {
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000).toISOString();
  const recent = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
  const ids = { old: newTaskId(), recent: newTaskId() };
  const fixture = await taskGateway({
    tasks: { enabled: true },
    async seed(stateDir) {
      const rows = new SqliteTaskStore(fleetDbIn(stateDir), { stateHome: stateDir });
      for (const [id, at] of [[ids.old, old], [ids.recent, recent]] as const) {
        rows.claim({
          id,
          agentId: 'ava',
          workerAgentId: 'ava',
          originSessionId: `fixture:ava:C31-${id}`,
          workerSessionId: `fixture:ava:C31-${id}:delegate:ava:1:${id}`,
          promptDigest: taskPromptDigest('ava', id),
        }, 3, at);
        rows.setStatus(id, 'completed', at);
        rows.setDelivery(id, 'delivered', at);
      }
      rows.close();
    },
  });
  try {
    assert.equal(fixture.rows.get(ids.old), undefined);
    assert.equal(fixture.rows.get(ids.recent)?.delivery, 'delivered');
  } finally {
    await fixture.stop();
  }
});

// AGT-356 PR 5b: the drain. A stop or restart doesn't wait for background
// tasks: once the ordinary turns have drained, every running worker is cut
// off with the fixed error, so it reads `interrupted`, and its notice, refused
// while stopping, is delivered by the next start's sweep.

test('drain: a stop does not wait for a running background task; the worker is cut off and reported interrupted once, at the next start', async () => {
  const origin = 'fixture:ava:C40';
  const first = await taskGateway({ tasks: { enabled: true }, stopDrainTimeoutMs: 5_000 });
  let task: string;
  let workerSessionId: string;
  try {
    task = (first.delegated(await first.ask(origin, { to: 'ava', prompt: 'BLOCK-D', background: true })).output as { task: string }).task;
    await until('the worker to start', () => first.blockedCount() === 1);
    workerSessionId = first.rows.get(task)!.workerSessionId;
  } finally {
    first.rows.close();
  }
  const began = Date.now();
  await first.gateway.stop();
  assert.ok(Date.now() - began < 2_500, `the stop waited ${Date.now() - began}ms, as if for the task`);

  const second = await taskGateway({ tasks: { enabled: true }, home: first.home });
  try {
    const worker = await second.gateway.store.get(workerSessionId);
    assert.equal(worker?.status, 'failed');
    assert.equal(worker?.lastError, TASK_CUT_OFF_ERROR);
    const row = await second.settled(task);
    assert.deepEqual([row.status, row.delivery], ['interrupted', 'delivered']);
    const notices = keyed(await second.gateway.store.get(origin), taskOutcomeKey(task));
    assert.equal(notices.length, 1);
    assert.match(notices[0]!.content, /was interrupted after .*: a restart cut it off, and it was not run again\.\]$/);
    assert.equal(second.calls.includes(workerSessionId), false, 'the worker was not run again');
  } finally {
    await second.stop();
  }
});

test('drain: the workers are cut off only once the ordinary turns have drained', async () => {
  const first = await taskGateway({ tasks: { enabled: true }, stopDrainTimeoutMs: 5_000 });
  try {
    const task = (first.delegated(await first.ask('fixture:ava:C41', { to: 'ava', prompt: 'BLOCK-E', background: true })).output as { task: string }).task;
    await until('the worker to start', () => first.blockedCount() === 1);
    const ordinary = first.gateway.dispatch({ sessionId: 'fixture:ava:C42', agentId: 'ava', userMessage: 'WAIT' });
    await until('the ordinary turn to start', () => first.waitingCount() === 1);
    const stopped = first.gateway.stop();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(first.workerSignals[0]?.aborted, false, 'the task is not cut off while an ordinary turn still drains');
    first.releaseOrdinary();
    assert.equal((await ordinary).messages.at(-1)?.content, 'waited');
    await stopped;
    assert.equal(first.workerSignals[0]?.aborted, true);
    const worker = await new ShardedSessionStore({ stateDir: stateOf(first.home) }).get(first.rows.get(task)!.workerSessionId);
    assert.equal(worker?.lastError, TASK_CUT_OFF_ERROR);
  } finally {
    first.rows.close();
  }
});

test('drain: when the window runs out on an ordinary turn, the workers still end with the cut-off error, not the shutdown\'s', async () => {
  const first = await taskGateway({ tasks: { enabled: true }, stopDrainTimeoutMs: 300 });
  try {
    const task = (first.delegated(await first.ask('fixture:ava:C43', { to: 'ava', prompt: 'BLOCK-F', background: true })).output as { task: string }).task;
    await until('the worker to start', () => first.blockedCount() === 1);
    const ordinary = first.gateway.dispatch({ sessionId: 'fixture:ava:C44', agentId: 'ava', userMessage: 'WAIT' }).catch((error: unknown) => error);
    await until('the ordinary turn to start', () => first.waitingCount() === 1);
    await first.gateway.stop();
    await ordinary;
    const sessions = new ShardedSessionStore({ stateDir: stateOf(first.home) });
    try {
      assert.equal((await sessions.get(first.rows.get(task)!.workerSessionId))?.lastError, TASK_CUT_OFF_ERROR);
      assert.notEqual((await sessions.get('fixture:ava:C44'))?.lastError, TASK_CUT_OFF_ERROR, 'an ordinary turn keeps the shutdown\'s error');
    } finally {
      sessions.close();
    }
    assert.equal(first.rows.get(task)?.status, 'interrupted');
    assert.equal(first.rows.get(task)?.delivery, 'pending', 'the notice waits for the next start');
  } finally {
    first.rows.close();
  }
});

// AGT-357: cancelling a task through the gateway. Each point of spec test 8
// is in task-cancel.test.ts on stand-ins; these are the two that need the
// real turn and a real restart.

test('cancel: a worker stopped mid-turn runs no tool call after the cancel, and settles cancelled once', async () => {
  const fixture = await taskGateway({ tasks: { enabled: true } });
  try {
    const origin = 'fixture:ava:C40';
    const task = (fixture.delegated(await fixture.ask(origin, { to: 'ava', prompt: 'STUBBORN-1', background: true })).output as { task: string }).task;
    await until('the worker to start', () => fixture.blockedCount() === 1);
    const workerSessionId = fixture.rows.get(task)!.workerSessionId;

    const result = await fixture.gateway.cancelTask(task, 'cli');
    assert.equal(result.kind, 'stopping');
    assert.equal(fixture.rows.get(task)?.stoppedBy, 'cli', 'the stop is written before the turn ends');
    // The provider answers only now, after the cancel, with a tool call.
    fixture.release();

    const row = await fixture.settled(task);
    assert.deepEqual([row.status, row.stoppedBy, row.delivery], ['cancelled', 'cli', 'delivered']);
    const worker = await fixture.gateway.store.get(workerSessionId);
    assert.equal(worker?.status, 'failed');
    assert.equal(worker?.messages.some((message) => message.role === 'tool'), false, 'no tool ran in the worker');
    assert.equal((await fixture.gateway.store.list()).some((item) => item.id.startsWith(`${workerSessionId}:delegate:mia:`)), false, 'the delegation the provider asked for after the cancel never ran');
    assert.equal(fixture.calls.some((id) => id.includes(':delegate:mia:')), false);
    const notices = keyed(await fixture.gateway.store.get(origin), taskOutcomeKey(task));
    assert.equal(notices.length, 1);
    assert.match(notices[0]!.content, /was stopped from the CLI (before its first step finished|after 1 step)\.\]$/);

    assert.equal((await fixture.gateway.cancelTask(task, 'cli')).kind, 'finished', 'a cancel of a settled task changes nothing');
    assert.deepEqual(await fixture.gateway.cancelTask('t_nope', 'cli'), { kind: 'missing' });
  } finally {
    fixture.release();
    await fixture.stop();
  }
});

test('cancel: a crash after the stop was written and before the abort ends cancelled at the next start, not interrupted', async () => {
  const origin = 'fixture:ava:C41';
  const crashed = await crashedMidTask(origin);
  // The copy is the moment the worker was mid-turn; the stop is written into
  // it as a cancel would before its abort, then the process is gone.
  const stopped = new SqliteTaskStore(fleetDbIn(stateOf(crashed.home)), { stateHome: stateOf(crashed.home) });
  assert.equal(stopped.recordStop(crashed.task, 'U123', new Date().toISOString()), true);
  stopped.close();

  const fixture = await taskGateway({ tasks: { enabled: true }, home: crashed.home });
  try {
    const row = await fixture.settled(crashed.task);
    assert.deepEqual([row.status, row.stoppedBy, row.delivery], ['cancelled', 'U123', 'delivered']);
    assert.equal(fixture.calls.includes(crashed.workerSessionId), false, 'the worker was not run again');
    const notices = keyed(await fixture.gateway.store.get(origin), taskOutcomeKey(crashed.task));
    assert.equal(notices.length, 1);
    assert.match(notices[0]!.content, /was stopped by U123/);
    assert.doesNotMatch(notices[0]!.content, /interrupted/);
  } finally {
    await fixture.stop();
  }
});

// AGT-357 PR 2: the agent's own tools for its tasks.

test('agent.tasks and agent.cancelTask are offered only while tasks are on', async () => {
  const off = await taskGateway();
  const on = await taskGateway({ tasks: { enabled: true } });
  try {
    const names = (fixture: typeof off) => fixture.gateway.tools().map((tool) => tool.name);
    assert.equal(names(off).includes('agent.tasks'), false);
    assert.equal(names(off).includes('agent.cancelTask'), false);
    assert.ok(names(on).includes('agent.tasks'));
    assert.ok(names(on).includes('agent.cancelTask'));
  } finally {
    await off.stop();
    await on.stop();
  }
});

test('an agent lists its tasks with agent.tasks and stops one with agent.cancelTask, from any of its conversations', async () => {
  const fixture = await taskGateway({ tasks: { enabled: true } });
  try {
    const origin = 'fixture:ava:C50';
    const task = (fixture.delegated(await fixture.ask(origin, { to: 'ava', prompt: 'BLOCK-50', background: true })).output as { task: string }).task;
    await until('the worker to start', () => fixture.blockedCount() === 1);

    const listed = fixture.delegated(await fixture.ask(origin, { tool: 'agent.tasks' }));
    assert.equal(listed.ok, true, listed.error);
    const rows = (listed.output as { tasks: Array<Record<string, unknown>> }).tasks;
    assert.deepEqual(rows.map((row) => [row.task, row.status, row.worker, row.steps, row.delivery]), [[task, 'running', 'ava', 0, 'pending']]);
    assert.equal(typeof rows[0]!.age, 'string');
    assert.equal(JSON.stringify(rows).includes('BLOCK-50'), false, 'the list carries no prompt');

    const cancelled = fixture.delegated(await fixture.ask('fixture:ava:C51', { tool: 'agent.cancelTask', input: { task } }));
    assert.equal(cancelled.ok, true, cancelled.error);
    assert.equal((cancelled.output as { stopped: boolean }).stopped, true);

    const row = await fixture.settled(task);
    assert.deepEqual([row.status, row.stoppedBy], ['cancelled', 'agent']);
    const notices = keyed(await fixture.gateway.store.get(origin), taskOutcomeKey(task));
    assert.equal(notices.length, 1);
    assert.match(notices[0]!.content, /was stopped by the agent/);

    const after = (fixture.delegated(await fixture.ask(origin, { tool: 'agent.tasks' })).output as { tasks: Array<Record<string, unknown>> }).tasks;
    assert.deepEqual(after.map((entry) => [entry.task, entry.status, entry.delivery, entry.stoppedBy]), [[task, 'cancelled', 'delivered', 'agent']]);

    const again = fixture.delegated(await fixture.ask(origin, { tool: 'agent.cancelTask', input: { task } }));
    assert.equal(again.ok, true, again.error);
    assert.deepEqual([(again.output as { stopped: boolean }).stopped, (again.output as { status: string }).status], [false, 'cancelled']);
  } finally {
    fixture.release();
    await fixture.stop();
  }
});
