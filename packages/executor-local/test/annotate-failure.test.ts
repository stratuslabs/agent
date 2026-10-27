import test from 'node:test';
import assert from 'node:assert/strict';

import type { Session } from '@stratusagent/core';
import {
  createLocalCommandExecutor,
  defineLocalCommandTool,
  type LocalCommandContext,
  type LocalCommandExecution,
} from '../src/index.ts';

const session: Session = {
  id: 'session-1',
  agent: { id: 'agent-1', name: 'Kernel' },
  status: 'running',
  messages: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const failing = ['-e', 'console.error("boom"); process.exit(4);'];
const call = { id: 'call-1', toolName: 'explode', input: {} };

const RECORD_KEYS = ['aborted', 'args', 'command', 'durationMs', 'exitCode', 'stderr', 'stderrTruncated', 'stdout', 'stdoutTruncated', 'timedOut'].sort();

test('a command that exits non-zero carries the fields its tool adds, beside the execution record', async () => {
  const asked: Array<{ execution: LocalCommandExecution; context: LocalCommandContext }> = [];
  const tool = defineLocalCommandTool({
    name: 'explode',
    createCommand: () => ({ command: process.execPath, args: failing }),
    annotateFailure(execution, context) {
      asked.push({ execution, context });
      // A key the record already has is not the tool's to rewrite.
      return { hint: 'it was the sandbox', exitCode: 0, stderr: 'rewritten' };
    },
  });

  const result = await createLocalCommandExecutor().execute(call, tool, session);

  assert.equal(result.ok, false);
  assert.equal(result.error, `Command exited with code 4: ${process.execPath}`);
  const output = result.output as Record<string, unknown>;
  assert.equal(output.hint, 'it was the sandbox');
  assert.equal(output.exitCode, 4);
  assert.equal(output.stderr, 'boom\n');
  assert.deepEqual(Object.keys(output).sort(), [...RECORD_KEYS, 'hint'].sort());
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.execution.exitCode, 4);
  assert.equal(asked[0]!.execution.stderr, 'boom\n');
  assert.equal(asked[0]!.context.call.id, 'call-1');
  assert.equal(asked[0]!.context.session.id, 'session-1');
});

test('the hook is asked only for a non-zero exit, not on success or a timeout', async () => {
  let asked = 0;
  const annotateFailure = () => {
    asked += 1;
    return { hint: 'x' };
  };
  const ok = defineLocalCommandTool({
    name: 'ok',
    createCommand: () => ({ command: process.execPath, args: ['-e', ''] }),
    annotateFailure,
  });
  const slow = defineLocalCommandTool({
    name: 'slow',
    createCommand: () => ({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 5000)'], timeoutMs: 100 }),
    annotateFailure,
  });
  const executor = createLocalCommandExecutor();

  const passed = await executor.execute({ id: 'c1', toolName: 'ok', input: {} }, ok, session);
  const timedOut = await executor.execute({ id: 'c2', toolName: 'slow', input: {} }, slow, session);

  assert.equal(passed.ok, true);
  assert.equal(timedOut.ok, false);
  assert.match(String(timedOut.error), /timed out/);
  assert.equal((timedOut.output as Record<string, unknown>).hint, undefined);
  assert.equal(asked, 0);
});

test('a hook that throws, rejects or returns something other than an object leaves the failure as it was', async () => {
  const hooks: Array<() => unknown> = [
    () => { throw new Error('hook broke'); },
    () => Promise.reject(new Error('hook rejected')),
    () => undefined,
    () => ['not', 'an', 'object'],
    () => 'text',
  ];
  for (const hook of hooks) {
    const tool = defineLocalCommandTool({
      name: 'explode',
      createCommand: () => ({ command: process.execPath, args: failing }),
      annotateFailure: hook as never,
    });
    const result = await createLocalCommandExecutor().execute(call, tool, session);
    assert.equal(result.ok, false);
    assert.equal(result.error, `Command exited with code 4: ${process.execPath}`);
    assert.deepEqual(Object.keys(result.output as object).sort(), RECORD_KEYS);
  }
});

test('a hook that never settles cannot hold the result: it is dropped after its bound, or at once when the turn stops', { timeout: 10_000 }, async () => {
  const stuck = defineLocalCommandTool({
    name: 'explode',
    createCommand: () => ({ command: process.execPath, args: failing }),
    annotateFailure: () => new Promise<never>(() => {}),
  });

  const started = Date.now();
  const bounded = await createLocalCommandExecutor().execute(call, stuck, session);
  const boundedMs = Date.now() - started;
  assert.equal(bounded.ok, false);
  assert.equal(bounded.error, `Command exited with code 4: ${process.execPath}`);
  assert.deepEqual(Object.keys(bounded.output as object).sort(), RECORD_KEYS);
  assert.ok(boundedMs < 4_000, `took ${boundedMs}ms`);

  const controller = new AbortController();
  const stopping = defineLocalCommandTool({
    name: 'explode',
    createCommand: () => ({ command: process.execPath, args: failing }),
    annotateFailure: () => {
      setTimeout(() => controller.abort(), 20);
      return new Promise<never>(() => {});
    },
  });
  const stopStarted = Date.now();
  const stopped = await createLocalCommandExecutor().execute(call, stopping, session, { signal: controller.signal });
  const stoppedMs = Date.now() - stopStarted;
  assert.equal(stopped.ok, false);
  assert.equal(stopped.error, `Command exited with code 4: ${process.execPath}`);
  assert.deepEqual(Object.keys(stopped.output as object).sort(), RECORD_KEYS);
  assert.ok(stoppedMs < 1_500, `took ${stoppedMs}ms`);
});
