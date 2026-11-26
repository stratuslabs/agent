import './home-guard.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { runCli } from '../src/index.ts';

const createStreams = () => {
  let stdout = '';
  let stderr = '';
  return {
    streams: {
      stdout: { write(chunk: string) { stdout += chunk; return true; } },
      stderr: { write(chunk: string) { stderr += chunk; return true; } },
    },
    output: {
      get stdout() { return stdout; },
      get stderr() { return stderr; },
    },
  };
};

const exists = (file: string): Promise<boolean> => readFile(file).then(() => true, () => false);

/** Runs `stratus setup` on a fresh home with a service manager that records every call. */
const setupWith = async (setupInput: Readable) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const calls: string[] = [];
  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      servicePlatform: 'darwin',
      serviceRunner: async (command: string, args: string[]) => {
        calls.push([command, ...args].join(' '));
        return { code: 0, stdout: command === 'launchctl' && args[0] === 'print' ? '\tstate = running\n' : '', stderr: '' };
      },
      serviceSleep: async () => {},
      setupInput,
    },
  });
  return { home, exitCode, output, calls };
};

test('setup whose input ends before any answer saves nothing and leaves the service alone', async () => {
  // `stratus setup </dev/null`: no answer was ever given, so nobody chose a
  // provider, an agent, or an always-on service.
  for (const input of [Readable.from([]), Readable.from([''])]) {
    const { home, exitCode, output, calls } = await setupWith(input);
    assert.equal(exitCode, 1, output.stdout);
    assert.match(
      output.stderr,
      /^Setup needs a terminal, or its answers on stdin\. The input ended before the first answer, so nothing was saved\.$/m,
    );
    assert.equal(await exists(path.join(home, '.stratus', 'config.json')), false);
    assert.deepEqual(await readdir(path.join(home, '.stratus', 'agents')).catch(() => []), []);
    assert.deepEqual(calls.filter((call) => !call.startsWith('launchctl print')), []);
    assert.doesNotMatch(output.stdout, /Created Stratus|Saved/);
  }
});

test('setup with scripted answers that end without Save & finish still saves them', async () => {
  // Providers → Demo, then the input ends: an answer was given, so the
  // ending saves it, as before.
  const { home, exitCode, output } = await setupWith(Readable.from(['1\n', 'demo\n']));
  assert.equal(exitCode, 0, output.stderr);
  const config = JSON.parse(await readFile(path.join(home, '.stratus', 'config.json'), 'utf8')) as { provider?: string };
  assert.equal(config.provider, 'demo');
  assert.doesNotMatch(output.stderr, /needs a terminal/);
});
