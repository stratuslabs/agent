import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentRunner,
  EventBus,
  HostRefusalError,
  InMemorySessionStore,
  type ModelProvider,
  type Session,
  type StratusEvent,
} from '../src/index.ts';

const AGENT = { id: 'masked', name: 'Masked', credentials: ['search.apiKey'] };
const NAMED = 'brave-key-0123456789';
const TOKEN = 'xoxb-111-222-abcdef';

const failingWith = (error: unknown): ModelProvider => ({
  name: 'failing',
  async generate() {
    throw error;
  },
});

const failureSink = (bus: EventBus): Array<Extract<StratusEvent, { type: 'session.failed' }>> => {
  const failures: Array<Extract<StratusEvent, { type: 'session.failed' }>> = [];
  bus.subscribe((event) => {
    if (event.type === 'session.failed') {
      failures.push(event);
    }
  });
  return failures;
};

test('a failure quoting a stored secret is masked in lastError, session.failed and the thrown error', async () => {
  const store = new InMemorySessionStore();
  const bus = new EventBus();
  const failures = failureSink(bus);
  const asked: Session[] = [];
  const runner = new AgentRunner({
    provider: failingWith(new Error(`upstream said: bad header "${NAMED}" (token ${TOKEN})`)),
    store,
    bus,
    failureSecrets: async (session) => {
      asked.push(session);
      return [NAMED, TOKEN];
    },
  });

  await assert.rejects(
    () => runner.run({ sessionId: 'mask-1', agent: AGENT, userMessage: 'hello' }),
    (error: Error) => error.message === 'upstream said: bad header "[redacted]" (token [redacted])',
  );

  const masked = 'upstream said: bad header "[redacted]" (token [redacted])';
  assert.equal((await store.get('mask-1'))?.lastError, masked);
  assert.deepEqual(failures.map((event) => event.error), [masked]);
  // Asked with the failing session, so a host can add what that agent
  // alone resolves (a credential supplied by the environment).
  assert.deepEqual(asked.map((session) => session.id), ['mask-1']);
  assert.deepEqual(asked[0]?.agent.credentials, ['search.apiKey']);
});

test('masking keeps the error\'s class, so a refusal still reads as refused', async () => {
  const bus = new EventBus();
  const failures = failureSink(bus);
  const runner = new AgentRunner({
    provider: failingWith(new HostRefusalError(`budget for ${NAMED} is spent`)),
    bus,
    failureSecrets: async () => [NAMED],
  });

  await assert.rejects(
    () => runner.run({ sessionId: 'mask-2', agent: AGENT, userMessage: 'hello' }),
    (error: Error) => error instanceof HostRefusalError && error.message === 'budget for [redacted] is spent',
  );
  assert.equal(failures[0]?.error, 'budget for [redacted] is spent');
  assert.equal(failures[0]?.refused, true);
});

test('a thrown string is masked the same way', async () => {
  const store = new InMemorySessionStore();
  const runner = new AgentRunner({
    provider: failingWith(`raw ${TOKEN}`),
    store,
    failureSecrets: async () => [TOKEN],
  });

  await assert.rejects(
    () => runner.run({ sessionId: 'mask-3', agent: AGENT, userMessage: 'hello' }),
    (thrown: unknown) => thrown === 'raw [redacted]',
  );
  assert.equal((await store.get('mask-3'))?.lastError, 'raw [redacted]');
});

test('when the secrets cannot be read, the failure is still recorded and announced, unmasked', async () => {
  // The store being unreadable is most often the failure being reported,
  // and its own message names a path, not a value: withholding the text
  // would hide the one clue to the fix. The turn must fail either way.
  const store = new InMemorySessionStore();
  const bus = new EventBus();
  const failures = failureSink(bus);
  const runner = new AgentRunner({
    provider: failingWith(new Error('Credentials file must contain a JSON object: /home/x/.stratus/credentials.json')),
    store,
    bus,
    failureSecrets: async () => {
      throw new Error('unreadable');
    },
  });

  await assert.rejects(
    () => runner.run({ sessionId: 'mask-4', agent: AGENT, userMessage: 'hello' }),
    /Credentials file must contain a JSON object/,
  );
  const stored = await store.get('mask-4');
  assert.equal(stored?.status, 'failed');
  assert.match(stored?.lastError ?? '', /Credentials file must contain a JSON object/);
  assert.equal(failures.length, 1);
});

test('without failureSecrets a failure reads as it was thrown', async () => {
  const store = new InMemorySessionStore();
  const runner = new AgentRunner({ provider: failingWith(new Error(`plain ${NAMED}`)), store });

  await assert.rejects(() => runner.run({ sessionId: 'mask-5', agent: AGENT, userMessage: 'hello' }), new RegExp(`plain ${NAMED}`));
  assert.equal((await store.get('mask-5'))?.lastError, `plain ${NAMED}`);
});
