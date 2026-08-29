import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MemoryEntry, ProviderRequest, Session, ToolCall, ToolResult } from '@stratusagent/core';
import { hasHostedToolSideEffects } from '@stratusagent/providers';
import {
  CODEX_THREAD_METADATA_KEY,
  createCodexProvider,
  DEFAULT_CODEX_MODEL,
  MCP_TOKEN_ENV_VAR,
  startKernelMcpServer,
  type CodexThreadEvent,
  type CodexTurnParams,
  type CodexRunTurn,
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

const createFakeRunTurn = (events: CodexThreadEvent[]) => {
  const calls: CodexTurnParams[] = [];
  const runTurn: CodexRunTurn = (params) => {
    calls.push(params);
    return (async function* () {
      for (const event of events) {
        yield event;
      }
    })();
  };
  return { runTurn, calls };
};

const successEvents = (text: string, threadId = 'thread-1'): CodexThreadEvent[] => [
  { type: 'thread.started', thread_id: threadId },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text } },
  { type: 'turn.completed' },
];

interface CapturedConfig {
  features?: Record<string, boolean>;
  web_search?: string;
  tools?: { update_plan?: { enabled?: boolean } };
  project_doc_max_bytes?: number;
  developer_instructions?: string;
  mcp_servers?: Record<string, { url: string; bearer_token_env_var: string; required?: boolean }>;
}

test('generate runs a turn through the Codex SDK and returns the reply text', async () => {
  const { runTurn, calls } = createFakeRunTurn(successEvents('Hi! Lovely to meet you.'));
  const provider = createCodexProvider({ runTurn });
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
  assert.equal(call.input, 'Hello there');
  assert.equal(call.threadOptions.model, DEFAULT_CODEX_MODEL);
  const config = call.clientOptions.config as CapturedConfig;
  assert.match(config.developer_instructions ?? '', /You are Ava\. Be warm and concise\./);
  assert.match(config.developer_instructions ?? '', /The user prefers short answers\./);
});

test('the harness posture is pinned: no native tools, read-only sandbox, no repo instructions', async () => {
  const { runTurn, calls } = createFakeRunTurn(successEvents('ok'));
  await createCodexProvider({ runTurn }).generate({ session: createSession() });

  const call = calls[0]!;
  // Stratus owns the tool surface: codex's shell (and with it file edits),
  // web search, image reads, plan/sleep tools, and hooks are all off.
  const config = call.clientOptions.config as CapturedConfig;
  assert.deepEqual(config.features, { shell_tool: false, view_image: false, sleep_tool: false, hooks: false });
  assert.equal(config.web_search, 'disabled');
  assert.equal(config.tools?.update_plan?.enabled, false);
  // Repository content is not agent instructions.
  assert.equal(config.project_doc_max_bytes, 0);
  // Belt and braces under the disabled tools.
  assert.equal(call.threadOptions.sandboxMode, 'read-only');
  assert.equal(call.threadOptions.approvalPolicy, 'never');
  assert.equal(call.threadOptions.skipGitRepoCheck, true);
  // Text-only run: no MCP endpoint is opened.
  assert.equal(config.mcp_servers, undefined);
});

test('subscription billing is pinned: an ambient CODEX_API_KEY never leaks into the run', async (t) => {
  process.env.CODEX_API_KEY = 'sk-ambient';
  t.after(() => {
    delete process.env.CODEX_API_KEY;
  });

  const subscription = createFakeRunTurn(successEvents('ok'));
  await createCodexProvider({ runTurn: subscription.runTurn }).generate({ session: createSession() });
  assert.equal(subscription.calls[0]!.clientOptions.apiKey, undefined);
  assert.equal(subscription.calls[0]!.clientOptions.env.CODEX_API_KEY, undefined);

  const metered = createFakeRunTurn(successEvents('ok'));
  await createCodexProvider({ apiKey: 'sk-configured', runTurn: metered.runTurn }).generate({ session: createSession() });
  assert.equal(metered.calls[0]!.clientOptions.apiKey, 'sk-configured');
});

test('multi-turn sessions are rendered as a transcript for a fresh thread', async () => {
  const { runTurn, calls } = createFakeRunTurn(successEvents('Continuing!'));
  const provider = createCodexProvider({ runTurn });
  const session = createSession();
  session.messages.push(
    { id: 'session-1:assistant:2', role: 'assistant', content: 'Hi, I am Ava.', createdAt: new Date().toISOString() },
    { id: 'session-1:user:3', role: 'user', content: 'What did I just say?', createdAt: new Date().toISOString() },
  );

  await provider.generate({ session });

  const input = calls[0]!.input;
  assert.match(input, /Conversation so far:/);
  assert.match(input, /\[user\] Hello there/);
  assert.match(input, /\[assistant\] Hi, I am Ava\./);
  assert.match(input, /replying to the latest user message/);
});

test('failed turns and empty responses surface as errors', async () => {
  const failed = createCodexProvider({
    runTurn: createFakeRunTurn([
      { type: 'thread.started', thread_id: 't1' },
      { type: 'turn.failed', error: { message: 'stream disconnected' } },
    ]).runTurn,
  });
  await assert.rejects(() => failed.generate({ session: createSession() }), /Codex run failed: stream disconnected/);

  const empty = createCodexProvider({
    runTurn: createFakeRunTurn([{ type: 'thread.started', thread_id: 't1' }, { type: 'turn.completed' }]).runTurn,
  });
  await assert.rejects(() => empty.generate({ session: createSession() }), /empty response/);
});

test('a signed-out codex maps to sign-in guidance', async () => {
  const provider = createCodexProvider({
    runTurn: () => {
      throw new Error('Codex Exec exited with code 1: Not logged in. Run codex login.');
    },
  });
  await assert.rejects(
    () => provider.generate({ session: createSession() }),
    /Run `codex login`, or add an OpenAI API key with `stratus setup`/,
  );
});

test('kernel tools are served over a loopback MCP endpoint the codex process can call', async () => {
  const executed: ToolCall[] = [];
  // The fake plays the codex subprocess: it reads the endpoint and token
  // exactly where codex would (the config block and its own environment)
  // and drives a real tools/call over HTTP mid-turn.
  const runTurn: CodexRunTurn = (params) => (async function* () {
    const config = params.clientOptions.config as CapturedConfig;
    const server = config.mcp_servers?.stratus;
    assert.ok(server, 'the MCP endpoint must be configured');
    assert.equal(server.bearer_token_env_var, MCP_TOKEN_ENV_VAR);
    assert.equal(server.required, true);
    const token = params.clientOptions.env[MCP_TOKEN_ENV_VAR];
    assert.ok(token, 'the bearer token must ride in the subprocess environment');

    const listResponse = await fetch(server.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const listing = await listResponse.json() as { result: { tools: Array<{ name: string }> } };
    assert.deepEqual(listing.result.tools.map((tool) => tool.name), ['memory_remember', 'demo_echo']);

    yield { type: 'thread.started', thread_id: 't1' } as CodexThreadEvent;
    yield { type: 'item.started', item: { id: 'call-1', type: 'mcp_tool_call', server: 'stratus', tool: 'memory_remember' } } as CodexThreadEvent;

    const callResponse = await fetch(server.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'memory_remember', arguments: { fact: 'likes tea' } },
      }),
    });
    const result = await callResponse.json() as { result: { content: Array<{ text: string }>; isError?: boolean } };
    assert.notEqual(result.result.isError, true);
    assert.match(result.result.content[0]!.text, /"saved":true/);

    yield { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'Saved!' } } as CodexThreadEvent;
    yield { type: 'turn.completed' } as CodexThreadEvent;
  })();

  const provider = createCodexProvider({
    runTurn,
    executeTool: async (_session, call) => {
      executed.push(call);
      return { callId: call.id, toolName: call.toolName, ok: true, output: { saved: true } };
    },
  });

  const deltas: unknown[] = [];
  const response = await provider.generate({
    session: createSession(),
    tools: [
      { name: 'memory.remember', description: 'Save a fact.', parameters: { type: 'object', properties: { fact: { type: 'string' } }, required: ['fact'] } },
      { name: 'demo.echo' },
    ],
    onDelta: (delta) => {
      deltas.push(delta);
    },
  });

  assert.deepEqual(response.parts, [{ type: 'text', text: 'Saved!' }]);
  // The kernel sees the original dotted name, not the MCP-flattened one —
  // in the executed call and in the streamed delta alike.
  assert.equal(executed[0]?.toolName, 'memory.remember');
  assert.deepEqual(executed[0]?.input, { fact: 'likes tea' });
  assert.deepEqual(deltas, [
    { type: 'tool-call', toolName: 'memory.remember' },
    { type: 'text', text: 'Saved!' },
  ]);
});

test('maxTurns bounds the inner loop: calls past the budget are refused, not executed', async () => {
  // Codex has no native turn cap, so the kernel's limit is enforced at the
  // tool endpoint — a call past the budget comes back as a tool error with
  // nothing executed, and the loop finishes with what it has.
  const executed: string[] = [];
  const runTurn: CodexRunTurn = (params) => (async function* (): AsyncGenerator<CodexThreadEvent> {
    const config = params.clientOptions.config as CapturedConfig;
    const server = config.mcp_servers?.stratus;
    assert.ok(server);
    const call = async (id: number) => {
      const response = await fetch(server.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${params.clientOptions.env[MCP_TOKEN_ENV_VAR]}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'demo_echo', arguments: {} } }),
      });
      return (await response.json() as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
    };
    const first = await call(1);
    assert.notEqual(first.isError, true, 'the first call is inside the budget');
    const second = await call(2);
    assert.equal(second.isError, true, 'the second call must be refused');
    assert.match(second.content[0]!.text, /Turn budget exhausted/);
    yield { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'stopping here' } };
    yield { type: 'turn.completed' };
  })();

  const response = await createCodexProvider({
    runTurn,
    maxTurns: 1,
    executeTool: async (_session, call) => {
      executed.push(call.toolName);
      return { callId: call.id, toolName: call.toolName, ok: true, output: null };
    },
  }).generate({ session: createSession(), tools: [{ name: 'demo.echo' }] });

  assert.deepEqual(executed, ['demo.echo'], 'only the budgeted call may execute');
  assert.deepEqual(response.parts, [{ type: 'text', text: 'stopping here' }]);
});

test('without an executor the runtime stays text-only', async () => {
  const { runTurn, calls } = createFakeRunTurn(successEvents('Hi.'));
  await createCodexProvider({ runTurn }).generate({
    session: createSession(),
    tools: [{ name: 'demo.echo' }],
  });
  assert.equal((calls[0]!.clientOptions.config as CapturedConfig).mcp_servers, undefined);
  assert.equal(calls[0]!.clientOptions.env[MCP_TOKEN_ENV_VAR], undefined);
});

test('the first turn records the codex thread id, and the next one resumes it', async () => {
  const { runTurn, calls } = createFakeRunTurn(successEvents('Hi.', 'thread-abc'));
  const provider = createCodexProvider({ runTurn });

  const session = createSession();
  await provider.generate({ session });
  assert.equal(session.metadata?.[CODEX_THREAD_METADATA_KEY], 'thread-abc');
  assert.equal(calls[0]!.resumeThreadId, undefined);

  session.messages.push(
    { id: 'session-1:assistant:2', role: 'assistant', content: 'Hi.', createdAt: new Date().toISOString() },
    { id: 'session-1:user:3', role: 'user', content: 'And now?', createdAt: new Date().toISOString() },
  );
  await provider.generate({ session });

  // The resumed thread already holds everything before this message.
  assert.equal(calls[1]!.resumeThreadId, 'thread-abc');
  assert.equal(calls[1]!.input, 'And now?');
});

test('a thread codex no longer has replays history into a fresh one', async () => {
  const attempts: Array<{ resume: string | undefined; input: string }> = [];
  const runTurn: CodexRunTurn = (params) => {
    attempts.push({ resume: params.resumeThreadId, input: params.input });
    return (async function* (): AsyncGenerator<CodexThreadEvent> {
      if (params.resumeThreadId) {
        throw new Error(`no rollout found for thread ${params.resumeThreadId}`);
      }
      for (const event of successEvents('Recovered.', 'thread-new')) {
        yield event;
      }
    })();
  };

  const failures: unknown[] = [];
  const deltas: unknown[] = [];
  const provider = createCodexProvider({ runTurn, onResumeFailed: (error) => failures.push(error) });
  const session = createSession({ metadata: { [CODEX_THREAD_METADATA_KEY]: 'thread-gone' } });
  session.messages.push(
    { id: 'session-1:assistant:2', role: 'assistant', content: 'Hi.', createdAt: new Date().toISOString() },
    { id: 'session-1:user:3', role: 'user', content: 'Still there?', createdAt: new Date().toISOString() },
  );

  const response = await provider.generate({
    session,
    onDelta: (delta) => {
      deltas.push(delta);
    },
  });

  assert.deepEqual(response.parts, [{ type: 'text', text: 'Recovered.' }]);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]?.resume, 'thread-gone');
  // The replay carries the whole conversation — the fresh thread knows nothing.
  assert.equal(attempts[1]?.resume, undefined);
  assert.match(attempts[1]?.input ?? '', /Conversation so far:/);
  assert.equal(failures.length, 1);
  // The reset precedes the replay so no consumer fuses the two attempts.
  assert.deepEqual(deltas[0], { type: 'reset', reason: 'retry' });
  assert.equal(session.metadata?.[CODEX_THREAD_METADATA_KEY], 'thread-new');
});

test('a failed resume is not replayed once a hosted tool has run', async () => {
  const attempts: Array<string | undefined> = [];
  const executed: string[] = [];
  const runTurn: CodexRunTurn = (params) => {
    attempts.push(params.resumeThreadId);
    return (async function* (): AsyncGenerator<CodexThreadEvent> {
      const config = params.clientOptions.config as CapturedConfig;
      const server = config.mcp_servers?.stratus;
      assert.ok(server, 'the tool must be bridged');
      await fetch(server.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${params.clientOptions.env[MCP_TOKEN_ENV_VAR]}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'demo_echo', arguments: {} } }),
      });
      throw new Error('no rollout found for thread thread-gone');
      yield { type: 'turn.completed' } as CodexThreadEvent;
    })();
  };

  const provider = createCodexProvider({
    runTurn,
    executeTool: async (_session, call) => {
      executed.push(call.toolName);
      return { callId: call.id, toolName: call.toolName, ok: true, output: { ok: true } };
    },
  });

  const session = createSession({ metadata: { [CODEX_THREAD_METADATA_KEY]: 'thread-gone' } });
  await assert.rejects(() => provider.generate({
    session,
    tools: [{ name: 'demo.echo', description: 'echo', parameters: { type: 'object', properties: {} } }],
  }));

  assert.deepEqual(attempts, ['thread-gone'], 'the turn must not be replayed after a tool ran');
  assert.deepEqual(executed, ['demo.echo']);
});

test('errors after hosted tool runs carry the side-effect mark the fallback wrapper honors', async () => {
  const runTurn: CodexRunTurn = (params) => (async function* (): AsyncGenerator<CodexThreadEvent> {
    const config = params.clientOptions.config as CapturedConfig;
    const server = config.mcp_servers?.stratus;
    assert.ok(server);
    await fetch(server.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${params.clientOptions.env[MCP_TOKEN_ENV_VAR]}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'demo_echo', arguments: {} } }),
    });
    throw new Error('stream disconnected after the tool ran');
    yield { type: 'turn.completed' } as CodexThreadEvent;
  })();

  const provider = createCodexProvider({
    runTurn,
    executeTool: async (_session, call) => ({ callId: call.id, toolName: call.toolName, ok: true, output: null }),
  });

  await assert.rejects(
    () => provider.generate({ session: createSession(), tools: [{ name: 'demo.echo' }] }),
    (error: unknown) => {
      assert.equal(hasHostedToolSideEffects(error), true);
      return true;
    },
  );
});

test('agent message snapshots stream as suffix deltas, reasoning as content-free progress', async () => {
  const { runTurn } = createFakeRunTurn([
    { type: 'thread.started', thread_id: 't1' },
    { type: 'item.started', item: { id: 'r1', type: 'reasoning', text: 'thinking...' } },
    { type: 'item.started', item: { id: 'msg-1', type: 'agent_message', text: 'Hel' } },
    { type: 'item.updated', item: { id: 'msg-1', type: 'agent_message', text: 'Hello th' } },
    { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'Hello there.' } },
    { type: 'turn.completed' },
  ]);

  const deltas: unknown[] = [];
  const response = await createCodexProvider({ runTurn }).generate({
    session: createSession(),
    onDelta: (delta) => {
      deltas.push(delta);
    },
  });

  assert.deepEqual(deltas, [
    { type: 'thinking' },
    { type: 'text', text: 'Hel' },
    { type: 'text', text: 'lo th' },
    { type: 'text', text: 'ere.' },
  ]);
  assert.deepEqual(response.parts, [{ type: 'text', text: 'Hello there.' }]);
});

test('a wedged event stream is aborted after the idle timeout', async () => {
  const provider = createCodexProvider({
    idleTimeoutMs: 50,
    runTurn: ({ signal }) => ({
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise((_resolve, reject) => {
              const keepAlive = setTimeout(() => {}, 60_000);
              signal.addEventListener(
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
    () => provider.generate({ session: createSession() }),
    /no output for 50ms/,
  );
});

test('a slow delta consumer is not counted as codex silence', async () => {
  const IDLE_MS = 60;
  // The fake honours the signal the provider hands it, as the real SDK
  // does — otherwise an abort has no visible effect and this test would
  // pass whether the timer fired or not.
  const runTurn: CodexRunTurn = ({ signal }) => (async function* (): AsyncGenerator<CodexThreadEvent> {
    for (const event of [
      { type: 'item.updated', item: { id: 'm1', type: 'agent_message', text: 'one' } },
      { type: 'item.updated', item: { id: 'm1', type: 'agent_message', text: 'onetwo' } },
      { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'onetwo' } },
      { type: 'turn.completed' },
    ] as CodexThreadEvent[]) {
      if (signal.aborted) {
        throw new Error('aborted');
      }
      yield event;
    }
  })();

  const response = await createCodexProvider({ runTurn, idleTimeoutMs: IDLE_MS }).generate({
    session: createSession(),
    onDelta: async () => {
      await new Promise((resolve) => setTimeout(resolve, IDLE_MS * 2));
    },
  });

  assert.deepEqual(response.parts, [{ type: 'text', text: 'onetwo' }]);
});

test('the idle timer suspends across hosted tool waits and its abort reaches hosted work', async () => {
  // Sampled while the tool is still executing: the turn-final abort in
  // generate()'s cleanup fires on every exit by design, so the signal's
  // state after the turn says nothing about the idle timer.
  const abortedDuringTool: boolean[] = [];
  let sawSignal = false;
  const provider = createCodexProvider({
    idleTimeoutMs: 60,
    executeTool: async (_session, call, context) => {
      sawSignal = context?.signal !== undefined;
      // 3x the idle timeout — survives only if the timer suspended.
      await new Promise((resolve) => setTimeout(resolve, 200));
      abortedDuringTool.push(context?.signal?.aborted ?? false);
      return { callId: call.id, toolName: call.toolName, ok: true, output: { echoed: true } };
    },
    runTurn: (params) => (async function* (): AsyncGenerator<CodexThreadEvent> {
      const config = params.clientOptions.config as CapturedConfig;
      const server = config.mcp_servers?.stratus;
      assert.ok(server);
      await fetch(server.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${params.clientOptions.env[MCP_TOKEN_ENV_VAR]}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'demo_echo', arguments: {} } }),
      });
      yield { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'survived the slow tool' } };
      yield { type: 'turn.completed' };
    })(),
  });

  const response = await provider.generate({
    session: createSession(),
    tools: [{ name: 'demo.echo', parameters: { type: 'object', properties: {} } }],
  });

  assert.deepEqual(response.parts, [{ type: 'text', text: 'survived the slow tool' }]);
  assert.equal(sawSignal, true, 'hosted tools must receive the abort signal even without a caller signal');
  assert.deepEqual(abortedDuringTool, [false], 'the idle timer must not fire during a hosted tool wait');
});

test('hosted work still in flight is aborted when the codex run dies', async () => {
  // The subprocess can fire a tools/call and then die without awaiting it.
  // The HTTP handler executing that call is detached from generate(), so
  // unless the provider aborts its controller on the way out, the kernel
  // keeps executing a tool for a turn that has already been reported
  // failed — a command running after its turn is dead.
  let started: () => void;
  const toolStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finished: (signal: AbortSignal | undefined) => void;
  const toolFinished = new Promise<AbortSignal | undefined>((resolve) => {
    finished = resolve;
  });

  const provider = createCodexProvider({
    executeTool: async (_session, call, context) => {
      started();
      // Runs until cancellation reaches it — the exact dependence on the
      // abort that this test exists to pin.
      await new Promise<void>((resolve) => {
        context?.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      finished(context?.signal);
      return { callId: call.id, toolName: call.toolName, ok: false, output: null, error: 'aborted' };
    },
    runTurn: (params) => (async function* (): AsyncGenerator<CodexThreadEvent> {
      const config = params.clientOptions.config as CapturedConfig;
      const server = config.mcp_servers?.stratus;
      assert.ok(server);
      // Fired, never awaited — the call is mid-execution when the stream dies.
      void fetch(server.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${params.clientOptions.env[MCP_TOKEN_ENV_VAR]}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'demo_echo', arguments: {} } }),
      }).catch(() => {});
      await toolStarted;
      throw new Error('codex died');
      yield { type: 'turn.completed' };
    })(),
  });

  await assert.rejects(
    () => provider.generate({ session: createSession(), tools: [{ name: 'demo.echo' }] }),
    /codex died/,
  );

  // The gate has a way to lose: without the abort, the hosted call never
  // settles and the deadline rejects instead of the suite hanging.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 10_000);
  try {
    const signal = await Promise.race([
      toolFinished,
      new Promise<never>((_, reject) => {
        deadline.signal.addEventListener('abort', () => {
          reject(new Error('the in-flight hosted call was never aborted — it outlived its dead turn'));
        }, { once: true });
      }),
    ]);
    assert.equal(signal?.aborted, true);
  } finally {
    clearTimeout(timer);
  }
});

test('concurrent MCP tool calls execute one at a time', async () => {
  let inFlight = 0;
  let peak = 0;
  const order: string[] = [];
  const server = await startKernelMcpServer({
    descriptors: [{ name: 'demo.echo' }, { name: 'memory.remember' }],
    session: createSession(),
    executeTool: async (_session, call): Promise<ToolResult> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(call.toolName);
      inFlight -= 1;
      return { callId: call.id, toolName: call.toolName, ok: true, output: null };
    },
  });

  const call = (id: number, name: string) =>
    fetch(server.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } }),
    });

  await Promise.all([call(1, 'demo_echo'), call(2, 'memory_remember'), call(3, 'demo_echo')]);
  await server.close();

  // The kernel contract: tools run one at a time, in arrival order.
  assert.equal(peak, 1);
  assert.deepEqual(order, ['demo.echo', 'memory.remember', 'demo.echo']);
});

test('the MCP endpoint refuses requests without the bearer token', async () => {
  const server = await startKernelMcpServer({
    descriptors: [{ name: 'demo.echo' }],
    session: createSession(),
    executeTool: async (): Promise<ToolResult> => {
      throw new Error('must not execute');
    },
  });

  try {
    const missing = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'demo_echo', arguments: {} } }),
    });
    assert.equal(missing.status, 401);

    const wrong = await fetch(server.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${'0'.repeat(server.token.length)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'demo_echo', arguments: {} } }),
    });
    assert.equal(wrong.status, 401);

    // The server never initiates messages, so the SSE listening stream is
    // declined rather than half-implemented.
    const get = await fetch(server.url, { headers: { authorization: `Bearer ${server.token}` } });
    assert.equal(get.status, 405);
  } finally {
    await server.close();
  }
});

test('the MCP endpoint speaks the initialize/list/call slice codex uses', async () => {
  const server = await startKernelMcpServer({
    descriptors: [
      { name: 'demo.echo', description: 'Echo.', parameters: { type: 'object', properties: { text: { type: 'string' } } } },
    ],
    session: createSession(),
    executeTool: async (_session, call): Promise<ToolResult> => (
      { callId: call.id, toolName: call.toolName, ok: false, output: null, error: 'denied by approval policy' }
    ),
    instructions: 'Stratus tools.',
  });

  const post = async (body: JsonRpcBody): Promise<{ status: number; body: unknown }> => {
    const response = await fetch(server.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: response.status === 202 ? undefined : await response.json() };
  };
  interface JsonRpcBody { jsonrpc: '2.0'; id?: number; method: string; params?: Record<string, unknown> }

  try {
    const initialize = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex', version: '0.151.0' } },
    });
    const initResult = (initialize.body as { result: { protocolVersion: string; capabilities: { tools: object }; serverInfo: { name: string } } }).result;
    assert.equal(initResult.protocolVersion, '2025-06-18');
    assert.deepEqual(initResult.capabilities, { tools: {} });
    assert.equal(initResult.serverInfo.name, 'stratus');

    // Notifications are acknowledged with 202 and no body.
    const initialized = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(initialized.status, 202);

    const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (list.body as { result: { tools: Array<{ name: string; inputSchema: { type: string } }> } }).result.tools;
    assert.equal(tools[0]?.name, 'demo_echo');
    assert.equal(tools[0]?.inputSchema.type, 'object');

    // A denied kernel call comes back as a tool error, not a transport one.
    const denied = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'demo_echo', arguments: {} } });
    const deniedResult = (denied.body as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
    assert.equal(deniedResult.isError, true);
    assert.match(deniedResult.content[0]!.text, /denied by approval policy/);

    const unknownTool = await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'fs_write', arguments: {} } });
    assert.match(JSON.stringify(unknownTool.body), /Unknown tool/);

    const unknownMethod = await post({ jsonrpc: '2.0', id: 5, method: 'resources/list' });
    assert.match(JSON.stringify(unknownMethod.body), /Method not found/);
  } finally {
    await server.close();
  }
});
