import test from 'node:test';
import assert from 'node:assert/strict';

import type { Session, Tool } from '@stratusagent/core';
import {
  createLocalCommandExecutor,
  defineLocalCommandTool,
} from '../src/index.ts';

const session: Session = {
  id: 'session-1',
  agent: { id: 'agent-1', name: 'Kernel' },
  status: 'running',
  messages: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

test('local command executor runs a local process and parses its result', async () => {
  const tool = defineLocalCommandTool({
    name: 'demo.echo',
    async createCommand(input) {
      const text = typeof input.text === 'string' ? input.text.trim() : 'empty input';
      const script = `const value = ${JSON.stringify(text)}; console.log(JSON.stringify({ received: value, uppercase: value.toUpperCase(), length: value.length }));`;

      return {
        command: process.execPath,
        args: ['-e', script],
      };
    },
    parseResult(result) {
      return JSON.parse(result.stdout) as { received: string; uppercase: string; length: number };
    },
  });

  const executor = createLocalCommandExecutor();
  const result = await executor.execute({
    id: 'call-1',
    toolName: 'demo.echo',
    input: { text: 'stratus' },
  }, tool, session);

  assert.deepEqual(result, {
    callId: 'call-1',
    toolName: 'demo.echo',
    ok: true,
    output: {
      received: 'stratus',
      uppercase: 'STRATUS',
      length: 7,
    },
  });
});

test('local command executor falls back to direct tool execution for plain tools', async () => {
  const tool: Tool = {
    name: 'plain.echo',
    async execute(input) {
      return { echoed: String(input.value).toUpperCase() };
    },
  };

  const executor = createLocalCommandExecutor();
  const result = await executor.execute({
    id: 'call-2',
    toolName: 'plain.echo',
    input: { value: 'mini' },
  }, tool, session);

  assert.deepEqual(result, {
    callId: 'call-2',
    toolName: 'plain.echo',
    ok: true,
    output: { echoed: 'MINI' },
  });
});

test('local command executor captures non-zero exits as failures', async () => {
  const tool = defineLocalCommandTool({
    name: 'explode',
    createCommand() {
      return {
        command: process.execPath,
        args: ['-e', 'console.error("boom"); process.exit(4);'],
      };
    },
  });

  const executor = createLocalCommandExecutor();
  const result = await executor.execute({
    id: 'call-3',
    toolName: 'explode',
    input: {},
  }, tool, session);

  assert.equal(result.ok, false);
  assert.equal(result.error, `Command exited with code 4: ${process.execPath}`);

  const output = result.output as Record<string, unknown>;
  assert.equal(output.command, process.execPath);
  assert.deepEqual(output.args, ['-e', 'console.error("boom"); process.exit(4);']);
  assert.equal(output.stdout, '');
  assert.equal(output.stderr, 'boom\n');
  assert.equal(output.exitCode, 4);
  assert.equal(output.timedOut, false);
  assert.equal(typeof output.durationMs, 'number');
});

test('local command executor times out long-running processes', async () => {
  const tool = defineLocalCommandTool({
    name: 'slow',
    createCommand() {
      return {
        command: process.execPath,
        args: ['-e', 'setTimeout(() => console.log("late"), 200);'],
        timeoutMs: 25,
      };
    },
  });

  const executor = createLocalCommandExecutor();
  const result = await executor.execute({
    id: 'call-4',
    toolName: 'slow',
    input: {},
  }, tool, session);

  assert.equal(result.ok, false);
  assert.equal(result.error, `Command timed out after 25ms: ${process.execPath}`);

  const output = result.output as Record<string, unknown>;
  assert.equal(output.command, process.execPath);
  assert.deepEqual(output.args, ['-e', 'setTimeout(() => console.log("late"), 200);']);
  assert.equal(output.stdout, '');
  assert.equal(output.stderr, '');
  assert.equal(output.exitCode, -1);
  assert.equal(output.timedOut, true);
  assert.equal(typeof output.durationMs, 'number');
});

test('local command executor preserves utf-8 characters split across stdout chunks', async () => {
  const tool = defineLocalCommandTool({
    name: 'utf8.echo',
    createCommand() {
      return {
        command: process.execPath,
        args: ['-e', `process.stdout.write(Buffer.from([0xF0, 0x9F])); setTimeout(() => process.stdout.end(Buffer.from([0x98, 0x80])), 10);`],
      };
    },
  });

  const executor = createLocalCommandExecutor();
  const result = await executor.execute({
    id: 'call-5',
    toolName: 'utf8.echo',
    input: {},
  }, tool, session);

  assert.equal(result.ok, true);
  const output = result.output as Record<string, unknown>;
  assert.equal(output.stdout, '😀');
});

test('local command executor kills the child when the turn aborts', async () => {
  const tool = defineLocalCommandTool({
    name: 'sleepy',
    createCommand() {
      return {
        command: process.execPath,
        args: ['-e', 'setTimeout(() => console.log("survived"), 5000);'],
      };
    },
  });

  const controller = new AbortController();
  const executor = createLocalCommandExecutor();
  const startedAt = Date.now();
  setTimeout(() => controller.abort(), 50);

  const result = await executor.execute(
    { id: 'call-abort', toolName: 'sleepy', input: {} },
    tool,
    session,
    { signal: controller.signal },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, `Command aborted: ${process.execPath}`);
  const output = result.output as Record<string, unknown>;
  assert.equal(output.aborted, true);
  assert.equal(output.stdout, '');
  // The child died with the abort, not with its own 5s timer.
  assert.ok(Date.now() - startedAt < 4000);
});
