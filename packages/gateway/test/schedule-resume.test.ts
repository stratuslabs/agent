import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  leastTrusted,
  SENDER_TRUST_METADATA_KEY,
  sessionTrustOf,
  sessionWriteTrust,
  type JsonObject,
  type StratusEvent,
} from '@stratusagent/core';
import type { ScheduleRecord } from '@stratusagent/agents';
import { fleetDbPath } from '@stratusagent/state';
import {
  createGateway,
  createSchedulerRuntime,
  SqliteScheduleStore,
  type PreviousRun,
  type SchedulerRuntimeOptions,
} from '../src/index.ts';

// Card 858 part 2: the next firing of a schedule starts from the run that
// stopped early. The previous session is the checkpoint, read when the
// next firing is claimed.

const newHome = async (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'stratus-resume-'));

const waitFor = async (condition: () => boolean, what: string, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

interface Fired {
  sessionId: string;
  userMessage: string;
  metadata: JsonObject;
}

const openAiReply = (message: object): Response =>
  new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', ...message } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const due = (): string => new Date(Date.now() - 5).toISOString();

const record = (overrides: Partial<ScheduleRecord> = {}): ScheduleRecord => ({
  id: 'sched-1',
  agentId: 'ava',
  cadence: { kind: 'every', intervalMs: 600_000 },
  prompt: 'check the repo',
  createdAt: new Date().toISOString(),
  trust: 'agent',
  nextFireAt: due(),
  ...overrides,
});

const stopped = (reply: string | undefined, trust: PreviousRun['trust'] = 'agent'): PreviousRun => ({
  status: 'completed',
  stoppedEarly: { reason: 'turn-limit', continuations: 0, at: '2026-10-29T10:00:00.000Z' },
  ...(reply !== undefined ? { reply } : {}),
  trust,
});

const finished = (status: PreviousRun['status'] = 'completed'): PreviousRun => ({ status, reply: 'all done', trust: 'agent' });

/** One firing of `row` through a fresh runtime; returns what it dispatched and the row after. */
const fireOnce = async (
  row: ScheduleRecord,
  runs: Record<string, PreviousRun>,
  overrides: Partial<SchedulerRuntimeOptions> = {},
): Promise<{ fired: Fired; after: ScheduleRecord | undefined; lines: string[] }> => {
  const home = await newHome();
  const store = new SqliteScheduleStore(path.join(home, 'fleet.db'));
  const fired: Fired[] = [];
  const lines: string[] = [];
  store.insert(row);
  const runtime = createSchedulerRuntime({
    store,
    dispatch: async (input) => {
      fired.push(input as Fired);
    },
    validateDestination: async () => {},
    sessionStatus: async (sessionId) => runs[sessionId]?.status,
    previousRun: async (sessionId) => runs[sessionId],
    hasAgent: () => true,
    limits: { minIntervalMs: 1, tickMs: 10, maxConcurrentPerAgent: 1 },
    log: (line) => lines.push(line),
    warn: (line) => lines.push(line),
    ...overrides,
  });
  await runtime.start();
  await waitFor(() => fired.length === 1, 'the firing');
  runtime.stop();
  await runtime.drain();
  const after = store.get(row.id);
  store.close();
  return { fired: fired[0]!, after, lines };
};

test('the firing after a run that stopped early starts from its summary, at the lower of the two labels', async () => {
  const previous = 'schedule:sched-1:2026-10-29T10:00:00.000Z';
  const { fired, after } = await fireOnce(
    record({ lastSessionId: previous }),
    { [previous]: stopped('Reviewed 3 of 5 PRs. Left: #12 and #14.', 'external') },
  );

  assert.ok(fired.userMessage.startsWith('check the repo\n\n'), 'the stored prompt comes first');
  assert.match(fired.userMessage, /last run of this schedule, at 2026-10-29T10:00:00\.000Z, stopped early/);
  assert.match(fired.userMessage, /Reviewed 3 of 5 PRs\. Left: #12 and #14\./);
  assert.match(fired.userMessage, /don't redo finished work/);
  assert.doesNotMatch(fired.userMessage, /in a row/, 'one stop is not a repeat');
  // The summary was written in a session that read a web page: it must not
  // come back at the schedule's own label.
  assert.equal(fired.metadata[SENDER_TRUST_METADATA_KEY], 'external');
  assert.equal(after?.stoppedEarlyStreak, 1);
  assert.deepEqual(after?.resumeFrom, { firing: fired.sessionId, from: previous });
  assert.equal(after?.lastSessionId, fired.sessionId);
});

test('a clean previous run that stopped early keeps the schedule\'s label', async () => {
  const previous = 'schedule:sched-1:prev';
  const { fired } = await fireOnce(record({ lastSessionId: previous, trust: 'agent' }), { [previous]: stopped('half done') });
  assert.equal(fired.metadata[SENDER_TRUST_METADATA_KEY], 'agent');
});

test('a second stop in a row says so, and asks for one line only when the schedule reports somewhere', async () => {
  const previous = 'schedule:sched-1:prev';
  const withDestination = await fireOnce(
    record({ lastSessionId: previous, stoppedEarlyStreak: 1, destination: { channel: 'slack', to: 'C-ENG' } }),
    { [previous]: stopped('still stuck on the build') },
  );
  assert.match(withDestination.fired.userMessage, /2nd run in a row to stop early/);
  assert.match(withDestination.fired.userMessage, /post one line to this schedule's report destination/);
  assert.equal(withDestination.after?.stoppedEarlyStreak, 2);

  const silent = await fireOnce(
    record({ lastSessionId: previous, stoppedEarlyStreak: 2 }),
    { [previous]: stopped('still stuck on the build') },
  );
  assert.match(silent.fired.userMessage, /3rd run in a row to stop early/);
  assert.doesNotMatch(silent.fired.userMessage, /report destination/, 'a schedule with no destination has nowhere to post');
  assert.equal(silent.after?.stoppedEarlyStreak, 3);
});

test('any other outcome starts fresh and resets the streak, a failed run included', async () => {
  for (const status of ['completed', 'failed'] as const) {
    const previous = 'schedule:sched-1:prev';
    const { fired, after } = await fireOnce(
      record({ lastSessionId: previous, stoppedEarlyStreak: 3, resumeFrom: { firing: previous, from: 'schedule:sched-1:older' } }),
      { [previous]: finished(status) },
    );
    assert.equal(fired.userMessage, 'check the repo', `${status}: the prompt alone`);
    assert.equal(fired.metadata[SENDER_TRUST_METADATA_KEY], 'agent');
    assert.equal(after?.stoppedEarlyStreak, undefined, `${status}: the streak is back to 0`);
    assert.equal(after?.resumeFrom, undefined, `${status}: nothing to resume from`);
  }
});

test('a stopped run that left no summary still says it stopped', async () => {
  const previous = 'schedule:sched-1:prev';
  const { fired } = await fireOnce(record({ lastSessionId: previous }), { [previous]: stopped(undefined) });
  assert.match(fired.userMessage, /stopped early/);
  assert.match(fired.userMessage, /left no summary/);
});

test('the summary is capped at 4 KB, on a character boundary, with a note', async () => {
  const previous = 'schedule:sched-1:prev';
  const { fired } = await fireOnce(record({ lastSessionId: previous }), { [previous]: stopped('é'.repeat(10_000)) });
  const summary = fired.userMessage.match(/é+/)?.[0] ?? '';
  assert.ok(Buffer.byteLength(summary) <= 4_096, `summary is ${Buffer.byteLength(summary)} bytes`);
  assert.ok(summary.length > 1_000, 'most of the 4 KB is kept');
  assert.doesNotMatch(fired.userMessage, /�/, 'no character split in half');
  assert.match(fired.userMessage, /\[summary cut at 4 KB\]/);
});

test('a firing that never started resumes from the checkpoint it carried, with the streak unchanged', async () => {
  const home = await newHome();
  const store = new SqliteScheduleStore(path.join(home, 'fleet.db'));
  const checkpoint = 'schedule:sched-1:x';
  const runs: Record<string, PreviousRun> = { [checkpoint]: stopped('X: did one, left two') };
  const base = {
    store,
    validateDestination: async () => {},
    sessionStatus: async (sessionId: string) => runs[sessionId]?.status,
    previousRun: async (sessionId: string) => runs[sessionId],
    hasAgent: () => true,
    limits: { minIntervalMs: 1, tickMs: 10, maxConcurrentPerAgent: 1 },
    log: () => {},
    warn: () => {},
  } satisfies Partial<SchedulerRuntimeOptions>;
  store.insert(record({ cadence: { kind: 'every', intervalMs: 300 }, lastSessionId: checkpoint, stoppedEarlyStreak: 1 }));

  // First daemon: the firing is claimed, then refused at shutdown before
  // its session exists. Its claim carried the checkpoint.
  const first: Fired[] = [];
  const one = createSchedulerRuntime({
    ...base,
    dispatch: async (input) => {
      first.push(input as Fired);
      const error = new Error('stratusd is stopping');
      error.name = 'GatewayStoppingError';
      throw error;
    },
  });
  await one.start();
  await waitFor(() => first.length === 1, 'the first firing');
  one.stop();
  await one.drain();
  const lost = first[0]!.sessionId;
  assert.match(first[0]!.userMessage, /X: did one, left two/);
  assert.equal(store.get('sched-1')?.lastSessionId, lost);
  assert.deepEqual(store.get('sched-1')?.resumeFrom, { firing: lost, from: checkpoint }, 'a firing whose session never existed keeps its fallback');
  assert.equal(store.get('sched-1')?.stoppedEarlyStreak, 2);

  // Second daemon: the row points at a session that doesn't exist, and
  // the fallback names that same firing, so the checkpoint is replayed.
  const second: Fired[] = [];
  const two = createSchedulerRuntime({ ...base, dispatch: async (input) => { second.push(input as Fired); } });
  await two.start();
  await waitFor(() => second.length === 1, 'the next firing');
  two.stop();
  await two.drain();
  assert.match(second[0]!.userMessage, /X: did one, left two/);
  assert.equal(store.get('sched-1')?.stoppedEarlyStreak, 2, 'the lost firing has no outcome, so the count stays');
  assert.deepEqual(store.get('sched-1')?.resumeFrom, { firing: second[0]!.sessionId, from: checkpoint });
  store.close();
});

test('a resumed firing that settles drops its fallback, so a removed session later starts fresh', async () => {
  const home = await newHome();
  const store = new SqliteScheduleStore(path.join(home, 'fleet.db'));
  const checkpoint = 'schedule:sched-1:x';
  const runs: Record<string, PreviousRun> = { [checkpoint]: stopped('X summary') };
  const fired: Fired[] = [];
  const lines: string[] = [];
  store.insert(record({ cadence: { kind: 'every', intervalMs: 300 }, lastSessionId: checkpoint }));
  const runtime = createSchedulerRuntime({
    store,
    dispatch: async (input) => {
      fired.push(input as Fired);
      // The firing ran and its session exists, and it finished normally.
      runs[input.sessionId] = finished();
      if (fired.length === 1) {
        // Removed by hand once it ran (an edit to the state database).
        setTimeout(() => {
          delete runs[input.sessionId];
        }, 50);
      }
    },
    validateDestination: async () => {},
    sessionStatus: async (sessionId) => runs[sessionId]?.status,
    previousRun: async (sessionId) => runs[sessionId],
    hasAgent: () => true,
    limits: { minIntervalMs: 1, tickMs: 10, maxConcurrentPerAgent: 1 },
    log: (line) => lines.push(line),
    warn: (line) => lines.push(line),
  });
  await runtime.start();
  await waitFor(() => fired.length === 1, 'the resumed firing');
  await waitFor(() => store.get('sched-1')?.resumeFrom === undefined, 'the fallback to be dropped once the session exists');
  await waitFor(() => fired.length === 2, 'the next firing');
  runtime.stop();
  await runtime.drain();

  assert.match(fired[0]!.userMessage, /X summary/);
  assert.equal(fired[1]!.userMessage, 'check the repo', 'the old checkpoint is not replayed after a run that carried it on');
  assert.ok(lines.some((line) => line === `schedule sched-1: previous run ${fired[0]!.sessionId} not found; starting fresh`), lines.join('\n'));
  assert.equal(store.get('sched-1')?.stoppedEarlyStreak, undefined);
  store.close();
});

test('a fallback written for another firing is never replayed', async () => {
  const previous = 'schedule:sched-1:gone';
  const { fired, after, lines } = await fireOnce(
    record({ lastSessionId: previous, stoppedEarlyStreak: 2, resumeFrom: { firing: 'schedule:sched-1:other', from: 'schedule:sched-1:x' } }),
    { 'schedule:sched-1:x': stopped('X summary') },
  );
  assert.equal(fired.userMessage, 'check the repo');
  assert.equal(after?.stoppedEarlyStreak, undefined);
  assert.equal(after?.resumeFrom, undefined);
  assert.ok(lines.includes(`schedule sched-1: previous run ${previous} not found; starting fresh`), lines.join('\n'));
});

test('a schedule never claims past its own run that is still going', async () => {
  for (const status of ['running', 'pending_approval'] as const) {
    const home = await newHome();
    const store = new SqliteScheduleStore(path.join(home, 'fleet.db'));
    const previous = 'schedule:sched-1:prev';
    const runs: Record<string, PreviousRun> = { [previous]: { status, trust: 'agent' } };
    const fired: Fired[] = [];
    const warnings: string[] = [];
    let reads = 0;
    store.insert(record({ lastSessionId: previous }));
    const runtime = createSchedulerRuntime({
      store,
      dispatch: async (input) => {
        fired.push(input as Fired);
      },
      validateDestination: async () => {},
      sessionStatus: async (sessionId) => runs[sessionId]?.status,
      previousRun: async (sessionId) => {
        reads += 1;
        return runs[sessionId];
      },
      hasAgent: () => true,
      // A higher per-agent limit, so only the new rule can hold it back.
      limits: { minIntervalMs: 1, tickMs: 10, maxConcurrentPerAgent: 4 },
      log: () => {},
      warn: (line) => warnings.push(line),
    });
    await runtime.start();
    await waitFor(() => reads >= 5, 'several ticks');
    assert.equal(fired.length, 0, `${status}: deferred while its previous run is ${status}`);
    assert.equal(store.get('sched-1')?.lastSessionId, previous, `${status}: the slot is not claimed`);
    assert.equal(warnings.filter((line) => /still going/.test(line)).length, 1, `${status}: warned once, not per tick`);

    runs[previous] = stopped('picked up later');
    await waitFor(() => fired.length === 1, 'the deferred firing');
    runtime.stop();
    await runtime.drain();
    assert.match(fired[0]!.userMessage, /picked up later/, `${status}: it then reads the finished run`);
    store.close();
  }
});

test('a firing this daemon started holds back the same schedule\'s next slot, even under a higher limit', async () => {
  const home = await newHome();
  const store = new SqliteScheduleStore(path.join(home, 'fleet.db'));
  const fired: Fired[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  store.insert(record({ cadence: { kind: 'every', intervalMs: 20 } }));
  const runtime = createSchedulerRuntime({
    store,
    dispatch: async (input) => {
      fired.push(input as Fired);
      if (fired.length === 1) {
        await held;
      }
    },
    validateDestination: async () => {},
    sessionStatus: async () => undefined,
    previousRun: async () => undefined,
    hasAgent: () => true,
    limits: { minIntervalMs: 1, tickMs: 10, maxConcurrentPerAgent: 4 },
    log: () => {},
    warn: () => {},
  });
  await runtime.start();
  await waitFor(() => fired.length === 1, 'the first firing');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(fired.length, 1, 'no second firing of the same schedule while the first runs');
  release();
  await waitFor(() => fired.length === 2, 'the next firing once the first settled');
  runtime.stop();
  await runtime.drain();
  store.close();
});

test('a one-shot is never resumed or held back', async () => {
  const previous = 'schedule:sched-1:prev';
  const at = due();
  const { fired } = await fireOnce(
    record({ cadence: { kind: 'at', at }, nextFireAt: at, lastSessionId: previous }),
    { [previous]: stopped('should not appear') },
  );
  assert.equal(fired.userMessage, 'check the repo');
});

test('a home stamped by a newer build while the previous run was read claims nothing', async () => {
  const home = await newHome();
  const store = new SqliteScheduleStore(path.join(home, 'fleet.db'));
  const previous = 'schedule:sched-1:prev';
  const slot = due();
  store.insert(record({ lastSessionId: previous, nextFireAt: slot }));
  let readsAfterLookup = false;
  let dispatches = 0;
  const runtime = createSchedulerRuntime({
    store,
    dispatch: async () => {
      dispatches += 1;
    },
    validateDestination: async () => {},
    sessionStatus: async () => 'completed',
    previousRun: async () => {
      readsAfterLookup = true;
      return stopped('x');
    },
    hasAgent: () => true,
    ready: () => {
      if (readsAfterLookup) {
        throw new Error('the home was stamped by a newer build');
      }
    },
    limits: { minIntervalMs: 1, tickMs: 10, maxConcurrentPerAgent: 1 },
    log: () => {},
    warn: () => {},
  });
  await assert.rejects(() => runtime.start(), /stamped by a newer build/);
  runtime.stop();
  await runtime.drain();
  assert.equal(dispatches, 0);
  assert.equal(store.get('sched-1')?.nextFireAt, slot, 'the slot is not spent');
  assert.equal(store.get('sched-1')?.lastSessionId, previous);
  store.close();
});

test('a previous run that cannot be read fires without the block and keeps the count', async () => {
  const previous = 'schedule:sched-1:prev';
  const { fired, after, lines } = await fireOnce(
    record({ lastSessionId: previous, stoppedEarlyStreak: 1 }),
    {},
    { previousRun: async () => { throw new Error('database is locked'); } },
  );
  assert.equal(fired.userMessage, 'check the repo');
  assert.equal(after?.stoppedEarlyStreak, 1);
  assert.equal(after?.resumeFrom, undefined);
  assert.ok(lines.some((line) => /could not read its previous run .*database is locked/.test(line)), lines.join('\n'));
});

// ---- end to end through the gateway ---------------------------------------

test('through the gateway: a firing that runs out of steps is the next firing\'s starting point, and a repeat says so', async () => {
  const home = await newHome();
  const agentsDir = path.join(home, '.stratus', 'agents');
  await mkdir(agentsDir, { recursive: true });
  await writeFile(path.join(agentsDir, 'ava.md'), [
    '---',
    'name: Ava',
    'provider: openai',
    'model: model-a',
    'tools:',
    '  - schedule.list',
    '---',
    '',
    'You are Ava.',
    '',
  ].join('\n'));
  const schedules = new SqliteScheduleStore(fleetDbPath({ homeDir: home }));
  schedules.insert(record({ cadence: { kind: 'every', intervalMs: 400 }, nextFireAt: due() }));
  schedules.close();

  // Always one more tool call, until the runner's wrap-up asks for an
  // answer with no tools: then a summary naming the firing it came from.
  let wrapUps = 0;
  const fakeFetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { tool_choice?: string };
    if (body.tool_choice === 'none') {
      wrapUps += 1;
      return openAiReply({ content: `Summary ${wrapUps}: listed schedules; left the report.` });
    }
    return openAiReply({ content: '', tool_calls: [{ id: `call-${Date.now()}`, type: 'function', function: { name: 'schedule_list', arguments: '{}' } }] });
  }) as unknown as typeof fetch;

  const completed: string[] = [];
  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fakeFetch },
    idleTimeoutMs: 0,
    maxTurns: 1,
    schedules: { tickMs: 25 },
  });
  gateway.bus.subscribe((event: StratusEvent) => {
    if (event.type === 'session.completed' && event.sessionId.startsWith('schedule:')) {
      completed.push(event.sessionId);
    }
  });
  await gateway.start();
  let sessions: Awaited<ReturnType<typeof gateway.store.get>>[];
  try {
    await waitFor(() => completed.length >= 3, 'three firings', 15_000);
    sessions = await Promise.all(completed.slice(0, 3).map((id) => gateway.store.get(id)));
  } finally {
    await gateway.stop();
  }

  const [first, second, third] = sessions;
  assert.equal(first?.stoppedEarly?.reason, 'turn-limit', 'the first firing ran out of steps');
  assert.equal(first?.messages[0]?.content, 'check the repo', 'the first firing starts from its prompt alone');
  const secondPrompt = String(second?.messages[0]?.content ?? '');
  assert.ok(secondPrompt.startsWith('check the repo\n\n'), secondPrompt);
  assert.match(secondPrompt, /Summary 1: listed schedules; left the report\./, 'the second firing carries the first one\'s wrap-up');
  assert.doesNotMatch(secondPrompt, /in a row/);
  const thirdPrompt = String(third?.messages[0]?.content ?? '');
  assert.match(thirdPrompt, /Summary 2: listed schedules; left the report\./);
  assert.match(thirdPrompt, /2nd run in a row to stop early/);
  // The resumed firing's label is no higher than the run it carries on from.
  assert.equal(sessionTrustOf(third!), leastTrusted(sessionTrustOf(third!), 'agent', sessionWriteTrust(second!)));
  assert.notEqual(sessionTrustOf(third!), 'user');

  const after = new SqliteScheduleStore(fleetDbPath({ homeDir: home }));
  assert.ok((after.get('sched-1')?.stoppedEarlyStreak ?? 0) >= 2);
  after.close();
});
