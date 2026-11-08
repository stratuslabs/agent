import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { credentialsPath, storedSecretValues } from '../src/index.ts';

const newEnv = async (): Promise<{ homeDir: string }> => ({
  homeDir: await mkdtemp(path.join(os.tmpdir(), 'stratus-stored-secrets-')),
});

const writeCredentials = async (env: { homeDir: string }, contents: unknown): Promise<void> => {
  await mkdir(path.dirname(credentialsPath(env)), { recursive: true });
  await writeFile(credentialsPath(env), `${JSON.stringify(contents, null, 2)}\n`);
};

test('every secret value in the credentials file, from every namespace, and nothing that is not one', async () => {
  const env = await newEnv();
  await writeCredentials(env, {
    anthropic: { type: 'oauth_token', value: 'sk-ant-oat-setup' },
    openai: { type: 'api_key', value: 'sk-openai-key', baseUrl: 'http://127.0.0.1:11434/v1' },
    // A subscription marker, not a secret: masking it would turn the
    // word "chatgpt" in any failure into [redacted].
    codex: { type: 'oauth_token', value: 'chatgpt' },
    agentSignIns: { kai: { anthropic: { type: 'oauth_token', value: 'sk-ant-oat-kai' } } },
    named: {
      shared: { 'github.token': 'ghp-shared' },
      agents: { ava: { 'search.apiKey': 'brave-ava' }, kai: { 'linear.apiKey': 'lin-kai' } },
    },
    channels: {
      slack: { ava: { appToken: 'xapp-ava', botToken: 'xoxb-ava' } },
      discord: { kai: { botToken: 'discord-kai' } },
    },
    // Names, not values.
    envBindings: { agents: { ava: { BRAVE_API_KEY: 'search.apiKey' } } },
  });

  assert.deepEqual((await storedSecretValues(env)).sort(), [
    'brave-ava',
    'discord-kai',
    'ghp-shared',
    'lin-kai',
    'sk-ant-oat-kai',
    'sk-ant-oat-setup',
    'sk-openai-key',
    'xapp-ava',
    'xoxb-ava',
  ]);
});

test('a missing credentials file holds no secrets, and malformed entries are skipped, not thrown on', async () => {
  const env = await newEnv();
  assert.deepEqual(await storedSecretValues(env), []);

  await writeCredentials(env, {
    anthropic: 'not-an-entry',
    named: { shared: { ok: 'kept-value', bad: 7 }, agents: [] },
    channels: { slack: { ava: 'x' }, discord: { kai: { botToken: '', appId: 42 } } },
    agentSignIns: { kai: null },
  });
  assert.deepEqual(await storedSecretValues(env), ['kept-value']);
});

test('a credentials file that cannot be parsed rejects, so a caller can tell nothing was read', async () => {
  const env = await newEnv();
  await mkdir(path.dirname(credentialsPath(env)), { recursive: true });
  await writeFile(credentialsPath(env), '{ not json');
  await assert.rejects(storedSecretValues(env));
});
