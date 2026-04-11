import test from 'node:test';
import assert from 'node:assert/strict';

import type { Session, Tool } from '@stratusclaw/core';
import {
  createDirectExecutor,
  defineExecutor,
  failureResult,
  successResult,
} from '../src/index.ts';

const session: Session = {
  id: 'session-1',
  agent: { id: 'agent-1', name: 'Kernel' },
  status: 'running',
  messages: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

test('direct executor runs tools and returns normalized success results', async () => {
  const executor = createDirectExecutor();
  const tool: Tool = {
    name: 'echo',
    async execute(input) {
      return { echoed: String(input.value).toUpperCase() };
    },
  };

  const result = await executor.execute(
    {
      id: 'call-1',
      toolName: 'echo',
      input: { value: 'stratus' },
    },
    tool,
    session,
  );

  assert.deepEqual(result, {
    callId: 'call-1',
    toolName: 'echo',
    ok: true,
    output: { echoed: 'STRATUS' },
  });
});

test('direct executor can customize failure mapping', async () => {
  const executor = createDirectExecutor({
    onError({ call, error }) {
      return failureResult(call, `wrapped:${error instanceof Error ? error.message : String(error)}`);
    },
  });

  const tool: Tool = {
    name: 'explode',
    async execute() {
      throw new Error('boom');
    },
  };

  const result = await executor.execute(
    {
      id: 'call-2',
      toolName: 'explode',
      input: {},
    },
    tool,
    session,
  );

  assert.deepEqual(result, {
    callId: 'call-2',
    toolName: 'explode',
    ok: false,
    output: null,
    error: 'wrapped:boom',
  });
});

test('executor helpers produce core-compatible executor results', async () => {
  const executor = defineExecutor({
    async execute(call) {
      return successResult(call, { mode: 'remote' });
    },
  });

  const tool: Tool = {
    name: 'noop',
    async execute() {
      return null;
    },
  };

  const result = await executor.execute(
    {
      id: 'call-3',
      toolName: 'noop',
      input: {},
    },
    tool,
    session,
  );

  assert.deepEqual(result, {
    callId: 'call-3',
    toolName: 'noop',
    ok: true,
    output: { mode: 'remote' },
  });
});
