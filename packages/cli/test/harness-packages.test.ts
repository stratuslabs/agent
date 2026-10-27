import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { CLI_VERSION, runCli, type ServiceRunner } from '../src/index.ts';
import { runStateMigrations } from '@stratusagent/state';

const CLAUDE_CODE = '@stratusagent/provider-claude-code';
const CODEX = '@stratusagent/provider-codex';

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

// No service manager answers: these tests are about packages, not units.
const noService: ServiceRunner = async () => ({ code: 1, stdout: '', stderr: 'not here' });

/** A home whose default agent runs on the Claude subscription (the claude-code harness). */
const subscriptionHome = async (): Promise<string> => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-harness-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'anthropic' }));
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ anthropic: { type: 'oauth_token', value: 'sk-ant-oat-x' } }),
  );
  return home;
};

// Setup installs the always-on service; a manager that says yes to all of it.
// It also says the daemon is running when asked, as install asks afterwards.
const stubServiceRunner: ServiceRunner = async (command, args) => ({
  code: 0,
  stdout: command === 'launchctl' && args[0] === 'print'
    ? '\tstate = running\n'
    : command === 'systemctl' && args.includes('is-active') ? 'active\n' : '',
  stderr: '',
});

const missing = (...names: string[]) => (specifier: string) => !names.includes(specifier);

test('neither the CLI nor state depends on a harness provider package', async () => {
  // The whole point: a base install does not download claude-code's or
  // codex's native binary. Dev-only, so tests and types still have them.
  for (const pkg of ['cli', 'state']) {
    const manifest = JSON.parse(await readFile(
      fileURLToPath(new URL(`../../${pkg}/package.json`, import.meta.url)),
      'utf8',
    )) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
      for (const name of [CLAUDE_CODE, CODEX]) {
        assert.equal(manifest[field]?.[name], undefined, `${pkg} ${field} still lists ${name}`);
      }
    }
  }
});

test('neither the CLI nor control-api depends on or imports a provider adapter', async () => {
  // Naming a default model or hiding replay state is state's job
  // (`defaultModelFor`, `redactProviderReplayState`), so these two hosts
  // build with no adapter at all. Tests may still use one as a dev dependency.
  const adapter = /^@stratusagent\/provider-/;
  const importsAdapter = /(?:\bfrom\s*|\bimport\s*\(\s*)['"]@stratusagent\/provider-[^'"]*['"]/;
  for (const pkg of ['cli', 'control-api']) {
    const root = fileURLToPath(new URL(`../../${pkg}/`, import.meta.url));
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
      const named = Object.keys(manifest[field] ?? {}).filter((name) => adapter.test(name));
      assert.deepEqual(named, [], `${pkg} ${field} lists ${named.join(', ')}`);
    }
    const sources = (await readdir(path.join(root, 'src'), { recursive: true }))
      .filter((file) => /\.(?:ts|mts|js|mjs)$/.test(file));
    assert.ok(sources.length > 0, `no sources found under ${pkg}/src`);
    for (const file of sources) {
      const text = await readFile(path.join(root, 'src', file), 'utf8');
      assert.doesNotMatch(text, importsAdapter, `${pkg}/src/${file} imports a provider adapter`);
    }
  }
});

test('update --check names a harness an agent uses that is not installed, and calls it actionable', async () => {
  const home = await subscriptionHome();
  await runStateMigrations({ homeDir: home }, { exclusive: true });
  const { streams, output } = createStreams();
  const code = await runCli({
    argv: ['update', '--check'],
    streams,
    env: {
      homeDir: home,
      cwd: home,
      processEnv: {},
      serviceRunner: noService,
      packageVersionFetcher: async () => CLI_VERSION,
      installedVersionReader: async () => undefined,
      packageResolver: missing(CLAUDE_CODE),
    },
  });
  assert.equal(code, 1, output.stdout);
  assert.match(output.stdout, /provider {4}@stratusagent\/provider-claude-code — your agents use it and it is not installed/);
  assert.doesNotMatch(output.stdout, /provider-codex/);
});

test('the second half of an update installs the harness the old CLI carried and the new one does not', async () => {
  // Upgrading from a CLI that bundled both harnesses removes them with it;
  // the first half's package list came from that old build, so the new
  // build is the one that has to put back the one in use.
  const home = await subscriptionHome();
  const installs: string[][] = [];
  const { streams, output } = createStreams();
  const code = await runCli({
    argv: ['update'],
    streams,
    env: {
      homeDir: home,
      cwd: home,
      processEnv: { STRATUS_UPDATE_RESUME: 'stopped' },
      serviceRunner: noService,
      packageVersionFetcher: async () => CLI_VERSION,
      installedVersionReader: async () => undefined,
      packageResolver: missing(CLAUDE_CODE, CODEX),
      packageInstaller: async (packages) => {
        installs.push(packages);
        return { ok: true, message: '' };
      },
    },
  });
  assert.equal(code, 0, `${output.stdout}\n${output.stderr}`);
  // Only the one an agent uses, at this CLI's own version.
  assert.deepEqual(installs, [[`${CLAUDE_CODE}@${CLI_VERSION}`]]);
  assert.match(output.stdout, /Installed @stratusagent\/provider-claude-code/);
});

test('update installs the harness the service needs even when this shell exports a provider key', async () => {
  // The unit carries only PATH: ANTHROPIC_API_KEY in the updating shell
  // makes a foreground run use the API, but the daemon reads the stored
  // Claude sign-in and runs on claude-code.
  const home = await subscriptionHome();
  const installs: string[][] = [];
  const { streams, output } = createStreams();
  const code = await runCli({
    argv: ['update'],
    streams,
    env: {
      homeDir: home,
      cwd: home,
      processEnv: { STRATUS_UPDATE_RESUME: 'stopped', ANTHROPIC_API_KEY: 'sk-ant-api-shell' },
      serviceRunner: noService,
      packageVersionFetcher: async () => CLI_VERSION,
      installedVersionReader: async () => undefined,
      packageResolver: missing(CLAUDE_CODE, CODEX),
      packageInstaller: async (packages) => {
        installs.push(packages);
        return { ok: true, message: '' };
      },
    },
  });
  assert.equal(code, 0, `${output.stdout}\n${output.stderr}`);
  assert.deepEqual(installs, [[`${CLAUDE_CODE}@${CLI_VERSION}`]]);
});

test('setup installs the claude-code harness for a subscription even when this shell exports a provider key', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const installs: string[][] = [];
  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: { ANTHROPIC_API_KEY: 'sk-ant-api-shell' },
      serviceRunner: stubServiceRunner,
      packageResolver: missing(CLAUDE_CODE),
      packageInstaller: async (packages) => {
        installs.push(packages);
        return { ok: true, message: '' };
      },
      setupInput: Readable.from(['1\n', '1\n', '1\n', 'sk-ant-oat-123\n', '9\n']),
    },
  });
  assert.equal(exitCode, 0, output.stderr);
  assert.deepEqual(installs, [[`${CLAUDE_CODE}@${CLI_VERSION}`]]);
});

test('update leaves harness packages alone when the one in use is installed', async () => {
  const home = await subscriptionHome();
  const installs: string[][] = [];
  const { streams, output } = createStreams();
  const code = await runCli({
    argv: ['update'],
    streams,
    env: {
      homeDir: home,
      cwd: home,
      processEnv: { STRATUS_UPDATE_RESUME: 'stopped' },
      serviceRunner: noService,
      packageVersionFetcher: async () => CLI_VERSION,
      installedVersionReader: async () => undefined,
      // codex is absent, but nothing runs on it.
      packageResolver: missing(CODEX),
      packageInstaller: async (packages) => {
        installs.push(packages);
        return { ok: true, message: '' };
      },
    },
  });
  assert.equal(code, 0, `${output.stdout}\n${output.stderr}`);
  assert.deepEqual(installs, []);
});

test('a harness install that fails makes the update fail, with the command to run', async () => {
  const home = await subscriptionHome();
  const { streams, output } = createStreams();
  const code = await runCli({
    argv: ['update'],
    streams,
    env: {
      homeDir: home,
      cwd: home,
      processEnv: { STRATUS_UPDATE_RESUME: 'stopped' },
      serviceRunner: noService,
      packageVersionFetcher: async () => CLI_VERSION,
      installedVersionReader: async () => undefined,
      packageResolver: missing(CLAUDE_CODE),
      packageInstaller: async () => ({ ok: false, message: 'npm exited with code 1' }),
    },
  });
  assert.equal(code, 1);
  assert.match(output.stderr, new RegExp(`npm install -g @stratusagent/provider-claude-code@${CLI_VERSION.replace(/\./g, '\\.')}`));
});

test('doctor reports an agent whose harness is not installed', async () => {
  const home = await subscriptionHome();
  const { streams, output } = createStreams();
  const code = await runCli({
    argv: ['doctor'],
    streams,
    env: {
      homeDir: home,
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-cwd-')),
      processEnv: {},
      serviceRunner: noService,
      packageResolver: missing(CLAUDE_CODE),
    },
  });
  assert.equal(code, 1);
  assert.match(output.stdout, /@stratusagent\/provider-claude-code is not installed, and an agent runs on it/);
});

test('setup installs the claude-code harness when the Claude subscription is chosen', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const installs: string[][] = [];
  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      serviceRunner: stubServiceRunner,
      // Only the harness is missing, so the optional-package offer stays quiet.
      packageResolver: missing(CLAUDE_CODE),
      packageInstaller: async (packages) => {
        installs.push(packages);
        return { ok: true, message: '' };
      },
      // Claude → subscription → paste token, then save & finish.
      setupInput: Readable.from(['1\n', '1\n', '1\n', 'sk-ant-oat-123\n', '9\n']),
    },
  });
  assert.equal(exitCode, 0, output.stderr);
  assert.deepEqual(installs, [[`${CLAUDE_CODE}@${CLI_VERSION}`]]);
  assert.match(output.stdout, /Running: npm install -g @stratusagent\/provider-claude-code@/);
});

test('setup that cannot install the harness exits 1 and does not say ready', async () => {
  // The CLI no longer carries the harness, so a failed install leaves a
  // saved config on which every turn fails. Saved either way; the exit code
  // and the closing line carry it, as for a failed service step.
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      serviceRunner: stubServiceRunner,
      packageResolver: missing(CLAUDE_CODE),
      packageInstaller: async () => ({ ok: false, message: 'npm exited with code 243' }),
      setupInput: Readable.from(['1\n', '1\n', '1\n', 'sk-ant-oat-123\n', '9\n']),
    },
  });
  assert.equal(exitCode, 1, output.stdout);
  assert.doesNotMatch(output.stdout, /ready to go/);
  assert.match(output.stdout, /Saved, but a run started here would fail: @stratusagent\/provider-claude-code is not installed/);
  assert.match(await readFile(path.join(home, '.stratus', 'config.json'), 'utf8'), /"provider": "anthropic"/);
});

test('setup installs no harness for an API-key provider', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'anthropic' }));
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ anthropic: { type: 'api_key', value: 'sk-ant-api-x' } }),
  );
  const installs: string[][] = [];
  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: {},
      serviceRunner: stubServiceRunner,
      packageResolver: missing(CLAUDE_CODE, CODEX),
      packageInstaller: async (packages) => {
        installs.push(packages);
        return { ok: true, message: '' };
      },
      setupInput: Readable.from(['9\n']),
    },
  });
  assert.equal(exitCode, 0, output.stderr);
  assert.deepEqual(installs, []);
});
