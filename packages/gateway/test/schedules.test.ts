import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { JsonObject, Session, StratusEvent } from '@stratusagent/core';
import {
  SCHEDULE_ID_METADATA_KEY,
  SCHEDULED_TURN_METADATA_KEY,
  type ScheduleRecord,
} from '@stratusagent/agents';
import { createPermissionPolicy } from '@stratusagent/permissions';
import {
  createGateway,
  createSchedulerRuntime,
  SqliteScheduleStore,
  type ApprovalTransport,
  type GatewayChannelAdapter,
  type SchedulerRuntimeOptions,
} from '../src/index.ts';

const newHome = async (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'stratus-sched-'));

const writeSoul = async (home: string, file: string, contents: string): Promise<void> => {
  const dir = path.join(home, '.stratus', 'agents');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, file), contents);
};

/**
 * Wait for a condition the code under test will bring about. Bounded so a
 * regression fails the assertion that follows instead of hanging the suite.
 */
const waitFor = async (condition: () => boolean, what: string, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
};

// ---- the store ---------------------------------------------------------------

const record = (overrides: Partial<ScheduleRecord> = {}): ScheduleRecord => ({
  id: overrides.id ?? 'sched-1',
  agentId: 'ava',
  cadence: { kind: 'every', intervalMs: 60_000 },
  prompt: 'check the repo',
  createdAt: new Date().toISOString(),
  nextFireAt: new Date(Date.now() + 60_000).toISOString(),
  ...overrides,
});

test('the schedule store round-trips rows and scans only unspent, due slots', async () => {
  const home = await newHome();
  const store = new SqliteScheduleStore(path.join(home, 'sessions.db'));

  const past = new Date(Date.now() - 1_000).toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();
  store.insert(record({ id: 'due', nextFireAt: past, destination: { channel: 'slack', to: 'C1' } }));
  store.insert(record({ id: 'later', nextFireAt: future }));
  const spent = record({ id: 'spent', cadence: { kind: 'at', at: past } });
  delete spent.nextFireAt;
  store.insert(spent);

  assert.deepEqual(store.get('due')?.destination, { channel: 'slack', to: 'C1' });
  assert.deepEqual(store.due(new Date().toISOString()).map((row) => row.id), ['due']);
  assert.deepEqual(store.list().map((row) => row.id).sort(), ['due', 'later', 'spent']);
  assert.equal(store.delete('due'), true);
  assert.equal(store.delete('due'), false);
  store.close();
});

// ---- the scheduler runtime ----------------------------------------------------

interface Fired {
  sessionId: string;
  agentId: string;
  userMessage: string;
  metadata: JsonObject;
}

const runtimeWith = (
  store: SqliteScheduleStore,
  overrides: Partial<SchedulerRuntimeOptions> = {},
) =>
  createSchedulerRuntime({
    store,
    dispatch: async () => undefined,
    validateDestination: async () => {},
    sessionStatus: async () => undefined,
    hasAgent: () => true,
    limits: { minIntervalMs: 1, tickMs: 10, maxConcurrentPerAgent: 1 },
    log: () => {},
    warn: () => {},
    ...overrides,
  });

test('the interval floor refuses fast schedules — intervals and crons alike', async () => {
  const home = await newHome();
  const store = new SqliteScheduleStore(path.join(home, 'sessions.db'));
  const runtime = createSchedulerRuntime({
    store,
    dispatch: async () => undefined,
    validateDestination: async () => {},
    sessionStatus: async () => undefined,
    hasAgent: () => true,
    // No limits: the DEFAULT floor is what this test pins down.
    log: () => {},
    warn: () => {},
  });

  await assert.rejects(
    () => runtime.handle.create({ agentId: 'ava', cadence: { kind: 'every', intervalMs: 30_000 }, prompt: 'x' }),
    /not run more often than every 60s/,
  );
  // At the floor is allowed — and `* * * * *` IS the floor: five-field
  // cron cannot say anything under a minute.
  const created = await runtime.handle.create({
    agentId: 'ava',
    cadence: { kind: 'every', intervalMs: 60_000 },
    prompt: 'x',
  });
  assert.ok(created.nextFireAt);
  const everyMinute = await runtime.handle.create({
    agentId: 'ava',
    cadence: { kind: 'cron', expression: '* * * * *' },
    prompt: 'x',
  });
  assert.ok(everyMinute.nextFireAt);

  // An operator who raises the floor holds crons to it too — a fast
  // schedule must not slip past for being spelled as a cron.
  const strict = runtimeWith(store, { limits: { minIntervalMs: 5 * 60_000, tickMs: 10 } });
  await assert.rejects(
    () => strict.handle.create({ agentId: 'ava', cadence: { kind: 'cron', expression: '* * * * *' }, prompt: 'x' }),
    /fires more often/,
  );
  store.close();
});

test('creation refuses an unknown agent and a destination the channel rejects', async () => {
  const home = await newHome();
  const store = new SqliteScheduleStore(path.join(home, 'sessions.db'));
  const runtime = runtimeWith(store, {
    hasAgent: (agentId) => agentId === 'ava',
    validateDestination: async (_agentId, destination) => {
      if (destination.to !== 'C-OK') {
        throw new Error(`slack: not a member of ${destination.to}`);
      }
    },
  });

  await assert.rejects(
    () => runtime.handle.create({ agentId: 'ghost', cadence: { kind: 'every', intervalMs: 60_000 }, prompt: 'x' }),
    /Agent not found/,
  );
  await assert.rejects(
    () => runtime.handle.create({
      agentId: 'ava',
      cadence: { kind: 'every', intervalMs: 60_000 },
      prompt: 'x',
      destination: { channel: 'slack', to: 'C-BAD' },
    }),
    /not a member of C-BAD/,
  );
  assert.equal(store.list().length, 0, 'a refused schedule leaves no row');
  store.close();
});

test('a due schedule fires through dispatch with its slot consumed first', async () => {
  const home = await newHome();
  const store = new SqliteScheduleStore(path.join(home, 'sessions.db'));
  const fired: Fired[] = [];
  const consumedBeforeDispatch: Array<string | undefined> = [];
  const firstFire = deferred<void>();

  const runtime = runtimeWith(store, {
    dispatch: async (input) => {
      fired.push(input as Fired);
      // Read the row back INSIDE the dispatch: the slot must already be
      // spent, or a crash right here would re-run this window on restart.
      consumedBeforeDispatch.push(store.get('sched-1')?.nextFireAt);
      firstFire.resolve();
    },
  });

  const slot = new Date(Date.now() - 5).toISOString();
  store.insert(record({ id: 'sched-1', cadence: { kind: 'every', intervalMs: 600_000 }, nextFireAt: slot }));
  await runtime.start();
  await firstFire.promise;
  runtime.stop();
  await runtime.drain();

  assert.equal(fired.length, 1);
  assert.equal(fired[0]?.agentId, 'ava');
  assert.equal(fired[0]?.userMessage, 'check the repo');
  assert.equal(fired[0]?.sessionId, `schedule:sched-1:${slot}`);
  assert.equal(fired[0]?.metadata[SCHEDULED_TURN_METADATA_KEY], true);
  assert.equal(fired[0]?.metadata[SCHEDULE_ID_METADATA_KEY], 'sched-1');
  const advanced = consumedBeforeDispatch[0];
  assert.ok(advanced && Date.parse(advanced) > Date.parse(slot), 'the slot is spent before the dispatch');
  assert.equal(store.get('sched-1')?.lastSessionId, fired[0]?.sessionId);
  store.close();
});

test('a long-missed short-interval schedule skips forward without spinning a per-interval loop', async () => {
  const home = await newHome();
  const store = new SqliteScheduleStore(path.join(home, 'sessions.db'));
  let dispatches = 0;
  const runtime = runtimeWith(store, { dispatch: async () => { dispatches += 1; } });

  // A one-minute schedule whose slot is a full year in the past: the skip
  // must land on the first future slot in one closed-form jump, not by
  // stepping ~525k intervals. Phase stays aligned to the original slot.
  const intervalMs = 60_000;
  const slotMs = Date.now() - 365 * 24 * 60 * 60 * 1000;
  store.insert(record({ id: 'ancient', cadence: { kind: 'every', intervalMs }, nextFireAt: new Date(slotMs).toISOString() }));

  const started = Date.now();
  await runtime.start();
  // The skip runs synchronously inside start(); if it looped per interval
  // it would take seconds and likely time out. Bounded here to prove it did
  // not.
  assert.ok(Date.now() - started < 1_000, 'skipping a year of minutes must not spin a loop');

  const next = store.get('ancient')?.nextFireAt;
  assert.ok(next, 'the schedule keeps a future slot');
  const nextMs = Date.parse(next);
  assert.ok(nextMs > Date.now(), 'the next slot is in the future');
  assert.equal((nextMs - slotMs) % intervalMs, 0, 'the next slot stays phase-aligned to the original');
  assert.equal(dispatches, 0, 'a fully-missed window is skipped, not replayed');
  runtime.stop();
  await runtime.drain();
  store.close();
});

test('the concurrency cap warns once per deferred slot, not once per tick', async () => {
  const home = await newHome();
  const store = new SqliteScheduleStore(path.join(home, 'sessions.db'));
  const warnings: string[] = [];
  const held = deferred<void>();
  let dispatches = 0;

  const runtime = runtimeWith(store, {
    warn: (line) => { if (/deferring this firing/.test(line)) warnings.push(line); },
    // The first firing is held open across many ticks; the second schedule
    // cannot run (agent at cap 1) and is deferred every tick.
    dispatch: async () => { dispatches += 1; if (dispatches === 1) { await held.promise; } },
  });

  // Two schedules for the SAME agent, both due, with a large interval so
  // neither slot advances during the test — one fires and is held, the
  // other is deferred on the same slot every tick.
  const due = new Date(Date.now() - 5).toISOString();
  store.insert(record({ id: 'holder', agentId: 'ava', cadence: { kind: 'every', intervalMs: 3_600_000 }, nextFireAt: due }));
  store.insert(record({ id: 'waiter', agentId: 'ava', cadence: { kind: 'every', intervalMs: 3_600_000 }, nextFireAt: due }));

  await runtime.start();
  await waitFor(() => dispatches === 1, 'the first firing to be held');
  await waitFor(() => warnings.length >= 1, 'the deferral warning');
  // Many ticks pass (tickMs is 10) while the holder stays open; the deferred
  // slot must not re-warn on each.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(warnings.length, 1, 'the deferred slot warns once across many ticks, not once per tick');

  held.resolve();
  runtime.stop();
  await runtime.drain();
  store.close();
});

test('a deferred firing whose window passes is skipped with a line that says so, not one blaming downtime', async () => {
  const home = await newHome();
  const store = new SqliteScheduleStore(path.join(home, 'sessions.db'));
  const lines: string[] = [];
  const held = deferred<void>();
  const skipped = deferred<void>();
  let dispatches = 0;

  const runtime = runtimeWith(store, {
    log: (line) => {
      lines.push(line);
      if (/^schedule waiter: .*skipping to/.test(line)) {
        skipped.resolve();
      }
    },
    dispatch: async () => { dispatches += 1; if (dispatches === 1) { await held.promise; } },
  });

  // The holder fires and stays open; the waiter — same agent, short
  // interval — is deferred under the cap, and its whole window passes
  // while the holder runs. Reproduced against a running daemon with an
  // `every 1m` firing that ran for two minutes: the deferred slot was
  // skipped under "missed firing(s) while the daemon was down", and the
  // daemon had not been down.
  // The waiter's window is its interval, and it has to outlast the
  // runtime's start — at 40ms a slow CI runner had the slot already past
  // its window the first time the scheduler looked, which is the
  // downtime case this test exists to tell apart from the deferral.
  const due = new Date(Date.now() - 5).toISOString();
  store.insert(record({ id: 'holder', agentId: 'ava', cadence: { kind: 'every', intervalMs: 3_600_000 }, nextFireAt: due }));
  store.insert(record({ id: 'waiter', agentId: 'ava', cadence: { kind: 'every', intervalMs: 500 }, nextFireAt: due }));

  await runtime.start();
  await waitFor(() => dispatches === 1, 'the holder to be held');
  try {
    await skipped.promise;
    assert.ok(
      lines.some((line) => /^schedule waiter: the firing deferred by the per-agent cap \(slot .*\) outlasted its window; skipping to/.test(line)),
      `expected the skip to name the deferral, got:\n${lines.join('\n')}`,
    );
    assert.ok(!lines.some((line) => /^schedule waiter: .*daemon was down/.test(line)), 'the daemon was never down');
  } finally {
    held.resolve();
    runtime.stop();
    await runtime.drain();
    store.close();
  }
});

test('a slightly-late recurring firing advances from its slot, not from now — no cadence drift', async () => {
  const home = await newHome();
  const store = new SqliteScheduleStore(path.join(home, 'sessions.db'));
  const fired = deferred<void>();
  const runtime = runtimeWith(store, { dispatch: async () => { fired.resolve(); } });

  // A due slot in the past against a one-hour interval: the firing is
  // "late" but its window is still open. The next slot must be exactly
  // slot + 1h — computed from the slot — regardless of when the tick
  // actually picked it up. Asserted by equality, so nothing races the
  // wall clock.
  const intervalMs = 3_600_000;
  const slot = new Date(Date.now() - 50).toISOString();
  store.insert(record({ id: 'nodrift', cadence: { kind: 'every', intervalMs }, nextFireAt: slot }));

  await runtime.start();
  await fired.promise;
  runtime.stop();
  await runtime.drain();

  const expected = new Date(Date.parse(slot) + intervalMs).toISOString();
  assert.equal(store.get('nodrift')?.nextFireAt, expected);
  store.close();
});

test('the per-agent cap defers a firing while one is still running', async () => {
  const home = await newHome();
  const store = new SqliteScheduleStore(path.join(home, 'sessions.db'));
  const avaFires: Deferred<void>[] = [];
  let avaDispatches = 0;
  let witnessDispatches = 0;
  const secondAvaFire = deferred<void>();

  const runtime = runtimeWith(store, {
    dispatch: async (input) => {
      if (input.agentId === 'ava') {
        avaDispatches += 1;
        if (avaDispatches === 2) {
          secondAvaFire.resolve();
        }
        const gate = deferred<void>();
        avaFires.push(gate);
        await gate.promise;
        return;
      }
      witnessDispatches += 1;
    },
  });

  // Both due immediately; ava's recurs fast, the witness (another agent)
  // recurs fast too and proves ticks are flowing while ava is held.
  store.insert(record({ id: 'ava-fast', cadence: { kind: 'every', intervalMs: 20 }, nextFireAt: new Date().toISOString() }));
  store.insert(record({
    id: 'witness',
    agentId: 'bea',
    cadence: { kind: 'every', intervalMs: 20 },
    nextFireAt: new Date().toISOString(),
  }));
  await runtime.start();

  // The witness fires again and again while ava's first turn is still
  // running — if the cap were gone, ava would have fired again too.
  await waitFor(() => avaDispatches === 1, "ava's first firing");
  const witnessedAt = witnessDispatches;
  await waitFor(() => witnessDispatches >= witnessedAt + 3, 'three witness firings');
  assert.equal(avaDispatches, 1, 'a second scheduled turn for the same agent waits for the first');

  // The moment the running turn finishes, the deferred slot fires.
  avaFires[0]?.resolve();
  await secondAvaFire.promise;
  runtime.stop();
  for (const gate of avaFires) {
    gate.resolve();
  }
  await runtime.drain();
  store.close();
});

test('missed windows: one late catch-up when the window is still open, a logged skip when it is gone', async () => {
  const home = await newHome();
  const store = new SqliteScheduleStore(path.join(home, 'sessions.db'));
  const fired: Fired[] = [];
  const skips: string[] = [];
  const catchUpFire = deferred<void>();
  const skippedScheduleFire = deferred<void>();

  const runtime = runtimeWith(store, {
    dispatch: async (input) => {
      fired.push(input as Fired);
      if (input.sessionId.startsWith('schedule:missed-open:')) {
        catchUpFire.resolve();
      }
      if (input.sessionId.startsWith('schedule:missed-closed:')) {
        skippedScheduleFire.resolve();
      }
    },
    warn: (line) => skips.push(line),
    log: (line) => skips.push(line),
  });

  const testStart = Date.now();
  // Missed by one second against a ten-minute interval: the window is
  // still open, so this slot gets its one catch-up, late.
  const openSlot = new Date(testStart - 1_000).toISOString();
  store.insert(record({ id: 'missed-open', cadence: { kind: 'every', intervalMs: 600_000 }, nextFireAt: openSlot }));
  // Missed by many intervals: the window has passed entirely — never
  // replayed; the schedule resumes at the next future slot.
  const closedSlot = new Date(testStart - 1_000).toISOString();
  store.insert(record({ id: 'missed-closed', cadence: { kind: 'every', intervalMs: 40 }, nextFireAt: closedSlot }));

  await runtime.start();
  await catchUpFire.promise;
  await skippedScheduleFire.promise;
  runtime.stop();
  await runtime.drain();

  const openFires = fired.filter((entry) => entry.sessionId.startsWith('schedule:missed-open:'));
  assert.equal(openFires.length, 1, 'exactly one catch-up');
  assert.equal(openFires[0]?.sessionId, `schedule:missed-open:${openSlot}`);

  const closedFires = fired.filter((entry) => entry.sessionId.startsWith('schedule:missed-closed:'));
  const firstClosedSlot = closedFires[0]?.sessionId.slice('schedule:missed-closed:'.length) ?? '';
  assert.ok(
    Date.parse(firstClosedSlot) > testStart,
    `the missed slot was replayed: fired ${firstClosedSlot}, missed ${closedSlot}`,
  );
  assert.ok(skips.some((line) => /missed-closed.*missed firing/.test(line)), 'the skip leaves a log line');
  store.close();
});

test('a one-shot fires once and its row is retired after the firing settles', async () => {
  const home = await newHome();
  const store = new SqliteScheduleStore(path.join(home, 'sessions.db'));
  const fires = deferred<void>();
  let dispatches = 0;
  const runtime = runtimeWith(store, {
    dispatch: async () => {
      dispatches += 1;
      fires.resolve();
    },
  });

  const at = new Date(Date.now() - 5).toISOString();
  store.insert(record({ id: 'once', cadence: { kind: 'at', at }, nextFireAt: at }));
  await runtime.start();
  await fires.promise;
  // The row lives exactly as long as the firing it pre-authorizes.
  await waitFor(() => store.get('once') === undefined, 'the spent one-shot to be retired');
  assert.equal(dispatches, 1);
  runtime.stop();
  await runtime.drain();
  store.close();
});

test('a restart during a firing does not double-run it', async () => {
  const home = await newHome();
  const store = new SqliteScheduleStore(path.join(home, 'sessions.db'));

  // First daemon: the dispatch never settles — a firing in flight when the
  // process dies.
  const firedOnce = deferred<void>();
  const first = runtimeWith(store, {
    dispatch: async () => {
      firedOnce.resolve();
      await new Promise(() => {});
    },
  });
  store.insert(record({ id: 'sched-1', cadence: { kind: 'every', intervalMs: 600_000 }, nextFireAt: new Date().toISOString() }));
  store.insert(record({
    id: 'witness',
    agentId: 'bea',
    cadence: { kind: 'every', intervalMs: 20 },
    nextFireAt: new Date().toISOString(),
  }));
  await first.start();
  await firedOnce.promise;
  first.stop(); // The crash: no drain, the dispatch is simply gone.

  // Second daemon over the same store: the slot was consumed before the
  // dispatch, so the same window must not run again.
  let replays = 0;
  let witnessFires = 0;
  const second = runtimeWith(store, {
    dispatch: async (input) => {
      if (input.sessionId.startsWith('schedule:sched-1:')) {
        replays += 1;
      } else {
        witnessFires += 1;
      }
    },
  });
  await second.start();
  await waitFor(() => witnessFires >= 3, 'the second daemon to tick');
  assert.equal(replays, 0, 'the interrupted firing was not re-run');
  second.stop();
  await second.drain();
  store.close();
});

test('the restart sweep retires a spent one-shot unless its turn is still parked on a human', async () => {
  const home = await newHome();
  const store = new SqliteScheduleStore(path.join(home, 'sessions.db'));
  const spentDone = record({ id: 'done', cadence: { kind: 'at', at: '2026-01-01T00:00:00Z' }, lastSessionId: 'schedule:done:x' });
  delete spentDone.nextFireAt;
  const spentParked = record({ id: 'parked', cadence: { kind: 'at', at: '2026-01-01T00:00:00Z' }, lastSessionId: 'schedule:parked:x' });
  delete spentParked.nextFireAt;
  store.insert(spentDone);
  store.insert(spentParked);

  const runtime = runtimeWith(store, {
    sessionStatus: async (sessionId) => (sessionId === 'schedule:parked:x' ? 'pending_approval' : 'completed'),
  });
  await runtime.start();
  runtime.stop();
  await runtime.drain();

  assert.equal(store.get('done'), undefined, 'a finished one-shot is retired');
  assert.ok(store.get('parked'), "a parked one-shot's row is the approval's scope — it stays");
  store.close();
});

test('the destination grant holds only inside a live firing, from the row a human approved', async () => {
  const home = await newHome();
  const store = new SqliteScheduleStore(path.join(home, 'sessions.db'));

  const sessionLike = (sessionId: string, agentId: string, scheduleId?: string): Session => {
    const now = new Date().toISOString();
    return {
      id: sessionId,
      agent: { id: agentId, name: agentId },
      status: 'running',
      messages: [],
      createdAt: now,
      updatedAt: now,
      ...(scheduleId ? { metadata: { [SCHEDULE_ID_METADATA_KEY]: scheduleId } } : {}),
    };
  };

  const during: Array<[string, boolean]> = [];
  const fired = deferred<string>();
  const runtime = runtimeWith(store, {
    dispatch: async (input) => {
      // The checks a firing's own message.send calls would make, taken
      // while the firing is in flight — the only window the grant exists.
      const firing = (agentId: string, scheduleId?: string): Session =>
        sessionLike(input.sessionId, agentId, scheduleId);
      during.push(['declared destination', runtime.isPreauthorized(firing('ava', 'sched-1'), 'slack:C-ENG')]);
      during.push(['other destination', runtime.isPreauthorized(firing('ava', 'sched-1'), 'slack:C-OTHER')]);
      during.push(["another agent's session", runtime.isPreauthorized(firing('bea', 'sched-1'), 'slack:C-ENG')]);
      during.push(['no schedule id', runtime.isPreauthorized(firing('ava'), 'slack:C-ENG')]);
      // Cancelled mid-turn: the very next send gates.
      assert.equal(runtime.cancel('sched-1'), true);
      during.push(['after cancel', runtime.isPreauthorized(firing('ava', 'sched-1'), 'slack:C-ENG')]);
      fired.resolve(input.sessionId);
    },
  });

  store.insert(record({
    id: 'sched-1',
    cadence: { kind: 'every', intervalMs: 600_000 },
    destination: { channel: 'slack', to: 'C-ENG' },
    nextFireAt: new Date(Date.now() - 5).toISOString(),
  }));
  await runtime.start();
  const firingSessionId = await fired.promise;
  runtime.stop();
  await runtime.drain();

  assert.deepEqual(during, [
    ['declared destination', true],
    ['other destination', false],
    ["another agent's session", false],
    ['no schedule id', false],
    ['after cancel', false],
  ]);
  // Once the firing settles the grant is gone with it.
  assert.equal(runtime.isPreauthorized(sessionLike(firingSessionId, 'ava', 'sched-1'), 'slack:C-ENG'), false);
  store.close();
});

test('metadata alone cannot borrow a schedule\'s grant — the session must be a scheduler-started firing', async () => {
  // The control API forwards caller-supplied metadata into new sessions,
  // so a dispatch stamped with a live schedule's id is exactly the forgery
  // this test pins down: right agent, right destination, right metadata —
  // wrong provenance.
  const home = await newHome();
  const store = new SqliteScheduleStore(path.join(home, 'sessions.db'));
  const runtime = runtimeWith(store);
  store.insert(record({
    id: 'sched-1',
    destination: { channel: 'slack', to: 'C-ENG' },
    nextFireAt: new Date(Date.now() + 60_000).toISOString(),
  }));

  const now = new Date().toISOString();
  const forged: Session = {
    id: 'api-dispatched-session',
    agent: { id: 'ava', name: 'ava' },
    status: 'running',
    messages: [],
    createdAt: now,
    updatedAt: now,
    metadata: { scheduled: true, [SCHEDULE_ID_METADATA_KEY]: 'sched-1' },
  };
  assert.equal(runtime.isPreauthorized(forged, 'slack:C-ENG'), false);
  store.close();
});

test('a cancel racing the due scan wins: the claimed-away slot never fires', async () => {
  const home = await newHome();
  const real = new SqliteScheduleStore(path.join(home, 'sessions.db'));
  const fired: string[] = [];
  const witnessFired = deferred<void>();
  let witnessCount = 0;

  // The race, made deterministic: the cancel lands after due() returned
  // the row and before the slot is claimed — exactly the gap `stratus
  // schedules cancel` hits from its own process.
  const racingStore: typeof real = Object.create(real);
  racingStore.due = (nowIso: string) => {
    const rows = real.due(nowIso);
    for (const row of rows) {
      if (row.id === 'doomed') {
        real.delete('doomed');
      }
    }
    return rows;
  };

  const runtime = runtimeWith(racingStore, {
    dispatch: async (input) => {
      fired.push(input.sessionId);
      if (input.sessionId.startsWith('schedule:witness:')) {
        witnessCount += 1;
        if (witnessCount >= 2) {
          witnessFired.resolve();
        }
      }
    },
  });

  real.insert(record({ id: 'doomed', cadence: { kind: 'every', intervalMs: 600_000 }, nextFireAt: new Date().toISOString() }));
  real.insert(record({
    id: 'witness',
    agentId: 'bea',
    cadence: { kind: 'every', intervalMs: 20 },
    nextFireAt: new Date().toISOString(),
  }));
  await runtime.start();
  await witnessFired.promise;
  runtime.stop();
  await runtime.drain();

  assert.ok(fired.every((sessionId) => !sessionId.startsWith('schedule:doomed:')),
    'a cancelled schedule ran anyway — the revoked grant\'s prompt executed');
  real.close();
});

// ---- end to end through the gateway -------------------------------------------

const openAiText = (text: string): Response =>
  new Response(
    JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const openAiToolCall = (name: string, args: object, id = 'call-1'): Response =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
            ],
          },
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const SCHEDULER_SOUL = [
  '---',
  'name: Ava',
  'provider: openai',
  'model: model-a',
  'tools:',
  '  - schedule.*',
  '  - message.send',
  '---',
  '',
  'You are Ava.',
  '',
].join('\n');

interface FakeSlackChannel extends GatewayChannelAdapter {
  posts: Array<{ agentId: string; to: string; text: string }>;
}

/** A slack-shaped adapter: C-ENG is the one conversation the app is in. */
const fakeSlackChannel = (): FakeSlackChannel => {
  const channel: FakeSlackChannel = {
    name: 'slack',
    posts: [],
    async start() {},
    async stop() {},
    async resolveOutbound({ agentId, to }) {
      if (to !== 'C-ENG') {
        throw new Error(`slack: ${agentId}'s app is not a member of ${to} — invite it there before it can post.`);
      }
      return {
        post: async (text: string) => {
          channel.posts.push({ agentId, to, text });
          return { channel: to, ts: '1' };
        },
      };
    },
  };
  return channel;
};

test('an approved schedule fires headless and reports to its declared destination — and nowhere else', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', SCHEDULER_SOUL);

  // ---- phase 1: a person is present. The agent asks for the schedule;
  // the human approves that one gated call through the normal transport.
  let phase1Calls = 0;
  const phase1Fetch = (async () => {
    phase1Calls += 1;
    return phase1Calls === 1
      ? openAiToolCall('schedule_every', {
          every: '1s',
          prompt: 'check the repo and report what changed',
          destination: { channel: 'slack', to: 'C-ENG' },
        })
      : openAiText('scheduled!');
  }) as typeof fetch;

  const env1 = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: phase1Fetch };
  const answered: string[] = [];
  const creation = createGateway({
    env: env1,
    idleTimeoutMs: 0,
    schedules: { minIntervalMs: 500, tickMs: 25 },
    channels: [fakeSlackChannel()],
    approvals: (transport: ApprovalTransport) =>
      createPermissionPolicy({
        mode: 'remote',
        request: transport.request,
        destinations: transport.destinations,
      }),
  });
  await creation.start();
  creation.bus.subscribe((event: StratusEvent) => {
    if (event.type === 'tool.approval-requested') {
      answered.push(event.call.toolName);
      creation.resolveApproval({ requestId: event.requestId, answer: 'once', actor: 'U-DYLAN' });
    }
  });

  const asked = await creation.dispatch({ sessionId: 'slack-thread-1', agentId: 'ava', userMessage: 'check my repo every morning' });
  assert.equal(asked.status, 'completed');
  assert.deepEqual(answered, ['schedule.every'], 'creating the schedule is the human decision');
  const [created] = creation.schedules();
  assert.ok(created, 'the schedule is listable the moment it exists');
  assert.deepEqual(created.destination, { channel: 'slack', to: 'C-ENG' });
  await creation.stop();

  // ---- phase 2: nobody is present. A fresh daemon over the same home —
  // the schedule survived the restart — runs headless, which refuses every
  // gated call except the one destination the human already approved.
  let phase2Calls = 0;
  const phase2Fetch = (async () => {
    phase2Calls += 1;
    if (phase2Calls === 1) {
      return openAiToolCall('message_send', { destination: { channel: 'slack', to: 'C-ENG' }, text: 'all green today' });
    }
    if (phase2Calls === 2) {
      // The same turn trying a channel the schedule never declared.
      return openAiToolCall('message_send', { destination: { channel: 'slack', to: 'C-EXEC' }, text: 'leaking' }, 'call-2');
    }
    return openAiText('done');
  }) as typeof fetch;

  const env2 = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: phase2Fetch };
  const slack = fakeSlackChannel();
  const firingDone = deferred<string>();
  const headless = createGateway({
    env: env2,
    idleTimeoutMs: 0,
    schedules: { tickMs: 25 },
    channels: [slack],
    approvals: (transport: ApprovalTransport) =>
      createPermissionPolicy({
        mode: 'headless',
        destinations: transport.destinations,
      }),
  });
  headless.bus.subscribe((event: StratusEvent) => {
    if (event.type === 'session.completed' && event.sessionId.startsWith('schedule:')) {
      firingDone.resolve(event.sessionId);
    }
  });
  await headless.start();

  const firingSessionId = await firingDone.promise;
  const firing = await headless.store.get(firingSessionId);
  await headless.stop();

  // The report reached the approved channel with no one in the loop…
  assert.deepEqual(slack.posts, [{ agentId: 'ava', to: 'C-ENG', text: 'all green today' }]);
  assert.equal(firing?.status, 'completed');
  assert.equal(firing?.metadata?.[SCHEDULED_TURN_METADATA_KEY], true);
  assert.equal(firing?.messages[0]?.content, 'check the repo and report what changed');
  // …and the undeclared destination was refused exactly as headless
  // refuses any gated call.
  const results = (firing?.messages ?? []).filter((message) => message.toolResult).map((message) => message.toolResult!);
  assert.equal(results.length, 2);
  assert.equal(results[0]?.ok, true);
  assert.equal(results[1]?.ok, false);
  assert.match(results[1]?.error ?? '', /denied by approval policy/);
});

test('a schedule naming an unaddressable destination is refused at creation, not at 6am', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', SCHEDULER_SOUL);

  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return calls === 1
      ? openAiToolCall('schedule_every', {
          every: '1h',
          prompt: 'post somewhere the app is not',
          destination: { channel: 'slack', to: 'C-PRIVATE' },
        })
      : openAiText('understood');
  }) as typeof fetch;

  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const slack = fakeSlackChannel();
  const gateway = createGateway({
    env,
    idleTimeoutMs: 0,
    channels: [slack],
    approvals: (transport: ApprovalTransport) =>
      createPermissionPolicy({ mode: 'remote', request: transport.request, destinations: transport.destinations }),
  });
  await gateway.start();
  gateway.bus.subscribe((event: StratusEvent) => {
    if (event.type === 'tool.approval-requested') {
      gateway.resolveApproval({ requestId: event.requestId, answer: 'once' });
    }
  });

  const session = await gateway.dispatch({ sessionId: 't-1', agentId: 'ava', userMessage: 'schedule it' });
  assert.equal(gateway.schedules().length, 0, 'no row for a schedule that cannot report');
  await gateway.stop();

  const result = session.messages.find((message) => message.toolResult)?.toolResult;
  assert.equal(result?.ok, false);
  assert.match(result?.error ?? '', /not a member of C-PRIVATE/);
});

test('the reserved schedule: session namespace refuses external dispatch', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();
  try {
    await assert.rejects(
      () => gateway.dispatch({ sessionId: 'schedule:sched-1:2026-08-29T07:00:00.000Z', agentId: 'stratus', userMessage: 'inject' }),
      /reserved for scheduled firings/,
    );
    // A firing that is still parked or running has no session an external
    // caller could target either, however derivable the id.
    await assert.rejects(
      () => gateway.dispatch({ sessionId: 'schedule:whatever', agentId: 'stratus', userMessage: 'x' }),
      /reserved for scheduled firings/,
    );
  } finally {
    await gateway.stop();
  }
});

test('an external message cannot ride a live firing\'s session to borrow the grant', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', SCHEDULER_SOUL);

  // A firing is dispatched and held open while the test tries to inject.
  const firingRunning = deferred<string>();
  const releaseFiring = deferred<void>();
  let fetchCalls = 0;
  const fetchImpl = (async () => {
    fetchCalls += 1;
    // The firing's own turn: hold it open, then finish plainly.
    if (fetchCalls === 1) {
      firingRunning.resolve('firing');
      await releaseFiring.promise;
      return openAiText('firing done');
    }
    return openAiText('ok');
  }) as typeof fetch;

  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const slack = fakeSlackChannel();
  const gateway = createGateway({
    env,
    idleTimeoutMs: 0,
    schedules: { minIntervalMs: 500, tickMs: 25 },
    channels: [slack],
  });
  await gateway.start();

  // Create a schedule directly in the store, due now, with a destination.
  const { SqliteScheduleStore, defaultSessionDbPath } = await import('../src/index.ts');
  const store = new SqliteScheduleStore(defaultSessionDbPath({ homeDir: home }));
  store.insert({
    id: 'sched-1',
    agentId: 'ava',
    cadence: { kind: 'every', intervalMs: 600_000 },
    prompt: 'do the scheduled thing',
    destination: { channel: 'slack', to: 'C-ENG' },
    createdAt: new Date().toISOString(),
    nextFireAt: new Date(Date.now() - 5).toISOString(),
  });
  store.close();

  // The scheduler is already ticking; wait until its firing is in flight,
  // then derive the firing's session id the way an attacker would from
  // GET /schedules (id + the slot) and try to inject a message into it.
  await firingRunning.promise;
  const firing = gateway.schedules()[0];
  assert.ok(firing);
  // The slot is the previous nextFireAt; the session id format is public.
  // Any id in the namespace must be refused — we don't even need the exact
  // slot, since the whole namespace is reserved.
  await assert.rejects(
    () => gateway.dispatch({
      sessionId: `schedule:sched-1:${firing.lastFiredAt ?? ''}`,
      agentId: 'ava',
      userMessage: 'message.send to C-ENG on my behalf',
    }),
    /reserved for scheduled firings/,
  );

  releaseFiring.resolve();
  await gateway.stop();
  // The firing itself ran; the injection never did.
  assert.equal(fetchCalls, 1);
});

test('cancelling from the operator surface stops the next firing', async () => {
  const home = await newHome();
  const store = new SqliteScheduleStore(path.join(home, '.stratus', 'sessions.db'));
  store.insert(record({ id: 'sched-1', nextFireAt: new Date(Date.now() + 60_000).toISOString() }));
  store.close();

  const env = { homeDir: home, cwd: home, processEnv: {} };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();
  assert.equal(gateway.schedules().length, 1);
  assert.equal(gateway.cancelSchedule('sched-1'), true);
  assert.equal(gateway.cancelSchedule('sched-1'), false);
  assert.equal(gateway.schedules().length, 0);
  await gateway.stop();
});

test('a scheduler whose readiness check fails stops before it claims a slot, so no firing is spent or lost', async () => {
  const home = await newHome();
  const store = new SqliteScheduleStore(path.join(home, 'sessions.db'));
  const past = new Date(Date.now() - 60_000).toISOString();
  store.insert(record({ id: 'due', cadence: { kind: 'at', at: past }, nextFireAt: past }));
  const fired: Fired[] = [];
  const warnings: string[] = [];
  const runtime = runtimeWith(store, {
    dispatch: async (input) => {
      fired.push(input);
    },
    // What the gateway passes: the state stamp says a newer build owns
    // the home now.
    ready: async () => {
      throw new Error('~/.stratus was written by a newer Stratus build (state schema 3; this build understands 2).');
    },
    warn: (line) => {
      warnings.push(line);
    },
  });
  // At start the refusal propagates — a daemon whose home a newer build has
  // stamped must not begin serving — rather than being logged and swallowed
  // as it is for a stamp that advances under a scheduler already running.
  await assert.rejects(() => runtime.start(), /newer Stratus build/);
  try {
    assert.deepEqual(fired, []);
    assert.deepEqual(warnings, []);
    // The slot is still there for the build that understands it.
    assert.deepEqual(store.due(new Date().toISOString()).map((row) => row.id), ['due']);
  } finally {
    runtime.stop();
    store.close();
  }
});
