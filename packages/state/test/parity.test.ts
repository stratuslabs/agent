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

/** What both paths must agree on, gathered from one scripted run. */
interface Observed {
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
    return anthropicMessage([{ type: 'text', text: FINAL_TEXT }], 'end_turn');
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
  return (async function* (): AsyncGenerator<ClaudeCodeStreamMessage> {
    yield { type: 'system', subtype: 'init' } as ClaudeCodeStreamMessage;
    // `memory.remember` reaches the SDK as `memory_remember`: the MCP name
    // charset has no dots, and the dotted original travels in the closure
    // so the kernel still sees its own naming.
    const registered = servers?.stratus?.instance?._registeredTools ?? {};
    const handler = registered.memory_remember?.handler;
    assert.ok(handler, `the memory tool was not bridged: ${JSON.stringify(Object.keys(registered))}`);
    await handler({ fact: REMEMBERED }, {});
    yield { type: 'result', subtype: 'success', is_error: false, result: FINAL_TEXT } as ClaudeCodeStreamMessage;
  })();
};

const observe = async (
  build: (executeTool: ClaudeCodeToolExecutor) => ModelProvider,
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

  const session = await runner.run({
    sessionId: 'parity-1',
    agent: AGENT,
    userMessage: USER_MESSAGE,
  });

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
    memory: await memoryStore.list(AGENT.id),
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
