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

test('cancellation kills the whole process tree, not just the direct child', async () => {
  const tool = defineLocalCommandTool({
    name: 'tree',
    createCommand() {
      // A shell whose grandchild would outlive a direct-child-only kill.
      return {
        command: 'sh',
        args: ['-c', `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 5000)" & wait`],
      };
    },
  });

  const controller = new AbortController();
  const executor = createLocalCommandExecutor();
  const startedAt = Date.now();
  setTimeout(() => controller.abort(), 100);

  const result = await executor.execute(
    { id: 'call-tree', toolName: 'tree', input: {} },
    tool,
    session,
    { signal: controller.signal },
  );

  assert.equal(result.ok, false);
  const output = result.output as Record<string, unknown>;
  assert.equal(output.aborted, true);
  // The wait ended because the grandchild died with the group — well
  // before its own 5s timer.
  assert.ok(Date.now() - startedAt < 4000);
});

test('cancellation settles the turn even when createCommand never resolves', async () => {
  // The factory runs before any process exists; the abort signal must be
  // honored there too, or a cancelled turn (and a draining daemon) waits
  // on it forever.
  const tool = defineLocalCommandTool({
    name: 'stuck.factory',
    createCommand: () => new Promise(() => {}),
  });

  const executor = createLocalCommandExecutor();
  const controller = new AbortController();
  const pending = executor.execute(
    { id: 'c-stuck', toolName: 'stuck.factory', input: {} },
    tool,
    session,
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 20);

  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /aborted/i);
});

test('a command is not spawned when the signal fired during construction', async () => {
  let spawned = 0;
  const executor = createLocalCommandExecutor({
    spawn: ((..._args: unknown[]) => {
      spawned += 1;
      throw new Error('must not spawn');
    }) as never,
  });

  const controller = new AbortController();
  const tool = defineLocalCommandTool({
    name: 'late.factory',
    createCommand: async () => {
      controller.abort();
      return { command: 'echo', args: ['hi'] };
    },
  });

  const result = await executor.execute(
    { id: 'c-late', toolName: 'late.factory', input: {} },
    tool,
    session,
    { signal: controller.signal },
  );

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /aborted/i);
  assert.equal(spawned, 0);
});

test('cancellation settles the turn even when parseResult never resolves', async () => {
  // The subprocess exits cleanly, then the parser blocks: the turn's
  // signal must settle this phase too, or the drain waits on it forever.
  const tool = defineLocalCommandTool({
    name: 'stuck.parser',
    createCommand: () => ({ command: process.execPath, args: ['-e', ''] }),
    parseResult: () => new Promise(() => {}),
  });

  const executor = createLocalCommandExecutor();
  const controller = new AbortController();
  const pending = executor.execute(
    { id: 'c-parse', toolName: 'stuck.parser', input: {} },
    tool,
    session,
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 100);

  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /aborted/i);
});

test('a replacement environment gives the child only what was granted', async (t) => {
  // A secret in the daemon's own environment, exactly where a real one
  // lives: exported by the operator before `stratus serve` started.
  process.env.ANTHROPIC_API_KEY = 'sk-ant-not-for-the-child';
  process.env.STRATUS_TEST_AMBIENT = 'ambient';
  t.after(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.STRATUS_TEST_AMBIENT;
  });

  const dumpEnv = (envMode: 'inherit' | 'replace'): Tool => defineLocalCommandTool({
    name: `demo.env.${envMode}`,
    async createCommand() {
      return {
        command: process.execPath,
        args: ['-e', 'console.log(JSON.stringify(process.env))'],
        env: { GRANTED: 'yes' },
        envMode,
      };
    },
    parseResult(result) {
      return JSON.parse(result.stdout) as Record<string, string>;
    },
  });

  const executor = createLocalCommandExecutor();
  const replaced = await executor.execute(
    { id: 'call-replace', toolName: 'demo.env.replace', input: {} },
    dumpEnv('replace'),
    session,
  );
  assert.equal(replaced.ok, true);
  const replacedEnv = replaced.output as Record<string, string>;
  assert.equal(replacedEnv.GRANTED, 'yes');
  assert.equal(replacedEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(replacedEnv.STRATUS_TEST_AMBIENT, undefined);
  // Not "mostly scrubbed": the child's environment is what was granted and
  // nothing else, so a variable nobody thought to blocklist is still absent.
  assert.deepEqual(Object.keys(replacedEnv), ['GRANTED']);

  // The default is unchanged, because a fixed-argv tool written in this
  // repository is not the thing being defended against.
  const inherited = await executor.execute(
    { id: 'call-inherit', toolName: 'demo.env.inherit', input: {} },
    dumpEnv('inherit'),
    session,
  );
  const inheritedEnv = inherited.output as Record<string, string>;
  assert.equal(inheritedEnv.GRANTED, 'yes');
  assert.equal(inheritedEnv.STRATUS_TEST_AMBIENT, 'ambient');
});
