import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ContributionRegistry, type ProviderContribution } from '@stratusagent/core';

import {
  createRuntimeProvider,
  loadChannelCredentials,
  loadChannelTransportSecrets,
  parseProviderName,
  resolveRuntimeConfig,
  saveChannelCredentials,
  saveChannelTransportSecrets,
  saveConfigFile,
  validateConfigFile,
  type RuntimeConfig,
} from '../src/index.ts';

const newHome = async (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'stratus-registered-'));

const provider = (name: string, seen: string[] = []): ProviderContribution => ({
  name,
  create(selection) {
    seen.push(`${name}:${selection.model ?? '(default)'}:${selection.systemPrompt ?? ''}`);
    return { name, async generate() { return { parts: [{ type: 'text', text: `served by ${name}` }] }; } };
  },
});

test('a provider name is a built-in, or a plugin name carried as plugin:<name>, and nothing else', () => {
  assert.equal(parseProviderName('anthropic', 'x'), 'anthropic');
  assert.equal(parseProviderName('ollama', 'x'), 'plugin:ollama');
  assert.equal(parseProviderName('plugin:ollama', 'x'), 'plugin:ollama');
  assert.throws(() => parseProviderName('Ollama', 'soul file'), /Unsupported provider in soul file: Ollama/);
  assert.throws(() => parseProviderName('plugin:', 'x'), /Unsupported provider/);
});

test('a soul selecting a plugin provider resolves to the registered variant with its own model, no sign-in required', async () => {
  const home = await newHome();
  const soulPath = path.join(home, 'ava.md');
  await writeFile(soulPath, '---\nname: Ava\nid: ava\nprovider: ollama\nmodel: llama3\n---\n\nYou are Ava.\n');

  const config = await resolveRuntimeConfig({ soul: soulPath }, { homeDir: home, cwd: home, processEnv: {} });
  assert.equal(config.provider, 'plugin:ollama');
  assert.equal(config.provider === 'plugin:ollama' ? config.model : undefined, 'llama3');
  assert.equal(config.soul?.agent.id, 'ava');

  // The soul's model belongs to the soul's provider: a flag selecting
  // another provider strands it, exactly as it would for a built-in.
  const overridden = await resolveRuntimeConfig(
    { soul: soulPath, provider: parseProviderName('other', 'flag') },
    { homeDir: home, cwd: home, processEnv: {} },
  );
  assert.equal(overridden.provider, 'plugin:other');
  assert.equal('model' in overridden ? overridden.model : undefined, undefined);
});

test('a fallbackProvider naming a plugin provider resolves behind a built-in primary, and behind a plugin primary', async () => {
  const home = await newHome();
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' } };
  await saveConfigFile(path.join(home, '.stratus', 'config.json'), {
    provider: 'openai',
    model: 'gpt-4.1-mini',
    fallbackModel: 'llama3',
    fallbackProvider: parseProviderName('ollama', 'test'),
  });
  const behindBuiltin = await resolveRuntimeConfig({}, env);
  assert.equal(behindBuiltin.provider, 'openai');
  assert.deepEqual(behindBuiltin.provider === 'openai' ? behindBuiltin.fallback : undefined, { provider: 'plugin:ollama', model: 'llama3' });

  await saveConfigFile(path.join(home, '.stratus', 'config.json'), {
    provider: parseProviderName('vllm', 'test'),
    fallbackModel: 'llama3',
    fallbackProvider: parseProviderName('ollama', 'test'),
  });
  const behindPlugin = await resolveRuntimeConfig({}, { ...env, processEnv: {} });
  assert.equal(behindPlugin.provider, 'plugin:vllm');
  assert.deepEqual(behindPlugin.provider === 'plugin:vllm' ? behindPlugin.fallback : undefined, { provider: 'plugin:ollama', model: 'llama3' });

  // A built-in fallback behind a plugin primary resolves on its own
  // sign-in — the operator configured it, and it must not be dropped for
  // the primary having none to lend.
  await saveConfigFile(path.join(home, '.stratus', 'config.json'), {
    provider: parseProviderName('vllm', 'test'),
    fallbackModel: 'gpt-4.1-mini',
    fallbackProvider: 'openai',
  });
  const builtInBehindPlugin = await resolveRuntimeConfig({}, env);
  assert.deepEqual(builtInBehindPlugin.provider === 'plugin:vllm' ? builtInBehindPlugin.fallback : undefined, {
    provider: 'openai',
    model: 'gpt-4.1-mini',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
  });
  // And without a sign-in it is quietly skipped, as behind a built-in.
  const unsigned = await resolveRuntimeConfig({}, { ...env, processEnv: {} });
  assert.equal(unsigned.provider === 'plugin:vllm' ? unsigned.fallback : 'wrong', undefined);

  // An implicit fallback (no fallbackProvider) was written for the config's
  // own provider — here the plugin itself, on another model.
  await saveConfigFile(path.join(home, '.stratus', 'config.json'), {
    provider: parseProviderName('vllm', 'test'),
    model: 'big',
    fallbackModel: 'small',
  });
  const implicit = await resolveRuntimeConfig({}, { ...env, processEnv: {} });
  assert.deepEqual(implicit.provider === 'plugin:vllm' ? implicit.fallback : undefined, { provider: 'plugin:vllm', model: 'small' });
});

test('createRuntimeProvider builds a registered provider from the registry, once per selection, and names what exists otherwise', () => {
  const seen: string[] = [];
  const registered = new ContributionRegistry<ProviderContribution>();
  registered.register('ollama', provider('ollama', seen));

  const built = createRuntimeProvider(
    { provider: 'plugin:ollama', model: 'llama3', systemPrompt: 'Be brief.' },
    undefined,
    undefined,
    undefined,
    undefined,
    registered,
  );
  assert.equal(built.name, 'ollama');
  assert.deepEqual(seen, ['ollama:llama3:Be brief.']);

  assert.throws(
    () => createRuntimeProvider({ provider: 'plugin:vllm' }, undefined, undefined, undefined, undefined, registered),
    /No provider named vllm is registered \(plugins registered: ollama\)\. Built in: demo, openai, anthropic, codex/,
  );
  assert.throws(
    () => createRuntimeProvider({ provider: 'plugin:vllm' }),
    /no loaded plugin registers one/,
  );
});

test('a registered provider works as a fallback target behind a built-in primary', async () => {
  const registered = new ContributionRegistry<ProviderContribution>();
  registered.register('ollama', provider('ollama'));
  const config: RuntimeConfig = {
    provider: 'openai',
    model: 'gpt-4.1-mini',
    baseUrl: 'http://127.0.0.1:9',
    apiKey: 'sk-test',
    // Any fetch that rejects: the primary fails, the fallback serves.
    fetch: async () => { throw new Error('primary down'); },
    fallback: { provider: 'plugin:ollama', model: 'llama3' },
  };
  const fellBack: unknown[] = [];
  const wrapped = createRuntimeProvider(config, (error) => fellBack.push(error), undefined, undefined, undefined, registered);
  const session = {
    id: 's1',
    agent: { id: 'ava', name: 'Ava', instructions: 'You are Ava.' },
    status: 'running' as const,
    messages: [{ id: 'm1', role: 'user' as const, content: 'hi', createdAt: new Date().toISOString() }],
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const response = await wrapped.generate({ session });
  assert.equal(fellBack.length, 1);
  assert.deepEqual(response.parts, [{ type: 'text', text: 'served by ollama' }]);
});

test('executor and memoryStore are config keys with the shape of a contribution name', () => {
  const parsed = validateConfigFile({ executor: 'docker', memoryStore: 'vector' }, 'config');
  assert.equal(parsed.executor, 'docker');
  assert.equal(parsed.memoryStore, 'vector');
  assert.throws(() => validateConfigFile({ executor: 'Docker' }, 'config'), /Invalid executor in config config: "Docker"/);
  assert.throws(() => validateConfigFile({ memoryStore: 7 }, 'config'), /Invalid memoryStore/);
});

test('channel transport secrets are read by kind from the same namespace Slack uses, and a Slack save keeps other kinds', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await saveChannelTransportSecrets(env, 'discord', 'ava', { botToken: 'discord-1', appId: '42' });
  await saveChannelCredentials(env, { slack: { ava: { appToken: 'xapp-1', botToken: 'xoxb-1' } } });

  assert.deepEqual(await loadChannelTransportSecrets(env, 'discord'), { ava: { botToken: 'discord-1', appId: '42' } });
  // Slack's own tokens come back through the generic path too — same
  // namespace, same shape — and the typed reader still sees them.
  assert.deepEqual(await loadChannelTransportSecrets(env, 'slack'), { ava: { appToken: 'xapp-1', botToken: 'xoxb-1' } });
  assert.deepEqual(await loadChannelCredentials(env), { slack: { ava: { appToken: 'xapp-1', botToken: 'xoxb-1' } } });
  assert.deepEqual(await loadChannelTransportSecrets(env, 'matrix'), {});

  // Removing every Slack binding removes Slack only.
  await saveChannelCredentials(env, {});
  assert.deepEqual(await loadChannelCredentials(env), {});
  assert.deepEqual(await loadChannelTransportSecrets(env, 'discord'), { ava: { botToken: 'discord-1', appId: '42' } });
});

test('the roster summary reports a plugin provider by its resolved name, with no model unless one is pinned', async () => {
  const { listAgentSummaries, agentsDirPath } = await import('../src/index.ts');
  const home = await newHome();
  const dir = agentsDirPath({ homeDir: home });
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'ava.md'), '---\nname: Ava\nid: ava\nprovider: ollama\n---\n\nYou are Ava.\n');
  await writeFile(path.join(dir, 'bea.md'), '---\nname: Bea\nid: bea\nprovider: ollama\nmodel: llama3\n---\n\nYou are Bea.\n');

  const summaries = await listAgentSummaries({ homeDir: home, cwd: home, processEnv: {} });
  assert.deepEqual(summaries.find((entry) => entry.id === 'ava')?.runsOn, { provider: 'plugin:ollama' });
  assert.deepEqual(summaries.find((entry) => entry.id === 'bea')?.runsOn, { provider: 'plugin:ollama', model: 'llama3' });
});

test('a soul pinning the provider the config already names, in either spelling, keeps the default model', async () => {
  const { applySoulPins } = await import('../src/index.ts');
  const soul = { agent: { id: 'ava', name: 'Ava', instructions: 'You are Ava.' }, provider: 'ollama' };
  const result = applySoulPins(
    soul,
    { model: 'llama3' },
    { processEnv: {} },
    { configProvider: 'plugin:ollama', configPresent: true },
  );
  // Same provider, so the daemon-wide model was chosen for it and stays.
  assert.equal(result.selection.model, 'llama3');
  const demoted = applySoulPins(
    soul,
    { model: 'gpt-4.1-mini' },
    { processEnv: {} },
    { configProvider: 'openai', configPresent: true },
  );
  assert.equal(demoted.selection.model, undefined);
});

test('channel transport secrets refuse a kind or agent id that is not one', async () => {
  const home = await newHome();
  await assert.rejects(saveChannelTransportSecrets({ homeDir: home }, '__proto__', 'ava', { token: 'x' }), /is not a channel kind/);
  await assert.rejects(saveChannelTransportSecrets({ homeDir: home }, 'discord', '__proto__', { token: 'x' }), /is not an agent id/);
});
