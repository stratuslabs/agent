import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sessionTrustOf, workItemState } from '@stratusagent/core';
import { createGateway } from '../src/index.ts';

// Card 423: messages that arrive while a session's turn is running are
// answered by ONE next turn, not one turn each. No debounce: the batch is
// whatever queued by the time the running turn ends.

const newHome = async (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'stratus-merge-'));

const openAiText = (text: string): Response =>
  new Response(
    JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

/** A provider whose first call waits for `release`, recording every prompt's last user message. */
const gatedProvider = () => {
  const prompts: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
    const last = body.messages.filter((message) => message.role === 'user').at(-1)?.content ?? '';
    prompts.push(last);
    if (prompts.length === 1) {
      started();
      await gate;
    }
    return openAiText(`answer ${prompts.length}`);
  }) as typeof fetch;
  return { prompts, fetchImpl, release, running };
};

const startGateway = async (fetchImpl: typeof fetch) => {
  const home = await newHome();
  const dir = path.join(home, '.stratus', 'agents');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'ava.md'), '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();
  return gateway;
};

test('messages queued behind a running turn are answered by one merged turn, at the lowest trust among them', async () => {
  const provider = gatedProvider();
  const gateway = await startGateway(provider.fetchImpl);
  const absorbed: string[] = [];

  const first = gateway.dispatch({ sessionId: 'm-1', agentId: 'ava', userMessage: 'Dylan: first', idempotencyKey: 'k1', onAbsorbed: () => absorbed.push('k1') });
  await provider.running;
  const second = gateway.dispatch({
    sessionId: 'm-1', agentId: 'ava', userMessage: 'Dylan: second', idempotencyKey: 'k2', turnId: 't2',
    metadata: { senderTrust: 'user' }, onAbsorbed: () => absorbed.push('k2'),
  });
  const third = gateway.dispatch({
    sessionId: 'm-1', agentId: 'ava', userMessage: 'Stranger: third', idempotencyKey: 'k3', turnId: 't3',
    metadata: { senderTrust: 'external' }, onAbsorbed: () => absorbed.push('k3'),
  });
  provider.release();
  await first;
  const [two, three] = await Promise.all([second, third]);

  // One turn for the two queued messages, and it saw both, in order.
  assert.equal(provider.prompts.length, 2);
  assert.match(provider.prompts[1] ?? '', /Dylan: second\n\nStranger: third/);
  // The first queued message leads; the later one was absorbed into it.
  assert.deepEqual(absorbed, ['k3']);
  assert.equal(two.id, three.id);
  const users = three.messages.filter((message) => message.role === 'user');
  assert.equal(users.length, 2);
  assert.equal(users[1]?.idempotencyKey, 'k2');
  assert.deepEqual(users[1]?.absorbedKeys, ['k3']);
  // The stranger's words are in the turn, so the session is at their trust.
  assert.equal(sessionTrustOf(three), 'external');
  assert.equal(workItemState(three, 'k3'), 'finished');

  // A redelivery of the absorbed message runs nothing: it was answered.
  let repeat: string | undefined;
  await gateway.dispatch({ sessionId: 'm-1', agentId: 'ava', userMessage: 'Stranger: third', idempotencyKey: 'k3', onAbsorbed: () => {}, onRepeat: (kind) => { repeat = kind; } });
  assert.equal(repeat, 'finished');
  assert.equal(provider.prompts.length, 2);
  await gateway.stop();
});

test('a caller that cannot withdraw a reply is never merged: one turn per dispatch, as before', async () => {
  const provider = gatedProvider();
  const gateway = await startGateway(provider.fetchImpl);

  const first = gateway.dispatch({ sessionId: 'm-2', agentId: 'ava', userMessage: 'first' });
  await provider.running;
  const second = gateway.dispatch({ sessionId: 'm-2', agentId: 'ava', userMessage: 'second' });
  const third = gateway.dispatch({ sessionId: 'm-2', agentId: 'ava', userMessage: 'third' });
  provider.release();
  await Promise.all([first, second, third]);
  assert.equal(provider.prompts.length, 3);
  await gateway.stop();
});

test('a turn nobody asked for is not merged into an addressed one', async () => {
  const provider = gatedProvider();
  const gateway = await startGateway(provider.fetchImpl);

  const first = gateway.dispatch({ sessionId: 'm-3', agentId: 'ava', userMessage: 'first', onAbsorbed: () => {} });
  await provider.running;
  const addressed = gateway.dispatch({ sessionId: 'm-3', agentId: 'ava', userMessage: 'to you', onAbsorbed: () => {} });
  const overheard = gateway.dispatch({ sessionId: 'm-3', agentId: 'ava', userMessage: 'to someone else', addressed: false, onAbsorbed: () => {} });
  provider.release();
  await Promise.all([first, addressed, overheard]);
  assert.equal(provider.prompts.length, 3);
  await gateway.stop();
});

test('a queued message cancelled before the merged turn starts is left out of it', async () => {
  const provider = gatedProvider();
  const gateway = await startGateway(provider.fetchImpl);

  const first = gateway.dispatch({ sessionId: 'm-4', agentId: 'ava', userMessage: 'first', onAbsorbed: () => {} });
  await provider.running;
  const cancel = new AbortController();
  const kept = gateway.dispatch({ sessionId: 'm-4', agentId: 'ava', userMessage: 'kept', idempotencyKey: 'a', onAbsorbed: () => {} });
  const dropped = assert.rejects(gateway.dispatch({ sessionId: 'm-4', agentId: 'ava', userMessage: 'dropped', idempotencyKey: 'b', signal: cancel.signal, onAbsorbed: () => {} }));
  cancel.abort();
  provider.release();
  await first;
  const session = await kept;
  await dropped;
  assert.equal(provider.prompts.length, 2);
  assert.equal(provider.prompts[1], 'kept');
  assert.equal(workItemState(session, 'b'), undefined);
  await gateway.stop();
});

test('a message overheard after a batch opened closes it, so nothing said later is answered ahead of it', async () => {
  const provider = gatedProvider();
  const gateway = await startGateway(provider.fetchImpl);
  const absorbed: string[] = [];

  const first = gateway.dispatch({ sessionId: 'm-5', agentId: 'ava', userMessage: 'first', onAbsorbed: () => {} });
  await provider.running;
  const leader = gateway.dispatch({ sessionId: 'm-5', agentId: 'ava', userMessage: 'second', onAbsorbed: () => absorbed.push('second') });
  const heard = gateway.observe({ sessionId: 'm-5', agentId: 'ava', message: 'Bea: overheard' });
  const later = gateway.dispatch({ sessionId: 'm-5', agentId: 'ava', userMessage: 'third', onAbsorbed: () => absorbed.push('third') });
  provider.release();
  await Promise.all([first, leader, heard]);
  const session = await later;
  assert.deepEqual(absorbed, []);
  assert.deepEqual(provider.prompts, ['first', 'second', 'third']);
  const users = session.messages.filter((message) => message.role === 'user').map((message) => message.content);
  assert.deepEqual(users, ['first', 'second', 'Bea: overheard', 'third']);
  await gateway.stop();
});
