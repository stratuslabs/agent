import test from 'node:test';
import assert from 'node:assert/strict';

import type { Session } from '@stratusagent/core';

import {
  CANCEL_TASK_TOOL_NAME,
  createTaskTools,
  DELEGATED_BY_METADATA_KEY,
  GATEWAY_ONLY_TOOL_NAMES,
  TASK_ID_METADATA_KEY,
  TASKS_TOOL_NAME,
  type TaskCancelAnswer,
  type TaskSummary,
  type TaskToolsHost,
} from '../src/index.ts';

// AGT-357: the agent's own view of its background tasks, and its way to
// stop one. The host (the gateway) owns the table and the cancel; these
// tools scope every call to the calling agent and say what happened.

const NOW = Date.parse('2026-11-13T18:00:00.000Z');

const session = (id: string, agentId = 'ava', metadata: Record<string, unknown> = {}): Session => ({
  id,
  agent: { id: agentId, name: agentId, instructions: '', tools: [], skills: [], delegates: [] },
  status: 'running',
  messages: [],
  createdAt: '2026-11-13T17:00:00.000Z',
  updatedAt: '2026-11-13T17:00:00.000Z',
  metadata,
}) as unknown as Session;

const fakeHost = (rows: TaskSummary[] = [], answer: TaskCancelAnswer = { kind: 'missing' }) => {
  const calls: Array<{ op: string; agentId: string; taskId?: string }> = [];
  const host: TaskToolsHost = {
    async list(agentId) {
      calls.push({ op: 'list', agentId });
      return rows;
    },
    async cancel(taskId, agentId) {
      calls.push({ op: 'cancel', agentId, taskId });
      return answer;
    },
  };
  return { host, calls };
};

const toolsFor = (host: TaskToolsHost) => {
  const tools = createTaskTools(host, { now: () => NOW });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return { list: byName.get(TASKS_TOOL_NAME)!, cancel: byName.get(CANCEL_TASK_TOOL_NAME)! };
};

test('agent.tasks is safe, agent.cancelTask is gated, and both are gateway-only', () => {
  const { list, cancel } = toolsFor(fakeHost().host);
  assert.equal(list.risk, 'safe');
  assert.equal(cancel.risk, 'gated');
  assert.ok(GATEWAY_ONLY_TOOL_NAMES.includes(TASKS_TOOL_NAME));
  assert.ok(GATEWAY_ONLY_TOOL_NAMES.includes(CANCEL_TASK_TOOL_NAME));
});

test('agent.tasks lists the calling agent\'s tasks with their age', async () => {
  const rows: TaskSummary[] = [
    { task: 't_A', status: 'running', worker: 'ava', startedAt: '2026-11-13T17:58:30.000Z', steps: 3, delivery: 'pending' },
    { task: 't_B', status: 'completed', worker: 'mia', startedAt: '2026-11-13T15:45:00.000Z', endedAt: '2026-11-13T16:00:00.000Z', steps: 12, delivery: 'delivered' },
    { task: 't_C', status: 'cancelled', worker: 'ava', startedAt: '2026-11-10T18:00:00.000Z', endedAt: '2026-11-10T18:05:00.000Z', steps: 0, delivery: 'dropped', stoppedBy: 'U123' },
  ];
  const { host, calls } = fakeHost(rows);
  const output = await toolsFor(host).list.execute({}, session('fixture:ava:C1')) as { tasks: Array<Record<string, unknown>> };
  assert.deepEqual(calls, [{ op: 'list', agentId: 'ava' }]);
  assert.deepEqual(output.tasks.map((row) => [row.task, row.age]), [['t_A', '1m'], ['t_B', '2h 15m'], ['t_C', '3d']]);
  assert.equal(output.tasks[1]!.steps, 12);
  assert.equal(output.tasks[2]!.stoppedBy, 'U123');
});

test('agent.tasks with none says so', async () => {
  const output = await toolsFor(fakeHost([]).host).list.execute({}, session('fixture:ava:C1')) as { tasks: unknown[]; note?: string };
  assert.deepEqual(output.tasks, []);
  assert.match(output.note ?? '', /no background tasks/i);
});

test('agent.cancelTask stops one of the caller\'s own tasks and says the notice follows', async () => {
  const { host, calls } = fakeHost([], { kind: 'stopping', status: 'running' });
  const output = await toolsFor(host).cancel.execute({ task: '  t_A ' }, session('fixture:ava:C1')) as Record<string, unknown>;
  assert.deepEqual(calls, [{ op: 'cancel', agentId: 'ava', taskId: 't_A' }]);
  assert.equal(output.task, 't_A');
  assert.equal(output.stopped, true);
  assert.match(String(output.note), /notice/);
});

test('agent.cancelTask on a task that already finished stops nothing and says how it ended', async () => {
  const output = await toolsFor(fakeHost([], { kind: 'finished', status: 'completed' }).host)
    .cancel.execute({ task: 't_A' }, session('fixture:ava:C1')) as Record<string, unknown>;
  assert.equal(output.stopped, false);
  assert.equal(output.status, 'completed');
  assert.match(String(output.note), /already finished/);
});

test('agent.cancelTask on an unknown task, or another agent\'s, is an error that names the id', async () => {
  await assert.rejects(
    toolsFor(fakeHost([], { kind: 'missing' }).host).cancel.execute({ task: 't_X' }, session('fixture:ava:C1')),
    /No background task t_X of yours/,
  );
});

test('agent.cancelTask needs a task id', async () => {
  const { host, calls } = fakeHost();
  for (const input of [{}, { task: '' }, { task: '   ' }, { task: 5 }]) {
    await assert.rejects(toolsFor(host).cancel.execute(input as never, session('fixture:ava:C1')), /needs "task"/);
  }
  assert.deepEqual(calls, []);
});

test('a delegated session or a task worker can\'t cancel tasks', async () => {
  const { host, calls } = fakeHost([], { kind: 'stopping', status: 'running' });
  const { cancel } = toolsFor(host);
  const delegated = session('fixture:ava:C1:delegate:ava:1:abc', 'ava', { [DELEGATED_BY_METADATA_KEY]: 'ava' });
  const worker = session('fixture:ava:C1:delegate:ava:1:t_A', 'ava', { [DELEGATED_BY_METADATA_KEY]: 'ava', [TASK_ID_METADATA_KEY]: 't_A' });
  for (const caller of [delegated, worker]) {
    await assert.rejects(cancel.execute({ task: 't_A' }, caller), /can't cancel background tasks/);
  }
  assert.deepEqual(calls, []);
});
