import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MemoryEntry, ProviderRequest, Session } from '@stratusagent/core';
import {
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
