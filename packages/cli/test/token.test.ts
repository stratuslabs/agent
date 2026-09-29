import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createControlApi } from '@stratusagent/control-api';
import { createGateway } from '@stratusagent/gateway';

import { parseCommand, runCli } from '../src/index.ts';

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

const newHome = (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'stratus-token-'));

const run = async (home: string, argv: string[]) => {
  const captured = createStreams();
  const code = await runCli({ argv, streams: captured.streams, env: { homeDir: home, cwd: home, processEnv: {} } });
  return { code, stdout: captured.output.stdout, stderr: captured.output.stderr };
};

test('stratus token create prints the token once, alone on stdout, and stores only its hash in a 0600 file', async () => {
  const home = await newHome();
  const created = await run(home, ['token', 'create', 'alice']);
  assert.equal(created.code, 0, created.stderr);
  const token = created.stdout.trim();
  assert.match(token, /^stm_[A-Za-z0-9_-]{43}$/, 'stdout is exactly the token, so it can be redirected to a file');
  assert.match(created.stderr, /only time it is shown/);

  const file = path.join(home, '.stratus', 'api-tokens.json');
  const raw = await readFile(file, 'utf8');
  assert.ok(!raw.includes(token), 'the token itself is never written');
  assert.equal((await stat(file)).mode & 0o777, 0o600);

  // Neither listing shows it again.
  const list = await run(home, ['token', 'list']);
  assert.match(list.stdout, /^tok_[0-9a-f]{12} {2}alice {2}member {2}created /);
  assert.ok(!list.stdout.includes(token));
  const json = await run(home, ['tokens', '--format', 'json']);
  const listed = JSON.parse(json.stdout) as { tokens: Array<Record<string, unknown>> };
  assert.deepEqual(Object.keys(listed.tokens[0] ?? {}).sort(), ['createdAt', 'id', 'name', 'role']);

  const duplicate = await run(home, ['token', 'create', 'Alice']);
  assert.equal(duplicate.code, 1);
  assert.match(duplicate.stderr, /A token named alice already exists \(tok_[0-9a-f]{12}\)\. Pick another name/);
  assert.equal(duplicate.stdout, '', 'a refused create prints no token');

  const badName = await run(home, ['token', 'create', 'api:alice']);
  assert.equal(badName.code, 1);
  assert.match(badName.stderr, /is not a token name\. Use letters, digits/);
});

test('stratus token revoke takes an id or a name, and says so when neither matches', async () => {
  const home = await newHome();
  await run(home, ['token', 'create', 'alice']);
  await run(home, ['token', 'create', 'bob']);
  const [aliceLine] = (await run(home, ['token', 'list'])).stdout.split('\n');
  const aliceId = aliceLine?.split(' ')[0] ?? '';

  assert.match((await run(home, ['token', 'revoke', aliceId])).stdout, /Revoked alice/);
  assert.match((await run(home, ['token', 'revoke', 'bob'])).stdout, /Revoked bob/);
  const missing = await run(home, ['token', 'revoke', 'carol']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /No member token has the id or name carol\. `stratus token list` shows what exists\./);
  assert.match((await run(home, ['token', 'list'])).stdout, /No member tokens/);
});

test('token parsing refuses an operator role, and a create or revoke with nothing to name', () => {
  assert.throws(() => parseCommand(['token', 'create', 'root', '--role', 'operator']), /gateway-token, and there is exactly one/);
  assert.deepEqual(parseCommand(['token', 'create', 'alice', '--role', 'member']), {
    command: 'token', action: 'create', target: 'alice', role: 'member', format: 'text',
  });
  assert.throws(() => parseCommand(['token', 'create']), /needs a name/);
  assert.throws(() => parseCommand(['token', 'revoke']), /needs the token's id or name/);
  assert.throws(() => parseCommand(['token', 'mint', 'x']), /It is create, list, or revoke/);
});

test('a token created by the CLI works against a running daemon, is refused the operator\'s routes, and stops on revoke', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  const api = createControlApi({ env, port: 0, ui: false });
  await gateway.start();
  await api.start(gateway);
  try {
    const url = api.url ?? '';
    // Created after the daemon started: the daemon has to notice the file.
    const token = (await run(home, ['token', 'create', 'ci'])).stdout.trim();
    const health = await fetch(`${url}/api/v1/health`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(health.status, 200);

    // The CLI surfaces the API's reason rather than blaming the token.
    const restart = await run(home, ['restart', '--gateway', url, '--token', token]);
    assert.equal(restart.code, 1);
    assert.match(restart.stderr, /refused this call: POST \/api\/v1\/restart is operator-only/);

    assert.equal((await run(home, ['token', 'revoke', 'ci'])).code, 0);
    const after = await fetch(`${url}/api/v1/health`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(after.status, 401);
  } finally {
    await api.stop();
    await gateway.stop();
  }
});
