import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  CLI_VERSION,
  compareVersions,
  installService,
  parseCommand,
  readServiceCommand,
  runCli,
  serviceUnitPath,
  type ServiceRunner,
} from '../src/index.ts';
import {
  credentialsPath,
  readStateStamp,
  runStateMigrations,
  STATE_SCHEMA_VERSION,
  stateFilePath,
} from '@stratusagent/state';

const freshHome = () => mkdtemp(path.join(os.tmpdir(), 'stratus-update-'));

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

// Answers as a manager whose job is loaded and running, on either platform —
// tests must not depend on which OS the suite happens to run on.
const runningServiceRunner: ServiceRunner = async (command, args) => {
  if (command === 'launchctl' && args[0] === 'print') {
    return { code: 0, stdout: 'state = running', stderr: '' };
  }
  if (command === 'systemctl' && args.includes('is-active')) {
    return { code: 0, stdout: 'active', stderr: '' };
  }
  if (command === 'systemctl' && args.includes('is-enabled')) {
    return { code: 0, stdout: 'enabled', stderr: '' };
  }
  return { code: 0, stdout: '', stderr: '' };
};

test('parseCommand understands update and update --check', () => {
  assert.deepEqual(parseCommand(['update']), { command: 'update', check: false });
  assert.deepEqual(parseCommand(['update', '--check']), { command: 'update', check: true });
  assert.deepEqual(parseCommand(['update', '--help']), { command: 'help' });
  assert.throws(() => parseCommand(['update', '--force']), /Unknown option/);
});

test('compareVersions orders dotted versions numerically, not lexically', () => {
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.ok(compareVersions('v1.2.4', '1.2.3') > 0);
  // Garbage from the registry compares as zero segments instead of throwing.
  assert.equal(compareVersions('nonsense', '0.0.0'), 0);
});

test('readServiceCommand round-trips what installService wrote, on both platforms', async () => {
  for (const platform of ['darwin', 'linux'] as const) {
    const home = await freshHome();
    // Paths with % and $ are the reason the unit writers escape; the parser
    // must reverse exactly that.
    const execPath = path.join(home, '100% node', '$HOME-v22', 'node');
    const scriptPath = path.join(home, 'lib', 'bin.js');
    const configPath = path.join(home, 'stratus.config.json');
    const env = { platform, homeDir: home, cwd: home, execPath, scriptPath, execArgv: [], run: runningServiceRunner };
    const installed = await installService(env, { configPath });
    assert.equal(installed.ok, true, installed.messages.join('\n'));

    const command = await readServiceCommand(env);
    assert.ok(command, `no command parsed back from the ${platform} unit`);
    assert.equal(command.execPath, execPath);
    assert.equal(command.scriptPath, scriptPath);
    assert.equal(command.configPath, configPath);
    assert.equal(command.argv[0], execPath);
  }
});

test('update --check reports what it would do and exits 1 only when something is actionable', async () => {
  const home = await freshHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };

  const actionable = createStreams();
  const first = await runCli({
    argv: ['update', '--check'],
    streams: actionable.streams,
    env: { ...env, serviceRunner: runningServiceRunner, packageVersionFetcher: async () => '99.0.0' },
  });
  assert.equal(first, 1);
  assert.match(actionable.output.stdout, /update available/);
  assert.match(actionable.output.stdout, /pending migration/);
  // --check does none of it: no stamp was written.
  await assert.rejects(() => stat(stateFilePath(env)));

  await runStateMigrations(env);
  const settled = createStreams();
  const second = await runCli({
    argv: ['update', '--check'],
    streams: settled.streams,
    env: { ...env, serviceRunner: runningServiceRunner, packageVersionFetcher: async () => CLI_VERSION },
  });
  assert.equal(second, 0);
  assert.match(settled.output.stdout, /Nothing to do/);
});

test('update stops the service, upgrades, migrates, rewrites the unit with current paths, and preserves its config pin', async () => {
  const home = await freshHome();
  const configPath = path.join(home, 'pinned.config.json');
  await writeFile(configPath, '{}');
  // A unit installed by an older world: a node path that no longer exists.
  const staleNode = path.join(home, 'nvm', 'v20.0.0', 'node');
  const seeded = await installService(
    { homeDir: home, cwd: home, execPath: staleNode, scriptPath: path.join(home, 'old-bin.js'), execArgv: [], run: runningServiceRunner },
    { configPath },
  );
  assert.equal(seeded.ok, true, seeded.messages.join('\n'));

  const installs: string[][] = [];
  const { streams, output } = createStreams();
  const code = await runCli({
    argv: ['update'],
    streams,
    env: {
      homeDir: home,
      cwd: home,
      processEnv: {},
      serviceRunner: runningServiceRunner,
      packageVersionFetcher: async () => '99.0.0',
      packageInstaller: async (packages) => {
        installs.push(packages);
        return { ok: true, message: '' };
      },
    },
  });
  assert.equal(code, 0, `update failed:\n${output.stdout}\n${output.stderr}`);

  // The service stops before anything migrates or upgrades — the bracket
  // that keeps a live daemon from holding the session database mid-change.
  const stopAt = output.stdout.indexOf('Stopping stratusd');
  const upgradeAt = output.stdout.indexOf('Upgrading @stratusagent/cli');
  const rewriteAt = output.stdout.indexOf('Rewriting the service unit');
  assert.ok(stopAt !== -1 && upgradeAt !== -1 && rewriteAt !== -1, output.stdout);
  assert.ok(stopAt < upgradeAt && upgradeAt < rewriteAt, 'steps ran out of order');
  assert.deepEqual(installs, [['@stratusagent/cli@latest']]);

  // The unit now names this process's interpreter, and kept its config pin.
  const rewritten = await readServiceCommand({ homeDir: home, cwd: home, run: runningServiceRunner });
  assert.ok(rewritten);
  assert.equal(rewritten.execPath, process.execPath);
  assert.equal(rewritten.configPath, configPath);
  assert.ok(!(await readFile(serviceUnitPath({ homeDir: home }), 'utf8')).includes(staleNode));

  // Migrations ran and stamped the home directory.
  assert.equal((await readStateStamp({ homeDir: home })).schemaVersion, STATE_SCHEMA_VERSION);
});

test('an unreachable npm still migrates and repairs the unit — the offline case is the repair case', async () => {
  const home = await freshHome();
  await installService(
    { homeDir: home, cwd: home, execPath: path.join(home, 'gone-node'), scriptPath: path.join(home, 'gone.js'), execArgv: [], run: runningServiceRunner },
    {},
  );

  const { streams, output } = createStreams();
  const code = await runCli({
    argv: ['update'],
    streams,
    env: {
      homeDir: home,
      cwd: home,
      processEnv: {},
      serviceRunner: runningServiceRunner,
      packageVersionFetcher: async () => undefined,
      packageInstaller: async () => {
        throw new Error('npm must not be invoked when the registry did not answer');
      },
    },
  });
  assert.equal(code, 0, output.stderr);
  assert.match(output.stdout, /npm did not answer/);
  assert.match(output.stdout, /Rewriting the service unit/);
  const rewritten = await readServiceCommand({ homeDir: home, cwd: home, run: runningServiceRunner });
  assert.equal(rewritten?.execPath, process.execPath);
});

test('every command migrates on first use of a newer build, and serve refuses newer state', async () => {
  const home = await freshHome();
  const loose = credentialsPath({ homeDir: home });
  await mkdir(path.dirname(loose), { recursive: true });
  await writeFile(loose, '{}');
  await chmod(loose, 0o644);

  const agents = createStreams();
  const listed = await runCli({
    argv: ['agents'],
    streams: agents.streams,
    env: { homeDir: home, cwd: home, processEnv: {} },
  });
  assert.equal(listed, 0);
  assert.match(agents.output.stderr, /state migration 0001-owner-only-state-files/);
  assert.equal((await stat(loose)).mode & 0o777, 0o600);
  assert.equal((await readStateStamp({ homeDir: home })).schemaVersion, STATE_SCHEMA_VERSION);

  // State written by a newer build: ordinary commands warn and continue…
  await writeFile(stateFilePath({ homeDir: home }), JSON.stringify({ schemaVersion: STATE_SCHEMA_VERSION + 1, applied: [] }));
  const warned = createStreams();
  assert.equal(await runCli({
    argv: ['agents'],
    streams: warned.streams,
    env: { homeDir: home, cwd: home, processEnv: {} },
  }), 0);
  assert.match(warned.output.stderr, /newer Stratus build/);

  // …while the daemon refuses outright rather than guessing at a format it
  // was not written for.
  const refused = createStreams();
  assert.equal(await runCli({
    argv: ['serve'],
    streams: refused.streams,
    env: { homeDir: home, cwd: home, processEnv: {} },
  }), 1);
  assert.match(refused.output.stderr, /newer Stratus build/);
});

test('doctor names a unit whose interpreter no longer exists', async () => {
  const home = await freshHome();
  await installService(
    { homeDir: home, cwd: home, execPath: path.join(home, 'nvm', 'v20.0.0', 'node'), scriptPath: path.join(home, 'bin.js'), execArgv: [], run: runningServiceRunner },
    {},
  );

  const { streams, output } = createStreams();
  await runCli({
    argv: ['doctor', '--format', 'json'],
    streams,
    env: { homeDir: home, cwd: home, processEnv: {}, serviceRunner: runningServiceRunner },
  });
  const report = JSON.parse(output.stdout) as { problems: string[] };
  assert.ok(
    report.problems.some((problem) => problem.includes('interpreter that no longer exists')),
    `expected a stale-interpreter problem, got: ${JSON.stringify(report.problems)}`,
  );
});
