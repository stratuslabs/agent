import './home-guard.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { installService, runCli, startService } from '../src/index.ts';

// A daemon the service manager starts can still die a moment later: a
// dyld error, a native module built for another node. Products on Nov 12
// printed "stratusd started" over exactly that (AGT-363).

const quiet = { code: 0, stdout: '', stderr: '' };

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

const errLogOf = (home: string): string => path.join(home, '.stratus', 'logs', 'stratusd.err.log');
const gatewayInfoOf = (home: string): string => path.join(home, '.stratus', 'gateway.json');

/**
 * launchd, as it answers around a start: nothing is loaded until `trigger`
 * (kickstart, or bootstrap for an install that starts at load), then each
 * `launchctl print` takes the next of `states`, the last repeating.
 * `onStart` runs at the trigger, as the daemon would.
 */
const launchd = (trigger: 'kickstart' | 'bootstrap', states: string[], onStart: () => Promise<void> = async () => {}) => {
  let started = false;
  let asked = 0;
  return async (command: string, args: string[]) => {
    if (command === 'launchctl' && args[0] === trigger) {
      started = true;
      await onStart();
    }
    if (command === 'launchctl' && args[0] === 'print' && started) {
      const state = states[Math.min(asked, states.length - 1)] ?? '';
      asked += 1;
      return { code: 0, stdout: state, stderr: '' };
    }
    return quiet;
  };
};

const running = '\tstate = running\n\truns = 1\n\tpid = 4242\n';
const exited = '\tstate = not running\n\truns = 1\n\tlast exit code = 134\n';

const installedHome = async (): Promise<string> => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await installService({ platform: 'darwin', homeDir: home, uid: 501, sleep: async () => {}, run: launchd('bootstrap', [running]) });
  return home;
};

test('stratus service start exits 1 and shows what stratusd wrote when it dies right after launchd starts it', async () => {
  const home = await installedHome();
  await writeFile(errLogOf(home), 'an older run: a problem fixed long ago\n');
  const noise = Array.from({ length: 300 }, (_, index) => `noise ${index}`).join('\n');
  const dyld = 'dyld[4242]: Library not loaded: /opt/homebrew/opt/icu4c/lib/libicuuc.76.dylib';

  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['service', 'start'],
    streams,
    env: {
      cwd: home,
      homeDir: home,
      processEnv: {},
      servicePlatform: 'darwin',
      serviceSleep: async () => {},
      // launchd says running at the first ask, the way it did on Products,
      // and not running once the process has died.
      serviceRunner: launchd('kickstart', [running, exited], async () => {
        await appendFile(errLogOf(home), `${noise}\n${dyld}\n`);
      }),
    },
  });

  assert.equal(exitCode, 1, output.stdout);
  assert.doesNotMatch(output.stdout, /stratusd started/);
  assert.match(output.stderr, /launchd started stratusd, but it exited/);
  assert.match(output.stderr, /last exited with code 134/);
  assert.ok(output.stderr.includes(`  ${dyld}`), output.stderr);
  // Only this start's output, and only its end.
  assert.doesNotMatch(output.stderr, /an older run/);
  const shown = output.stderr.split('\n').filter((line) => line.startsWith('  '));
  assert.equal(shown.length, 20, output.stderr);
  assert.equal(shown.at(-1), `  ${dyld}`);
  assert.ok(shown.every((line) => line === `  ${dyld}` || /^ {2}noise \d+$/.test(line)), output.stderr);
});

test('service start reports started as soon as the new daemon publishes its address', async () => {
  const home = await installedHome();
  const slept: number[] = [];
  const result = await startService({
    platform: 'darwin',
    homeDir: home,
    uid: 501,
    sleep: async (ms) => { slept.push(ms); },
    run: launchd('kickstart', [running], async () => {
      await writeFile(gatewayInfoOf(home), JSON.stringify({ url: 'http://127.0.0.1:7777', pid: 4242, startedAt: new Date().toISOString() }));
    }),
  });

  assert.equal(result.running, true);
  assert.deepEqual(result.messages, ['stratusd started.']);
  assert.equal(slept.length, 0, 'nothing left to wait for');
});

test('service start does not take a published address from a daemon that died after publishing it', async () => {
  // gateway.json outlives a crash in a later startup step (a channel, the
  // scheduler), so the manager is asked again after the file is seen.
  const home = await installedHome();
  const result = await startService({
    platform: 'darwin',
    homeDir: home,
    uid: 501,
    sleep: async () => {},
    run: launchd('kickstart', [running, exited], async () => {
      await writeFile(gatewayInfoOf(home), JSON.stringify({ url: 'http://127.0.0.1:7777', pid: 4242, startedAt: new Date().toISOString() }));
    }),
  });

  assert.equal(result.running, false);
  assert.match(result.messages.join('\n'), /launchd started stratusd, but it exited during startup/);
});

test('service start keeps watching a daemon that has not published an address, and calls it started if it stays up', async () => {
  // A daemon with no control API never writes gateway.json, and the file a
  // dead one left behind says nothing about this start.
  const home = await installedHome();
  await writeFile(gatewayInfoOf(home), JSON.stringify({ url: 'http://127.0.0.1:7777', pid: 1, startedAt: new Date(Date.now() - 3_600_000).toISOString() }));
  const slept: number[] = [];
  const result = await startService({
    platform: 'darwin',
    homeDir: home,
    uid: 501,
    sleep: async (ms) => { slept.push(ms); },
    run: launchd('kickstart', [running]),
  });

  assert.equal(result.running, true);
  assert.deepEqual(result.messages, ['stratusd started.']);
  assert.equal(slept.length, 10, 'about five seconds of asking');
});

test('service install does not call a LaunchAgent that exits during startup running, and says when it wrote nothing', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.dirname(errLogOf(home)), { recursive: true });
  await writeFile(errLogOf(home), 'an older run: a problem fixed long ago\n');
  const result = await installService({
    platform: 'darwin',
    homeDir: home,
    uid: 501,
    sleep: async () => {},
    run: launchd('bootstrap', [running, running, exited]),
  });

  assert.equal(result.ok, true, 'launchd accepted the job, so the unit is installed');
  assert.equal(result.running, false);
  const text = result.messages.join('\n');
  assert.doesNotMatch(text, /stratusd is running/);
  assert.match(text, /launchd started stratusd, but it exited/);
  assert.ok(text.includes(`Nothing was written to ${errLogOf(home)} since this start`), text);
  assert.doesNotMatch(text, /an older run/);
});

test('service start shows the journal for a systemd unit that exits during startup', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await installService({ platform: 'linux', homeDir: home, sleep: async () => {}, systemdBooted: true, run: async (command, args) => (args.includes('is-active') ? { ...quiet, stdout: 'active\n' } : quiet) });
  const calls: string[][] = [];
  let asked = 0;
  const before = Math.floor(Date.now() / 1000);
  const result = await startService({
    platform: 'linux',
    homeDir: home,
    systemdBooted: true,
    sleep: async () => {},
    run: async (command, args) => {
      calls.push([command, ...args]);
      if (args.includes('is-active')) {
        // Restart=on-failure: after an exit, systemd waits RestartSec in
        // `activating (auto-restart)`.
        asked += 1;
        return { ...quiet, stdout: asked === 1 ? 'active\n' : 'activating\n' };
      }
      if (command === 'journalctl') {
        return { ...quiet, stdout: "Error: Cannot find module 'better-sqlite3'\n" };
      }
      return quiet;
    },
  });

  assert.equal(result.running, false);
  const text = result.messages.join('\n');
  assert.match(text, /systemd started stratusd, but it exited/);
  assert.ok(text.includes("  Error: Cannot find module 'better-sqlite3'"), text);
  assert.match(text, /journalctl --user -u stratusd\.service/);
  assert.ok(!text.includes('stratusd.err.log'), 'systemd keeps stderr in the journal, not that file');
  const journal = calls.find(([command]) => command === 'journalctl');
  assert.ok(journal, calls.map((call) => call.join(' ')).join('\n'));
  const since = journal[journal.indexOf('--since') + 1] ?? '';
  assert.match(since, /^@\d+$/);
  assert.ok(Number(since.slice(1)) >= before - 1, since);
});
