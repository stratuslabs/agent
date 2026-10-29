import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { watchOutputReader } from '../src/io.ts';
import { createLogWriter } from '../src/logs.ts';

const packageDir = fileURLToPath(new URL('..', import.meta.url));

const pipeError = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`write ${code}`), { code, syscall: 'write' });

/**
 * A home whose daemon log already holds `count` records, so `stratus logs`
 * makes one write per record: the first one finds the reader gone and every
 * later one is a write to a stream that already failed.
 */
const homeWithLogRecords = async (count: number): Promise<string> => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-closed-output-'));
  const dir = path.join(home, '.stratus', 'logs');
  await mkdir(dir, { recursive: true });
  const writer = createLogWriter({ dir });
  for (let index = 0; index < count; index += 1) {
    await writer.write({ ts: new Date(index * 1000).toISOString(), level: 'info', msg: `record ${index}` });
  }
  return home;
};

/**
 * Runs the source bin with its stdout reader closed before the child can
 * write — what `stratus … | grep -q x` is once grep has matched, or
 * `| true` from the start. Resolves with the exit code, or `'killed'` when
 * the command was still running after `limitMs`: the losing outcome for a
 * command that should have noticed the reader was gone.
 */
const runWithClosedReader = async (
  argv: string[],
  home: string,
  limitMs = 20_000,
): Promise<{ exit: number | 'killed'; stderr: string }> => {
  const child = spawn(process.execPath, ['--experimental-strip-types', './src/bin.ts', ...argv], {
    cwd: packageDir,
    env: { ...process.env, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.destroy();
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  let killed = false;
  const limit = setTimeout(() => {
    killed = true;
    child.kill('SIGKILL');
  }, limitMs);
  const [code] = (await once(child, 'close')) as [number | null];
  clearTimeout(limit);
  return { exit: killed ? 'killed' : code ?? -1, stderr };
};

/** stderr may carry a first start's migration notice; it must not carry the crash. */
const assertNoCrash = (stderr: string): void => {
  assert.doesNotMatch(stderr, /EPIPE/);
  assert.doesNotMatch(stderr, /^\s+at /m);
};

test('a reader that closed the pipe aborts the output signal instead of throwing', () => {
  const stream = new EventEmitter();
  const closed = watchOutputReader(stream);

  assert.equal(closed.aborted, false);
  stream.emit('error', pipeError('EPIPE'));
  assert.equal(closed.aborted, true);
  // Every later write to the failed stream is dropped the same way.
  stream.emit('error', pipeError('EPIPE'));
});

test('any other output error still fails loudly', () => {
  // A full disk or a dead terminal is not someone who stopped reading: the
  // output they asked for did not arrive, so it stays an exception.
  const stream = new EventEmitter();
  const closed = watchOutputReader(stream);

  assert.throws(() => stream.emit('error', pipeError('ENOSPC')), { code: 'ENOSPC' });
  assert.equal(closed.aborted, false);
});

test('a command piped into a reader that stops early exits with its own code and no stack trace', async () => {
  const home = await homeWithLogRecords(200);

  const { exit, stderr } = await runWithClosedReader(['logs', '-n', '200'], home);

  assert.equal(exit, 0);
  assertNoCrash(stderr);
});

test('following the log stops once nobody reads it', async () => {
  // `stratus logs -f | grep -m1 x` has to end after grep does. Dropping the
  // output alone would leave a follower that never finishes on its own
  // writing into the void forever, and the pipeline waiting on it.
  const home = await homeWithLogRecords(5);

  const { exit, stderr } = await runWithClosedReader(['logs', '-f', '-n', '5'], home);

  assert.equal(exit, 0);
  assertNoCrash(stderr);
});
