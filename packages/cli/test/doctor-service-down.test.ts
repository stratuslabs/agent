import './home-guard.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { installService, runCli, type ServiceRunner } from '../src/index.ts';

// With no daemon running, the one finding that explains everything else is
// that the service is down and why. A doctor run on a host whose daemon
// was down led with a stray-souls warning instead (AGT-364).

const quiet = { code: 0, stdout: '', stderr: '' };
const stopped = '\tstate = not running\n\truns = 4\n\tlast exit code = 1\n';
const errLogOf = (home: string): string => path.join(home, '.stratus', 'logs', 'stratusd.err.log');

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

/**
 * A home with the service installed and a config doctor has its own
 * complaint about (a key Stratus doesn't read), which is found before the
 * daemon is looked at.
 */
const installedHome = async (platform: 'darwin' | 'linux') => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus', 'agents'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'anthropic', model: 'claude-opus-5', colour: 'blue' }), { mode: 0o600 });
  await writeFile(path.join(home, '.stratus', 'credentials.json'), JSON.stringify({ anthropic: { type: 'api_key', value: 'sk-ant-stored' } }));
  const scriptPath = path.join(home, 'bin.js');
  await writeFile(scriptPath, '');
  const installed = await installService(
    {
      platform,
      homeDir: home,
      cwd: home,
      uid: 501,
      systemdBooted: true,
      scriptPath,
      execArgv: [],
      sleep: async () => {},
      run: async (command, args) => (command === 'launchctl' && args[0] === 'print'
        ? { code: 0, stdout: '\tstate = running\n', stderr: '' }
        : command === 'systemctl' && args.includes('is-active') ? { code: 0, stdout: 'active\n', stderr: '' } : quiet),
    },
    {},
  );
  assert.equal(installed.ok, true, installed.messages.join('\n'));
  return home;
};

const doctor = async (
  home: string,
  platform: 'darwin' | 'linux',
  serviceRunner: ServiceRunner,
  options: { format?: 'json'; fetch?: typeof fetch } = {},
) => {
  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['doctor', ...(options.format ? ['--format', options.format] : [])],
    streams,
    env: {
      homeDir: home,
      cwd: home,
      processEnv: {},
      servicePlatform: platform,
      serviceSystemdBooted: true,
      serviceRunner,
      serviceSleep: async () => {},
      ...(options.fetch ? { fetch: options.fetch } : {}),
    },
  });
  return { exitCode, output };
};

const problemsOf = (stdout: string): string[] => (JSON.parse(stdout) as { problems: string[] }).problems;

const launchdSays = (print: { code: number; stdout: string; stderr: string }): ServiceRunner => async (command, args) =>
  (command === 'launchctl' && args[0] === 'print' ? print : quiet);

test('doctor leads with a stopped LaunchAgent: its state and the end of its error log', async () => {
  const home = await installedHome('darwin');
  const lines = Array.from({ length: 30 }, (_, index) => `line ${index}`);
  await writeFile(errLogOf(home), `${lines.join('\n')}\nError: Cannot find module '/opt/homebrew/Cellar/node/26.1.0/lib/node_modules'\n`);

  const { exitCode, output } = await doctor(home, 'darwin', launchdSays({ code: 0, stdout: stopped, stderr: '' }), { format: 'json' });
  assert.equal(exitCode, 1);
  const problems = problemsOf(output.stdout);
  const first = problems[0] ?? '';
  assert.ok(first.startsWith('The stratusd service is installed'), first);
  assert.match(first, /launchd says it is not running/);
  assert.match(first, /It last exited with code 1/);
  assert.ok(first.includes(`The last lines of ${errLogOf(home)}:`), first);
  assert.ok(first.includes("Error: Cannot find module '/opt/homebrew/Cellar/node/26.1.0/lib/node_modules'"), first);
  // The end of the log, not all of it.
  assert.ok(first.includes('line 29'), first);
  assert.ok(!first.includes('line 10\n'), first);
  assert.match(first, /`stratus service start`/);
  // What doctor found first before still comes, after it.
  assert.ok(problems.slice(1).some((problem) => problem.includes('"colour"')), JSON.stringify(problems));
});

test('doctor shows the stopped service first in its text output, the log indented under it', async () => {
  const home = await installedHome('darwin');
  await writeFile(errLogOf(home), 'dyld[4242]: Library not loaded\n');

  const { exitCode, output } = await doctor(home, 'darwin', launchdSays({ code: 0, stdout: stopped, stderr: '' }));
  assert.equal(exitCode, 1);
  const found = output.stdout.slice(output.stdout.indexOf('problems found:'));
  const lines = found.split('\n');
  assert.match(lines[1] ?? '', /^ {2}! The stratusd service is installed/);
  assert.ok(lines.includes('      dyld[4242]: Library not loaded'), found);
});

test('doctor says launchd has not loaded the job, and does not repeat the remedy it gives', async () => {
  const home = await installedHome('darwin');
  const { output } = await doctor(home, 'darwin', launchdSays({
    code: 113,
    stdout: '',
    stderr: 'Could not find service "com.stratusagent.stratusd" in domain for user gui: 501\n',
  }), { format: 'json' });
  const first = problemsOf(output.stdout)[0] ?? '';
  assert.match(first, /launchd has not loaded the job/);
  assert.equal(first.split('`stratus service start`').length - 1, 1, first);
  assert.ok(first.includes(`Nothing has been written to ${errLogOf(home)}`), first);
});

test('doctor leads with the stopped service when gateway.json is left over from the daemon that died', async () => {
  const home = await installedHome('darwin');
  await writeFile(path.join(home, '.stratus', 'gateway-token'), 'doctor-token\n');
  await writeFile(path.join(home, '.stratus', 'gateway.json'), JSON.stringify({ url: 'http://127.0.0.1:9', host: '127.0.0.1', port: 9 }));
  const { output } = await doctor(home, 'darwin', launchdSays({ code: 0, stdout: stopped, stderr: '' }), {
    format: 'json',
    fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch,
  });
  const problems = problemsOf(output.stdout);
  assert.match(problems[0] ?? '', /^The stratusd service is installed/);
  assert.ok(problems.slice(1).some((problem) => problem.includes('did not answer /health')), JSON.stringify(problems));
});

test('doctor leads with a failed systemd unit and the end of its journal', async () => {
  const home = await installedHome('linux');
  const journalArgs: string[][] = [];
  const { output } = await doctor(home, 'linux', async (command, args) => {
    if (command === 'systemctl' && args.includes('is-active')) {
      return { code: 3, stdout: 'failed\n', stderr: '' };
    }
    if (command === 'systemctl' && args.includes('is-enabled')) {
      return { code: 0, stdout: 'enabled\n', stderr: '' };
    }
    if (command === 'journalctl') {
      journalArgs.push(args);
      return { code: 0, stdout: 'stratusd: config.json could not be parsed\n', stderr: '' };
    }
    return quiet;
  }, { format: 'json' });
  const first = problemsOf(output.stdout)[0] ?? '';
  assert.match(first, /^The stratusd service is installed/);
  assert.match(first, /systemd says it is not running/);
  assert.match(first, /systemd reports the unit failed/);
  assert.ok(first.includes('stratusd: config.json could not be parsed'), first);
  assert.equal(journalArgs.length, 1);
  // The last lines, whenever they were written: no start to measure from.
  assert.ok(!journalArgs[0]?.includes('--since'), JSON.stringify(journalArgs));
  assert.ok(journalArgs[0]?.includes('stratusd.service'), JSON.stringify(journalArgs));
});

test('doctor says nothing about the service when the manager says it is running', async () => {
  const home = await installedHome('darwin');
  const { output } = await doctor(home, 'darwin', launchdSays({ code: 0, stdout: '\tstate = running\n', stderr: '' }), { format: 'json' });
  assert.ok(!problemsOf(output.stdout).some((problem) => problem.includes('stratusd service')), output.stdout);
});

test('doctor does not call the service stopped when the manager does not answer', async () => {
  const home = await installedHome('darwin');
  const { output } = await doctor(home, 'darwin', launchdSays({ code: 1, stdout: '', stderr: 'launchctl: timed out' }), { format: 'json' });
  assert.ok(!problemsOf(output.stdout).some((problem) => problem.includes('stratusd service')), output.stdout);
});

test('doctor does not ask the manager about a daemon that answers /health', async () => {
  const home = await installedHome('darwin');
  await writeFile(path.join(home, '.stratus', 'gateway-token'), 'doctor-token\n');
  await writeFile(path.join(home, '.stratus', 'gateway.json'), JSON.stringify({ url: 'http://127.0.0.1:9', host: '127.0.0.1', port: 9 }));
  const asked: string[] = [];
  const { output } = await doctor(home, 'darwin', async (command, args) => {
    asked.push(`${command} ${args[0]}`);
    return { code: 0, stdout: stopped, stderr: '' };
  }, {
    format: 'json',
    fetch: (async () => new Response(JSON.stringify({ ok: true, version: '9.9.9' }), { status: 200 })) as typeof fetch,
  });
  assert.deepEqual(asked, []);
  assert.ok(!problemsOf(output.stdout).some((problem) => problem.includes('stratusd service')), output.stdout);
});
