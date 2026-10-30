import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentRunner,
  EventBus,
  InMemorySessionStore,
  RunAbortedError,
  SkillRegistry,
  createSkillReadTool,
  ToolRegistry,
  type ApprovalPolicy,
  type ModelProvider,
  type ProviderPart,
  type Session,
  type StratusEvent,
  type Tool,
  type ToolCall,
} from '../src/index.ts';

/**
 * Card 956: a response's read-only calls run together. Every gate below is
 * a count of event-loop turns, never a clock, and each has a way to lose:
 * a runner that still ran these calls one at a time reaches the end of the
 * count with the other call not started, and the assertion fails rather
 * than the suite hanging.
 */
const turns = async (count: number): Promise<void> => {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

const signalled = (): { promise: Promise<void>; fire: () => void; fired: () => boolean } => {
  let fire!: () => void;
  let done = false;
  const promise = new Promise<void>((resolve) => { fire = () => { done = true; resolve(); }; });
  return { promise, fire, fired: () => done };
};

const call = (id: string, toolName: string): ToolCall => ({ id, toolName, input: {} });

/** Sends `calls` as one response, then answers once their results are in. */
const createScript = (calls: ToolCall[], answer = 'done'): ModelProvider & { seen: ToolCall[][] } => {
  const seen: ToolCall[][] = [];
  return {
    name: 'script',
    seen,
    async generate({ session }) {
      if (session.messages.at(-1)?.role === 'tool') {
        return { parts: [{ type: 'text', text: answer }] };
      }
      seen.push(calls);
      return { parts: calls.map((value): ProviderPart => ({ type: 'tool-call', call: value })) };
    },
  };
};

/** A tool that logs its start and end, and holds in between until `hold` settles. */
const createLoggedTool = (
  name: string,
  log: string[],
  shape: Pick<Tool, 'risk' | 'readOnly'>,
  hold: () => Promise<void> = () => turns(3),
): Tool => ({
  name,
  ...shape,
  async execute() {
    log.push(`${name}:start`);
    await hold();
    log.push(`${name}:end`);
    return name;
  },
});

const toolResultIds = (session: Session | undefined): string[] =>
  (session?.messages ?? []).filter((message) => message.role === 'tool').map((message) => message.toolResult?.callId ?? '?');

const runAs = (runner: AgentRunner, sessionId: string, signal?: AbortSignal): Promise<Session> =>
  runner.run({
    sessionId,
    agent: { id: 'ava', name: 'Ava' },
    userMessage: 'look around',
    ...(signal ? { signal } : {}),
  });

test('read-only calls in one response run together, and their results land in call order', async () => {
  const log: string[] = [];
  const fastStarted = signalled();
  const tools = new ToolRegistry();
  // The slow call holds until the fast one has started, or gives up: run
  // one at a time, the fast one cannot start until the slow one ends.
  tools.register(createLoggedTool('look.slow', log, { risk: 'safe', readOnly: true }, async () => {
    await Promise.race([fastStarted.promise, turns(200)]);
    log.push(`look.slow:saw-fast=${fastStarted.fired()}`);
  }));
  tools.register({
    name: 'look.fast',
    risk: 'safe',
    readOnly: true,
    async execute() {
      fastStarted.fire();
      log.push('look.fast:ran');
      return 'fast';
    },
  });
  const provider = createScript([call('c-slow', 'look.slow'), call('c-fast', 'look.fast')]);
  const store = new InMemorySessionStore();
  const runner = new AgentRunner({ provider, tools, store });
  await runner.initialize();

  const session = await runAs(runner, 'together-1');

  assert.ok(log.includes('look.slow:saw-fast=true'), `the second call waited for the first: ${log.join(', ')}`);
  // Finished out of order, recorded in order: the transcript reads as the
  // response asked, which is what every provider pairs results against.
  assert.ok(log.indexOf('look.fast:ran') < log.indexOf('look.slow:end'));
  assert.deepEqual(toolResultIds(session), ['c-slow', 'c-fast']);
  assert.deepEqual(toolResultIds(await store.get('together-1')), ['c-slow', 'c-fast']);
  assert.equal(session.messages.at(-1)?.content, 'done');
});

test('a call that is not read-only, or not safe, runs alone and in its place', async () => {
  const log: string[] = [];
  const tools = new ToolRegistry();
  for (const name of ['read.one', 'read.two', 'read.three', 'read.four']) {
    tools.register(createLoggedTool(name, log, { risk: 'safe', readOnly: true }));
  }
  // Safe but writes (memory.remember's shape): never alongside anything.
  tools.register(createLoggedTool('note.write', log, { risk: 'safe' }));
  // Declares read-only but is asked about: a question per call, in order.
  tools.register(createLoggedTool('gated.one', log, { risk: 'gated', readOnly: true }));
  tools.register(createLoggedTool('gated.two', log, { risk: 'gated', readOnly: true }));
  // Safe and read-only, but judged against the label the call before it
  // left (`trustBeforeCall`): in line too.
  for (const name of ['ledger.one', 'ledger.two']) {
    tools.register({ ...createLoggedTool(name, log, { risk: 'safe', readOnly: true }), trustBeforeCall: () => undefined });
  }
  const provider = createScript([
    call('c1', 'read.one'),
    call('c2', 'read.two'),
    call('c3', 'note.write'),
    call('c4', 'read.three'),
    call('c5', 'read.four'),
    call('c6', 'gated.one'),
    call('c7', 'gated.two'),
    call('c8', 'ledger.one'),
    call('c9', 'ledger.two'),
  ]);
  const runner = new AgentRunner({ provider, tools });
  await runner.initialize();

  const session = await runAs(runner, 'mixed-1');
  const at = (entry: string): number => {
    const index = log.indexOf(entry);
    assert.notEqual(index, -1, `${entry} never happened: ${log.join(', ')}`);
    return index;
  };

  assert.ok(at('read.two:start') < at('read.one:end'), 'the two reads before the write ran together');
  assert.ok(at('note.write:start') > Math.max(at('read.one:end'), at('read.two:end')), 'the write waited for the reads before it');
  assert.ok(at('read.three:start') > at('note.write:end'), 'the reads after the write waited for it');
  assert.ok(at('read.four:start') < at('read.three:end'), 'the two reads after the write ran together');
  assert.ok(at('gated.one:start') > at('read.four:end'));
  assert.ok(at('gated.two:start') > at('gated.one:end'), 'a gated call ran alongside another');
  assert.ok(at('ledger.two:start') > at('ledger.one:end'), 'a call judged by a label read before it ran alongside another');
  assert.deepEqual(toolResultIds(session), ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9']);
});

test('stopping a turn mid-batch settles every call in it, records them in order, and runs nothing after', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const politeEntered = signalled();
  const hungEntered = signalled();
  let wroteAfter = false;
  const tools = new ToolRegistry();
  tools.register({
    name: 'look.polite',
    risk: 'safe',
    readOnly: true,
    async execute(_input, _session, context) {
      politeEntered.fire();
      return new Promise((_resolve, reject) => {
        context?.signal?.addEventListener('abort', () => reject(new Error('look.polite stopped')), { once: true });
      });
    },
  });
  tools.register({
    name: 'look.hung',
    risk: 'safe',
    readOnly: true,
    async execute() {
      hungEntered.fire();
      return new Promise(() => undefined);
    },
  });
  tools.register({ name: 'note.write', risk: 'safe', async execute() { wroteAfter = true; return 'wrote'; } });
  const events: StratusEvent[] = [];
  const bus = new EventBus();
  bus.subscribe((event) => { events.push(event); });
  const store = new InMemorySessionStore();
  const provider = createScript([call('c-polite', 'look.polite'), call('c-hung', 'look.hung'), call('c-after', 'note.write')]);
  const runner = new AgentRunner({ provider, tools, store, bus });
  await runner.initialize();

  const controller = new AbortController();
  const run = runAs(runner, 'stop-1', controller.signal);
  // Both inside their tools at once — the batch is running, not queued.
  await Promise.race([Promise.all([politeEntered.promise, hungEntered.promise]), turns(200)]);
  assert.ok(politeEntered.fired() && hungEntered.fired(), 'the second read never started alongside the first');
  controller.abort();
  // The polite one answers for itself; the hung one is left behind after
  // the grace.
  await turns(5);
  t.mock.timers.tick(5_000);
  await assert.rejects(run, (error: Error) => error instanceof RunAbortedError);

  const session = await store.get('stop-1');
  assert.deepEqual(toolResultIds(session).slice(0, 2), ['c-polite', 'c-hung']);
  const [polite, hung] = (session?.messages ?? []).filter((message) => message.role === 'tool').map((message) => message.toolResult);
  assert.equal(polite?.error, 'look.polite stopped');
  assert.match(hung?.error ?? '', /did not return after the turn was stopped/);
  assert.equal(wroteAfter, false, 'a call after the stopped batch ran');
  assert.ok(!events.some((event) => event.type === 'tool.called' && event.call.id === 'c-after'));
});

test('the saved transcript only ever holds a prefix of the batch, so a crash leaves the rest to be closed in order', async () => {
  const firstHeld = signalled();
  const secondDone = signalled();
  const saved: string[][] = [];
  const snapshots: Session[] = [];
  const store = new InMemorySessionStore();
  const capturing: InMemorySessionStore = Object.assign(Object.create(store) as InMemorySessionStore, {
    async save(session: Session): Promise<void> {
      saved.push(toolResultIds(session));
      snapshots.push(JSON.parse(JSON.stringify(session)) as Session);
      await store.save(session);
    },
  });
  const tools = new ToolRegistry();
  tools.register({ name: 'look.first', risk: 'safe', readOnly: true, async execute() { await firstHeld.promise; return 'first'; } });
  tools.register({ name: 'look.second', risk: 'safe', readOnly: true, async execute() { return 'second'; } });
  tools.register({ name: 'look.third', risk: 'safe', readOnly: true, async execute() { return 'third'; } });
  const bus = new EventBus();
  bus.subscribe((event) => {
    if (event.type === 'tool.completed' && event.result.callId === 'c2') {
      secondDone.fire();
    }
  });
  const provider = createScript([call('c1', 'look.first'), call('c2', 'look.second'), call('c3', 'look.third')]);
  const runner = new AgentRunner({ provider, tools, store: capturing, bus });
  await runner.initialize();

  const run = runAs(runner, 'prefix-1');
  await Promise.race([secondDone.promise, turns(200)]);
  assert.ok(secondDone.fired(), 'the second read never ran while the first was still running');
  await turns(20);
  // The process dies here: what a restart finds is the last save.
  const atCrash = snapshots.at(-1);
  assert.deepEqual(toolResultIds(atCrash), [], 'a later call\'s result was saved ahead of an earlier one');

  firstHeld.fire();
  await run;
  for (const ids of saved) {
    assert.deepEqual(ids, ['c1', 'c2', 'c3'].slice(0, ids.length), `a save held ${ids.join(', ')}`);
  }
  assert.deepEqual(saved.at(-1), ['c1', 'c2', 'c3']);

  // The restart: nothing runs again; every call the crash cut off is closed
  // as interrupted, in the order the response asked for them.
  const reborn = new InMemorySessionStore();
  await reborn.save(atCrash!);
  let reran = 0;
  const again = new ToolRegistry();
  for (const name of ['look.first', 'look.second', 'look.third']) {
    again.register({ name, risk: 'safe', readOnly: true, async execute() { reran += 1; return 'again'; } });
  }
  const after = new AgentRunner({ provider: createScript([], 'picked up'), tools: again, store: reborn });
  await after.initialize();
  const continued = await after.continueTurn('prefix-1');
  assert.equal(reran, 0);
  assert.deepEqual(toolResultIds(continued), ['c1', 'c2', 'c3']);
  for (const message of (continued?.messages ?? []).filter((entry) => entry.role === 'tool')) {
    assert.match(message.toolResult?.error ?? '', /interrupted before a result was recorded/);
  }
});

test('a denied call in a batch is answered in its place and the others still run', async () => {
  const tools = new ToolRegistry();
  const ran: string[] = [];
  for (const name of ['look.a', 'look.b', 'look.c']) {
    tools.register({ name, risk: 'safe', readOnly: true, async execute() { ran.push(name); return name; } });
  }
  const approvals: ApprovalPolicy = {
    async approve({ call: asked }) {
      return asked.toolName !== 'look.b';
    },
  };
  const runner = new AgentRunner({ provider: createScript([call('a', 'look.a'), call('b', 'look.b'), call('c', 'look.c')]), tools, approvals });
  await runner.initialize();

  const session = await runAs(runner, 'deny-1');
  const results = session.messages.filter((message) => message.role === 'tool').map((message) => message.toolResult);
  assert.deepEqual(results.map((result) => result?.callId), ['a', 'b', 'c']);
  assert.deepEqual(results.map((result) => result?.ok), [true, false, true]);
  assert.match(results[1]?.error ?? '', /denied by approval policy/);
  assert.deepEqual(ran.sort(), ['look.a', 'look.c']);
});

for (const [order, recorded] of [[['s', 'x'], ['s']], [['x', 's'], []]] as const) {
  test(`a call that throws ends the turn only after the rest of its batch has settled (${order.join(' then ')})`, async (t) => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    t.after(() => { process.off('unhandledRejection', onUnhandled); });

    const log: string[] = [];
    const tools = new ToolRegistry();
    tools.register(createLoggedTool('look.slow', log, { risk: 'safe', readOnly: true }, () => turns(30)));
    tools.register(createLoggedTool('look.broken', log, { risk: 'safe', readOnly: true }));
    const approvals: ApprovalPolicy = {
      async approve({ call: asked }) {
        if (asked.toolName === 'look.broken') {
          throw new Error('the policy fell over');
        }
        return true;
      },
    };
    const store = new InMemorySessionStore();
    const calls = order.map((id) => call(id, id === 's' ? 'look.slow' : 'look.broken'));
    const runner = new AgentRunner({ provider: createScript(calls), tools, store, approvals });
    await runner.initialize();

    await assert.rejects(runAs(runner, 'throw-1'), /the policy fell over/);
    // Nothing of the turn is still running once it has ended.
    assert.deepEqual(log, ['look.slow:start', 'look.slow:end']);
    // A call ahead of the failure keeps its result; the failed one, and any
    // behind it, have none, so what is saved is still a prefix.
    assert.deepEqual(toolResultIds(await store.get('throw-1')), [...recorded]);
    await turns(5);
    assert.deepEqual(unhandled, []);
  });
}

test('a result that cannot be saved ends the turn only after the rest of its batch has settled', async () => {
  const log: string[] = [];
  const tools = new ToolRegistry();
  tools.register(createLoggedTool('look.fast', log, { risk: 'safe', readOnly: true }, async () => undefined));
  tools.register(createLoggedTool('look.slow', log, { risk: 'safe', readOnly: true }, () => turns(30)));
  const store = new InMemorySessionStore();
  let failed = false;
  // The disk fails once, on the save that would hold the first result.
  const flaky: InMemorySessionStore = Object.assign(Object.create(store) as InMemorySessionStore, {
    async save(session: Session): Promise<void> {
      if (!failed && toolResultIds(session).length > 0) {
        failed = true;
        throw new Error('disk I/O error');
      }
      await store.save(session);
    },
  });
  const runner = new AgentRunner({ provider: createScript([call('f', 'look.fast'), call('s', 'look.slow')]), tools, store: flaky });
  await runner.initialize();

  await assert.rejects(runAs(runner, 'save-1'), /disk I\/O error/);
  assert.ok(failed);
  // Nothing of the turn is still running once it has ended.
  assert.ok(log.includes('look.slow:end'), `the turn ended with a call still running: ${log.join(', ')}`);
});

test('skill.read declares itself read-only', () => {
  assert.equal(createSkillReadTool(new SkillRegistry()).readOnly, true);
});
