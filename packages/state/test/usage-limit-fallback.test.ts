import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AgentRunner, InMemorySessionStore, ToolRegistry, type AgentDefinition } from '@stratusagent/core';
import { createRememberTool, MEMORY_TOOL_NAME } from '@stratusagent/agents';
import type { ClaudeCodeQueryFn, ClaudeCodeStreamMessage, ClaudeCodeToolExecutor } from '@stratusagent/provider-claude-code';

import { createFileMemoryStore, createRuntimeProvider, FALLBACK_ACTIVE_METADATA_KEY, resolveRuntimeConfig } from '../src/index.ts';

/**
 * A Claude subscription whose usage window is spent, behind a configured
 * OpenAI fallback: the setup operators reach for when a shared Claude
 * account hits its limit. Driven through the resolver and the factory the
 * gateway calls, so the claim is the whole path: a sign-in in the
 * credential store, a fallback in config.json, and the error the Claude
 * Code runtime raises when the window is spent.
 */

// What the real CLI yields when the window is spent (see the provider's
// own test of this shape): a `success` result flagged `is_error`.
const USAGE_LIMIT_TEXT = "You've hit your session limit · resets 1:27am (America/New_York)";
const FALLBACK_TEXT = 'Answered by the fallback.';
const REMEMBERED = 'The user likes short answers.';

const AGENT: AgentDefinition = {
  id: 'ava',
  name: 'Ava',
  instructions: 'Be concise.',
  tools: [MEMORY_TOOL_NAME],
};

const setUpHome = async (): Promise<string> => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-usage-limit-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({
      anthropic: { type: 'oauth_token', value: 'sk-ant-oat-shared' },
      openai: { type: 'api_key', value: 'sk-openai-test' },
    }),
  );
  await writeFile(
    path.join(home, '.stratus', 'config.json'),
    JSON.stringify({ provider: 'anthropic', model: 'claude-opus-5', fallbackProvider: 'openai', fallbackModel: 'gpt-4o' }),
  );
  return home;
};

const openAIFetch = (calls: string[]): typeof fetch => (async (input: string | URL | Request) => {
  calls.push(String(input));
  return new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: FALLBACK_TEXT }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

/**
 * Each call to the scripted SDK runs `script` with the bridged tool
 * handlers, then reports the spent window.
 */
const spentWindow = (
  calls: { count: number },
  script?: (tools: Record<string, { handler: (input: unknown, extra: unknown) => Promise<unknown> }>) => Promise<void>,
): ClaudeCodeQueryFn => (params) => {
  calls.count += 1;
  const servers = (params.options as {
    mcpServers?: Record<string, {
      instance?: { _registeredTools?: Record<string, { handler: (input: unknown, extra: unknown) => Promise<unknown> }> };
    }>;
  }).mcpServers;
  return (async function* (): AsyncGenerator<ClaudeCodeStreamMessage> {
    yield { type: 'system', subtype: 'init', session_id: 'sdk-limit' } as ClaudeCodeStreamMessage;
    if (script) {
      await script(servers?.stratus?.instance?._registeredTools ?? {});
    }
    yield { type: 'rate_limit_event' } as unknown as ClaudeCodeStreamMessage;
    yield { type: 'result', subtype: 'success', is_error: true, result: USAGE_LIMIT_TEXT, session_id: 'sdk-limit' } as ClaudeCodeStreamMessage;
  })();
};

const build = async (queryFn: ClaudeCodeQueryFn, fetchCalls: string[]) => {
  const home = await setUpHome();
  const config = await resolveRuntimeConfig({}, {
    homeDir: home,
    cwd: home,
    processEnv: {},
    queryFn,
    fetch: openAIFetch(fetchCalls),
  });
  assert.equal(config.provider, 'anthropic');
  assert.equal(config.fallback?.provider, 'openai', 'the shared sign-in keeps its openai fallback');

  const memory = createFileMemoryStore(path.join(home, 'memory.jsonl'));
  const tools = new ToolRegistry();
  tools.register(createRememberTool(memory));
  const switches: string[] = [];
  let runner: AgentRunner | undefined;
  const executeTool: ClaudeCodeToolExecutor = async (session, call, context) => {
    if (!runner) {
      throw new Error('runner not ready');
    }
    return runner.executeHostedToolCall(session, call, context);
  };
  const provider = createRuntimeProvider(
    config,
    (error) => switches.push(error instanceof Error ? error.message : String(error)),
    executeTool,
  );
  const store = new InMemorySessionStore();
  runner = new AgentRunner({ provider, tools, memory, store });
  await runner.initialize();
  return { runner, memory, store, switches };
};

test('a spent Claude subscription window fails over to the openai fallback, and the conversation stays there', async () => {
  const sdk = { count: 0 };
  const fetchCalls: string[] = [];
  const { runner, switches } = await build(spentWindow(sdk), fetchCalls);

  const first = await runner.run({ sessionId: 'limit-1', agent: AGENT, userMessage: 'hello' });

  assert.equal(first.status, 'completed', `the turn failed: ${String(first.lastError)}`);
  assert.equal(first.messages.at(-1)?.content, FALLBACK_TEXT);
  assert.equal(first.metadata?.[FALLBACK_ACTIVE_METADATA_KEY], true);
  assert.equal(sdk.count, 1);
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0]!, /\/chat\/completions$/);
  assert.deepEqual(switches, [`Claude Code run failed: ${USAGE_LIMIT_TEXT}`], 'the switch is logged with the limit text');

  // Sticky: the next turn goes straight to the fallback.
  const second = await runner.resume({ sessionId: first.id, userMessage: 'and again' });
  assert.equal(second.status, 'completed');
  assert.equal(sdk.count, 1, 'the spent primary is not asked again');
  assert.equal(fetchCalls.length, 2);
});

test('a window spent after a tool ran fails that turn as itself, and the next turn fails over', async () => {
  const sdk = { count: 0 };
  const fetchCalls: string[] = [];
  const { runner, memory, store, switches } = await build(spentWindow(sdk, async (tools) => {
    if (sdk.count === 1) {
      const handler = tools.memory_remember?.handler;
      assert.ok(handler, `the memory tool was not bridged: ${JSON.stringify(Object.keys(tools))}`);
      await handler({ fact: REMEMBERED }, {});
    }
  }), fetchCalls);

  // Replaying the turn on another model would remember the fact twice.
  await assert.rejects(
    runner.run({ sessionId: 'limit-2', agent: AGENT, userMessage: 'remember that I like short answers' }),
    /hit your session limit/,
  );
  const first = await store.get('limit-2');
  assert.ok(first);
  assert.equal(first.status, 'failed');
  assert.match(String(first.lastError), /hit your session limit/);
  assert.notEqual(first.metadata?.[FALLBACK_ACTIVE_METADATA_KEY], true);
  assert.equal(fetchCalls.length, 0, 'the fallback is not asked to replay a turn whose tools already ran');
  assert.deepEqual(switches, []);
  assert.equal((await memory.list(AGENT.id)).entries.length, 1);

  // The next message starts clean, so the spent window now fails over.
  const second = await runner.resume({ sessionId: first.id, userMessage: 'hello?' });
  assert.equal(second.status, 'completed', `the turn failed: ${String(second.lastError)}`);
  assert.equal(second.messages.at(-1)?.content, FALLBACK_TEXT);
  assert.equal(second.metadata?.[FALLBACK_ACTIVE_METADATA_KEY], true);
  // Not pinned: how many times the SDK is launched before the switch. A
  // failed resume is retried once on a fresh SDK session, and a spent
  // window fails that one too.
  assert.ok(sdk.count >= 2);
  assert.equal(fetchCalls.length, 1);
  assert.equal((await memory.list(AGENT.id)).entries.length, 1, 'nothing ran twice');
});
