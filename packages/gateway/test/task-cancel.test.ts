import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { recordTurnFailure, type AgentDefinition, type Message, type Session } from '@stratusagent/core';
import { fleetDbIn } from '@stratusagent/state';

import { createBackgroundTasks } from '../src/background-tasks.ts';
import { ShardedSessionStore } from '../src/sessions.ts';
import { taskOutcomeKey } from '../src/task-settle.ts';
import { SqliteTaskStore, type TaskRow } from '../src/tasks.ts';
import type { DispatchInput, GatewayOptions } from '../src/types.ts';

// AGT-357: cancelling a background task, at each point spec test 8 names.
// The background-task host runs here on stand-ins for the gateway's
// dispatch and chains, so each point can be held still: a worker link not
// yet started, a dispatch whose turn hasn't begun, a turn in flight, and a
// turn that has finished but not been settled. The gateway-level cases
// (a real turn stopped mid-flight, a crash between the stop and the abort)
// are in background-tasks.test.ts.

const ORIGIN = 'fixture:ava:C1';
const AVA = { id: 'ava', name: 'Ava', instructions: '', tools: [], skills: [], delegates: [] } as unknown as AgentDefinition;

let counter = 0;
const message = (role: Message['role'], content: string, extra: Partial<Message> = {}): Message => {
  counter += 1;
  return { id: `m${counter}`, role, content, createdAt: new Date().toISOString(), ...extra };
};

const until = async (what: string, check: () => Promise<boolean> | boolean, ms = 5_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/** How the stand-in worker dispatch behaves. */
type WorkerMode =
  /** Refused by its signal before its turn begins, as a dispatch whose start hasn't run is: no worker session. */
  | 'pre-turn'
  /** Its turn starts and runs until its signal is aborted, then fails as aborted with its session saved. */
  | 'mid-turn'
  /** Its turn finishes and is saved, then the dispatch waits for `release` before it resolves: finished, not settled. */
  | 'finish-then-hold';

const fixture = async (
  mode: WorkerMode,
  { holdWorkerLink = false, onRead }: { holdWorkerLink?: boolean; onRead?: (sessionId: string) => void } = {},
) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-task-cancel-'));
  const stateDir = path.join(home, '.stratus');
  await mkdir(stateDir, { recursive: true });
  const store = new ShardedSessionStore({ stateDir });
  await store.create({
    id: ORIGIN,
    agent: { id: 'ava', name: 'Ava' },
    status: 'completed',
    metadata: { channel: 'fixture' },
    messages: [message('user', 'start a job'), message('assistant', 'Started it.')],
  } as unknown as Session);

  const chains = new Map<string, Promise<unknown>>();
  const onChain = <T>(sessionId: string, work: () => Promise<T>): Promise<T> => {
    const next = (chains.get(sessionId) ?? Promise.resolve()).then(work, work);
    chains.set(sessionId, next.catch(() => {}));
    return next;
  };
  let openWorkerLink: () => void = () => {};
  const workerLinkGate = holdWorkerLink ? new Promise<void>((resolve) => { openWorkerLink = resolve; }) : Promise.resolve();
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });

  /** Each worker dispatch: whether its signal was already aborted when it was made. */
  const workerDispatches: Array<{ abortedAtStart: boolean }> = [];
  const aborted: Array<{ sessionId: string; reason: string }> = [];
  const warnings: string[] = [];

  const dispatchInternal = async (input: DispatchInput): Promise<Session> => {
    if (input.sessionId === ORIGIN) {
      // The outcome notice: a keyed turn the origin answers.
      const origin = (await store.get(ORIGIN))!;
      origin.messages.push(message('user', input.userMessage, { idempotencyKey: input.idempotencyKey! }));
      origin.messages.push(message('assistant', 'noted'));
      origin.status = 'completed';
      await store.save(origin);
      return origin;
    }
    const signal = input.signal!;
    workerDispatches.push({ abortedAtStart: signal.aborted });
    const abortedNow = (): Promise<never> => new Promise<never>((_resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    if (mode === 'pre-turn') {
      return abortedNow();
    }
    if (signal.aborted) {
      throw signal.reason;
    }
    const worker = await store.create({
      id: input.sessionId,
      agent: { id: 'ava', name: 'Ava' },
      status: 'running',
      metadata: input.metadata ?? {},
      messages: [message('user', input.userMessage)],
    } as unknown as Session);
    if (mode === 'mid-turn') {
      try {
        return await abortedNow();
      } catch (error) {
        const current = (await store.get(input.sessionId))!;
        recordTurnFailure(current, error instanceof Error ? error.message : String(error));
        await store.save(current);
        throw error;
      }
    }
    worker.messages.push(message('assistant', `did ${input.userMessage}`));
    worker.status = 'completed';
    await store.save(worker);
    await released;
    return worker;
  };

  // The host's reads go through here, so a case can act between a read and
  // what follows it.
  const seen = {
    get: async (sessionId: string) => {
      const session = await store.get(sessionId);
      onRead?.(sessionId);
      return session;
    },
    save: (session: Session) => store.save(session),
  } as unknown as ShardedSessionStore;
  const tasks = createBackgroundTasks({
    options: { tasks: { enabled: true } } as GatewayOptions,
    fleetDb: fleetDbIn(stateDir),
    stateHome: stateDir,
    store: seen,
    bus: { emit: async () => {} },
    dispatchInternal,
    onSessionChain: onChain,
    onWorkerChain: async (sessionId, work) => {
      await workerLinkGate;
      return onChain(sessionId, work);
    },
    settleRepeat: async () => undefined,
    observe: async () => { throw new Error('no fallback expected'); },
    postToOrigin: async () => { throw new Error('no fallback expected'); },
    abortTurns: (sessionId, reason) => {
      aborted.push({ sessionId, reason });
      return 0;
    },
    isStopping: () => false,
    refusal: () => new Error('stopping'),
    log: () => {},
    warn: (line) => warnings.push(line),
  });
  const rows = new SqliteTaskStore(fleetDbIn(stateDir), { stateHome: stateDir });

  const start = async (prompt = 'WORK'): Promise<TaskRow> => {
    const started = await tasks.start!({
      origin: (await store.get(ORIGIN))!,
      agent: AVA,
      prompt,
      workerSessionId: (id) => `${ORIGIN}:delegate:ava:1:${id}`,
      metadata: {},
    });
    return rows.get(started.task)!;
  };
  const settled = (taskId: string): Promise<TaskRow> => until(`task ${taskId} to settle`, () => {
    const row = rows.get(taskId);
    return row !== undefined && row.delivery !== 'pending';
  }).then(() => rows.get(taskId)!);
  const notice = async (taskId: string): Promise<string | undefined> =>
    (await store.get(ORIGIN))?.messages.find((candidate) => candidate.idempotencyKey === taskOutcomeKey(taskId))?.content;

  return {
    tasks,
    rows,
    store,
    start,
    settled,
    notice,
    workerDispatches,
    aborted,
    warnings,
    openWorkerLink: () => openWorkerLink(),
    release: () => release(),
    async close() {
      release();
      openWorkerLink();
      // A worker still waiting on its signal (a failed case) ends here.
      tasks.cutOff();
      await Promise.allSettled([...chains.values()]);
      rows.close();
      tasks.close();
      store.close();
    },
  };
};

test('cancel before the start dispatch: the stop is written first, the start is refused by its own signal, and it settles cancelled, never started', async () => {
  const f = await fixture('pre-turn', { holdWorkerLink: true });
  try {
    const row = await f.start();
    const result = await f.tasks.cancel(row.id, { stoppedBy: 'cli' });
    assert.equal(result.kind, 'stopping');
    assert.equal(f.rows.get(row.id)?.stoppedBy, 'cli', 'the stop is on the row before the worker link runs');
    assert.deepEqual(f.workerDispatches, [], 'nothing was dispatched yet');

    f.openWorkerLink();
    const final = await f.settled(row.id);
    assert.deepEqual(f.workerDispatches, [{ abortedAtStart: true }], 'the start went out already stopped');
    assert.deepEqual([final.status, final.stoppedBy, final.delivery], ['cancelled', 'cli', 'delivered']);
    assert.equal(await f.store.get(row.workerSessionId), undefined, 'no worker turn ran');
    assert.match((await f.notice(row.id)) ?? '', /was stopped from the CLI before it started\.\]$/);
  } finally {
    await f.close();
  }
});

test('cancel after the dispatch, before the worker\'s turn begins: the start is refused and it settles cancelled, never started', async () => {
  const f = await fixture('pre-turn');
  try {
    const row = await f.start();
    await until('the worker dispatch', () => f.workerDispatches.length === 1);
    assert.equal(f.workerDispatches[0]?.abortedAtStart, false);

    const result = await f.tasks.cancel(row.id, { stoppedBy: 'dashboard' });
    assert.equal(result.kind, 'stopping');
    const final = await f.settled(row.id);
    assert.deepEqual([final.status, final.stoppedBy], ['cancelled', 'dashboard']);
    assert.equal(await f.store.get(row.workerSessionId), undefined);
    assert.match((await f.notice(row.id)) ?? '', /was stopped from the dashboard before it started\.\]$/);
  } finally {
    await f.close();
  }
});

test('cancel mid-turn: the task\'s signal and the worker\'s running turn are both aborted, and it settles cancelled', async () => {
  const f = await fixture('mid-turn');
  try {
    const row = await f.start();
    await until('the worker turn to start', async () => (await f.store.get(row.workerSessionId))?.status === 'running');

    const result = await f.tasks.cancel(row.id, { stoppedBy: 'agent' });
    assert.equal(result.kind, 'stopping');
    assert.equal(result.kind === 'stopping' ? result.task.stoppedBy : undefined, 'agent');
    assert.deepEqual(f.aborted.map((call) => call.sessionId), [row.workerSessionId], 'the running turn is aborted as a backstop');
    assert.match(f.aborted[0]!.reason, new RegExp(`^Background task ${row.id} was stopped by the agent\\.$`));

    const final = await f.settled(row.id);
    assert.deepEqual([final.status, final.stoppedBy], ['cancelled', 'agent']);
    const worker = await f.store.get(row.workerSessionId);
    assert.equal(worker?.status, 'failed');
    assert.equal(worker?.lastError, f.aborted[0]!.reason, 'the worker failed with the stop, its session saved');
    assert.match((await f.notice(row.id)) ?? '', /was stopped by the agent before its first step finished\.\]$/);
  } finally {
    await f.close();
  }
});

test('cancel after the worker\'s turn finished, before settling: "already finished", no stop written, and it ends completed', async () => {
  const f = await fixture('finish-then-hold');
  try {
    const row = await f.start();
    await until('the worker turn to finish', async () => (await f.store.get(row.workerSessionId))?.status === 'completed');
    assert.equal(f.rows.get(row.id)?.status, 'running', 'not settled yet');

    const result = await f.tasks.cancel(row.id, { stoppedBy: 'cli' });
    assert.equal(result.kind, 'finished');
    assert.equal(f.rows.get(row.id)?.stoppedBy, undefined, 'no stop was written');
    assert.deepEqual(f.aborted, [], 'nothing was aborted');

    f.release();
    const final = await f.settled(row.id);
    assert.deepEqual([final.status, final.stoppedBy], ['completed', undefined]);
    const text = (await f.notice(row.id)) ?? '';
    assert.match(text, /completed after 1 step\.\nResult: did WORK\]$/);
    assert.doesNotMatch(text, /stop/);
  } finally {
    await f.close();
  }
});

test('a task already final, an unknown id, and another agent\'s task: nothing is written', async () => {
  const f = await fixture('mid-turn');
  try {
    const row = await f.start();
    await until('the worker turn to start', async () => (await f.store.get(row.workerSessionId))?.status === 'running');

    assert.deepEqual(await f.tasks.cancel('t_unknown', { stoppedBy: 'cli' }), { kind: 'missing' });
    assert.deepEqual(await f.tasks.cancel(row.id, { stoppedBy: 'agent', agentId: 'mia' }), { kind: 'missing' }, 'an agent cancels only its own tasks');
    assert.equal(f.rows.get(row.id)?.stoppedBy, undefined);
    assert.deepEqual(f.aborted, []);

    assert.equal((await f.tasks.cancel(row.id, { stoppedBy: 'agent', agentId: 'ava' })).kind, 'stopping');
    const final = await f.settled(row.id);
    assert.equal(final.status, 'cancelled');

    const again = await f.tasks.cancel(row.id, { stoppedBy: 'cli' });
    assert.equal(again.kind, 'finished');
    assert.equal(f.rows.get(row.id)?.stoppedBy, 'agent', 'the row is unchanged');
    assert.equal(f.aborted.length, 1, 'nothing more was aborted');
  } finally {
    await f.close();
  }
});

test('a second cancel while the first is stopping keeps the first stopper and aborts again', async () => {
  const f = await fixture('mid-turn');
  try {
    const row = await f.start();
    await until('the worker turn to start', async () => (await f.store.get(row.workerSessionId))?.status === 'running');
    // The first stop is recorded but its abort hasn't reached the turn: a
    // crash would leave this, and so does a turn that ignores its signal.
    f.rows.recordStop(row.id, 'U123', new Date().toISOString());

    const result = await f.tasks.cancel(row.id, { stoppedBy: 'cli' });
    assert.equal(result.kind, 'stopping');
    assert.equal(result.kind === 'stopping' ? result.already : undefined, true);
    assert.equal(f.rows.get(row.id)?.stoppedBy, 'U123');
    assert.match(f.aborted[0]?.reason ?? '', /was stopped by U123\.$/);
    const final = await f.settled(row.id);
    assert.deepEqual([final.status, final.stoppedBy], ['cancelled', 'U123']);
  } finally {
    await f.close();
  }
});

test('a task that settles while the cancel reads its worker is reported finished, with nothing written or aborted', async () => {
  let settleNow: ((sessionId: string) => void) | undefined;
  const f = await fixture('mid-turn', { onRead: (sessionId) => settleNow?.(sessionId) });
  try {
    const row = await f.start();
    await until('the worker turn to start', async () => (await f.store.get(row.workerSessionId))?.status === 'running');
    // Settling writes a final status after the cancel read the worker
    // session as running and before it records the stop.
    settleNow = (sessionId) => {
      if (sessionId === row.workerSessionId) {
        settleNow = undefined;
        f.rows.setStatus(row.id, 'failed', new Date().toISOString());
      }
    };
    const result = await f.tasks.cancel(row.id, { stoppedBy: 'cli' });
    assert.equal(result.kind, 'finished');
    assert.equal(f.rows.get(row.id)?.stoppedBy, undefined, 'no stop on a final row');
    assert.deepEqual(f.aborted, [], 'nothing was aborted');
  } finally {
    await f.close();
  }
});
