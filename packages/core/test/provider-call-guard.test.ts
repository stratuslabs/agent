import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentRunner,
  ContextOverflowError,
  EventBus,
  HostRefusalError,
  InMemorySessionStore,
  type ModelProvider,
  type ProviderCallCheck,
  type ProviderCallGuard,
  type StratusEvent,
} from '../src/index.ts';

const AGENT = { id: 'budgeted', name: 'Budgeted' };

/** Answers with a tool call on its first request and text after, reporting `tokens` input tokens each time. */
const createTwoStepProvider = (log: string[], tokens = 10): ModelProvider => {
  let calls = 0;
  return {
    name: 'metered',
    async generate() {
      calls += 1;
      log.push(`call ${calls}`);
      return calls === 1
        ? {
            parts: [{ type: 'tool-call' as const, call: { id: 'c1', toolName: 'missing.tool', input: {} } }],
            usage: { provider: 'metered', inputTokens: tokens },
          }
        : { parts: [{ type: 'text' as const, text: 'done' }], usage: { provider: 'metered', inputTokens: tokens } };
    },
  };
};

const createFailureSink = (bus: EventBus): StratusEvent[] => {
  const failures: StratusEvent[] = [];
  bus.subscribe((event) => {
    if (event.type === 'session.failed') {
      failures.push(event);
    }
  });
  return failures;
};

test('every guard is asked before every provider call, after the previous call\'s usage was announced', async () => {
  const bus = new EventBus();
  const log: string[] = [];
  let spent = 0;
  bus.subscribe((event) => {
    if (event.type === 'session.usage') {
      spent += event.records.reduce((sum, record) => sum + (record.inputTokens ?? 0), 0);
    }
  });
  const checks: ProviderCallCheck[] = [];
  const first: ProviderCallGuard = (check) => {
    checks.push(check);
    log.push(`first sees ${spent}`);
  };
  const second: ProviderCallGuard = async () => {
    log.push('second');
  };

  await new AgentRunner({ provider: createTwoStepProvider(log), bus, providerCallGuards: [first, second] })
    .run({ sessionId: 'guard-1', agent: AGENT, userMessage: 'hello' });

  assert.deepEqual(log, ['first sees 0', 'second', 'call 1', 'first sees 10', 'second', 'call 2']);
  assert.deepEqual(checks, [
    { agentId: 'budgeted', sessionId: 'guard-1', provider: 'metered' },
    { agentId: 'budgeted', sessionId: 'guard-1', provider: 'metered' },
  ]);
});

test('a guard that refuses on purpose stops the call, and the turn fails as refused', async () => {
  const store = new InMemorySessionStore();
  const bus = new EventBus();
  const failures = createFailureSink(bus);
  const log: string[] = [];
  let allowed = 1;
  const budget: ProviderCallGuard = () => {
    if (allowed === 0) {
      throw new HostRefusalError('This agent has used its daily model budget. It resets at midnight UTC.');
    }
    allowed -= 1;
  };
  const later: ProviderCallGuard = () => {
    log.push('later guard');
  };

  await assert.rejects(
    new AgentRunner({ provider: createTwoStepProvider(log), store, bus, providerCallGuards: [budget, later] })
      .run({ sessionId: 'guard-2', agent: AGENT, userMessage: 'hello' }),
    HostRefusalError,
  );

  // The second call was never made, and no guard after the refusing one ran.
  assert.deepEqual(log, ['later guard', 'call 1']);
  assert.deepEqual(failures, [{
    type: 'session.failed',
    sessionId: 'guard-2',
    error: 'This agent has used its daily model budget. It resets at midnight UTC.',
    refused: true,
  }]);
  assert.equal((await store.get('guard-2'))?.status, 'failed');
});

test('a guard that throws anything else refuses the call too, as a failure', async () => {
  const bus = new EventBus();
  const failures = createFailureSink(bus);
  const log: string[] = [];
  const broken: ProviderCallGuard = async () => {
    throw new Error('the budget file could not be read');
  };

  await assert.rejects(
    new AgentRunner({ provider: createTwoStepProvider(log), bus, providerCallGuards: [broken] })
      .run({ sessionId: 'guard-3', agent: AGENT, userMessage: 'hello' }),
    /the budget file could not be read/,
  );

  // Closed, not open: a guard that cannot answer is not a guard that said yes.
  assert.deepEqual(log, []);
  assert.deepEqual(failures, [{ type: 'session.failed', sessionId: 'guard-3', error: 'the budget file could not be read' }]);
});

test('the retry after a context overflow is a provider call, and is guarded like one', async () => {
  const asked: string[] = [];
  let calls = 0;
  const provider: ModelProvider = {
    name: 'small-window',
    async generate() {
      calls += 1;
      asked.push(`call ${calls}`);
      if (calls === 2) {
        throw new ContextOverflowError('prompt is too long: 900 tokens > 800 maximum');
      }
      return { parts: [{ type: 'text' as const, text: 'done' }] };
    },
  };
  const runner = new AgentRunner({
    provider,
    store: new InMemorySessionStore(),
    providerCallGuards: [() => {
      asked.push('guard');
    }],
  });

  await runner.run({ sessionId: 'guard-4', agent: AGENT, userMessage: 'first' });
  await runner.resume({ sessionId: 'guard-4', userMessage: 'second' });

  assert.deepEqual(asked, ['guard', 'call 1', 'guard', 'call 2', 'guard', 'call 3']);
});
