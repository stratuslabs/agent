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
  answer: number | 'offline' | 'hang' | ((url: string) => Response),
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
  const calls: Array<{ url: string; key: string | undefined; body?: unknown }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      key: (init?.headers as Record<string, string> | undefined)?.['x-api-key'],
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}),
    });
    if (typeof answer === 'function') {
      return answer(String(url));
    }
    if (answer === 'offline') {
      throw new TypeError('fetch failed');
    }
    if (answer === 'hang') {
      // Accepts the connection and never answers, and ignores any abort
      // signal, so only doctor's own deadline can end the wait.
      return new Promise<Response>(() => {});
    }
    // A 200 from the one-token call carries a message, as a real one does:
    // the probe calls a 200 without a completion a refusal.
    const body = answer === 200 && String(url).endsWith('/v1/messages')
      ? JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'p' }], stop_reason: 'max_tokens' })
      : '{}';
    return new Response(body, { status: answer });
  }) as typeof fetch;
  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv,
    streams,
    env: { cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-cwd-')), homeDir: home, processEnv: {}, fetch: fetchImpl },
  });
  return { exitCode, output, calls };
};

/**
 * Run mocked timers forward until `done`, for up to 10 real seconds. A fixed
 * number of turns is not enough on a slow runner: doctor reads files before
 * it sets its deadline, and ticks before that move nothing.
 */
const driveClock = async (done: () => boolean): Promise<void> => {
  const realDeadline = performance.now() + 10_000;
  while (!done() && performance.now() < realDeadline) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    mock.timers.tick(5_000);
  }
};

test('doctor without --live never calls a provider', async () => {
  const { exitCode, calls, output } = await doctor(['doctor'], 401);
  assert.equal(exitCode, 0);
  assert.deepEqual(calls, []);
  assert.doesNotMatch(output.stdout, /Live check/);
});

test('doctor --live says the provider accepted the key and the configured model answered', async () => {
  const { exitCode, calls, output } = await doctor(['doctor', '--live'], 200);
  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [
    { url: 'https://api.anthropic.com/v1/models', key: 'sk-ant-stored' },
    {
      url: 'https://api.anthropic.com/v1/messages',
      key: 'sk-ant-stored',
      body: { model: 'claude-opus-5', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
    },
  ]);
  assert.match(output.stdout, /Live check\n {2}anthropic +key accepted · claude-opus-5 answered/);
  assert.match(output.stdout, /No problems found\./);
});

/** Accepts the key, then answers the one-token call with `status` and an API-style error body. */
const modelAnswers = (status: number, message?: string) => (url: string) => (url.endsWith('/v1/models')
  ? new Response('{}', { status: 200 })
  : new Response(JSON.stringify(message ? { type: 'error', error: { type: 'x', message } } : {}), { status }));

test('doctor --live makes a model the provider will not run a problem, with its reason', async () => {
  const { exitCode, output } = await doctor(['doctor', '--live'], modelAnswers(404, 'model: claude-opus-5'));
  assert.equal(exitCode, 1);
  assert.match(output.stdout, /anthropic +key accepted · claude-opus-5 refused \(HTTP 404: model: claude-opus-5\)/);
  assert.match(output.stdout, /anthropic accepted the key but would not run claude-opus-5 \(HTTP 404: model: claude-opus-5\), so every such run fails/);
});

test('doctor --live reports an account the provider will not bill as a problem', async () => {
  const { exitCode, output } = await doctor(['doctor', '--live'], modelAnswers(400, 'Your credit balance is too low to access the Anthropic API.'));
  assert.equal(exitCode, 1);
  assert.match(output.stdout, /claude-opus-5 refused \(HTTP 400: Your credit balance is too low/);
});

test('doctor --live does not condemn a model when the provider is busy', async () => {
  for (const status of [429, 500, 529]) {
    const { exitCode, output } = await doctor(['doctor', '--live'], modelAnswers(status, 'Overloaded'));
    assert.equal(exitCode, 0, `HTTP ${status}`);
    assert.match(output.stdout, new RegExp(`claude-opus-5 did not answer \\(HTTP ${status}: Overloaded\\); the model was not judged`));
    assert.match(output.stdout, /No problems found\./);
  }
});

test('doctor --live --format json carries the model check', async () => {
  const { output } = await doctor(['doctor', '--live', '--format', 'json'], modelAnswers(404, 'model: claude-opus-5'));
  const report = JSON.parse(output.stdout) as { keyChecks: unknown[] };
  assert.deepEqual(report.keyChecks, [{
    provider: 'anthropic',
    role: 'default',
    status: 'accepted',
    model: { id: 'claude-opus-5', status: 'refused', detail: 'HTTP 404: model: claude-opus-5' },
  }]);
});

test('doctor --live makes a refused key a problem', async () => {
  const { exitCode, output, calls } = await doctor(['doctor', '--live'], 401);
  assert.equal(exitCode, 1);
  // A refused key has nothing to ask the model with.
  assert.equal(calls.length, 1);
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
    await driveClock(() => finished);
    assert.ok(finished, 'doctor --live hung on a provider that never answered');
    const { exitCode, output } = await run;
    assert.equal(exitCode, 0);
    assert.match(output.stdout, /anthropic +no answer \(no answer within 10s\); the key was not judged/);
  } finally {
    mock.timers.reset();
  }
});

test('doctor --live gives up on a model reply that stalls mid-body', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    // Headers arrive, the body never finishes.
    const run = doctor(['doctor', '--live'], (url) => (url.endsWith('/v1/models')
      ? new Response('{}', { status: 200 })
      : new Response(new ReadableStream({ start() {} }), { status: 500 })));
    let finished = false;
    void run.then(() => { finished = true; });
    await driveClock(() => finished);
    assert.ok(finished, 'doctor --live hung on a reply body that never finished');
    const { exitCode, output } = await run;
    assert.equal(exitCode, 0);
    assert.match(output.stdout, /claude-opus-5 did not answer \(no answer within 10s\); the model was not judged/);
  } finally {
    mock.timers.reset();
  }
});
