import test from 'node:test';
import assert from 'node:assert/strict';

import type { JsonObject, Session } from '@stratusagent/core';
import {
  canonicalDestination,
  createMessageReadTool,
  createMessageSendTool,
  createScheduleTools,
  MESSAGE_READ_MAX_LIMIT,
  MESSAGE_READ_TEXT_BUDGET,
  describeCadence,
  nextFireAfter,
  parseCronExpression,
  parseInterval,
  SCHEDULE_CANCEL_TOOL_NAME,
  SCHEDULE_EVERY_TOOL_NAME,
  SCHEDULE_LIST_TOOL_NAME,
  type ScheduleCreateInput,
  type ScheduleRecord,
  type SchedulerHandle,
} from '../src/index.ts';

const sessionFor = (agentId: string, sessionId = 'sess-1'): Session => {
  const now = new Date().toISOString();
  return {
    id: sessionId,
    agent: { id: agentId, name: agentId },
    status: 'running',
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
};

// ---- cadence arithmetic ------------------------------------------------------

test('parseInterval reads one positive integer and one unit, nothing else', () => {
  assert.equal(parseInterval('90s'), 90_000);
  assert.equal(parseInterval('30m'), 1_800_000);
  assert.equal(parseInterval('2h'), 7_200_000);
  assert.equal(parseInterval('1d'), 86_400_000);
  for (const bad of ['', '10', 'm', '1.5h', '-5m', '0s', '10 m', '1w', '5ms']) {
    assert.equal(parseInterval(bad), undefined, `accepted: ${bad}`);
  }
});

test('cron parsing enforces five fields, ranges, and numeric values', () => {
  assert.throws(() => parseCronExpression('0 7 * *'), /five fields/);
  assert.throws(() => parseCronExpression('60 * * * *'), /out of range/);
  assert.throws(() => parseCronExpression('* 24 * * *'), /out of range/);
  assert.throws(() => parseCronExpression('* * * * mon'), /numbers only/);
  assert.throws(() => parseCronExpression('*/0 * * * *'), /step/);
  // Both 0 and 7 mean Sunday, so an expression using 7 matches a Sunday.
  const fields = parseCronExpression('0 7 * * 7');
  assert.ok(fields.daysOfWeek.has(0));
});

test('nextFireAfter advances an interval, searches a cron, and spends a one-shot', () => {
  const after = new Date(2026, 0, 15, 6, 30); // local, so the test is TZ-independent
  const everyNext = nextFireAfter({ kind: 'every', intervalMs: 60_000 }, after);
  assert.equal(everyNext?.getTime(), after.getTime() + 60_000);

  const cronNext = nextFireAfter({ kind: 'cron', expression: '0 7 * * *' }, after);
  assert.deepEqual(cronNext, new Date(2026, 0, 15, 7, 0));
  // From after 7am, the next 7am is tomorrow's.
  const cronFollowing = nextFireAfter({ kind: 'cron', expression: '0 7 * * *' }, cronNext!);
  assert.deepEqual(cronFollowing, new Date(2026, 0, 16, 7, 0));

  const future = new Date(Date.now() + 60_000).toISOString();
  assert.equal(nextFireAfter({ kind: 'at', at: future }, new Date())?.toISOString(), future);
  assert.equal(nextFireAfter({ kind: 'at', at: future }, new Date(Date.parse(future) + 1)), undefined);
});

test('a cron expression that matches no real date has no next fire', () => {
  assert.equal(nextFireAfter({ kind: 'cron', expression: '0 0 31 2 *' }, new Date()), undefined);
});

test('day-of-month and day-of-week are OR when both are restricted (vixie semantics)', () => {
  // Jan 15 2026 is a Thursday (dow 4). "1st of the month, and Mondays":
  // from the 15th, the next match is the first Monday, not Feb 1st.
  const after = new Date(2026, 0, 15, 12, 0);
  const next = nextFireAfter({ kind: 'cron', expression: '0 9 1 * 1' }, after);
  assert.deepEqual(next, new Date(2026, 0, 19, 9, 0));
});

test('describeCadence renders the operator-facing line', () => {
  assert.equal(describeCadence({ kind: 'every', intervalMs: 1_800_000 }), 'every 30m');
  assert.equal(describeCadence({ kind: 'cron', expression: '0 7 * * *' }), 'cron 0 7 * * *');
  assert.equal(describeCadence({ kind: 'at', at: '2026-09-01T07:00:00.000Z' }), 'once at 2026-09-01T07:00:00.000Z');
});

test('canonicalDestination normalizes the channel kind, never the native id', () => {
  assert.equal(canonicalDestination({ channel: 'Slack', to: 'C0123' }), 'slack:C0123');
  assert.notEqual(canonicalDestination({ channel: 'slack', to: 'c0123' }), 'slack:C0123');
});

// ---- schedule tools ----------------------------------------------------------

interface HandleCalls {
  created: ScheduleCreateInput[];
  cancelled: Array<{ agentId: string; scheduleId: string }>;
}

const fakeHandle = (records: ScheduleRecord[] = []): SchedulerHandle & HandleCalls => {
  const handle: SchedulerHandle & HandleCalls = {
    created: [],
    cancelled: [],
    async create(input) {
      handle.created.push(input);
      return {
        id: 'sched-1',
        agentId: input.agentId,
        cadence: input.cadence,
        prompt: input.prompt,
        ...(input.destination ? { destination: input.destination } : {}),
        createdAt: new Date().toISOString(),
        nextFireAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
    async list(agentId) {
      return records.filter((record) => record.agentId === agentId);
    },
    async cancel(agentId, scheduleId) {
      handle.cancelled.push({ agentId, scheduleId });
      return records.some((record) => record.id === scheduleId && record.agentId === agentId);
    },
  };
  return handle;
};

const toolNamed = (tools: ReturnType<typeof createScheduleTools>, name: string) => {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `no tool ${name}`);
  return tool;
};

test('the schedule toolset splits risk: creation is gated, list and cancel are safe', () => {
  const tools = createScheduleTools(fakeHandle());
  const byName = new Map(tools.map((tool) => [tool.name, tool.risk]));
  assert.equal(byName.get('schedule.every'), 'gated');
  assert.equal(byName.get('schedule.at'), 'gated');
  assert.equal(byName.get('schedule.list'), 'safe');
  assert.equal(byName.get('schedule.cancel'), 'safe');
});

test('schedule.every takes exactly one of an interval or a cron expression', async () => {
  const handle = fakeHandle();
  const every = toolNamed(createScheduleTools(handle), SCHEDULE_EVERY_TOOL_NAME);
  const session = sessionFor('ava');

  await assert.rejects(() => every.execute({ prompt: 'check' }, session), /exactly one/);
  await assert.rejects(() => every.execute({ every: '30m', cron: '0 7 * * *', prompt: 'check' }, session), /exactly one/);
  await assert.rejects(() => every.execute({ every: 'soonish', prompt: 'check' }, session), /Not an interval/);
  await assert.rejects(() => every.execute({ cron: 'every morning', prompt: 'check' }, session), /five fields/);
  await assert.rejects(() => every.execute({ every: '30m', prompt: '  ' }, session), /non-empty "prompt"/);

  await every.execute({ every: '30m', prompt: 'check the repo' }, session);
  assert.deepEqual(handle.created[0]?.cadence, { kind: 'every', intervalMs: 1_800_000 });
  assert.equal(handle.created[0]?.agentId, 'ava');
  assert.equal(handle.created[0]?.createdBy, 'sess-1');
  assert.equal(handle.created[0]?.destination, undefined);

  await every.execute(
    { cron: '0 7 * * *', prompt: 'morning report', destination: { channel: 'Slack', to: ' C0123 ' } },
    session,
  );
  assert.deepEqual(handle.created[1]?.cadence, { kind: 'cron', expression: '0 7 * * *' });
  assert.deepEqual(handle.created[1]?.destination, { channel: 'slack', to: 'C0123' });
});

test('a malformed destination is refused, never silently dropped', async () => {
  const handle = fakeHandle();
  const every = toolNamed(createScheduleTools(handle), SCHEDULE_EVERY_TOOL_NAME);
  await assert.rejects(
    () => every.execute({ every: '30m', prompt: 'check', destination: { channel: 'slack' } }, sessionFor('ava')),
    /"destination" must be/,
  );
  assert.equal(handle.created.length, 0);
});

test('schedule.at refuses the past and malformed timestamps', async () => {
  const handle = fakeHandle();
  const at = toolNamed(createScheduleTools(handle), 'schedule.at');
  const session = sessionFor('ava');
  await assert.rejects(() => at.execute({ at: 'tomorrow', prompt: 'x' }, session), /Not a timestamp/);
  await assert.rejects(() => at.execute({ at: '2020-01-01T00:00:00Z', prompt: 'x' }, session), /in the past/);
  await at.execute({ at: new Date(Date.now() + 60_000).toISOString(), prompt: 'remind me' }, session);
  assert.equal(handle.created[0]?.cadence.kind, 'at');
});

test('schedule.list and schedule.cancel act as the calling agent, never another', async () => {
  const records: ScheduleRecord[] = [
    {
      id: 'sched-ava',
      agentId: 'ava',
      cadence: { kind: 'every', intervalMs: 60_000 },
      prompt: 'mine',
      createdAt: new Date().toISOString(),
      nextFireAt: new Date().toISOString(),
    },
    {
      id: 'sched-bea',
      agentId: 'bea',
      cadence: { kind: 'every', intervalMs: 60_000 },
      prompt: 'not mine',
      createdAt: new Date().toISOString(),
      nextFireAt: new Date().toISOString(),
    },
  ];
  const handle = fakeHandle(records);
  const tools = createScheduleTools(handle);

  const listed = await toolNamed(tools, SCHEDULE_LIST_TOOL_NAME).execute({}, sessionFor('ava')) as {
    schedules: JsonObject[];
  };
  assert.deepEqual(listed.schedules.map((entry) => entry.id), ['sched-ava']);

  const cancel = toolNamed(tools, SCHEDULE_CANCEL_TOOL_NAME);
  await assert.rejects(() => cancel.execute({ id: 'sched-bea' }, sessionFor('ava')), /No schedule of yours/);
  const cancelled = await cancel.execute({ id: 'sched-ava' }, sessionFor('ava')) as JsonObject;
  assert.equal(cancelled.cancelled, true);
  assert.deepEqual(handle.cancelled.at(-1), { agentId: 'ava', scheduleId: 'sched-ava' });
});

// ---- message.send ------------------------------------------------------------

test('message.send is gated and names its destination for the policy', async () => {
  const sends: Array<{ agentId: string; destination: { channel: string; to: string }; text: string }> = [];
  const tool = createMessageSendTool(async (input) => {
    sends.push(input);
  });

  assert.equal(tool.risk, 'gated');
  assert.equal(tool.destinationFor?.({ destination: { channel: 'Slack', to: 'C9' }, text: 'x' }), 'slack:C9');
  // A malformed destination is judged by risk alone, not mis-canonicalized.
  assert.equal(tool.destinationFor?.({ destination: { channel: 'slack' }, text: 'x' }), undefined);

  await assert.rejects(() => tool.execute({ destination: { channel: 'slack' }, text: 'x' }, sessionFor('ava')), /requires "destination"/);
  await assert.rejects(() => tool.execute({ destination: { channel: 'slack', to: 'C9' }, text: '  ' }, sessionFor('ava')), /non-empty "text"/);

  const result = await tool.execute(
    { destination: { channel: 'slack', to: 'C9' }, text: 'all green' },
    sessionFor('ava'),
  ) as JsonObject;
  assert.deepEqual(sends, [{ agentId: 'ava', destination: { channel: 'slack', to: 'C9' }, text: 'all green' }]);
  assert.equal(result.destination, 'slack:C9');
  // A messenger that reports no id leaves none in the result, and no thread.
  assert.equal(result.id, undefined);
  assert.equal(result.thread, undefined);
});

test('message.send replies in a thread when given one, and returns the posted id', async () => {
  const sends: Array<Parameters<Parameters<typeof createMessageSendTool>[0]>[0]> = [];
  const tool = createMessageSendTool(async (input) => {
    sends.push(input);
    return { id: '1791400000.000100' };
  });

  const top = await tool.execute({ destination: { channel: 'slack', to: 'C9' }, text: 'report' }, sessionFor('ava')) as JsonObject;
  assert.equal(top.id, '1791400000.000100');
  // A top-level post is the root of its own thread.
  assert.equal(top.thread, '1791400000.000100');

  // The thread a send returned is the thread a later send names.
  const reply = await tool.execute(
    { destination: { channel: 'slack', to: 'C9' }, text: 'details', thread: ' 1791400000.000100 ' },
    sessionFor('ava'),
  ) as JsonObject;
  assert.equal(sends[1]?.thread, '1791400000.000100');
  // A reply hands back the root, not its own id, so a third send stays in
  // the same thread.
  assert.equal(reply.thread, '1791400000.000100');

  // The thread does not change what is judged: the same conversation is
  // the same destination, so a schedule's pre-authorization still matches.
  assert.equal(tool.destinationFor?.({ destination: { channel: 'slack', to: 'C9' }, text: 'x', thread: '1.2' }), 'slack:C9');

  await assert.rejects(
    () => tool.execute({ destination: { channel: 'slack', to: 'C9' }, text: 'x', thread: '  ' }, sessionFor('ava')),
    /message\.send: "thread" must be a non-empty string/,
  );
  await assert.rejects(
    () => tool.execute({ destination: { channel: 'slack', to: 'C9' }, text: 'x', thread: 12 }, sessionFor('ava')),
    /message\.send: "thread" must be a non-empty string/,
  );
  assert.equal(sends.length, 2);
});

test('message.read is gated and external, reads as the calling agent, and bounds the limit', async () => {
  const reads: Array<Parameters<Parameters<typeof createMessageReadTool>[0]>[0]> = [];
  const tool = createMessageReadTool(async (input) => {
    reads.push(input);
    return { messages: [{ id: '1.000001', author: 'U1', text: 'hi' }], more: false };
  });

  assert.equal(tool.risk, 'gated');
  assert.equal(tool.outputTrust, 'external');

  await assert.rejects(() => tool.execute({ source: { channel: 'slack' } }, sessionFor('ava')), /requires "source"/);
  await assert.rejects(() => tool.execute({ source: { channel: 'slack', to: 'C9' }, thread: '' }, sessionFor('ava')), /"thread" must be/);
  assert.equal(reads.length, 0, 'a malformed call reads nothing');

  const result = await tool.execute(
    { source: { channel: 'Slack', to: 'C9' }, thread: '1.000001', limit: 10_000 },
    sessionFor('ava'),
  ) as JsonObject;
  assert.deepEqual(reads, [{ agentId: 'ava', source: { channel: 'slack', to: 'C9' }, thread: '1.000001', limit: MESSAGE_READ_MAX_LIMIT }]);
  assert.equal(result.source, 'slack:C9');
  assert.equal(result.count, 1);

  await tool.execute({ source: { channel: 'slack', to: 'C9' } }, sessionFor('ava'));
  assert.equal(reads[1]?.limit, 50);
});

test('message.read is judged by its source, so always-allow cannot become a standing grant to every conversation', () => {
  const tool = createMessageReadTool(async () => ({ messages: [], more: false }));
  assert.equal(tool.destinationFor?.({ source: { channel: 'slack', to: 'C0123456789' } }), 'slack:C0123456789');
  assert.equal(tool.destinationFor?.({}), undefined);
});

test('message.read stops at its text budget and says there is more, cutting only a message too big to fit alone', async () => {
  // The budget counts the whole message as returned, so leave room for
  // its id and author beside the text.
  const half = 'x'.repeat(MESSAGE_READ_TEXT_BUDGET / 2 - JSON.stringify({ id: '3.000001', author: 'U1', text: '' }).length);
  const tool = createMessageReadTool(async () => ({
    messages: [
      { id: '3.000001', author: 'U1', text: half },
      { id: '2.000001', author: 'U1', text: half },
      { id: '1.000001', author: 'U1', text: 'one too many' },
    ],
    more: false,
  }));
  const result = await tool.execute({ source: { channel: 'slack', to: 'C9' } }, sessionFor('ava')) as JsonObject;
  assert.equal(result.count, 2);
  assert.equal(result.more, true);

  const huge = createMessageReadTool(async () => ({
    messages: [{ id: '1.000001', author: 'U1', text: 'y'.repeat(MESSAGE_READ_TEXT_BUDGET * 2) }, { id: '0.000001', author: 'U1', text: 'next' }],
    more: false,
  }));
  const cut = await huge.execute({ source: { channel: 'slack', to: 'C9' } }, sessionFor('ava')) as JsonObject;
  const messages = cut.messages as Array<{ text: string }>;
  assert.equal(messages.length, 1);
  assert.ok(messages[0]!.text.length < MESSAGE_READ_TEXT_BUDGET + 100);
  assert.match(messages[0]!.text, /the rest of this message is not shown\]$/);
  assert.equal(cut.more, true);
});

test('message.read counts names and file lists against its budget, not only the text', async () => {
  // Short posts with long attachment lists outgrew a text-only budget.
  const files = Array.from({ length: 200 }, (_, index) => `attachment-${index}-${'f'.repeat(80)}.pdf`);
  const tool = createMessageReadTool(async () => ({
    messages: Array.from({ length: 10 }, (_, index) => ({ id: `${index}.000001`, author: 'U1', authorName: 'Blair', text: 'see attached', files })),
    more: false,
  }));
  const result = await tool.execute({ source: { channel: 'slack', to: 'C9' } }, sessionFor('ava')) as JsonObject;
  assert.ok(JSON.stringify(result.messages).length <= MESSAGE_READ_TEXT_BUDGET + 100);
  assert.ok((result.count as number) < 10);
  assert.equal(result.more, true);

  // One message whose list alone is past the budget says how many files
  // it had rather than listing them.
  const many = Array.from({ length: 2000 }, (_, index) => `attachment-${index}-${'f'.repeat(80)}.pdf`);
  const single = createMessageReadTool(async () => ({ messages: [{ id: '1.000001', author: 'U1', text: 'all of them', files: many }], more: false }));
  const cut = await single.execute({ source: { channel: 'slack', to: 'C9' } }, sessionFor('ava')) as JsonObject;
  const first = (cut.messages as Array<{ text: string; files?: string[] }>)[0]!;
  assert.deepEqual(first.files, ['2000 files, not listed']);
  assert.ok(JSON.stringify(cut.messages).length <= MESSAGE_READ_TEXT_BUDGET);
  assert.equal(cut.more, true);
});
