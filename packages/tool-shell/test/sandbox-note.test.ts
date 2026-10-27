import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtemp, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { JsonObject, Session } from '@stratusagent/core';
import { createLocalCommandExecutor, type LocalSpawn } from '@stratusagent/executor-local';

import { createShellTool, type planSandbox } from '../src/index.ts';

// How a command ran is read from the program that was spawned, so these
// plan a sandbox by its real program name and then run the shell part
// unconfined: the result says what a sandboxed run would, on any host,
// without needing a sandbox that can start here (CI has no bwrap, and this
// suite may itself run inside one).

const session: Session = {
  id: 'session-ava',
  agent: { id: 'ava', name: 'ava' },
  status: 'running',
  messages: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const plannedAs = (program: string): typeof planSandbox => (_policy, shell, shellArgs) => ({
  kind: 'sandboxed',
  command: { command: program, args: ['--fake-sandbox-args', '--', shell, ...shellArgs] },
});

// Runs `shell -c command`, the tail of whatever was planned, without the sandbox.
const unconfinedTail: LocalSpawn = (_command, args, options) => {
  const at = args.indexOf('--');
  return nodeSpawn(args[at + 1]!, args.slice(at + 2), options);
};

const run = async (command: string, program?: string) => {
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'stratus-note-')));
  const tool = createShellTool(program ? { cwd, sandbox: 'required' } : { cwd, sandbox: 'off' }, {
    home: cwd,
    processEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    ...(program ? { planSandbox: plannedAs(program) } : {}),
  });
  const executor = createLocalCommandExecutor(program ? { spawn: unconfinedTail } : {});
  return executor.execute({ id: 'c', toolName: 'shell.run', input: { command } }, tool, session);
};

const fields = (result: { output: unknown }): JsonObject => result.output as JsonObject;

const DENIALS: Array<[string, string]> = [
  ['/usr/bin/sandbox-exec', 'touch: /etc/x: Operation not permitted'],
  ['/usr/bin/bwrap', "touch: cannot touch '/etc/x': Read-only file system"],
  ['/usr/local/bin/bwrap', "cat: /root/.ssh/id_ed25519: Permission denied"],
];

for (const [program, denial] of DENIALS) {
  const sandbox = path.basename(program);
  test(`a ${sandbox} command that fails with "${denial.split(': ').at(-1)}" says it ran sandboxed and what that may mean`, async () => {
    const result = await run(`echo "${denial}" >&2; exit 1`, program);
    assert.equal(result.ok, false);
    assert.equal(result.error, `Command exited with code 1: ${program}`);
    const output = fields(result);
    assert.equal(output.sandbox, sandbox);
    assert.equal(output.exitCode, 1);
    assert.equal(output.stderr, `${denial}\n`);
    const note = String(output.sandboxNote);
    assert.match(note, /shell sandbox/);
    assert.match(note, new RegExp(`\\(${sandbox}\\)`));
    assert.match(note, /may be the sandbox/);
    assert.match(note, /writablePaths or readablePaths/);
  });
}

test('a sandboxed command that fails for another reason says it ran sandboxed, with no note', async () => {
  const result = await run('echo "no such thing" >&2; exit 2', '/usr/bin/sandbox-exec');
  assert.equal(result.ok, false);
  assert.equal(fields(result).sandbox, 'sandbox-exec');
  assert.equal('sandboxNote' in fields(result), false);
  const silent = await run('false', '/usr/bin/bwrap');
  assert.equal(fields(silent).sandbox, 'bwrap');
  assert.equal('sandboxNote' in fields(silent), false);
});

test('an unconfined command that fails with a permission error gets sandbox "off" and no note', async () => {
  const result = await run('echo "touch: /etc/x: Permission denied" >&2; exit 1');
  assert.equal(result.ok, false);
  assert.equal(fields(result).sandbox, 'off');
  assert.equal('sandboxNote' in fields(result), false);
});

test('a command that succeeds says how it ran too', async () => {
  const sandboxed = await run('echo hi', '/usr/bin/bwrap');
  assert.equal(sandboxed.ok, true);
  assert.equal(fields(sandboxed).sandbox, 'bwrap');
  assert.equal(fields(sandboxed).stdout, 'hi\n');
  assert.equal('sandboxNote' in fields(sandboxed), false);
  const unconfined = await run('echo hi');
  assert.equal(fields(unconfined).sandbox, 'off');
});

test('a program that only shares a sandbox runner\'s name is not taken for one', async () => {
  // The operator's shell, wherever it lives, is never a sandbox runner, even
  // one called bwrap on a path tool-shell would not have planned.
  const result = await run('echo "x: Operation not permitted" >&2; exit 1', '/opt/tools/bwrap');
  assert.equal(fields(result).sandbox, 'off');
  assert.equal('sandboxNote' in fields(result), false);
});
