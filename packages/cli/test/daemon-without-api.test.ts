import './home-guard.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { claimHome } from '@stratusagent/gateway';
import { claimFileLock, updateLockPath } from '@stratusagent/state';
import { runCli } from '../src/index.ts';

// A daemon from a plain `npm i -g @stratusagent/cli` has no
// @stratusagent/control-api, so it publishes no gateway.json. It is still
// running, and holds ~/.stratus/stratusd.lock for its whole life: the
// commands that look for it say that, and why it can't be asked, rather
// than that nothing is running.

const createStreams = () => {
  let stdout = '';
  let stderr = '';
  return {
    streams: {
      stdout: { write(chunk: string) { stdout += chunk; return true; } },
      stderr: { write(chunk: string) { stderr += chunk; return true; } },
    },
    output: {
      get stdout() { return stdout; },
      get stderr() { return stderr; },
    },
  };
};

const CONTROL_API = '@stratusagent/control-api';

const newHome = async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-no-api-'));
  await mkdir(path.join(home, '.stratus', 'agents'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'anthropic', model: 'claude-opus-5' }));
  return home;
};

const envFor = (home: string, controlApiInstalled: boolean) => ({
  homeDir: home,
  cwd: home,
  processEnv: {},
  packageResolver: (specifier: string) => specifier !== CONTROL_API || controlApiInstalled,
  fetch: (async () => {
    throw new TypeError('nothing should be asked over HTTP');
  }) as typeof fetch,
});

const run = async (argv: string[], env: ReturnType<typeof envFor>) => {
  const { streams, output } = createStreams();
  const exitCode = await runCli({ argv, streams, env });
  return { exitCode, output };
};

test('health names a running daemon with no control-api package as running, says how to add it, and still exits 1', async () => {
  const home = await newHome();
  const env = envFor(home, false);
  const daemon = claimHome(env);
  try {
    const text = await run(['health'], env);
    assert.equal(text.exitCode, 1);
    assert.match(text.output.stderr, /^Error: stratusd is running, but without a control API/);
    assert.match(text.output.stderr, /@stratusagent\/control-api isn't installed/);
    assert.match(text.output.stderr, /npm install -g @stratusagent\/control-api@\d+\.\d+\.\d+/);
    // Not the flag nobody passed.
    assert.doesNotMatch(text.output.stderr, /--no-api/);
    assert.doesNotMatch(text.output.stderr, /Usage:/);

    const json = await run(['health', '--format', 'json'], env);
    assert.equal(json.exitCode, 1);
    const payload = JSON.parse(json.output.stdout) as { ok: boolean; error: string };
    assert.equal(payload.ok, false);
    assert.match(payload.error, /running, but without a control API/);
  } finally {
    daemon.release();
  }
});

test('with the package installed, a daemon that published nothing is still starting or has its API off', async () => {
  const home = await newHome();
  const env = envFor(home, true);
  const daemon = claimHome(env);
  try {
    const text = await run(['health'], env);
    assert.equal(text.exitCode, 1);
    assert.match(text.output.stderr, /stratusd is running but has not published a control API/);
    assert.match(text.output.stderr, /still starting or restarting/);
    assert.match(text.output.stderr, /--no-api or api\.enabled: false/);
    assert.doesNotMatch(text.output.stderr, /isn't installed/);
  } finally {
    daemon.release();
  }
});

test('with nothing holding the home, health says no daemon is running and blames no flag', async () => {
  const home = await newHome();
  const env = envFor(home, false);
  const text = await run(['health'], env);
  assert.equal(text.exitCode, 1);
  assert.match(text.output.stderr, /^Error: stratusd is not running for this home/);
  assert.match(text.output.stderr, /Start it with `stratus serve` or `stratus service start`/);
  assert.doesNotMatch(text.output.stderr, /--no-api/);
  // Asking made no lock file.
  await assert.rejects(access(path.join(home, '.stratus', 'stratusd.lock')), { code: 'ENOENT' });
});

test('doctor shows a daemon running without a control API, and why, without calling it a problem', async () => {
  const home = await newHome();
  const env = envFor(home, false);
  const daemon = claimHome(env);
  try {
    const text = await run(['doctor'], env);
    assert.match(text.output.stdout, /daemon {4}running without a control API\n/);
    assert.match(text.output.stdout, /@stratusagent\/control-api isn't installed/);
    assert.match(text.output.stdout, /npm install -g @stratusagent\/control-api@\d+\.\d+\.\d+/);
    assert.doesNotMatch(text.output.stdout, /none found/);
    // Information, not a problem: a daemon without the API is a supported setup.
    assert.doesNotMatch(text.output.stdout, /^ {2}! .*control API/m);

    const json = await run(['doctor', '--format', 'json'], env);
    const report = JSON.parse(json.output.stdout) as { daemon: { state: string; packageMissing?: boolean } };
    assert.deepEqual(report.daemon, { state: 'without-api', packageMissing: true });
  } finally {
    daemon.release();
  }
});

test('doctor with nothing holding the home says none is running', async () => {
  const home = await newHome();
  const env = envFor(home, true);
  const text = await run(['doctor'], env);
  assert.match(text.output.stdout, /daemon {4}none running\n/);
  const json = await run(['doctor', '--format', 'json'], env);
  assert.deepEqual((JSON.parse(json.output.stdout) as { daemon: unknown }).daemon, { state: 'no-api' });
});

test('commands that ask the daemon say it runs without a control API instead of that none was found', async () => {
  const home = await newHome();
  const env = envFor(home, false);
  const daemon = claimHome(env);
  try {
    for (const argv of [['restart'], ['sessions'], ['tasks'], ['skill', 'reload'], ['events']]) {
      const result = await run(argv, env);
      assert.equal(result.exitCode, 1, argv.join(' '));
      assert.match(result.output.stderr, /^Error: stratusd is running, but without a control API/, argv.join(' '));
      assert.doesNotMatch(result.output.stderr, /no running daemon found|not serving/, argv.join(' '));
    }
  } finally {
    daemon.release();
  }
  // Released: the old sentence, as before.
  const after = await run(['restart'], env);
  assert.match(after.output.stderr, /^Error: no running daemon found/);
});

test('while `stratus update` holds the home to migrate it, readers say so instead of naming a daemon', async () => {
  // The update holds the same home lock a daemon does, with no daemon
  // running. Its own lock beside it is what tells the two apart.
  const home = await newHome();
  const env = envFor(home, false);
  const update = claimFileLock(updateLockPath(env));
  const claim = claimHome(env);
  try {
    const health = await run(['health'], env);
    assert.equal(health.exitCode, 1);
    assert.match(health.output.stderr, /^Error: `stratus update` is migrating this home/);
    assert.doesNotMatch(health.output.stderr, /stratusd is running|isn't installed|npm install/);

    const doctor = await run(['doctor'], env);
    assert.match(doctor.output.stdout, /daemon {4}stopped while `stratus update` migrates this home\n/);
    assert.doesNotMatch(doctor.output.stdout, /isn't installed|npm install -g @stratusagent\/control-api/);
    const json = await run(['doctor', '--format', 'json'], env);
    assert.deepEqual((JSON.parse(json.output.stdout) as { daemon: unknown }).daemon, { state: 'updating' });

    const restart = await run(['restart'], env);
    assert.equal(restart.exitCode, 1);
    assert.match(restart.output.stderr, /^Error: `stratus update` is migrating this home/);
  } finally {
    claim.release();
    update.release();
  }
});

test('the update lock alone, with the home free, is not a daemon', async () => {
  // Taken before the home and let go after it, so this is the instant
  // around the update's claim: nothing holds the home, nothing is running.
  const home = await newHome();
  const env = envFor(home, false);
  const update = claimFileLock(updateLockPath(env));
  try {
    const health = await run(['health'], env);
    assert.match(health.output.stderr, /^Error: stratusd is not running for this home/);
  } finally {
    update.release();
  }
});
