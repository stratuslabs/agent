import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SENDER_TRUST_METADATA_KEY, type JsonObject, type Session } from '@stratusagent/core';
import {
  SCHEDULE_ID_METADATA_KEY,
  SCHEDULED_TURN_METADATA_KEY,
  parseEventFilter,
  type ScheduleCadence,
} from '@stratusagent/agents';
import {
  SqliteEventStore,
  SqliteScheduleStore,
  createSchedulerRuntime,
  eventCoalescingKey,
  eventDispatchKey,
  eventSessionId,
  type NewEventFiring,
  type SchedulerRuntimeOptions,
} from '../src/index.ts';

// Event triggers end to end inside the scheduler (card 590): a trigger is a
// schedule whose cadence is an event; a matched delivery leaves a pending
// firing; the scheduler decides hold or fire and dispatches through the same
// path a timed firing takes. The clock is the test's, and ticks are driven
// by hand (`kickEvents`), so nothing here races a timer.

interface Dispatched {
  sessionId: string;
  agentId: string;
  userMessage: string;
  idempotencyKey?: string;
  metadata: JsonObject;
  finish: (error?: Error) => void;
}

const T0 = new Date('2026-10-28T15:00:00.000Z'); // 11:00 in New York

interface Rig {
  schedules: SqliteScheduleStore;
  events: SqliteEventStore;
  runtime: ReturnType<typeof createSchedulerRuntime>;
  dispatched: Dispatched[];
  clock: { now: Date };
  paused: { value: boolean };
  warnings: string[];
  trigger(cadence?: Partial<Extract<ScheduleCadence, { kind: 'event' }>>, agentId?: string): Promise<string>;
  deliver(triggerId: string, eventId: string, subject?: string, agentId?: string): string;
  stop(): Promise<void>;
}

const rig = async (overrides: Partial<SchedulerRuntimeOptions> = {}, file?: string): Promise<Rig> => {
  const db = file ?? path.join(await mkdtemp(path.join(os.tmpdir(), 'stratus-triggers-')), 'fleet.db');
  const schedules = new SqliteScheduleStore(db);
  const events = new SqliteEventStore(db);
  const dispatched: Dispatched[] = [];
  const clock = { now: T0 };
  const paused = { value: false };
  const warnings: string[] = [];
  const runtime = createSchedulerRuntime({
    store: schedules,
    dispatch: (input) => new Promise((resolve, reject) => {
      dispatched.push({ ...input, finish: (error) => (error ? reject(error) : resolve(undefined)) } as Dispatched);
    }),
    validateDestination: async () => {},
    sessionStatus: async () => undefined,
    hasAgent: () => true,
    limits: { minIntervalMs: 1, tickMs: 3_600_000, maxConcurrentPerAgent: 1 },
    events: { store: events, sources: () => ['github', 'board'] },
    now: () => clock.now,
    paused: () => paused.value,
    log: () => {},
    warn: (line) => warnings.push(line),
    ...overrides,
  });
  const trigger: Rig['trigger'] = async (cadence = {}, agentId = 'atlas') => {
    const record = await runtime.handle.create({
      agentId,
      cadence: { kind: 'event', source: 'github', filter: parseEventFilter({ prefix: { type: 'com.github.' } }), ...cadence },
      prompt: 'Codex reviewed your PR. Handle it.',
      destination: { channel: 'slack', to: 'C-ENG' },
      trust: 'user',
    });
    return record.id;
  };
  const deliver: Rig['deliver'] = (triggerId, eventId, subject = 'pull/470', agentId = 'atlas') => {
    const coalescingKey = eventCoalescingKey('github', { attributes: { id: eventId, subject } });
    const firing: NewEventFiring = {
      triggerId,
      agentId,
      coalescingKey,
      sessionId: eventSessionId(triggerId, coalescingKey),
      dispatchKey: eventDispatchKey(triggerId, 'github', eventId),
      block: `Event from source "github": ${eventId}`,
    };
    const accepted = events.accept({
      source: 'github', eventId, type: 'com.github.pull_request_review.submitted', subject, receivedAt: clock.now.toISOString(), firings: [firing],
    });
    return accepted.firings[0]!.id;
  };
  return {
    schedules, events, runtime, dispatched, clock, paused, warnings, trigger, deliver,
    async stop() {
      runtime.stop();
      for (const pending of dispatched) {
        pending.finish();
      }
      await runtime.drain();
      events.close();
      schedules.close();
    },
  };
};

/** Let the dispatch promise's settlement (and the bookkeeping after it) run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

test('schedule.on creates a trigger with no slot, only for a configured source', async () => {
  const r = await rig();
  try {
    await assert.rejects(() => r.trigger({ source: 'stripe' }), /No event source "stripe" is configured.*github, board/);
    const id = await r.trigger();
    const row = r.schedules.get(id)!;
    assert.equal(row.nextFireAt, undefined, 'never due by the clock');
    assert.deepEqual(r.schedules.due(new Date(T0.getTime() + 365 * 86_400_000).toISOString()), []);
    await r.runtime.start();
    assert.ok(r.schedules.get(id), 'the startup sweep keeps it: it is not a spent one-shot');
    assert.deepEqual(r.runtime.eventTriggers('github').map((trigger) => trigger.triggerId), [id]);
    assert.deepEqual(r.runtime.eventTriggers('board'), []);
  } finally {
    await r.stop();
  }
});

test('a daemon with no event sources refuses a trigger, rather than keeping one that can never fire', async () => {
  const db = path.join(await mkdtemp(path.join(os.tmpdir(), 'stratus-triggers-off-')), 'fleet.db');
  const schedules = new SqliteScheduleStore(db);
  const runtime = createSchedulerRuntime({
    store: schedules,
    dispatch: async () => undefined,
    validateDestination: async () => {},
    sessionStatus: async () => undefined,
    hasAgent: () => true,
    log: () => {},
    warn: () => {},
  });
  await assert.rejects(
    () => runtime.handle.create({ agentId: 'atlas', cadence: { kind: 'event', source: 'github', filter: { exact: { type: 't' } } }, prompt: 'p' }),
    /takes no events/,
  );
  schedules.close();
});

test('a matched firing goes out through dispatch: prompt then event, its session, its idempotency key, labeled external', async () => {
  const r = await rig();
  try {
    const id = await r.trigger();
    await r.runtime.start();
    const firingId = r.deliver(id, 'd-1');
    r.runtime.kickEvents();
    assert.equal(r.dispatched.length, 1);
    const [turn] = r.dispatched;
    assert.equal(turn!.agentId, 'atlas');
    assert.equal(turn!.userMessage, 'Codex reviewed your PR. Handle it.\n\nEvent from source "github": d-1');
    assert.equal(turn!.sessionId, eventSessionId(id, eventCoalescingKey('github', { attributes: { id: 'd-1', subject: 'pull/470' } })));
    assert.equal(turn!.idempotencyKey, eventDispatchKey(id, 'github', 'd-1'));
    assert.equal(turn!.metadata[SCHEDULED_TURN_METADATA_KEY], true);
    assert.equal(turn!.metadata[SCHEDULE_ID_METADATA_KEY], id);
    assert.equal(turn!.metadata[SENDER_TRUST_METADATA_KEY], 'external');
    assert.equal(r.events.firing(firingId)!.status, 'firing');

    // While it runs, the firing may speak to the destination its trigger was approved with.
    const session = { id: turn!.sessionId, agent: { id: 'atlas', name: 'atlas' }, metadata: turn!.metadata } as unknown as Session;
    assert.equal(r.runtime.isPreauthorized(session, 'slack:C-ENG'), true);
    assert.equal(r.runtime.isPreauthorized(session, 'slack:C-OTHER'), false);

    r.runtime.kickEvents();
    assert.equal(r.dispatched.length, 1, 'an in-flight firing is not sent again');
    turn!.finish();
    await settle();
    assert.equal(r.events.firing(firingId)!.status, 'fired');
    assert.equal(r.events.firing(firingId)!.block, undefined);
    assert.equal(r.runtime.isPreauthorized(session, 'slack:C-ENG'), false, 'the grant ends with the firing');
  } finally {
    await r.stop();
  }
});

test('a dispatch that throws marks the firing failed with the reason', async () => {
  const r = await rig();
  try {
    const id = await r.trigger();
    await r.runtime.start();
    const firingId = r.deliver(id, 'd-1');
    r.runtime.kickEvents();
    r.dispatched[0]!.finish(new Error('Agent not found: atlas'));
    await settle();
    const row = r.events.firing(firingId)!;
    assert.equal(row.status, 'failed');
    assert.match(row.reason ?? '', /Agent not found/);
  } finally {
    await r.stop();
  }
});

test('event firings have their own per-agent slot: a second waits for the first, then goes', async () => {
  const r = await rig();
  try {
    const id = await r.trigger();
    await r.runtime.start();
    r.deliver(id, 'd-1', 'pull/1');
    r.deliver(id, 'd-2', 'pull/2');
    r.runtime.kickEvents();
    assert.equal(r.dispatched.length, 1);
    r.dispatched[0]!.finish();
    await settle();
    r.runtime.kickEvents();
    assert.equal(r.dispatched.length, 2);
    assert.match(r.dispatched[1]!.userMessage, /d-2/);
  } finally {
    await r.stop();
  }
});

test('quiet hours hold firings, and when the window ends each key goes out once with its events, under the newest key', async () => {
  const r = await rig();
  try {
    const id = await r.trigger({ quietHours: { from: '22:00', to: '07:00', timeZone: 'America/New_York' } });
    await r.runtime.start();
    r.clock.now = new Date('2026-10-29T03:00:00.000Z'); // 23:00 in New York
    const a = r.deliver(id, 'd-a');
    r.clock.now = new Date('2026-10-29T04:00:00.000Z');
    const b = r.deliver(id, 'd-b');
    r.runtime.kickEvents();
    assert.equal(r.dispatched.length, 0);
    assert.equal(r.events.firing(a)!.status, 'held');
    assert.equal(r.events.firing(b)!.status, 'held');

    r.clock.now = new Date('2026-10-29T11:00:00.000Z'); // 07:00 in New York
    r.runtime.kickEvents();
    assert.equal(r.dispatched.length, 1);
    assert.equal(r.dispatched[0]!.userMessage, 'Codex reviewed your PR. Handle it.\n\nEvent from source "github": d-a\n\nEvent from source "github": d-b');
    assert.equal(r.dispatched[0]!.idempotencyKey, eventDispatchKey(id, 'github', 'd-b'));
    assert.equal(r.events.firing(a)!.batchKey, r.events.firing(b)!.batchKey);
  } finally {
    await r.stop();
  }
});

test('paused intake holds event firings, and they go out when it resumes', async () => {
  const r = await rig();
  try {
    const id = await r.trigger();
    await r.runtime.start();
    r.paused.value = true;
    const firingId = r.deliver(id, 'd-1');
    r.runtime.kickEvents();
    assert.equal(r.dispatched.length, 0);
    assert.equal(r.events.firing(firingId)!.status, 'held');
    r.paused.value = false;
    r.runtime.kickEvents();
    assert.equal(r.dispatched.length, 1);
  } finally {
    await r.stop();
  }
});

test('over maxPerHour a firing waits as rate_limited, the newest per key goes when the hour allows, older ones are superseded', async () => {
  const r = await rig();
  try {
    const id = await r.trigger({ maxPerHour: 1 });
    await r.runtime.start();
    r.deliver(id, 'd-1', 'pull/1');
    r.runtime.kickEvents();
    r.dispatched[0]!.finish();
    await settle();

    r.clock.now = new Date(T0.getTime() + 60_000);
    const older = r.deliver(id, 'd-2', 'pull/2');
    r.clock.now = new Date(T0.getTime() + 120_000);
    const newer = r.deliver(id, 'd-3', 'pull/2');
    r.runtime.kickEvents();
    assert.equal(r.dispatched.length, 1, 'the hour is used up');
    assert.equal(r.events.firing(older)!.status, 'superseded');
    assert.equal(r.events.firing(newer)!.status, 'rate_limited');

    r.clock.now = new Date(T0.getTime() + 3_700_000);
    r.runtime.kickEvents();
    assert.equal(r.dispatched.length, 2);
    assert.match(r.dispatched[1]!.userMessage, /d-3/);
    assert.doesNotMatch(r.dispatched[1]!.userMessage, /d-2/);
  } finally {
    await r.stop();
  }
});

test('a key keeps at most its 5 newest held firings, and a hold older than 24 hours expires', async () => {
  const r = await rig();
  try {
    const id = await r.trigger({ quietHours: { from: '00:00', to: '23:59', timeZone: 'UTC' } });
    await r.runtime.start();
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      r.clock.now = new Date(T0.getTime() + i * 1_000);
      ids.push(r.deliver(id, `d-${i}`));
    }
    r.runtime.kickEvents();
    assert.deepEqual(ids.map((firingId) => r.events.firing(firingId)!.status), [
      'superseded', 'superseded', 'held', 'held', 'held', 'held', 'held',
    ]);
    r.clock.now = new Date(T0.getTime() + 25 * 3_600_000);
    r.runtime.kickEvents();
    assert.deepEqual(r.events.open(), []);
    assert.equal(r.events.firing(ids[6]!)!.status, 'expired');
    assert.equal(r.dispatched.length, 0);
  } finally {
    await r.stop();
  }
});

test('cancelling a trigger expires its waiting firings, and nothing goes out', async () => {
  const r = await rig();
  try {
    const id = await r.trigger();
    await r.runtime.start();
    r.paused.value = true;
    const firingId = r.deliver(id, 'd-1');
    r.runtime.kickEvents();
    assert.equal(await r.runtime.handle.cancel('atlas', id), true);
    r.paused.value = false;
    r.runtime.kickEvents();
    assert.equal(r.dispatched.length, 0);
    assert.equal(r.events.firing(firingId)!.status, 'expired');
  } finally {
    await r.stop();
  }
});

test('recovery: a batch claimed before a crash goes out again as itself, and an event that arrived since gets its own turn', async () => {
  const db = path.join(await mkdtemp(path.join(os.tmpdir(), 'stratus-triggers-crash-')), 'fleet.db');
  const first = await rig({}, db);
  const id = await first.trigger();
  const a = first.deliver(id, 'd-a');
  const b = first.deliver(id, 'd-b');
  const batchKey = eventDispatchKey(id, 'github', 'd-b');
  assert.equal(first.events.claim([a, b], batchKey, T0.toISOString()), true);
  // The process dies here: claimed, never dispatched.
  first.runtime.stop();
  first.events.close();
  first.schedules.close();

  const second = await rig({}, db);
  try {
    const c = second.deliver(id, 'd-c');
    await second.runtime.start();
    assert.equal(second.dispatched.length, 1);
    assert.equal(second.dispatched[0]!.idempotencyKey, batchKey, 'the same key, so a dispatch that did land continues its turn');
    assert.match(second.dispatched[0]!.userMessage, /d-a[\s\S]*d-b/);
    assert.doesNotMatch(second.dispatched[0]!.userMessage, /d-c/);
    second.dispatched[0]!.finish();
    await settle();
    second.runtime.kickEvents();
    assert.equal(second.dispatched.length, 2);
    assert.match(second.dispatched[1]!.userMessage, /d-c/);
    assert.equal(second.dispatched[1]!.idempotencyKey, eventDispatchKey(id, 'github', 'd-c'));
    assert.equal(second.events.firing(c)!.batchKey, eventDispatchKey(id, 'github', 'd-c'));
  } finally {
    await second.stop();
  }
});

test('recovery inside quiet hours holds the recovered firing instead of sending it', async () => {
  const db = path.join(await mkdtemp(path.join(os.tmpdir(), 'stratus-triggers-quiet-crash-')), 'fleet.db');
  const first = await rig({}, db);
  const id = await first.trigger({ quietHours: { from: '22:00', to: '07:00', timeZone: 'America/New_York' } });
  const a = first.deliver(id, 'd-a');
  first.events.claim([a], eventDispatchKey(id, 'github', 'd-a'), T0.toISOString());
  first.runtime.stop();
  first.events.close();
  first.schedules.close();

  const second = await rig({}, db);
  try {
    second.clock.now = new Date('2026-10-29T03:00:00.000Z'); // 23:00 in New York
    await second.runtime.start();
    assert.equal(second.dispatched.length, 0);
    const row = second.events.firing(a)!;
    assert.equal(row.status, 'held');
    assert.equal(row.batchKey, eventDispatchKey(id, 'github', 'd-a'), 'held as the batch it was');
  } finally {
    await second.stop();
  }
});
