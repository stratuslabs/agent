import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentRunner,
  InMemorySessionStore,
  ToolRegistry,
  type ModelProvider,
  type ProviderRequest,
  type ProviderResponse,
  type StratusEvent,
} from '../src/index.ts';

// A provider that always wants another step, until the wrap-up's
// `toolChoice` takes its tools away.
const createEndlessProvider = (summary = 'Did some; the rest is left.'): ModelProvider & { requests: ProviderRequest[] } => {
  const requests: ProviderRequest[] = [];
  return {
    name: 'endless',
    requests,
    async generate(request) {
      requests.push(request);
      if (request.toolChoice === 'none') {
        return { parts: [{ type: 'text', text: summary }] };
      }
      return { parts: [{ type: 'tool-call', call: { id: `s${requests.length}`, toolName: 'step', input: { n: requests.length } } }] };
    },
  };
};

const createStepTools = (): ToolRegistry => {
  const tools = new ToolRegistry();
  tools.register({ name: 'step', async execute() { return { done: true }; } });
  return tools;
};

const recordEvents = (runner: AgentRunner): StratusEvent[] => {
  const events: StratusEvent[] = [];
  runner.bus.subscribe((event) => {
    events.push(event);
  });
  return events;
};

test('a message that runs out of steps is marked stopped early, and says so just before it completes', async () => {
  const provider = createEndlessProvider();
  const runner = new AgentRunner({ provider, tools: createStepTools(), maxTurns: 2 });
  const events = recordEvents(runner);

  const session = await runner.run({ sessionId: 'out-of-steps', agent: { id: 'ava', name: 'Ava', tools: ['*'] }, userMessage: 'Do it all' });

  // Still completed: the wrap-up answered. The marker is what tells this
  // run apart from one that finished.
  assert.equal(session.status, 'completed');
  assert.equal(session.stoppedEarly?.reason, 'turn-limit');
  assert.equal(session.stoppedEarly?.continuations, 0);
  assert.ok(!Number.isNaN(Date.parse(session.stoppedEarly?.at ?? '')));
  // Durable, not only on the object the run handed back.
  assert.deepEqual((await runner.store.get('out-of-steps'))?.stoppedEarly, session.stoppedEarly);

  const types = events.map((event) => event.type);
  const stopped = types.indexOf('session.stopped-early');
  assert.ok(stopped >= 0, 'session.stopped-early is emitted');
  assert.equal(types[stopped + 1], 'session.completed');
  // Counts only: the event is what the daemon log records.
  assert.deepEqual(events[stopped], { type: 'session.stopped-early', sessionId: 'out-of-steps', reason: 'turn-limit', continuations: 0 });
});

test('a message that finishes inside its budget carries no marker and no event', async () => {
  const provider: ModelProvider = {
    name: 'quick',
    async generate() {
      return { parts: [{ type: 'text', text: 'Done.' }] };
    },
  };
  const runner = new AgentRunner({ provider, maxTurns: 2 });
  const events = recordEvents(runner);

  const session = await runner.run({ sessionId: 'quick', agent: { id: 'ava', name: 'Ava', tools: ['*'] }, userMessage: 'Hi' });

  assert.equal(session.status, 'completed');
  assert.equal(session.stoppedEarly, undefined);
  assert.equal(events.some((event) => event.type === 'session.stopped-early'), false);
});

test('a message stopped at the auto-continue cap counts the budgets it was given', async () => {
  const provider = createEndlessProvider();
  const runner = new AgentRunner({ provider, tools: createStepTools(), maxTurns: 2, autoContinue: 2 });
  const events = recordEvents(runner);

  const session = await runner.run({ sessionId: 'capped', agent: { id: 'ava', name: 'Ava', tools: ['*'] }, userMessage: 'Go' });

  assert.deepEqual(
    { reason: session.stoppedEarly?.reason, continuations: session.stoppedEarly?.continuations },
    { reason: 'turn-limit', continuations: 2 },
  );
  assert.equal(events.filter((event) => event.type === 'session.stopped-early').length, 1);
});

test('a message stopped for repeating one failure is marked with that reason', async () => {
  const tools = new ToolRegistry();
  tools.register({ name: 'shell.run', async execute() { throw new Error('cwd /work/missing does not exist'); } });
  const provider: ModelProvider = {
    name: 'stuck',
    async generate(request) {
      if (request.toolChoice === 'none') {
        return { parts: [{ type: 'text', text: 'The directory is missing.' }] };
      }
      return { parts: [{ type: 'tool-call', call: { id: `c${Math.random()}`, toolName: 'shell.run', input: { command: 'ls' } } }] };
    },
  };
  const runner = new AgentRunner({ provider, tools });

  const session = await runner.run({ sessionId: 'stuck', agent: { id: 'ava', name: 'Ava', tools: ['*'] }, userMessage: 'List' });

  assert.equal(session.stoppedEarly?.reason, 'repeated-failure');
});

test('the next message in the same session clears the marker', async () => {
  let wrapUps = 0;
  let calls = 0;
  const provider: ModelProvider = {
    name: 'once',
    async generate(request) {
      calls += 1;
      if (request.toolChoice === 'none') {
        wrapUps += 1;
        return { parts: [{ type: 'text', text: 'Out of steps.' }] };
      }
      // Endless on the first message, done at once on the second.
      return wrapUps === 0
        ? { parts: [{ type: 'tool-call', call: { id: `s${calls}`, toolName: 'step', input: {} } }] }
        : { parts: [{ type: 'text', text: 'Finished.' }] };
    },
  };
  const runner = new AgentRunner({ provider, tools: createStepTools(), maxTurns: 1 });
  const events = recordEvents(runner);

  const first = await runner.run({ sessionId: 'thread', agent: { id: 'ava', name: 'Ava', tools: ['*'] }, userMessage: 'Start' });
  assert.equal(first.stoppedEarly?.reason, 'turn-limit');

  const second = await runner.resume({ sessionId: 'thread', userMessage: 'Thanks' });

  assert.equal(second.status, 'completed');
  assert.equal(second.stoppedEarly, undefined);
  assert.equal((await runner.store.get('thread'))?.stoppedEarly, undefined);
  assert.equal(events.filter((event) => event.type === 'session.stopped-early').length, 1);
});

test('a provider running its own loop reports its wrap-up, and the runner marks it the same way', async () => {
  const response = (stoppedEarly: unknown): ModelProvider => ({
    name: 'harness',
    async generate(request) {
      // One inner budget granted, then out of steps with its own wrap-up.
      request.mayContinue?.();
      return { parts: [{ type: 'text', text: 'Wrapped up inside the harness.' }], stoppedEarly } as ProviderResponse;
    },
  });
  const marked = new AgentRunner({ provider: response('turn-limit'), maxTurns: 3, autoContinue: true });
  const events = recordEvents(marked);
  const session = await marked.run({ sessionId: 'harness', agent: { id: 'ava', name: 'Ava', tools: ['*'] }, userMessage: 'Go' });
  assert.deepEqual(
    { reason: session.stoppedEarly?.reason, continuations: session.stoppedEarly?.continuations },
    { reason: 'turn-limit', continuations: 1 },
  );
  assert.equal(events.filter((event) => event.type === 'session.stopped-early').length, 1);

  // A value core does not know is no marker: a plugin's typo must not
  // invent a reason nothing downstream can read.
  const unknown = new AgentRunner({ provider: response('ran-out'), maxTurns: 3 });
  const plain = await unknown.run({ sessionId: 'harness-unknown', agent: { id: 'ava', name: 'Ava', tools: ['*'] }, userMessage: 'Go' });
  assert.equal(plain.stoppedEarly, undefined);
});

test('a wrap-up saved before a crash is still announced as stopped early when the turn is finished', async () => {
  const store = new InMemorySessionStore();
  const now = new Date().toISOString();
  // What the store holds when the process died after saving the wrap-up's
  // answer and before the save marking the turn completed.
  await store.create({
    id: 'crashed',
    agent: { id: 'ava', name: 'Ava', tools: ['*'] },
    status: 'running',
    messages: [
      { id: 'crashed:user:1', role: 'user', content: 'Go', createdAt: now },
      { id: 'crashed:assistant:2', role: 'assistant', content: 'Out of steps; here is where I got to.', createdAt: now },
    ],
    stoppedEarly: { reason: 'turn-limit', continuations: 0, at: now },
  });
  let called = false;
  const provider: ModelProvider = {
    name: 'never',
    async generate() {
      called = true;
      return { parts: [] };
    },
  };
  const runner = new AgentRunner({ provider, store });
  const events = recordEvents(runner);

  const session = await runner.continueTurn('crashed');

  assert.equal(called, false);
  assert.equal(session?.status, 'completed');
  const types = events.map((event) => event.type);
  assert.equal(types[types.indexOf('session.stopped-early') + 1], 'session.completed');
});
