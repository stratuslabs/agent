import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { RunAbortedError } from '@stratusagent/core';
import { createGateway, SqliteSessionStore } from '../src/index.ts';

const newHome = async (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'stratus-gw-'));

const writeSoul = async (home: string, file: string, contents: string): Promise<void> => {
  const dir = path.join(home, '.stratus', 'agents');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, file), contents);
};

const openAiText = (text: string): Response =>
  new Response(
    JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

// A minimal Anthropic SSE stream: the gateway's streaming path (anthropic +
// apiKey) drives the SDK's stream parser, which wants real event framing.
const anthropicSse = (events: Array<{ type: string }>): Response =>
  new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );

const anthropicMessageStart = {
  type: 'message_start',
  message: {
    id: 'msg_1', type: 'message', role: 'assistant', model: 'model-x', content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
  },
};

const anthropicSseText = (text: string): Response =>
  anthropicSse([
    anthropicMessageStart,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ]);

const anthropicSseToolCall = (wireName: string, args: object): Response =>
  anthropicSse([
    anthropicMessageStart,
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: wireName, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ]);

const openAiToolCall = (name: string, args: object): Response =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(args) } },
            ],
          },
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

test('sessions survive a gateway restart and resume with full history', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };

  const first = createGateway({ env, idleTimeoutMs: 0 });
  await first.start();
  const opening = await first.dispatch({ sessionId: 'thread-1', userMessage: 'say hello' });
  assert.equal(opening.status, 'completed');
  await first.stop();

  // A brand-new gateway process over the same home: the same session id
  // must continue the conversation, not start a new one.
  const second = createGateway({ env, idleTimeoutMs: 0 });
  await second.start();
  const resumed = await second.dispatch({ sessionId: 'thread-1', userMessage: 'still there?' });
  await second.stop();

  const userMessages = resumed.messages.filter((message) => message.role === 'user').map((m) => m.content);
  assert.deepEqual(userMessages, ['say hello', 'still there?']);
  assert.equal(resumed.status, 'completed');
});

test('sqlite sessions round-trip metadata (anthropic raw-turn cache included)', async () => {
  const home = await newHome();
  const store = new SqliteSessionStore(path.join(home, 'sessions.db'));
  await store.create({
    id: 's1',
    agent: { id: 'ava', name: 'Ava' },
    status: 'running',
    messages: [],
    metadata: { anthropicRawTurns: { 'call-1': [{ type: 'thinking', thinking: 'hmm' }] } },
  });
  const loaded = await store.get('s1');
  assert.deepEqual(loaded?.metadata, { anthropicRawTurns: { 'call-1': [{ type: 'thinking', thinking: 'hmm' }] } });
  store.close();
});

test('agents pinned to different models run through their own provider config', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  await writeSoul(home, 'bea.md', '---\nname: Bea\nprovider: openai\nmodel: model-b\n---\n\nYou are Bea.\n');

  const requestedModels: string[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string };
    requestedModels.push(body.model);
    return openAiText(`reply from ${body.model}`);
  }) as typeof fetch;

  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();

  const fromAva = await gateway.dispatch({ sessionId: 'a-1', agentId: 'ava', userMessage: 'hi' });
  const fromBea = await gateway.dispatch({ sessionId: 'b-1', agentId: 'bea', userMessage: 'hi' });
  await gateway.stop();

  assert.deepEqual(requestedModels, ['model-a', 'model-b']);
  assert.match(fromAva.messages.at(-1)?.content ?? '', /model-a/);
  assert.match(fromBea.messages.at(-1)?.content ?? '', /model-b/);
});

test('delegation runs the target on the target\'s own provider config', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', [
    '---',
    'name: Ava',
    'provider: openai',
    'model: model-a',
    'tools:',
    '  - agent.delegate',
    '---',
    '',
    'You are Ava, an orchestrator.',
    '',
  ].join('\n'));
  await writeSoul(home, 'bea.md', '---\nname: Bea\nprovider: openai\nmodel: model-b\n---\n\nYou are Bea.\n');

  let avaCalls = 0;
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string };
    if (body.model === 'model-a') {
      avaCalls += 1;
      return avaCalls === 1
        ? openAiToolCall('agent_delegate', { agent: 'Bea', prompt: 'take this over' })
        : openAiText('ava done');
    }
    return openAiText(`bea here on ${body.model}`);
  }) as typeof fetch;

  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();
  const session = await gateway.dispatch({ sessionId: 'orchestrate-1', agentId: 'ava', userMessage: 'delegate please' });
  await gateway.stop();

  const toolMessage = session.messages.find((message) => message.role === 'tool');
  assert.ok(toolMessage?.toolResult?.ok, `delegation failed: ${toolMessage?.toolResult?.error}`);
  const output = toolMessage.toolResult.output as { agent: string; reply: string };
  assert.equal(output.agent, 'Bea');
  // The delegated turn ran on Bea's model — never on the delegator's.
  assert.match(output.reply, /model-b/);
});

test('the watchdog aborts a stalled streaming turn and fails the session cleanly', async () => {
  const home = await newHome();
  // The idle watchdog applies to delta-streaming providers (Anthropic API
  // path); a request that never resolves until its signal fires simulates
  // a stall, and the abort must cancel the underlying request.
  await writeSoul(home, 'slow.md', '---\nname: Slow\nprovider: anthropic\nmodel: model-slow\n---\n\nYou stall.\n');

  const fetchImpl = ((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      if (init?.signal?.aborted) {
        reject(new DOMException('aborted', 'AbortError'));
        return;
      }
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    })) as typeof fetch;

  const env = { homeDir: home, cwd: home, processEnv: { ANTHROPIC_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 300, warn: () => {} });
  await gateway.start();

  await assert.rejects(
    () => gateway.dispatch({ sessionId: 'stalled-1', agentId: 'slow', userMessage: 'hang' }),
    (error: Error) => error instanceof RunAbortedError && /no activity/.test(error.message),
  );

  const stored = await gateway.store.get('stalled-1');
  assert.equal(stored?.status, 'failed');
  await gateway.stop();
});

test('the idle watchdog stays off for non-streaming providers', async () => {
  const home = await newHome();
  await writeSoul(home, 'steady.md', '---\nname: Steady\nprovider: openai\nmodel: model-a\n---\n\nYou take your time.\n');

  // Slower than the idle timeout, but healthy: a non-streaming provider
  // emits no deltas, so the watchdog must not treat silence as a stall.
  const fetchImpl = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
    return openAiText('worth the wait');
  }) as typeof fetch;

  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 100, warn: () => {} });
  await gateway.start();
  const session = await gateway.dispatch({ sessionId: 'steady-1', agentId: 'steady', userMessage: 'take your time' });
  await gateway.stop();

  assert.equal(session.status, 'completed');
  assert.match(session.messages.at(-1)?.content ?? '', /worth the wait/);
});

test('a rotated credential reaches the provider on the next dispatch', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');

  const authHeaders: string[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    authHeaders.push(String((init?.headers as Record<string, string>)?.authorization ?? ''));
    return openAiText('ok');
  }) as typeof fetch;

  const processEnv: NodeJS.ProcessEnv = { OPENAI_API_KEY: 'sk-before' };
  const env = { homeDir: home, cwd: home, processEnv, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();

  await gateway.dispatch({ sessionId: 'rotate-1', agentId: 'ava', userMessage: 'one' });
  processEnv.OPENAI_API_KEY = 'sk-after';
  await gateway.dispatch({ sessionId: 'rotate-2', agentId: 'ava', userMessage: 'two' });
  await gateway.stop();

  assert.deepEqual(authHeaders, ['Bearer sk-before', 'Bearer sk-after']);
});

test('a session never crosses agent identities', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  const fetchImpl = (async () => openAiText('ok')) as typeof fetch;
  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };

  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();
  await gateway.dispatch({ sessionId: 'shared-1', agentId: 'ava', userMessage: 'hi' });
  await assert.rejects(
    () => gateway.dispatch({ sessionId: 'shared-1', agentId: 'stratus', userMessage: 'hijack' }),
    /never cross agent identities/,
  );
  await gateway.stop();
});

test('a soul edit reaches an existing session on its next turn', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are cheerful.\n');

  const systemPrompts: string[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
    systemPrompts.push(body.messages.find((message) => message.role === 'system')?.content ?? '');
    return openAiText('ok');
  }) as typeof fetch;

  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();

  await gateway.dispatch({ sessionId: 'edit-1', agentId: 'ava', userMessage: 'hi' });
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are extremely grumpy.\n');
  await gateway.dispatch({ sessionId: 'edit-1', agentId: 'ava', userMessage: 'hi again' });
  await gateway.stop();

  assert.match(systemPrompts[0] ?? '', /cheerful/);
  assert.match(systemPrompts[1] ?? '', /extremely grumpy/);
});

test('messages to one session are single-flight; separate sessions run concurrently', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');

  let inFlight = 0;
  let sawOverlapSameSession = false;
  let sawConcurrency = false;
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
    const last = body.messages.at(-1)?.content ?? '';
    inFlight += 1;
    if (inFlight > 1) {
      if (last.startsWith('same')) {
        sawOverlapSameSession = true;
      }
      sawConcurrency = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
    inFlight -= 1;
    return openAiText(`echo ${last}`);
  }) as typeof fetch;

  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();

  const [one, two] = await Promise.all([
    gateway.dispatch({ sessionId: 'sf-1', agentId: 'ava', userMessage: 'same first' }),
    gateway.dispatch({ sessionId: 'sf-1', agentId: 'ava', userMessage: 'same second' }),
  ]);
  await Promise.all([
    gateway.dispatch({ sessionId: 'p-1', agentId: 'ava', userMessage: 'parallel one' }),
    gateway.dispatch({ sessionId: 'p-2', agentId: 'ava', userMessage: 'parallel two' }),
  ]);
  await gateway.stop();

  assert.equal(sawOverlapSameSession, false, 'same-session turns must not interleave');
  assert.equal(sawConcurrency, true, 'separate sessions should run concurrently');
  // The queued second message resumed the same session after the first.
  assert.equal(two.messages.filter((m) => m.role === 'user').length, 2);
  assert.equal(one.messages.filter((m) => m.role === 'user').length, 1);
});

test('a stopping gateway refuses new work but drains in-flight turns', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();

  const turn = gateway.dispatch({ sessionId: 'drain-1', userMessage: 'say hello' });
  const stopped = gateway.stop();
  await assert.rejects(
    () => gateway.dispatch({ sessionId: 'drain-2', userMessage: 'too late' }),
    /stopping/,
  );
  const session = await turn;
  assert.equal(session.status, 'completed');
  await stopped;
});

test('the session database and its directory are owner-only', async () => {
  const { stat } = await import('node:fs/promises');
  const home = await newHome();
  const dbPath = path.join(home, 'state', 'sessions.db');
  const store = new SqliteSessionStore(dbPath);
  store.close();

  assert.equal(((await stat(path.dirname(dbPath))).mode & 0o777), 0o700);
  assert.equal(((await stat(dbPath)).mode & 0o777), 0o600);
});

test('a pre-existing loose session directory is tightened to owner-only', async () => {
  const { stat } = await import('node:fs/promises');
  const home = await newHome();
  // The upgrade path: ~/.stratus already exists with the default 0755 from
  // an earlier install. mkdir's mode only applies to directories it
  // creates, so the constructor must chmod explicitly — but only for a
  // directory declared as dedicated Stratus state.
  const dir = path.join(home, 'state');
  await mkdir(dir, { recursive: true, mode: 0o755 });
  const dbPath = path.join(dir, 'sessions.db');
  const store = new SqliteSessionStore(dbPath, { ownedDirectory: true });
  store.close();

  assert.equal(((await stat(dir)).mode & 0o777), 0o700);
});

test('a caller-supplied parent directory is never chmodded', async () => {
  const { stat } = await import('node:fs/promises');
  const home = await newHome();
  // An embedder pointing sessionDbPath at a shared directory (think /tmp
  // or a project root): the store must not change that directory's
  // permissions from under other processes. The database file itself is
  // still tightened — it is always ours.
  const dir = path.join(home, 'shared');
  await mkdir(dir, { recursive: true, mode: 0o755 });
  const dbPath = path.join(dir, 'sessions.db');
  const store = new SqliteSessionStore(dbPath);
  store.close();

  assert.equal(((await stat(dir)).mode & 0o777), 0o755);
  assert.equal(((await stat(dbPath)).mode & 0o777), 0o600);
});

test('a queued dispatch whose signal aborted while waiting never mutates the session', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');

  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
    await new Promise((resolve) => setTimeout(resolve, 60));
    return openAiText(`echo ${body.messages.at(-1)?.content ?? ''}`);
  }) as typeof fetch;

  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();

  const controller = new AbortController();
  const first = gateway.dispatch({ sessionId: 'q-1', agentId: 'ava', userMessage: 'first' });
  const second = gateway.dispatch({ sessionId: 'q-1', agentId: 'ava', userMessage: 'second', signal: controller.signal });
  controller.abort(); // fires while `second` waits behind `first`

  const settled = await first;
  await assert.rejects(() => second, (error: Error) => error instanceof RunAbortedError);

  assert.equal(settled.status, 'completed');
  const stored = await gateway.store.get('q-1');
  await gateway.stop();
  // The cancelled message never entered durable history and the session
  // was not marked failed by work that never ran.
  assert.deepEqual(stored?.messages.filter((m) => m.role === 'user').map((m) => m.content), ['first']);
  assert.equal(stored?.status, 'completed');
});

test('the idle watchdog honors a session sticky-switched to a non-streaming fallback', async () => {
  const home = await newHome();
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  // Anthropic primary (streams → watchdog eligible) with an OpenAI
  // fallback (no deltas): once a session has durably switched, the
  // watchdog must stay off for it or slow-but-healthy fallback turns die.
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({
    provider: 'anthropic',
    model: 'model-p',
    fallbackModel: 'model-f',
    fallbackProvider: 'openai',
  }));

  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    if (String(url).includes('anthropic')) {
      throw new Error('primary should not be called for a switched session');
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
    return openAiText('slow but healthy fallback');
  }) as typeof fetch;

  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { ANTHROPIC_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-o' },
    fetch: fetchImpl,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 100, warn: () => {} });
  await gateway.start();

  // A durable session that already switched to the fallback.
  await gateway.store.create({
    id: 'switched-1',
    agent: { id: 'stratus', name: 'Stratus' },
    status: 'completed',
    messages: [
      { id: 'u1', role: 'user', content: 'earlier', createdAt: new Date().toISOString() },
      { id: 'a1', role: 'assistant', content: 'earlier reply', createdAt: new Date().toISOString() },
    ],
    metadata: { fallbackActive: true },
  });

  const session = await gateway.dispatch({ sessionId: 'switched-1', userMessage: 'take your time' });
  await gateway.stop();

  assert.equal(session.status, 'completed');
  assert.match(session.messages.at(-1)?.content ?? '', /slow but healthy fallback/);
});

test('the watchdog suspends across a slow tool phase and re-arms for the next provider call', async () => {
  const home = await newHome();
  // A streaming primary calls agent.delegate; the delegated agent's provider
  // takes longer than the idle timeout. The tool phase emits no deltas, so
  // the watchdog must suspend at provider.response and only re-arm once the
  // tool settles — otherwise every slow tool or approval wait dies at the
  // idle timeout.
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: anthropic\nmodel: model-a\n---\n\nYou are Ava.\n');
  await writeSoul(home, 'bea.md', '---\nname: Bea\nprovider: openai\nmodel: model-b\n---\n\nYou are Bea.\n');

  let anthropicCalls = 0;
  const fetchImpl = (async (url: unknown) => {
    if (String(url).includes('anthropic')) {
      anthropicCalls += 1;
      return anthropicCalls === 1
        ? anthropicSseToolCall('agent_delegate', { agent: 'bea', prompt: 'take your time' })
        : anthropicSseText('bea finally answered');
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
    return openAiText('slow but healthy delegate');
  }) as typeof fetch;

  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { ANTHROPIC_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-o' },
    fetch: fetchImpl,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 100, warn: () => {} });
  await gateway.start();

  const session = await gateway.dispatch({ sessionId: 'tool-phase-1', agentId: 'ava', userMessage: 'delegate this' });
  await gateway.stop();

  assert.equal(session.status, 'completed');
  assert.equal(anthropicCalls, 2);
  assert.match(session.messages.at(-1)?.content ?? '', /bea finally answered/);
});

test('a mid-turn switch to a non-streaming fallback suspends the watchdog for the turn', async () => {
  const home = await newHome();
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  // The primary dies before the session ever recorded a durable switch, so
  // this turn started watchdog-eligible. The reset delta emitted at the
  // switch must suspend the timer: the OpenAI fallback emits no deltas, and
  // its slow-but-healthy turn would otherwise be killed as a stall.
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({
    provider: 'anthropic',
    model: 'model-p',
    fallbackModel: 'model-f',
    fallbackProvider: 'openai',
  }));

  const fetchImpl = (async (url: unknown) => {
    if (String(url).includes('anthropic')) {
      // A 400 fails the primary immediately — the SDK does not retry it,
      // so the switch happens while the watchdog is still freshly armed.
      return new Response(
        JSON.stringify({ error: { type: 'invalid_request_error', message: 'primary down' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
    return openAiText('fallback rode out the silence');
  }) as typeof fetch;

  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { ANTHROPIC_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-o' },
    fetch: fetchImpl,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 100, warn: () => {} });
  await gateway.start();

  const session = await gateway.dispatch({ sessionId: 'mid-turn-1', userMessage: 'hang in there' });
  await gateway.stop();

  assert.equal(session.status, 'completed');
  assert.match(session.messages.at(-1)?.content ?? '', /fallback rode out the silence/);
});

test('a soul provider pin beats the gateway-wide selection', async () => {
  const home = await newHome();
  // The gateway's selection is a default for unpinned agents, never an
  // override: Ava pins Anthropic, so she must not be routed through the
  // gateway's OpenAI default — nor inherit its model.
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: anthropic\nmodel: model-a\n---\n\nYou are Ava.\n');

  const urls: string[] = [];
  const fetchImpl = (async (url: unknown) => {
    urls.push(String(url));
    if (String(url).includes('anthropic')) {
      return anthropicSseText('from anthropic');
    }
    return openAiText('from openai');
  }) as typeof fetch;

  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { ANTHROPIC_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-o' },
    fetch: fetchImpl,
  };
  const gateway = createGateway({
    env,
    idleTimeoutMs: 0,
    selection: { provider: 'openai', model: 'model-o' },
  });
  await gateway.start();

  const pinned = await gateway.dispatch({ sessionId: 'pin-1', agentId: 'ava', userMessage: 'hi' });
  // The default agent has no pins, so the gateway-wide selection applies.
  const unpinned = await gateway.dispatch({ sessionId: 'pin-2', userMessage: 'hi' });
  await gateway.stop();

  assert.match(pinned.messages.at(-1)?.content ?? '', /from anthropic/);
  assert.match(unpinned.messages.at(-1)?.content ?? '', /from openai/);
  assert.ok(urls.some((url) => url.includes('anthropic')));
});

test('the watchdog re-arms after a rejected tool call and still catches a stalled provider', async () => {
  const home = await newHome();
  // The streaming provider calls a tool that does not exist; the kernel
  // rejects it without executing anything. The rejection must still settle
  // the watchdog's pending-tool count — otherwise the timer stays
  // suspended, and the stalled second provider request below would hang
  // the turn (and gateway shutdown) forever.
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: anthropic\nmodel: model-a\n---\n\nYou are Ava.\n');

  let anthropicCalls = 0;
  const fetchImpl = ((url: unknown, init?: RequestInit) => {
    if (String(url).includes('anthropic')) {
      anthropicCalls += 1;
      if (anthropicCalls === 1) {
        return Promise.resolve(anthropicSseToolCall('no_such_tool', {}));
      }
      return new Promise((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new DOMException('aborted', 'AbortError'));
          return;
        }
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    }
    return Promise.resolve(openAiText('unused'));
  }) as typeof fetch;

  const env = { homeDir: home, cwd: home, processEnv: { ANTHROPIC_API_KEY: 'sk-a' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 200, warn: () => {} });
  await gateway.start();

  await assert.rejects(
    () => gateway.dispatch({ sessionId: 'rejected-tool-1', agentId: 'ava', userMessage: 'call something odd' }),
    (error: Error) => error instanceof RunAbortedError && /no activity/.test(error.message),
  );
  await gateway.stop();
  assert.equal(anthropicCalls, 2);
});

test('a soul provider pin beats the daemon environment defaults', async () => {
  const home = await newHome();
  // STRATUS_PROVIDER / STRATUS_MODEL inherited by the daemon's process are
  // defaults with the same standing as the gateway selection — a soul
  // pinned to another provider must not be routed through them.
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: anthropic\nmodel: model-a\n---\n\nYou are Ava.\n');

  const urls: string[] = [];
  const fetchImpl = (async (url: unknown) => {
    urls.push(String(url));
    if (String(url).includes('anthropic')) {
      return anthropicSseText('from anthropic');
    }
    return openAiText('from openai');
  }) as typeof fetch;

  const env = {
    homeDir: home,
    cwd: home,
    processEnv: {
      STRATUS_PROVIDER: 'openai',
      STRATUS_MODEL: 'model-env',
      ANTHROPIC_API_KEY: 'sk-a',
      OPENAI_API_KEY: 'sk-o',
    },
    fetch: fetchImpl,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();

  const pinned = await gateway.dispatch({ sessionId: 'env-pin-1', agentId: 'ava', userMessage: 'hi' });
  // The unpinned default agent still follows the environment default.
  const unpinned = await gateway.dispatch({ sessionId: 'env-pin-2', userMessage: 'hi' });
  await gateway.stop();

  assert.match(pinned.messages.at(-1)?.content ?? '', /from anthropic/);
  assert.match(unpinned.messages.at(-1)?.content ?? '', /from openai/);
  assert.ok(urls.some((url) => url.includes('anthropic')));
});

test('endpoint and generic credential defaults never ride along to a soul-pinned provider', async () => {
  const home = await newHome();
  // The daemon's defaults point at a custom OpenAI-compatible endpoint
  // with a generic key. Ava pins Anthropic: her requests must go to the
  // real Anthropic endpoint with her provider's credential — the default
  // base URL and generic key were chosen for a different service.
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: anthropic\nmodel: model-a\n---\n\nYou are Ava.\n');

  const urls: string[] = [];
  const fetchImpl = (async (url: unknown) => {
    urls.push(String(url));
    if (String(url).includes('api.anthropic.com')) {
      return anthropicSseText('anthropic answered');
    }
    return openAiText('local endpoint answered');
  }) as typeof fetch;

  const env = {
    homeDir: home,
    cwd: home,
    processEnv: {
      STRATUS_API_KEY: 'sk-generic',
      ANTHROPIC_API_KEY: 'sk-a',
      OPENAI_API_KEY: 'sk-o',
    },
    fetch: fetchImpl,
  };
  const gateway = createGateway({
    env,
    idleTimeoutMs: 0,
    selection: { provider: 'openai', baseUrl: 'http://localhost:9/v1' },
  });
  await gateway.start();

  const pinned = await gateway.dispatch({ sessionId: 'endpoint-pin-1', agentId: 'ava', userMessage: 'hi' });
  await gateway.stop();

  assert.match(pinned.messages.at(-1)?.content ?? '', /anthropic answered/);
  assert.ok(urls.every((url) => !url.includes('localhost')));
});

test('the watchdog arms when a streaming fallback takes over a non-streaming primary', async () => {
  const home = await newHome();
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  // The primary emits no deltas, so the turn starts with the watchdog
  // unarmed. When the primary fails and the Anthropic fallback takes over
  // mid-turn, the reset delta must arm it: a fallback stream that then
  // stalls has to be cut loose, not held open until an SDK timeout.
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({
    provider: 'openai',
    model: 'model-p',
    fallbackModel: 'model-f',
    fallbackProvider: 'anthropic',
  }));

  const fetchImpl = ((url: unknown, init?: RequestInit) => {
    if (String(url).includes('anthropic')) {
      return new Promise((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new DOMException('aborted', 'AbortError'));
          return;
        }
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    }
    return Promise.resolve(new Response(
      JSON.stringify({ error: { message: 'primary down' } }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    ));
  }) as typeof fetch;

  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { OPENAI_API_KEY: 'sk-o', ANTHROPIC_API_KEY: 'sk-a' },
    fetch: fetchImpl,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 300, warn: () => {} });
  await gateway.start();

  await assert.rejects(
    () => gateway.dispatch({ sessionId: 'arming-1', userMessage: 'hang after switching' }),
    (error: Error) => error instanceof RunAbortedError && /no activity/.test(error.message),
  );
  await gateway.stop();
});

test('a dispatch aborted during preflight never touches durable state', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();

  // The entry check runs first (microtask FIFO), then preflight awaits
  // filesystem work, then this abort fires — landing squarely between the
  // entry check and the runner. The recheck must catch it before any
  // session is created.
  const controller = new AbortController();
  const pending = gateway.dispatch({
    sessionId: 'preflight-abort-1',
    userMessage: 'never me',
    signal: controller.signal,
  });
  queueMicrotask(() => controller.abort());

  await assert.rejects(() => pending, (error: Error) => error instanceof RunAbortedError);
  const stored = await gateway.store.get('preflight-abort-1');
  await gateway.stop();
  assert.equal(stored, undefined);
});

test('an agentId-less dispatch answers as the configured default soul', async () => {
  const home = await newHome();
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  // What `stratus setup` writes: a default soul outside the roster dir.
  await writeFile(path.join(home, 'nova.md'), '---\nname: Nova\n---\n\nYou are Nova, precise and quick.\n');
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ soul: 'nova.md' }));

  const env = { homeDir: home, cwd: home, processEnv: {} };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();

  // The default soul is part of the visible roster.
  assert.ok(gateway.agents().some((agent) => agent.name === 'Nova'), 'the default soul must appear in agents()');

  // No agentId: the turn runs AS Nova — identity, not just provider config.
  const session = await gateway.dispatch({ sessionId: 'default-soul-1', userMessage: 'hello' });
  await gateway.stop();

  assert.equal(session.agent.name, 'Nova');
  assert.notEqual(session.agent.id, 'stratus');
  assert.equal(session.status, 'completed');
});

test('a config-only default soul keeps its provider pin over the gateway selection', async () => {
  const home = await newHome();
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  // The default soul lives outside the roster dir and pins Anthropic; the
  // gateway was started with an OpenAI-wide default. The pin must win.
  await writeFile(path.join(home, 'nova.md'), '---\nname: Nova\nprovider: anthropic\nmodel: model-a\n---\n\nYou are Nova.\n');
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ soul: 'nova.md' }));

  const urls: string[] = [];
  const fetchImpl = (async (url: unknown) => {
    urls.push(String(url));
    if (String(url).includes('anthropic')) {
      return anthropicSseText('nova on anthropic');
    }
    return openAiText('wrong provider');
  }) as typeof fetch;

  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { ANTHROPIC_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-o' },
    fetch: fetchImpl,
  };
  const gateway = createGateway({
    env,
    idleTimeoutMs: 0,
    selection: { provider: 'openai', model: 'model-o' },
  });
  await gateway.start();
  const session = await gateway.dispatch({ sessionId: 'config-soul-pin-1', userMessage: 'hi' });
  await gateway.stop();

  assert.equal(session.agent.name, 'Nova');
  assert.match(session.messages.at(-1)?.content ?? '', /nova on anthropic/);
  assert.ok(urls.every((url) => !url.includes('openai')));
});

test('a roster-backed default soul keeps its soulPath (and its pins) when registered as default', async () => {
  const home = await newHome();
  // The normal setup layout: the default soul IS a roster soul. Its
  // registration as the default must not shed the soulPath that drives
  // per-dispatch refresh and pin demotion.
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: anthropic\nmodel: model-a\n---\n\nYou are Ava.\n');
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ soul: '.stratus/agents/ava.md' }));

  const urls: string[] = [];
  const fetchImpl = (async (url: unknown) => {
    urls.push(String(url));
    if (String(url).includes('anthropic')) {
      return anthropicSseText('ava on anthropic');
    }
    return openAiText('wrong provider');
  }) as typeof fetch;

  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { ANTHROPIC_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-o' },
    fetch: fetchImpl,
  };
  const gateway = createGateway({
    env,
    idleTimeoutMs: 0,
    selection: { provider: 'openai', model: 'model-o' },
  });
  await gateway.start();
  const session = await gateway.dispatch({ sessionId: 'roster-default-1', userMessage: 'hi' });
  await gateway.stop();

  assert.equal(session.agent.name, 'Ava');
  assert.match(session.messages.at(-1)?.content ?? '', /ava on anthropic/);
  assert.ok(urls.every((url) => !url.includes('openai')));
});

test('an agentId-less session resumes with its stored agent after the default soul changes', async () => {
  const home = await newHome();
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, 'nova.md'), '---\nname: Nova\n---\n\nYou are Nova.\n');
  await writeFile(path.join(home, 'mira.md'), '---\nname: Mira\n---\n\nYou are Mira.\n');
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ soul: 'nova.md' }));

  const env = { homeDir: home, cwd: home, processEnv: {} };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();

  const opened = await gateway.dispatch({ sessionId: 'sticky-default-1', userMessage: 'hello' });
  assert.equal(opened.agent.name, 'Nova');

  // The operator repoints the default soul mid-flight. The existing
  // conversation keeps its pinned agent; a NEW session takes the new one.
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ soul: 'mira.md' }));

  const resumed = await gateway.dispatch({ sessionId: 'sticky-default-1', userMessage: 'still you?' });
  const fresh = await gateway.dispatch({ sessionId: 'sticky-default-2', userMessage: 'hello' });
  await gateway.stop();

  assert.equal(resumed.agent.name, 'Nova');
  assert.equal(resumed.status, 'completed');
  assert.equal(
    resumed.messages.filter((m) => m.role === 'user').length,
    2,
    'the conversation must continue, not restart',
  );
  assert.equal(fresh.agent.name, 'Mira');
});

test('an edited config-only default soul reaches resumed sessions on their next turn', async () => {
  const home = await newHome();
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, 'nova.md'), '---\nname: Nova\n---\n\nYou are Nova, mark one.\n');
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ soul: 'nova.md' }));

  const env = { homeDir: home, cwd: home, processEnv: {} };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();

  const opened = await gateway.dispatch({ sessionId: 'edited-default-1', userMessage: 'hello' });
  assert.match(opened.agent.instructions ?? '', /mark one/);

  // Edit the soul in place (same identity). The next turn of the SAME
  // session must run with the new persona — a config-only soul refreshes
  // per dispatch exactly like a roster soul.
  await writeFile(path.join(home, 'nova.md'), '---\nname: Nova\n---\n\nYou are Nova, mark two.\n');
  const resumed = await gateway.dispatch({ sessionId: 'edited-default-1', userMessage: 'and now?' });
  await gateway.stop();

  assert.equal(resumed.agent.name, 'Nova');
  assert.match(resumed.agent.instructions ?? '', /mark two/);
});

test('a soul file reassigned to a different agent id refuses dispatches for the old id', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');

  const fetchImpl = (async () => openAiText('hi from ava')) as typeof fetch;
  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0, warn: () => {} });
  await gateway.start();

  const opened = await gateway.dispatch({ sessionId: 'reassigned-1', agentId: 'ava', userMessage: 'hello' });
  assert.equal(opened.status, 'completed');

  // The operator rewrites the file as a different agent. Ava's sessions
  // must not silently run on Zed's provider pins — the dispatch refuses
  // with a clear error instead.
  await writeSoul(home, 'ava.md', '---\nname: Zed\nprovider: anthropic\nmodel: model-z\n---\n\nYou are Zed.\n');
  await assert.rejects(
    () => gateway.dispatch({ sessionId: 'reassigned-1', agentId: 'ava', userMessage: 'still ava?' }),
    /now declares agent .*not ava/,
  );

  // Restoring the identity restores service.
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava again.\n');
  const recovered = await gateway.dispatch({ sessionId: 'reassigned-1', agentId: 'ava', userMessage: 'back?' });
  await gateway.stop();
  assert.equal(recovered.status, 'completed');
});

test('a temporarily unreadable soul degrades to the cached definition and pins', async () => {
  const { unlink } = await import('node:fs/promises');
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  // A configured default soul with its own model: Ava's degraded
  // resolution must not fall back to it.
  await writeFile(path.join(home, 'nova.md'), '---\nname: Nova\nprovider: openai\nmodel: model-nova\n---\n\nYou are Nova.\n');
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ soul: 'nova.md' }));

  const requestedModels: string[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string };
    requestedModels.push(body.model);
    return openAiText(`reply from ${body.model}`);
  }) as typeof fetch;

  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0, warn: () => {} });
  await gateway.start();

  const first = await gateway.dispatch({ sessionId: 'degraded-1', agentId: 'ava', userMessage: 'hello' });
  assert.equal(first.status, 'completed');

  // The soul file vanishes mid-flight (partial edit, sync glitch): the
  // agent keeps serving from cache instead of failing every dispatch.
  await unlink(path.join(home, '.stratus', 'agents', 'ava.md'));
  const degraded = await gateway.dispatch({ sessionId: 'degraded-1', agentId: 'ava', userMessage: 'still here?' });
  await gateway.stop();

  assert.equal(degraded.status, 'completed');
  assert.equal(degraded.agent.name, 'Ava');
  // Both turns ran on Ava's own cached model — never the default soul's.
  assert.deepEqual(requestedModels, ['model-a', 'model-a']);
});

test('the watchdog observes activity ahead of slow external event consumers', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', [
    '---', 'name: Ava', 'provider: anthropic', 'model: model-a',
    'tools:', '  - agent.delegate', '---', '', 'You are Ava.', '',
  ].join('\n'));
  await writeSoul(home, 'bea.md', '---\nname: Bea\nprovider: openai\nmodel: model-b\n---\n\nYou are Bea.\n');

  let anthropicCalls = 0;
  const fetchImpl = (async (url: unknown) => {
    if (String(url).includes('anthropic')) {
      anthropicCalls += 1;
      return anthropicCalls === 1
        ? anthropicSseToolCall('agent_delegate', { agent: 'bea', prompt: 'quick task' })
        : anthropicSseText('all done');
    }
    return openAiText('bea done');
  }) as typeof fetch;

  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { ANTHROPIC_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-o' },
    fetch: fetchImpl,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 300, warn: () => {} });
  await gateway.start();

  // An external consumer (think: a throttled channel edit) that takes
  // longer than the idle timeout to process provider.response. Emission
  // awaits subscribers in order — the watchdog must observe (and suspend)
  // BEFORE this consumer blocks the chain, or a healthy turn dies.
  gateway.bus.subscribe(async (event) => {
    if (event.type === 'provider.response') {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  });

  const session = await gateway.dispatch({ sessionId: 'slow-consumer-1', agentId: 'ava', userMessage: 'delegate it' });
  await gateway.stop();

  assert.equal(session.status, 'completed');
  assert.match(session.messages.at(-1)?.content ?? '', /all done/);
});

test('a pinless cached soul never inherits the default soul\'s pins while unreadable', async () => {
  const { unlink } = await import('node:fs/promises');
  const home = await newHome();
  // Ava has NO provider/model pins; the configured default soul does.
  await writeSoul(home, 'ava.md', '---\nname: Ava\n---\n\nYou are Ava.\n');
  await writeFile(path.join(home, 'nova.md'), '---\nname: Nova\nprovider: openai\nmodel: model-nova\n---\n\nYou are Nova.\n');
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ soul: 'nova.md' }));

  const requestedModels: string[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string };
    requestedModels.push(body.model);
    return openAiText('should not be called for ava');
  }) as typeof fetch;

  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0, warn: () => {} });
  await gateway.start();

  const first = await gateway.dispatch({ sessionId: 'pinless-1', agentId: 'ava', userMessage: 'hello' });
  assert.equal(first.status, 'completed');

  await unlink(path.join(home, '.stratus', 'agents', 'ava.md'));
  const degraded = await gateway.dispatch({ sessionId: 'pinless-1', agentId: 'ava', userMessage: 'still?' });
  await gateway.stop();

  assert.equal(degraded.status, 'completed');
  assert.equal(degraded.agent.name, 'Ava');
  // A pinless soul resolves the same way readable or not — and NEVER
  // through the default soul's provider/model.
  assert.ok(!requestedModels.includes('model-nova'), `default soul pins leaked: ${JSON.stringify(requestedModels)}`);
});

test('repointing the default soul to a new file with the same id takes effect', async () => {
  const home = await newHome();
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, 'nova.md'), '---\nname: Nova\n---\n\nYou are Nova, mark one.\n');
  await writeFile(path.join(home, 'nova-v2.md'), '---\nname: Nova\n---\n\nYou are Nova, mark two.\n');
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ soul: 'nova.md' }));

  const env = { homeDir: home, cwd: home, processEnv: {} };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();

  const opened = await gateway.dispatch({ sessionId: 'repoint-1', userMessage: 'hello' });
  assert.match(opened.agent.instructions ?? '', /mark one/);

  // A replacement file, same identity: the source must follow the new
  // path instead of silently refreshing the old one forever.
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ soul: 'nova-v2.md' }));
  const fresh = await gateway.dispatch({ sessionId: 'repoint-2', userMessage: 'hello again' });
  await gateway.stop();

  assert.match(fresh.agent.instructions ?? '', /mark two/);
});

test('the watchdog does not tick while slow delta consumers process a healthy stream', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: anthropic\nmodel: model-a\n---\n\nYou are Ava.\n');

  const fetchImpl = (async (url: unknown) => {
    if (String(url).includes('anthropic')) {
      return anthropicSseText('healthy but slowly consumed');
    }
    return openAiText('unused');
  }) as typeof fetch;

  const env = { homeDir: home, cwd: home, processEnv: { ANTHROPIC_API_KEY: 'sk-a' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 300, warn: () => {} });
  await gateway.start();

  // A throttled consumer that takes longer than the idle timeout per
  // delta. The provider awaits the sink (backpressure), so no further
  // delta can arrive until this finishes — that elapsed time is consumer
  // time, not provider silence, and must not be counted against the turn.
  gateway.bus.subscribe(async (event) => {
    if (event.type === 'provider.delta') {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  });

  const session = await gateway.dispatch({ sessionId: 'slow-delta-1', agentId: 'ava', userMessage: 'stream it' });
  await gateway.stop();

  assert.equal(session.status, 'completed');
  assert.match(session.messages.at(-1)?.content ?? '', /healthy but slowly consumed/);
});

test('the gateway starts when daemon defaults lack credentials the default soul does not need', async () => {
  const home = await newHome();
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeSoul(home, 'roster-bea.md', '---\nname: Bea\nprovider: anthropic\nmodel: model-b\n---\n\nYou are Bea.\n');
  // The default soul pins Anthropic; the daemon-wide default says OpenAI —
  // and only Anthropic credentials are installed. Startup must not fail
  // on the OpenAI key the soul never needed.
  await writeFile(path.join(home, 'nova.md'), '---\nname: Nova\nprovider: anthropic\nmodel: model-n\n---\n\nYou are Nova.\n');
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ soul: 'nova.md' }));

  const fetchImpl = (async (url: unknown) => {
    if (String(url).includes('anthropic')) {
      return anthropicSseText('nova on anthropic');
    }
    return openAiText('unexpected provider');
  }) as typeof fetch;

  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { ANTHROPIC_API_KEY: 'sk-a' },
    fetch: fetchImpl,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 0, selection: { provider: 'openai' } });

  // Previously this threw "Missing API key" out of loadRoster.
  await gateway.start();
  assert.ok(gateway.agents().some((agent) => agent.name === 'Nova'));

  // The default route runs on the soul's own provider...
  const viaDefault = await gateway.dispatch({ sessionId: 'start-degrade-1', userMessage: 'hi' });
  assert.equal(viaDefault.agent.name, 'Nova');
  assert.match(viaDefault.messages.at(-1)?.content ?? '', /nova on anthropic/);

  // ...and explicit roster agents were never held hostage by the default.
  const viaRoster = await gateway.dispatch({ sessionId: 'start-degrade-2', agentId: 'bea', userMessage: 'hi' });
  await gateway.stop();
  assert.equal(viaRoster.status, 'completed');
});

test('an unreadable default soul path degrades startup instead of failing it', async () => {
  const home = await newHome();
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ soul: 'missing.md' }));

  const warnings: string[] = [];
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const gateway = createGateway({ env, idleTimeoutMs: 0, warn: (line) => warnings.push(line) });
  await gateway.start();

  // The default route falls back to the built-in agent, with a warning.
  const session = await gateway.dispatch({ sessionId: 'missing-default-1', userMessage: 'hello' });
  await gateway.stop();

  assert.equal(session.status, 'completed');
  assert.equal(session.agent.id, 'stratus');
  assert.ok(warnings.some((line) => line.includes('default soul')), `expected a default-soul warning, got ${JSON.stringify(warnings)}`);
});

test('a malformed config.json degrades dispatches instead of failing them', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ soul: 'nova.md' }));
  await writeFile(path.join(home, 'nova.md'), '---\nname: Nova\n---\n\nYou are Nova.\n');

  const fetchImpl = (async () => openAiText('ava fine')) as typeof fetch;
  const warnings: string[] = [];
  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0, warn: (line) => warnings.push(line) });
  await gateway.start();

  const healthy = await gateway.dispatch({ sessionId: 'cfg-degrade-0', userMessage: 'hi' });
  assert.equal(healthy.agent.name, 'Nova');

  // The operator saves config.json mid-edit: invalid JSON. The daemon
  // keeps serving — roster agents from their own pins, the default route
  // from its cached source — with a warning, not a dead gateway.
  await writeFile(path.join(home, '.stratus', 'config.json'), '{ "soul": ');

  const roster = await gateway.dispatch({ sessionId: 'cfg-degrade-1', agentId: 'ava', userMessage: 'hi' });
  assert.equal(roster.status, 'completed');
  assert.match(roster.messages.at(-1)?.content ?? '', /ava fine/);

  const viaDefault = await gateway.dispatch({ sessionId: 'cfg-degrade-2', userMessage: 'hi' });
  await gateway.stop();
  assert.equal(viaDefault.status, 'completed');
  assert.equal(viaDefault.agent.name, 'Nova');
  assert.ok(warnings.some((line) => line.includes('config')), `expected a config warning, got ${JSON.stringify(warnings)}`);
});

test('generic credentials survive when the soul pins the config-file provider', async () => {
  const home = await newHome();
  // The daemon default comes ONLY from the config file, and the soul pins
  // that same provider. The generic key installed for it must survive.
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: anthropic\nmodel: model-a\n---\n\nYou are Ava.\n');
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'anthropic' }));

  const authHeaders: string[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? {});
    authHeaders.push(headers.get('x-api-key') ?? '');
    if (String(url).includes('anthropic')) {
      return anthropicSseText('ava with the generic key');
    }
    return openAiText('unexpected');
  }) as typeof fetch;

  const env = {
    homeDir: home,
    cwd: home,
    processEnv: { STRATUS_API_KEY: 'sk-generic' },
    fetch: fetchImpl,
  };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();

  // Previously this failed with "Missing API key": no selection/env
  // provider default meant the scrub always fired.
  const session = await gateway.dispatch({ sessionId: 'cfg-provider-1', agentId: 'ava', userMessage: 'hi' });
  await gateway.stop();

  assert.equal(session.status, 'completed');
  assert.match(session.messages.at(-1)?.content ?? '', /ava with the generic key/);
  assert.ok(authHeaders.some((header) => header === 'sk-generic'));
});
