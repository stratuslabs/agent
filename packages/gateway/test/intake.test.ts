import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { intakeStatePath } from '@stratusagent/state';
import { createGateway, DEFAULT_PAUSED_MESSAGE, IntakePausedError } from '../src/index.ts';

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

test('an intake file that is JSON but not a pause record starts paused, and says why', async () => {
  for (const contents of ['{}', '{ "paused": "true" }', '{ "paused": false }', 'null', '[]']) {
    const home = await newHome();
    const env = { homeDir: home, cwd: home, processEnv: {} };
    const probe = createGateway({ env, idleTimeoutMs: 0 });
    await probe.start();
    await probe.stop();
    await writeFile(intakeStatePath(env), contents, { mode: 0o600 });

    const warnings: string[] = [];
    const gateway = createGateway({ env, idleTimeoutMs: 0, warn: (line: string) => warnings.push(line) });
    await gateway.start();
    try {
      assert.equal(gateway.intake().paused, true, `opened on ${contents}`);
      assert.ok(warnings.some((line) => line.includes(intakeStatePath(env))), warnings.join('\n'));
    } finally {
      await gateway.stop();
    }
  }
});

test('overlapping pause and resume calls leave memory and disk agreeing', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await gateway.start();
  try {
    for (let round = 0; round < 20; round += 1) {
      await Promise.all([gateway.pauseIntake({ message: `round ${round}` }), gateway.resumeIntake()]);
      // Called in that order, so the resume is the last word, on disk too.
      assert.equal(gateway.intake().paused, false);
      await assert.rejects(readFile(intakeStatePath(env), 'utf8'), { code: 'ENOENT' });

      await Promise.all([gateway.resumeIntake(), gateway.pauseIntake({ message: `round ${round}` })]);
      assert.equal(gateway.intake().paused, true);
      assert.equal(JSON.parse(await readFile(intakeStatePath(env), 'utf8')).paused, true);
    }
    await gateway.resumeIntake();
  } finally {
    await gateway.stop();
  }
});
