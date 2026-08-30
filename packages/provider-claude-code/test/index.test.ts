import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  MemoryEntry,
  ProviderCallUsage,
  ProviderRequest,
  Session,
  ToolCall,
  ToolResult,
} from '@stratusagent/core';
import {
  bridgeKernelTools,
  createClaudeCodeProvider,
  DEFAULT_CLAUDE_CODE_MODEL,
  hasHostedToolSideEffects,
  markHostedToolSideEffects,
  SDK_SESSION_METADATA_KEY,
  type ClaudeCodeQueryFn,
  type ClaudeCodeStreamMessage,
} from '../src/index.ts';

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

const createFakeQuery = (messages: ClaudeCodeStreamMessage[]) => {
  const calls: Array<{ prompt: string; options?: Record<string, unknown> }> = [];
  const queryFn: ClaudeCodeQueryFn = (params) => {
    calls.push(params as { prompt: string; options?: Record<string, unknown> });
    return (async function* () {
      for (const message of messages) {
        yield message;
      }
    })();
  };
  return { queryFn, calls };
};

test('generate runs a turn through the Agent SDK and returns the result text', async () => {
  const { queryFn, calls } = createFakeQuery([
    { type: 'system', subtype: 'init' },
    { type: 'assistant' },
    { type: 'result', subtype: 'success', is_error: false, result: 'Hi! Lovely to meet you.' },
  ]);

  const provider = createClaudeCodeProvider({ authToken: 'sk-ant-oat-test', queryFn });
  const memory: MemoryEntry[] = [
    {
      id: 'ava:memory:1',
      agentId: 'ava',
      content: 'The user prefers short answers.',
      createdAt: new Date().toISOString(),
    },
  ];

  const response = await provider.generate({ session: createSession(), memory });
  assert.deepEqual(response.parts, [{ type: 'text', text: 'Hi! Lovely to meet you.' }]);

  const call = calls[0]!;
  assert.equal(call.prompt, 'Hello there');
  const options = call.options as {
    model?: string;
    systemPrompt?: string;
    tools?: string[];
    maxTurns?: number;
    env?: Record<string, string | undefined>;
  };
  assert.equal(options.model, DEFAULT_CLAUDE_CODE_MODEL);
  assert.match(options.systemPrompt ?? '', /You are Ava\. Be warm and concise\./);
  assert.match(options.systemPrompt ?? '', /The user prefers short answers\./);
  // No built-in Claude Code tools, one turn per generate.
  assert.deepEqual(options.tools, []);
  assert.equal(options.maxTurns, 1);
  // Subscription auth is pinned: the setup token is set and any ambient
  // API key is cleared so billing cannot silently fall back to it.
  assert.equal(options.env?.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat-test');
  assert.equal(options.env?.ANTHROPIC_API_KEY, undefined);
});

test('multi-turn sessions are rendered as a transcript', async () => {
  const { queryFn, calls } = createFakeQuery([
    { type: 'result', subtype: 'success', is_error: false, result: 'Continuing!' },
  ]);

  const provider = createClaudeCodeProvider({ queryFn });
  const session = createSession();
  session.messages.push(
    {
      id: 'session-1:assistant:2',
      role: 'assistant',
      content: 'Hi, I am Ava.',
      createdAt: new Date().toISOString(),
    },
    {
      id: 'session-1:user:3',
      role: 'user',
      content: 'What did I just say?',
      createdAt: new Date().toISOString(),
    },
  );

  await provider.generate({ session });

  const prompt = calls[0]!.prompt;
  assert.match(prompt, /Conversation so far:/);
  assert.match(prompt, /\[user\] Hello there/);
  assert.match(prompt, /\[assistant\] Hi, I am Ava\./);
  assert.match(prompt, /\[user\] What did I just say\?/);
  assert.match(prompt, /replying to the latest user message/);
});

test('error results and empty responses surface as errors', async () => {
  const failed = createClaudeCodeProvider({
    queryFn: createFakeQuery([
      { type: 'result', subtype: 'error_max_turns', is_error: true },
    ]).queryFn,
  });
  await assert.rejects(
    () => failed.generate({ session: createSession() }),
    /Claude Code run failed \(error_max_turns\)/,
  );

  const empty = createClaudeCodeProvider({
    queryFn: createFakeQuery([{ type: 'system' }]).queryFn,
  });
  await assert.rejects(
    () => empty.generate({ session: createSession() }),
    /empty response/,
  );
});

test('kernel tools bridge into the loop as an in-process MCP server', async () => {
  const { queryFn, calls } = createFakeQuery([
    { type: 'result', subtype: 'success', is_error: false, result: 'Saved!' },
  ]);

  const executed: ToolCall[] = [];
  const provider = createClaudeCodeProvider({
    queryFn,
    executeTool: async (_session, call) => {
      executed.push(call);
      return { callId: call.id, toolName: call.toolName, ok: true, output: { saved: true } };
    },
  });

  await provider.generate({
    session: createSession(),
    tools: [
      { name: 'memory.remember', description: 'Save a fact.', parameters: { type: 'object', properties: { fact: { type: 'string' } }, required: ['fact'] } },
      { name: 'demo.echo', parameters: { type: 'object', properties: { text: { type: 'string' } } } },
    ],
  });

  const options = calls[0]!.options as {
    tools?: string[];
    maxTurns?: number;
    allowedTools?: string[];
    mcpServers?: Record<string, unknown>;
  };
  // Built-ins stay off; the Stratus server carries the kernel tools, with
  // names flattened to the MCP charset and pre-approved for the loop.
  assert.deepEqual(options.tools, []);
  assert.ok(options.mcpServers?.stratus);
  assert.deepEqual(options.allowedTools, ['mcp__stratus__memory_remember', 'mcp__stratus__demo_echo']);
  // Tool runs need a real loop, not a single turn.
  assert.equal(options.maxTurns, 8);
});

test('bridged tool handlers execute through the host and report failures', async () => {
  const session = createSession();
  const seen: ToolCall[] = [];
  const executeTool = async (forSession: Session, call: ToolCall): Promise<ToolResult> => {
    assert.equal(forSession.id, session.id);
    seen.push(call);
    if (call.toolName === 'demo.echo') {
      return { callId: call.id, toolName: call.toolName, ok: true, output: { uppercase: 'HI' } };
    }
    return { callId: call.id, toolName: call.toolName, ok: false, output: null, error: 'denied by approval policy' };
  };

  const bridged = bridgeKernelTools(
    [
      { name: 'demo.echo', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
      { name: 'memory.remember' },
    ],
    session,
    executeTool,
  );

  assert.deepEqual(bridged.map((tool) => tool.name), ['demo_echo', 'memory_remember']);

  const ok = await bridged[0]!.handler({ text: 'hi' }, {});
  assert.deepEqual(ok.content, [{ type: 'text', text: JSON.stringify({ uppercase: 'HI' }) }]);
  assert.notEqual(ok.isError, true);
  // The kernel sees the original dotted name, not the MCP-flattened one.
  assert.equal(seen[0]?.toolName, 'demo.echo');
  assert.deepEqual(seen[0]?.input, { text: 'hi' });

  const failed = await bridged[1]!.handler({}, {});
  assert.equal(failed.isError, true);
  assert.match(JSON.stringify(failed.content), /denied by approval policy/);
});

test('concurrent bridged tool calls execute one at a time', async () => {
  const session = createSession();
  let inFlight = 0;
  let peak = 0;
  const order: string[] = [];
  const executeTool = async (_session: Session, call: ToolCall): Promise<ToolResult> => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    // Yield so a racing second call would be observable as peak > 1.
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push(call.toolName);
    inFlight -= 1;
    return { callId: call.id, toolName: call.toolName, ok: true, output: null };
  };

  const bridged = bridgeKernelTools(
    [{ name: 'demo.echo' }, { name: 'memory.remember' }],
    session,
    executeTool,
  );

  await Promise.all([
    bridged[0]!.handler({}, {}),
    bridged[1]!.handler({}, {}),
    bridged[0]!.handler({}, {}),
  ]);

  // The kernel contract: tools run one at a time, in arrival order.
  assert.equal(peak, 1);
  assert.deepEqual(order, ['demo.echo', 'memory.remember', 'demo.echo']);
});

test('an explicit maxTurns also governs the bridged loop', async () => {
  const { queryFn, calls } = createFakeQuery([
    { type: 'result', subtype: 'success', is_error: false, result: 'Done.' },
  ]);
  const provider = createClaudeCodeProvider({
    queryFn,
    maxTurns: 2,
    executeTool: async (_session, call) => ({ callId: call.id, toolName: call.toolName, ok: true, output: null }),
  });
  await provider.generate({ session: createSession(), tools: [{ name: 'demo.echo' }] });
  assert.equal((calls[0]!.options as { maxTurns?: number }).maxTurns, 2);
});

test('errors after hosted tool side effects are marked against fallback replay', () => {
  const plain = new Error('failed before any tool ran');
  assert.equal(hasHostedToolSideEffects(plain), false);

  const marked = markHostedToolSideEffects(new Error('failed after memory.remember ran'));
  assert.equal(hasHostedToolSideEffects(marked), true);
  // Non-object errors pass through unharmed.
  assert.equal(hasHostedToolSideEffects(markHostedToolSideEffects('string error')), false);
});

test('without an executor the runtime stays text-only', async () => {
  const { queryFn, calls } = createFakeQuery([
    { type: 'result', subtype: 'success', is_error: false, result: 'Hi.' },
  ]);
  const provider = createClaudeCodeProvider({ queryFn });
  await provider.generate({
    session: createSession(),
    tools: [{ name: 'demo.echo' }],
  });
  const options = calls[0]!.options as { mcpServers?: unknown; maxTurns?: number };
  assert.equal(options.mcpServers, undefined);
  assert.equal(options.maxTurns, 1);
});

test('a missing Claude Code executable produces install guidance', async () => {
  const queryFn: ClaudeCodeQueryFn = () => {
    const error = new Error('spawn claude ENOENT') as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    throw error;
  };

  const provider = createClaudeCodeProvider({ queryFn });
  await assert.rejects(
    () => provider.generate({ session: createSession() }),
    /Install it \(npm install -g @anthropic-ai\/claude-code\)/,
  );
});

test('a wedged SDK stream is aborted after the idle timeout', async () => {
  // The query never yields a message; the idle timer must abort the SDK's
  // controller and surface the stall as a provider failure, not hang the
  // turn until the daemon is killed.
  const provider = createClaudeCodeProvider({
    idleTimeoutMs: 50,
    queryFn: ({ options }) => ({
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise((_resolve, reject) => {
              const keepAlive = setTimeout(() => {}, 60_000);
              options?.abortController?.signal.addEventListener(
                'abort',
                () => {
                  clearTimeout(keepAlive);
                  reject(new DOMException('aborted', 'AbortError'));
                },
                { once: true },
              );
            }),
        };
      },
    }),
  });

  await assert.rejects(
    () => provider.generate({ session: createSession() } as never),
    /no output for 50ms/,
  );
});


test('the idle timer suspends across hosted tool waits and its abort reaches hosted work', async () => {
  // A hosted tool (or approval wait) longer than the idle timeout is
  // legitimate silence: the timer must suspend around it and resume
  // guarding the stream afterwards. And the signal handed to hosted work
  // is the provider's own controller — the union of caller aborts and the
  // idle timeout — so a stalled query can never leave a hosted operation
  // running behind it.
  const toolSignals: Array<AbortSignal | undefined> = [];
  const provider = createClaudeCodeProvider({
    idleTimeoutMs: 60,
    executeTool: async (_session, call, context) => {
      toolSignals.push(context?.signal);
      // 3x the idle timeout — survives only if the timer suspended.
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { callId: call.id, toolName: call.toolName, ok: true, output: { echoed: true } };
    },
    queryFn: ({ options }) => (async function* () {
      const servers = options?.mcpServers as
        | Record<string, { instance?: { _registeredTools?: Record<string, { handler: (a: unknown, b: unknown) => Promise<unknown> }> } }>
        | undefined;
      const handler = servers?.stratus?.instance?._registeredTools?.demo_echo?.handler;
      assert.ok(handler, 'the bridged tool must be registered on the MCP server');
      // Simulate the SDK executing the hosted tool mid-turn.
      await handler({}, {});
      yield { type: 'result', subtype: 'success', result: 'survived the slow tool' } as never;
    })(),
  });

  const response = await provider.generate({
    session: createSession(),
    tools: [{ name: 'demo.echo', parameters: { type: 'object', properties: {} } }],
  } as never);

  assert.equal((response.parts[0] as { text: string }).text, 'survived the slow tool');
  const signal = toolSignals[0];
  assert.ok(signal, 'hosted tools must receive the abort signal even without a caller signal');
  assert.equal(signal.aborted, false, 'the idle timer must not fire during a hosted tool wait');
});

test('transcripts replay hosted tool calls alongside their results', async () => {
  // The next query must see what was asked, not just what came back — a
  // memory id without the remembered fact is half the history.
  const prompts: string[] = [];
  const provider = createClaudeCodeProvider({
    queryFn: ({ prompt }) => {
      prompts.push(prompt);
      return (async function* () {
        yield { type: 'result', subtype: 'success', result: 'ok' } as never;
      })();
    },
  });

  const now = new Date().toISOString();
  await provider.generate({
    session: createSession({
      messages: [
        { id: 'u1', role: 'user', content: 'remember that I like tea', createdAt: now },
        {
          id: 'a1',
          role: 'assistant',
          content: '',
          createdAt: now,
          toolCalls: [{ id: 'c1', toolName: 'memory.remember', input: { fact: 'likes tea' } }],
        },
        {
          id: 't1',
          role: 'tool',
          name: 'memory.remember',
          content: '{"ok":true}',
          createdAt: now,
          toolResult: { callId: 'c1', toolName: 'memory.remember', ok: true, output: { id: 'mem-1' } },
        },
        { id: 'u2', role: 'user', content: 'what do I like?', createdAt: now },
      ],
    }),
  } as never);

  const prompt = prompts[0] ?? '';
  assert.match(prompt, /assistant called tool memory\.remember/);
  assert.match(prompt, /likes tea/);
  // The empty runner message that carried the call renders nothing extra.
  assert.doesNotMatch(prompt, /\[assistant\] \n/);
});

test('the first turn records the SDK session id, and the next one resumes it', async () => {
  const { queryFn, calls } = createFakeQuery([
    { type: 'system', subtype: 'init', session_id: 'sdk-abc' },
    { type: 'result', subtype: 'success', is_error: false, result: 'Hi.', session_id: 'sdk-abc' },
  ]);
  const provider = createClaudeCodeProvider({ authToken: 'sk-ant-oat-test', queryFn });

  const session = createSession();
  await provider.generate({ session, memory: [] });

  // Captured without a handshake: the id rides on every message.
  assert.equal(session.metadata?.[SDK_SESSION_METADATA_KEY], 'sdk-abc');
  assert.equal((calls[0]!.options as { resume?: string }).resume, undefined);
  assert.equal(calls[0]!.prompt, 'Hello there');

  // The next turn continues that SDK session instead of re-sending the
  // conversation: the SDK is already holding everything before this
  // message, so replaying it would both cost more and leave the SDK no
  // state of its own between turns.
  session.messages.push(
    { id: 'session-1:assistant:2', role: 'assistant', content: 'Hi.', createdAt: new Date().toISOString() },
    { id: 'session-1:user:3', role: 'user', content: 'And now?', createdAt: new Date().toISOString() },
  );
  await provider.generate({ session, memory: [] });

  assert.equal((calls[1]!.options as { resume?: string }).resume, 'sdk-abc');
  assert.equal(calls[1]!.prompt, 'And now?');
  assert.doesNotMatch(calls[1]!.prompt, /Conversation so far:/);
});

test('an SDK session that no longer exists replays history into a fresh one', async () => {
  const attempts: Array<{ resume: string | undefined; prompt: string }> = [];
  const queryFn: ClaudeCodeQueryFn = (params) => {
    const resume = (params.options as { resume?: string }).resume;
    attempts.push({ resume, prompt: params.prompt });
    return (async function* (): AsyncGenerator<ClaudeCodeStreamMessage> {
      if (resume) {
        throw new Error(`No conversation found with session ID: ${resume}`);
      }
      yield { type: 'result', subtype: 'success', is_error: false, result: 'Recovered.', session_id: 'sdk-new' };
    })();
  };

  const failures: unknown[] = [];
  const provider = createClaudeCodeProvider({
    authToken: 'sk-ant-oat-test',
    queryFn,
    onResumeFailed: (error) => failures.push(error),
  });

  const session = createSession({ metadata: { [SDK_SESSION_METADATA_KEY]: 'sdk-gone' } });
  session.messages.push(
    { id: 'session-1:assistant:2', role: 'assistant', content: 'Hi.', createdAt: new Date().toISOString() },
    { id: 'session-1:user:3', role: 'user', content: 'Still there?', createdAt: new Date().toISOString() },
  );

  const response = await provider.generate({ session, memory: [] });

  assert.deepEqual(response.parts, [{ type: 'text', text: 'Recovered.' }]);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]?.resume, 'sdk-gone');
  // The replay carries the whole conversation, not just the latest turn —
  // the fresh SDK session knows nothing.
  assert.equal(attempts[1]?.resume, undefined);
  assert.match(attempts[1]?.prompt ?? '', /Conversation so far:/);
  assert.equal(failures.length, 1);
  // And the session now points at the session that answered.
  assert.equal(session.metadata?.[SDK_SESSION_METADATA_KEY], 'sdk-new');
});

test('a failed resume is not replayed once a hosted tool has run', async () => {
  // Replaying would execute the tool a second time. Its side effects are
  // real and already recorded, so a costlier turn is not the trade — a
  // duplicated action is.
  const attempts: Array<string | undefined> = [];
  const executed: string[] = [];
  const queryFn: ClaudeCodeQueryFn = (params) => {
    const options = params.options as {
      resume?: string;
      mcpServers?: Record<string, { instance?: { _registeredTools?: Record<string, { handler: (a: unknown, b: unknown) => Promise<unknown> }> } }>;
    };
    attempts.push(options.resume);
    return (async function* (): AsyncGenerator<ClaudeCodeStreamMessage> {
      const handler = options.mcpServers?.stratus?.instance?._registeredTools?.demo_echo?.handler;
      assert.ok(handler, 'the tool must be bridged');
      await handler({}, {});
      throw new Error('No conversation found with session ID: sdk-gone');
    })();
  };

  const provider = createClaudeCodeProvider({
    authToken: 'sk-ant-oat-test',
    queryFn,
    executeTool: async (_session, call) => {
      executed.push(call.toolName);
      return { callId: call.id, toolName: call.toolName, ok: true, output: { ok: true } };
    },
  });

  const session = createSession({ metadata: { [SDK_SESSION_METADATA_KEY]: 'sdk-gone' } });
  await assert.rejects(() => provider.generate({
    session,
    memory: [],
    tools: [{ name: 'demo.echo', description: 'echo', parameters: { type: 'object', properties: {} } }],
  }));

  assert.deepEqual(attempts, ['sdk-gone'], 'the turn must not be replayed after a tool ran');
  assert.deepEqual(executed, ['demo.echo']);
});

test('SDK partial messages become kernel deltas, in the kernel\'s own tool naming', async () => {
  const { queryFn, calls } = createFakeQuery([
    { type: 'system', subtype: 'init', session_id: 'sdk-1' },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta' } } },
    // The SDK names the tool the way MCP does; consumers are the kernel's.
    { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'mcp__stratus__demo_echo' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"a":' } } },
    { type: 'result', subtype: 'success', is_error: false, result: 'Hello.', session_id: 'sdk-1' },
  ]);

  const deltas: unknown[] = [];
  const provider = createClaudeCodeProvider({
    authToken: 'sk-ant-oat-test',
    queryFn,
    executeTool: async (_session, call) => ({ callId: call.id, toolName: call.toolName, ok: true, output: {} }),
  });

  await provider.generate({
    session: createSession(),
    memory: [],
    tools: [{ name: 'demo.echo', description: 'echo', parameters: { type: 'object', properties: {} } }],
    onDelta: (delta) => {
      deltas.push(delta);
    },
  });

  assert.deepEqual(deltas, [
    { type: 'text', text: 'Hel' },
    { type: 'thinking' },
    { type: 'tool-call', toolName: 'demo.echo' },
    { type: 'tool-call', toolName: 'demo.echo', inputFragment: '{"a":' },
  ]);

  // Partial messages are only requested when someone is listening.
  assert.equal((calls[0]!.options as { includePartialMessages?: boolean }).includePartialMessages, true);
});

test('partial messages are not requested when nothing consumes them', async () => {
  const { queryFn, calls } = createFakeQuery([
    { type: 'result', subtype: 'success', is_error: false, result: 'Hi.', session_id: 'sdk-1' },
  ]);
  const provider = createClaudeCodeProvider({ authToken: 'sk-ant-oat-test', queryFn });

  await provider.generate({ session: createSession(), memory: [] });

  assert.equal((calls[0]!.options as { includePartialMessages?: boolean }).includePartialMessages, undefined);
});

test('a failed resume discards its streamed fragments before replaying', async () => {
  // The abandoned attempt may already have streamed text, and the replay
  // is a different answer to the same question. Without a reset an
  // aggregator concatenates them into one garbled reply — which is the
  // exact case the reset delta exists for.
  const queryFn: ClaudeCodeQueryFn = (params) => {
    const resume = (params.options as { resume?: string }).resume;
    return (async function* (): AsyncGenerator<ClaudeCodeStreamMessage> {
      if (resume) {
        yield { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'stale half-' } } };
        throw new Error(`No conversation found with session ID: ${resume}`);
      }
      yield { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fresh answer' } } };
      yield { type: 'result', subtype: 'success', is_error: false, result: 'fresh answer', session_id: 'sdk-new' };
    })();
  };

  const deltas: unknown[] = [];
  const provider = createClaudeCodeProvider({ authToken: 'sk-ant-oat-test', queryFn });

  await provider.generate({
    session: createSession({ metadata: { [SDK_SESSION_METADATA_KEY]: 'sdk-gone' } }),
    memory: [],
    onDelta: (delta) => {
      deltas.push(delta);
    },
  });

  assert.deepEqual(deltas, [
    { type: 'text', text: 'stale half-' },
    // `retry`, not `fallback`: the same provider is starting over, and a
    // consumer tracking which provider serves the turn must see that.
    { type: 'reset', reason: 'retry' },
    { type: 'text', text: 'fresh answer' },
  ]);
});

test('a slow delta consumer is not counted as SDK silence', async () => {
  // The sink is awaited per fragment on purpose — that is the backpressure
  // contract. Counting the wait as provider idleness would abort a healthy
  // query for honouring it.
  const IDLE_MS = 60;
  // The fake honours the controller the provider hands it, as a real query
  // does — otherwise an abort has no visible effect and this test would
  // pass whether the timer fired or not.
  const queryFn: ClaudeCodeQueryFn = (params) => {
    const signal = (params.options as { abortController?: AbortController }).abortController?.signal;
    return (async function* (): AsyncGenerator<ClaudeCodeStreamMessage> {
      for (const message of [
        { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'one' } } },
        { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'two' } } },
        { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'sdk-1' },
      ] as ClaudeCodeStreamMessage[]) {
        if (signal?.aborted) {
          throw new Error('aborted');
        }
        yield message;
      }
    })();
  };

  const provider = createClaudeCodeProvider({
    authToken: 'sk-ant-oat-test',
    queryFn,
    idleTimeoutMs: IDLE_MS,
  });

  const response = await provider.generate({
    session: createSession(),
    memory: [],
    // A throttled channel edit, slower than the idle timeout.
    onDelta: async () => {
      await new Promise((resolve) => setTimeout(resolve, IDLE_MS * 2));
    },
  });

  assert.deepEqual(response.parts, [{ type: 'text', text: 'done' }]);
});

test('a slow consumer of the retry reset does not abort the replay', async () => {
  // The reset uses the same awaited-sink contract as every other delta, so
  // it needs the same treatment: billing the consumer's time to the SDK
  // would turn a recoverable resume failure into an idle timeout before
  // the replacement attempt even starts.
  const IDLE_MS = 60;
  const attempts: Array<string | undefined> = [];
  const queryFn: ClaudeCodeQueryFn = (params) => {
    const options = params.options as { resume?: string; abortController?: AbortController };
    attempts.push(options.resume);
    return (async function* (): AsyncGenerator<ClaudeCodeStreamMessage> {
      if (options.abortController?.signal.aborted) {
        throw new Error('aborted');
      }
      yield { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } } };
      if (options.resume) {
        throw new Error(`No conversation found with session ID: ${options.resume}`);
      }
      yield { type: 'result', subtype: 'success', is_error: false, result: 'replayed', session_id: 'sdk-new' };
    })();
  };

  const provider = createClaudeCodeProvider({
    authToken: 'sk-ant-oat-test',
    queryFn,
    idleTimeoutMs: IDLE_MS,
  });

  const response = await provider.generate({
    session: createSession({ metadata: { [SDK_SESSION_METADATA_KEY]: 'sdk-gone' } }),
    memory: [],
    // Slower than the idle timeout, on every delta including the reset.
    onDelta: async () => {
      await new Promise((resolve) => setTimeout(resolve, IDLE_MS * 2));
    },
  });

  assert.deepEqual(attempts, ['sdk-gone', undefined], 'the replay must have run');
  assert.deepEqual(response.parts, [{ type: 'text', text: 'replayed' }]);
});

test('a turn reports each model the inner loop used, separately', async () => {
  // Three model calls against two models inside one Stratus turn — the case
  // that cannot ride on the response, because only the last of them would
  // ever cross the provider interface.
  const { queryFn } = createFakeQuery([
    { type: 'assistant' },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Done.',
      modelUsage: {
        'claude-opus-5': {
          inputTokens: 300,
          outputTokens: 120,
          cacheReadInputTokens: 9000,
          cacheCreationInputTokens: 400,
        },
        'claude-haiku-4-5': { inputTokens: 50, outputTokens: 10 },
      },
    },
  ]);

  const reported: ProviderCallUsage[] = [];
  const provider = createClaudeCodeProvider({ authToken: 'sk-ant-oat-test', queryFn });
  await provider.generate({
    session: createSession(),
    onUsage: (usage) => reported.push(usage),
  } as ProviderRequest);

  assert.deepEqual(reported, [
    {
      provider: 'claude-code',
      model: 'claude-opus-5',
      inputTokens: 300,
      outputTokens: 120,
      cacheReadTokens: 9000,
      cacheWriteTokens: 400,
    },
    { provider: 'claude-code', model: 'claude-haiku-4-5', inputTokens: 50, outputTokens: 10 },
  ]);
});

test('a run that fails still reports what it spent before it broke', async () => {
  const { queryFn } = createFakeQuery([
    {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'boom',
      modelUsage: { 'claude-opus-5': { inputTokens: 90, outputTokens: 4 } },
    },
  ]);

  const reported: ProviderCallUsage[] = [];
  const provider = createClaudeCodeProvider({ authToken: 'sk-ant-oat-test', queryFn });

  await assert.rejects(
    provider.generate({
      session: createSession(),
      onUsage: (usage) => reported.push(usage),
    } as ProviderRequest),
    /Claude Code run failed/,
  );

  // A failed call returns no response to carry a count, and the tokens were
  // spent regardless. Losing them makes the total unreconcilable against
  // Anthropic's own reporting, which is the only external check it has.
  assert.deepEqual(reported, [{ provider: 'claude-code', model: 'claude-opus-5', inputTokens: 90, outputTokens: 4 }]);
});

test('a failed resume reports the abandoned attempt and the replay separately', async () => {
  const queryFn: ClaudeCodeQueryFn = (params) => {
    const resume = (params.options as { resume?: string }).resume;
    return (async function* (): AsyncGenerator<ClaudeCodeStreamMessage> {
      if (resume) {
        yield {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          modelUsage: { 'claude-opus-5': { inputTokens: 15 } },
        };
        return;
      }
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Recovered.',
        session_id: 'sdk-new',
        modelUsage: { 'claude-opus-5': { inputTokens: 700, outputTokens: 30 } },
      };
    })();
  };

  const reported: ProviderCallUsage[] = [];
  const provider = createClaudeCodeProvider({ authToken: 'sk-ant-oat-test', queryFn });
  await provider.generate({
    session: createSession({ metadata: { [SDK_SESSION_METADATA_KEY]: 'sdk-gone' } }),
    onUsage: (usage) => reported.push(usage),
  } as ProviderRequest);

  // Two records, not one: the replay is a second, more expensive call, and
  // the attempt it replaced still cost what it cost.
  assert.deepEqual(reported, [
    { provider: 'claude-code', model: 'claude-opus-5', inputTokens: 15 },
    { provider: 'claude-code', model: 'claude-opus-5', inputTokens: 700, outputTokens: 30 },
  ]);
});

test('a zeroed modelUsage row is dropped rather than recorded as a free call', async () => {
  // The SDK zeroes modelUsage on a crash-or-startup-error result. A model
  // that truly consumed nothing never ran, so the row is a placeholder — and
  // recording it would state a cost of zero for a call nobody can see.
  const { queryFn } = createFakeQuery([
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Done.',
      modelUsage: {
        'claude-opus-5': { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        'claude-haiku-4-5': { inputTokens: 0, outputTokens: 7 },
      },
    },
  ]);

  const reported: ProviderCallUsage[] = [];
  const provider = createClaudeCodeProvider({ authToken: 'sk-ant-oat-test', queryFn });
  await provider.generate({
    session: createSession(),
    onUsage: (usage) => reported.push(usage),
  } as ProviderRequest);

  assert.deepEqual(reported, [
    { provider: 'claude-code', model: 'claude-haiku-4-5', inputTokens: 0, outputTokens: 7 },
  ]);
});

test('a run whose result carries no modelUsage reports nothing', async () => {
  const { queryFn } = createFakeQuery([
    { type: 'result', subtype: 'success', is_error: false, result: 'Done.' },
  ]);

  const reported: ProviderCallUsage[] = [];
  const provider = createClaudeCodeProvider({ authToken: 'sk-ant-oat-test', queryFn });
  const response = await provider.generate({
    session: createSession(),
    onUsage: (usage) => reported.push(usage),
  } as ProviderRequest);

  assert.deepEqual(reported, []);
  assert.equal(response.usage, undefined);
});
