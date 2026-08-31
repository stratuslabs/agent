import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MemoryEntry, ProviderCallUsage, ProviderRequest, Session } from '@stratusagent/core';
import {
  createAnthropicProvider,
  DEFAULT_ANTHROPIC_MODEL,
  RAW_TURNS_METADATA_KEY,
  redactAnthropicRawTurns,
  sanitizeAnthropicToolName,
} from '../src/index.ts';

interface RecordedRequest {
  url: string;
  body: Record<string, any>;
  headers: Record<string, string>;
}

/**
 * One SSE frame's payload. Typed as "a `type` plus whatever else that event
 * carries", because the helper only reads `type` and serializes the rest —
 * describing it as `{ type: string }` made every realistic event literal an
 * excess-property error.
 */
type SseEvent = { type: string } & Record<string, unknown>;

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

test('generate sends the persona in the system block and memory at the tail', async () => {
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
  // The stable sections travel as one system block, joined exactly as they
  // always were, carrying the single cache breakpoint.
  assert.match(body.system[0].text, /You are Ava\. Be warm and concise\./);
  assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral', ttl: '5m' });
  // Memory is the volatile section, so it rides at the tail as a system
  // message rather than inside the cached head.
  assert.doesNotMatch(body.system[0].text, /The user prefers short answers\./);
  assert.deepEqual(body.messages, [
    { role: 'user', content: [{ type: 'text', text: 'Hello there' }] },
    { role: 'system', content: 'Things you remember from previous conversations (your own long-term memory):\n- The user prefers short answers.' },
  ]);
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

test('redactAnthropicRawTurns strips replay state from exported sessions', async () => {
  const { fetchImpl } = createMockFetch([
    apiMessage(
      [
        { type: 'thinking', thinking: 'Private reasoning.', signature: 'sig_redact' },
        { type: 'tool_use', id: 'toolu_r', name: 'demo_echo', input: {} },
      ],
      'tool_use',
    ),
  ]);

  const provider = createAnthropicProvider({ apiKey: 'test-key', fetch: fetchImpl });
  const session = createSession({ metadata: { provider: 'anthropic' } });
  await provider.generate({
    session,
    tools: [{ name: 'demo.echo', parameters: { type: 'object', properties: {} } }],
  });

  assert.ok(session.metadata?.[RAW_TURNS_METADATA_KEY]);

  const redacted = redactAnthropicRawTurns(session);
  assert.equal(redacted.metadata?.[RAW_TURNS_METADATA_KEY], undefined);
  // Other metadata survives, the original session is untouched, and
  // sessions without replay state pass through unchanged.
  assert.equal(redacted.metadata?.provider, 'anthropic');
  assert.ok(session.metadata?.[RAW_TURNS_METADATA_KEY]);
  assert.doesNotMatch(JSON.stringify(redacted), /Private reasoning/);

  const plain = createSession();
  assert.equal(redactAnthropicRawTurns(plain), plain);
});

test('streaming forwards tool-input fragments as tool-call deltas', async () => {
  // Claude streams tool input as JSON fragments after the block's start
  // event; each must reach the sink — consumers and activity watchdogs
  // would otherwise see silence while a large argument is generated.
  const sse = (events: SseEvent[]): Response =>
    new Response(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );

  const fetchImpl = (async () =>
    sse([
      {
        type: 'message_start',
        message: {
          id: 'msg_1', type: 'message', role: 'assistant', model: DEFAULT_ANTHROPIC_MODEL,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'demo_echo', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"text":' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"hi"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ])) as typeof fetch;

  const provider = createAnthropicProvider({ apiKey: 'test-key', fetch: fetchImpl });
  const session: Session = {
    id: 's-frag',
    agent: { id: 'a', name: 'A' },
    status: 'running',
    messages: [{ id: 'u1', role: 'user', content: 'go', createdAt: new Date().toISOString() }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const deltas: Array<{ type: string; toolName?: string; inputFragment?: string }> = [];
  const response = await provider.generate({
    session,
    tools: [{ name: 'demo.echo', parameters: { type: 'object', properties: {} } }],
    onDelta: async (delta) => {
      deltas.push(delta as { type: string });
    },
  } as ProviderRequest);

  // One announcing delta (wire name mapped back), then one per fragment.
  assert.deepEqual(deltas, [
    { type: 'tool-call', toolName: 'demo.echo' },
    { type: 'tool-call', toolName: 'demo.echo', inputFragment: '{"text":' },
    { type: 'tool-call', toolName: 'demo.echo', inputFragment: '"hi"}' },
  ]);
  const call = response.parts.find((part) => part.type === 'tool-call');
  assert.ok(call && call.type === 'tool-call');
  assert.deepEqual(call.call.input, { text: 'hi' });
});

test('streaming forwards thinking progress without exposing the reasoning', async () => {
  const sse = (events: SseEvent[]): Response =>
    new Response(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );

  const fetchImpl = (async () =>
    sse([
      {
        type: 'message_start',
        message: {
          id: 'msg_1', type: 'message', role: 'assistant', model: DEFAULT_ANTHROPIC_MODEL,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'private reasoning' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'the answer' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ])) as typeof fetch;

  const provider = createAnthropicProvider({ apiKey: 'test-key', fetch: fetchImpl });
  const session: Session = {
    id: 's-think',
    agent: { id: 'a', name: 'A' },
    status: 'running',
    messages: [{ id: 'u1', role: 'user', content: 'go', createdAt: new Date().toISOString() }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const deltas: Array<Record<string, unknown>> = [];
  await provider.generate({
    session,
    onDelta: async (delta) => {
      deltas.push(delta as Record<string, unknown>);
    },
  } as ProviderRequest);

  // Thinking stretches surface as content-free progress signals, so an
  // activity watchdog sees a healthy turn — and the reasoning never rides
  // along.
  assert.deepEqual(deltas, [
    { type: 'thinking' },
    { type: 'thinking' },
    { type: 'text', text: 'the answer' },
  ]);
});

test('generate reports the API usage in the kernel buckets, untouched', async () => {
  const { fetchImpl } = createMockFetch([
    {
      ...apiMessage([{ type: 'text', text: 'Hi.' }]),
      model: 'claude-opus-5-20260101',
      usage: {
        input_tokens: 40,
        output_tokens: 12,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 300,
      },
    },
  ]);

  const provider = createAnthropicProvider({ apiKey: 'test-key', fetch: fetchImpl });
  const response = await provider.generate({ session: createSession() });

  // The Messages API already reports the three input buckets as disjoint
  // counts, so nothing is subtracted here — and the model is the one the API
  // says served, not the alias that was asked for.
  assert.deepEqual(response.usage, {
    provider: 'anthropic',
    model: 'claude-opus-5-20260101',
    inputTokens: 40,
    outputTokens: 12,
    cacheReadTokens: 900,
    cacheWriteTokens: 300,
  });
});

test('a cache bucket the API leaves null is absent rather than zero', async () => {
  const { fetchImpl } = createMockFetch([
    {
      ...apiMessage([{ type: 'text', text: 'Hi.' }]),
      usage: {
        input_tokens: 40,
        output_tokens: 12,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
      },
    },
  ]);

  const provider = createAnthropicProvider({ apiKey: 'test-key', fetch: fetchImpl });
  const response = await provider.generate({ session: createSession() });

  assert.deepEqual(Object.keys(response.usage ?? {}), ['provider', 'model', 'inputTokens', 'outputTokens']);
  assert.equal(response.usage?.model, DEFAULT_ANTHROPIC_MODEL);
});

test('a paid call that surfaces no parts still reports its tokens through the sink', async () => {
  // Adaptive thinking can consume the whole output budget without producing
  // a text or tool_use block. The API call completed and was billed, and the
  // empty-response check below throws — so the response field has no way to
  // carry the count and the sink is the only carrier left.
  const { fetchImpl } = createMockFetch([
    {
      ...apiMessage([]),
      usage: { input_tokens: 8000, output_tokens: 4096 },
    },
  ]);

  const reported: ProviderCallUsage[] = [];
  const provider = createAnthropicProvider({ apiKey: 'test-key', fetch: fetchImpl });

  await assert.rejects(
    provider.generate({
      session: createSession(),
      onUsage: (usage) => reported.push(usage),
    } as ProviderRequest),
    /Claude returned an empty response/,
  );

  assert.deepEqual(reported, [
    { provider: 'anthropic', model: DEFAULT_ANTHROPIC_MODEL, inputTokens: 8000, outputTokens: 4096 },
  ]);
});

test('a successful call reports once, through the sink, and repeats it on the response', async () => {
  const { fetchImpl } = createMockFetch([
    { ...apiMessage([{ type: 'text', text: 'Hi.' }]), usage: { input_tokens: 40, output_tokens: 12 } },
  ]);

  const reported: ProviderCallUsage[] = [];
  const provider = createAnthropicProvider({ apiKey: 'test-key', fetch: fetchImpl });
  const response = await provider.generate({
    session: createSession(),
    onUsage: (usage) => reported.push(usage),
  } as ProviderRequest);

  // Both channels carry the same call, which is safe because the kernel
  // reads one or the other and never both — the response field is what a
  // host calling generate with no sink attached gets.
  assert.equal(reported.length, 1);
  assert.deepEqual(reported[0], response.usage);
});

/** Two turns of the same conversation, second one carrying a new memory. */
const cachedHeadOf = (body: Record<string, any>): string => body.system[0].text;

test('a memory write leaves the cached head byte-identical', async () => {
  // The whole point of the step. If a remembered fact changes the system
  // block, every turn after it re-pays full input price for a persona and a
  // skills list that did not change.
  const { fetchImpl, requests } = createMockFetch([
    apiMessage([{ type: 'text', text: 'One.' }]),
    apiMessage([{ type: 'text', text: 'Two.' }]),
  ]);
  const provider = createAnthropicProvider({ apiKey: 'test-key', fetch: fetchImpl });
  const entry = (content: string): MemoryEntry => ({
    id: `ava:memory:${content.length}`,
    agentId: 'ava',
    content,
    createdAt: new Date().toISOString(),
  });

  await provider.generate({ session: createSession(), memory: [entry('First fact.')] });
  await provider.generate({
    session: createSession(),
    memory: [entry('First fact.'), entry('A fact learned since.')],
    skills: [{ id: 'triage', name: 'Triage', description: 'Use when triaging.' }],
  } as ProviderRequest);

  assert.notEqual(cachedHeadOf(requests[1]!.body), undefined);
  // The head grew only because a skill was enabled — the memory write did not
  // touch it, and the newly remembered fact is at the tail instead.
  assert.match(cachedHeadOf(requests[1]!.body), /You are Ava/);
  assert.doesNotMatch(cachedHeadOf(requests[1]!.body), /A fact learned since/);
  assert.match(String(requests[1]!.body.messages.at(-1).content), /A fact learned since/);
});

test('the tool list is byte-identical after a tool is re-registered', async () => {
  // The MCP reconnect case: a bridge unregisters and re-registers its tools,
  // which moves them to the end of the registry's insertion order. Unsorted,
  // that silently kills every cache hit for the rest of the daemon's life.
  const { fetchImpl, requests } = createMockFetch([
    apiMessage([{ type: 'text', text: 'One.' }]),
    apiMessage([{ type: 'text', text: 'Two.' }]),
  ]);
  const provider = createAnthropicProvider({ apiKey: 'test-key', fetch: fetchImpl });
  const echo = { name: 'demo.echo', description: 'Echo.', parameters: { type: 'object', properties: {} } };
  const notes = { name: 'mcp.notes.read', description: 'Read.', parameters: { type: 'object', properties: {} } };

  await provider.generate({ session: createSession(), tools: [echo, notes] } as ProviderRequest);
  await provider.generate({ session: createSession(), tools: [notes, echo] } as ProviderRequest);

  assert.deepEqual(requests[0]!.body.tools, requests[1]!.body.tools);
  assert.deepEqual(
    requests[0]!.body.tools.map((tool: { name: string }) => tool.name),
    ['demo_echo', 'mcp_notes_read'],
  );
});

test('prompt caching can be turned off, and the TTL chosen', async () => {
  const { fetchImpl, requests } = createMockFetch([apiMessage([{ type: 'text', text: 'Hi.' }])]);
  const off = createAnthropicProvider({ apiKey: 'test-key', fetch: fetchImpl, promptCache: false });
  await off.generate({ session: createSession() });
  assert.equal(requests[0]!.body.system[0].cache_control, undefined);

  const hourly = createAnthropicProvider({
    apiKey: 'test-key',
    fetch: createMockFetch([apiMessage([{ type: 'text', text: 'Hi.' }])]).fetchImpl,
    promptCacheTtl: '1h',
  });
  const response = await hourly.generate({ session: createSession() });
  assert.equal(response.parts.length, 1);
});

test('a model that rejects a system message falls back, and does not pay for it twice', async () => {
  const bodies: Array<Record<string, any>> = [];
  let calls = 0;
  const fetchImpl = (async (_input: any, init?: any) => {
    bodies.push(JSON.parse(init?.body ?? '{}'));
    calls += 1;
    // Sonnet 5 rejects a mid-conversation system message. Only the first
    // attempt of the first turn should ever see it.
    if (bodies.at(-1)?.messages?.at(-1)?.role === 'system') {
      return new Response(
        JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: "messages: role 'system' is not supported on this model" } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify(apiMessage([{ type: 'text', text: 'Hi.' }])), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const provider = createAnthropicProvider({ apiKey: 'test-key', fetch: fetchImpl, maxTokens: 64 });
  const memory: MemoryEntry[] = [
    { id: 'm1', agentId: 'ava', content: 'Remembered.', createdAt: new Date().toISOString() },
  ];

  const first = await provider.generate({ session: createSession(), memory });
  assert.deepEqual(first.parts, [{ type: 'text', text: 'Hi.' }]);
  // Rejected, then retried with memory back in the system block.
  assert.equal(calls, 2);
  assert.match(bodies[1]!.system[0].text, /Remembered\./);

  // The rejection is remembered for the life of the provider, so the next
  // turn costs one request rather than two.
  await provider.generate({ session: createSession(), memory });
  assert.equal(calls, 3);
  assert.match(bodies[2]!.system[0].text, /Remembered\./);
});

test('an unrelated 400 is not swallowed by the system-message fallback', async () => {
  const fetchImpl = (async () => new Response(
    JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: must be greater than 0' } }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  )) as typeof fetch;

  const provider = createAnthropicProvider({ apiKey: 'test-key', fetch: fetchImpl });
  await assert.rejects(
    provider.generate({
      session: createSession(),
      memory: [{ id: 'm1', agentId: 'ava', content: 'x', createdAt: new Date().toISOString() }],
    }),
    /max_tokens/,
  );
});

test('an agent with tools but nothing to say caches its tool list', async () => {
  // No preamble, no instructions, no skills — so there is no system block to
  // carry the breakpoint, and the tool schemas are the largest stable thing
  // in the request. Without the fallback below they would be re-sent at full
  // price on every turn of the agent's life.
  const { fetchImpl, requests } = createMockFetch([apiMessage([{ type: 'text', text: 'Hi.' }])]);
  const provider = createAnthropicProvider({ apiKey: 'test-key', fetch: fetchImpl });

  await provider.generate({
    session: createSession({ agent: { id: 'bare', name: 'Bare' } }),
    tools: [
      { name: 'a.one', description: 'One.', parameters: { type: 'object', properties: {} } },
      { name: 'b.two', description: 'Two.', parameters: { type: 'object', properties: {} } },
    ],
  } as ProviderRequest);

  const body = requests[0]!.body;
  assert.equal(body.system, undefined);
  assert.equal(body.tools[0].cache_control, undefined);
  assert.deepEqual(body.tools.at(-1).cache_control, { type: 'ephemeral', ttl: '5m' });
});

test('the breakpoint is never placed twice on one contiguous prefix', async () => {
  // A marker on the last system block already covers the tools ahead of it,
  // so a second one on the last tool would spend a slot to cache the same
  // bytes twice.
  const { fetchImpl, requests } = createMockFetch([apiMessage([{ type: 'text', text: 'Hi.' }])]);
  const provider = createAnthropicProvider({ apiKey: 'test-key', fetch: fetchImpl });

  await provider.generate({
    session: createSession(),
    tools: [{ name: 'a.one', description: 'One.', parameters: { type: 'object', properties: {} } }],
  } as ProviderRequest);

  const body = requests[0]!.body;
  assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral', ttl: '5m' });
  assert.equal(body.tools.at(-1).cache_control, undefined);
});

test('a retry does not carry the previous attempt\'s tool breakpoint', async () => {
  // The fallback path rebuilds the request. Tools are copied per attempt, so
  // an annotation from the rejected attempt cannot leak into the retry and
  // leave two markers on one prefix.
  const bodies: Array<Record<string, any>> = [];
  const fetchImpl = (async (_input: any, init?: any) => {
    const body = JSON.parse(init?.body ?? '{}');
    bodies.push(body);
    if (body.messages?.at(-1)?.role === 'system') {
      return new Response(
        JSON.stringify({ type: 'error', error: { message: "role 'system' is not supported on this model" } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify(apiMessage([{ type: 'text', text: 'Hi.' }])), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const provider = createAnthropicProvider({ apiKey: 'test-key', fetch: fetchImpl });
  await provider.generate({
    session: createSession({ agent: { id: 'bare', name: 'Bare' } }),
    tools: [{ name: 'a.one', description: 'One.', parameters: { type: 'object', properties: {} } }],
    memory: [{ id: 'm1', agentId: 'bare', content: 'Remembered.', createdAt: new Date().toISOString() }],
  } as ProviderRequest);

  // The retry moved memory into a system block, so the breakpoint belongs
  // there — and must no longer be on the tool it fell back to first.
  const retry = bodies[1]!;
  assert.deepEqual(retry.system[0].cache_control, { type: 'ephemeral', ttl: '5m' });
  assert.equal(retry.tools.at(-1).cache_control, undefined);
});
