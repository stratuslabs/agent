import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentRunner,
  ContextOverflowError,
  HostRefusalError,
  RunAbortedError,
  type ModelProvider,
  type StratusEvent,
} from '../src/index.ts';

// A second copy of core, the way a real install has one. npm gives every
// global package its own tree, so `@stratusagent/channel-slack`, a provider
// package and the CLI each carry their own `@stratusagent/core`. A query
// string makes Node load the same file as a separate module, with classes
// of its own.
const otherCopy = await import(new URL('../src/index.ts?copy=other', import.meta.url).href) as typeof import('../src/index.ts');

test('the copy really is a second one, so these tests mean something', () => {
  assert.notEqual(otherCopy.ContextOverflowError, ContextOverflowError);
  assert.notEqual(otherCopy.RunAbortedError, RunAbortedError);
});

test('a context overflow thrown by another copy of core is still a context overflow', () => {
  assert.ok(new otherCopy.ContextOverflowError('too long') instanceof ContextOverflowError);
  assert.ok(new ContextOverflowError('too long') instanceof otherCopy.ContextOverflowError);
  assert.ok(new otherCopy.RunAbortedError('stopped') instanceof RunAbortedError);
  assert.ok(new RunAbortedError('stopped') instanceof otherCopy.RunAbortedError);
});

test('only the errors themselves match, not lookalikes or each other', () => {
  for (const value of [
    new Error('too long'),
    Object.assign(new Error('too long'), { name: 'ContextOverflowError' }),
    { name: 'ContextOverflowError', message: 'too long' },
    new RunAbortedError('stopped'),
    new otherCopy.RunAbortedError('stopped'),
    null,
    undefined,
    'ContextOverflowError',
  ]) {
    assert.equal(value instanceof ContextOverflowError, false, String(value));
  }
  assert.equal(new ContextOverflowError('too long') instanceof RunAbortedError, false);
  assert.equal(new otherCopy.ContextOverflowError('too long') instanceof RunAbortedError, false);
});

test('a subclass is still checked as a subclass', () => {
  class Narrower extends ContextOverflowError {}
  assert.ok(new Narrower('too long') instanceof ContextOverflowError);
  assert.ok(new Narrower('too long') instanceof Narrower);
  assert.equal(new ContextOverflowError('too long') instanceof Narrower, false);
  assert.equal(new otherCopy.ContextOverflowError('too long') instanceof Narrower, false);
});

test('a provider package on its own copy of core still gets a shorter window when the conversation outgrows the model', async () => {
  // The adapter throws the overflow from the core it was installed with;
  // the runner checks it against its own.
  const sent: number[] = [];
  const provider: ModelProvider = {
    name: 'separately-installed',
    async generate(request) {
      const messages = request.messages ?? request.session.messages;
      sent.push(messages.length);
      if (messages.length > 6) {
        throw new otherCopy.ContextOverflowError('prompt is too long');
      }
      return { parts: [{ type: 'text' as const, text: 'fits now' }] };
    },
  };
  const runner = new AgentRunner({ provider });
  const events: StratusEvent[] = [];
  runner.bus.subscribe((event) => {
    events.push(event);
  });
  const now = new Date().toISOString();
  const messages = [];
  for (let turn = 1; turn <= 10; turn += 1) {
    messages.push({ id: `copies:user:${turn}`, role: 'user' as const, content: `question ${turn}`, createdAt: now });
    messages.push({ id: `copies:assistant:${turn}`, role: 'assistant' as const, content: `answer ${turn}`, createdAt: now });
  }
  await runner.store.create({ id: 'copies', agent: { id: 'copies', name: 'Copies' }, status: 'idle', messages });

  const session = await runner.resume({ sessionId: 'copies', userMessage: 'and now?' });

  assert.equal(session.status, 'completed');
  assert.ok(sent.length >= 2, `retried on a shorter window: ${JSON.stringify(sent)}`);
  assert.ok(events.some((event) => event.type === 'session.context-trimmed'));
});

test('a stop reason from a channel on its own copy of core is the reason the turn fails with', async () => {
  // channel-slack aborts a turn with the person who stopped it in the
  // reason, built from the core it was installed with.
  const controller = new AbortController();
  const reason = new otherCopy.RunAbortedError('Run aborted: stopped from Slack by Dylan');
  const provider: ModelProvider = {
    name: 'stalls',
    generate: ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('fetch aborted')), { once: true });
        controller.abort(reason);
      }),
  };
  const runner = new AgentRunner({ provider });
  await assert.rejects(
    () => runner.run({ sessionId: 'copies-abort', agent: { id: 'copies', name: 'Copies' }, userMessage: 'go', signal: controller.signal }),
    (error: unknown) => error === reason,
  );
  assert.equal((await runner.store.get('copies-abort'))?.lastError, 'Run aborted: stopped from Slack by Dylan');
});

test('a refusal from a plugin on its own copy of core still fails the turn as refused', async () => {
  // A budgets plugin installed on its own throws the HostRefusalError of
  // the core it was installed with.
  assert.ok(new otherCopy.HostRefusalError('out of budget') instanceof HostRefusalError);
  assert.equal(new otherCopy.ContextOverflowError('too long') instanceof HostRefusalError, false);
  const failures: StratusEvent[] = [];
  const provider: ModelProvider = {
    name: 'never-called',
    async generate() {
      throw new Error('the guard should have refused first');
    },
  };
  const runner = new AgentRunner({
    provider,
    providerCallGuards: [() => {
      throw new otherCopy.HostRefusalError('Ava has used her daily model budget.');
    }],
  });
  runner.bus.subscribe((event) => {
    if (event.type === 'session.failed') {
      failures.push(event);
    }
  });
  await assert.rejects(
    () => runner.run({ sessionId: 'copies-refused', agent: { id: 'copies', name: 'Copies' }, userMessage: 'go' }),
    /daily model budget/,
  );
  assert.equal(failures.length, 1);
  assert.equal((failures[0] as { refused?: true }).refused, true);
});
