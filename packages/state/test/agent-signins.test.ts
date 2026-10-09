import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { defineAgent } from '@stratusagent/agents';
import {
  createFileCredentialResolver,
  loadAgentSignIns,
  loadChannelCredentials,
  loadCredentials,
  loadNamedCredentials,
  removeAgentSignIn,
  resolveRuntimeConfig,
  saveAgentSignIn,
} from '../src/index.ts';

// Synthetic values only.
const SHARED = 'synthetic-shared-token';
const OWN = 'synthetic-kai-token';

const newHome = async (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'stratus-agent-signin-'));

const setUp = async (
  credentials: Record<string, unknown>,
  config?: Record<string, unknown>,
): Promise<{ home: string; kai: string; mia: string }> => {
  const home = await newHome();
  const agents = path.join(home, '.stratus', 'agents');
  await mkdir(agents, { recursive: true });
  const kai = path.join(agents, 'kai.md');
  const mia = path.join(agents, 'mia.md');
  await writeFile(kai, '---\nname: Kai\nprovider: anthropic\n---\n\nYou are Kai.\n');
  await writeFile(mia, '---\nname: Mia\nprovider: anthropic\n---\n\nYou are Mia.\n');
  await writeFile(path.join(home, '.stratus', 'credentials.json'), JSON.stringify(credentials), { mode: 0o600 });
  if (config !== undefined) {
    await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify(config), { mode: 0o600 });
  }
  return { home, kai, mia };
};

const withOwn = { anthropic: { type: 'oauth_token', value: SHARED }, agentSignIns: { kai: { anthropic: { type: 'oauth_token', value: OWN } } } };

test('an agent\'s own sign-in replaces the shared one for that agent only', async () => {
  const { home, kai, mia } = await setUp(withOwn);
  const env = { homeDir: home, cwd: home, processEnv: {} };

  const kaiRuntime = await resolveRuntimeConfig({ soul: kai }, env);
  const miaRuntime = await resolveRuntimeConfig({ soul: mia }, env);
  const soulless = await resolveRuntimeConfig({ provider: 'anthropic' }, env);

  assert.equal(kaiRuntime.provider === 'anthropic' && kaiRuntime.authToken, OWN);
  assert.equal(kaiRuntime.provider === 'anthropic' && kaiRuntime.agentSignIn, 'kai');
  assert.equal(miaRuntime.provider === 'anthropic' && miaRuntime.authToken, SHARED);
  assert.equal(miaRuntime.provider === 'anthropic' && miaRuntime.agentSignIn, undefined);
  assert.equal(soulless.provider === 'anthropic' && soulless.authToken, SHARED);
});

test('an agent\'s own sign-in outranks the daemon\'s environment keys, which still serve everyone else', async () => {
  const { home, kai, mia } = await setUp(withOwn);
  const env = { homeDir: home, cwd: home, processEnv: { ANTHROPIC_API_KEY: 'synthetic-env-key', STRATUS_API_KEY: 'synthetic-generic-key' } };

  const kaiRuntime = await resolveRuntimeConfig({ soul: kai }, env);
  const miaRuntime = await resolveRuntimeConfig({ soul: mia }, env);

  assert.ok(kaiRuntime.provider === 'anthropic');
  assert.equal(kaiRuntime.authToken, OWN);
  assert.equal(kaiRuntime.apiKey, undefined, 'an environment key would turn kai\'s run into metered shared usage');
  assert.equal(kaiRuntime.apiKeyEnvVar, undefined);
  assert.ok(miaRuntime.provider === 'anthropic');
  assert.equal(miaRuntime.apiKey, 'synthetic-generic-key');
});

test('removing an agent\'s own sign-in returns it to the shared one, and only touches that entry', async () => {
  const { home, kai } = await setUp({
    ...withOwn,
    named: { shared: { 'search.apiKey': 'synthetic-search' }, agents: {} },
    channels: { slack: { kai: { appToken: 'synthetic-app', botToken: 'synthetic-bot' } } },
  });
  const env = { homeDir: home, cwd: home, processEnv: {} };

  assert.equal(await removeAgentSignIn(env, 'kai', 'anthropic'), true);
  assert.equal(await removeAgentSignIn(env, 'kai', 'anthropic'), false);
  const runtime = await resolveRuntimeConfig({ soul: kai }, env);
  assert.equal(runtime.provider === 'anthropic' && runtime.authToken, SHARED);

  assert.equal((await loadCredentials(env)).anthropic?.value, SHARED);
  assert.equal((await loadNamedCredentials(env)).shared['search.apiKey'], 'synthetic-search');
  assert.equal((await loadChannelCredentials(env)).slack?.kai?.botToken, 'synthetic-bot');
  const raw = JSON.parse(await readFile(path.join(home, '.stratus', 'credentials.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(raw.agentSignIns, undefined, 'an empty namespace is not left behind');
});

test('a stored agent sign-in is written 0600 beside, not over, the other namespaces', async () => {
  const { home } = await setUp({ anthropic: { type: 'oauth_token', value: SHARED } });
  const env = { homeDir: home };
  await saveAgentSignIn(env, 'kai', 'anthropic', { type: 'oauth_token', value: OWN });

  assert.equal((await loadAgentSignIns(env)).kai?.anthropic?.value, OWN);
  assert.equal((await loadCredentials(env)).anthropic?.value, SHARED);
  assert.equal((await stat(path.join(home, '.stratus', 'credentials.json'))).mode & 0o777, 0o600);
  await assert.rejects(saveAgentSignIn(env, '__proto__', 'anthropic', { type: 'oauth_token', value: OWN }), /cannot be an agent id/);
});

test('an agent sign-in is not a named credential: no soul allowlist can resolve it', async () => {
  const { home } = await setUp(withOwn);
  const resolver = createFileCredentialResolver({ homeDir: home }, {});
  const agent = defineAgent({ id: 'kai', name: 'Kai', credentials: ['anthropic', 'agentSignIns', 'CLAUDE_CODE_OAUTH_TOKEN'] });
  for (const name of ['anthropic', 'agentSignIns', 'CLAUDE_CODE_OAUTH_TOKEN']) {
    assert.equal(await resolver.resolve(agent, name), undefined, name);
  }
});

test('an unusable agent sign-in refuses the run instead of using the shared one', async () => {
  const { home, kai } = await setUp({
    anthropic: { type: 'oauth_token', value: SHARED },
    agentSignIns: { kai: { anthropic: { type: 'api_key', value: 'synthetic-wrong-kind' } } },
  });
  await assert.rejects(
    resolveRuntimeConfig({ soul: kai }, { homeDir: home, cwd: home, processEnv: {} }),
    (error: unknown) => error instanceof Error
      && /kai has its own Claude sign-in/.test(error.message)
      && /stratus signin remove anthropic --agent kai/.test(error.message)
      && !error.message.includes('synthetic-wrong-kind'),
  );
});

test('an agent on its own sign-in falls back only onto that sign-in', async () => {
  const sameProvider = await setUp(withOwn, { provider: 'anthropic', fallbackModel: 'claude-fallback' });
  const env = { homeDir: sameProvider.home, cwd: sameProvider.home, processEnv: { ANTHROPIC_API_KEY: 'synthetic-env-key' } };
  const kai = await resolveRuntimeConfig({ soul: sameProvider.kai }, env);
  assert.ok(kai.provider === 'anthropic');
  assert.equal(kai.fallback?.authToken, OWN);
  assert.equal(kai.fallback?.apiKey, undefined);
  assert.equal(kai.fallback?.agentSignIn, 'kai');

  const crossProvider = await setUp(
    { ...withOwn, openai: { type: 'api_key', value: 'synthetic-openai' } },
    { provider: 'anthropic', fallbackProvider: 'openai', fallbackModel: 'model-f' },
  );
  const crossEnv = { homeDir: crossProvider.home, cwd: crossProvider.home, processEnv: {} };
  const kaiCross = await resolveRuntimeConfig({ soul: crossProvider.kai }, crossEnv);
  const miaCross = await resolveRuntimeConfig({ soul: crossProvider.mia }, crossEnv);
  assert.ok(kaiCross.provider === 'anthropic' && miaCross.provider === 'anthropic');
  assert.equal(kaiCross.fallback, undefined, 'a shared openai key must not rescue kai\'s own subscription');
  assert.equal(miaCross.fallback?.provider, 'openai', 'an agent on the shared sign-in keeps its fallback');
});

test('an anthropic fallback behind another provider uses the agent\'s own sign-in', async () => {
  const { home } = await setUp(
    { ...withOwn, openai: { type: 'api_key', value: 'synthetic-openai' } },
    { provider: 'openai', model: 'model-a', fallbackProvider: 'anthropic', fallbackModel: 'claude-fallback' },
  );
  const agents = path.join(home, '.stratus', 'agents');
  await writeFile(path.join(agents, 'kai.md'), '---\nname: Kai\n---\n\nYou are Kai.\n');
  const runtime = await resolveRuntimeConfig({ soul: path.join(agents, 'kai.md') }, { homeDir: home, cwd: home, processEnv: {} });
  assert.equal(runtime.provider, 'openai');
  assert.ok(runtime.provider === 'openai');
  assert.equal(runtime.fallback?.authToken, OWN);
});
