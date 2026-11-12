import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ContextOverflowError,
  renderToolResultContent,
  type ImageAttachment,
  type ProviderCallUsage,
  type ProviderDelta,
  type ProviderRequest,
  type ToolResult,
} from '@stratusagent/core';
import { createOpenAIResponsesProvider } from '../src/index.ts';

const now = new Date().toISOString();

const requestWith = (messages: ProviderRequest['session']['messages']): ProviderRequest => ({
  session: {
    id: 'session-1',
    agent: { id: 'agent-1', name: 'Kernel' },
    status: 'running',
    messages,
    createdAt: now,
    updatedAt: now,
  },
});

const sayHello = (): ProviderRequest =>
  requestWith([{ id: 'session-1:user:1', role: 'user', content: 'Say hello', createdAt: now }]);

const encoder = new TextEncoder();

/**
 * A `text/event-stream` body as the API sends it, cut into `chunkSize`-byte
 * pieces so the reader meets events, lines and line endings split across
 * reads.
 */
const sseBody = (events: readonly object[], { chunkSize, lineEnd = '\n' }: { chunkSize?: number; lineEnd?: string } = {}): Uint8Array[] => {
  const text = events
    .map((event) => `event: ${(event as { type: string }).type}${lineEnd}data: ${JSON.stringify(event)}${lineEnd}${lineEnd}`)
    .join('');
  const bytes = encoder.encode(text);
  const size = chunkSize ?? bytes.length;
  const chunks: Uint8Array[] = [];
  for (let start = 0; start < bytes.length; start += size) {
    chunks.push(bytes.slice(start, start + size));
  }
  return chunks;
};

const sseResponse = (events: readonly object[], options?: { chunkSize?: number; lineEnd?: string }): Response => {
  const chunks = sseBody(events, options);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
};

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Captured {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

const fakeFetch = (respond: (call: number, init: RequestInit) => Response | Promise<Response>) => {
  const calls: Captured[] = [];
  const fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return respond(calls.length, init);
  }) as typeof globalThis.fetch;
  return { calls, fetch };
};

const outputMessage = (text: string, id = 'msg_1') => ({
  id,
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
});

const terminal = (type: string, fields: Record<string, unknown>) => ({
  type,
  sequence_number: 99,
  response: { id: 'resp_1', object: 'response', model: 'gpt-test-2026', output: [], ...fields },
});

const USAGE = {
  input_tokens: 100,
  input_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 },
  output_tokens: 7,
  output_tokens_details: { reasoning_tokens: 2 },
  total_tokens: 107,
};

const EXPECTED_USAGE: ProviderCallUsage = {
  provider: 'openai',
  model: 'gpt-test-2026',
  inputTokens: 50,
  outputTokens: 7,
  cacheReadTokens: 40,
  cacheWriteTokens: 10,
};

const png = (data: string, name?: string): ImageAttachment => ({ mediaType: 'image/png', data, ...(name ? { name } : {}) });

test('the Responses transport streams text and sends the whole history statelessly', async () => {
  const { calls, fetch } = fakeFetch(() => sseResponse([
    { type: 'response.created', sequence_number: 0, response: { id: 'resp_1', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { id: 'rs_1', type: 'reasoning', summary: [] } },
    { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, summary_index: 0, delta: 'Thinking' },
    { type: 'response.output_item.added', output_index: 1, item: { id: 'msg_1', type: 'message', role: 'assistant', content: [] } },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, content_index: 0, delta: 'Hé' },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, content_index: 0, delta: 'llo' },
    { type: 'response.output_item.done', output_index: 1, item: outputMessage('Héllo') },
    // The final event's `output` left empty: the items already arrived one
    // by one, and a backend that does not repeat them must still work.
    terminal('response.completed', { status: 'completed', usage: USAGE }),
    // One byte a read: every `\r\n` and the two bytes of `é` arrive split.
  ], { chunkSize: 1, lineEnd: '\r\n' }));

  const provider = createOpenAIResponsesProvider({ model: 'gpt-test', apiKey: 'sk-test', systemPrompt: 'You are terse.', fetch });
  const deltas: ProviderDelta[] = [];
  const usages: ProviderCallUsage[] = [];
  const result = await provider.generate({
    ...sayHello(),
    onDelta: (delta) => {
      deltas.push(delta);
    },
    onUsage: (usage) => {
      usages.push(usage);
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://api.openai.com/v1/responses');
  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer sk-test');
  assert.equal(headers.accept, 'text/event-stream');
  const body = calls[0]?.body ?? {};
  assert.equal(body.model, 'gpt-test');
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.match(String(body.instructions), /You are terse\./);
  assert.deepEqual(body.input, [{ role: 'user', content: 'Say hello' }]);
  assert.equal('tools' in body, false);
  assert.equal('tool_choice' in body, false);

  assert.deepEqual(deltas, [
    { type: 'thinking' },
    { type: 'thinking' },
    { type: 'text', text: 'Hé' },
    { type: 'text', text: 'llo' },
  ]);
  assert.deepEqual(result.parts, [{ type: 'text', text: 'Héllo' }]);
  assert.deepEqual(usages, [EXPECTED_USAGE]);
  assert.deepEqual(result.usage, EXPECTED_USAGE);
});

test('an event over several data lines is read as one, wherever the reads cut it', async () => {
  const output = JSON.stringify([outputMessage('Hi')]);
  const raw = ': keep-alive\r\n\r\n'
    + 'event: response.completed\r\n'
    + 'data: {"type":"response.completed",\r\n'
    + `data: "response":{"status":"completed","output":${output}}}\r\n\r\n`;
  const bytes = encoder.encode(raw);
  const { fetch } = fakeFetch(() => new Response(new ReadableStream<Uint8Array>({
    start(stream) {
      for (const byte of bytes) {
        stream.enqueue(Uint8Array.of(byte));
      }
      stream.close();
    },
  }), { status: 200 }));
  const provider = createOpenAIResponsesProvider({ model: 'gpt-test', apiKey: 'sk-test', fetch });

  const result = await provider.generate(sayHello());

  assert.deepEqual(result.parts, [{ type: 'text', text: 'Hi' }]);
});

test('tool calls go out by wire name, stream as fragments, and come back by registry name', async () => {
  const call = { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'demo_echo', arguments: '{"text":"hi"}', status: 'completed' };
  const { calls, fetch } = fakeFetch(() => sseResponse([
    { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '', status: 'in_progress' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '{"text":' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '"hi"}' },
    { type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 0, arguments: '{"text":"hi"}' },
    { type: 'response.output_item.done', output_index: 0, item: call },
    terminal('response.completed', { status: 'completed', output: [call] }),
  ]));
  const provider = createOpenAIResponsesProvider({ model: 'gpt-test', apiKey: 'sk-test', fetch });
  const tools = [{ name: 'demo.echo', description: 'Echo text', parameters: { type: 'object', properties: { text: { type: 'string' } } } }];
  const deltas: ProviderDelta[] = [];

  const result = await provider.generate({ ...sayHello(), tools, onDelta: (delta) => { deltas.push(delta); } });

  assert.deepEqual(calls[0]?.body.tools, [
    { type: 'function', name: 'demo_echo', description: 'Echo text', parameters: tools[0]?.parameters },
  ]);
  assert.deepEqual(deltas, [
    { type: 'tool-call', toolName: 'demo.echo' },
    { type: 'tool-call', toolName: 'demo.echo', inputFragment: '{"text":' },
    { type: 'tool-call', toolName: 'demo.echo', inputFragment: '"hi"}' },
  ]);
  // Taken once, though the item arrived both on its own and in the final event.
  assert.deepEqual(result.parts, [
    { type: 'tool-call', call: { id: 'call_1', toolName: 'demo.echo', input: { text: 'hi' } } },
  ]);

  // The wrap-up turn keeps the tools declared and asks for words.
  await provider.generate({ ...sayHello(), tools, toolChoice: 'none' });
  assert.equal(calls[1]?.body.tool_choice, 'none');
  assert.equal((calls[1]?.body.tools as unknown[]).length, 1);
});

test('arguments that are not a JSON object fail the turn with the tool named', async () => {
  const call = { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'demo_echo', arguments: '{"text":', status: 'completed' };
  const { fetch } = fakeFetch(() => sseResponse([terminal('response.completed', { status: 'completed', output: [call] })]));
  const provider = createOpenAIResponsesProvider({ model: 'gpt-test', apiKey: 'sk-test', fetch });
  await assert.rejects(
    provider.generate({ ...sayHello(), tools: [{ name: 'demo.echo' }] }),
    /invalid arguments for tool demo\.echo/,
  );
});

test('the transcript reaches the wire as Responses items, tool images inside their own output', async () => {
  const result: ToolResult = { callId: 'call_1', toolName: 'demo.echo', ok: true, output: { echoed: 'hi' }, trust: 'agent' };
  const request = requestWith([
    { id: 'm1', role: 'user', content: 'Look at this', images: [png('aGk=', 'one.png')], createdAt: now },
    { id: 'm2', role: 'assistant', content: 'Checking.', createdAt: now },
    { id: 'm3', role: 'assistant', content: '', toolCalls: [{ id: 'call_1', toolName: 'demo.echo', input: { text: 'hi' } }], createdAt: now },
    { id: 'm4', role: 'tool', name: 'demo.echo', content: '', toolResult: result, images: [png('Ymk=')], createdAt: now },
    { id: 'm5', role: 'assistant', content: '', createdAt: now },
    { id: 'm6', role: 'user', content: 'Thanks', createdAt: now },
  ]);
  const { calls, fetch } = fakeFetch(() => sseResponse([
    terminal('response.completed', { status: 'completed', output: [outputMessage('Welcome')] }),
  ]));
  const provider = createOpenAIResponsesProvider({ model: 'gpt-test', apiKey: 'sk-test', fetch });

  const response = await provider.generate({ ...request, tools: [{ name: 'demo.echo' }] });

  assert.deepEqual(response.parts, [{ type: 'text', text: 'Welcome' }]);
  assert.deepEqual(calls[0]?.body.input, [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: 'Look at this' },
        { type: 'input_image', image_url: 'data:image/png;base64,aGk=', detail: 'auto' },
      ],
    },
    { role: 'assistant', content: 'Checking.' },
    { type: 'function_call', call_id: 'call_1', name: 'demo_echo', arguments: '{"text":"hi"}' },
    {
      type: 'function_call_output',
      call_id: 'call_1',
      output: [
        { type: 'input_text', text: renderToolResultContent(result) },
        { type: 'input_image', image_url: 'data:image/png;base64,Ymk=', detail: 'auto' },
      ],
    },
    { role: 'user', content: 'Thanks' },
  ]);
});

test('images past the replay budget go as notes, and a 400 blaming an image retries once with none', async () => {
  const older = png('b2xk', 'older.png');
  const newer = png('bmV3', 'newer.png');
  const request = requestWith([
    { id: 'm1', role: 'user', content: 'First', images: [older], createdAt: now },
    { id: 'm2', role: 'assistant', content: 'Seen.', createdAt: now },
    { id: 'm3', role: 'user', content: 'Second', images: [newer], createdAt: now },
  ]);
  const { calls, fetch } = fakeFetch((call) => (call === 1
    ? jsonResponse(400, { error: { message: 'Invalid image data.', type: 'invalid_request_error', code: 'invalid_image' } })
    : sseResponse([terminal('response.completed', { status: 'completed', output: [outputMessage('Fine')] })])));
  const provider = createOpenAIResponsesProvider({ model: 'gpt-test', apiKey: 'sk-test', fetch, imageReplayBudget: { count: 1 } });

  const response = await provider.generate(request);

  assert.deepEqual(response.parts, [{ type: 'text', text: 'Fine' }]);
  assert.equal(calls.length, 2);
  const first = JSON.stringify(calls[0]?.body.input);
  assert.match(first, /bmV3/);
  assert.doesNotMatch(first, /b2xk/);
  assert.match(first, /older\.png/);
  // The refused image is let go of on the session, and the retry sends no
  // image at all: not the refused one, and not the older one its omission
  // made room for.
  assert.equal(newer.omitted, true);
  assert.equal(newer.data, '');
  assert.notEqual(older.omitted, true);
  const second = JSON.stringify(calls[1]?.body.input);
  assert.doesNotMatch(second, /input_image/);
  assert.match(second, /newer\.png/);
});

test('a caller abort mid-stream cancels the request and is not reported as a timeout', async () => {
  const controller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  const { fetch } = fakeFetch((_call, init) => {
    requestSignal = init.signal ?? undefined;
    const [first] = sseBody([{ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Hel' }]);
    return new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(first!);
        // As fetch does: the body fails when the request's signal fires.
        init.signal?.addEventListener('abort', () => stream.error(init.signal?.reason), { once: true });
      },
    }), { status: 200 });
  });
  const provider = createOpenAIResponsesProvider({ model: 'gpt-test', apiKey: 'sk-test', fetch });

  await assert.rejects(
    provider.generate({
      ...sayHello(),
      signal: controller.signal,
      onDelta: () => {
        controller.abort();
      },
    }),
    (error: unknown) => error instanceof Error && !/timed out/.test(error.message),
  );
  assert.equal(requestSignal?.aborted, true);
});

test('a stream that goes quiet is bounded by the request timeout', async () => {
  const { fetch } = fakeFetch((_call, init) => new Response(new ReadableStream<Uint8Array>({
    start(stream) {
      init.signal?.addEventListener('abort', () => stream.error(init.signal?.reason), { once: true });
    },
  }), { status: 200 }));
  const provider = createOpenAIResponsesProvider({ model: 'gpt-test', apiKey: 'sk-test', fetch, requestTimeoutMs: 50 });

  await assert.rejects(provider.generate(sayHello()), /timed out after 50ms/);
});

test('an HTTP error is thrown in the endpoint\'s words with the key redacted', async () => {
  const { fetch } = fakeFetch(() => jsonResponse(401, { error: { message: 'Incorrect API key provided: sk-test-secret.', code: 'invalid_api_key' } }));
  const provider = createOpenAIResponsesProvider({ model: 'gpt-test', apiKey: 'sk-test-secret', fetch });
  await assert.rejects(provider.generate(sayHello()), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Incorrect API key provided/);
    assert.doesNotMatch(error.message, /sk-test-secret/);
    return true;
  });

  const { fetch: gateway } = fakeFetch(() => new Response('Bad gateway', { status: 502 }));
  await assert.rejects(
    createOpenAIResponsesProvider({ model: 'gpt-test', apiKey: 'sk-test', fetch: gateway }).generate(sayHello()),
    /Bad gateway/,
  );
});

test('a transcript past the context window is reported as recoverable', async () => {
  const { fetch } = fakeFetch(() => jsonResponse(400, {
    error: { message: 'Your input exceeds the context window of this model.', type: 'invalid_request_error', code: 'context_length_exceeded' },
  }));
  const provider = createOpenAIResponsesProvider({ model: 'gpt-test', apiKey: 'sk-test', fetch });
  await assert.rejects(provider.generate(sayHello()), ContextOverflowError);

  // The same refusal arriving inside the stream, as a failed response or an
  // error event, by its code only: prose in a stream is not a 400.
  for (const event of [
    terminal('response.failed', { status: 'failed', error: { code: 'context_length_exceeded', message: 'Your input exceeds the context window of this model.' } }),
    { type: 'error', sequence_number: 1, code: 'context_length_exceeded', message: 'Your input exceeds the context window of this model.', param: null },
  ]) {
    const { fetch: streamed } = fakeFetch(() => sseResponse([event]));
    await assert.rejects(
      createOpenAIResponsesProvider({ model: 'gpt-test', apiKey: 'sk-test', fetch: streamed }).generate(sayHello()),
      ContextOverflowError,
    );
  }
});

test('a failed or incomplete response fails the turn and still reports what it cost', async () => {
  const cases: Array<{ events: object[]; error: RegExp; usage: boolean }> = [
    {
      events: [terminal('response.failed', { status: 'failed', error: { code: 'server_error', message: 'The server had an error.' }, usage: USAGE })],
      error: /server_error.*The server had an error\./,
      usage: true,
    },
    {
      events: [
        { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Half a' },
        terminal('response.incomplete', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [outputMessage('Half a')], usage: USAGE }),
      ],
      error: /output cap/,
      usage: true,
    },
    {
      events: [terminal('response.incomplete', { status: 'incomplete', incomplete_details: { reason: 'content_filter' }, usage: USAGE })],
      error: /content_filter/,
      usage: true,
    },
    {
      events: [{ type: 'error', sequence_number: 1, code: 'rate_limit_exceeded', message: 'Rate limit reached.', param: null }],
      error: /rate_limit_exceeded.*Rate limit reached\./,
      usage: false,
    },
    {
      events: [{ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Hel' }],
      error: /stream ended before the response finished/,
      usage: false,
    },
  ];
  for (const { events, error, usage } of cases) {
    const usages: ProviderCallUsage[] = [];
    const { fetch } = fakeFetch(() => sseResponse(events));
    const provider = createOpenAIResponsesProvider({ model: 'gpt-test', apiKey: 'sk-test', fetch });
    await assert.rejects(provider.generate({ ...sayHello(), onUsage: (counted) => { usages.push(counted); } }), error);
    assert.deepEqual(usages, usage ? [EXPECTED_USAGE] : [], String(error));
  }
});

test('a refusal is reported as one, and an empty answer as a failure', async () => {
  const refusal = { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'I can\'t help with that.' }] };
  const { fetch } = fakeFetch(() => sseResponse([terminal('response.completed', { status: 'completed', output: [refusal] })]));
  await assert.rejects(
    createOpenAIResponsesProvider({ model: 'gpt-test', apiKey: 'sk-test', fetch }).generate(sayHello()),
    /refused the request: I can't help with that\./,
  );

  const { fetch: empty } = fakeFetch(() => sseResponse([terminal('response.completed', { status: 'completed', output: [] })]));
  await assert.rejects(
    createOpenAIResponsesProvider({ model: 'gpt-test', apiKey: 'sk-test', fetch: empty }).generate(sayHello()),
    /empty response/,
  );
});
