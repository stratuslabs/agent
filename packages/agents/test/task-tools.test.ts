import test from 'node:test';
import assert from 'node:assert/strict';

import { SESSION_TRUST_METADATA_KEY, type Session } from '@stratusagent/core';

import {
  CANCEL_TASK_TOOL_NAME,
  createTaskTools,
  DELEGATED_BY_METADATA_KEY,
  GATEWAY_ONLY_TOOL_NAMES,
  MESSAGE_TASK_TOOL_NAME,
  TASK_ID_METADATA_KEY,
  TASKS_TOOL_NAME,
  type TaskCancelAnswer,
  type TaskMessageAnswer,
  type TaskMessageInput,
  type TaskSummary,
  type TaskToolsHost,
} from '../src/index.ts';

// The agent's own view of its background tasks, and its way to
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

const fakeHost = (
  rows: TaskSummary[] = [],
  answer: TaskCancelAnswer = { kind: 'missing' },
  messaged: TaskMessageAnswer = { kind: 'queued', status: 'running' },
) => {
  const calls: Array<{ op: string; agentId: string; taskId?: string }> = [];
  const messages: TaskMessageInput[] = [];
  const host: TaskToolsHost = {
    async list(agentId) {
      calls.push({ op: 'list', agentId });
      return rows;
    },
    async cancel(taskId, agentId) {
      calls.push({ op: 'cancel', agentId, taskId });
      return answer;
    },
    async message(input) {
      messages.push(input);
      return messaged;
    },
  };
  return { host, calls, messages };
};

const toolsFor = (host: TaskToolsHost) => {
  const tools = createTaskTools(host, { now: () => NOW });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return { list: byName.get(TASKS_TOOL_NAME)!, cancel: byName.get(CANCEL_TASK_TOOL_NAME)!, message: byName.get(MESSAGE_TASK_TOOL_NAME)! };
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

// agent.messageTask: a follow-up from the conversation that started a task,
// passed into its worker's running turn at its next step. The host decides
// whether the task takes it; the tool scopes the call to the calling agent
// and conversation, keys it on the call, and says what happened.

test('agent.messageTask is safe until outside content is read, then gated, and gateway-only', () => {
  const { message } = toolsFor(fakeHost().host);
  assert.equal(message.risk, 'safe');
  assert.equal(message.riskAfterExternalContent, 'gated');
  assert.ok(GATEWAY_ONLY_TOOL_NAMES.includes(MESSAGE_TASK_TOOL_NAME));
});

test('agent.messageTask passes the follow-up with the conversation, the session\'s write trust and a key from the call', async () => {
  const { host, messages } = fakeHost();
  const caller = session('fixture:ava:C1', 'ava', { [SESSION_TRUST_METADATA_KEY]: 'external' });
  caller.messages = [
    { id: 'fixture:ava:C1:user:1', role: 'user', content: 'go', createdAt: '' },
    { id: 'fixture:ava:C1:assistant:2', role: 'assistant', content: '', createdAt: '', toolCalls: [{ id: 'call_0', toolName: MESSAGE_TASK_TOOL_NAME, input: {} }] },
  ];
  const output = await toolsFor(host).message.execute(
    { task: ' t_A ', message: '  Change Money: to Money planning:  ' },
    caller,
    { callId: 'call_0' },
  ) as Record<string, unknown>;
  assert.deepEqual(messages, [{
    taskId: 't_A',
    agentId: 'ava',
    originSessionId: 'fixture:ava:C1',
    text: 'Change Money: to Money planning:',
    trust: 'external',
    key: 'fixture:ava:C1:assistant:2#call_0',
  }]);
  assert.deepEqual([output.task, output.status, output.delivered], ['t_A', 'running', 'at_next_step']);
  assert.match(String(output.note), /next step/);
});

test('agent.messageTask keys a reused call id by the response that made it, so a later call with the same id is its own', async () => {
  const { host, messages } = fakeHost();
  const caller = session('fixture:ava:C1');
  caller.messages = [
    { id: 'm1', role: 'assistant', content: '', createdAt: '', toolCalls: [{ id: 'call_0', toolName: MESSAGE_TASK_TOOL_NAME, input: {} }] },
    { id: 'm2', role: 'tool', content: '', createdAt: '', toolResult: { callId: 'call_0', toolName: MESSAGE_TASK_TOOL_NAME, ok: true, output: null } },
    { id: 'm3', role: 'assistant', content: '', createdAt: '', toolCalls: [{ id: 'call_0', toolName: MESSAGE_TASK_TOOL_NAME, input: {} }] },
  ];
  await toolsFor(host).message.execute({ task: 't_A', message: 'two' }, caller, { callId: 'call_0' });
  assert.equal(messages[0]?.key, 'm3#call_0');
});

test('agent.messageTask with no call id passes no key, so the host never mistakes it for a repeat', async () => {
  const { host, messages } = fakeHost();
  await toolsFor(host).message.execute({ task: 't_A', message: 'hi' }, session('fixture:ava:C1'));
  assert.equal(messages[0]?.key, undefined);
});

test('agent.messageTask says when the same call was already passed on', async () => {
  const output = await toolsFor(fakeHost([], undefined, { kind: 'queued', status: 'running', already: true }).host)
    .message.execute({ task: 't_A', message: 'hi' }, session('fixture:ava:C1'), { callId: 'c1' }) as Record<string, unknown>;
  assert.equal(output.delivered, 'at_next_step');
  assert.match(String(output.note), /already passed on/);
});

test('agent.messageTask refusals are errors that say nothing was passed on', async () => {
  const cases: Array<[TaskMessageAnswer, RegExp]> = [
    [{ kind: 'missing' }, /No background task t_A of yours/],
    [{ kind: 'elsewhere' }, /Only the conversation that started background task t_A can send it follow-ups/],
    [{ kind: 'ended', status: 'completed' }, /t_A isn't taking follow-ups any more \(completed\)/],
    [{ kind: 'stopping' }, /A stop was already asked for background task t_A/],
  ];
  for (const [answer, error] of cases) {
    await assert.rejects(
      toolsFor(fakeHost([], undefined, answer).host).message.execute({ task: 't_A', message: 'hi' }, session('fixture:ava:C1')),
      (thrown: Error) => error.test(thrown.message) && (answer.kind === 'missing' || /[Nn]othing was passed on/.test(thrown.message)),
    );
  }
});

test('agent.messageTask needs a task id and a message', async () => {
  const { host, messages } = fakeHost();
  for (const input of [{ message: 'hi' }, { task: '  ', message: 'hi' }, { task: 5, message: 'hi' }]) {
    await assert.rejects(toolsFor(host).message.execute(input as never, session('fixture:ava:C1')), /needs "task"/);
  }
  for (const input of [{ task: 't_A' }, { task: 't_A', message: '   ' }, { task: 't_A', message: 7 }]) {
    await assert.rejects(toolsFor(host).message.execute(input as never, session('fixture:ava:C1')), /needs "message"/);
  }
  assert.deepEqual(messages, []);
});

test('a delegated session or a task worker can\'t message tasks', async () => {
  const { host, messages } = fakeHost();
  const { message } = toolsFor(host);
  const delegated = session('fixture:ava:C1:delegate:ava:1:abc', 'ava', { [DELEGATED_BY_METADATA_KEY]: 'ava' });
  const worker = session('fixture:ava:C1:delegate:ava:1:t_A', 'ava', { [DELEGATED_BY_METADATA_KEY]: 'ava', [TASK_ID_METADATA_KEY]: 't_A' });
  for (const caller of [delegated, worker]) {
    await assert.rejects(message.execute({ task: 't_A', message: 'hi' }, caller), /can't message background tasks/);
  }
  assert.deepEqual(messages, []);
});
