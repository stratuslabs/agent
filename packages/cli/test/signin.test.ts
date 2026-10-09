import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runCli } from '../src/index.ts';

// Synthetic values only.
const TOKEN = 'synthetic-remy-setup-token';
const ROTATED = 'synthetic-remy-rotated-token';

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

const newHome = async (): Promise<string> => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-signin-cli-'));
  const agents = path.join(home, '.stratus', 'agents');
  await mkdir(agents, { recursive: true });
  await writeFile(path.join(agents, 'remy.md'), '---\nname: Remy\nprovider: anthropic\n---\n\nYou are Remy.\n');
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ anthropic: { type: 'oauth_token', value: 'synthetic-shared-token' } }),
    { mode: 0o600 },
  );
  return home;
};

const run = async (argv: string[], env: Record<string, unknown>) => {
  const captured = createStreams();
  const code = await runCli({ argv, streams: captured.streams, env });
  return { code, stdout: captured.output.stdout, stderr: captured.output.stderr };
};

test('stratus signin set stores one agent\'s token from stdin, 0600, and never prints it', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };

  const set = await run(['signin', 'set', 'anthropic', '--agent', 'remy'], { ...env, stdin: `${TOKEN}\n` });
  assert.equal(set.code, 0, set.stderr);
  assert.match(set.stdout, /Stored remy's own Claude sign-in/);
  assert.match(set.stdout, /next turn, no restart/);

  const file = path.join(home, '.stratus', 'credentials.json');
  const stored = JSON.parse(await readFile(file, 'utf8')) as {
    anthropic?: { value?: string };
    agentSignIns?: Record<string, { anthropic?: { type?: string; value?: string } }>;
  };
  assert.deepEqual(stored.agentSignIns?.remy?.anthropic, { type: 'oauth_token', value: TOKEN });
  assert.equal(stored.anthropic?.value, 'synthetic-shared-token', 'the shared sign-in is untouched');
  assert.equal((await stat(file)).mode & 0o777, 0o600);

  const replaced = await run(['signin', 'set', 'anthropic', '--agent', 'remy'], { ...env, stdin: ROTATED });
  assert.equal(replaced.code, 0, replaced.stderr);
  assert.match(replaced.stdout, /Replaced remy's own Claude sign-in/);

  const list = await run(['signins'], env);
  assert.equal(list.code, 0);
  assert.match(list.stdout, /remy\s+anthropic/);

  const removed = await run(['signin', 'remove', 'anthropic', '--agent', 'remy'], env);
  assert.equal(removed.code, 0);
  assert.match(removed.stdout, /next turn runs on the shared sign-in/);
  const again = await run(['signin', 'remove', 'anthropic', '--agent', 'remy'], env);
  assert.equal(again.code, 1);

  for (const output of [set, replaced, list, removed, again]) {
    for (const secret of [TOKEN, ROTATED, 'synthetic-shared-token']) {
      assert.ok(!output.stdout.includes(secret) && !output.stderr.includes(secret), `printed ${secret}`);
    }
  }
});

test('stratus signin set refuses what would never work, and stores nothing', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  const file = path.join(home, '.stratus', 'credentials.json');
  const before = await readFile(file, 'utf8');

  const apiKey = await run(['signin', 'set', 'anthropic', '--agent', 'remy'], { ...env, stdin: 'sk-ant-api03-synthetic' });
  assert.equal(apiKey.code, 1);
  assert.match(apiKey.stderr, /API key, not a setup token/);

  const empty = await run(['signin', 'set', 'anthropic', '--agent', 'remy'], { ...env, stdin: '\n' });
  assert.equal(empty.code, 1);

  const stranger = await run(['signin', 'set', 'anthropic', '--agent', 'nobody'], { ...env, stdin: TOKEN });
  assert.equal(stranger.code, 1);
  assert.match(stranger.stderr, /No agent nobody is on the roster/);

  assert.equal(await readFile(file, 'utf8'), before);
});

test('stratus signin takes the token from stdin or a prompt, never from the command line', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  // A token passed as an argument is a stray positional, refused before
  // anything is read or stored.
  const inArgv = await run(['signin', 'set', 'anthropic', TOKEN, '--agent', 'remy'], env);
  assert.notEqual(inArgv.code, 0);
  assert.ok(!inArgv.stderr.includes(TOKEN), 'the refusal echoed the token');
  assert.match(inArgv.stderr, /takes one provider/);
  const noAgent = await run(['signin', 'set', 'anthropic'], { ...env, stdin: TOKEN });
  assert.notEqual(noAgent.code, 0);
  assert.match(noAgent.stderr, /needs --agent/);
  const otherProvider = await run(['signin', 'set', 'openai', '--agent', 'remy'], { ...env, stdin: TOKEN });
  assert.notEqual(otherProvider.code, 0);
  assert.match(otherProvider.stderr, /anthropic .* is the only one/);
});
