import './home-guard.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runCli } from '../src/index.ts';

// `stratus doctor`'s chatgpt line: the ChatGPT sign-in lives in its own file
// (~/.stratus/chatgpt-sign-in.json), not credentials.json, so doctor reads
// it there and reports the account, whether it may use the plan, and when
// the access token runs out. Never a token.

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

// 2100-01-01T00:00:00Z and 2000-01-01T00:00:00Z.
const FUTURE = 4_102_444_800_000;
const PAST = 946_684_800_000;

const session = (overrides: object = {}) => ({
  clientId: 'oaiapp_issued123',
  subject: 'user-sub-1',
  email: 'person@example.com',
  idToken: 'id-secret-1',
  accessToken: 'access-secret-1',
  refreshToken: 'refresh-secret-1',
  expiresAt: FUTURE,
  scopes: ['openid', 'chatgpt.tokens.use.direct'],
  savedAt: 1_700_000_000_000,
  ...overrides,
});

const doctor = async (options: { config?: object; signIn?: object | string; credentials?: object; format?: 'json' } = {}) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  if (options.config) {
    await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify(options.config), { mode: 0o600 });
  }
  if (options.credentials) {
    // Synthetic values only.
    await writeFile(path.join(home, '.stratus', 'credentials.json'), JSON.stringify(options.credentials), { mode: 0o600 });
  }
  if (options.signIn !== undefined) {
    await writeFile(
      path.join(home, '.stratus', 'chatgpt-sign-in.json'),
      typeof options.signIn === 'string' ? options.signIn : JSON.stringify(options.signIn),
      { mode: 0o600 },
    );
  }
  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['doctor', ...(options.format ? ['--format', options.format] : [])],
    streams,
    env: { cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-cwd-')), homeDir: home, processEnv: {} },
  });
  const line = output.stdout.split('\n').find((entry) => entry.startsWith('  chatgpt '));
  return { exitCode, output, line };
};

test('doctor reports the ChatGPT account a chatgpt run uses and when its access token expires, never a token', async () => {
  const { output, line } = await doctor({ config: { provider: 'chatgpt' }, signIn: { session: session() } });
  assert.match(output.stdout, /provider {2}chatgpt/);
  assert.equal(
    line,
    '  chatgpt   ChatGPT sign-in (person@example.com), plan usage allowed; access token valid until 2100-01-01 00:00 UTC, renewed as it runs out',
  );
  assert.doesNotMatch(output.stdout + output.stderr, /secret/);
});

test('doctor says an expired access token is renewed by the next run', async () => {
  const { line } = await doctor({ config: { provider: 'chatgpt' }, signIn: { session: session({ expiresAt: PAST }) } });
  assert.equal(
    line,
    '  chatgpt   ChatGPT sign-in (person@example.com), plan usage allowed; access token expired 2000-01-01 00:00 UTC, the next run renews it',
  );
});

test('doctor prints an expiry past the year 9999 whole', async () => {
  // 10000-01-01T00:00:00Z; toISOString writes the year as +010000.
  const { line } = await doctor({ config: { provider: 'chatgpt' }, signIn: { session: session({ expiresAt: 253_402_300_800_000 }) } });
  assert.equal(
    line,
    '  chatgpt   ChatGPT sign-in (person@example.com), plan usage allowed; access token valid until +010000-01-01 00:00 UTC, renewed as it runs out',
  );
});

test('doctor calls a sign-in with an expiry no Date can hold signed in, without the expiry', async () => {
  const { line } = await doctor({ config: { provider: 'chatgpt' }, signIn: { session: session({ expiresAt: Number.MAX_VALUE }) } });
  assert.equal(line, '  chatgpt   ChatGPT sign-in (person@example.com), plan usage allowed');
});

test('doctor leaves the expiry out when the sign-in has none', async () => {
  const { line } = await doctor({ config: { provider: 'chatgpt' }, signIn: { session: session({ expiresAt: undefined }) } });
  assert.equal(line, '  chatgpt   ChatGPT sign-in (person@example.com), plan usage allowed');
});

test('doctor names a ChatGPT sign-in that may not use the plan', async () => {
  const { exitCode, output, line } = await doctor({
    config: { provider: 'chatgpt' },
    signIn: { session: session({ scopes: ['openid', 'email'] }) },
  });
  assert.equal(exitCode, 1);
  assert.equal(line, '  chatgpt   ChatGPT sign-in (person@example.com) without plan usage, so no run can use it');
  // The run's own refusal is the problem doctor reports.
  assert.match(output.stdout, /doesn't allow Stratus Agent to use your ChatGPT plan/);
});

test('doctor names the account of a signed-out ChatGPT sign-in', async () => {
  const { line } = await doctor({
    config: { provider: 'chatgpt' },
    signIn: { session: session({ idToken: undefined, accessToken: undefined, refreshToken: undefined }) },
  });
  assert.equal(line, '  chatgpt   signed out (person@example.com)');
});

test('doctor reports chatgpt not signed in when there is no sign-in file', async () => {
  const { line } = await doctor({ config: { provider: 'anthropic' }, credentials: { anthropic: { type: 'api_key', value: 'sk-ant-x' } } });
  assert.equal(line, '  chatgpt   not signed in');
});

test('doctor marks a ChatGPT sign-in no run uses as unused', async () => {
  const { line } = await doctor({
    config: { provider: 'anthropic' },
    credentials: { anthropic: { type: 'api_key', value: 'sk-ant-x' } },
    signIn: { session: session() },
  });
  assert.match(line ?? '', /^ {2}chatgpt {3}ChatGPT sign-in \(person@example\.com\), plan usage allowed; .* \(unused — anthropic serves your runs\)$/);
});

test('doctor does not call a ChatGPT sign-in used only by the fallback unused', async () => {
  const { line } = await doctor({
    config: { provider: 'anthropic', fallbackProvider: 'chatgpt', fallbackModel: 'gpt-5.4-mini' },
    credentials: { anthropic: { type: 'api_key', value: 'sk-ant-x' } },
    signIn: { session: session() },
  });
  assert.match(line ?? '', /^ {2}chatgpt {3}ChatGPT sign-in \(person@example\.com\)/);
  assert.doesNotMatch(line ?? '', /unused/);
});

test('doctor says the ChatGPT sign-in file cannot be read, and goes on', async () => {
  const { output, line } = await doctor({
    config: { provider: 'anthropic' },
    credentials: { anthropic: { type: 'api_key', value: 'sk-ant-x' } },
    signIn: 'not json',
  });
  assert.match(line ?? '', /^ {2}chatgpt {3}unreadable: .*chatgpt-sign-in\.json is not valid JSON/);
  assert.match(output.stdout, /provider {2}anthropic/);
});

test('doctor --format json lists the chatgpt sign-in with the others', async () => {
  const { output } = await doctor({ config: { provider: 'chatgpt' }, signIn: { session: session() }, format: 'json' });
  const report = JSON.parse(output.stdout) as { signIns: Array<{ provider: string; status: string }> };
  const entry = report.signIns.find((signIn) => signIn.provider === 'chatgpt');
  assert.match(entry?.status ?? '', /^ChatGPT sign-in \(person@example\.com\), plan usage allowed/);
  assert.doesNotMatch(output.stdout, /secret/);
});
