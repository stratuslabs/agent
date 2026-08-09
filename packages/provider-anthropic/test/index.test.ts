import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MemoryEntry, ProviderRequest, Session } from '@stratusagent/core';
import {
  createAnthropicProvider,
  DEFAULT_ANTHROPIC_MODEL,
  sanitizeAnthropicToolName,
} from '../src/index.ts';

interface RecordedRequest {
  url: string;
  body: Record<string, any>;
  headers: Record<string, string>;
}

const createMockFetch = (responses: Array<Record<string, unknown>>) => {
  const requests: RecordedRequest[] = [];
  let callIndex = 0;

  const fetchImpl = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((value, key) => {
      headers[key] = value;
    });
    requests.push({ url, body: JSON.parse(init?.body ?? '{}'), headers });

    const payload = responses[Math.min(callIndex, responses.length - 1)];
    callIndex += 1;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  return { fetchImpl, requests };
};

const apiMessage = (content: unknown[], stopReason = 'end_turn') => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: DEFAULT_ANTHROPIC_MODEL,
  content,
  stop_reason: stopReason,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 10 },
});

const createSession = (overrides: Partial<Session> = {}): Session => ({
  id: 'session-1',
  agent: { id: 'ava', name: 'Ava', instructions: 'Be warm and concise.' },
  status: 'running',
  messages: [
    {
      id: 'session-1:user:1',
      role: 'user',
      content: 'Hello there',
      createdAt: new Date().toISOString(),
    },
  ],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
});

test('sanitizeAnthropicToolName replaces unsupported characters', () => {
  assert.equal(sanitizeAnthropicToolName('demo.echo'), 'demo_echo');
  assert.equal(sanitizeAnthropicToolName('memory.remember'), 'memory_remember');
  assert.equal(sanitizeAnthropicToolName(''), 'tool');
});

test('generate sends persona and memory as the system prompt', async () => {
  const { fetchImpl, requests } = createMockFetch([
    apiMessage([{ type: 'text', text: 'Hi! Lovely to meet you.' }]),
  ]);

  const provider = createAnthropicProvider({ apiKey: 'test-key', fetch: fetchImpl });
  const memory: MemoryEntry[] = [
    {
      id: 'ava:memory:1',
      agentId: 'ava',
      content: 'The user prefers short answers.',
      createdAt: new Date().toISOString(),
    },
  ];

  const response = await provider.generate({ session: createSession(), memory });

  assert.equal(response.parts.length, 1);
  assert.deepEqual(response.parts[0], { type: 'text', text: 'Hi! Lovely to meet you.' });

  const body = requests[0]!.body;
  assert.equal(body.model, DEFAULT_ANTHROPIC_MODEL);
  assert.match(body.system, /You are Ava\. Be warm and concise\./);
  assert.match(body.system, /The user prefers short answers\./);
  assert.deepEqual(body.messages, [{ role: 'user', content: [{ type: 'text', text: 'Hello there' }] }]);
  assert.equal(requests[0]!.headers['x-api-key'], 'test-key');
});

test('generate advertises tools with sanitized wire names and maps calls back', async () => {
  const { fetchImpl, requests } = createMockFetch([
    apiMessage(
      [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'toolu_1', name: 'demo_echo', input: { text: 'hi' } },
      ],
      'tool_use',
    ),
  ]);

  const provider = createAnthropicProvider({ apiKey: 'test-key', fetch: fetchImpl });
  const request: ProviderRequest = {
    session: createSession(),
    tools: [
      {
        name: 'demo.echo',
        description: 'Echo things',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      },
    ],
  };

  const response = await provider.generate(request);

  const body = requests[0]!.body;
  assert.deepEqual(body.tools, [
    {
      name: 'demo_echo',
      description: 'Echo things',
      input_schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
  ]);

  assert.deepEqual(response.parts, [
    { type: 'text', text: 'Let me check.' },
    {
      type: 'tool-call',
      call: { id: 'toolu_1', toolName: 'demo.echo', input: { text: 'hi' } },
    },
  ]);
});

test('history replay merges runner messages into API turns and keeps thinking blocks', async () => {
  const thinkingTurn = [
    { type: 'thinking', thinking: 'The user wants the echo tool.', signature: 'sig_abc' },
    { type: 'tool_use', id: 'toolu_1', name: 'demo_echo', input: { text: 'hi' } },
  ];
  const { fetchImpl, requests } = createMockFetch([
    apiMessage(thinkingTurn, 'tool_use'),
    apiMessage([{ type: 'text', text: 'All done: HI' }]),
  ]);

  const provider = createAnthropicProvider({ apiKey: 'test-key', fetch: fetchImpl });
  const session = createSession({
    agent: { id: 'ava', name: 'Ava' },
    metadata: {},
  });
  const tools: ProviderRequest['tools'] = [
    { name: 'demo.echo', parameters: { type: 'object', properties: {} } },
  ];

  const first = await provider.generate({ session, tools });
  const call = first.parts.find((part) => part.type === 'tool-call');
  assert.ok(call && call.type === 'tool-call');

  // Mirror what AgentRunner records: an assistant tool-call message, then a
  // tool result message.
  session.messages.push(
    {
      id: 'session-1:assistant:2',
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      toolCalls: [call.call],
    },
    {
      id: 'session-1:tool:toolu_1',
      role: 'tool',
      name: 'demo.echo',
      content: '{}',
      createdAt: new Date().toISOString(),
      toolResult: {
        callId: 'toolu_1',
        toolName: 'demo.echo',
        ok: true,
        output: { received: 'hi', uppercase: 'HI' },
      },
    },
  );

  const second = await provider.generate({ session, tools });
  assert.deepEqual(second.parts, [{ type: 'text', text: 'All done: HI' }]);

  const replay = requests[1]!.body.messages;
  assert.equal(replay.length, 3);
  assert.deepEqual(replay[1], { role: 'assistant', content: thinkingTurn });
  assert.deepEqual(replay[2], {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: JSON.stringify({ received: 'hi', uppercase: 'HI' }),
      },
    ],
  });
});

test('failed tool results replay as is_error tool_result blocks', async () => {
  const { fetchImpl, requests } = createMockFetch([
    apiMessage([{ type: 'text', text: 'That tool failed, sorry.' }]),
  ]);

  const provider = createAnthropicProvider({ apiKey: 'test-key', fetch: fetchImpl });
  const session = createSession();
  session.messages.push(
    {
      id: 'session-1:assistant:2',
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      toolCalls: [{ id: 'toolu_9', toolName: 'demo.echo', input: {} }],
    },
    {
      id: 'session-1:tool:toolu_9',
      role: 'tool',
      name: 'demo.echo',
      content: '{}',
      createdAt: new Date().toISOString(),
      toolResult: {
        callId: 'toolu_9',
        toolName: 'demo.echo',
        ok: false,
        output: null,
        error: 'boom',
      },
    },
  );

  await provider.generate({ session });

  const replay = requests[0]!.body.messages;
  // Unseen assistant tool calls are reconstructed as plain tool_use blocks.
  assert.deepEqual(replay[1], {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_9', name: 'demo_echo', input: {} }],
  });
  assert.deepEqual(replay[2], {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_9',
        content: JSON.stringify({ error: 'boom' }),
        is_error: true,
      },
    ],
  });
});

test('thinking can be disabled and empty responses throw', async () => {
  const { fetchImpl, requests } = createMockFetch([apiMessage([])]);

  const provider = createAnthropicProvider({
    apiKey: 'test-key',
    fetch: fetchImpl,
    thinking: 'disabled',
    model: 'claude-sonnet-5',
    maxTokens: 2048,
  });

  await assert.rejects(
    () => provider.generate({ session: createSession() }),
    /empty response/,
  );

  const body = requests[0]!.body;
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.model, 'claude-sonnet-5');
  assert.equal(body.max_tokens, 2048);
});

test('a response with text and multiple tool calls replays as one atomic turn', async () => {
  const multiCallTurn = [
    { type: 'thinking', thinking: 'Two tools needed.', signature: 'sig_multi' },
    { type: 'text', text: 'Running both tools.' },
    { type: 'tool_use', id: 'toolu_a', name: 'demo_echo', input: { text: 'one' } },
    { type: 'tool_use', id: 'toolu_b', name: 'demo_echo', input: { text: 'two' } },
  ];
  const { fetchImpl, requests } = createMockFetch([
    apiMessage(multiCallTurn, 'tool_use'),
    apiMessage([{ type: 'text', text: 'Both done.' }]),
  ]);

  const provider = createAnthropicProvider({ apiKey: 'test-key', fetch: fetchImpl });
  const session = createSession();
  const tools: ProviderRequest['tools'] = [
    { name: 'demo.echo', parameters: { type: 'object', properties: {} } },
  ];

  const first = await provider.generate({ session, tools });
  const calls = first.parts.filter((part) => part.type === 'tool-call');
  assert.equal(calls.length, 2);

  // Mirror what AgentRunner records for [text, call, call]: one text message,
  // then per call an assistant message followed by its tool result.
  session.messages.push(
    {
      id: 'session-1:assistant:2',
      role: 'assistant',
      content: 'Running both tools.',
      createdAt: new Date().toISOString(),
    },
    {
      id: 'session-1:assistant:3',
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      toolCalls: [calls[0]!.call],
    },
    {
      id: 'session-1:tool:toolu_a',
      role: 'tool',
      name: 'demo.echo',
      content: '{}',
      createdAt: new Date().toISOString(),
      toolResult: { callId: 'toolu_a', toolName: 'demo.echo', ok: true, output: { echoed: 'one' } },
    },
    {
      id: 'session-1:assistant:5',
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      toolCalls: [calls[1]!.call],
    },
    {
      id: 'session-1:tool:toolu_b',
      role: 'tool',
      name: 'demo.echo',
      content: '{}',
      createdAt: new Date().toISOString(),
      toolResult: { callId: 'toolu_b', toolName: 'demo.echo', ok: true, output: { echoed: 'two' } },
    },
  );

  await provider.generate({ session, tools });

  const replay = requests[1]!.body.messages;
  // user, ONE assistant turn (the raw response, text included exactly once),
  // ONE user turn carrying both tool results.
  assert.equal(replay.length, 3);
  assert.deepEqual(replay[1], { role: 'assistant', content: multiCallTurn });
  assert.deepEqual(
    replay[2].content.map((block: { tool_use_id: string }) => block.tool_use_id),
    ['toolu_a', 'toolu_b'],
  );
});

test('raw turns persist with the session across provider instances and serialization', async () => {
  const multiCallTurn = [
    { type: 'thinking', thinking: 'Two tools needed.', signature: 'sig_persist' },
    { type: 'text', text: 'Running both tools.' },
    { type: 'tool_use', id: 'toolu_a', name: 'demo_echo', input: { text: 'one' } },
    { type: 'tool_use', id: 'toolu_b', name: 'demo_echo', input: { text: 'two' } },
  ];
  const first = createMockFetch([apiMessage(multiCallTurn, 'tool_use')]);
  const second = createMockFetch([apiMessage([{ type: 'text', text: 'Both done.' }])]);

  const tools: ProviderRequest['tools'] = [
    { name: 'demo.echo', parameters: { type: 'object', properties: {} } },
  ];

  const session = createSession();
  const firstProvider = createAnthropicProvider({ apiKey: 'test-key', fetch: first.fetchImpl });
  const response = await firstProvider.generate({ session, tools });
  const calls = response.parts.filter((part) => part.type === 'tool-call');
  assert.equal(calls.length, 2);

  session.messages.push(
    {
      id: 'session-1:assistant:2',
      role: 'assistant',
      content: 'Running both tools.',
      createdAt: new Date().toISOString(),
    },
    {
      id: 'session-1:assistant:3',
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      toolCalls: [calls[0]!.call],
    },
    {
      id: 'session-1:tool:toolu_a',
      role: 'tool',
      name: 'demo.echo',
      content: '{}',
      createdAt: new Date().toISOString(),
      toolResult: { callId: 'toolu_a', toolName: 'demo.echo', ok: true, output: { echoed: 'one' } },
    },
    {
      id: 'session-1:assistant:5',
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      toolCalls: [calls[1]!.call],
    },
    {
      id: 'session-1:tool:toolu_b',
      role: 'tool',
      name: 'demo.echo',
      content: '{}',
      createdAt: new Date().toISOString(),
      toolResult: { callId: 'toolu_b', toolName: 'demo.echo', ok: true, output: { echoed: 'two' } },
    },
  );

  // The session goes through a store round-trip (serialize + parse) and the
  // follow-up turn is served by a DIFFERENT provider instance — modelling a
  // slow tool wait, a process restart, or a resume elsewhere. The raw turn
  // travels in session.metadata, so nothing is lost.
  const revived = JSON.parse(JSON.stringify(session)) as Session;
  const secondProvider = createAnthropicProvider({ apiKey: 'test-key', fetch: second.fetchImpl });
  await secondProvider.generate({ session: revived, tools });

  const replay = second.requests[0]!.body.messages;
  // Still one atomic assistant turn (thinking intact, text exactly once)
  // followed by one user turn with both results — even though each cached
  // key now holds a distinct parsed copy of the raw turn.
  assert.equal(replay.length, 3);
  assert.deepEqual(replay[1], { role: 'assistant', content: multiCallTurn });
  assert.deepEqual(
    replay[2].content.map((block: { tool_use_id: string }) => block.tool_use_id),
    ['toolu_a', 'toolu_b'],
  );
});
