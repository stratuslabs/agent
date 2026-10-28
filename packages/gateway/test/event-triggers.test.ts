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
  GatewayStoppingError,
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
  dbFile: string;
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

const rig = async (overrides: Partial<SchedulerRuntimeOptions> = {}, file?: string, slot = 1): Promise<Rig> => {
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
    events: { store: events, sources: () => ['github', 'board'], maxConcurrentPerAgent: slot },
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
    dbFile: db, schedules, events, runtime, dispatched, clock, paused, warnings, trigger, deliver,
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
    // Nor held, expired or regrouped while it runs: a pause now must not
    // turn a firing that is already out into one that goes out again.
    r.paused.value = true;
    r.runtime.kickEvents();
    assert.equal(r.events.firing(firingId)!.status, 'firing');
    r.paused.value = false;
    turn!.finish();
    await settle();
    assert.equal(r.events.firing(firingId)!.status, 'fired');
    assert.equal(r.events.firing(firingId)!.block, undefined);
    assert.equal(r.runtime.isPreauthorized(session, 'slack:C-ENG'), false, 'the grant ends with the firing');
  } finally {
    await r.stop();
  }
});

test('a firing records when it went out on the trigger itself, like a timed schedule\'s slot', async () => {
  const r = await rig();
  try {
    const id = await r.trigger();
    await r.runtime.start();
    assert.equal(r.schedules.get(id)!.lastFiredAt, undefined);
    r.deliver(id, 'd-1');
    r.runtime.kickEvents();
    const row = r.schedules.get(id)!;
    assert.equal(row.lastFiredAt, T0.toISOString());
    assert.equal(row.lastSessionId, r.dispatched[0]!.sessionId);
    assert.equal(row.nextFireAt, undefined, 'still never due by the clock');
    assert.deepEqual(r.schedules.due(new Date(T0.getTime() + 365 * 86_400_000).toISOString()), []);
  } finally {
    await r.stop();
  }
});

test('the running scheduler prunes the event tables to their 7-day window, at start and then hourly', async () => {
  const r = await rig();
  try {
    const old = new Date(T0.getTime() - 8 * 86_400_000).toISOString();
    r.events.accept({ source: 'github', eventId: 'old-1', type: 'com.github.ping', receivedAt: old, firings: [] });
    r.events.accept({ source: 'github', eventId: 'new-1', type: 'com.github.ping', receivedAt: T0.toISOString(), firings: [] });
    await r.runtime.start();
    assert.deepEqual(r.events.deliveries().map((row) => row.eventId), ['new-1'], 'the start-up pass pruned the 8-day-old row');

    // A row that ages out later goes at the next hourly pass, not every tick.
    r.clock.now = new Date(T0.getTime() + 30 * 60_000);
    r.events.accept({ source: 'github', eventId: 'older-1', type: 'com.github.ping', receivedAt: old, firings: [] });
    r.runtime.kickEvents();
    assert.equal(r.events.deliveries().length, 2, 'within the hour: not pruned yet');
    r.clock.now = new Date(T0.getTime() + 61 * 60_000);
    r.runtime.kickEvents();
    assert.deepEqual(r.events.deliveries().map((row) => row.eventId), ['new-1']);
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

test('a firing a stopping daemon refused or cut short stays claimed, and the next start sends it again under its key', async () => {
  // Card 590, Fly live check 3: a graceful restart mid-turn marked the
  // firing failed and the event was never handled. The gateway now leaves a
  // keyed turn its stop cut short for the next start and refuses the
  // dispatch (GatewayStoppingError), as it refuses one that reaches it on
  // the way down; either way the batch is not done, so it stays claimed.
  const db = path.join(await mkdtemp(path.join(os.tmpdir(), 'stratus-triggers-stop-')), 'fleet.db');
  const first = await rig({}, db);
  let firingId: string;
  let batchKey: string | undefined;
  try {
    const id = await first.trigger();
    await first.runtime.start();
    firingId = first.deliver(id, 'd-1');
    first.runtime.kickEvents();
    batchKey = first.dispatched[0]!.idempotencyKey;
    first.dispatched[0]!.finish(new GatewayStoppingError('stratusd is stopping; this turn was cut short and continues when it is started again.', false));
    await settle();
    assert.equal(first.events.firing(firingId)!.status, 'firing');
    assert.equal(first.events.firing(firingId)!.batchKey, batchKey);
    assert.ok(!first.warnings.some((line) => /firing failed/.test(line)), first.warnings.join('\n'));
  } finally {
    await first.stop();
  }

  const second = await rig({}, db);
  try {
    await second.runtime.start();
    assert.equal(second.dispatched.length, 1);
    assert.equal(second.dispatched[0]!.idempotencyKey, batchKey, 'the same key, so the turn the stop left is continued, not run again');
    second.dispatched[0]!.finish();
    await settle();
    assert.equal(second.events.firing(firingId)!.status, 'fired');
  } finally {
    await second.stop();
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

test('a start that failed still uses the hour, so a failing provider cannot run past maxPerHour', async () => {
  const r = await rig();
  try {
    const id = await r.trigger({ maxPerHour: 1 });
    await r.runtime.start();
    r.deliver(id, 'd-1', 'pull/1');
    r.runtime.kickEvents();
    r.dispatched[0]!.finish(new Error('provider down'));
    await settle();
    const next = r.deliver(id, 'd-2', 'pull/2');
    r.runtime.kickEvents();
    assert.equal(r.dispatched.length, 1);
    assert.equal(r.events.firing(next)!.status, 'rate_limited');
  } finally {
    await r.stop();
  }
});

test('a turn still running uses the hour too', async () => {
  const r = await rig({}, undefined, 2);
  try {
    const id = await r.trigger({ maxPerHour: 1 });
    await r.runtime.start();
    r.deliver(id, 'd-1', 'pull/1');
    r.runtime.kickEvents();
    assert.equal(r.dispatched.length, 1);
    const next = r.deliver(id, 'd-2', 'pull/2');
    r.runtime.kickEvents();
    assert.equal(r.dispatched.length, 1, 'the slot has room, the hour does not');
    assert.equal(r.events.firing(next)!.status, 'rate_limited');
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

test('a trigger cancelled from another process between the scan and the claim does not fire', async () => {
  const r = await rig();
  try {
    const id = await r.trigger();
    await r.runtime.start();
    const firingId = r.deliver(id, 'd-1');
    // `stratus schedules cancel` deletes the row through its own connection;
    // here the delete lands after this scan has read the trigger.
    const realGet = r.schedules.get.bind(r.schedules);
    let cancelled = false;
    r.schedules.get = (scheduleId: string) => {
      const row = realGet(scheduleId);
      if (!cancelled && scheduleId === id) {
        cancelled = true;
        const other = new SqliteScheduleStore(r.dbFile);
        other.delete(id);
        other.close();
      }
      return row;
    };
    r.runtime.kickEvents();
    assert.equal(r.dispatched.length, 0, 'the claim saw the trigger gone');
    assert.notEqual(r.events.firing(firingId)!.status, 'firing');
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

test('a batch claimed before a long outage still goes out: the 24-hour expiry is for holds, not claims', async () => {
  const db = path.join(await mkdtemp(path.join(os.tmpdir(), 'stratus-triggers-long-crash-')), 'fleet.db');
  const first = await rig({}, db);
  const id = await first.trigger();
  const a = first.deliver(id, 'd-a');
  first.events.claim([a], eventDispatchKey(id, 'github', 'd-a'), T0.toISOString());
  first.runtime.stop();
  first.events.close();
  first.schedules.close();

  const second = await rig({}, db);
  try {
    second.clock.now = new Date(T0.getTime() + 30 * 3_600_000);
    await second.runtime.start();
    assert.equal(second.dispatched.length, 1);
    assert.equal(second.dispatched[0]!.idempotencyKey, eventDispatchKey(id, 'github', 'd-a'));
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

// ---- end to end through the gateway ---------------------------------------------

test('a signed delivery wakes the trigger\'s agent through the gateway: one turn, the event in its prompt, the report sent', async () => {
  const { createHmac } = await import('node:crypto');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { addNamedCredential, fleetDbIn } = await import('@stratusagent/state');
  const { createGateway } = await import('../src/index.ts');

  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-triggers-e2e-'));
  await mkdir(path.join(home, '.stratus', 'agents'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'agents', 'ava.md'), [
    '---', 'name: Ava', 'provider: openai', 'model: model-a', 'tools:', '  - schedule.*', '  - message.send', '---', '', 'You are Ava.', '',
  ].join('\n'));
  const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' } as Record<string, string> };
  await addNamedCredential(env, { name: 'events.board', value: secret });

  // The trigger, as an approved `schedule.on` leaves it.
  const schedules = new SqliteScheduleStore(fleetDbIn(path.join(home, '.stratus')));
  schedules.insert({
    id: 'trig-1',
    agentId: 'ava',
    cadence: { kind: 'event', source: 'board', filter: parseEventFilter({ exact: { type: 'card.moved' } }) },
    prompt: 'A card moved. Tell the team.',
    destination: { channel: 'slack', to: 'C-ENG' },
    createdAt: new Date().toISOString(),
    trust: 'user',
  });
  schedules.close();

  const prompts: string[] = [];
  let calls = 0;
  const fetchFake = (async (_url: unknown, init?: { body?: unknown }) => {
    calls += 1;
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: unknown }> };
    const user = body.messages.filter((message) => message.role === 'user').map((message) => String(message.content));
    prompts.push(user[user.length - 1] ?? '');
    const first = { choices: [{ message: { role: 'assistant', content: '', tool_calls: [
      { id: 'call-1', type: 'function', function: { name: 'message_send', arguments: JSON.stringify({ destination: { channel: 'slack', to: 'C-ENG' }, text: 'Card 590 moved.' }) } },
    ] } }] };
    const done = { choices: [{ message: { role: 'assistant', content: 'Reported.' } }] };
    return new Response(JSON.stringify(calls % 2 === 1 ? first : done), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const posts: Array<{ to: string; text: string }> = [];
  const gateway = createGateway({
    env: { ...env, fetch: fetchFake },
    idleTimeoutMs: 0,
    schedules: { tickMs: 25 },
    log: () => {},
    warn: () => {},
    channels: [{
      name: 'slack',
      async start() {},
      async stop() {},
      async resolveOutbound({ to }) {
        return { post: async (text: string) => { posts.push({ to, text }); return { channel: to, ts: '1' }; } };
      },
    }],
    events: { sources: { board: { verify: 'standard-webhooks', secrets: ['events.board'] } } },
  });
  await gateway.start();
  try {
    const body = JSON.stringify({ specversion: '1.0', id: 'ce-1', source: 'https://board.example', type: 'card.moved', subject: 'card/590', data: { to: 'Todo' } });
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const signature = `v1,${createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`ce-1.${timestamp}.${body}`).digest('base64')}`;
    const request = {
      sourceId: 'board',
      headers: { 'content-type': 'application/json', 'webhook-id': 'ce-1', 'webhook-timestamp': timestamp, 'webhook-signature': signature },
      body: Buffer.from(body),
    };
    const answer = await gateway.receiveEvent(request);
    assert.deepEqual(answer, { status: 200, body: { status: 'matched' } });

    const deadline = Date.now() + 5_000;
    while (posts.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(posts, [{ to: 'C-ENG', text: 'Card 590 moved.' }], 'the pre-authorized report went out, headless');
    assert.match(prompts[0] ?? '', /^A card moved\. Tell the team\.\n\nEvent from source "board":\n\{"id":"ce-1"/);

    const repeat = await gateway.receiveEvent(request);
    assert.deepEqual(repeat.body, { status: 'duplicate' });
  } finally {
    // Gated on the drain, not on a delay: stop() waits out every firing
    // the scheduler started, so a turn the repeat had caused would be done.
    await gateway.stop();
  }
  assert.equal(calls, 2, 'the repeat started no turn');

  // The process dies after the turn finished and before its firing was
  // marked fired: the row is still claimed. The next start re-sends the
  // batch under its key, and the gateway answers with the finished turn
  // instead of running the event again.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(fleetDbIn(path.join(home, '.stratus')));
  const changed = db.prepare("UPDATE event_firings SET status = 'firing', block = 'Event from source \"board\": replayed' WHERE trigger_id = 'trig-1'").run().changes;
  db.close();
  assert.equal(changed, 1);
  const restarted = createGateway({
    env: { ...env, fetch: fetchFake },
    idleTimeoutMs: 0,
    schedules: { tickMs: 25 },
    log: () => {},
    warn: () => {},
    channels: [{
      name: 'slack',
      async start() {},
      async stop() {},
      async resolveOutbound({ to }) {
        return { post: async (text: string) => { posts.push({ to, text }); return { channel: to, ts: '1' }; } };
      },
    }],
    events: { sources: { board: { verify: 'standard-webhooks', secrets: ['events.board'] } } },
  });
  await restarted.start();
  await restarted.stop();
  assert.equal(calls, 2, 'the recovered batch did not run its event a second time');
  assert.equal(posts.length, 1);
  const check = new DatabaseSync(fleetDbIn(path.join(home, '.stratus')));
  const status = (check.prepare("SELECT status FROM event_firings WHERE trigger_id = 'trig-1'").get() as { status: string }).status;
  check.close();
  assert.equal(status, 'fired');
});
