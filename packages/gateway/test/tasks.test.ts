import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, symlink, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { fleetDbIn } from '@stratusagent/state';
import { SqliteScheduleStore } from '../src/index.ts';
import {
  SqliteTaskStore,
  TASK_RETENTION_MS,
  newTaskId,
  taskPromptDigest,
  type NewTask,
} from '../src/tasks.ts';

const newDb = async (): Promise<string> =>
  path.join(await mkdtemp(path.join(os.tmpdir(), 'stratus-tasks-')), 'fleet.db');

const T0 = '2026-11-13T14:00:00.000Z';
const at = (offsetMs: number): string => new Date(Date.parse(T0) + offsetMs).toISOString();

const newTask = (overrides: Partial<NewTask> = {}): NewTask => {
  const id = overrides.id ?? newTaskId();
  const workerAgentId = overrides.workerAgentId ?? 'atlas';
  const originSessionId = overrides.originSessionId ?? 'slack:C1:1794.1';
  return {
    id,
    agentId: 'atlas',
    workerAgentId,
    originSessionId,
    workerSessionId: `${originSessionId}:delegate:${workerAgentId}:1:${id}`,
    promptDigest: taskPromptDigest(workerAgentId, `job for ${id}`),
    ...overrides,
  };
};

// ---- ids and digests --------------------------------------------------------

test('a task id is t_ plus a ULID, and ids sort by the millisecond they were made', () => {
  const early = newTaskId(Date.parse(T0));
  const late = newTaskId(Date.parse(T0) + 1);
  assert.match(early, /^t_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.ok(early < late, `${early} sorts before ${late}`);
  assert.notEqual(newTaskId(Date.parse(T0)), newTaskId(Date.parse(T0)), 'two ids in one millisecond still differ');
});

test('the prompt digest covers the worker and the prompt, so the same prompt to another worker is another job', () => {
  assert.equal(taskPromptDigest('atlas', 'merge #512'), taskPromptDigest('atlas', 'merge #512'));
  assert.notEqual(taskPromptDigest('atlas', 'merge #512'), taskPromptDigest('blair', 'merge #512'));
  assert.notEqual(taskPromptDigest('atlas', 'merge #512'), taskPromptDigest('atlas', 'merge #513'));
  // The pair is encoded, not concatenated, so a boundary shift is a different job.
  assert.notEqual(taskPromptDigest('at', 'lasmerge'), taskPromptDigest('atlas', 'merge'));
});

// ---- the capacity claim -----------------------------------------------------

test('a claim writes the row as running and undelivered before anything starts', async () => {
  const store = new SqliteTaskStore(await newDb());
  const task = newTask();
  const claim = store.claim(task, 3, T0);
  assert.equal(claim.kind, 'started');
  const row = store.get(task.id);
  assert.ok(row);
  assert.equal(row.status, 'running');
  assert.equal(row.delivery, 'pending');
  assert.equal(row.workerSessionId, task.workerSessionId);
  assert.equal(row.createdAt, T0);
  assert.equal(row.stoppedBy, undefined);
  assert.equal(row.endedAt, undefined);
  store.close();
});

test('a claim past the per-agent cap starts nothing, and waiting on an approval still counts as running', async () => {
  const store = new SqliteTaskStore(await newDb());
  const a = newTask();
  const b = newTask();
  const c = newTask();
  assert.equal(store.claim(a, 2, T0).kind, 'started');
  assert.equal(store.claim(b, 2, T0).kind, 'started');
  store.setStatus(b.id, 'waiting_approval', at(1));
  const full = store.claim(c, 2, at(2));
  assert.deepEqual(full, { kind: 'full', running: 2, cap: 2 });
  assert.equal(store.get(c.id), undefined, 'no row for a refused claim');
  // Another agent's tasks don't count against atlas's cap.
  assert.equal(store.claim(newTask({ agentId: 'blair' }), 2, at(3)).kind, 'started');
  // A finished task frees its slot.
  store.setStatus(a.id, 'completed', at(4));
  assert.equal(store.claim(c, 2, at(5)).kind, 'started');
  store.close();
});

test('a claim through another connection to fleet.db counts against the cap: only one of two gets the last slot', async () => {
  const file = await newDb();
  const first = new SqliteTaskStore(file);
  const second = new SqliteTaskStore(file);
  first.claim(newTask(), 2, T0);
  const results = [first.claim(newTask(), 2, at(1)), second.claim(newTask(), 2, at(1))];
  assert.deepEqual(results.map((result) => result.kind).sort(), ['full', 'started']);
  first.close();
  second.close();
});

test('the same worker and prompt from the same conversation, still running, returns that task instead of a second one', async () => {
  const store = new SqliteTaskStore(await newDb());
  const digest = taskPromptDigest('atlas', 'get #512 merged');
  const first = newTask({ promptDigest: digest });
  assert.equal(store.claim(first, 3, T0).kind, 'started');
  const repeat = store.claim(newTask({ promptDigest: digest }), 3, at(1));
  assert.equal(repeat.kind, 'existing');
  assert.equal(repeat.kind === 'existing' ? repeat.task.id : '', first.id);
  // From another conversation it's a separate job.
  assert.equal(store.claim(newTask({ promptDigest: digest, originSessionId: 'slack:C1:1794.2' }), 3, at(2)).kind, 'started');
  // Once the first has ended, asking again starts a new one.
  store.setStatus(first.id, 'completed', at(3));
  assert.equal(store.claim(newTask({ promptDigest: digest }), 3, at(4)).kind, 'started');
  store.close();
});

test('a repeat of a running job is recognized even when the agent is at its cap', async () => {
  const store = new SqliteTaskStore(await newDb());
  const digest = taskPromptDigest('atlas', 'get #512 merged');
  const first = newTask({ promptDigest: digest });
  store.claim(first, 1, T0);
  const repeat = store.claim(newTask({ promptDigest: digest }), 1, at(1));
  assert.equal(repeat.kind, 'existing');
  store.close();
});

test('a cap below one is a programming error, not a silent refusal', async () => {
  const store = new SqliteTaskStore(await newDb());
  assert.throws(() => store.claim(newTask(), 0, T0), /cap/);
  assert.throws(() => store.claim(newTask(), 1.5, T0), /cap/);
  store.close();
});

// ---- status, stop and delivery ---------------------------------------------

test('a final status stamps ended_at once; a final row can be corrected to another final status but never reopened', async () => {
  const store = new SqliteTaskStore(await newDb());
  const task = newTask();
  store.claim(task, 3, T0);
  assert.equal(store.setStatus(task.id, 'running', at(1)), false, 'no change, no write');
  assert.equal(store.setStatus(task.id, 'completed', at(2)), true);
  assert.equal(store.get(task.id)?.endedAt, at(2));
  // A restore can show the worker was cut off after all: the row follows the transcript.
  assert.equal(store.setStatus(task.id, 'interrupted', at(3)), true);
  assert.equal(store.get(task.id)?.status, 'interrupted');
  assert.equal(store.get(task.id)?.endedAt, at(2), 'ended_at keeps when it first ended');
  assert.equal(store.setStatus(task.id, 'running', at(4)), false);
  assert.equal(store.setStatus(task.id, 'waiting_approval', at(4)), false);
  assert.equal(store.get(task.id)?.status, 'interrupted');
  assert.equal(store.setStatus('t_missing', 'completed', at(5)), false);
  store.close();
});

test('a stop is recorded once, on an open row only, and the first stopper is kept', async () => {
  const store = new SqliteTaskStore(await newDb());
  const task = newTask();
  store.claim(task, 3, T0);
  assert.equal(store.recordStop(task.id, 'U3QRT6Q0Y', at(1)), true);
  assert.equal(store.recordStop(task.id, 'cli', at(2)), false);
  assert.equal(store.get(task.id)?.stoppedBy, 'U3QRT6Q0Y');
  const done = newTask();
  store.claim(done, 3, at(3));
  store.setStatus(done.id, 'completed', at(4));
  assert.equal(store.recordStop(done.id, 'cli', at(5)), false, 'a finished task is not stopped');
  assert.equal(store.get(done.id)?.stoppedBy, undefined);
  store.close();
});

test('delivery moves from pending once, and only after the status is final', async () => {
  const store = new SqliteTaskStore(await newDb());
  const task = newTask();
  store.claim(task, 3, T0);
  assert.equal(store.setDelivery(task.id, 'delivered', at(1)), false, 'a running task has nothing to deliver yet');
  store.setStatus(task.id, 'completed', at(2));
  assert.equal(store.setDelivery(task.id, 'delivered', at(3)), true);
  assert.equal(store.setDelivery(task.id, 'dropped', at(4)), false);
  assert.equal(store.get(task.id)?.delivery, 'delivered');
  store.close();
});

test('unsettled lists every open row and every final row still owed a delivery, oldest first, and survives reopening', async () => {
  const file = await newDb();
  const store = new SqliteTaskStore(file);
  const running = newTask();
  const owed = newTask();
  const delivered = newTask();
  const dropped = newTask();
  store.claim(owed, 5, T0);
  store.claim(running, 5, at(1));
  store.claim(delivered, 5, at(2));
  store.claim(dropped, 5, at(3));
  store.setStatus(owed.id, 'failed', at(4));
  store.setStatus(delivered.id, 'completed', at(4));
  store.setDelivery(delivered.id, 'delivered', at(5));
  store.setStatus(dropped.id, 'cancelled', at(4));
  store.setDelivery(dropped.id, 'dropped', at(5));
  store.close();
  const reopened = new SqliteTaskStore(file);
  assert.deepEqual(reopened.unsettled().map((row) => row.id), [owed.id, running.id]);
  reopened.close();
});

// ---- retention -------------------------------------------------------------

test('a list: every open or undelivered task, newest first, then the most recent finished ones up to the limit, for one agent or all', async () => {
  const tasks = new SqliteTaskStore(await newDb());
  const make = (offsetMs: number, overrides: Partial<NewTask> = {}): string => {
    const task = newTask({ promptDigest: taskPromptDigest('atlas', `job ${offsetMs}`), ...overrides });
    assert.equal(tasks.claim(task, 100, at(offsetMs)).kind, 'started');
    return task.id;
  };
  const finish = (id: string, offsetMs: number, delivery: 'delivered' | 'dropped' | 'pending' = 'delivered'): void => {
    tasks.setStatus(id, 'completed', at(offsetMs));
    if (delivery !== 'pending') {
      tasks.setDelivery(id, delivery, at(offsetMs));
    }
  };
  const doneEarly = make(0);
  finish(doneEarly, 10_000);
  const doneLate = make(1_000);
  finish(doneLate, 20_000, 'dropped');
  const doneMiddle = make(2_000);
  finish(doneMiddle, 15_000);
  const owed = make(3_000);
  finish(owed, 4_000, 'pending');
  const running = make(5_000);
  const waiting = make(6_000);
  tasks.setStatus(waiting, 'waiting_approval', at(6_500));
  const othersId = make(7_000, { agentId: 'blair' });

  assert.deepEqual(tasks.list('atlas', 2).map((row) => row.id), [waiting, running, owed, doneLate, doneMiddle]);
  assert.deepEqual(tasks.list('atlas', 0).map((row) => row.id), [waiting, running, owed], 'open and owed rows are never cut');
  assert.deepEqual(tasks.list('blair', 10).map((row) => row.id), [othersId]);
  assert.deepEqual(tasks.list('nobody', 10), []);
  // The operator's list: every agent's, the finished limit across them all.
  assert.deepEqual(tasks.list(undefined, 2).map((row) => row.id), [othersId, waiting, running, owed, doneLate, doneMiddle]);
  assert.deepEqual(tasks.list(undefined, 10).map((row) => row.id), [othersId, waiting, running, owed, doneLate, doneMiddle, doneEarly]);
  tasks.close();
});

test('a conversation\'s open tasks: only the ones it started that are still running or waiting, oldest first', async () => {
  const tasks = new SqliteTaskStore(await newDb());
  const make = (offsetMs: number, overrides: Partial<NewTask> = {}): string => {
    const task = newTask({ promptDigest: taskPromptDigest('atlas', `job ${offsetMs}`), ...overrides });
    assert.equal(tasks.claim(task, 100, at(offsetMs)).kind, 'started');
    return task.id;
  };
  const here = 'slack:atlas:T1:C1:1794.1';
  const waiting = make(0, { originSessionId: here });
  tasks.setStatus(waiting, 'waiting_approval', at(500));
  const running = make(1_000, { originSessionId: here });
  const finished = make(2_000, { originSessionId: here });
  tasks.setStatus(finished, 'completed', at(2_500));
  make(3_000, { originSessionId: 'slack:atlas:T1:C1:1794.2' });

  assert.deepEqual(tasks.openForOrigin(here).map((row) => row.id), [waiting, running]);
  assert.deepEqual(tasks.openForOrigin('slack:atlas:T1:C9:1'), []);
  tasks.close();
});

test('pruning removes delivered and dropped rows past retention, and never an open or undelivered one', async () => {
  const store = new SqliteTaskStore(await newDb());
  const ended = (status: 'completed' | 'cancelled', delivery: 'delivered' | 'dropped' | undefined, base: number): string => {
    const task = newTask();
    store.claim(task, 10, at(base));
    store.setStatus(task.id, status, at(base + 1));
    if (delivery !== undefined) {
      store.setDelivery(task.id, delivery, at(base + 2));
    }
    return task.id;
  };
  const delivered = ended('completed', 'delivered', 0);
  const dropped = ended('cancelled', 'dropped', 0);
  const owed = ended('completed', undefined, 0);
  const open = newTask();
  store.claim(open, 10, T0);
  const later = 60_000;
  const fresh = ended('completed', 'delivered', later);
  const now = at(TASK_RETENTION_MS + 10);
  assert.equal(store.prune(now), 2);
  assert.equal(store.get(delivered), undefined);
  assert.equal(store.get(dropped), undefined);
  assert.ok(store.get(owed), 'still owed a notice');
  assert.ok(store.get(open.id), 'still running');
  assert.ok(store.get(fresh), 'last touched inside the window');
  store.close();
});

// ---- the file --------------------------------------------------------------

test('the task store shares fleet.db with schedules, owner-only, and refuses a linked file under a state home', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-tasks-home-'));
  const file = fleetDbIn(home);
  const schedules = new SqliteScheduleStore(file, { stateHome: home });
  const tasks = new SqliteTaskStore(file, { stateHome: home });
  tasks.claim(newTask(), 3, T0);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  schedules.close();
  tasks.close();

  const linkedHome = await mkdtemp(path.join(os.tmpdir(), 'stratus-tasks-linked-'));
  const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'stratus-tasks-elsewhere-'));
  const linked = fleetDbIn(linkedHome);
  await mkdir(path.dirname(linked), { recursive: true });
  await symlink(path.join(elsewhere, 'fleet.db'), linked);
  assert.throws(() => new SqliteTaskStore(linked, { stateHome: linkedHome }));
});
