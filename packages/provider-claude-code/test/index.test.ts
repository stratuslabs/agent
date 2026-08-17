import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MemoryEntry, ProviderRequest, Session, ToolCall, ToolResult } from '@stratusagent/core';
import {
  bridgeKernelTools,
  createClaudeCodeProvider,
  DEFAULT_CLAUDE_CODE_MODEL,
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
