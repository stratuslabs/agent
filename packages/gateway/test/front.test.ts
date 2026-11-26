import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FRONT_NOTE } from '@stratusagent/core';
import { FRONT_MAX_STEPS, frontToolEntries } from '@stratusagent/agents';
import { fleetDbPath } from '@stratusagent/state';
import { createGateway, SqliteScheduleStore } from '../src/index.ts';

/*
 * A soul's `front:` (the conversation side of an agent): the turns a person
 * is waiting on run on the front's model with the front's tools, and
 * everything else keeps the agent's own. Driven through an OpenAI-compatible
 * fake, so each request says which model it asked for and which tools it
 * offered.
 */

interface CapturedRequest {
  model: string;
  messages: Array<{ role: string; content: string | null; tool_call_id?: string }>;
  tools?: Array<{ function: { name: string } }>;
}

const reply = (message: Record<string, unknown>): Response =>
  new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', ...message } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const text = (content: string): Response => reply({ content });

const toolCall = (id: string, name: string, input: Record<string, unknown>): Response =>
  reply({ content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] });

const wire = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, '_');

const toolsOf = (request: CapturedRequest | undefined): string[] =>
  (request?.tools ?? []).map((tool) => tool.function.name).sort();

const systemOf = (request: CapturedRequest | undefined): string =>
  (request?.messages ?? []).filter((message) => message.role === 'system').map((message) => message.content).join('\n');

const lastUserOf = (request: CapturedRequest): string =>
  [...request.messages].reverse().find((message) => message.role === 'user')?.content ?? '';

const homeWith = async (soul: string): Promise<string> => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-gw-front-'));
  const agentsDir = path.join(home, '.stratus', 'agents');
  await mkdir(agentsDir, { recursive: true });
  await writeFile(path.join(agentsDir, 'ava.md'), soul);
  return home;
};

const AVA_WITH_FRONT = [
  '---', 'name: Ava', 'id: ava', 'provider: openai', 'model: main-model', 'tools: ["*"]',
  'front:', '  model: front-model', '---', '', 'You are Ava.', '',
].join('\n');

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
};

/** The gate, bounded: a regression fails here instead of hanging the suite. */
const within = async (gate: Deferred, what: string, ms = 5_000): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      gate.promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

test('with front: set, a DM turn runs on the front model with only the front tools, and is told it is the front', async () => {
  const home = await homeWith(AVA_WITH_FRONT);
  const captured: CapturedRequest[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    captured.push(JSON.parse(String(init?.body)) as CapturedRequest);
    return text('9:30, the DG block.');
  }) as typeof fetch;
  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0, log: () => {}, warn: () => {} });
  await gateway.start();
  try {
    const entries = frontToolEntries({ model: 'front-model' });
    // skill.read rides on the agent having a skill (the built-in one, here),
    // not on any tools list, for a front turn as for every other.
    const expected = [...gateway.tools().map((tool) => tool.name).filter((name) => entries.includes(name)), 'skill.read'].map(wire).sort();
    // The quick reads, memory and messages are here, and the task tools.
    assert.ok(expected.includes('memory_recall') && expected.includes('message_send') && expected.includes('agent_delegate'), expected.join(', '));

    const session = await gateway.dispatch({
      sessionId: 'slack:ava:D01',
      agentId: 'ava',
      userMessage: 'what time is my first call tomorrow?',
      metadata: { channel: 'slack' },
    });

    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.model, 'front-model');
    assert.deepEqual(toolsOf(captured[0]), expected);
    // Nothing the front set leaves out, however wide the agent's own list:
    // no schedules, no forgetting, not even the credential request every
    // other turn is granted.
    for (const absent of ['memory_forget', 'credential_request', 'schedule_every']) {
      assert.equal(toolsOf(captured[0]).includes(absent), false, absent);
    }
    assert.ok(systemOf(captured[0]).includes(FRONT_NOTE));
    assert.equal(session.metadata?.model, 'front-model');
    assert.equal(session.messages.at(-1)?.content, '9:30, the DG block.');
  } finally {
    await gateway.stop();
  }
});

test('with front: set, a schedule firing runs on the main model with the agent\'s own tools', async () => {
  const home = await homeWith(AVA_WITH_FRONT);
  const captured: CapturedRequest[] = [];
  const fired = deferred();
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as CapturedRequest;
    captured.push(body);
    if (lastUserOf(body).includes('do the scheduled thing')) {
      fired.resolve();
    }
    return text('done');
  }) as typeof fetch;
  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({
    env,
    idleTimeoutMs: 0,
    log: () => {},
    warn: () => {},
    schedules: { minIntervalMs: 500, tickMs: 25 },
  });
  await gateway.start();
  try {
    const store = new SqliteScheduleStore(fleetDbPath({ homeDir: home }));
    store.insert({
      id: 'sched-front',
      agentId: 'ava',
      cadence: { kind: 'every', intervalMs: 600_000 },
      prompt: 'do the scheduled thing',
      createdAt: new Date().toISOString(),
      nextFireAt: new Date(Date.now() - 5).toISOString(),
    });
    store.close();
    await within(fired, 'the firing');
  } finally {
    await gateway.stop();
  }

  const firing = captured.find((request) => lastUserOf(request).includes('do the scheduled thing'));
  assert.ok(firing);
  assert.equal(firing.model, 'main-model');
  // The agent's own list: wider than any front's.
  assert.ok(toolsOf(firing).includes('schedule_every'), toolsOf(firing).join(', '));
  assert.ok(toolsOf(firing).includes('memory_forget'));
  assert.equal(systemOf(firing).includes(FRONT_NOTE), false);
});

test('front.tools never grants what the agent\'s own tools: does not', async () => {
  const home = await homeWith([
    '---', 'name: Ava', 'id: ava', 'provider: openai', 'model: main-model', 'tools: [memory.recall, schedule.list]',
    'front:', '  model: front-model', '  tools: [memory.recall, message.send, memory.forget]', '---', '', 'You are Ava.', '',
  ].join('\n'));
  const captured: CapturedRequest[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    captured.push(JSON.parse(String(init?.body)) as CapturedRequest);
    return text('ok');
  }) as typeof fetch;
  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0, log: () => {}, warn: () => {} });
  await gateway.start();
  try {
    await gateway.dispatch({ sessionId: 'front-narrow', agentId: 'ava', userMessage: 'hi' });
  } finally {
    await gateway.stop();
  }
  // memory.recall is in both lists. message.send and memory.forget are in
  // the front's only, schedule.list in the agent's only, and the task tools
  // in neither the agent's list nor, therefore, the front. skill.read
  // follows skills:, as on every turn.
  assert.deepEqual(toolsOf(captured[0]), ['memory_recall', 'skill_read']);
  assert.equal(captured[0]!.model, 'front-model');
});

test('a soul with no tools: list gives its front only the safe tools of the front set, as it would any turn', async () => {
  const home = await homeWith([
    '---', 'name: Ava', 'id: ava', 'provider: openai', 'model: main-model', 'front:', '  model: front-model', '---', '', 'You are Ava.', '',
  ].join('\n'));
  const captured: CapturedRequest[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    captured.push(JSON.parse(String(init?.body)) as CapturedRequest);
    return text('ok');
  }) as typeof fetch;
  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0, log: () => {}, warn: () => {} });
  await gateway.start();
  let safe: string[];
  try {
    const entries = frontToolEntries({ model: 'front-model' });
    safe = gateway.tools().filter((tool) => entries.includes(tool.name) && tool.risk === 'safe').map((tool) => wire(tool.name));
    await gateway.dispatch({ sessionId: 'front-unlisted', agentId: 'ava', userMessage: 'hi' });
  } finally {
    await gateway.stop();
  }
  assert.equal(captured[0]!.model, 'front-model');
  assert.deepEqual(toolsOf(captured[0]), [...safe, 'skill_read'].sort());
  // message.send is in the front set but not safe, so an omitted list keeps it out.
  assert.equal(toolsOf(captured[0]).includes('message_send'), false);
  assert.ok(toolsOf(captured[0]).includes('memory_recall'));
});

test('an agent without front: runs a DM turn on its own model and tools, as before', async () => {
  const home = await homeWith([
    '---', 'name: Ava', 'id: ava', 'provider: openai', 'model: main-model', 'tools: ["*"]', '---', '', 'You are Ava.', '',
  ].join('\n'));
  const captured: CapturedRequest[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    captured.push(JSON.parse(String(init?.body)) as CapturedRequest);
    return text('ok');
  }) as typeof fetch;
  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0, log: () => {}, warn: () => {} });
  await gateway.start();
  try {
    await gateway.dispatch({ sessionId: 'slack:ava:D02', agentId: 'ava', userMessage: 'hi', metadata: { channel: 'slack' } });
  } finally {
    await gateway.stop();
  }
  assert.equal(captured[0]!.model, 'main-model');
  assert.ok(toolsOf(captured[0]).includes('credential_request'));
  assert.ok(toolsOf(captured[0]).includes('schedule_every'));
  assert.equal(systemOf(captured[0]).includes(FRONT_NOTE), false);
});

test('when the front model fails, that call answers on the agent\'s own model, the log says so without the conversation, and the next turn tries the front again', async () => {
  const home = await homeWith(AVA_WITH_FRONT);
  const captured: CapturedRequest[] = [];
  let frontDown = true;
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as CapturedRequest;
    captured.push(body);
    if (body.model === 'front-model' && frontDown) {
      // A provider's error can quote the request, the person's words included.
      return new Response(JSON.stringify({ error: { message: `no such model; request was: ${lastUserOf(body)}` } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    return text(`answered by ${body.model}`);
  }) as typeof fetch;
  const warnings: string[] = [];
  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0, log: () => {}, warn: (line: string) => warnings.push(line) });
  await gateway.start();
  let first;
  let second;
  try {
    first = await gateway.dispatch({ sessionId: 'front-down', agentId: 'ava', userMessage: 'my PIN is 4321' });
    frontDown = false;
    second = await gateway.dispatch({ sessionId: 'front-down', agentId: 'ava', userMessage: 'and now?' });
  } finally {
    await gateway.stop();
  }
  assert.deepEqual(captured.map((request) => request.model), ['front-model', 'main-model', 'front-model']);
  assert.equal(first.messages.at(-1)?.content, 'answered by main-model');
  assert.equal(second.messages.at(-1)?.content, 'answered by front-model');
  // The main model answering a front turn still holds only the front tools.
  assert.deepEqual(toolsOf(captured[1]), toolsOf(captured[0]));
  const said = warnings.filter((line) => line.includes('the front model failed'));
  assert.equal(said.length, 1, warnings.join('\n'));
  assert.equal(warnings.some((line) => line.includes('4321')), false, warnings.join('\n'));
  // Nothing sticky: the session was never switched to a fallback.
  assert.equal(second.metadata?.fallbackActive, undefined);
});

for (const [agentCap, steps] of [[undefined, FRONT_MAX_STEPS], [3, 3]] as const) {
  test(`a front turn that keeps calling tools wraps up after ${steps} steps${agentCap !== undefined ? ', the agent\'s lower cap winning' : ''}`, async () => {
    const home = await homeWith(AVA_WITH_FRONT);
    const captured: CapturedRequest[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as CapturedRequest & { tool_choice?: string };
      captured.push(body);
      // A front that loops: every response asks for another recall until
      // the request says no more tools.
      return body.tool_choice === 'none'
        ? text('Still looking; I started a task for the rest.')
        : toolCall(`call-${captured.length}`, 'memory_recall', { query: 'git chart' });
    }) as typeof fetch;
    const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
    const gateway = createGateway({
      env,
      idleTimeoutMs: 0,
      log: () => {},
      warn: () => {},
      ...(agentCap !== undefined ? { maxTurns: agentCap } : {}),
    });
    await gateway.start();
    let session;
    try {
      session = await gateway.dispatch({ sessionId: `front-cap-${steps}`, agentId: 'ava', userMessage: 'find it' });
    } finally {
      await gateway.stop();
    }
    // Its steps, then the one wrap-up that may not call a tool.
    assert.equal(captured.length, steps + 1);
    assert.equal(session.messages.at(-1)?.content, 'Still looking; I started a task for the rest.');
  });
}

test('a background task a front turn starts runs on the main model, and its outcome notice is a front turn', async () => {
  const home = await homeWith(AVA_WITH_FRONT);
  const captured: CapturedRequest[] = [];
  const noticed = deferred();
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as CapturedRequest;
    captured.push(body);
    const said = lastUserOf(body);
    const last = body.messages.at(-1);
    if (said.startsWith('[Background task')) {
      noticed.resolve();
      return text('Here is the updated plan.');
    }
    if (said === 'PLAN-JOB') {
      return text('updated the plan');
    }
    // The front: start the job on itself, then say so.
    return last?.role === 'tool'
      ? text('On it, I started that.')
      : toolCall('delegate-1', 'agent_delegate', { agent: 'ava', prompt: 'PLAN-JOB', background: true });
  }) as typeof fetch;
  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0, log: () => {}, warn: () => {}, tasks: { enabled: true } });
  await gateway.start();
  try {
    await gateway.dispatch({ sessionId: 'slack:ava:D03', agentId: 'ava', userMessage: 'update my plan', metadata: { channel: 'slack' } });
    await within(noticed, 'the outcome notice');
  } finally {
    await gateway.stop();
  }

  const worker = captured.find((request) => lastUserOf(request) === 'PLAN-JOB');
  assert.ok(worker, 'the worker ran');
  assert.equal(worker.model, 'main-model');
  assert.ok(toolsOf(worker).includes('memory_forget'), 'the worker holds the agent\'s own tools');
  assert.equal(systemOf(worker).includes(FRONT_NOTE), false);

  const notice = captured.find((request) => lastUserOf(request).startsWith('[Background task'));
  assert.ok(notice, 'the outcome notice ran');
  assert.equal(notice.model, 'front-model');
  assert.ok(systemOf(notice).includes(FRONT_NOTE));
  assert.equal(toolsOf(notice).includes('memory_forget'), false);
});
