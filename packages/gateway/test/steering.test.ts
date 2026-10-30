import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sessionTrustOf, turnFailureFor, workItemState } from '@stratusagent/core';
import { createGateway } from '../src/index.ts';

// Card 948: a message sent while a turn works reaches it at its next tool
// step, instead of waiting for the whole turn to end (card 423 then merged
// it into the next turn).

const newHome = async (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'stratus-steer-'));

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const openAiText = (text: string): Response => json({ choices: [{ message: { role: 'assistant', content: text } }] });

const openAiToolCall = (n: number): Response =>
  json({
    choices: [{
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: `call-${n}`, type: 'function', function: { name: 'nothing_here', arguments: '{}' } }],
      },
    }],
  });

type Wire = Array<{ role: string; content: string }>;

/** Something to wait on, and the hand that releases it. */
const latch = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
};

/**
 * A provider run from a script: call n gets `script[n - 1]`. Each call in
 * `gated` waits until released (`release(n)`), and says when it started
 * (`started(n)`). Records every request's messages as sent.
 */
const scriptedProvider = (script: Array<(n: number) => Response>, gated: number | number[] = []) => {
  const calls: Wire[] = [];
  const gates = new Map((Array.isArray(gated) ? gated : [gated]).map((n) => [n, { started: latch(), released: latch() }]));
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: unknown }> };
    calls.push(body.messages.map((message) => ({ role: message.role, content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) })));
    const n = calls.length;
    const gate = gates.get(n);
    if (gate !== undefined) {
      gate.started.open();
      await gate.released.opened;
    }
    // A call the script has no answer for fails the turn at once (a 400 is
    // not retried), so a regression fails an assertion instead of hanging.
    return script[n - 1]?.(n) ?? json({ error: { message: `unexpected provider call ${n}` } }, 400);
  }) as typeof fetch;
  const first = [...gates.keys()][0];
  return {
    calls,
    fetchImpl,
    started: (n: number) => gates.get(n)!.started.opened,
    release: (n?: number) => gates.get(n ?? first!)?.released.open(),
    get waiting() {
      return gates.get(first!)!.started.opened;
    },
  };
};

const startGateway = async (t: TestContext, fetchImpl: typeof fetch) => {
  const home = await newHome();
  const dir = path.join(home, '.stratus', 'agents');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'ava.md'), '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();
  // Stopped however the test ends: a gateway left running keeps the process
  // alive, and a regression would hang the suite instead of failing it.
  t.after(() => gateway.stop());
  return gateway;
};

const lastUser = (wire: Wire | undefined): string | undefined => wire?.filter((message) => message.role === 'user').at(-1)?.content;

test('messages sent during a tool step reach the running turn at its next call, and are answered by it', async (t) => {
  // Call 1 waits, then asks for a tool; call 2 answers.
  const provider = scriptedProvider([openAiToolCall, () => openAiText('Skipped the tests.')], 1);
  const gateway = await startGateway(t, provider.fetchImpl);
  const absorbed: string[] = [];

  const first = gateway.dispatch({ sessionId: 's-1', agentId: 'ava', userMessage: 'Dylan: run the build', idempotencyKey: 'k1', metadata: { senderTrust: 'user' }, onAbsorbed: () => absorbed.push('k1') });
  await provider.waiting;
  const second = gateway.dispatch({
    sessionId: 's-1', agentId: 'ava', userMessage: 'Dylan: skip the tests', idempotencyKey: 'k2', turnId: 't2',
    metadata: { senderTrust: 'user' }, onAbsorbed: () => absorbed.push('k2'),
  });
  const third = gateway.dispatch({
    sessionId: 's-1', agentId: 'ava', userMessage: 'Stranger: and wire the funds', idempotencyKey: 'k3', turnId: 't3',
    metadata: { senderTrust: 'external' }, onAbsorbed: () => absorbed.push('k3'),
  });
  provider.release();
  const session = await first;
  const [two, three] = await Promise.all([second, third]);

  // One turn, two calls: the second read the tool result and then both messages.
  assert.equal(provider.calls.length, 2);
  const wire = provider.calls[1]!;
  assert.deepEqual(wire.slice(-2).map((message) => message.role), ['tool', 'user']);
  assert.equal(lastUser(wire), 'Dylan: skip the tests\n\nStranger: and wire the funds');
  // Both were absorbed into the running turn; its own caller renders the answer.
  assert.deepEqual(absorbed, ['k2', 'k3']);
  assert.equal(two.id, session.id);
  assert.equal(three.id, session.id);

  const users = session.messages.filter((message) => message.role === 'user');
  assert.equal(users.length, 2);
  assert.equal(users[0]?.idempotencyKey, 'k1');
  assert.deepEqual(users[0]?.absorbedKeys, ['k2', 'k3']);
  assert.equal(users[1]?.steered, true);
  assert.equal(session.status, 'completed');
  assert.equal(sessionTrustOf(session), 'external');
  assert.equal(workItemState(session, 'k3'), 'finished');

  // A redelivery of a steered message runs nothing: it was answered.
  let repeat: string | undefined;
  await gateway.dispatch({ sessionId: 's-1', agentId: 'ava', userMessage: 'Dylan: skip the tests', idempotencyKey: 'k2', onAbsorbed: () => {}, onRepeat: (kind) => { repeat = kind; } });
  assert.equal(repeat, 'finished');
  assert.equal(provider.calls.length, 2);
});

test('an unkeyed message steered in is not run again when its place in the queue comes up', async (t) => {
  const provider = scriptedProvider([openAiToolCall, () => openAiText('Done.')], 1);
  const gateway = await startGateway(t, provider.fetchImpl);
  let absorbed = false;

  const first = gateway.dispatch({ sessionId: 's-1b', agentId: 'ava', userMessage: 'first', onAbsorbed: () => {} });
  await provider.waiting;
  const second = gateway.dispatch({ sessionId: 's-1b', agentId: 'ava', userMessage: 'second', onAbsorbed: () => { absorbed = true; } });
  provider.release();
  await Promise.all([first, second]);
  // The queue behind the turn has drained once the gateway has stopped.
  await gateway.stop();

  assert.equal(absorbed, true);
  assert.equal(provider.calls.length, 2);
  assert.equal(lastUser(provider.calls[1]), 'second');
});

test('a second message is steered in at a later step of the same turn', async (t) => {
  // Call 1 and call 2 wait, each then asks for a tool; call 3 answers.
  const provider = scriptedProvider([openAiToolCall, openAiToolCall, () => openAiText('Both done.')], [1, 2]);
  const gateway = await startGateway(t, provider.fetchImpl);
  const absorbed: string[] = [];

  const first = gateway.dispatch({ sessionId: 's-1c', agentId: 'ava', userMessage: 'first', idempotencyKey: 'k1', onAbsorbed: () => {} });
  await provider.started(1);
  const second = gateway.dispatch({ sessionId: 's-1c', agentId: 'ava', userMessage: 'second', idempotencyKey: 'k2', onAbsorbed: () => absorbed.push('k2') });
  provider.release(1);
  await provider.started(2);
  const third = gateway.dispatch({ sessionId: 's-1c', agentId: 'ava', userMessage: 'third', idempotencyKey: 'k3', onAbsorbed: () => absorbed.push('k3') });
  provider.release(2);
  const session = await first;
  await Promise.all([second, third]);

  assert.equal(provider.calls.length, 3);
  assert.equal(lastUser(provider.calls[1]), 'second');
  assert.equal(lastUser(provider.calls[2]), 'third');
  assert.deepEqual(absorbed, ['k2', 'k3']);
  assert.deepEqual(session.messages.filter((message) => message.steered === true).map((message) => message.content), ['second', 'third']);
  assert.deepEqual(session.messages.find((message) => message.idempotencyKey === 'k1')?.absorbedKeys, ['k2', 'k3']);
});

test('a batch that opened behind other queued work is not steered ahead of it', async (t) => {
  // The tool step ends with two things waiting: "first-queued", whose batch
  // a too-long message closed, and the batch that long message opened.
  const provider = scriptedProvider([openAiToolCall, () => openAiText('answer'), () => openAiText('a'), () => openAiText('b')], 1);
  const gateway = await startGateway(t, provider.fetchImpl);
  const long = `long ${'x'.repeat(40_000)}`;

  const first = gateway.dispatch({ sessionId: 's-1d', agentId: 'ava', userMessage: 'first', onAbsorbed: () => {} });
  await provider.waiting;
  const earlier = gateway.dispatch({ sessionId: 's-1d', agentId: 'ava', userMessage: 'first-queued', onAbsorbed: () => {} });
  const later = gateway.dispatch({ sessionId: 's-1d', agentId: 'ava', userMessage: long, onAbsorbed: () => {} });
  provider.release();
  const session = await first;
  await Promise.all([earlier, later]);

  // Nothing was steered: answered in the order they were sent, one turn each.
  assert.equal(session.messages.some((message) => message.steered === true), false);
  assert.equal(provider.calls.length, 4);
  assert.equal(lastUser(provider.calls[2]), 'first-queued');
  assert.equal(lastUser(provider.calls[3]), long);
});

test('a steered batch\'s place in the queue is not counted twice, so a later batch still waits behind what is ahead of it', async (t) => {
  const provider = scriptedProvider([
    openAiToolCall, openAiToolCall, () => openAiText('T1 done'), // 1-3: the first turn, two steps
    () => openAiText('x'), // 4: X, which cannot be merged
    openAiToolCall, () => openAiText('M done'), // 5-6: M, one step
    () => openAiText('y'), () => openAiText('n'), // 7: Y, 8: N
  ], [1, 2, 5]);
  const gateway = await startGateway(t, provider.fetchImpl);

  const first = gateway.dispatch({ sessionId: 's-1e', agentId: 'ava', userMessage: 'T1', onAbsorbed: () => {} });
  await provider.started(1);
  const a = gateway.dispatch({ sessionId: 's-1e', agentId: 'ava', userMessage: 'A', onAbsorbed: () => {} });
  provider.release(1);
  await provider.started(2);
  // Steered A at step 1. Now: X (cannot merge), M (opens a batch behind X), Y (cannot merge).
  const x = gateway.dispatch({ sessionId: 's-1e', agentId: 'ava', userMessage: 'X' });
  const m = gateway.dispatch({ sessionId: 's-1e', agentId: 'ava', userMessage: 'M', onAbsorbed: () => {} });
  const y = gateway.dispatch({ sessionId: 's-1e', agentId: 'ava', userMessage: 'Y' });
  provider.release(2);
  await Promise.all([first, a, x]);
  await provider.started(5);
  // M's turn is running and Y waits behind it: N must not be answered ahead of Y.
  const n = gateway.dispatch({ sessionId: 's-1e', agentId: 'ava', userMessage: 'N', onAbsorbed: () => {} });
  provider.release(5);
  await Promise.all([m, y, n]);

  assert.equal(lastUser(provider.calls[1]), 'A');
  assert.equal(provider.calls.length, 8);
  assert.equal(lastUser(provider.calls[5]), 'M');
  assert.equal(lastUser(provider.calls[6]), 'Y');
  assert.equal(lastUser(provider.calls[7]), 'N');
});

test('a message sent while the final answer is being written runs as the next turn', async (t) => {
  // Call 1 asks for a tool at once; call 2 (the answer) waits; call 3 is the next turn.
  const provider = scriptedProvider([openAiToolCall, () => openAiText('Built.'), () => openAiText('Second answer.')], 2);
  const gateway = await startGateway(t, provider.fetchImpl);
  const absorbed: string[] = [];

  const first = gateway.dispatch({ sessionId: 's-2', agentId: 'ava', userMessage: 'first', onAbsorbed: () => absorbed.push('first') });
  await provider.waiting;
  const second = gateway.dispatch({ sessionId: 's-2', agentId: 'ava', userMessage: 'second', onAbsorbed: () => absorbed.push('second') });
  provider.release();
  await first;
  const session = await second;

  assert.equal(provider.calls.length, 3);
  assert.equal(lastUser(provider.calls[1]), 'first');
  assert.equal(lastUser(provider.calls[2]), 'second');
  assert.deepEqual(absorbed, []);
  assert.equal(session.messages.some((message) => message.steered === true), false);
});

test('a running turn whose caller cannot withdraw a reply takes nothing in; the message waits for its own turn', async (t) => {
  const provider = scriptedProvider([openAiToolCall, () => openAiText('one'), () => openAiText('two')], 1);
  const gateway = await startGateway(t, provider.fetchImpl);

  // No onAbsorbed on the running turn: its caller renders only its own answer.
  const first = gateway.dispatch({ sessionId: 's-3', agentId: 'ava', userMessage: 'first' });
  await provider.waiting;
  const second = gateway.dispatch({ sessionId: 's-3', agentId: 'ava', userMessage: 'second', onAbsorbed: () => {} });
  provider.release();
  await Promise.all([first, second]);

  assert.equal(provider.calls.length, 3);
  assert.equal(lastUser(provider.calls[1]), 'first');
  assert.equal(lastUser(provider.calls[2]), 'second');
});

test('a message cancelled while it waited is refused, not steered in', async (t) => {
  const provider = scriptedProvider([openAiToolCall, () => openAiText('done')], 1);
  const gateway = await startGateway(t, provider.fetchImpl);

  const first = gateway.dispatch({ sessionId: 's-4', agentId: 'ava', userMessage: 'first', onAbsorbed: () => {} });
  await provider.waiting;
  const cancel = new AbortController();
  const kept = gateway.dispatch({ sessionId: 's-4', agentId: 'ava', userMessage: 'kept', idempotencyKey: 'a', onAbsorbed: () => {} });
  const dropped = assert.rejects(gateway.dispatch({ sessionId: 's-4', agentId: 'ava', userMessage: 'dropped', idempotencyKey: 'b', signal: cancel.signal, onAbsorbed: () => {} }));
  cancel.abort();
  provider.release();
  await first;
  const session = await kept;
  await dropped;

  assert.equal(provider.calls.length, 2);
  assert.equal(lastUser(provider.calls[1]), 'kept');
  assert.equal(workItemState(session, 'a'), 'finished');
  assert.equal(workItemState(session, 'b'), undefined);
});

test('a steered message shares the running turn\'s failure, recorded where its key finds it', async (t) => {
  const provider = scriptedProvider([
    openAiToolCall,
    () => json({ error: { message: 'bad request' } }, 400),
  ], 1);
  const gateway = await startGateway(t, provider.fetchImpl);

  const first = gateway.dispatch({ sessionId: 's-5', agentId: 'ava', userMessage: 'first', idempotencyKey: 'k1', onAbsorbed: () => {} });
  await provider.waiting;
  const second = gateway.dispatch({ sessionId: 's-5', agentId: 'ava', userMessage: 'second', idempotencyKey: 'k2', onAbsorbed: () => {} });
  provider.release();
  const [one, two] = await Promise.allSettled([first, second]);

  assert.equal(one.status, 'rejected');
  assert.equal(two.status, 'rejected');
  assert.equal(provider.calls.length, 2);
  assert.equal(lastUser(provider.calls[1]), 'second');
  const session = await gateway.store.get('s-5');
  assert.ok(session !== undefined);
  assert.equal(session.status, 'failed');
  assert.ok(turnFailureFor(session, 'k2') !== undefined);
  assert.equal(turnFailureFor(session, 'k2'), turnFailureFor(session, 'k1'));
});

test('a waiting batch holding a key the session already answered is not steered: the repeat is judged after the turn', async (t) => {
  const provider = scriptedProvider([() => openAiText('zero'), openAiToolCall, () => openAiText('one')], 2);
  const gateway = await startGateway(t, provider.fetchImpl);

  await gateway.dispatch({ sessionId: 's-6', agentId: 'ava', userMessage: 'zero', idempotencyKey: 'k0', onAbsorbed: () => {} });
  const running = gateway.dispatch({ sessionId: 's-6', agentId: 'ava', userMessage: 'one', idempotencyKey: 'k1', onAbsorbed: () => {} });
  await provider.waiting;
  let repeat: string | undefined;
  const redelivered = gateway.dispatch({ sessionId: 's-6', agentId: 'ava', userMessage: 'zero', idempotencyKey: 'k0', onAbsorbed: () => {}, onRepeat: (kind) => { repeat = kind; } });
  provider.release();
  const session = await running;
  await redelivered;

  assert.equal(provider.calls.length, 3);
  assert.equal(lastUser(provider.calls[2]), 'one');
  assert.equal(session.messages.some((message) => message.steered === true), false);
  assert.equal(repeat, 'finished');
});
