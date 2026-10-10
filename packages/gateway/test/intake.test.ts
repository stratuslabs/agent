import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { fleetDbPath, intakeStatePath } from '@stratusagent/state';
import {
  createGateway,
  DEFAULT_PAUSED_MESSAGE,
  HELD_MESSAGE,
  IntakePausedError,
  SqliteScheduleStore,
  type Gateway,
  type GatewayChannelAdapter,
} from '../src/index.ts';

const newHome = async (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'stratus-intake-'));

test('a paused gateway refuses new work with its message, and finishes the turn already running', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();
  try {
    assert.deepEqual(gateway.intake(), { paused: false });

    const running = gateway.dispatch({ sessionId: 'in-flight', userMessage: 'say hello' });
    const state = await gateway.pauseIntake({ message: 'Paused: the usage limit is reached.' });
    assert.equal(state.paused, true);
    assert.equal(state.message, 'Paused: the usage limit is reached.');
    assert.ok(state.since && !Number.isNaN(Date.parse(state.since)));

    await assert.rejects(
      () => gateway.dispatch({ sessionId: 'new-work', userMessage: 'too late' }),
      (error: unknown) => error instanceof IntakePausedError
        && error.name === 'IntakePausedError'
        && error.message === 'Paused: the usage limit is reached.',
    );
    const session = await running;
    assert.equal(session.status, 'completed');

    await gateway.resumeIntake();
    assert.deepEqual(gateway.intake(), { paused: false });
    const after = await gateway.dispatch({ sessionId: 'new-work', userMessage: 'hello again' });
    assert.equal(after.status, 'completed');
  } finally {
    await gateway.stop();
  }
});

test('pausing without a message uses the default sentence', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();
  try {
    await gateway.pauseIntake();
    await assert.rejects(
      () => gateway.dispatch({ sessionId: 'x', userMessage: 'hi' }),
      (error: unknown) => error instanceof IntakePausedError && error.message === DEFAULT_PAUSED_MESSAGE,
    );
  } finally {
    await gateway.stop();
  }
});

test('a pause survives a restart, so a crash cannot reopen intake', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const first = createGateway({ env, idleTimeoutMs: 0 });
  await first.start();
  await first.pauseIntake({ message: 'Paused for maintenance.' });
  await first.stop();

  const file = intakeStatePath(env);
  assert.equal((await stat(file)).mode & 0o777, 0o600);

  const second = createGateway({ env, idleTimeoutMs: 0 });
  await second.start();
  try {
    assert.equal(second.intake().paused, true);
    await assert.rejects(
      () => second.dispatch({ sessionId: 'x', userMessage: 'hi' }),
      (error: unknown) => error instanceof IntakePausedError && error.message === 'Paused for maintenance.',
    );
    await second.resumeIntake();
  } finally {
    await second.stop();
  }

  // Resumed is the default, so nothing is left on disk to say otherwise.
  await assert.rejects(readFile(file, 'utf8'), { code: 'ENOENT' });
});

test('an unreadable intake file starts paused, and says why', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const warnings: string[] = [];
  const probe = createGateway({ env, idleTimeoutMs: 0 });
  await probe.start();
  await probe.stop();
  await writeFile(intakeStatePath(env), '{ not json', { mode: 0o600 });

  // Fails closed: a pause exists to stop spending, and a file nobody can
  // read is no evidence the pause was lifted.
  const gateway = createGateway({ env, idleTimeoutMs: 0, warn: (line: string) => warnings.push(line) });
  await gateway.start();
  try {
    assert.equal(gateway.intake().paused, true);
    assert.ok(warnings.some((line) => line.includes(intakeStatePath(env))), warnings.join('\n'));
  } finally {
    await gateway.stop();
  }
});

test('a pause message is bounded', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();
  try {
    await assert.rejects(() => gateway.pauseIntake({ message: 'x'.repeat(501) }), /500/);
    await assert.rejects(() => gateway.pauseIntake({ message: '   ' }), /empty/);
    assert.equal(gateway.intake().paused, false);
  } finally {
    await gateway.stop();
  }
});

// ---- a held start --------------------------------------------------------------


const recordingAdapter = (name: string, order: string[], servesWhileHeld?: boolean): GatewayChannelAdapter => ({
  name,
  ...(servesWhileHeld !== undefined ? { servesWhileHeld } : {}),
  async start(_gateway: Gateway) {
    order.push(`start ${name}`);
  },
  async stop() {
    order.push(`stop ${name}`);
  },
});

test('a held gateway starts only what serves while held, refuses work, and promote brings up the rest', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const order: string[] = [];
  const gateway = createGateway({
    env,
    idleTimeoutMs: 0,
    held: true,
    channels: [recordingAdapter('operator', order, true), recordingAdapter('chat', order)],
  });
  await gateway.start();
  try {
    assert.equal(gateway.held(), true);
    assert.deepEqual(order, ['start operator']);
    await assert.rejects(
      () => gateway.dispatch({ sessionId: 'held-1', userMessage: 'hello' }),
      (error: unknown) => error instanceof IntakePausedError && error.message === HELD_MESSAGE,
    );

    await gateway.promote();
    assert.equal(gateway.held(), false);
    assert.deepEqual(order, ['start operator', 'start chat']);
    const session = await gateway.dispatch({ sessionId: 'held-1', userMessage: 'hello' });
    assert.equal(session.status, 'completed');

    // Promoting again changes nothing and starts nothing twice.
    await gateway.promote();
    assert.deepEqual(order, ['start operator', 'start chat']);
  } finally {
    await gateway.stop();
  }
  assert.deepEqual(order.slice(2).sort(), ['stop chat', 'stop operator']);
});

test('a gateway that is not held ignores promote and starts every channel', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const order: string[] = [];
  const gateway = createGateway({ env, idleTimeoutMs: 0, channels: [recordingAdapter('operator', order, true), recordingAdapter('chat', order)] });
  await gateway.start();
  try {
    assert.equal(gateway.held(), false);
    await gateway.promote();
    assert.deepEqual(order, ['start operator', 'start chat']);
  } finally {
    await gateway.stop();
  }
});

test('a held gateway fires no schedule until promoted', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const probe = createGateway({ env, idleTimeoutMs: 0 });
  await probe.start();
  await probe.stop();

  const store = new SqliteScheduleStore(fleetDbPath(env));
  const slot = new Date(Date.now() - 5).toISOString();
  store.insert({
    id: 'held-sched',
    agentId: 'stratus',
    cadence: { kind: 'every', intervalMs: 600_000 },
    prompt: 'say hello',
    createdAt: new Date().toISOString(),
    nextFireAt: slot,
  });
  store.close();

  const gateway = createGateway({ env, idleTimeoutMs: 0, held: true, schedules: { minIntervalMs: 1, tickMs: 10 } });
  await gateway.start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(gateway.schedules().find((row) => row.id === 'held-sched')?.nextFireAt, slot, 'nothing fired while held');

    await gateway.promote();
    const deadline = Date.now() + 5_000;
    while (gateway.schedules().find((row) => row.id === 'held-sched')?.nextFireAt === slot && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.notEqual(gateway.schedules().find((row) => row.id === 'held-sched')?.nextFireAt, slot, 'the slot fired once promoted');
  } finally {
    await gateway.stop();
  }
});
