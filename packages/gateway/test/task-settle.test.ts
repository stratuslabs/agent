import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  SESSION_TRUST_METADATA_KEY,
  recordTurnFailure,
  type Message,
  type Session,
  type TaskEvent,
  type TaskEventType,
  type TrustLevel,
} from '@stratusagent/core';
import { SqliteTaskStore, newTaskId, taskPromptDigest, type NewTask, type TaskRow } from '../src/tasks.ts';
import {
  TASK_CUT_OFF_ERROR,
  TASK_RESULT_LIMIT_BYTES,
  createTaskSettler,
  deriveTaskOutcome,
  taskFallbackKey,
  taskNoticeText,
  taskOutcomeKey,
  type TaskNotice,
  type TaskSettleHost,
} from '../src/task-settle.ts';

const T0 = '2026-11-13T14:00:00.000Z';

const newStore = async (): Promise<SqliteTaskStore> =>
  new SqliteTaskStore(path.join(await mkdtemp(path.join(os.tmpdir(), 'stratus-settle-')), 'fleet.db'));

const ORIGIN = 'slack:atlas:T1:C1:1794.1';

const newTask = (overrides: Partial<NewTask> = {}): NewTask => {
  const id = overrides.id ?? newTaskId();
  return {
    id,
    agentId: 'atlas',
    workerAgentId: 'atlas',
    originSessionId: ORIGIN,
    workerSessionId: `${ORIGIN}:delegate:atlas:1:${id}`,
    promptDigest: taskPromptDigest('atlas', `job for ${id}`),
    ...overrides,
  };
};

let counter = 0;
const message = (role: Message['role'], content: string, extra: Partial<Message> = {}): Message => {
  counter += 1;
  return { id: `m${counter}`, role, content, createdAt: T0, ...extra };
};

const session = (id: string, status: Session['status'], messages: Message[], trust: TrustLevel = 'agent'): Session => ({
  id,
  agent: { id: 'atlas', name: 'Atlas', instructions: '', tools: [], skills: [], delegates: [] },
  status,
  messages,
  createdAt: T0,
  updatedAt: T0,
  metadata: { [SESSION_TRUST_METADATA_KEY]: trust },
});

/** A worker whose one turn took `steps` responses and answered `reply`. */
const finishedWorker = (row: NewTask, reply: string, steps = 2, trust: TrustLevel = 'agent'): Session => {
  const messages: Message[] = [message('user', 'Do the job.')];
  for (let step = 1; step < steps; step += 1) {
    messages.push(message('assistant', '', { toolCalls: [{ id: `c${step}`, toolName: 'fs.read', input: {} }] }));
    messages.push(message('tool', '', { toolResult: { callId: `c${step}`, toolName: 'fs.read', ok: true, output: 'x', trust: 'agent' } }));
  }
  messages.push(message('assistant', reply));
  return session(row.workerSessionId, 'completed', messages, trust);
};

type OutcomeTurn = 'reply' | 'fails' | 'silent' | 'never-lands';

interface Fake {
  host: TaskSettleHost;
  sessions: Map<string, Session>;
  dispatched: TaskNotice[];
  appended: TaskNotice[];
  posted: TaskNotice[];
  cutOff: string[];
  warnings: string[];
  /** The task events settling sent, in order. */
  events: TaskEvent[];
  /** What the origin's keyed turn does when a notice is dispatched. */
  outcomeTurn: OutcomeTurn;
  dispatchThrows: boolean;
  appendThrows: boolean;
  /** The append resolves without writing anything, as an observe into a session that went away does. */
  appendLands: boolean;
  postThrows: boolean;
  /** Runs inside the dispatch, before it resolves: a second settle racing the first. */
  duringDispatch: (() => Promise<void>) | undefined;
}

const fakeHost = (tasks: SqliteTaskStore): Fake => {
  const fake: Fake = {
    sessions: new Map(),
    dispatched: [],
    appended: [],
    posted: [],
    cutOff: [],
    warnings: [],
    events: [],
    outcomeTurn: 'reply',
    dispatchThrows: false,
    appendThrows: false,
    appendLands: true,
    postThrows: false,
    duringDispatch: undefined,
    host: undefined as unknown as TaskSettleHost,
  };
  fake.host = {
    tasks,
    getSession: async (id) => {
      const stored = fake.sessions.get(id);
      return stored === undefined ? undefined : structuredClone(stored);
    },
    failCutOffTurn: async (id, error) => {
      fake.cutOff.push(id);
      const stored = fake.sessions.get(id);
      if (stored !== undefined) {
        recordTurnFailure(stored, error);
      }
    },
    dispatchNotice: async (notice) => {
      fake.dispatched.push(notice);
      await fake.duringDispatch?.();
      const origin = fake.sessions.get(notice.sessionId);
      if (origin !== undefined && fake.outcomeTurn !== 'never-lands') {
        origin.messages.push(message('user', notice.text, { idempotencyKey: notice.idempotencyKey }));
        if (fake.outcomeTurn === 'reply') {
          origin.messages.push(message('assistant', 'Your task is done.'));
          origin.status = 'completed';
        } else if (fake.outcomeTurn === 'fails') {
          recordTurnFailure(origin, 'provider exploded');
        } else {
          origin.status = 'completed';
        }
      }
      if (fake.dispatchThrows) {
        throw new Error('dispatch refused');
      }
      return origin;
    },
    appendFallback: async (notice) => {
      fake.appended.push(notice);
      if (fake.appendThrows) {
        throw new Error('store refused');
      }
      if (!fake.appendLands) {
        return undefined;
      }
      fake.sessions.get(notice.sessionId)?.messages.push(
        message('user', notice.text, { idempotencyKey: notice.idempotencyKey, overheard: true, observed: true }),
      );
    },
    postFallback: async (notice) => {
      fake.posted.push(notice);
      if (fake.postThrows) {
        throw new Error('slack said no');
      }
    },
    emit: async (event) => {
      fake.events.push(event);
    },
    now: () => T0,
    warn: (line) => {
      fake.warnings.push(line);
    },
  };
  return fake;
};

const claimed = (tasks: SqliteTaskStore, task: NewTask): TaskRow => {
  const claim = tasks.claim(task, 3, T0);
  assert.equal(claim.kind, 'started');
  return claim.task;
};

const setup = async (): Promise<{ tasks: SqliteTaskStore; fake: Fake; task: NewTask }> => {
  const tasks = await newStore();
  const fake = fakeHost(tasks);
  const task = newTask();
  claimed(tasks, task);
  fake.sessions.set(ORIGIN, session(ORIGIN, 'completed', [message('user', 'start a job'), message('assistant', 'Started it.')]));
  return { tasks, fake, task };
};

// ---- deriving the outcome from the worker session ---------------------------

test('a worker that finished is completed with its reply, even when a stop was recorded after', () => {
  const task = newTask();
  const worker = finishedWorker(task, 'All done.', 3);
  assert.deepEqual(deriveTaskOutcome({ status: 'running' }, worker), { status: 'completed', steps: 3, reply: 'All done.' });
  assert.deepEqual(
    deriveTaskOutcome({ status: 'running', stoppedBy: 'U123' }, worker),
    { status: 'completed', steps: 3, reply: 'All done.', stoppedBy: 'U123' },
  );
  worker.status = 'idle';
  assert.equal(deriveTaskOutcome({ status: 'running' }, worker)?.status, 'completed');
});

test('one response saved as several assistant messages is one step', () => {
  const task = newTask();
  const worker = session(task.workerSessionId, 'completed', [
    message('user', 'Do the job.'),
    message('assistant', 'Reading it first.'),
    message('assistant', '', { toolCalls: [{ id: 'c1', toolName: 'fs.read', input: {} }] }),
    message('tool', '', { toolResult: { callId: 'c1', toolName: 'fs.read', ok: true, output: 'x', trust: 'agent' } }),
    message('assistant', 'Done.'),
  ]);
  assert.equal(deriveTaskOutcome({ status: 'running' }, worker)?.steps, 2);
});

test('a recorded stop makes anything but a finished worker cancelled, a start that never landed included', () => {
  const task = newTask();
  const failed = finishedWorker(task, 'partial', 2);
  recordTurnFailure(failed, 'Stopped by U123.');
  assert.deepEqual(deriveTaskOutcome({ status: 'running', stoppedBy: 'U123' }, failed), { status: 'cancelled', steps: 2, stoppedBy: 'U123' });
  assert.deepEqual(deriveTaskOutcome({ status: 'running', stoppedBy: 'cli' }, undefined), { status: 'cancelled', steps: 0, stoppedBy: 'cli', why: 'never-started' });
  // Started, stopped before its first response was saved: not "never started".
  const early = session(task.workerSessionId, 'running', [message('user', 'Do the job.')]);
  recordTurnFailure(early, 'Stopped by U123.');
  assert.deepEqual(deriveTaskOutcome({ status: 'running', stoppedBy: 'U123' }, early), { status: 'cancelled', steps: 0, stoppedBy: 'U123' });
  const cutOff = finishedWorker(task, 'partial', 2);
  recordTurnFailure(cutOff, TASK_CUT_OFF_ERROR);
  assert.equal(deriveTaskOutcome({ status: 'running', stoppedBy: 'dashboard' }, cutOff)?.status, 'cancelled');
});

test('no worker session, or one with no start message, never started', () => {
  const task = newTask();
  assert.deepEqual(deriveTaskOutcome({ status: 'running' }, undefined), { status: 'interrupted', steps: 0, why: 'never-started' });
  assert.deepEqual(
    deriveTaskOutcome({ status: 'running' }, session(task.workerSessionId, 'idle', [])),
    { status: 'interrupted', steps: 0, why: 'never-started' },
  );
});

test('a worker still in flight has no outcome yet', () => {
  const task = newTask();
  const worker = finishedWorker(task, 'x');
  worker.status = 'running';
  assert.equal(deriveTaskOutcome({ status: 'running' }, worker), undefined);
  worker.status = 'pending_approval';
  assert.equal(deriveTaskOutcome({ status: 'waiting_approval' }, worker), undefined);
});

test('the fixed cut-off error reads interrupted, lost in a restore when the row had already ended; any other failure is failed', () => {
  const task = newTask();
  const cutOff = finishedWorker(task, 'partial', 4);
  recordTurnFailure(cutOff, TASK_CUT_OFF_ERROR);
  assert.deepEqual(deriveTaskOutcome({ status: 'running' }, cutOff), { status: 'interrupted', steps: 4, why: 'cut-off' });
  assert.deepEqual(deriveTaskOutcome({ status: 'interrupted' }, cutOff), { status: 'interrupted', steps: 4, why: 'cut-off' });
  assert.deepEqual(deriveTaskOutcome({ status: 'completed' }, cutOff), { status: 'interrupted', steps: 4, why: 'lost-in-restore' });
  assert.deepEqual(deriveTaskOutcome({ status: 'failed' }, cutOff), { status: 'interrupted', steps: 4, why: 'lost-in-restore' });
  const failed = finishedWorker(task, 'partial', 1);
  recordTurnFailure(failed, 'rate limited');
  assert.deepEqual(deriveTaskOutcome({ status: 'running' }, failed), { status: 'failed', steps: 1, error: 'rate limited' });
});

// ---- the notice --------------------------------------------------------------

test('the notice says how the task ended, built from the row and the outcome alone', () => {
  const row = { id: 't_1', workerAgentId: 'atlas', workerSessionId: 'w' };
  assert.equal(
    taskNoticeText(row, { status: 'completed', steps: 23, reply: 'Merged it.' }),
    '[Background task t_1 (atlas) completed after 23 steps.\nResult: Merged it.]',
  );
  assert.equal(
    taskNoticeText(row, { status: 'completed', steps: 1, reply: 'Done.', stoppedBy: 'cli' }),
    '[Background task t_1 (atlas) completed after 1 step. The stop from the CLI came after it had finished.\nResult: Done.]',
  );
  assert.equal(
    taskNoticeText(row, { status: 'failed', steps: 2, error: 'rate limited' }),
    '[Background task t_1 (atlas) failed after 2 steps.\nError: rate limited]',
  );
  assert.equal(taskNoticeText(row, { status: 'cancelled', steps: 5, stoppedBy: 'U123' }), '[Background task t_1 (atlas) was stopped by U123 after 5 steps.]');
  assert.equal(taskNoticeText(row, { status: 'cancelled', steps: 0, stoppedBy: 'dashboard', why: 'never-started' }), '[Background task t_1 (atlas) was stopped from the dashboard before it started.]');
  assert.equal(taskNoticeText(row, { status: 'cancelled', steps: 0, stoppedBy: 'agent' }), '[Background task t_1 (atlas) was stopped by the agent before its first step finished.]');
  assert.match(taskNoticeText(row, { status: 'interrupted', steps: 0, why: 'never-started' }), /never started.*It was not run\.\]$/s);
  assert.match(taskNoticeText(row, { status: 'interrupted', steps: 4, why: 'cut-off' }), /interrupted after 4 steps: a restart cut it off, and it was not run again\.\]$/);
  assert.match(taskNoticeText(row, { status: 'interrupted', steps: 4, why: 'lost-in-restore' }), /result was lost in a restore, and it was not run again\.\]$/);
});

test('a result past 16 KB is cut on a character boundary and says so', () => {
  const row = { id: 't_1', workerAgentId: 'atlas', workerSessionId: 'w' };
  const long = 'é'.repeat(TASK_RESULT_LIMIT_BYTES);
  const text = taskNoticeText(row, { status: 'completed', steps: 1, reply: long });
  const result = text.slice(text.indexOf('Result: ') + 'Result: '.length);
  const kept = result.slice(0, result.indexOf('\n'));
  assert.equal(Buffer.byteLength(kept), TASK_RESULT_LIMIT_BYTES);
  assert.equal(kept, 'é'.repeat(TASK_RESULT_LIMIT_BYTES / 2));
  assert.match(result, /\n\(Cut at 16 KB of 32 KB\.\)\]$/);
  const short = taskNoticeText(row, { status: 'completed', steps: 1, reply: 'x'.repeat(TASK_RESULT_LIMIT_BYTES) });
  assert.doesNotMatch(short, /Cut at/);
});

// ---- settling ----------------------------------------------------------------

test('a finished worker settles completed and its notice is dispatched once, keyed, at the worker\'s label', async () => {
  const { tasks, fake, task } = await setup();
  fake.sessions.set(task.workerSessionId, finishedWorker(task, 'Merged it.', 3, 'external'));
  const settled = await createTaskSettler(fake.host).settle(task.id);
  assert.equal(settled.kind, 'settled');
  const row = tasks.get(task.id);
  assert.equal(row?.status, 'completed');
  assert.equal(row?.delivery, 'delivered');
  assert.equal(fake.dispatched.length, 1);
  assert.deepEqual(fake.dispatched[0], {
    taskId: task.id,
    sessionId: ORIGIN,
    agentId: 'atlas',
    idempotencyKey: taskOutcomeKey(task.id),
    text: `[Background task ${task.id} (atlas) completed after 3 steps.\nResult: Merged it.]`,
    trust: 'external',
  });
  assert.deepEqual([fake.appended, fake.posted], [[], []]);
});

test('a notice that carries none of the worker\'s words is the runtime\'s own, labeled agent', async () => {
  const { fake, task, tasks } = await setup();
  const worker = finishedWorker(task, 'partial');
  recordTurnFailure(worker, 'Stopped.');
  worker.metadata = { [SESSION_TRUST_METADATA_KEY]: 'external' };
  fake.sessions.set(task.workerSessionId, worker);
  tasks.recordStop(task.id, 'cli', T0);
  await createTaskSettler(fake.host).settle(task.id);
  assert.equal(fake.dispatched[0]?.trust, 'agent');
  assert.equal(tasks.get(task.id)?.status, 'cancelled');
});

test('a worker still running at a turn\'s end is left open and nothing is dispatched', async () => {
  const { tasks, fake, task } = await setup();
  const worker = finishedWorker(task, 'x');
  worker.status = 'pending_approval';
  fake.sessions.set(task.workerSessionId, worker);
  const settled = await createTaskSettler(fake.host).settle(task.id);
  assert.equal(settled.kind, 'open');
  assert.equal(tasks.get(task.id)?.status, 'waiting_approval');
  assert.deepEqual([fake.cutOff, fake.dispatched], [[], []]);
});

test('at startup a worker the last process left in flight is failed with the fixed error, reported interrupted, and not rerun', async () => {
  const { tasks, fake, task } = await setup();
  const worker = finishedWorker(task, 'half', 2);
  worker.status = 'running';
  fake.sessions.set(task.workerSessionId, worker);
  await createTaskSettler(fake.host).settle(task.id, { startup: true });
  assert.deepEqual(fake.cutOff, [task.workerSessionId]);
  assert.equal(fake.sessions.get(task.workerSessionId)?.lastError, TASK_CUT_OFF_ERROR);
  assert.equal(tasks.get(task.id)?.status, 'interrupted');
  assert.equal(tasks.get(task.id)?.delivery, 'delivered');
  assert.match(fake.dispatched[0]?.text ?? '', /a restart cut it off, and it was not run again/);
});

test('a stop recorded before a crash still settles cancelled at startup', async () => {
  const { tasks, fake, task } = await setup();
  const worker = finishedWorker(task, 'half', 2);
  worker.status = 'running';
  fake.sessions.set(task.workerSessionId, worker);
  tasks.recordStop(task.id, 'U123', T0);
  await createTaskSettler(fake.host).settle(task.id, { startup: true });
  assert.deepEqual(fake.cutOff, [task.workerSessionId]);
  assert.equal(tasks.get(task.id)?.status, 'cancelled');
  assert.match(fake.dispatched[0]?.text ?? '', /was stopped by U123 after 2 steps/);
});

test('a stop recorded while the startup sweep fails the worker counts: cancelled, not interrupted', async () => {
  const { tasks, fake, task } = await setup();
  const worker = finishedWorker(task, 'half', 2);
  worker.status = 'running';
  fake.sessions.set(task.workerSessionId, worker);
  const failCutOffTurn = fake.host.failCutOffTurn;
  fake.host.failCutOffTurn = async (id, error) => {
    // A cancel landing while the sweep waits on the worker session.
    tasks.recordStop(task.id, 'cli', T0);
    await failCutOffTurn(id, error);
  };
  await createTaskSettler(fake.host).settle(task.id, { startup: true });
  assert.equal(tasks.get(task.id)?.status, 'cancelled');
  assert.equal(tasks.get(task.id)?.stoppedBy, 'cli');
  assert.match(fake.dispatched[0]?.text ?? '', /was stopped from the CLI after 2 steps/);
});

test('a restored row that says completed over a worker caught mid-turn becomes interrupted, lost in the restore', async () => {
  const { tasks, fake, task } = await setup();
  const worker = finishedWorker(task, 'half', 2);
  worker.status = 'running';
  fake.sessions.set(task.workerSessionId, worker);
  tasks.setStatus(task.id, 'completed', T0);
  await createTaskSettler(fake.host).settle(task.id, { startup: true });
  assert.equal(tasks.get(task.id)?.status, 'interrupted');
  assert.match(fake.dispatched[0]?.text ?? '', /lost in a restore/);
});

test('an origin session that no longer exists drops the delivery and dispatches nothing', async () => {
  const { tasks, fake, task } = await setup();
  fake.sessions.set(task.workerSessionId, finishedWorker(task, 'done'));
  fake.sessions.delete(ORIGIN);
  await createTaskSettler(fake.host).settle(task.id);
  assert.equal(tasks.get(task.id)?.status, 'completed');
  assert.equal(tasks.get(task.id)?.delivery, 'dropped');
  assert.deepEqual(fake.dispatched, []);
});

test('an origin that already holds the answered notice is only marked delivered (a sweep after a crash)', async () => {
  const { tasks, fake, task } = await setup();
  fake.sessions.set(task.workerSessionId, finishedWorker(task, 'done'));
  fake.sessions.get(ORIGIN)?.messages.push(
    message('user', 'notice', { idempotencyKey: taskOutcomeKey(task.id) }),
    message('assistant', 'Told them.'),
  );
  await createTaskSettler(fake.host).settle(task.id, { startup: true });
  assert.equal(tasks.get(task.id)?.delivery, 'delivered');
  assert.deepEqual([fake.dispatched, fake.appended, fake.posted], [[], [], []]);
});

test('an origin turn the last process left running on the notice is dispatched again under the same key', async () => {
  const { tasks, fake, task } = await setup();
  fake.sessions.set(task.workerSessionId, finishedWorker(task, 'done'));
  const origin = fake.sessions.get(ORIGIN)!;
  origin.messages.push(message('user', 'notice', { idempotencyKey: taskOutcomeKey(task.id) }));
  origin.status = 'running';
  await createTaskSettler(fake.host).settle(task.id, { startup: true });
  assert.equal(fake.dispatched.length, 1);
  assert.equal(fake.dispatched[0]?.idempotencyKey, taskOutcomeKey(task.id));
  assert.equal(tasks.get(task.id)?.delivery, 'delivered');
});

for (const outcomeTurn of ['fails', 'silent'] as const) {
  test(`an outcome turn that ${outcomeTurn === 'fails' ? 'fails' : 'ends without a reply'} gets the fallback written first, then posted once`, async () => {
    const { tasks, fake, task } = await setup();
    fake.sessions.set(task.workerSessionId, finishedWorker(task, 'Merged it.', 1, 'external'));
    fake.outcomeTurn = outcomeTurn;
    await createTaskSettler(fake.host).settle(task.id);
    const text = `[Background task ${task.id} (atlas) completed after 1 step.\nResult: Merged it.]`;
    const fallback = { taskId: task.id, sessionId: ORIGIN, agentId: 'atlas', idempotencyKey: taskFallbackKey(task.id), text, trust: 'external' };
    assert.deepEqual(fake.appended, [fallback]);
    assert.deepEqual(fake.posted, [fallback]);
    assert.equal(tasks.get(task.id)?.delivery, 'delivered');
  });
}

test('a fallback already in the origin transcript is never written or posted again', async () => {
  const { tasks, fake, task } = await setup();
  fake.sessions.set(task.workerSessionId, finishedWorker(task, 'done'));
  const origin = fake.sessions.get(ORIGIN)!;
  origin.messages.push(message('user', 'notice', { idempotencyKey: taskOutcomeKey(task.id) }));
  recordTurnFailure(origin, 'provider exploded');
  origin.messages.push(message('user', 'fallback', { idempotencyKey: taskFallbackKey(task.id), overheard: true, observed: true }));
  await createTaskSettler(fake.host).settle(task.id, { startup: true });
  assert.deepEqual([fake.dispatched, fake.appended, fake.posted], [[], [], []]);
  assert.equal(tasks.get(task.id)?.delivery, 'delivered');
});

test('a failed fallback post is logged with the task id and the row still reads delivered', async () => {
  const { tasks, fake, task } = await setup();
  fake.sessions.set(task.workerSessionId, finishedWorker(task, 'done'));
  fake.outcomeTurn = 'fails';
  fake.postThrows = true;
  await createTaskSettler(fake.host).settle(task.id);
  assert.equal(fake.posted.length, 1);
  assert.equal(tasks.get(task.id)?.delivery, 'delivered');
  assert.ok(fake.warnings.some((line) => line.includes(task.id) && line.includes('slack said no')), fake.warnings.join('\n'));
});

test('a fallback the store refused is not posted, and the row stays pending for the next start', async () => {
  const { tasks, fake, task } = await setup();
  fake.sessions.set(task.workerSessionId, finishedWorker(task, 'done'));
  fake.outcomeTurn = 'fails';
  fake.appendThrows = true;
  await createTaskSettler(fake.host).settle(task.id);
  assert.deepEqual(fake.posted, []);
  assert.equal(tasks.get(task.id)?.delivery, 'pending');
  assert.ok(fake.warnings.some((line) => line.includes(task.id) && line.includes('store refused')), fake.warnings.join('\n'));
});

test('a fallback write that resolved without landing is not posted either', async () => {
  const { tasks, fake, task } = await setup();
  fake.sessions.set(task.workerSessionId, finishedWorker(task, 'done'));
  fake.outcomeTurn = 'silent';
  fake.appendLands = false;
  await createTaskSettler(fake.host).settle(task.id);
  assert.equal(fake.appended.length, 1);
  assert.deepEqual(fake.posted, []);
  assert.equal(tasks.get(task.id)?.delivery, 'pending');
});

test('delivery is judged from the transcript, not from whether the dispatch threw', async () => {
  const { tasks, fake, task } = await setup();
  fake.sessions.set(task.workerSessionId, finishedWorker(task, 'done'));
  fake.dispatchThrows = true;
  await createTaskSettler(fake.host).settle(task.id);
  assert.equal(tasks.get(task.id)?.delivery, 'delivered');

  const second = await setup();
  second.fake.sessions.set(second.task.workerSessionId, finishedWorker(second.task, 'done'));
  second.fake.dispatchThrows = true;
  second.fake.outcomeTurn = 'never-lands';
  await createTaskSettler(second.fake.host).settle(second.task.id);
  assert.equal(second.tasks.get(second.task.id)?.status, 'completed');
  assert.equal(second.tasks.get(second.task.id)?.delivery, 'pending');
  assert.deepEqual(second.fake.appended, []);
  assert.ok(second.fake.warnings.some((line) => line.includes(second.task.id) && line.includes('dispatch refused')));
});

test('two settles of one task at once dispatch one notice', async () => {
  const { fake, task } = await setup();
  fake.sessions.set(task.workerSessionId, finishedWorker(task, 'done'));
  const settler = createTaskSettler(fake.host);
  let second: Promise<unknown> | undefined;
  fake.duringDispatch = async () => {
    fake.duringDispatch = undefined;
    second = settler.settle(task.id);
  };
  await settler.settle(task.id);
  await second;
  assert.equal(fake.dispatched.length, 1);
});

test('a row already settled is left alone, and an unknown id is missing', async () => {
  const { tasks, fake, task } = await setup();
  fake.sessions.set(task.workerSessionId, finishedWorker(task, 'done'));
  const settler = createTaskSettler(fake.host);
  await settler.settle(task.id);
  // The worker's transcript deleted afterwards changes nothing about how the task ended.
  fake.sessions.delete(task.workerSessionId);
  await settler.settle(task.id, { startup: true });
  assert.equal(fake.dispatched.length, 1);
  assert.equal(tasks.get(task.id)?.status, 'completed');
  assert.equal(tasks.get(task.id)?.delivery, 'delivered');
  assert.deepEqual(await settler.settle('t_nope'), { kind: 'missing' });
});

// ---- task events -------------------------------------------------------------

/** The event for `task` ending as `type`: ids only. */
const ended = (task: NewTask, type: TaskEventType): TaskEvent => ({
  type,
  sessionId: ORIGIN,
  agentId: 'atlas',
  taskId: task.id,
  workerSessionId: task.workerSessionId,
  workerAgentId: 'atlas',
});

test('settling sends how the task ended once, ids only, before its notice goes out', async () => {
  const { fake, task } = await setup();
  fake.sessions.set(task.workerSessionId, finishedWorker(task, 'Merged it.'));
  let sentBeforeNotice: TaskEvent[] | undefined;
  fake.duringDispatch = async () => {
    sentBeforeNotice = [...fake.events];
  };
  const settler = createTaskSettler(fake.host);
  await settler.settle(task.id);
  // Settled again, at a turn's end or by a sweep: nothing more is sent.
  await settler.settle(task.id);
  await settler.settle(task.id, { startup: true });
  assert.deepEqual(fake.events, [ended(task, 'task.completed')]);
  assert.deepEqual(sentBeforeNotice, [ended(task, 'task.completed')]);
});

test('a failed, a stopped and a never-started task end as task.failed, task.cancelled and task.interrupted', async () => {
  const failed = await setup();
  const broken = finishedWorker(failed.task, 'partial');
  recordTurnFailure(broken, 'provider exploded');
  failed.fake.sessions.set(failed.task.workerSessionId, broken);
  await createTaskSettler(failed.fake.host).settle(failed.task.id);
  assert.deepEqual(failed.fake.events, [ended(failed.task, 'task.failed')]);

  const stopped = await setup();
  const halted = finishedWorker(stopped.task, 'partial');
  recordTurnFailure(halted, 'Stopped.');
  stopped.fake.sessions.set(stopped.task.workerSessionId, halted);
  stopped.tasks.recordStop(stopped.task.id, 'U123', T0);
  await createTaskSettler(stopped.fake.host).settle(stopped.task.id);
  assert.deepEqual(stopped.fake.events, [ended(stopped.task, 'task.cancelled')]);

  const never = await setup();
  await createTaskSettler(never.fake.host).settle(never.task.id);
  assert.equal(never.tasks.get(never.task.id)?.status, 'interrupted');
  assert.deepEqual(never.fake.events, [ended(never.task, 'task.interrupted')]);
});

test('a worker still in flight at a turn\'s end sends nothing, and the startup sweep that cuts it off sends task.interrupted', async () => {
  const { fake, task } = await setup();
  const worker = finishedWorker(task, 'half', 2);
  worker.status = 'running';
  fake.sessions.set(task.workerSessionId, worker);
  const settler = createTaskSettler(fake.host);
  assert.equal((await settler.settle(task.id)).kind, 'open');
  assert.deepEqual(fake.events, []);
  await settler.settle(task.id, { startup: true });
  assert.deepEqual(fake.events, [ended(task, 'task.interrupted')]);
});

test('a notice sent again after a crash sends no second end, and a restore that finds a finished task cut off sends task.interrupted', async () => {
  // The row ended before the crash; only its notice was still pending.
  const resent = await setup();
  resent.fake.sessions.set(resent.task.workerSessionId, finishedWorker(resent.task, 'done'));
  resent.tasks.setStatus(resent.task.id, 'completed', T0);
  await createTaskSettler(resent.fake.host).settle(resent.task.id, { startup: true });
  assert.equal(resent.fake.dispatched.length, 1);
  assert.deepEqual(resent.fake.events, []);

  // The row said completed, but the restored worker was caught mid-turn.
  const restored = await setup();
  const worker = finishedWorker(restored.task, 'half', 2);
  worker.status = 'running';
  restored.fake.sessions.set(restored.task.workerSessionId, worker);
  restored.tasks.setStatus(restored.task.id, 'completed', T0);
  await createTaskSettler(restored.fake.host).settle(restored.task.id, { startup: true });
  assert.deepEqual(restored.fake.events, [ended(restored.task, 'task.interrupted')]);
});
