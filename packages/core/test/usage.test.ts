import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentRunner,
  EventBus,
  InMemorySessionStore,
  ToolRegistry,
  totalTokenUsage,
  uncachedInputTokens,
  type ModelProvider,
  type ProviderCallUsage,
  type StratusEvent,
  type Tool,
  type UsageRecord,
} from '../src/index.ts';

const AGENT = { id: 'accountant', name: 'Accountant' };

/** Records every completion event's usage, in emission order. */
const createCompletionSink = (bus: EventBus): UsageRecord[][] => {
  const seen: UsageRecord[][] = [];
  bus.subscribe((event: StratusEvent) => {
    if (event.type === 'session.completed') {
      seen.push(event.usage ? [...event.usage] : []);
    }
  });
  return seen;
};

/**
 * A provider whose every call answers with the scripted text and reports the
 * scripted usage on its response — the simple shape, one request per call.
 */
const createReportingProvider = (
  name: string,
  script: ReadonlyArray<{ text: string; usage?: ProviderCallUsage }>,
): ModelProvider => {
  let index = 0;
  return {
    name,
    async generate() {
      const step = script[Math.min(index, script.length - 1)];
      index += 1;
      return {
        parts: [{ type: 'text' as const, text: step?.text ?? 'done' }],
        ...(step?.usage ? { usage: step.usage } : {}),
      };
    },
  };
};

test('a session against a provider reporting known counts emits exactly those counts', async () => {
  const bus = new EventBus();
  const completions = createCompletionSink(bus);
  const provider = createReportingProvider('fake', [
    { text: 'done', usage: { provider: 'fake', model: 'fake-1', inputTokens: 120, outputTokens: 34 } },
  ]);

  const session = await new AgentRunner({ provider, bus }).run({
    sessionId: 'usage-1',
    agent: AGENT,
    userMessage: 'hello',
  });

  assert.deepEqual(session.usage, [
    { turnId: 'usage-1:turn:1', provider: 'fake', model: 'fake-1', inputTokens: 120, outputTokens: 34 },
  ]);
  assert.deepEqual(completions, [session.usage]);
});

test('a subscriber cannot edit the session\'s records through the completion event', async () => {
  const store = new InMemorySessionStore();
  const bus = new EventBus();
  bus.subscribe((event) => {
    if (event.type === 'session.completed' && event.usage) {
      // A consumer normalizing what it was handed. The records are durable
      // accounting state, so this must reach nothing — not the session the
      // runner returns, not the next subscriber, and not the store, which
      // hands back the very same objects on the next read.
      event.usage.push({ turnId: 'forged', provider: 'nobody' });
      const first = event.usage[0];
      if (first) {
        first.inputTokens = 999_999;
      }
    }
  });

  const session = await new AgentRunner({
    provider: createReportingProvider('fake', [
      { text: 'done', usage: { provider: 'fake', model: 'fake-1', inputTokens: 120 } },
    ]),
    store,
    bus,
  }).run({ sessionId: 'usage-11', agent: AGENT, userMessage: 'hello' });

  assert.deepEqual(session.usage, [
    { turnId: 'usage-11:turn:1', provider: 'fake', model: 'fake-1', inputTokens: 120 },
  ]);
  assert.deepEqual((await store.get('usage-11'))?.usage, session.usage);
});

test('a two-call session emits both records, one per Stratus turn', async () => {
  const bus = new EventBus();
  const completions = createCompletionSink(bus);
  const tools = new ToolRegistry();
  const echo: Tool = {
    name: 'echo',
    risk: 'safe',
    async execute() {
      return { ok: true };
    },
  };
  tools.register(echo);

  let call = 0;
  const provider: ModelProvider = {
    name: 'fake',
    async generate() {
      call += 1;
      if (call === 1) {
        return {
          parts: [{ type: 'tool-call' as const, call: { id: 'c1', toolName: 'echo', input: {} } }],
          usage: { provider: 'fake', model: 'fake-1', inputTokens: 10, outputTokens: 2 },
        };
      }
      return {
        parts: [{ type: 'text' as const, text: 'done' }],
        usage: { provider: 'fake', model: 'fake-1', inputTokens: 30, outputTokens: 4 },
      };
    },
  };

  const session = await new AgentRunner({ provider, bus, tools }).run({
    sessionId: 'usage-2',
    agent: { ...AGENT, tools: ['echo'] },
    userMessage: 'hello',
  });

  // Two records, not one summed row: the turn ids are what keep a resumed
  // session's turns distinguishable once two of them share provider and model.
  assert.deepEqual(session.usage?.map((record) => record.turnId), ['usage-2:turn:1', 'usage-2:turn:2']);
  assert.deepEqual(totalTokenUsage(session.usage ?? []), { inputTokens: 40, outputTokens: 6 });
  assert.equal(completions[0]?.length, 2);
});

test('a provider reporting no usage completes with the field absent, not a zero', async () => {
  const bus = new EventBus();
  const seen: Array<StratusEvent & { type: 'session.completed' }> = [];
  bus.subscribe((event) => {
    if (event.type === 'session.completed') {
      seen.push(event);
    }
  });

  const session = await new AgentRunner({
    provider: createReportingProvider('silent', [{ text: 'done' }]),
    bus,
  }).run({ sessionId: 'usage-3', agent: AGENT, userMessage: 'hello' });

  assert.equal(session.usage, undefined);
  assert.equal(seen.length, 1);
  assert.ok(seen[0] !== undefined && !('usage' in seen[0]));
});

test('a fallback to a second provider keeps provider and model on each record', async () => {
  const bus = new EventBus();
  const store = new InMemorySessionStore();

  // The shape the fallback wrapper has: one provider object, answering to the
  // primary's name, serving the secondary after the primary fails. The record
  // must name who actually ran, not who the runner asked.
  let firstCall = true;
  const provider: ModelProvider = {
    name: 'primary',
    async generate() {
      if (firstCall) {
        firstCall = false;
        return {
          parts: [{ type: 'tool-call' as const, call: { id: 'c1', toolName: 'echo', input: {} } }],
          usage: { provider: 'primary', model: 'primary-1', inputTokens: 11, outputTokens: 1 },
        };
      }
      return {
        parts: [{ type: 'text' as const, text: 'rescued' }],
        usage: { provider: 'secondary', model: 'secondary-1', inputTokens: 22, outputTokens: 3 },
      };
    },
  };

  const tools = new ToolRegistry();
  tools.register({
    name: 'echo',
    risk: 'safe',
    async execute() {
      return { ok: true };
    },
  });

  const session = await new AgentRunner({ provider, bus, store, tools }).run({
    sessionId: 'usage-4',
    agent: { ...AGENT, tools: ['echo'] },
    userMessage: 'hello',
  });

  assert.deepEqual(
    session.usage?.map((record) => `${record.provider}/${record.model}`),
    ['primary/primary-1', 'secondary/secondary-1'],
  );
});

test('a provider that reports through the sink has its response usage ignored', async () => {
  // The harness shape: several model calls inside one Stratus turn, each
  // reported as it completes. Reading the response field as well would bill
  // the last inner call twice.
  const provider: ModelProvider = {
    name: 'harness',
    async generate(request) {
      request.onUsage?.({ provider: 'harness', model: 'small', inputTokens: 5, outputTokens: 1 });
      request.onUsage?.({ provider: 'harness', model: 'large', inputTokens: 50, outputTokens: 10 });
      request.onUsage?.({ provider: 'harness', model: 'large', inputTokens: 60, outputTokens: 20 });
      return {
        parts: [{ type: 'text' as const, text: 'done' }],
        usage: { provider: 'harness', model: 'large', inputTokens: 60, outputTokens: 20 },
      };
    },
  };

  const session = await new AgentRunner({ provider }).run({
    sessionId: 'usage-5',
    agent: AGENT,
    userMessage: 'hello',
  });

  assert.equal(session.usage?.length, 3);
  // Three calls, one Stratus turn: they share the turn id and the derived
  // total is their sum, with both models still separable.
  assert.deepEqual(new Set(session.usage?.map((record) => record.turnId)), new Set(['usage-5:turn:1']));
  assert.deepEqual(totalTokenUsage(session.usage ?? []), { inputTokens: 115, outputTokens: 31 });
  assert.deepEqual(
    session.usage?.filter((record) => record.model === 'large').map((record) => record.inputTokens),
    [50, 60],
  );
});

test('a failed attempt reported through the sink survives on the session', async () => {
  const store = new InMemorySessionStore();
  const provider: ModelProvider = {
    name: 'flaky',
    async generate(request) {
      // The tokens of an attempt that then threw were still spent. They have
      // no response to ride on, which is the second reason the sink exists.
      request.onUsage?.({ provider: 'flaky', model: 'flaky-1', inputTokens: 9, outputTokens: 0 });
      throw new Error('upstream exploded');
    },
  };

  await assert.rejects(
    new AgentRunner({ provider, store }).run({
      sessionId: 'usage-6',
      agent: AGENT,
      userMessage: 'hello',
    }),
    /upstream exploded/,
  );

  const stored = await store.get('usage-6');
  assert.equal(stored?.status, 'failed');
  assert.deepEqual(stored?.usage, [
    { turnId: 'usage-6:turn:1', provider: 'flaky', model: 'flaky-1', inputTokens: 9, outputTokens: 0 },
  ]);
});

test('a turn cancelled after the response still records what the response cost', async () => {
  const store = new InMemorySessionStore();
  const controller = new AbortController();
  const provider: ModelProvider = {
    name: 'fake',
    async generate() {
      // The window this covers: the model answered, and the turn is
      // cancelled before the loop looks at the answer. The tokens are gone
      // either way, so the record has to survive the abort.
      controller.abort();
      return {
        parts: [{ type: 'text' as const, text: 'too late' }],
        usage: { provider: 'fake', model: 'fake-1', inputTokens: 12, outputTokens: 5 },
      };
    },
  };

  await assert.rejects(
    new AgentRunner({ provider, store }).run({
      sessionId: 'usage-9',
      agent: AGENT,
      userMessage: 'hello',
      signal: controller.signal,
    }),
  );

  const stored = await store.get('usage-9');
  assert.equal(stored?.status, 'failed');
  assert.deepEqual(stored?.usage, [
    { turnId: 'usage-9:turn:1', provider: 'fake', model: 'fake-1', inputTokens: 12, outputTokens: 5 },
  ]);
});

test('a bucket reported as an explicit undefined is written as absent', async () => {
  // A JavaScript adapter can hand back `{ outputTokens: undefined }`, and the
  // two forms do not survive a round trip through the session store as the
  // same thing. Absence is the one that has to be stored.
  const usage: ProviderCallUsage = { provider: 'fake', inputTokens: 7 };
  Object.assign(usage, { outputTokens: undefined, model: undefined });

  const session = await new AgentRunner({
    provider: createReportingProvider('fake', [{ text: 'done', usage }]),
  }).run({ sessionId: 'usage-10', agent: AGENT, userMessage: 'hello' });

  assert.deepEqual(Object.keys(session.usage?.[0] ?? {}), ['turnId', 'provider', 'inputTokens']);
});

test('a resumed session adds to its stored usage rather than replacing it', async () => {
  const store = new InMemorySessionStore();
  const bus = new EventBus();
  const completions = createCompletionSink(bus);
  const provider = createReportingProvider('fake', [
    { text: 'first', usage: { provider: 'fake', model: 'fake-1', inputTokens: 10, outputTokens: 1 } },
    { text: 'second', usage: { provider: 'fake', model: 'fake-1', inputTokens: 20, outputTokens: 2 } },
  ]);

  const runner = new AgentRunner({ provider, store, bus });
  await runner.run({ sessionId: 'usage-7', agent: AGENT, userMessage: 'first' });
  const resumed = await runner.resume({ sessionId: 'usage-7', userMessage: 'second' });

  assert.deepEqual(resumed.usage, [
    { turnId: 'usage-7:turn:1', provider: 'fake', model: 'fake-1', inputTokens: 10, outputTokens: 1 },
    { turnId: 'usage-7:turn:2', provider: 'fake', model: 'fake-1', inputTokens: 20, outputTokens: 2 },
  ]);
  // The completion event carries the session's whole record set, so the
  // second run reports the first run's turn too.
  assert.deepEqual(completions.map((usage) => usage.length), [1, 2]);
});

test('an unnamed usage report is attributed to the provider the runner asked', async () => {
  const provider: ModelProvider = {
    name: 'minimal',
    async generate() {
      return {
        parts: [{ type: 'text' as const, text: 'done' }],
        usage: { inputTokens: 7 },
      };
    },
  };

  const session = await new AgentRunner({ provider }).run({
    sessionId: 'usage-8',
    agent: AGENT,
    userMessage: 'hello',
  });

  assert.deepEqual(session.usage, [{ turnId: 'usage-8:turn:1', provider: 'minimal', inputTokens: 7 }]);
});

test('totalTokenUsage leaves a bucket nobody measured absent', () => {
  assert.deepEqual(
    totalTokenUsage([{ inputTokens: 1 }, { inputTokens: 2, cacheReadTokens: 3 }]),
    { inputTokens: 3, cacheReadTokens: 3 },
  );
  assert.equal(totalTokenUsage([]), undefined);
  assert.equal(totalTokenUsage([{}, {}]), undefined);
});

test('uncachedInputTokens subtracts the cache buckets and never goes negative', () => {
  assert.equal(uncachedInputTokens(100, 30), 70);
  assert.equal(uncachedInputTokens(100, 30, 10), 60);
  assert.equal(uncachedInputTokens(100, undefined), 100);
  assert.equal(uncachedInputTokens(10, 40), 0);
});
