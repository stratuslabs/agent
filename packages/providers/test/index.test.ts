import test from 'node:test';
import assert from 'node:assert/strict';

import type { ProviderCallUsage, ProviderRequest } from '@stratusagent/core';
import {
  createOpenAICompatibleProvider,
  createProviderRegistry,
  createProviderResponseBuilder,
  defineProvider,
  defineScriptedProvider,
  defineStaticProvider,
  normalizeProviderParts,
  normalizeProviderResponse,
  sanitizeOpenAICompatibleToolName,
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

test('createOpenAICompatibleProvider advertises tools and parses tool calls', async () => {
  let requestBody: Record<string, unknown> = {};

  const provider = createOpenAICompatibleProvider({
    model: 'gpt-4.1-mini',
    apiKey: 'test-key',
    fetch: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;

      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call-abc',
                    type: 'function',
                    function: {
                      name: 'demo_echo',
                      arguments: JSON.stringify({ text: 'hello' }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      } as Response;
    },
  });

  const request: ProviderRequest = {
    ...createRequest(),
    tools: [
      {
        name: 'demo.echo',
        description: 'Echo text back.',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      },
    ],
  };

  const response = await provider.generate(request);

  assert.deepEqual(requestBody.tools, [
    {
      type: 'function',
      function: {
        name: 'demo_echo',
        description: 'Echo text back.',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      },
    },
  ]);
  assert.deepEqual(response.parts, [
    {
      type: 'tool-call',
      call: { id: 'call-abc', toolName: 'demo.echo', input: { text: 'hello' } },
    },
  ]);
});

test('createOpenAICompatibleProvider maps tool call and tool result messages for the wire', async () => {
  let requestBody: { messages?: Array<Record<string, unknown>> } = {};

  const provider = createOpenAICompatibleProvider({
    model: 'gpt-4.1-mini',
    apiKey: 'test-key',
    fetch: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as typeof requestBody;

      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          choices: [{ message: { content: 'The echo returned HELLO.' } }],
        }),
      } as Response;
    },
  });

  const base = createRequest();
  const request: ProviderRequest = {
    session: {
      ...base.session,
      messages: [
        ...base.session.messages,
        {
          id: 'session-1:assistant:2',
          role: 'assistant',
          content: '',
          createdAt: new Date().toISOString(),
          toolCalls: [{ id: 'call-abc', toolName: 'demo.echo', input: { text: 'hello' } }],
        },
        {
          id: 'session-1:tool:call-abc',
          role: 'tool',
          name: 'demo.echo',
          content: '{"callId":"call-abc","toolName":"demo.echo","ok":true,"output":{"echoed":"HELLO"}}',
          createdAt: new Date().toISOString(),
          toolResult: {
            callId: 'call-abc',
            toolName: 'demo.echo',
            ok: true,
            output: { echoed: 'HELLO' },
          },
        },
      ],
    },
  };

  const response = await provider.generate(request);

  assert.deepEqual(requestBody.messages, [
    { role: 'user', content: 'Say hello' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call-abc',
          type: 'function',
          function: { name: 'demo_echo', arguments: JSON.stringify({ text: 'hello' }) },
        },
      ],
    },
    {
      role: 'tool',
      content: JSON.stringify({ echoed: 'HELLO' }),
      tool_call_id: 'call-abc',
    },
  ]);
  assert.deepEqual(response.parts, [{ type: 'text', text: 'The echo returned HELLO.' }]);
});

test('createOpenAICompatibleProvider injects the agent persona as a system message', async () => {
  let requestBody: { messages?: Array<{ role: string; content: string }> } = {};

  const provider = createOpenAICompatibleProvider({
    model: 'gpt-4.1-mini',
    apiKey: 'test-key',
    systemPrompt: 'Global rules apply.',
    fetch: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as typeof requestBody;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: 'Hello!' } }] }),
      } as Response;
    },
  });

  const base = createRequest();
  const request: ProviderRequest = {
    session: {
      ...base.session,
      agent: {
        id: 'priya-salinger',
        name: 'Priya Salinger',
        instructions: 'You answer precisely and cite sources.',
      },
    },
  };

  await provider.generate(request);

  const systemMessages = (requestBody.messages ?? []).filter((message) => message.role === 'system');
  assert.equal(systemMessages[0]?.content, 'Global rules apply.');
  assert.equal(
    systemMessages[1]?.content,
    'You are Priya Salinger. You answer precisely and cite sources.',
  );
});

test('createOpenAICompatibleProvider renders agent memory as a system message', async () => {
  let requestBody: { messages?: Array<{ role: string; content: string }> } = {};

  const provider = createOpenAICompatibleProvider({
    model: 'gpt-4.1-mini',
    apiKey: 'test-key',
    fetch: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as typeof requestBody;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: 'Hi again!' } }] }),
      } as Response;
    },
  });

  const request: ProviderRequest = {
    ...createRequest(),
    memory: [
      {
        id: 'm1',
        agentId: 'agent-1',
        content: 'The user prefers dark mode.',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'm2',
        agentId: 'agent-1',
        content: 'Their name is Sam.',
        createdAt: new Date().toISOString(),
      },
    ],
  };

  await provider.generate(request);

  const memoryMessage = requestBody.messages?.find(
    (message) => message.role === 'system' && message.content.includes('long-term memory'),
  );
  assert.ok(memoryMessage, 'memory should be rendered as a system message');
  assert.match(memoryMessage.content, /- The user prefers dark mode\./);
  assert.match(memoryMessage.content, /- Their name is Sam\./);
});

test('createOpenAICompatibleProvider renders enabled skills as one line each, never a body', async () => {
  let requestBody: { messages?: Array<{ role: string; content: string }> } = {};

  const provider = createOpenAICompatibleProvider({
    model: 'gpt-4.1-mini',
    apiKey: 'test-key',
    fetch: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as typeof requestBody;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: 'Hi!' } }] }),
      } as Response;
    },
  });

  const request: ProviderRequest = {
    ...createRequest(),
    skills: [
      { id: 'code-review', name: 'Code Review', description: 'Use when reviewing a diff.' },
      { id: 'stratus-plugin-github:pr-review', name: 'pr-review', description: 'Use for GitHub pull requests.' },
    ],
  };

  await provider.generate(request);

  const skillsMessage = requestBody.messages?.find(
    (message) => message.role === 'system' && message.content.includes('skill.read'),
  );
  assert.ok(skillsMessage, 'skills should be rendered as a system message naming skill.read');
  assert.match(skillsMessage.content, /- code-review \(Code Review\): Use when reviewing a diff\./);
  assert.match(skillsMessage.content, /- stratus-plugin-github:pr-review \(pr-review\): Use for GitHub pull requests\./);
});

test('createOpenAICompatibleProvider sanitizes tool names and resolves collisions', async () => {
  assert.equal(sanitizeOpenAICompatibleToolName('demo.echo'), 'demo_echo');
  assert.equal(sanitizeOpenAICompatibleToolName('files:read/all'), 'files_read_all');
  assert.equal(sanitizeOpenAICompatibleToolName(''), 'tool');
  assert.equal(sanitizeOpenAICompatibleToolName('x'.repeat(80)).length, 64);

  let requestBody: { tools?: Array<{ function: { name: string } }> } = {};

  const provider = createOpenAICompatibleProvider({
    model: 'gpt-4.1-mini',
    apiKey: 'test-key',
    fetch: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as typeof requestBody;

      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call-1',
                    type: 'function',
                    function: { name: 'demo_echo_2', arguments: '{}' },
                  },
                ],
              },
            },
          ],
        }),
      } as Response;
    },
  });

  const request: ProviderRequest = {
    ...createRequest(),
    tools: [
      { name: 'demo.echo' },
      { name: 'demo/echo' },
    ],
  };

  const response = await provider.generate(request);

  assert.deepEqual(
    requestBody.tools?.map((tool) => tool.function.name),
    ['demo_echo', 'demo_echo_2'],
  );
  assert.deepEqual(response.parts, [
    { type: 'tool-call', call: { id: 'call-1', toolName: 'demo/echo', input: {} } },
  ]);
});

test('createOpenAICompatibleProvider rejects malformed tool call arguments', async () => {
  const provider = createOpenAICompatibleProvider({
    model: 'gpt-4.1-mini',
    apiKey: 'test-key',
    fetch: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call-bad',
                  type: 'function',
                  function: { name: 'demo.echo', arguments: 'not-json' },
                },
              ],
            },
          },
        ],
      }),
    }) as Response,
  });

  await assert.rejects(
    () => provider.generate(createRequest()),
    /invalid arguments for tool demo\.echo/,
  );
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

test('a hung endpoint is bounded by the request timeout', async () => {
  // An endpoint that accepts the request and never completes it must not
  // wedge the turn (or a draining daemon) forever — the provider bounds
  // every request even when the caller supplies no signal.
  const provider = createOpenAICompatibleProvider({
    model: 'm',
    apiKey: 'k',
    requestTimeoutMs: 50,
    fetch: ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        // AbortSignal.timeout's own timer is unref'd; this one keeps the
        // event loop alive while the "hung" request waits to be aborted.
        const keepAlive = setTimeout(() => {}, 60_000);
        init?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(keepAlive);
            reject(new DOMException('aborted', 'AbortError'));
          },
          { once: true },
        );
      })) as typeof fetch,
  });

  await assert.rejects(() => provider.generate(createRequest()), /timed out after 50ms/);
});

test('a caller abort is never reported as a provider timeout', async () => {
  const controller = new AbortController();
  const provider = createOpenAICompatibleProvider({
    model: 'm',
    apiKey: 'k',
    requestTimeoutMs: 60_000,
    fetch: ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
        controller.abort();
      })) as typeof fetch,
  });

  await assert.rejects(
    () => provider.generate({ ...createRequest(), signal: controller.signal }),
    (error: Error) => error.name === 'AbortError',
  );
});

/** A chat-completions endpoint answering with one fixed payload. */
const createOpenAIStub = (payload: Record<string, unknown>) =>
  createOpenAICompatibleProvider({
    model: 'gpt-4.1-mini',
    apiKey: 'test-key',
    fetch: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
    }) as Response,
  });

test('createOpenAICompatibleProvider takes cached tokens out of the input bucket', async () => {
  const provider = createOpenAIStub({
    model: 'gpt-4.1-mini-2025-04-14',
    choices: [{ message: { content: 'Hello.' } }],
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 25,
      prompt_tokens_details: { cached_tokens: 800 },
    },
  });

  const response = await provider.generate(createRequest());

  // `prompt_tokens` counts the cached tokens too, and `inputTokens` is the
  // full-rate bucket alone — 1000 prompt tokens of which 800 were cache hits
  // is 200 paid at the input rate, not 1000.
  assert.deepEqual(response.usage, {
    provider: 'openai',
    model: 'gpt-4.1-mini-2025-04-14',
    inputTokens: 200,
    outputTokens: 25,
    cacheReadTokens: 800,
  });
});

test('createOpenAICompatibleProvider reports nothing for an endpoint that omits usage', async () => {
  const provider = createOpenAIStub({ choices: [{ message: { content: 'Hello.' } }] });

  const response = await provider.generate(createRequest());

  // Plenty of compatible servers omit `usage` entirely. Absent is the honest
  // answer; a zeroed record would let a consumer report a free turn.
  assert.equal(response.usage, undefined);
  assert.deepEqual(response.parts, [{ type: 'text', text: 'Hello.' }]);
});

test('normalizeProviderResponse carries usage through', () => {
  const normalized = normalizeProviderResponse({
    parts: [{ type: 'text', text: 'hi' }],
    usage: { provider: 'fixture', inputTokens: 3 },
  });

  assert.deepEqual(normalized.usage, { provider: 'fixture', inputTokens: 3 });
});

test('a paid 200 with nothing usable in it still reports its tokens through the sink', async () => {
  // A billed completion whose only content is a tool call with a name the
  // endpoint omitted: the builder produces no parts and the empty-response
  // check throws, so the response field has no way to carry the count.
  const provider = createOpenAIStub({
    choices: [{ message: { content: '', tool_calls: [{ id: 'call-1', type: 'function', function: {} }] } }],
    usage: { prompt_tokens: 900, completion_tokens: 15 },
  });

  const reported: ProviderCallUsage[] = [];
  await assert.rejects(
    () => provider.generate({ ...createRequest(), onUsage: (usage) => reported.push(usage) }),
    /Provider returned an empty response/,
  );

  assert.deepEqual(reported, [
    { provider: 'openai', model: 'gpt-4.1-mini', inputTokens: 900, outputTokens: 15 },
  ]);
});

test('a successful call reports once, through the sink, and repeats it on the response', async () => {
  const provider = createOpenAIStub({
    choices: [{ message: { content: 'Hello.' } }],
    usage: { prompt_tokens: 100, completion_tokens: 5 },
  });

  const reported: ProviderCallUsage[] = [];
  const response = await provider.generate({
    ...createRequest(),
    onUsage: (usage) => reported.push(usage),
  });

  // Both channels carry the same call, which is safe because the kernel
  // reads one or the other and never both.
  assert.equal(reported.length, 1);
  assert.deepEqual(reported[0], response.usage);
});
