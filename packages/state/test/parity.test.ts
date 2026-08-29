import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  AgentRunner,
  EventBus,
  ToolRegistry,
  type AgentDefinition,
  type MemoryEntry,
  type ModelProvider,
  type Session,
  type StratusEvent,
} from '@stratusagent/core';
import { createRememberTool, MEMORY_TOOL_NAME } from '@stratusagent/agents';
import {
  SDK_SESSION_METADATA_KEY,
  type ClaudeCodeQueryFn,
  type ClaudeCodeStreamMessage,
  type ClaudeCodeToolExecutor,
} from '@stratusagent/provider-claude-code';

import { createFileMemoryStore, createRuntimeProvider } from '../src/index.ts';

/**
 * The same scripted turn, run on both billing paths, asserted through what
 * the kernel can observe.
 *
 * An agent is supposed to be the same agent whichever way you pay for it —
 * the API-key path and the Claude subscription path differ only in who
 * bills the tokens. That is easy to state and easy to lose: the two
 * providers share no code, one of them drives its own inner tool loop, and
 * the sameness lives entirely in what the kernel ends up holding
 * afterwards. So that is what this asserts — the tool that ran, the
 * arguments it ran with, the memory it wrote, the events it emitted, and
 * the transcript it left behind — rather than anything about how either
 * provider got there.
 *
 * Both paths are driven by their own injection seam (a `fetch` for the
 * Messages API, a `query` for the Agent SDK), scripted to make the same
 * decision. A difference in the assertions below is a real divergence in
 * what an agent *is* on one path or the other.
 */

const AGENT: AgentDefinition = {
  id: 'ava',
  name: 'Ava',
  instructions: 'Be warm and concise.',
  tools: [MEMORY_TOOL_NAME],
};

const USER_MESSAGE = 'remember that I like short answers';
const REMEMBERED = 'The user likes short answers.';
const FINAL_TEXT = 'Noted — short answers from here on.';
const FOLLOW_UP = 'what did I ask for?';
const RECALLED = 'Short answers.';

/**
 * A fresh session per provider-level assertion. Deliberately not shared:
 * the fallback wrapper marks a switch on the session so it stays sticky
 * for the rest of that conversation, so a session reused across tests
 * arrives at the next one already routed to the fallback — and a test
 * asserting the primary was tried would silently be asserting nothing.
 */
const fallbackSession = (id: string): Session => ({
  id,
  agent: AGENT,
  status: 'running',
  messages: [{ id: `${id}:user:1`, role: 'user', content: 'hello', createdAt: new Date().toISOString() }],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

/** What both paths must agree on, gathered from one scripted run. */
interface Observed {
  sdkSessionId: unknown;
  memory: MemoryEntry[];
  toolCalls: Array<{ toolName: string; input: unknown }>;
  toolResults: Array<{ toolName: string; ok: boolean }>;
  /**
   * Call ids paired with the ids the results answered, in transcript
   * order. Kept separate from the comparison above because these are
   * provider-generated and never match across the two — what has to hold
   * is that each provider answered its *own* calls.
   */
  pairing: Array<{ called: string; answered: string | undefined }>;
  events: string[];
  finalText: string;
  status: Session['status'];
}

const anthropicMessage = (content: object[], stopReason: string): Response =>
  new Response(
    JSON.stringify({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5',
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 2 },
    }),
    { headers: { 'content-type': 'application/json' } },
  );

/** The API-key path: a tool-call turn, then a text turn. */
const anthropicFetch = (): typeof fetch => {
  let call = 0;
  return (async () => {
    call += 1;
    if (call === 1) {
      return anthropicMessage(
        [{ type: 'tool_use', id: 'toolu_1', name: 'memory_remember', input: { fact: REMEMBERED } }],
        'tool_use',
      );
    }
    return anthropicMessage([{ type: 'text', text: call === 2 ? FINAL_TEXT : RECALLED }], 'end_turn');
  }) as typeof fetch;
};

/**
 * The subscription path: the SDK consumes the tool call inside its own
 * loop, so the scripted query calls the bridged MCP handler itself and
 * returns only the final text — which is exactly the shape this suite
 * exists to prove the kernel cannot tell apart.
 */
const claudeCodeQuery = (): ClaudeCodeQueryFn => (params) => {
  const servers = (params.options as {
    mcpServers?: Record<string, {
      instance?: { _registeredTools?: Record<string, { handler: (input: unknown, extra: unknown) => Promise<unknown> }> };
    }>;
  }).mcpServers;
  const resume = (params.options as { resume?: string }).resume;
  return (async function* (): AsyncGenerator<ClaudeCodeStreamMessage> {
    yield { type: 'system', subtype: 'init', session_id: SDK_SESSION_ID } as ClaudeCodeStreamMessage;
    if (resume) {
      // A resumed turn answers from the SDK's own history. Nothing is
      // re-sent and no tool runs again.
      yield { type: 'result', subtype: 'success', is_error: false, result: RECALLED, session_id: SDK_SESSION_ID } as ClaudeCodeStreamMessage;
      return;
    }
    // `memory.remember` reaches the SDK as `memory_remember`: the MCP name
    // charset has no dots, and the dotted original travels in the closure
    // so the kernel still sees its own naming.
    const registered = servers?.stratus?.instance?._registeredTools ?? {};
    const handler = registered.memory_remember?.handler;
    assert.ok(handler, `the memory tool was not bridged: ${JSON.stringify(Object.keys(registered))}`);
    await handler({ fact: REMEMBERED }, {});
    yield { type: 'result', subtype: 'success', is_error: false, result: FINAL_TEXT, session_id: SDK_SESSION_ID } as ClaudeCodeStreamMessage;
  })();
};

const SDK_SESSION_ID = 'sdk-parity-1';

const observe = async (
  build: (executeTool: ClaudeCodeToolExecutor) => ModelProvider,
  followUp?: string,
): Promise<Observed> => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-parity-'));
  const memoryStore = createFileMemoryStore(path.join(home, 'memory.jsonl'));

  const events: string[] = [];
  const bus = new EventBus();
  bus.subscribe((event: StratusEvent) => {
    events.push(event.type);
  });

  const tools = new ToolRegistry();
  tools.register(createRememberTool(memoryStore));

  let runner: AgentRunner | undefined;
  // Late-bound, as both real callers do it: the runner needs the provider
  // first, and the provider needs a way back into the runner.
  const executeTool: ClaudeCodeToolExecutor = async (session, call, context) => {
    if (!runner) {
      throw new Error('runner not ready');
    }
    return runner.executeHostedToolCall(session, call, context);
  };
  const provider = build(executeTool);

  runner = new AgentRunner({ provider, tools, bus, memory: memoryStore });
  await runner.initialize();

  let session = await runner.run({
    sessionId: 'parity-1',
    agent: AGENT,
    userMessage: USER_MESSAGE,
  });

  if (followUp !== undefined) {
    session = await runner.resume({ sessionId: session.id, userMessage: followUp });
  }

  const toolCalls: Observed['toolCalls'] = [];
  const toolResults: Observed['toolResults'] = [];
  const calledIds: string[] = [];
  const answeredIds: string[] = [];
  for (const message of session.messages) {
    for (const call of message.toolCalls ?? []) {
      toolCalls.push({ toolName: call.toolName, input: call.input });
      calledIds.push(call.id);
    }
    if (message.toolResult) {
      toolResults.push({ toolName: message.toolResult.toolName, ok: message.toolResult.ok });
      answeredIds.push(message.toolResult.callId);
    }
  }

  return {
    sdkSessionId: session.metadata?.[SDK_SESSION_METADATA_KEY],
    memory: (await memoryStore.list(AGENT.id)).entries,
    toolCalls,
    toolResults,
    pairing: calledIds.map((called, index) => ({ called, answered: answeredIds[index] })),
    events: events.filter((type) => type.startsWith('tool.')),
    finalText: session.messages.at(-1)?.content ?? '',
    status: session.status,
  };
};

test('a tool call and a memory write land identically on both billing paths', async () => {
  // Through the factory the CLI and the gateway actually call, not the
  // providers directly: selecting the wrong path, or dropping the hosted
  // executor on the way through, would disable subscription tools in
  // production while a suite that built its own providers stayed green.
  // The two configs differ only in which Anthropic credential they carry,
  // which is exactly how the real choice is made.
  const apiKey = await observe((executeTool) => createRuntimeProvider(
    { provider: 'anthropic', model: 'claude-opus-5', apiKey: 'sk-ant-test', fetch: anthropicFetch() },
    undefined,
    executeTool,
  ));

  const subscription = await observe((executeTool) => createRuntimeProvider(
    { provider: 'anthropic', model: 'claude-opus-5', authToken: 'sk-ant-oat-test', queryFn: claudeCodeQuery() },
    undefined,
    executeTool,
  ));

  // The agent remembered the same thing, under the same id.
  assert.equal(apiKey.memory.length, 1, `api-key path wrote ${apiKey.memory.length} entries`);
  assert.deepEqual(
    subscription.memory.map((entry) => [entry.agentId, entry.content]),
    apiKey.memory.map((entry) => [entry.agentId, entry.content]),
  );
  assert.equal(apiKey.memory[0]?.content, REMEMBERED);

  // The same tool ran, with the same arguments, and was recorded.
  assert.deepEqual(subscription.toolCalls, apiKey.toolCalls);
  assert.deepEqual(apiKey.toolCalls, [{ toolName: MEMORY_TOOL_NAME, input: { fact: REMEMBERED } }]);

  // Every call is answered *by its own id* on both paths. Equal counts
  // would not say that: a result carrying the wrong callId leaves one
  // call and one result in the transcript and still fails on replay,
  // which is the exact failure this line exists to catch.
  assert.deepEqual(subscription.toolResults, apiKey.toolResults);
  for (const [label, observed] of [['api-key', apiKey], ['subscription', subscription]] as const) {
    assert.ok(observed.pairing.length > 0, `${label} path recorded no tool calls`);
    for (const { called, answered } of observed.pairing) {
      assert.equal(answered, called, `${label} path answered ${called} with ${String(answered)}`);
    }
  }

  // Channels, approvals, and the dashboard all read the event stream, so
  // an agent that behaves the same but reports differently is not the
  // same agent from where anyone is watching.
  assert.deepEqual(subscription.events, apiKey.events);
  assert.deepEqual(apiKey.events, ['tool.called', 'tool.completed']);

  assert.equal(subscription.finalText, apiKey.finalText);
  assert.equal(subscription.status, apiKey.status);
  assert.equal(apiKey.status, 'completed');
});

test('a subscription fallback inherits the injected query transport', async () => {
  const sessionId = 'fallback-inherit';
  // The fallback branch returns before the subscription branch is reached,
  // so it builds its provider from a config of its own. If `queryFn` does
  // not travel with `fetch`, the fallback reaches the *real* Agent SDK the
  // moment the primary fails — launching Claude Code out of a test run, or
  // out from under an embedder that supplied its own transport on purpose.
  // Nothing about that failure looks like a missing option.
  const seen: string[] = [];
  const scripted = (label: string, behaviour: 'fail' | 'answer'): ClaudeCodeQueryFn => () =>
    (async function* (): AsyncGenerator<ClaudeCodeStreamMessage> {
      seen.push(label);
      if (behaviour === 'fail') {
        throw new Error('primary is down');
      }
      yield { type: 'system', subtype: 'init' } as ClaudeCodeStreamMessage;
      yield { type: 'result', subtype: 'success', is_error: false, result: FINAL_TEXT } as ClaudeCodeStreamMessage;
    })();

  // One transport for both, as a caller injecting a seam would supply: the
  // primary is scripted to fail, so a second call can only be the fallback.
  let call = 0;
  const queryFn: ClaudeCodeQueryFn = (params) => {
    call += 1;
    return call === 1
      ? scripted('primary', 'fail')(params)
      : scripted('fallback', 'answer')(params);
  };

  const provider = createRuntimeProvider({
    provider: 'anthropic',
    model: 'claude-opus-5',
    authToken: 'sk-ant-oat-primary',
    queryFn,
    fallback: { provider: 'anthropic', model: 'claude-opus-5', authToken: 'sk-ant-oat-fallback' },
  });

  // The gate needs a way to lose. Unforwarded, the fallback builds a real
  // Agent SDK provider and tries to spawn Claude Code, which hangs instead
  // of throwing — and a suite with no timeout would hang with it rather
  // than report the regression. The deadline is not a timing assertion:
  // the scripted transports settle immediately, so it can only fire when
  // something reached outside the test.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 10_000);
  let response;
  try {
    response = await Promise.race([
      provider.generate({ session: fallbackSession(sessionId), memory: [], signal: deadline.signal }),
      new Promise<never>((_, reject) => {
        deadline.signal.addEventListener('abort', () => {
          reject(new Error('the fallback never answered through the injected transport — it reached the real Agent SDK'));
        }, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }

  assert.deepEqual(seen, ['primary', 'fallback']);
  assert.deepEqual(response.parts, [{ type: 'text', text: FINAL_TEXT }]);
});

test('a subscription fallback behind an OpenAI primary can be given a transport', async () => {
  const sessionId = 'fallback-cross-provider';
  // An OpenAI primary has no `queryFn` to lend — the field exists only on
  // the Anthropic variant — so a subscription fallback here has nothing to
  // inherit. Without a seam of its own, this pair reaches the real Agent
  // SDK on the first primary failure, and the type system offers the
  // caller no way to prevent it.
  let answered = false;
  const queryFn: ClaudeCodeQueryFn = () =>
    (async function* (): AsyncGenerator<ClaudeCodeStreamMessage> {
      answered = true;
      yield { type: 'system', subtype: 'init' } as ClaudeCodeStreamMessage;
      yield { type: 'result', subtype: 'success', is_error: false, result: FINAL_TEXT } as ClaudeCodeStreamMessage;
    })();

  const provider = createRuntimeProvider({
    provider: 'openai',
    model: 'gpt-4o',
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'sk-openai',
    fetch: (async () => new Response('nope', { status: 500 })) as typeof fetch,
    fallback: {
      provider: 'anthropic',
      model: 'claude-opus-5',
      authToken: 'sk-ant-oat-fallback',
      queryFn,
    },
  });

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 10_000);
  let response;
  try {
    response = await Promise.race([
      provider.generate({ session: fallbackSession(sessionId), memory: [], signal: deadline.signal }),
      new Promise<never>((_, reject) => {
        deadline.signal.addEventListener('abort', () => {
          reject(new Error('the fallback never answered through its own transport — it reached the real Agent SDK'));
        }, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }

  assert.equal(answered, true);
  assert.deepEqual(response.parts, [{ type: 'text', text: FINAL_TEXT }]);
});

test('a fallback naming its own transport is not overridden by the primary\'s', async () => {
  const sessionId = 'fallback-precedence';
  // Both can carry one now, so precedence has to be decided rather than
  // fall out of spread order: a fallback that names a transport is the
  // only way to give the two halves different ones, and inheriting is the
  // convenience, not the rule.
  const used: string[] = [];
  const transport = (label: string): ClaudeCodeQueryFn => () =>
    (async function* (): AsyncGenerator<ClaudeCodeStreamMessage> {
      used.push(label);
      if (label === 'primary') {
        throw new Error('primary is down');
      }
      yield { type: 'system', subtype: 'init' } as ClaudeCodeStreamMessage;
      yield { type: 'result', subtype: 'success', is_error: false, result: FINAL_TEXT } as ClaudeCodeStreamMessage;
    })();

  const provider = createRuntimeProvider({
    provider: 'anthropic',
    model: 'claude-opus-5',
    authToken: 'sk-ant-oat-primary',
    queryFn: transport('primary'),
    fallback: {
      provider: 'anthropic',
      model: 'claude-opus-5',
      authToken: 'sk-ant-oat-fallback',
      queryFn: transport('fallback-own'),
    },
  });

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 10_000);
  try {
    await Promise.race([
      provider.generate({ session: fallbackSession(sessionId), memory: [], signal: deadline.signal }),
      new Promise<never>((_, reject) => {
        deadline.signal.addEventListener('abort', () => {
          reject(new Error('the fallback never answered — it reached the real Agent SDK'));
        }, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }

  // Not ['primary', 'primary']: the fallback used the one it named.
  assert.deepEqual(used, ['primary', 'fallback-own']);
});

test('a second turn lands identically, and the subscription path resumes rather than replays', async () => {
  const apiKey = await observe((executeTool) => createRuntimeProvider(
    { provider: 'anthropic', model: 'claude-opus-5', apiKey: 'sk-ant-test', fetch: anthropicFetch() },
    undefined,
    executeTool,
  ), FOLLOW_UP);

  const subscription = await observe((executeTool) => createRuntimeProvider(
    { provider: 'anthropic', model: 'claude-opus-5', authToken: 'sk-ant-oat-test', queryFn: claudeCodeQuery() },
    undefined,
    executeTool,
  ), FOLLOW_UP);

  // The turn the user sees is the same one, and the fact written on turn
  // one is still there — which is the point of the whole step: an agent
  // that cannot carry a conversation is not the same agent.
  assert.equal(subscription.finalText, apiKey.finalText);
  assert.equal(apiKey.finalText, RECALLED);
  assert.deepEqual(
    subscription.memory.map((entry) => entry.content),
    apiKey.memory.map((entry) => entry.content),
  );
  assert.equal(apiKey.memory.length, 1, 'the second turn must not remember twice');

  // Neither path ran the tool again on the follow-up.
  assert.deepEqual(subscription.toolCalls, apiKey.toolCalls);
  assert.equal(apiKey.toolCalls.length, 1);

  // Not parity — the two carry history differently by design, and this is
  // the difference. The API-key path replays the transcript because the
  // Messages API is stateless; the subscription path hands the SDK back
  // its own session id and sends only the new message.
  assert.equal(apiKey.sdkSessionId, undefined);
  assert.equal(subscription.sdkSessionId, SDK_SESSION_ID);
});
