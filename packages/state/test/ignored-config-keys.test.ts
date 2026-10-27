import test from 'node:test';
import assert from 'node:assert/strict';

import { ignoredConfigKeys, validateConfigFile } from '../src/index.ts';

test('a top-level key the loader never reads is reported as unknown', () => {
  assert.deepEqual(
    ignoredConfigKeys({ provider: 'anthropic', provder: 'openai', modle: 'x' }, 'config.json'),
    [{ key: 'provder', reason: 'unknown' }, { key: 'modle', reason: 'unknown' }],
  );
});

test('a key the loader reads but drops for its type is reported with that type, and loading is unchanged', () => {
  const parsed = {
    provider: { name: 'anthropic' },
    model: '',
    soul: 5,
    promptCache: 'yes',
    vision: null,
    api: ['enabled'],
    fallbackProvider: true,
  };

  // Loading still succeeds and still drops them: a config that runs today
  // keeps running after an upgrade.
  assert.deepEqual(validateConfigFile(parsed, 'config.json'), {});
  assert.deepEqual(ignoredConfigKeys(parsed, 'config.json'), [
    { key: 'provider', reason: 'dropped', valueType: 'object' },
    { key: 'model', reason: 'dropped', valueType: 'empty string' },
    { key: 'soul', reason: 'dropped', valueType: 'number' },
    { key: 'promptCache', reason: 'dropped', valueType: 'string' },
    { key: 'vision', reason: 'dropped', valueType: 'null' },
    { key: 'api', reason: 'dropped', valueType: 'array' },
    { key: 'fallbackProvider', reason: 'dropped', valueType: 'boolean' },
  ]);
});

test('a config using every key the loader accepts reports nothing', () => {
  const parsed = {
    provider: 'anthropic',
    model: 'claude-opus-5',
    baseUrl: 'https://api.anthropic.com',
    apiKeyEnv: 'MY_KEY',
    systemPrompt: 'Be brief.',
    soul: '~/souls/ava.md',
    fallbackModel: 'gpt-5',
    fallbackProvider: 'openai',
    fallbackBaseUrl: 'https://api.openai.com/v1',
    executor: 'local',
    memoryStore: 'jsonl',
    promptCache: false,
    promptCacheTtl: '1h',
    maxTokens: 4096,
    vision: false,
    language: 'en-US',
    maxTurns: 50,
    agentMaxTurns: { ava: 100 },
    autoContinue: { ava: true },
    approvals: { mode: 'headless' },
    principals: { slackUsers: ['U01OPERATOR'] },
    slack: { replies: 'final' },
    api: { enabled: true },
    plugins: { '@stratusagent/tool-fs': { enabled: true } },
  };

  // Every key above must survive loading, or this fixture is not testing
  // what its name says.
  assert.deepEqual(Object.keys(validateConfigFile(parsed, 'config.json')).sort(), Object.keys(parsed).sort());
  assert.deepEqual(ignoredConfigKeys(parsed, 'config.json'), []);
});

test('an empty block is not reported, since the loader keeps it', () => {
  // If a block parser ever starts dropping `{}`, doctor would call it a
  // value Stratus doesn't accept, which is wrong; this catches that first.
  assert.deepEqual(
    ignoredConfigKeys({ approvals: {}, principals: {}, slack: {}, api: {}, plugins: {} }, 'config.json'),
    [],
  );
});

test('a config that does not load reports nothing here, since the load error already says what is wrong', () => {
  // Keys after the failing one are never read, so reporting them as
  // unknown would be wrong.
  assert.deepEqual(ignoredConfigKeys({ maxTurns: 0, provder: 'openai' }, 'config.json'), []);
  assert.deepEqual(ignoredConfigKeys(['not', 'an', 'object'], 'config.json'), []);
});
