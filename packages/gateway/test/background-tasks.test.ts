import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { AllowAllApprovalPolicy, carriesKey, type PluginContext, type ProviderResponse, type Session } from '@stratusagent/core';
import { TASK_ID_METADATA_KEY } from '@stratusagent/agents';
import type { OptionalModuleHost } from '@stratusagent/plugins';
import { fleetDbIn } from '@stratusagent/state';

import { createGateway } from '../src/index.ts';
import { taskFallbackKey, taskOutcomeKey } from '../src/task-settle.ts';
import { SqliteTaskStore, type TaskRow } from '../src/tasks.ts';

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

/** What an origin turn asks for: one `agent.delegate` call. */
interface Ask {
  to: string;
  prompt: string;
  background?: boolean;
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
  tasks?: { enabled?: boolean; maxRunningPerAgent?: number };
  noticeTurn?: 'answers' | 'fails';
  /** The fixture channel refuses posts. */
  postRefused?: boolean;
} = {}) => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', [
    '---', 'name: Ava', 'id: ava', 'provider: scripted', 'tools: [agent.delegate]', 'delegates: [mia]',
    '---', '', 'You are Ava.', '',
  ].join('\n'));
  await writeSoul(home, 'mia.md', '---\nname: Mia\nid: mia\nprovider: scripted\ntools: []\n---\n\nYou are Mia.\n');
  const posts: Array<{ agentId: string; to: string; thread?: string; speaker?: unknown; text: string }> = [];
  const blocked: Array<() => void> = [];
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
              const said = lastUser(session);
              if (session.metadata?.[TASK_ID_METADATA_KEY] !== undefined) {
                if (said.startsWith('BLOCK')) {
                  if (signal) {
                    workerSignals.push(signal);
                  }
                  await new Promise<void>((resolve) => blocked.push(resolve));
                }
                return { parts: [{ type: 'text', text: `did ${said}` }] };
              }
              if (said.startsWith('[Background task')) {
                if (options.noticeTurn === 'fails') {
                  throw new Error('the provider is down');
                }
                return { parts: [{ type: 'text', text: 'noted' }] };
              }
              const last = session.messages.at(-1);
              if (last?.role === 'tool') {
                return { parts: [{ type: 'text', text: `tool said: ${JSON.stringify(last.toolResult ?? null)}` }] };
              }
              const ask = JSON.parse(said) as Ask;
              return {
                parts: [{
                  type: 'tool-call',
                  call: { id: `${session.id}:${session.messages.length}`, toolName: 'agent.delegate', input: { agent: ask.to, prompt: ask.prompt, ...(ask.background !== undefined ? { background: ask.background } : {}) } },
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
    log: () => {},
    warn: (line) => warnings.push(line),
  });
  await gateway.start();
  const rows = new SqliteTaskStore(fleetDbIn(path.join(home, '.stratus')), { stateHome: path.join(home, '.stratus') });
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
    gateway,
    rows,
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
  const fixture = await taskGateway({ tasks: { enabled: true, maxRunningPerAgent: 1 } });
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

test('tasks.maxRunningPerAgent must be a whole number of at least 1, whether or not tasks are on', () => {
  for (const tasks of [{ maxRunningPerAgent: 0 }, { enabled: true, maxRunningPerAgent: 1.5 }, { maxRunningPerAgent: Number.NaN }]) {
    assert.throws(
      () => createGateway({ env: { homeDir: os.tmpdir(), cwd: os.tmpdir(), processEnv: {} }, tasks }),
      /tasks\.maxRunningPerAgent must be a whole number of at least 1/,
    );
  }
});
