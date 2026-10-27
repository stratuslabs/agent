import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { claimHome } from '@stratusagent/gateway';

import { CLI_VERSION, runCli } from '../src/index.ts';

// `stratus dashboard` is the one command that offers to install the two
// packages the dashboard needs (card 308): setup and everything else leave
// them alone, so the offer comes only from someone asking for the dashboard.

const API = '@stratusagent/control-api';
const PAGE = '@stratusagent/dashboard';
const DASHBOARD = [API, PAGE];

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
 * A machine where `missing` are not installed until npm runs. Every other
 * package resolves, and the daemon the command starts loads the real ones
 * (devDependencies here), so only the offer is simulated.
 */
const machine = (missing: string[], install: { ok: boolean; message: string; resolvesAfter?: boolean } = { ok: true, message: '' }) => {
  const installed: string[][] = [];
  let done = false;
  return {
    installed,
    packageResolver: (specifier: string) => !missing.includes(specifier) || done,
    packageInstaller: async (packages: string[]) => {
      installed.push(packages);
      done = install.ok && install.resolvesAfter !== false;
      return { ok: install.ok, message: install.message };
    },
  };
};

const gatewayFile = (home: string) => path.join(home, '.stratus', 'gateway.json');

test('stratus dashboard offers the missing packages, installs them at its own version, and opens', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-dash-install-'));
  const box = machine(DASHBOARD);
  const { streams, output } = createStreams();
  let openedUrl = '';

  const exitCode = await runCli({
    argv: ['dashboard', '--port', '0'],
    streams,
    env: {
      homeDir: home,
      cwd: home,
      processEnv: {},
      packageResolver: box.packageResolver,
      packageInstaller: box.packageInstaller,
      // "Install them now".
      setupInput: Readable.from(['1\n']),
      openExternal: async (url) => { openedUrl = url; },
      dashboardAutoShutdownMs: 50,
    },
  });

  assert.equal(exitCode, 0, output.stderr);
  assert.match(output.stdout, /needs @stratusagent\/control-api and @stratusagent\/dashboard/);
  // Lockstep with this CLI, like the provider packages: an unpinned install
  // would put the latest control API beside an older daemon.
  assert.deepEqual(box.installed, [[`${API}@${CLI_VERSION}`, `${PAGE}@${CLI_VERSION}`]]);
  assert.match(output.stdout, /Installed @stratusagent\/control-api and @stratusagent\/dashboard\./);
  assert.match(output.stdout, /ready at http:\/\/127\.0\.0\.1:\d+/);
  assert.match(openedUrl, /\/api\/v1\/auth\/session\?ott=/);
});

test('stratus dashboard installs only the half that is missing', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-dash-half-'));
  const box = machine([PAGE]);
  const { streams, output } = createStreams();

  const exitCode = await runCli({
    argv: ['dashboard', '--port', '0', '--no-open'],
    streams,
    env: {
      homeDir: home,
      cwd: home,
      processEnv: {},
      packageResolver: box.packageResolver,
      packageInstaller: box.packageInstaller,
      setupInput: Readable.from(['1\n']),
      dashboardAutoShutdownMs: 50,
    },
  });

  assert.equal(exitCode, 0, output.stderr);
  assert.match(output.stdout, /needs @stratusagent\/dashboard,/);
  assert.deepEqual(box.installed, [[`${PAGE}@${CLI_VERSION}`]]);
});

test('without a terminal, stratus dashboard prints the install command and starts nothing', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-dash-piped-'));
  const box = machine(DASHBOARD);
  const { streams, output } = createStreams();

  // No setupInput, and the test runner's stdin is not a TTY: nobody to ask.
  const exitCode = await runCli({
    argv: ['dashboard', '--port', '0', '--no-open'],
    streams,
    env: {
      homeDir: home,
      cwd: home,
      processEnv: {},
      packageResolver: box.packageResolver,
      packageInstaller: box.packageInstaller,
      // Never waited on: on a build that ignores the missing packages this
      // command would start a daemon and run until it is stopped.
      dashboardAutoShutdownMs: 50,
    },
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(box.installed, []);
  assert.ok(
    output.stderr.includes(`npm install -g ${API}@${CLI_VERSION} ${PAGE}@${CLI_VERSION}`),
    output.stderr,
  );
  // Refused before a daemon was started, not after waiting for one that
  // could never serve the page.
  assert.doesNotMatch(output.stdout, /No daemon is running/);
  await assert.rejects(readFile(gatewayFile(home), 'utf8'));
});

test('declining the install leaves the machine alone and says how to do it later', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-dash-declined-'));
  const box = machine(DASHBOARD);
  const { streams, output } = createStreams();

  const exitCode = await runCli({
    argv: ['dashboard', '--port', '0', '--no-open'],
    streams,
    env: {
      homeDir: home,
      cwd: home,
      processEnv: {},
      packageResolver: box.packageResolver,
      packageInstaller: box.packageInstaller,
      // "Cancel".
      setupInput: Readable.from(['2\n']),
      dashboardAutoShutdownMs: 50,
    },
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(box.installed, []);
  assert.ok(output.stdout.includes(`npm install -g ${API}@${CLI_VERSION} ${PAGE}@${CLI_VERSION}`), output.stdout);
  assert.doesNotMatch(output.stdout, /No daemon is running/);
});

test('a failed install is reported with the command, and no daemon is started', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-dash-failed-'));
  const box = machine(DASHBOARD, { ok: false, message: 'npm exited with code 243' });
  const { streams, output } = createStreams();

  const exitCode = await runCli({
    argv: ['dashboard', '--port', '0', '--no-open'],
    streams,
    env: {
      homeDir: home,
      cwd: home,
      processEnv: {},
      packageResolver: box.packageResolver,
      packageInstaller: box.packageInstaller,
      setupInput: Readable.from(['1\n']),
      dashboardAutoShutdownMs: 50,
    },
  });

  assert.equal(exitCode, 1);
  assert.match(output.stderr, /Could not install: npm exited with code 243/);
  assert.ok(output.stderr.includes(`npm install -g ${API}@${CLI_VERSION} ${PAGE}@${CLI_VERSION}`), output.stderr);
  assert.doesNotMatch(output.stdout, /No daemon is running/);
});

test('an install this process cannot load yet asks for one more run instead of starting a daemon without them', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-dash-rerun-'));
  const box = machine(DASHBOARD, { ok: true, message: '', resolvesAfter: false });
  const { streams, output } = createStreams();

  const exitCode = await runCli({
    argv: ['dashboard', '--port', '0', '--no-open'],
    streams,
    env: {
      homeDir: home,
      cwd: home,
      processEnv: {},
      packageResolver: box.packageResolver,
      packageInstaller: box.packageInstaller,
      setupInput: Readable.from(['1\n']),
      dashboardAutoShutdownMs: 50,
    },
  });

  assert.equal(exitCode, 0, output.stderr);
  assert.match(output.stdout, /Installed /);
  assert.match(output.stdout, /run `stratus dashboard` again/);
  assert.doesNotMatch(output.stdout, /No daemon is running/);
});

test('after the install, a daemon already holding the home is told to restart, not waited on', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-dash-held-install-'));
  const env = { homeDir: home, cwd: home, processEnv: {} };
  // The installed service, started before the packages existed: it holds
  // the home and has no control API, so it will never publish an address.
  const holder = claimHome(env);
  try {
    const box = machine(DASHBOARD);
    const { streams, output } = createStreams();
    const startedAt = Date.now();

    const exitCode = await runCli({
      argv: ['dashboard', '--port', '0', '--no-open'],
      streams,
      env: {
        ...env,
        packageResolver: box.packageResolver,
        packageInstaller: box.packageInstaller,
        setupInput: Readable.from(['1\n']),
      },
    });

    assert.equal(exitCode, 1);
    assert.deepEqual(box.installed, [[`${API}@${CLI_VERSION}`, `${PAGE}@${CLI_VERSION}`]]);
    assert.match(output.stderr, /started before the dashboard packages were installed/);
    assert.match(output.stderr, /stratus service stop/);
    // Not the 15-second wait for an address this daemon can never publish.
    assert.ok(Date.now() - startedAt < 10_000, `took ${Date.now() - startedAt} ms`);
  } finally {
    holder.release();
  }
});

test('a daemon that is already serving is used as it is, with no offer', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-dash-serving-'));
  const controller = new AbortController();
  const served = createStreams();
  const serving = runCli({
    argv: ['serve', '--no-events', '--api-port', '0'],
    streams: served.streams,
    env: { homeDir: home, cwd: home, processEnv: {}, shutdownSignal: controller.signal },
  });
  try {
    for (let tries = 0; ; tries += 1) {
      try {
        await readFile(gatewayFile(home), 'utf8');
        break;
      } catch {
        if (tries > 200) throw new Error(`daemon never published gateway.json: ${served.output.stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    // What this shell can resolve says nothing about the daemon that is
    // already answering: it was started with whatever it has.
    const box = machine(DASHBOARD);
    const { streams, output } = createStreams();
    const exitCode = await runCli({
      argv: ['dashboard', '--no-open'],
      streams,
      env: {
        homeDir: home,
        cwd: home,
        processEnv: {},
        packageResolver: box.packageResolver,
        packageInstaller: box.packageInstaller,
      },
    });

    assert.equal(exitCode, 0, output.stderr);
    assert.deepEqual(box.installed, []);
    assert.doesNotMatch(output.stdout, /needs @stratusagent/);
    assert.match(output.stdout, /ready at http:\/\/127\.0\.0\.1:\d+/);
  } finally {
    controller.abort();
    await serving;
  }
});

/**
 * A daemon already answering with the control API and no dashboard package
 * (the headless configuration), seen through `fetch`: health answers, and
 * the page is the 404 the control API gives when the package is absent.
 */
const headlessDaemon = async (home: string) => {
  const base = 'http://127.0.0.1:9';
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(gatewayFile(home), JSON.stringify({ url: base }));
  await writeFile(path.join(home, '.stratus', 'gateway-token'), 'token\n');
  const asked: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    if (url === `${base}/api/v1/health`) {
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === `${base}/api/v1/auth/ott`) {
      return new Response(JSON.stringify({ path: '/api/v1/auth/session?ott=spent' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(
      JSON.stringify({ error: { code: 'no_dashboard', message: 'This gateway serves the control API only. Install @stratusagent/dashboard for the web UI.' } }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof globalThis.fetch;
  return { base, asked, fetch };
};

test('a running daemon with the control API but no dashboard is offered the page, then told to restart', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-dash-headless-'));
  const daemon = await headlessDaemon(home);
  const box = machine([PAGE]);
  const { streams, output } = createStreams();
  let opened = false;

  const exitCode = await runCli({
    argv: ['dashboard'],
    streams,
    env: {
      homeDir: home,
      cwd: home,
      processEnv: {},
      fetch: daemon.fetch,
      packageResolver: box.packageResolver,
      packageInstaller: box.packageInstaller,
      setupInput: Readable.from(['1\n']),
      openExternal: async () => { opened = true; },
    },
  });

  assert.equal(exitCode, 0, output.stderr);
  assert.ok(output.stdout.includes(`The daemon at ${daemon.base} serves the control API without the dashboard.`), output.stdout);
  assert.deepEqual(box.installed, [[`${PAGE}@${CLI_VERSION}`]]);
  assert.match(output.stdout + output.stderr, /`stratus restart`, then `stratus dashboard` again/);
  // No session minted for a page that would only 404.
  assert.ok(!daemon.asked.some((url) => url.endsWith('/api/v1/auth/ott')), daemon.asked.join(', '));
  assert.equal(opened, false);
});

test('without a terminal, a running daemon with no dashboard gets the install command and no session', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-dash-headless-piped-'));
  const daemon = await headlessDaemon(home);
  const box = machine([PAGE]);
  const { streams, output } = createStreams();

  const exitCode = await runCli({
    argv: ['dashboard', '--no-open'],
    streams,
    env: { homeDir: home, cwd: home, processEnv: {}, fetch: daemon.fetch, packageResolver: box.packageResolver, packageInstaller: box.packageInstaller },
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(box.installed, []);
  assert.ok(output.stderr.includes(`npm install -g ${PAGE}@${CLI_VERSION}`), output.stderr);
  assert.ok(!daemon.asked.some((url) => url.endsWith('/api/v1/auth/ott')), daemon.asked.join(', '));
});

test('a running daemon started before the dashboard was installed is told to restart, with nothing to install', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-dash-headless-stale-'));
  const daemon = await headlessDaemon(home);
  const box = machine([]);
  const { streams, output } = createStreams();

  const exitCode = await runCli({
    argv: ['dashboard', '--no-open'],
    streams,
    env: { homeDir: home, cwd: home, processEnv: {}, fetch: daemon.fetch, packageResolver: box.packageResolver, packageInstaller: box.packageInstaller },
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(box.installed, []);
  assert.doesNotMatch(output.stdout, /needs @stratusagent/);
  assert.match(output.stderr, /started before @stratusagent\/dashboard was installed.*`stratus restart`, then `stratus dashboard` again/);
  assert.ok(!daemon.asked.some((url) => url.endsWith('/api/v1/auth/ott')), daemon.asked.join(', '));
});
