import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  HostRefusalError,
  MEMORY_SAVE_PASS_INSTRUCTION,
  MEMORY_SAVE_PASS_REQUEST,
  type AgentMemoryStore,
  type JsonObject,
  type Message,
  type Session,
  type StratusEvent,
} from '@stratusagent/core';
import {
  agentMemoryPassesFileIn,
  agentMemoryShadowFileIn,
  createFileMemoryStore,
  createMemoryPassLedger,
  memoryPassEntries,
  type MemoryPassRecord,
} from '@stratusagent/state';

import { createMemoryPassHost, takeSaveSlice, type MemoryPassModelRun } from '../src/memory-passes.ts';

const AGENT = 'ava';

const message = (id: string, createdAt: string, content: string, role: Message['role'] = 'user'): Message =>
  ({ id, role, content, createdAt });

const sessionOf = (id: string, messages: Message[], metadata: JsonObject = {}): Session => ({
  id,
  agent: { id: AGENT, name: 'Ava' },
  status: 'completed',
  messages,
  createdAt: messages[0]?.createdAt ?? '2026-11-01T00:00:00.000Z',
  updatedAt: messages.at(-1)?.createdAt ?? '2026-11-01T00:00:00.000Z',
  // A session a turn has run in carries its label; the operator's own is `user`.
  metadata: { sessionTrust: 'user', ...metadata },
});

/** The gateway's single-flight chain, as the host sees it. */
const chainOf = () => {
  const chains = new Map<string, Promise<unknown>>();
  return {
    idle: (sessionId: string) => !chains.has(sessionId),
    queue<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
      const previous = chains.get(sessionId) ?? Promise.resolve();
      const turn = previous.then(work, work);
      const settled = turn.catch(() => {});
      chains.set(sessionId, settled);
      void settled.finally(() => {
        if (chains.get(sessionId) === settled) {
          chains.delete(sessionId);
        }
      });
      return turn;
    },
  };
};

/** A model that saves what it is told to, through the pass's own remember. */
type Script = (run: MemoryPassModelRun, remember: (input: JsonObject) => Promise<unknown>) => Promise<void>;

const saves = (...facts: string[]): Script => async (_run, remember) => {
  for (const fact of facts) {
    await remember({ fact, kind: 'semantic' });
  }
};

const setup = async (t: test.TestContext, options: { clock?: () => Date } = {}) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'memory-pass-host-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const memory: AgentMemoryStore = createFileMemoryStore(path.join(home, 'memory.jsonl'));
  const sessions = new Map<string, Session>();
  const chain = chainOf();
  const events: StratusEvent[] = [];
  const runs: MemoryPassModelRun[] = [];
  let script: Script = saves();
  let ids = 0;
  let clock = Date.parse('2026-11-01T01:00:00.000Z');
  const host = createMemoryPassHost({
    stateDir: home,
    run: 'run-1',
    memory,
    sessions: { get: async (id) => sessions.get(id) },
    chain,
    hasAgent: (id) => id === AGENT,
    isSubAgentSession: (session) => session.metadata?.subAgent === true,
    defaultModel: async () => 'model-a',
    async runModel(run) {
      runs.push(run);
      const passSession = sessionOf(run.sessionId, []);
      const remember = (input: JsonObject) => run.tools.find((tool) => tool.name === 'memory.remember')!.execute(input, passSession, {} as never);
      await script(run, remember);
    },
    emit: (event) => events.push(event),
    log: () => {},
    now: options.clock ?? (() => new Date(clock)),
    passId: () => `p${++ids}`,
  });
  const ledger = createMemoryPassLedger(agentMemoryPassesFileIn(home, AGENT));
  return {
    home,
    memory,
    sessions,
    chain,
    events,
    runs,
    host,
    ledger,
    setScript: (next: Script) => { script = next; },
    tick: (ms: number) => { clock += ms; },
  };
};

const at = (minute: number): string => new Date(Date.parse('2026-11-01T01:00:00.000Z') + minute * 60_000).toISOString();

test('a pass for an agent and mode not started is skipped, and nothing is read or written', async (t) => {
  const env = await setup(t);
  env.sessions.set('s1', sessionOf('s1', [message('m1', at(1), 'Ava prefers tea.')]));
  const outcome = await env.host.handle.run({ kind: 'save', agentId: AGENT, sessionId: 's1', reason: 'quiet' });
  assert.equal(outcome.status, 'skipped');
  assert.equal(outcome.reason, 'not-started');
  assert.equal(env.runs.length, 0);
  assert.deepEqual(await env.ledger.read(), []);
  assert.equal(env.events.length, 1);
  assert.equal((env.events[0] as { type: string }).type, 'memory.pass-completed');
});

test('start writes one start record per run and mode, and asking again changes nothing', async (t) => {
  const env = await setup(t);
  const first = await env.host.handle.start(AGENT, 'write');
  env.tick(60_000);
  const second = await env.host.handle.start(AGENT, 'write');
  assert.deepEqual(second, first);
  await env.host.handle.start(AGENT, 'shadow');
  const records = await env.ledger.read();
  assert.deepEqual(records.map((record) => [record.type, (record as { mode?: string }).mode]), [['start', 'write'], ['start', 'shadow']]);
  await assert.rejects(env.host.handle.start('nobody', 'write'), /no agent nobody/);
  await assert.rejects(env.host.handle.start(AGENT, 'sideways' as never), /mode must be/);
});

test('a save pass reads what was said after start, saves through its own remember, and moves the watermark', async (t) => {
  const env = await setup(t);
  env.sessions.set('s1', sessionOf('s1', [message('m0', at(-5), 'Said before upkeep was on.')]));
  await env.host.handle.start(AGENT, 'write');
  env.sessions.get('s1')!.messages.push(
    message('m1', at(1), 'Ava prefers tea in the morning.'),
    message('m2', at(2), 'Noted.', 'assistant'),
  );
  env.setScript(saves('Ava prefers tea in the morning.'));
  const outcome = await env.host.handle.run({ kind: 'save', agentId: AGENT, sessionId: 's1', reason: 'quiet' });
  assert.deepEqual(outcome, { passId: 'p1', status: 'done', saved: 1, superseded: 0, more: false });

  const [run] = env.runs;
  assert.equal(run!.sessionId, 'memory-pass:p1');
  assert.deepEqual(run!.tools.map((tool) => tool.name), ['memory.recall', 'memory.remember']);
  assert.ok(run!.prompt.startsWith(MEMORY_SAVE_PASS_REQUEST), 'the runtime speaks first');
  assert.ok(run!.prompt.endsWith(MEMORY_SAVE_PASS_INSTRUCTION), 'the request comes after the conversation');
  assert.match(run!.prompt, /<conversation>\n<message from="user">\nAva prefers tea in the morning\.\n<\/message>\n<message from="you">\nNoted\.\n<\/message>\n<\/conversation>/);
  assert.doesNotMatch(run!.prompt, /before upkeep/, 'nothing from before start is read');
  assert.equal(run!.trust, 'agent');

  const written = await memoryPassEntries(env.memory, AGENT, 'p1');
  assert.equal(written.length, 1);
  assert.deepEqual(written[0]!.metadata?.memoryPass, { id: 'p1', kind: 'save' });
  assert.equal(written[0]!.origin?.sessionId, 's1');

  const records = await env.ledger.read();
  const claim = records.find((record) => record.type === 'claim') as Extract<MemoryPassRecord, { type: 'claim' }>;
  assert.deepEqual(claim.slice, { from: 'm1', to: 'm2', count: 2 });
  assert.equal(claim.model, 'model-a');
  const end = records.find((record) => record.type === 'end') as Extract<MemoryPassRecord, { type: 'end' }>;
  assert.equal(end.status, 'done');
  assert.equal(end.released, false);
  assert.deepEqual(env.events.at(-1), {
    type: 'memory.pass-completed', sessionId: 'memory-pass:p1', agentId: AGENT, passId: 'p1', kind: 'save', mode: 'write',
    status: 'done', saved: 1, superseded: 0,
  });

  const again = await env.host.handle.run({ kind: 'save', agentId: AGENT, sessionId: 's1', reason: 'quiet' });
  assert.equal(again.status, 'nothing-new');
  assert.equal(env.runs.length, 1, 'a slice is read once');
});

test('only the conversations the request lists are read; a session with no channel always counts', async (t) => {
  const env = await setup(t);
  await env.host.handle.start(AGENT, 'write');
  const said = [message('m1', at(1), 'A fact.')];
  env.sessions.set('dm', sessionOf('dm', said, { channel: 'slack', conversation: { kind: 'direct' } }));
  env.sessions.set('pub', sessionOf('pub', said, { channel: 'slack', conversation: { kind: 'public' } }));
  env.sessions.set('nokind', sessionOf('nokind', said, { channel: 'slack' }));
  env.sessions.set('cli', sessionOf('cli', said));
  const ask = (sessionId: string, from?: ('direct' | 'public')[]) =>
    env.host.handle.run({ kind: 'save', agentId: AGENT, sessionId, reason: 'quiet', ...(from ? { from } : {}) });
  assert.equal((await ask('dm')).reason, 'conversation-kind', 'a DM is not read by default');
  assert.equal((await ask('nokind', ['direct', 'public'])).reason, 'conversation-kind', 'a channel that names no kind fails closed');
  assert.equal((await ask('pub')).status, 'done');
  assert.equal((await ask('cli')).status, 'done');
  assert.equal((await ask('dm', ['direct'])).status, 'done', 'listed, a DM is read');
});

test('a schedule firing is read only when the request says so, and a sub-agent or pass session never', async (t) => {
  const env = await setup(t);
  await env.host.handle.start(AGENT, 'write');
  const said = [message('m1', at(1), 'A fact.')];
  env.sessions.set('schedule:x', sessionOf('schedule:x', said, { scheduled: true }));
  env.sessions.set('sub', sessionOf('sub', said, { subAgent: true }));
  assert.equal((await env.host.handle.run({ kind: 'save', agentId: AGENT, sessionId: 'schedule:x', reason: 'quiet' })).reason, 'unattended');
  assert.equal((await env.host.handle.run({ kind: 'save', agentId: AGENT, sessionId: 'schedule:x', reason: 'quiet', scheduled: true })).status, 'done');
  assert.equal((await env.host.handle.run({ kind: 'save', agentId: AGENT, sessionId: 'sub', reason: 'quiet', scheduled: true })).reason, 'sub-agent');
  assert.equal((await env.host.handle.run({ kind: 'save', agentId: AGENT, sessionId: 'memory-pass:p1', reason: 'quiet' })).reason, 'sub-agent');
  assert.equal((await env.host.handle.run({ kind: 'save', agentId: AGENT, sessionId: 'gone', reason: 'quiet' })).reason, 'no-session');
});

test('a session with a turn running is skipped and nothing is claimed', async (t) => {
  const env = await setup(t);
  await env.host.handle.start(AGENT, 'write');
  env.sessions.set('s1', sessionOf('s1', [message('m1', at(1), 'A fact.')]));
  let finishTurn!: () => void;
  const turn = env.chain.queue('s1', () => new Promise<void>((resolve) => { finishTurn = resolve; }));
  const outcome = await env.host.handle.run({ kind: 'save', agentId: AGENT, sessionId: 's1', reason: 'quiet' });
  assert.equal(outcome.reason, 'turn-running');
  assert.equal((await env.ledger.read()).filter((record) => record.type === 'claim').length, 0);
  finishTurn();
  await turn;
});

test('a message that arrives while a pass takes its slice runs after that step and is not in the slice', async (t) => {
  const env = await setup(t);
  await env.host.handle.start(AGENT, 'write');
  const session = sessionOf('s1', [message('m1', at(1), 'Ava prefers tea.')]);
  env.sessions.set('s1', session);
  const order: string[] = [];
  // The next message arrives while the pass's step is loading the session,
  // so its turn queues behind that step on the same chain.
  let turn: Promise<void> | undefined;
  const get = env.sessions.get.bind(env.sessions);
  env.sessions.get = (id: string) => {
    if (turn === undefined) {
      order.push('step');
      turn = env.chain.queue('s1', async () => {
        order.push('turn');
        session.messages.push(message('m2', at(2), 'Also, Ava is in Lisbon.'));
      });
    }
    return get(id);
  };
  const outcome = await env.host.handle.run({ kind: 'save', agentId: AGENT, sessionId: 's1', reason: 'quiet' });
  await turn;
  assert.equal(outcome.status, 'done');
  assert.deepEqual(order, ['step', 'turn'], 'the turn waited for the step');
  const claim = (await env.ledger.read()).find((record) => record.type === 'claim') as Extract<MemoryPassRecord, { type: 'claim' }>;
  assert.deepEqual(claim.slice, { from: 'm1', to: 'm1', count: 1 }, 'the slice holds no part of the later turn');
  assert.doesNotMatch(env.runs[0]!.prompt, /Lisbon/);
  // The turn ran after the step: its message is the next pass's.
  const next = await env.host.handle.run({ kind: 'save', agentId: AGENT, sessionId: 's1', reason: 'quiet' });
  assert.equal(next.status, 'done');
  assert.match(env.runs[1]!.prompt, /Lisbon/);
  assert.doesNotMatch(env.runs[1]!.prompt, /prefers tea/);
});

test('a pass writes at its conversation\'s label: a session that read a web page writes external', async (t) => {
  const env = await setup(t);
  await env.host.handle.start(AGENT, 'write');
  env.sessions.set('s1', sessionOf('s1', [message('m1', at(1), 'Ava prefers tea.')], { sessionTrust: 'external' }));
  env.setScript(saves('Ava prefers tea.'));
  await env.host.handle.run({ kind: 'save', agentId: AGENT, sessionId: 's1', reason: 'quiet' });
  assert.equal(env.runs[0]!.trust, 'external');
  const [written] = await memoryPassEntries(env.memory, AGENT, 'p1');
  assert.equal(written!.trust, 'external');
});

test('a pass that fails before writing gives its slice back; one that wrote keeps it', async (t) => {
  const env = await setup(t);
  await env.host.handle.start(AGENT, 'write');
  env.sessions.set('s1', sessionOf('s1', [message('m1', at(1), 'Ava prefers tea.')]));
  env.setScript(async () => { throw new Error('provider unavailable'); });
  const failed = await env.host.handle.run({ kind: 'save', agentId: AGENT, sessionId: 's1', reason: 'quiet' });
  assert.deepEqual([failed.status, failed.reason], ['failed', 'model']);
  env.setScript(async () => { throw new HostRefusalError('The daily budget is spent.'); });
  const refused = await env.host.handle.run({ kind: 'save', agentId: AGENT, sessionId: 's1', reason: 'quiet' });
  assert.deepEqual([refused.status, refused.reason], ['failed', 'budget']);
  env.setScript(async (run, remember) => {
    await remember({ fact: 'Ava prefers tea.', kind: 'semantic' });
    throw new Error('provider went away after a save');
  });
  const half = await env.host.handle.run({ kind: 'save', agentId: AGENT, sessionId: 's1', reason: 'quiet' });
  assert.deepEqual([half.status, half.saved], ['failed', 1]);
  const ends = (await env.ledger.read()).filter((record) => record.type === 'end') as Extract<MemoryPassRecord, { type: 'end' }>[];
  assert.deepEqual(ends.map((end) => end.released), [true, true, false]);
  assert.equal(env.runs.length, 3, 'a released slice is read again');
  assert.equal((await env.host.handle.run({ kind: 'save', agentId: AGENT, sessionId: 's1', reason: 'quiet' })).status, 'nothing-new');
});

test('one pass per agent at a time', async (t) => {
  const env = await setup(t);
  await env.host.handle.start(AGENT, 'write');
  env.sessions.set('s1', sessionOf('s1', [message('m1', at(1), 'One.')]));
  env.sessions.set('s2', sessionOf('s2', [message('m2', at(1), 'Two.')]));
  let release!: () => void;
  env.setScript(() => new Promise<void>((resolve) => { release = resolve; }));
  const first = env.host.handle.run({ kind: 'save', agentId: AGENT, sessionId: 's1', reason: 'quiet' });
  while (env.runs.length === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const second = await env.host.handle.run({ kind: 'save', agentId: AGENT, sessionId: 's2', reason: 'quiet' });
  assert.equal(second.reason, 'pass-running');
  release();
  assert.equal((await first).status, 'done');
});

test('a stop aborts a running pass at once, settles it from what it wrote, then writes the stop', async (t) => {
  for (const wrote of [false, true]) {
    await t.test(wrote ? 'after a write: kept' : 'before a write: released', async (t) => {
      const env = await setup(t);
      await env.host.handle.start(AGENT, 'write');
      env.sessions.set('s1', sessionOf('s1', [message('m1', at(1), 'Ava prefers tea.')]));
      let thinking!: () => void;
      const midway = new Promise<void>((resolve) => { thinking = resolve; });
      env.setScript(async (run, remember) => {
        if (wrote) {
          await remember({ fact: 'Ava prefers tea.', kind: 'semantic' });
        }
        const stopped = new Promise((_resolve, reject) => run.signal.addEventListener('abort', () => reject(run.signal.reason)));
        thinking();
        await stopped;
      });
      const pass = env.host.handle.run({ kind: 'save', agentId: AGENT, sessionId: 's1', reason: 'quiet' });
      await midway;
      await env.host.close();
      const outcome = await pass;
      assert.deepEqual([outcome.status, outcome.reason, outcome.saved], ['interrupted', 'stopped', wrote ? 1 : 0]);
      const records = await env.ledger.read();
      assert.deepEqual(records.map((record) => record.type), ['start', 'claim', 'end', 'stop'], 'the end lands inside the activation');
      assert.equal((records[2] as Extract<MemoryPassRecord, { type: 'end' }>).released, !wrote);
      const late = await env.host.handle.run({ kind: 'save', agentId: AGENT, sessionId: 's1', reason: 'quiet' });
      assert.equal(late.reason, 'stopped');
    });
  }
});

test('a claim a crash left open is settled by the next start, after its start record', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'memory-pass-host-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const memory = createFileMemoryStore(path.join(home, 'memory.jsonl'));
  const ledger = createMemoryPassLedger(agentMemoryPassesFileIn(home, AGENT));
  const claim = (passId: string, to: string): MemoryPassRecord => ({
    type: 'claim', at: at(2), run: 'run-0', passId, kind: 'save', mode: 'write', model: 'm', sessionId: 's1', slice: { from: to, to, count: 1 },
  });
  await ledger.append({ type: 'start', at: at(0), run: 'run-0', mode: 'write' });
  await ledger.append(claim('wrote', 'm1'));
  await memory.append(AGENT, 'Ava prefers tea.', { metadata: { memoryPass: { id: 'wrote', kind: 'save' } } });
  await ledger.append(claim('empty', 'm2'));
  const host = createMemoryPassHost({
    stateDir: home, run: 'run-1', memory, sessions: { get: async () => undefined }, chain: chainOf(),
    hasAgent: () => true, isSubAgentSession: () => false, defaultModel: async () => 'm',
    runModel: async () => {}, emit: () => {}, log: () => {}, now: () => new Date(at(30)),
  });
  await host.handle.start(AGENT, 'write');
  const records = await ledger.read();
  assert.deepEqual(records.slice(3).map((record) => [record.type, record.run]), [['start', 'run-1'], ['end', 'run-1'], ['end', 'run-1']]);
  const ends = records.filter((record) => record.type === 'end') as Extract<MemoryPassRecord, { type: 'end' }>[];
  assert.deepEqual(ends.map((end) => [end.passId, end.status, end.released]), [['wrote', 'interrupted', false], ['empty', 'interrupted', true]]);
});

test('a shadow pass writes to the shadow file, never memory, and keeps its own watermark', async (t) => {
  const env = await setup(t);
  await env.host.handle.start(AGENT, 'write');
  await env.host.handle.start(AGENT, 'shadow');
  env.sessions.set('s1', sessionOf('s1', [message('m1', at(1), 'Ava prefers tea.')]));
  env.setScript(saves('Ava prefers tea.'));
  const shadow = await env.host.handle.run({ kind: 'save', agentId: AGENT, sessionId: 's1', reason: 'quiet', mode: 'shadow' });
  assert.deepEqual([shadow.status, shadow.saved], ['done', 1]);
  assert.equal((await env.memory.audit(AGENT)).length, 0, 'no real fact changes');
  const lines = (await readFile(agentMemoryShadowFileIn(env.home, AGENT), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].content, 'Ava prefers tea.');
  assert.deepEqual(lines[0].metadata.memoryPass, { id: 'p1', kind: 'save' });
  const write = await env.host.handle.run({ kind: 'save', agentId: AGENT, sessionId: 's1', reason: 'quiet' });
  assert.equal(write.status, 'done', 'a shadow claim does not move the write watermark');
});

test('the reads list passes newest first and show what each wrote: real facts for write, would-be facts for shadow', async (t) => {
  const env = await setup(t);
  assert.deepEqual(await env.host.passes(AGENT), [], 'no ledger reads as no passes');
  await env.host.handle.start(AGENT, 'write');
  await env.host.handle.start(AGENT, 'shadow');
  env.sessions.set('s1', sessionOf('s1', [message('m1', at(1), 'Ava prefers tea.')]));
  env.setScript(saves('Ava prefers tea.'));
  await env.host.handle.run({ kind: 'save', agentId: AGENT, sessionId: 's1', reason: 'quiet' });
  env.tick(60_000);
  await env.host.handle.run({ kind: 'save', agentId: AGENT, sessionId: 's1', reason: 'quiet', mode: 'shadow' });

  const listed = await env.host.passes(AGENT);
  assert.deepEqual(listed.map((pass) => [pass.passId, pass.mode, pass.status, pass.saved, pass.sessionId]), [
    ['p2', 'shadow', 'done', 1, 's1'],
    ['p1', 'write', 'done', 1, 's1'],
  ]);

  const write = await env.host.pass(AGENT, 'p1');
  assert.equal(write?.pass.passId, 'p1');
  assert.deepEqual(write?.entries.map((entry) => entry.content), ['Ava prefers tea.']);
  const shadow = await env.host.pass(AGENT, 'p2');
  assert.deepEqual(shadow?.entries.map((entry) => entry.content), ['Ava prefers tea.']);
  assert.equal((await env.memory.audit(AGENT)).length, 1, 'the shadow fact stays out of memory');
  assert.equal(await env.host.pass(AGENT, 'nope'), undefined);
  assert.deepEqual(await env.host.passes('someone-else'), []);
});

test('a ledger that cannot be read fails the pass instead of rejecting it', async (t) => {
  const env = await setup(t);
  await env.host.handle.start(AGENT, 'write');
  env.sessions.set('s1', sessionOf('s1', [message('m1', at(1), 'A fact.')]));
  const file = agentMemoryPassesFileIn(env.home, AGENT);
  await rm(file);
  await mkdir(file);
  const outcome = await env.host.handle.run({ kind: 'save', agentId: AGENT, sessionId: 's1', reason: 'quiet' });
  assert.deepEqual([outcome.status, outcome.reason], ['failed', 'state']);
  assert.equal(env.runs.length, 0);
});

test('a request that is not one is rejected; a tidy is refused until it is built', async (t) => {
  const env = await setup(t);
  await assert.rejects(env.host.handle.run({ kind: 'save', agentId: 'nobody', sessionId: 's1', reason: 'quiet' }), /no agent/);
  await assert.rejects(env.host.handle.run({ kind: 'save', agentId: AGENT, sessionId: '', reason: 'quiet' }), /sessionId/);
  await assert.rejects(env.host.handle.run({ kind: 'save', agentId: AGENT, sessionId: 's1', reason: 'bored' as never }), /reason/);
  await assert.rejects(env.host.handle.run({ kind: 'save', agentId: AGENT, sessionId: 's1', reason: 'quiet', from: ['everyone' as never] }), /from/);
  await assert.rejects(env.host.handle.run({ kind: 'nap' } as never), /kind must be/);
  const tidy = await env.host.handle.run({ kind: 'tidy', agentId: AGENT });
  assert.deepEqual([tidy.status, tidy.reason], ['skipped', 'tidy-unsupported']);
});

test('a slice stops at the byte cap and says more waits; a message alone over it is cut and the cut recorded', () => {
  const counts = () => true;
  const small = [message('a', at(1), 'x'.repeat(100)), message('b', at(2), 'y'.repeat(100)), message('c', at(3), 'z'.repeat(100))];
  const capped = takeSaveSlice(small, undefined, counts, 300)!;
  assert.deepEqual(capped.slice, { from: 'a', to: 'b', count: 2 });
  assert.equal(capped.more, true);
  const rest = takeSaveSlice(small, 'b', counts, 300)!;
  assert.deepEqual(rest.slice, { from: 'c', to: 'c', count: 1 });
  assert.equal(rest.more, false);

  const big = [message('huge', at(1), 'é'.repeat(400)), message('after', at(2), 'ok')];
  const cut = takeSaveSlice(big, undefined, counts, 300)!;
  assert.equal(cut.slice.to, 'huge');
  assert.equal(cut.slice.count, 1);
  assert.equal(cut.more, true);
  assert.ok(cut.slice.cut !== undefined && cut.slice.cut.messageId === 'huge' && cut.slice.cut.bytesOmitted > 0);
  assert.ok(!cut.entries[0]!.includes('�'), 'a character is never split');
  assert.match(cut.entries[0]!, /left out the last \d+ bytes/);
  assert.equal(takeSaveSlice(big, 'after', counts, 300), undefined);
  assert.equal(takeSaveSlice(small, undefined, () => false, 300), undefined, 'nothing written while upkeep was on is nothing new');
});
