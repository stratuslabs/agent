import './home-guard.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { installService } from '../src/index.ts';

// launchd refuses to bootstrap a label it still has loaded, and on current
// macOS that refusal reads "Bootstrap failed: 5: Input/output error". An
// install during a node upgrade hit it and gave up, leaving the fix to
// manual launchctl work (AGT-364).

const quiet = { code: 0, stdout: '', stderr: '' };
const stillLoaded = { code: 0, stdout: '\tstate = not running\n\truns = 3\n\tlast exit code = 1\n', stderr: '' };
const notLoaded = { code: 113, stdout: '', stderr: 'Could not find service "com.stratusagent.stratusd" in domain for user gui: 501\n' };
const running = { code: 0, stdout: '\tstate = running\n\truns = 1\n\tpid = 4242\n', stderr: '' };
const ioError = { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error\n' };

/**
 * launchd around an install whose first bootstrap is refused: `bootstraps`
 * answers each bootstrap in turn; before one succeeds, `launchctl print`
 * reports the old job still loaded for `lingers` asks after the second
 * bootout, then gone; after it, running.
 */
const launchd = (bootstraps: Array<typeof quiet>, lingers = 0) => {
  const calls: string[] = [];
  let bootouts = 0;
  let loaded = false;
  let asksSinceBootout = 0;
  const run = async (command: string, args: string[]) => {
    calls.push(`${command} ${args[0]}`);
    if (command !== 'launchctl') {
      return quiet;
    }
    if (args[0] === 'bootout') {
      bootouts += 1;
      asksSinceBootout = 0;
      return quiet;
    }
    if (args[0] === 'bootstrap') {
      const answer = bootstraps[Math.min(calls.filter((call) => call === 'launchctl bootstrap').length - 1, bootstraps.length - 1)] ?? quiet;
      loaded = answer.code === 0;
      return answer;
    }
    if (args[0] === 'print') {
      if (loaded) {
        return running;
      }
      if (bootouts < 2) {
        // Before the retry's bootout: whose job is loaded (install's first
        // question) reads as nothing, so install goes ahead.
        return notLoaded;
      }
      asksSinceBootout += 1;
      return asksSinceBootout <= lingers ? stillLoaded : notLoaded;
    }
    return quiet;
  };
  return { calls, run };
};

const home = () => mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));

test('service install boots out a job launchd still has loaded and bootstraps again on error 5', async () => {
  const { calls, run } = launchd([ioError, quiet], 2);
  const slept: number[] = [];
  const result = await installService({ platform: 'darwin', homeDir: await home(), uid: 501, sleep: async (ms) => { slept.push(ms); }, run });

  assert.equal(result.ok, true, result.messages.join('\n'));
  assert.equal(result.running, true, result.messages.join('\n'));
  assert.deepEqual(calls.slice(0, 8), [
    'launchctl print',
    'launchctl bootout',
    'launchctl bootstrap',
    // The retry: out again, wait until launchd has let go of the label, in.
    'launchctl bootout',
    'launchctl print',
    'launchctl print',
    'launchctl print',
    'launchctl bootstrap',
  ]);
  assert.equal(calls.filter((call) => call === 'launchctl bootstrap').length, 2);
  // Two asks found it still loaded, each followed by a wait; then the watch after the start.
  assert.deepEqual(slept.slice(0, 2), [500, 500]);
  const text = result.messages.join('\n');
  assert.match(text, /error 5/);
  assert.match(text, /stratusd is running/);
  assert.doesNotMatch(text, /bootstrap failed/);
});

test('service install bootstraps again straight away when launchd no longer has the old job', async () => {
  const { calls, run } = launchd([ioError, quiet], 0);
  const slept: number[] = [];
  const result = await installService({ platform: 'darwin', homeDir: await home(), uid: 501, sleep: async (ms) => { slept.push(ms); }, run });

  assert.equal(result.ok, true, result.messages.join('\n'));
  assert.deepEqual(calls.slice(2, 6), ['launchctl bootstrap', 'launchctl bootout', 'launchctl print', 'launchctl bootstrap']);
  // No wait before the second bootstrap; only the start watch sleeps.
  assert.equal(slept.length, 10);
});

test('service install retries error 5 once, then reports it with what it tried', async () => {
  const { calls, run } = launchd([ioError, ioError], 0);
  const result = await installService({ platform: 'darwin', homeDir: await home(), uid: 501, sleep: async () => {}, run });

  assert.equal(result.ok, false);
  assert.equal(calls.filter((call) => call === 'launchctl bootstrap').length, 2, calls.join('\n'));
  const text = result.messages.join('\n');
  assert.match(text, /launchctl bootstrap failed: Bootstrap failed: 5: Input\/output error/);
  assert.match(text, /again after booting out the old job/);
  // Nothing was left loaded, so the message does not blame a leftover job.
  assert.doesNotMatch(text, /still had it loaded/);
});

test('service install stops waiting for a job that never unloads, tries once more, and says it was still loaded', async () => {
  const { calls, run } = launchd([ioError, ioError], Number.POSITIVE_INFINITY);
  const slept: number[] = [];
  const result = await installService({ platform: 'darwin', homeDir: await home(), uid: 501, sleep: async (ms) => { slept.push(ms); }, run });

  assert.equal(result.ok, false);
  assert.equal(calls.filter((call) => call === 'launchctl bootstrap').length, 2);
  // Bounded by the unit's stop timeout (launchd kills the job by then) plus
  // a margin: 80s of half-second asks.
  assert.equal(slept.length, 160);
  const text = result.messages.join('\n');
  assert.match(text, /still had it loaded 80s later/);
  assert.match(text, /launchctl print gui\/501\/com\.stratusagent\.stratusd/);
});

test('service install does not retry a bootstrap failure other than error 5', async () => {
  const invalid = { code: 22, stdout: '', stderr: 'Bootstrap failed: 22: Invalid argument\n' };
  const { calls, run } = launchd([invalid, quiet], 0);
  const result = await installService({ platform: 'darwin', homeDir: await home(), uid: 501, sleep: async () => {}, run });

  assert.equal(result.ok, false);
  assert.equal(calls.filter((call) => call === 'launchctl bootstrap').length, 1);
  assert.match(result.messages.join('\n'), /launchctl bootstrap failed: Bootstrap failed: 22: Invalid argument/);
});

test('service install stops waiting when launchd does not answer, and still tries once more', async () => {
  const { calls, run } = launchd([ioError, quiet], 0);
  let printsAfterRetry = 0;
  const slept: number[] = [];
  const result = await installService({
    platform: 'darwin',
    homeDir: await home(),
    uid: 501,
    sleep: async (ms) => { slept.push(ms); },
    run: async (command, args) => {
      const bootouts = calls.filter((call) => call === 'launchctl bootout').length;
      const bootstraps = calls.filter((call) => call === 'launchctl bootstrap').length;
      if (command === 'launchctl' && args[0] === 'print' && bootouts === 2 && bootstraps === 1) {
        printsAfterRetry += 1;
        calls.push('launchctl print');
        return { code: 1, stdout: '', stderr: 'launchctl: timed out' };
      }
      return run(command, args);
    },
  });

  assert.equal(result.ok, true, result.messages.join('\n'));
  assert.equal(printsAfterRetry, 1, 'a manager that does not answer is not asked again and again');
  assert.equal(calls.filter((call) => call === 'launchctl bootstrap').length, 2);
});
