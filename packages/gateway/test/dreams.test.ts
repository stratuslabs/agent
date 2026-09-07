import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { JsonObject } from '@stratusagent/core';
import { parseDreams, type DreamFile } from '@stratusagent/agents';
import type { DreamerEntry } from '@stratusagent/state';
import {
  createDreamRuntime,
  createGateway,
  SqliteDreamStore,
  type DreamNightRecord,
  type DreamRuntimeOptions,
} from '../src/index.ts';

const newHome = async (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'stratus-dream-'));

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
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const night = (overrides: Partial<DreamNightRecord> = {}): DreamNightRecord => ({
  agentId: 'ava',
  night: '2026-09-07',
  started: 0,
  finished: 0,
  titles: [],
  source: '/souls/ava.dreams.md',
  openedAt: '2026-09-08T01:00:00.000Z',
  updatedAt: '2026-09-08T01:00:00.000Z',
  ...overrides,
});

// ---- the store ---------------------------------------------------------------

test('the dream store keeps one night per agent, and opens a new one only once', async () => {
  const home = await newHome();
  const store = new SqliteDreamStore(path.join(home, 'sessions.db'));

  assert.equal(store.beginNight(night()), true);
  // The same night again is somebody else's tick, not a new night: refused,
  // because the row it would reset may already have spent a dream.
  assert.equal(store.beginNight(night({ started: 0 })), false);
  store.claimDream(night({ started: 1, titles: ['first'] }), 0);
  assert.equal(store.beginNight(night()), false);
  assert.equal(store.get('ava')?.started, 1);

  // The next night replaces the row and starts the count again.
  assert.equal(store.beginNight(night({ night: '2026-09-08' })), true);
  assert.equal(store.get('ava')?.started, 0);
  assert.deepEqual(store.list().map((record) => record.agentId), ['ava']);
  store.close();
});

test('claiming a dream is conditional on the count the caller read', async () => {
  const home = await newHome();
  const store = new SqliteDreamStore(path.join(home, 'sessions.db'));
  store.beginNight(night());

  assert.equal(store.claimDream(night({ started: 1, titles: ['first'] }), 0), true);
  // A second claimer that read the same 0 loses — one dream, one dispatch.
  assert.equal(store.claimDream(night({ started: 1, titles: ['first again'] }), 0), false);
  assert.equal(store.claimDream(night({ started: 2, titles: ['first', 'second'] }), 1), true);
  assert.deepEqual(store.get('ava')?.titles, ['first', 'second']);

  // Bookkeeping never moves the count.
  store.save({ ...night({ started: 2, titles: ['first', 'second'] }), finished: 1 });
  assert.equal(store.get('ava')?.started, 2);
  assert.equal(store.get('ava')?.finished, 1);
  store.close();
});

// ---- the runtime -------------------------------------------------------------

interface Dreamt {
  sessionId: string;
  agentId: string;
  userMessage: string;
  metadata: JsonObject;
}

const DREAMS = `---
window: 01:00-05:00
---

Nobody is awake.

## First

look at the CI log

## Second

read about WAL

## Third

do not get here
`;

const runtimeWith = (
  store: SqliteDreamStore,
  file: DreamFile,
  dreamt: Dreamt[],
  overrides: Partial<DreamRuntimeOptions> = {},
) => {
  const dreamer: DreamerEntry = {
    agentId: 'ava',
    dreamsPath: '/souls/ava.dreams.md',
    soulPath: '/souls/ava.md',
  };
  return createDreamRuntime({
    store,
    dreamers: async () => [dreamer],
    loadDreams: async () => file,
    dispatch: async (input) => {
      dreamt.push(input);
    },
    limits: { tickMs: 5, maxPerNight: 2 },
    now: () => new Date(2026, 8, 7, 2, 0),
    log: () => {},
    warn: () => {},
    ...overrides,
  });
};

test('a night works through the dream file in order, one at a time, up to the cap', async () => {
  const home = await newHome();
  const store = new SqliteDreamStore(path.join(home, 'sessions.db'));
  const dreamt: Dreamt[] = [];
  const runtime = runtimeWith(store, parseDreams(DREAMS), dreamt);

  await runtime.start();
  await waitFor(() => dreamt.length >= 2, 'two dreams to be dispatched');
  // The cap is the runtime's default for a file that names none: a third
  // dream exists and is deliberately not started.
  await new Promise((resolve) => setTimeout(resolve, 50));
  runtime.stop();
  await runtime.drain();

  assert.deepEqual(dreamt.map((entry) => entry.userMessage.split('\n')[2]), ['## First', '## Second']);
  assert.deepEqual(dreamt.map((entry) => entry.sessionId), [
    'dream:ava:2026-09-07:0',
    'dream:ava:2026-09-07:1',
  ]);
  // Every dream is the operator's own words, marked as a dream and named.
  assert.deepEqual(dreamt[0]?.metadata, { dreaming: true, dreamTitle: 'First', senderTrust: 'user' });
  assert.match(dreamt[0]?.userMessage ?? '', /^Nobody is awake\./);

  const record = store.get('ava');
  assert.equal(record?.night, '2026-09-07');
  assert.equal(record?.started, 2);
  assert.equal(record?.finished, 2);
  assert.deepEqual(record?.titles, ['First', 'Second']);
  store.close();
});

test('a dream spent before the daemon died is not dreamt again after it restarts', async () => {
  const home = await newHome();
  const store = new SqliteDreamStore(path.join(home, 'sessions.db'));
  const file = parseDreams(DREAMS);

  // The night this process is restarting into: one dream claimed, and the
  // turn it dispatched died with the process.
  store.beginNight(night({ night: '2026-09-07' }));
  store.claimDream(night({ night: '2026-09-07', started: 1, titles: ['First'] }), 0);

  const dreamt: Dreamt[] = [];
  const runtime = runtimeWith(store, file, dreamt, { limits: { tickMs: 5, maxPerNight: 3 } });
  await runtime.start();
  await waitFor(() => dreamt.length >= 2, 'the rest of the night to be dreamt');
  runtime.stop();
  await runtime.drain();

  assert.deepEqual(dreamt.map((entry) => entry.metadata.dreamTitle), ['Second', 'Third']);
  assert.equal(store.get('ava')?.started, 3);
  store.close();
});

test('outside the window nothing dreams, and a closed window is never caught up', async () => {
  const home = await newHome();
  const store = new SqliteDreamStore(path.join(home, 'sessions.db'));
  const dreamt: Dreamt[] = [];
  // Noon: the window opened at 01:00 and shut at 05:00 with the daemon down.
  const runtime = runtimeWith(store, parseDreams(DREAMS), dreamt, {
    now: () => new Date(2026, 8, 7, 12, 0),
  });

  await runtime.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
  runtime.stop();
  await runtime.drain();

  assert.deepEqual(dreamt, []);
  assert.equal(store.get('ava'), undefined, 'a night that did not happen leaves no row');
  store.close();
});

test('a dream file that cannot be read is complained about once, not every tick', async () => {
  const home = await newHome();
  const store = new SqliteDreamStore(path.join(home, 'sessions.db'));
  const warnings: string[] = [];
  const runtime = runtimeWith(store, parseDreams(DREAMS), [], {
    loadDreams: async () => {
      throw new Error('Dream file not found: /souls/ava.dreams.md');
    },
    warn: (line) => warnings.push(line),
  });

  await runtime.start();
  // Long enough for many ticks at tickMs 5 — the point is that they do not
  // each write a line into a log that is meant to stay a trace.
  await new Promise((resolve) => setTimeout(resolve, 60));
  runtime.stop();
  await runtime.drain();

  assert.equal(warnings.length, 1, `expected one complaint, got ${warnings.length}`);
  assert.match(warnings[0] ?? '', /ava cannot dream: Dream file not found/);
  store.close();
});

test('a dream that fails is recorded on the night rather than retried', async () => {
  const home = await newHome();
  const store = new SqliteDreamStore(path.join(home, 'sessions.db'));
  const attempted: string[] = [];
  const runtime = runtimeWith(store, parseDreams(DREAMS), [], {
    dispatch: async (input) => {
      attempted.push(String(input.metadata.dreamTitle));
      throw new Error('the provider refused');
    },
    limits: { tickMs: 5, maxPerNight: 1 },
  });

  await runtime.start();
  await waitFor(() => store.get('ava')?.finished === 1, 'the failed dream to be recorded');
  runtime.stop();
  await runtime.drain();

  assert.deepEqual(attempted, ['First'], 'a spent dream is not retried, however it ended');
  assert.equal(store.get('ava')?.lastError, 'the provider refused');
  store.close();
});

// ---- the reserved namespace ---------------------------------------------------

test('the reserved dream: session namespace refuses external dispatch and observe', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();
  try {
    await assert.rejects(
      () => gateway.dispatch({ sessionId: 'dream:ava:2026-09-07:0', agentId: 'stratus', userMessage: 'inject' }),
      /reserved for dreams/,
    );
    await assert.rejects(
      () => gateway.observe({ sessionId: 'dream:ava:2026-09-07:0', message: 'overheard' }),
      /reserved for dreams/,
    );
  } finally {
    await gateway.stop();
  }
});

test('a soul whose dream file sits in the agents\' own workspace does not dream', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const warnings: string[] = [];
  // The one place an agent can write by default is the one place its own
  // standing overnight orders may not come from.
  await writeFile(path.join(home, 'dreamer.md'), [
    '---',
    'name: Ava',
    'id: ava',
    'dreams: ./.stratus/workspaces/ava/DREAMS.md',
    '---',
    '',
    'A researcher.',
    '',
  ].join('\n'));

  const gateway = createGateway({
    env,
    idleTimeoutMs: 0,
    selection: { soul: path.join(home, 'dreamer.md') },
    dreams: { tickMs: 5 },
    warn: (line) => warnings.push(line),
  });
  await gateway.start();
  try {
    await waitFor(
      () => warnings.some((line) => /cannot dream/.test(line)),
      'the refusal to be reported',
    );
    assert.match(
      warnings.find((line) => /cannot dream/.test(line)) ?? '',
      /may not live in .*workspaces/,
    );
    // Many ticks later, still one line: this check runs on a timer all
    // night, and a misconfiguration that repeats a line a minute buries
    // the log it is reported in.
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(
      warnings.filter((line) => /cannot dream/.test(line)).length,
      1,
      'the refusal is said once per message, not once per tick',
    );
  } finally {
    await gateway.stop();
  }
});
