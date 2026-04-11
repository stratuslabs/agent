import test from 'node:test';
import assert from 'node:assert/strict';

import type { ProviderRequest } from '@stratusclaw/core';
import {
  createOpenAICompatibleProvider,
  createProviderRegistry,
  createProviderResponseBuilder,
  defineProvider,
  defineScriptedProvider,
  defineStaticProvider,
  normalizeProviderParts,
  normalizeProviderResponse,
} from '../src/index.ts';

const createRequest = (): ProviderRequest => ({
  session: {
    id: 'session-1',
    agent: { id: 'agent-1', name: 'Kernel' },
    status: 'running',
    messages: [
      {
        id: 'session-1:user:1',
        role: 'user',
        content: 'Say hello',
        createdAt: new Date().toISOString(),
      },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
});

test('provider helpers build core-compatible responses', async () => {
  const provider = defineProvider({
    name: 'fixture-provider',
    async generate(_request: ProviderRequest) {
      return createProviderResponseBuilder()
        .addText('Planning')
        .addToolCall({
          id: 'call-1',
          toolName: 'echo',
          input: { value: 'hello' },
        })
        .addText('Complete')
        .done();
    },
  });

  const response = await provider.generate(createRequest());

  assert.equal(provider.name, 'fixture-provider');
  assert.deepEqual(response.parts, [
    { type: 'text', text: 'Planning' },
    {
      type: 'tool-call',
      call: {
        id: 'call-1',
        toolName: 'echo',
        input: { value: 'hello' },
      },
    },
    { type: 'text', text: 'Complete' },
  ]);
});

test('normalizeProviderResponse merges adjacent text parts and drops empty text', () => {
  const response = normalizeProviderResponse([
    'Hello',
    { type: 'text', text: '' },
    { type: 'text', text: ', world' },
    {
      type: 'tool-call',
      call: { id: 'call-1', toolName: 'echo', input: { value: 'hi' } },
    },
    { type: 'text', text: '!' },
  ]);

  assert.deepEqual(response.parts, [
    { type: 'text', text: 'Hello, world' },
    {
      type: 'tool-call',
      call: { id: 'call-1', toolName: 'echo', input: { value: 'hi' } },
    },
    { type: 'text', text: '!' },
  ]);
});

test('normalizeProviderParts clones tool call inputs to avoid external mutation', () => {
  const input = { value: 'before' };
  const parts = normalizeProviderParts([
    { type: 'tool-call', call: { id: 'call-1', toolName: 'echo', input } },
  ]);

  input.value = 'after';

  assert.deepEqual(parts, [
    {
      type: 'tool-call',
      call: { id: 'call-1', toolName: 'echo', input: { value: 'before' } },
    },
  ]);
});

test('createProviderRegistry registers, replaces, and resolves providers by name', async () => {
  const alpha = defineStaticProvider({ name: 'alpha', response: 'A' });
  const alphaReplacement = defineStaticProvider({ name: 'alpha', response: 'A2' });
  const beta = defineStaticProvider({ name: 'beta', response: 'B' });

  const registry = createProviderRegistry([alpha]).registerMany([alphaReplacement, beta]);

  assert.equal(registry.has('alpha'), true);
  assert.equal(registry.has('missing'), false);
  assert.deepEqual(registry.names(), ['alpha', 'beta']);
  assert.equal(registry.require('alpha'), alphaReplacement);
  assert.equal(registry.get('beta'), beta);
  assert.equal((await registry.require('alpha').generate(createRequest())).parts[0]?.type, 'text');
  assert.throws(() => registry.require('missing'), /Provider not found: missing/);
});

test('defineStaticProvider accepts strings, parts, and request-aware factories', async () => {
  const stringProvider = defineStaticProvider({ name: 'string', response: 'Hello' });
  const partsProvider = defineStaticProvider({
    name: 'parts',
    response: [
      'Before',
      { type: 'tool-call', call: { id: 'call-1', toolName: 'echo', input: { value: 1 } } },
      'After',
    ],
  });
  const requestProvider = defineStaticProvider({
    name: 'request',
    response: ({ session }) => `Session:${session.id}`,
  });

  assert.deepEqual(await stringProvider.generate(createRequest()), {
    parts: [{ type: 'text', text: 'Hello' }],
  });
  assert.deepEqual(await partsProvider.generate(createRequest()), {
    parts: [
      { type: 'text', text: 'Before' },
      { type: 'tool-call', call: { id: 'call-1', toolName: 'echo', input: { value: 1 } } },
      { type: 'text', text: 'After' },
    ],
  });
  assert.deepEqual(await requestProvider.generate(createRequest()), {
    parts: [{ type: 'text', text: 'Session:session-1' }],
  });
});

test('defineScriptedProvider advances through deterministic responses', async () => {
  const provider = defineScriptedProvider({
    name: 'scripted',
    steps: [
      'First',
      ({ callCount, stepIndex }) => [`Second:${callCount}:${stepIndex}`],
    ],
  });

  assert.deepEqual(await provider.generate(createRequest()), {
    parts: [{ type: 'text', text: 'First' }],
  });
  assert.deepEqual(await provider.generate(createRequest()), {
    parts: [{ type: 'text', text: 'Second:2:1' }],
  });
  assert.deepEqual(await provider.generate(createRequest()), {
    parts: [{ type: 'text', text: 'Second:3:1' }],
  });
});

test('defineScriptedProvider can fail when exhausted', async () => {
  const provider = defineScriptedProvider({
    name: 'finite',
    steps: ['Only once'],
    repeatLast: false,
  });

  await provider.generate(createRequest());

  await assert.rejects(() => provider.generate(createRequest()), /Scripted provider exhausted: finite/);
});

test('defineScriptedProvider rejects empty scripts', () => {
  assert.throws(
    () => defineScriptedProvider({ name: 'empty', steps: [] }),
    /Scripted provider requires at least one step: empty/,
  );
});

test('createOpenAICompatibleProvider posts session messages to a real chat-completions endpoint', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;

  const provider = createOpenAICompatibleProvider({
    model: 'gpt-4.1-mini',
    apiKey: 'test-key',
    baseUrl: 'https://example.test/v1',
    systemPrompt: 'Be concise.',
    fetch: async (url, init) => {
      requestUrl = String(url);
      requestInit = init;

      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          choices: [
            {
              message: {
                content: 'Hello from the real provider path.',
              },
            },
          ],
        }),
      } as Response;
    },
  });

  const response = await provider.generate(createRequest());

  assert.equal(requestUrl, 'https://example.test/v1/chat/completions');
  assert.equal(requestInit?.method, 'POST');
  assert.equal((requestInit?.headers as Record<string, string>).authorization, 'Bearer test-key');

  const body = JSON.parse(String(requestInit?.body));
  assert.equal(body.model, 'gpt-4.1-mini');
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'Be concise.' },
    { role: 'user', content: 'Say hello' },
  ]);
  assert.deepEqual(response.parts, [{ type: 'text', text: 'Hello from the real provider path.' }]);
});

test('createOpenAICompatibleProvider surfaces provider-side errors', async () => {
  const provider = createOpenAICompatibleProvider({
    model: 'gpt-4.1-mini',
    apiKey: 'test-key',
    fetch: async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({
        error: {
          message: 'Bad key',
        },
      }),
    }) as Response,
  });

  await assert.rejects(() => provider.generate(createRequest()), /Bad key/);
});

test('createOpenAICompatibleProvider preserves non-json HTTP error bodies', async () => {
  const provider = createOpenAICompatibleProvider({
    model: 'gpt-4.1-mini',
    apiKey: 'test-key',
    fetch: async () => ({
      ok: false,
      status: 502,
      text: async () => 'upstream proxy failure',
    }) as Response,
  });

  await assert.rejects(() => provider.generate(createRequest()), /upstream proxy failure/);
});
