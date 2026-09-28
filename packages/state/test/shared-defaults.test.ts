import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ModelProvider, ProviderRequest, Session } from '@stratusagent/core';
import {
  createFallbackWrappedProvider,
  describeServingModel,
  loadConfigFile,
  resolveRuntimeConfig,
} from '../src/index.ts';

const newHome = async (config?: unknown, soul?: string): Promise<string> => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-defaults-'));
  await mkdir(path.join(home, '.stratus', 'agents'), { recursive: true });
  if (config !== undefined) {
    await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify(config));
  }
  if (soul !== undefined) {
    await writeFile(path.join(home, '.stratus', 'agents', 'ava.md'), soul);
  }
  return home;
};

test('the config file takes a language tag and refuses anything else', async () => {
  const home = await newHome({ language: 'en-GB' });
  assert.equal((await loadConfigFile(path.join(home, '.stratus', 'config.json'))).language, 'en-GB');

  const bad = await newHome({ language: 'British' });
  await assert.rejects(
    loadConfigFile(path.join(bad, '.stratus', 'config.json')),
    /Invalid language in config .*"British"\. Use a language tag like en-US or en-GB\./,
  );
});

test('a soul language outranks the config file, and neither leaves the default to the prompt', async () => {
  const soul = '---\nname: Ava\nlanguage: en-AU\n---\n\nYou are Ava.\n';

  const neither = await newHome({});
  assert.equal((await resolveRuntimeConfig({}, { homeDir: neither, cwd: neither, processEnv: {} })).language, undefined);

  const configOnly = await newHome({ language: 'en-GB' });
  assert.equal((await resolveRuntimeConfig({}, { homeDir: configOnly, cwd: configOnly, processEnv: {} })).language, 'en-GB');

  const both = await newHome({ language: 'en-GB' }, soul);
  const resolved = await resolveRuntimeConfig(
    { soul: path.join(both, '.stratus', 'agents', 'ava.md') },
    { homeDir: both, cwd: both, processEnv: {} },
  );
  assert.equal(resolved.language, 'en-AU');
});

test('a config written before `language` existed loads exactly as it did', async () => {
  // Backward compatibility: a config written before the key existed loads
  // exactly as it did, and the prompt falls to the default.
  const home = await newHome({ provider: 'demo' });
  const config = await loadConfigFile(path.join(home, '.stratus', 'config.json'));
  assert.equal('language' in config, false);
});

test('describeServingModel reports the configured model, its fallback, and a switch', async () => {
  const home = await newHome({
    provider: 'openai',
    model: 'gpt-5',
    baseUrl: 'https://api.openai.com/v1',
    fallbackProvider: 'openai',
    fallbackModel: 'gpt-5-mini',
  });
  const config = await resolveRuntimeConfig({}, { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' } });

  assert.deepEqual(describeServingModel(config, false), {
    provider: 'openai',
    model: 'gpt-5',
    fallback: { provider: 'openai', model: 'gpt-5-mini' },
  });
  assert.equal(describeServingModel(config, true).onFallback, true);
  // The demo runtime has no model to name.
  const demo = await newHome({});
  assert.deepEqual(describeServingModel(await resolveRuntimeConfig({}, { homeDir: demo, cwd: demo, processEnv: {} }), false), { provider: 'demo' });
});

test('the fallback that takes over mid-turn is told it is the fallback', async () => {
  // The host described the runtime when the turn began, before the switch:
  // the model that took over must not be told the default is answering.
  const session: Session = {
    id: 's1',
    agent: { id: 'ava', name: 'Ava' },
    status: 'running',
    messages: [],
    createdAt: '',
    updatedAt: '',
  };
  const seen: ProviderRequest[] = [];
  const primary: ModelProvider = {
    name: 'primary',
    async generate() {
      throw new Error('primary down');
    },
  };
  const fallback: ModelProvider = {
    name: 'fallback',
    async generate(request) {
      seen.push(request);
      return { parts: [{ type: 'text', text: 'fallback' }] };
    },
  };
  const wrapped = createFallbackWrappedProvider(primary, fallback, () => {});
  const model = { provider: 'anthropic', model: 'claude-opus-5', fallback: { provider: 'openai', model: 'gpt-5' } };
  await wrapped.generate({ session, runtime: { language: 'en-GB', model } });

  assert.deepEqual(seen[0]?.runtime, { language: 'en-GB', model: { ...model, onFallback: true } });
});
