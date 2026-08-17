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
