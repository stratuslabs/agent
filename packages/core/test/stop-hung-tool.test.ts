import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';

import {
  AgentRunner,
  EventBus,
  InMemorySessionStore,
  RunAbortedError,
  ToolRegistry,
  type Executor,
  type ModelProvider,
  type Session,
  type StratusEvent,
  type ToolResult,
} from '../src/index.ts';

/**
 * A plugin tool that neither settles nor looks at its signal — the shape
 * that held a session `running` until the daemon restarted (card 826):
 * Slack's `stop` could not end it, and a stop shut down around it, losing
 * the message queued behind it.
 */
const createHungTool = (): {
  tool: { name: string; execute(): Promise<unknown> };
  entered: Promise<void>;
  release: (outcome: { value?: unknown; error?: Error }) => void;
} => {
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  let settle!: (outcome: { value?: unknown; error?: Error }) => void;
  const outcome = new Promise<{ value?: unknown; error?: Error }>((resolve) => { settle = resolve; });
  return {
    tool: {
      name: 'hang.wait',
      async execute() {
        enter();
        const { value, error } = await outcome;
        if (error) {
          throw error;
        }
        return value;
      },
    },
    entered,
    release: settle,
  };
};

const toolCallOnce = (toolName: string): ModelProvider => ({
  name: 'tool-then-text',
  async generate({ session }) {
    if (session.messages.at(-1)?.role === 'tool') {
      return { parts: [{ type: 'text', text: 'never reached' }] };
    }
    return { parts: [{ type: 'tool-call', call: { id: 'call-hang', toolName, input: {} } }] };
  },
});

const settledYet = async (promise: Promise<unknown>): Promise<boolean> => {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let index = 0; index < 20; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return settled;
};

test('a tool that ignores the turn\'s abort is left behind after a short grace, and the turn ends', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hung = createHungTool();
  const tools = new ToolRegistry();
  tools.register(hung.tool);
  const events: StratusEvent[] = [];
  const bus = new EventBus();
  bus.subscribe((event) => { events.push(event); });
  const store = new InMemorySessionStore();
  const runner = new AgentRunner({ provider: toolCallOnce('hang.wait'), tools, store, bus });
  await runner.initialize();

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => { process.off('unhandledRejection', onUnhandled); });

  const controller = new AbortController();
  const run = runner.run({
    sessionId: 'hung-1',
    agent: { id: 'ava', name: 'Ava' },
    userMessage: 'wait',
    signal: controller.signal,
  });
  await hung.entered;
  controller.abort();

  // The grace is the tool's chance to answer for itself; nothing ends early.
  assert.equal(await settledYet(run), false, 'the turn ended before the tool had its grace');
  t.mock.timers.tick(5_000);
  await assert.rejects(run, (error: Error) => error instanceof RunAbortedError);

  const session = await store.get('hung-1');
  assert.equal(session?.status, 'failed');
  assert.equal(session?.lastError, 'Run aborted');
  const results = session?.messages.filter((message) => message.role === 'tool') ?? [];
  assert.equal(results.length, 1, 'the call needs its result, or the next turn opens on a dangling call');
  const recorded = results[0]?.toolResult;
  assert.equal(recorded?.callId, 'call-hang');
  assert.equal(recorded?.ok, false);
  assert.match(recorded?.error ?? '', /hang\.wait did not return after the turn was stopped/);
  assert.match(recorded?.error ?? '', /may still be running/);
  // Announced and settled like any other call: the channel's live line and
  // the watchdog's phase both read the pair.
  assert.ok(events.some((event) => event.type === 'tool.called' && event.call.id === 'call-hang'));
  assert.ok(events.some((event) => event.type === 'tool.completed' && event.result.callId === 'call-hang' && !event.result.ok));

  // Whatever the tool does later is nobody's: not a rejection the process
  // dies of, and not a second result in the transcript.
  const before = JSON.stringify(session?.messages);
  hung.release({ error: new Error('the late failure') });
  await settledYet(Promise.resolve());
  assert.deepEqual(unhandled, []);
  assert.equal(JSON.stringify((await store.get('hung-1'))?.messages), before);
});

test('a tool that stops when asked keeps its own result', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const tools = new ToolRegistry();
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  tools.register({
    name: 'shell.like',
    async execute(_input, _session, context) {
      enter();
      // Answers on its own, a moment after the abort: a killed child's
      // close event, say. That answer says what happened; the kernel's
      // fallback would only guess.
      return new Promise((_resolve, reject) => {
        context?.signal?.addEventListener('abort', () => {
          setImmediate(() => reject(new Error('Command aborted: sleep 600')));
        }, { once: true });
      });
    },
  });
  const store = new InMemorySessionStore();
  const runner = new AgentRunner({ provider: toolCallOnce('shell.like'), tools, store });
  await runner.initialize();

  const controller = new AbortController();
  const run = runner.run({
    sessionId: 'polite-1',
    agent: { id: 'ava', name: 'Ava' },
    userMessage: 'sleep',
    signal: controller.signal,
  });
  await entered;
  controller.abort();
  await assert.rejects(run, (error: Error) => error instanceof RunAbortedError);

  const recorded = (await store.get('polite-1'))?.messages.find((message) => message.role === 'tool')?.toolResult;
  assert.equal(recorded?.error, 'Command aborted: sleep 600');
});

test('a hosted call (a harness\'s bridged tool) is left behind the same way', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hung = createHungTool();
  const tools = new ToolRegistry();
  tools.register(hung.tool);
  const runner = new AgentRunner({
    provider: { name: 'unused', async generate() { return { parts: [{ type: 'text', text: 'unused' }] }; } },
    tools,
  });
  await runner.initialize();
  const session: Session = {
    id: 'hosted-hang',
    agent: { id: 'ava', name: 'Ava' },
    status: 'running',
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const controller = new AbortController();
  const call = runner.executeHostedToolCall(session, { id: 'hc-hang', toolName: 'hang.wait', input: {} }, { signal: controller.signal });
  await hung.entered;
  controller.abort();
  assert.equal(await settledYet(call), false);
  t.mock.timers.tick(5_000);
  const result: ToolResult = await call;
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /did not return after the turn was stopped/);
  assert.equal(session.messages.at(-1)?.toolResult?.callId, 'hc-hang');
});

test('a tool that runs without a stop is waited for as long as it takes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hung = createHungTool();
  const tools = new ToolRegistry();
  tools.register(hung.tool);
  const store = new InMemorySessionStore();
  const runner = new AgentRunner({
    provider: {
      name: 'tool-then-text',
      async generate({ session }) {
        if (session.messages.at(-1)?.role === 'tool') {
          return { parts: [{ type: 'text', text: 'done' }] };
        }
        return { parts: [{ type: 'tool-call', call: { id: 'call-slow', toolName: 'hang.wait', input: {} } }] };
      },
    },
    tools,
    store,
  });
  await runner.initialize();

  // No abort: a slow tool is not a stuck one, and no clock gives up on it.
  const controller = new AbortController();
  const run = runner.run({ sessionId: 'slow-1', agent: { id: 'ava', name: 'Ava' }, userMessage: 'go', signal: controller.signal });
  await hung.entered;
  t.mock.timers.tick(600_000);
  assert.equal(await settledYet(run), false);
  hung.release({ value: { finished: true } });
  const session = await run;
  assert.equal(session.status, 'completed');
  assert.deepEqual(session.messages.find((message) => message.role === 'tool')?.toolResult?.output, { finished: true });
});

test('an executor whose late answer is a rejection does not take the process down', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const tools = new ToolRegistry();
  tools.register({ name: 'remote.run', async execute() { return null; } });
  // A plugin executor that does not convert its own failure into a result:
  // the contract allows a rejection, and after the call was left behind
  // nobody is awaiting it any more.
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  let failLater!: (error: Error) => void;
  const executor: Executor = {
    execute() {
      enter();
      return new Promise<ToolResult>((_resolve, reject) => { failLater = reject; });
    },
  };
  const runner = new AgentRunner({ provider: toolCallOnce('remote.run'), tools, executor });
  await runner.initialize();

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => { process.off('unhandledRejection', onUnhandled); });

  const controller = new AbortController();
  const run = runner.run({ sessionId: 'remote-1', agent: { id: 'ava', name: 'Ava' }, userMessage: 'go', signal: controller.signal });
  await entered;
  controller.abort();
  t.mock.timers.tick(5_000);
  await assert.rejects(run, (error: Error) => error instanceof RunAbortedError);

  failLater(new Error('the sandbox went away'));
  await settledYet(Promise.resolve());
  assert.deepEqual(unhandled, []);
});

test('a call that answers in time leaves nothing waiting on the turn\'s signal', async () => {
  const tools = new ToolRegistry();
  tools.register({ name: 'quick.echo', async execute(input) { return input; } });
  let calls = 0;
  const provider: ModelProvider = {
    name: 'many-tools',
    async generate() {
      calls += 1;
      if (calls > 25) {
        return { parts: [{ type: 'text', text: 'done' }] };
      }
      return { parts: [{ type: 'tool-call', call: { id: `call-${calls}`, toolName: 'quick.echo', input: { n: calls } } }] };
    },
  };
  const runner = new AgentRunner({ provider, tools, maxTurns: 50 });
  await runner.initialize();

  // One signal lives for the whole turn; a listener per call left on it
  // would pile up for as long as the turn runs, and each would arm a timer
  // at the abort for a call that answered long ago.
  const controller = new AbortController();
  const before = getEventListeners(controller.signal, 'abort').length;
  const session = await runner.run({ sessionId: 'many-1', agent: { id: 'ava', name: 'Ava' }, userMessage: 'go', signal: controller.signal });
  assert.equal(session.status, 'completed');
  assert.equal(getEventListeners(controller.signal, 'abort').length, before);
});
