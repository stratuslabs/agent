import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  CLI_VERSION,
  compareVersions,
  installService,
  parseCommand,
  readServiceCommand,
  readServiceStatus,
  runCli,
  serviceUnitPath,
  startService,
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

test('readServiceCommand does not mistake a node option operand for the entrypoint', async () => {
  const home = await freshHome();
  const scriptPath = path.join(home, 'lib', 'bin.js');
  const env = {
    platform: 'linux' as const,
    homeDir: home,
    cwd: home,
    execPath: path.join(home, 'node'),
    scriptPath,
    // A node option whose value is its own argv element — exactly the
    // shape execArgv copies into the unit verbatim.
    execArgv: ['--require', path.join(home, 'preload.cjs')],
    run: runningServiceRunner,
  };
  await installService(env, {});
  const command = await readServiceCommand(env);
  assert.equal(command?.scriptPath, scriptPath);
});

test('update refuses to rewrite the unit when the login setting cannot be determined', async () => {
  const home = await freshHome();
  // is-enabled answers garbage — a broken user bus, a timeout — so
  // readServiceStatus reports runAtLogin undefined on systemd.
  const undecidedRunner: ServiceRunner = async (command, args) => {
    if (command === 'systemctl' && args.includes('is-active')) {
      return { code: 0, stdout: 'active', stderr: '' };
    }
    if (command === 'systemctl' && args.includes('is-enabled')) {
      return { code: 124, stdout: '', stderr: 'did not respond' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  await installService(
    { platform: 'linux', homeDir: home, cwd: home, execPath: path.join(home, 'node'), scriptPath: path.join(home, 'bin.js'), execArgv: [], run: undecidedRunner },
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
      servicePlatform: 'linux',
      serviceRunner: undecidedRunner,
      packageVersionFetcher: async () => CLI_VERSION,
    },
  });
  assert.equal(code, 1);
  assert.match(output.stderr, /starts at login could not be determined/);
  // Refused before anything had a side effect: the daemon was not stopped.
  assert.ok(!output.stdout.includes('Stopping stratusd'), output.stdout);
});

test('update fails loudly when it cannot restore a deliberately stopped daemon', async () => {
  const home = await freshHome();
  const stoppedRunner: ServiceRunner = async (command, args) => {
    if (command === 'systemctl' && args.includes('is-active')) {
      return { code: 0, stdout: 'inactive', stderr: '' };
    }
    if (command === 'systemctl' && args.includes('is-enabled')) {
      return { code: 0, stdout: 'enabled', stderr: '' };
    }
    if (command === 'systemctl' && args.includes('stop')) {
      return { code: 1, stdout: '', stderr: 'stop refused' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  await installService(
    { platform: 'linux', homeDir: home, cwd: home, execPath: path.join(home, 'node'), scriptPath: path.join(home, 'bin.js'), execArgv: [], run: stoppedRunner },
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
      servicePlatform: 'linux',
      serviceRunner: stoppedRunner,
      packageVersionFetcher: async () => CLI_VERSION,
    },
  });
  // The unit was rewritten and the daemon started, but the prior stopped
  // state was not restored — a script must see that as a failure.
  assert.equal(code, 1);
  assert.match(output.stderr, /now RUNNING/);
});

test('update and --check treat state from a newer build as a refusal, before any side effect', async () => {
  const home = await freshHome();
  await runStateMigrations({ homeDir: home });
  await writeFile(stateFilePath({ homeDir: home }), JSON.stringify({
    schemaVersion: STATE_SCHEMA_VERSION + 1,
    // Every known migration already applied — the case where pending-only
    // logic would report "Nothing to do".
    applied: ['0001-owner-only-state-files'],
  }));
  const env = {
    homeDir: home,
    cwd: home,
    processEnv: {},
    serviceRunner: runningServiceRunner,
    packageVersionFetcher: async () => CLI_VERSION,
  };

  const check = createStreams();
  assert.equal(await runCli({ argv: ['update', '--check'], streams: check.streams, env }), 1);
  assert.match(check.output.stdout, /NEWER build/);
  assert.doesNotMatch(check.output.stdout, /Nothing to do/);

  const full = createStreams();
  const code = await runCli({ argv: ['update'], streams: full.streams, env });
  assert.equal(code, 1);
  assert.match(full.output.stderr, /newer Stratus build/);
  assert.ok(!full.output.stdout.includes('Stopping stratusd'), 'refusal must come before the service stop');
});

test('the unit rewrite preserves the working directory the daemon was installed with', async () => {
  const home = await freshHome();
  const projectDir = path.join(home, 'projects', 'fleet');
  await mkdir(projectDir, { recursive: true });
  // Installed from a project directory — relative paths in the pinned
  // config resolve against it.
  await installService(
    { platform: 'linux', homeDir: home, cwd: projectDir, execPath: path.join(home, 'node'), scriptPath: path.join(home, 'bin.js'), execArgv: [], run: runningServiceRunner },
    {},
  );
  const before = await readServiceCommand({ platform: 'linux', homeDir: home });
  assert.equal(before?.workingDirectory, projectDir);

  const elsewhere = path.join(home, 'somewhere-else');
  await mkdir(elsewhere, { recursive: true });
  const { streams, output } = createStreams();
  const code = await runCli({
    argv: ['update'],
    streams,
    env: {
      homeDir: home,
      cwd: elsewhere, // the update runs from a different directory
      processEnv: {},
      servicePlatform: 'linux',
      serviceRunner: runningServiceRunner,
      packageVersionFetcher: async () => CLI_VERSION,
    },
  });
  assert.equal(code, 0, output.stderr);
  const after = await readServiceCommand({ platform: 'linux', homeDir: home });
  assert.equal(after?.workingDirectory, projectDir, 'the rewrite must not substitute its own cwd');
});

test('a migration failure after the service stop restarts the daemon on its previous unit', async () => {
  const home = await freshHome();
  const starts: string[][] = [];
  const runner: ServiceRunner = async (command, args) => {
    if (command === 'systemctl' && args.includes('is-active')) {
      return { code: 0, stdout: 'active', stderr: '' };
    }
    if (command === 'systemctl' && args.includes('is-enabled')) {
      return { code: 0, stdout: 'enabled', stderr: '' };
    }
    if (command === 'systemctl' && args.includes('restart')) {
      starts.push([command, ...args]);
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  await installService(
    { platform: 'linux', homeDir: home, cwd: home, execPath: path.join(home, 'node'), scriptPath: path.join(home, 'bin.js'), execArgv: [], run: runner },
    {},
  );
  // Make the migration itself throw after the stop: a self-referential
  // symlink makes the owner-only migration's stat fail with ELOOP — works
  // whoever runs the test, root included, where permission bits would not.
  await mkdir(path.dirname(credentialsPath({ homeDir: home })), { recursive: true });
  await symlink(credentialsPath({ homeDir: home }), credentialsPath({ homeDir: home }));

  const { streams, output } = createStreams();
  const code = await runCli({
    argv: ['update'],
    streams,
    env: {
      homeDir: home,
      cwd: home,
      processEnv: {},
      servicePlatform: 'linux',
      serviceRunner: runner,
      packageVersionFetcher: async () => CLI_VERSION,
    },
  });
  assert.equal(code, 1);
  assert.match(output.stderr, /State migration failed/);
  assert.match(output.stderr, /restarted on its previous unit/);
  assert.ok(starts.length > 0, 'the daemon must be restarted after the failed migration');
  assert.ok(!output.stdout.includes('Rewriting the service unit'), 'the rewrite must not run on unmigrated state');
});

test('update refuses when the manager cannot say whether the daemon is running', async () => {
  const home = await freshHome();
  // is-active answers garbage — previously collapsed to "not running",
  // which read a transient failure as a deliberate stop.
  const undecidedRunner: ServiceRunner = async (command, args) => {
    if (command === 'systemctl' && args.includes('is-active')) {
      return { code: 124, stdout: '', stderr: 'did not respond' };
    }
    if (command === 'systemctl' && args.includes('is-enabled')) {
      return { code: 0, stdout: 'enabled', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  await installService(
    { platform: 'linux', homeDir: home, cwd: home, execPath: path.join(home, 'node'), scriptPath: path.join(home, 'bin.js'), execArgv: [], run: undecidedRunner },
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
      servicePlatform: 'linux',
      serviceRunner: undecidedRunner,
      packageVersionFetcher: async () => CLI_VERSION,
    },
  });
  assert.equal(code, 1);
  assert.match(output.stderr, /is running could not be determined/);
  assert.ok(!output.stdout.includes('Rewriting the service unit'), output.stdout);
});

test('a reloading systemd unit is running; a transitional one is unknown, not stopped', async () => {
  const home = await freshHome();
  await installService({ platform: 'linux', homeDir: home, cwd: home, execPath: path.join(home, 'node'), scriptPath: path.join(home, 'bin.js'), execArgv: [], run: runningServiceRunner }, {});
  const statusWith = (state: string) => readServiceStatus({
    platform: 'linux',
    homeDir: home,
    run: async (command, args) => (command === 'systemctl' && args.includes('is-active')
      ? { code: 0, stdout: `${state}\n`, stderr: '' }
      : { code: 0, stdout: 'enabled', stderr: '' }),
  });
  assert.equal((await statusWith('reloading'))?.running, true);
  assert.equal((await statusWith('activating'))?.running, undefined);
  assert.equal((await statusWith('inactive'))?.running, false);
});

test('a failed unit rewrite restores the previous unit and restarts the daemon', async () => {
  const home = await freshHome();
  const staleNode = path.join(home, 'nvm', 'v20.0.0', 'node');
  let restarts = 0;
  const runner: ServiceRunner = async (command, args) => {
    if (command === 'systemctl' && args.includes('is-active')) {
      return { code: 0, stdout: 'active', stderr: '' };
    }
    if (command === 'systemctl' && args.includes('is-enabled')) {
      return { code: 0, stdout: 'enabled', stderr: '' };
    }
    if (command === 'systemctl' && args.includes('daemon-reload')) {
      return { code: 1, stdout: '', stderr: 'daemon-reload refused' };
    }
    if (command === 'systemctl' && args.includes('restart')) {
      restarts += 1;
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  // Seeded with a working runner so the install itself succeeds.
  await installService(
    { platform: 'linux', homeDir: home, cwd: home, execPath: staleNode, scriptPath: path.join(home, 'bin.js'), execArgv: [], run: runningServiceRunner },
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
      servicePlatform: 'linux',
      serviceRunner: runner,
      packageVersionFetcher: async () => CLI_VERSION,
    },
  });
  assert.equal(code, 1);
  assert.match(output.stderr, /restarted on its previous unit/);
  assert.ok(restarts > 0, 'the daemon must be started again after the failed rewrite');
  // The previous unit definition — stale node path and all — is back.
  const restored = await readFile(serviceUnitPath({ platform: 'linux', homeDir: home }), 'utf8');
  assert.ok(restored.includes(staleNode), 'the old unit definition must be restored');
});

test('update --check flags an entrypoint that exists but is not the one this shell runs', async () => {
  const home = await freshHome();
  await runStateMigrations({ homeDir: home });
  // The old CLI file still exists — a versioned package directory kept
  // alive after an upgrade — so an existence check alone sees nothing.
  const oldEntrypoint = path.join(home, 'old-versions', 'bin.js');
  await mkdir(path.dirname(oldEntrypoint), { recursive: true });
  await writeFile(oldEntrypoint, '// old build');
  await installService(
    { homeDir: home, cwd: home, execPath: process.execPath, scriptPath: oldEntrypoint, execArgv: [], run: runningServiceRunner },
    {},
  );

  const { streams, output } = createStreams();
  const code = await runCli({
    argv: ['update', '--check'],
    streams,
    env: {
      homeDir: home,
      cwd: home,
      processEnv: {},
      serviceRunner: runningServiceRunner,
      packageVersionFetcher: async () => CLI_VERSION,
    },
  });
  assert.equal(code, 1, output.stdout);
  assert.match(output.stdout, /unit runs entrypoint/);
  assert.doesNotMatch(output.stdout, /Nothing to do/);
});

test('starting a systemd service reloads the manager first, so the unit on disk is the one that runs', async () => {
  const home = await freshHome();
  const calls: string[] = [];
  const runner: ServiceRunner = async (command, args) => {
    calls.push(`${command} ${args.join(' ')}`);
    return { code: 0, stdout: '', stderr: '' };
  };
  const result = await startService({ platform: 'linux', homeDir: home, run: runner });
  assert.equal(result.ok, true);
  const reloadAt = calls.findIndex((call) => call.includes('daemon-reload'));
  const restartAt = calls.findIndex((call) => call.includes('restart'));
  assert.ok(reloadAt !== -1 && restartAt !== -1, calls.join('\n'));
  assert.ok(reloadAt < restartAt, 'daemon-reload must precede the restart — restart alone runs the previously loaded definition');
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
