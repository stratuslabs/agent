// Release smoke check: install this commit the way a user would, into a
// scratch home shaped like a real host, start the daemon, and check the
// things that broke in 0.13.0 while unit tests and CI stayed green.
//
//   node scripts/release-smoke/run.mjs              # from the repository root
//   node scripts/release-smoke/run.mjs --repo DIR   # check another checkout (a tag's worktree)
//   node scripts/release-smoke/run.mjs --keep       # leave the scratch directory for a look
//
// See scripts/release-smoke/README.md. Needs Node, pnpm and npm; the install step
// needs the npm registry for third-party dependencies. Touches nothing
// outside its own temporary directory: HOME is the scratch home for every
// command it runs, so the real ~/.stratus is never read or written.
//
// Exit 0: every check passed. 1: a check failed. 2: nothing failed but a
// check could not run here (a shell that is itself sandboxed cannot start
// another sandbox), which is not a pass.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const repo = path.resolve(option('--repo') ?? path.join(here, '..', '..'));
const keep = flag('--keep');
const build = !flag('--no-build');

const AGENT = 'smoke';
const PRINCIPAL = 'U0SMOKETEST';
const results = [];
const record = (status, name, detail = '') => {
  results.push({ status, name, detail });
  console.log(`${status.padEnd(7)} ${name}${detail ? `: ${detail}` : ''}`);
};

const work = mkdtempSync(path.join(os.tmpdir(), 'stratus-release-smoke-'));
// realpath: on macOS the temp directory is reached through /var -> /private/var,
// and a sandbox profile is written against real paths.
const root = execFileSync('realpath', [work]).toString().trim();
const home = path.join(root, 'home');
const stratusHome = path.join(home, '.stratus');
const integration = path.join(stratusHome, 'integrations', AGENT);
const install = path.join(root, 'install');
const packs = path.join(install, 'packs');
let daemon;
let daemonLog = '';

const cleanup = () => {
  if (daemon && daemon.exitCode === null) {
    daemon.kill('SIGTERM');
  }
  if (keep) {
    console.log(`kept ${root}`);
  } else {
    rmSync(root, { recursive: true, force: true });
  }
};

// Interrupted, it still stops the daemon it started and removes its
// scratch directory.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    console.error(`release-smoke: ${signal}, cleaning up`);
    cleanup();
    process.exit(130);
  });
}

const fail = (message) => {
  console.error(`release-smoke: ${message}`);
  if (daemonLog) {
    console.error('--- daemon output (last 4000 chars)');
    console.error(daemonLog.slice(-4000));
  }
  cleanup();
  process.exit(1);
};

// Every command the check runs sees the scratch home and nothing else of
// this machine's environment: no provider key, no real gateway token.
const scratchEnv = (extra = {}) => ({
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: home,
  TMPDIR: os.tmpdir(),
  LANG: process.env.LANG ?? 'C.UTF-8',
  ...extra,
});

const run = (command, commandArgs, options = {}) => spawnSync(command, commandArgs, { encoding: 'utf8', ...options });

const freePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- install

const prepareInstall = () => {
  console.log(`--- install ${repo}`);
  // A fresh tag worktree has no dependencies yet, and its build would fail on
  // that rather than on anything the release changed.
  if (!existsSync(path.join(repo, 'node_modules'))) {
    const installed = run('pnpm', ['install', '--frozen-lockfile'], { cwd: repo, stdio: 'inherit' });
    if (installed.status !== 0) {
      fail('pnpm install failed in the checkout under test');
    }
  }
  if (build) {
    const built = run('pnpm', ['build'], { cwd: repo, stdio: 'inherit' });
    if (built.status !== 0) {
      fail('pnpm build failed in the checkout under test');
    }
  }
  // The same tarballs npm would publish, through the image's own packer.
  mkdirSync(packs, { recursive: true });
  const packer = path.join(repo, 'deploy', 'docker', 'pack.mjs');
  if (!existsSync(packer)) {
    fail(`${packer} is missing; this check needs a checkout from 0.12 or later`);
  }
  execFileSync(process.execPath, [packer, repo, packs], { stdio: ['ignore', 'inherit', 'inherit'] });
  const manifest = JSON.parse(readFileSync(path.join(packs, 'package.json'), 'utf8'));
  rmSync(path.join(packs, 'package.json'));
  // The test-only plugin, packed like a third-party plugin a user installs.
  const pluginCopy = path.join(root, 'plugin');
  cpSync(path.join(here, 'plugin'), pluginCopy, { recursive: true });
  const packed = run('npm', ['pack', '--pack-destination', packs], { cwd: pluginCopy, env: { ...process.env, npm_config_cache: path.join(root, 'npm-cache') } });
  if (packed.status !== 0) {
    fail(`npm pack of the smoke plugin failed: ${packed.stderr}`);
  }
  const pluginTarball = readdirSync(packs).find((name) => name.startsWith('stratus-plugin-release-smoke-'));
  manifest.dependencies['stratus-plugin-release-smoke'] = `file:packs/${pluginTarball}`;
  writeFileSync(path.join(install, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const installed = run('npm', ['install', '--no-audit', '--no-fund', '--loglevel', 'error'], {
    cwd: install,
    stdio: 'inherit',
    env: { ...process.env, npm_config_cache: path.join(root, 'npm-cache') },
  });
  if (installed.status !== 0) {
    fail('npm install of the packed release failed');
  }
};

const stratusBin = () => path.join(install, 'node_modules', '.bin', 'stratus');
const stratus = (commandArgs, options = {}) => run(stratusBin(), commandArgs, { env: scratchEnv(), ...options });

// ---------------------------------------------------------------- scratch home

// Shaped like our hosts: each agent's git config, HOME and toolchain live
// under ~/.stratus/integrations/<id>, which the shell sandbox hides with the
// rest of the Stratus home unless readablePaths names it. 0.13.0 shipped a
// sandbox where naming it did nothing, so git and gh failed in every
// sandboxed command on those hosts.
const prepareHome = () => {
  console.log(`--- scratch home ${home}`);
  const toolchain = path.join(integration, 'toolchain', 'bin');
  const agentHome = path.join(integration, 'home');
  mkdirSync(toolchain, { recursive: true });
  mkdirSync(agentHome, { recursive: true });
  writeFileSync(path.join(toolchain, 'smoke-toolchain'), '#!/bin/sh\necho toolchain-ok\n');
  chmodSync(path.join(toolchain, 'smoke-toolchain'), 0o755);
  symlinkSync(process.execPath, path.join(toolchain, 'node'));
  writeFileSync(path.join(agentHome, '.gitconfig'), '[smoke]\n\tmarker = gitconfig-ok\n');

  const agents = path.join(stratusHome, 'agents');
  mkdirSync(agents, { recursive: true });
  writeFileSync(path.join(agents, `${AGENT}.md`), [
    '---',
    'name: Smoke',
    'provider: smoke',
    'tools:',
    '  - shell.run',
    '  - smoke.credential',
    '  - schedule.every',
    '  - schedule.list',
    'credentials:',
    '  - smoke.token',
    '---',
    '',
    'Release smoke check agent. Its provider is a script, not a model.',
    '',
  ].join('\n'));

  writeFileSync(path.join(stratusHome, 'config.json'), `${JSON.stringify({
    provider: 'smoke',
    principals: { admit: 'principals', slackUsers: [PRINCIPAL] },
    plugins: {
      'stratus-plugin-release-smoke': { enabled: true },
      '@stratusagent/tool-shell': {
        enabled: true,
        sandbox: 'required',
        agents: {
          [AGENT]: {
            env: {
              HOME: agentHome,
              GIT_CONFIG_GLOBAL: path.join(agentHome, '.gitconfig'),
              PATH: `${toolchain}:/usr/bin:/bin`,
            },
            readablePaths: [`~/.stratus/integrations/${AGENT}`],
          },
        },
      },
    },
  }, null, 2)}\n`, { mode: 0o600 });
};

// ---------------------------------------------------------------- daemon

const token = randomBytes(24).toString('hex');
let api;

const call = async (method, route, body) => {
  const response = await fetch(`${api}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${route} answered ${response.status}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : undefined;
};

const startDaemon = async () => {
  console.log('--- start the daemon');
  const tokenFile = path.join(root, 'gateway-token');
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  const port = await freePort();
  api = `http://127.0.0.1:${port}/api/v1`;
  daemon = spawn(stratusBin(), ['serve', '--api-port', String(port)], {
    env: scratchEnv({ STRATUS_GATEWAY_TOKEN_FILE: tokenFile }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemon.stdout.on('data', (chunk) => { daemonLog += chunk; });
  daemon.stderr.on('data', (chunk) => { daemonLog += chunk; });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null) {
      fail(`the daemon exited with ${daemon.exitCode} before it answered`);
    }
    try {
      const health = await call('GET', '/health');
      if (health) {
        return health;
      }
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  fail('the daemon did not answer /health within 60 seconds');
};

// One scripted turn: the smoke provider makes the named call and answers
// with its result. Returns the parsed result line.
const scripted = async (tool, input) => {
  const sessionId = `web:${AGENT}:release-smoke-${randomBytes(6).toString('hex')}`;
  await call('POST', `/sessions/${encodeURIComponent(sessionId)}/messages`, { agentId: AGENT, message: JSON.stringify({ tool, input }) });
  const deadline = Date.now() + 60_000;
  let last = 'nothing read yet';
  while (Date.now() < deadline) {
    try {
      const { session } = await call('GET', `/sessions/${encodeURIComponent(sessionId)}`);
      const result = parseResult(session);
      if (result) {
        return result;
      }
      last = `session status ${session?.status ?? 'unknown'}, ${session?.messages?.length ?? 0} message(s)`;
    } catch (error) {
      // the session is not written yet, or a result line did not parse
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  throw new Error(`no answer to the scripted ${tool} call within 60 seconds (last read: ${last.slice(0, 300)})`);
};

const parseResult = (session) => {
  for (const message of [...(session.messages ?? [])].reverse()) {
    const text = typeof message.content === 'string' ? message.content : '';
    const at = text.indexOf('SMOKE_RESULT ');
    if (at >= 0) {
      return JSON.parse(text.slice(at + 'SMOKE_RESULT '.length));
    }
  }
  return undefined;
};

// ---------------------------------------------------------------- checks

// Only the errors a sandbox gives when it cannot start at all. A command
// the sandbox started and then denied (what 0.13.0 did) fails differently,
// and must stay a FAIL.
const NESTED_SANDBOX = /sandbox_apply: Operation not permitted|bwrap: (No permissions to creat|setting up uid map|Creating new namespace failed)/i;

const checkShell = async () => {
  const command = 'smoke-toolchain && git config --global --get smoke.marker && node -e "process.stdout.write(\'node-ok\')"';
  const result = await scripted('shell.run', { command });
  const text = result.text ?? '';
  if (result.ok && /toolchain-ok/.test(text) && /gitconfig-ok/.test(text) && /node-ok/.test(text)) {
    record('PASS', 'sandboxed shell.run reads the agent\'s integration toolchain and git config');
  } else if (NESTED_SANDBOX.test(text)) {
    record('NOT RUN', 'sandboxed shell.run', 'this shell cannot start a sandbox inside the one it is already in; run the check from a plain terminal');
  } else {
    record('FAIL', 'sandboxed shell.run reads the agent\'s integration toolchain and git config', text.slice(0, 800));
  }
};

const checkCredential = async (expected) => {
  const result = await scripted('smoke.credential', {});
  const output = JSON.parse(result.text ?? '{}').output;
  if (result.ok && output?.present === true && output?.sha256 === expected) {
    record('PASS', 'a stored named credential reaches the plugin tool that declares it');
  } else {
    record('FAIL', 'a stored named credential reaches the plugin tool that declares it', JSON.stringify(result).slice(0, 500));
  }
};

const checkSchedule = async () => {
  const result = await scripted('schedule.every', { every: '1m', prompt: 'release smoke schedule fired' });
  if (!result.ok) {
    record('FAIL', 'schedule.every creates a schedule', JSON.stringify(result).slice(0, 500));
    return;
  }
  const listed = stratus(['schedules']);
  if (listed.status !== 0 || !listed.stdout.includes('release smoke schedule fired')) {
    record('FAIL', '`stratus schedules` lists the new schedule', (listed.stderr || listed.stdout).slice(0, 500));
    return;
  }
  record('PASS', 'schedule.every creates a schedule and `stratus schedules` lists it');
  // A one-minute cadence fires within about a minute of creation, plus the
  // scheduler's tick.
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    const sessions = await call('GET', `/sessions?agent=${AGENT}&limit=50`);
    const fired = JSON.stringify(sessions).includes('schedule:');
    if (fired) {
      record('PASS', 'the schedule fired a turn');
      return;
    }
    await sleep(5_000);
  }
  record('FAIL', 'the schedule fired a turn', 'no schedule: session within 150 seconds of creation');
};

const checkDoctor = () => {
  const doctor = stratus(['doctor']);
  const output = `${doctor.stdout}\n${doctor.stderr}`;
  if (doctor.status === 0) {
    record('PASS', '`stratus doctor` passes on a host-shaped config');
  } else {
    record('FAIL', '`stratus doctor` passes on a host-shaped config', output.trim().slice(0, 1500));
  }
};

const checkStartup = (health) => {
  const warnings = health?.startup?.warnings ?? [];
  if (warnings.length === 0) {
    record('PASS', 'the daemon started with no startup warnings');
  } else {
    record('FAIL', 'the daemon started with no startup warnings', warnings.join(' | ').slice(0, 1500));
  }
};

// ---------------------------------------------------------------- main

try {
  prepareInstall();
  const version = stratus(['--version']);
  console.log(`--- installed ${version.stdout.trim()}`);
  prepareHome();
  const secret = randomBytes(16).toString('hex');
  const stored = stratus(['credential', 'set', 'smoke.token'], { input: secret });
  if (stored.status !== 0) {
    fail(`stratus credential set failed: ${stored.stderr}`);
  }
  const health = await startDaemon();
  checkStartup(health);
  checkDoctor();
  await checkShell();
  await checkCredential(createHash('sha256').update(secret).digest('hex'));
  await checkSchedule();
} catch (error) {
  record('FAIL', 'the smoke run itself', error instanceof Error ? error.message : String(error));
}

if (results.some((result) => result.status === 'FAIL') && daemonLog) {
  console.error('--- daemon output (last 4000 chars)');
  console.error(daemonLog.slice(-4000));
}
cleanup();
const failed = results.filter((result) => result.status === 'FAIL').length;
const notRun = results.filter((result) => result.status === 'NOT RUN').length;
console.log(`release-smoke: ${results.length - failed - notRun} passed, ${failed} failed, ${notRun} not run`);
process.exit(failed > 0 ? 1 : notRun > 0 ? 2 : 0);
