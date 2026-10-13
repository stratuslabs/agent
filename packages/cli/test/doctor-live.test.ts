import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runCli } from '../src/index.ts';

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

/**
 * A home with an anthropic default and no daemon, and a provider that
 * answers its models endpoint with `answer` — or throws, for an offline
 * machine. Every URL asked is recorded, so a test can say none was.
 */
const doctor = async (
  argv: string[],
  answer: number | 'offline' | 'hang',
  credential: Record<string, unknown> = { type: 'api_key', value: 'sk-ant-stored' },
) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus', 'agents'), { recursive: true });
  await writeFile(
    path.join(home, '.stratus', 'config.json'),
    JSON.stringify({ provider: 'anthropic', model: 'claude-opus-5' }),
    { mode: 0o600 },
  );
  await writeFile(path.join(home, '.stratus', 'credentials.json'), JSON.stringify({ anthropic: credential }));
  const calls: Array<{ url: string; key: string | undefined }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), key: (init?.headers as Record<string, string> | undefined)?.['x-api-key'] });
    if (answer === 'offline') {
      throw new TypeError('fetch failed');
    }
    if (answer === 'hang') {
      // Accepts the connection and never answers, and ignores any abort
      // signal, so only doctor's own deadline can end the wait.
      return new Promise<Response>(() => {});
    }
    return new Response('{}', { status: answer });
  }) as typeof fetch;
  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv,
    streams,
    env: { cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-cwd-')), homeDir: home, processEnv: {}, fetch: fetchImpl },
  });
  return { exitCode, output, calls };
};

test('doctor without --live never calls a provider', async () => {
  const { exitCode, calls, output } = await doctor(['doctor'], 401);
  assert.equal(exitCode, 0);
  assert.deepEqual(calls, []);
  assert.doesNotMatch(output.stdout, /Live check/);
});

test('doctor --live says the provider accepted the key a run would send', async () => {
  const { exitCode, calls, output } = await doctor(['doctor', '--live'], 200);
  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [{ url: 'https://api.anthropic.com/v1/models', key: 'sk-ant-stored' }]);
  assert.match(output.stdout, /Live check\n {2}anthropic +key accepted/);
  assert.match(output.stdout, /No problems found\./);
});

test('doctor --live makes a refused key a problem', async () => {
  const { exitCode, output } = await doctor(['doctor', '--live'], 401);
  assert.equal(exitCode, 1);
  assert.match(output.stdout, /anthropic +key refused \(HTTP 401\)/);
  assert.match(output.stdout, /anthropic refused the key your runs send \(HTTP 401\)/);
});

test('doctor --live on an offline machine does not condemn the key', async () => {
  const { exitCode, output } = await doctor(['doctor', '--live'], 'offline');
  assert.equal(exitCode, 0);
  assert.match(output.stdout, /anthropic +no answer \(fetch failed\); the key was not judged/);
  assert.match(output.stdout, /No problems found\./);
});

test('doctor --live does not send a subscription token to the key check', async () => {
  const { exitCode, calls, output } = await doctor(['doctor', '--live'], 401, { type: 'oauth_token', value: 'sk-ant-oat-stored' });
  assert.equal(exitCode, 0);
  assert.deepEqual(calls, []);
  assert.match(output.stdout, /anthropic +not checked: subscription sign-in, which has no key to check/);
});

test('doctor --live --format json reports the checks as data', async () => {
  const { exitCode, output } = await doctor(['doctor', '--live', '--format', 'json'], 401);
  assert.equal(exitCode, 1);
  const report = JSON.parse(output.stdout) as { keyChecks: unknown[] };
  assert.deepEqual(report.keyChecks, [{ provider: 'anthropic', role: 'default', status: 'rejected', detail: 'HTTP 401' }]);
});

test('doctor --live gives up on a provider that never answers and does not judge the key', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const run = doctor(['doctor', '--live'], 'hang');
    let finished = false;
    void run.then(() => { finished = true; });
    // Let doctor reach the probe, then run its deadline out.
    for (let i = 0; i < 200 && !finished; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      mock.timers.tick(5_000);
    }
    assert.ok(finished, 'doctor --live hung on a provider that never answered');
    const { exitCode, output } = await run;
    assert.equal(exitCode, 0);
    assert.match(output.stdout, /anthropic +no answer \(no answer within 10s\); the key was not judged/);
  } finally {
    mock.timers.reset();
  }
});
