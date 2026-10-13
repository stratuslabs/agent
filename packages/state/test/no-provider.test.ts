import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { NoProviderConfiguredError, resolveRuntimeConfig } from '../src/index.ts';

// Synthetic values only.
const home = async (credentials?: Record<string, unknown>): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stratus-no-provider-'));
  if (credentials !== undefined) {
    await mkdir(path.join(dir, '.stratus'), { recursive: true });
    await writeFile(path.join(dir, '.stratus', 'credentials.json'), JSON.stringify(credentials), { mode: 0o600 });
  }
  return dir;
};

test('nothing configured is an error that points at setup, not a run on the demo model', async () => {
  const dir = await home();
  await assert.rejects(
    resolveRuntimeConfig({}, { homeDir: dir, cwd: dir, processEnv: {} }),
    (error: unknown) => error instanceof NoProviderConfiguredError && /stratus setup/.test(error.message),
  );
});

test('a provider key in the environment alone does not pick a provider, and the error says how to', async () => {
  const dir = await home();
  await assert.rejects(
    resolveRuntimeConfig({}, { homeDir: dir, cwd: dir, processEnv: { OPENAI_API_KEY: 'synthetic-env-key' } }),
    (error: unknown) => error instanceof NoProviderConfiguredError && /STRATUS_PROVIDER=openai/.test(error.message),
  );
});

test('the demo model still runs when it is picked explicitly', async () => {
  const dir = await home();
  const env = { homeDir: dir, cwd: dir, processEnv: {} };
  assert.equal((await resolveRuntimeConfig({ provider: 'demo' }, env)).provider, 'demo');
  assert.equal((await resolveRuntimeConfig({}, { ...env, processEnv: { STRATUS_PROVIDER: 'demo' } })).provider, 'demo');
});

test('one stored provider sign-in is used, and the run says it was inferred', async () => {
  const dir = await home({ openai: { type: 'api_key', value: 'synthetic-stored-key' } });
  const config = await resolveRuntimeConfig({}, { homeDir: dir, cwd: dir, processEnv: {} });
  assert.equal(config.provider, 'openai');
  assert.equal(config.provider === 'openai' && config.apiKey, 'synthetic-stored-key');
  assert.equal(config.inferredProvider, 'openai');
});

test('an explicitly chosen provider is not reported as inferred', async () => {
  const dir = await home({ openai: { type: 'api_key', value: 'synthetic-stored-key' } });
  const config = await resolveRuntimeConfig({ provider: 'openai' }, { homeDir: dir, cwd: dir, processEnv: {} });
  assert.equal(config.inferredProvider, undefined);
});

test('two or more stored sign-ins with no provider chosen is an error naming them', async () => {
  const dir = await home({
    openai: { type: 'api_key', value: 'synthetic-stored-key' },
    anthropic: { type: 'api_key', value: 'synthetic-stored-key-2' },
  });
  await assert.rejects(
    resolveRuntimeConfig({}, { homeDir: dir, cwd: dir, processEnv: {} }),
    (error: unknown) => error instanceof NoProviderConfiguredError
      && /anthropic/.test(error.message) && /openai/.test(error.message),
  );
});
