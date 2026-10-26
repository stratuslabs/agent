// Writes an upgrade fixture home with a published release's own code.
//
//   node packages/cli/test/fixtures/homes/make-home.mjs 0.13.5
//
// Installs @stratusagent/cli and the plugins a typical host runs, all at that
// version, from npm into a scratch prefix, plus the test-only plugin from
// scripts/release-smoke/plugin, whose `smoke` provider makes exactly the tool
// call a message names. Then it runs that release's `stratus serve` against a
// scratch HOME and drives it over the control API, the way an operator and
// their agents would. It approves with "always" so grants get written by the
// release's own approval path, schedules a job, stores sign-ins and a named
// credential, and talks to two agents. Two memories are appended with the
// release's own memory store. See README.md for what is cleaned up afterward.
//
// Writes `<release>/stratus` (the home's `.stratus`), `<release>/Agents` (the
// visible souls and workspaces it links to) and `<release>/home.json` (the
// scratch home those links point into) beside this script. Needs network access to the
// npm registry. HOME is the scratch home for everything it runs, so the real
// ~/.stratus is never read or written.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const release = process.argv[2];
if (!release || !/^\d+\.\d+\.\d+$/.test(release)) {
  console.error('usage: node make-home.mjs <release, e.g. 0.13.5>');
  process.exit(2);
}
const out = path.join(here, release);
if (existsSync(out)) {
  console.error(`${out} exists; remove it first`);
  process.exit(2);
}
const pluginSource = path.resolve(here, '..', '..', '..', '..', '..', 'scripts', 'release-smoke', 'plugin');

const root = execFileSync('realpath', [mkdtempSync(path.join(os.tmpdir(), `stratus-fixture-${release}-`))]).toString().trim();
const home = path.join(root, 'home');
const stratusHome = path.join(home, '.stratus');
const install = path.join(root, 'install');
const env = { ...process.env, HOME: home, npm_config_cache: path.join(root, 'npm-cache') };
for (const key of Object.keys(env)) {
  if (key.startsWith('STRATUS_')) {
    delete env[key];
  }
}

const APPROVER = 'U0FIXTURE01';
const CHANNEL = 'C0FIXTURE01';
const SECRET = (label) => `FIXTURE-${label}-not-a-real-secret`;

let daemon;
let daemonLog = '';
const fail = (message) => {
  console.error(`make-home: ${message}`);
  if (daemonLog) {
    console.error(`--- daemon output (last 4000 chars)\n${daemonLog.slice(-4000)}`);
  }
  daemon?.kill('SIGTERM');
  console.error(`scratch left at ${root}`);
  process.exit(1);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- install

console.log(`--- install ${release} into ${install}`);
mkdirSync(path.join(install, 'packs'), { recursive: true });
const pluginCopy = path.join(root, 'plugin');
cpSync(pluginSource, pluginCopy, { recursive: true });
const packed = spawnSync('npm', ['pack', '--pack-destination', path.join(install, 'packs')], { cwd: pluginCopy, env, encoding: 'utf8' });
if (packed.status !== 0) {
  fail(`npm pack of the smoke plugin failed: ${packed.stderr}`);
}
const tarball = readdirSync(path.join(install, 'packs')).find((name) => name.endsWith('.tgz'));
writeFileSync(path.join(install, 'package.json'), `${JSON.stringify({
  private: true,
  dependencies: {
    '@stratusagent/cli': release,
    '@stratusagent/control-api': release,
    '@stratusagent/tool-shell': release,
    '@stratusagent/tool-web': release,
    'stratus-plugin-release-smoke': `file:packs/${tarball}`,
  },
}, null, 2)}\n`);
if (spawnSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel', 'error'], { cwd: install, env, stdio: 'inherit' }).status !== 0) {
  fail('npm install failed');
}

// ---------------------------------------------------------------- home

// What an operator writes by hand: souls and config. Ava runs on the
// scripted provider so this script can make her tools run; it becomes
// `demo` in the cleanup, since the test has no smoke plugin.
mkdirSync(path.join(stratusHome, 'agents'), { recursive: true, mode: 0o700 });
writeFileSync(path.join(stratusHome, 'agents', 'ava.md'), [
  '---',
  'name: Ava',
  'provider: smoke',
  'tools:',
  '  - shell.run',
  '  - web.fetch',
  '  - schedule.every',
  '  - schedule.list',
  '  - demo.echo',
  'credentials:',
  '  - fixture.token',
  '---',
  '',
  'Ava is an upgrade fixture agent.',
  '',
].join('\n'));
writeFileSync(path.join(stratusHome, 'config.json'), `${JSON.stringify({
  provider: 'demo',
  principals: { admit: 'principals', slackUsers: [APPROVER] },
  approvals: {
    mode: 'remote',
    posture: 'guarded',
    slackApprovers: [APPROVER],
    slackChannel: CHANNEL,
    agents: { bob: { posture: 'open' } },
  },
  plugins: {
    'stratus-plugin-release-smoke': { enabled: true },
    // Off so a shell that cannot start a sandbox inside its own (an agent's)
    // still runs the command, and the transcript holds its output rather
    // than a refusal quoting the whole sandbox profile.
    '@stratusagent/tool-shell': { enabled: true, sandbox: 'off' },
    '@stratusagent/tool-web': { enabled: true },
  },
}, null, 2)}\n`, { mode: 0o600 });

// ---------------------------------------------------------------- daemon

const token = randomBytes(24).toString('hex');
const tokenFile = path.join(root, 'gateway-token');
writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port: free } = server.address();
    server.close(() => resolve(free));
  });
});
const api = `http://127.0.0.1:${port}/api/v1`;
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

console.log('--- serve');
daemon = spawn(path.join(install, 'node_modules', '.bin', 'stratus'), ['serve', '--api-port', String(port)], {
  env: { ...env, STRATUS_GATEWAY_TOKEN_FILE: tokenFile },
  stdio: ['ignore', 'pipe', 'pipe'],
});
daemon.stdout.on('data', (chunk) => { daemonLog += chunk; });
daemon.stderr.on('data', (chunk) => { daemonLog += chunk; });
for (let started = Date.now(); ; await sleep(250)) {
  if (daemon.exitCode !== null) {
    fail(`serve exited with ${daemon.exitCode}`);
  }
  if (Date.now() - started > 60_000) {
    fail('serve never answered');
  }
  try {
    await call('GET', '/health');
    break;
  } catch {
    // not up yet
  }
}

const settled = async (sessionId, count) => {
  for (let started = Date.now(); Date.now() - started < 60_000; await sleep(250)) {
    const pending = (await call('GET', '/approvals')).approvals ?? [];
    for (const approval of pending) {
      console.log(`approve always: ${approval.call.toolName} (always means ${JSON.stringify(approval.always ?? null)})`);
      await call('POST', '/approvals', { requestId: approval.requestId, answer: 'always', actor: 'make-home' });
    }
    try {
      const { session } = await call('GET', `/sessions/${sessionId}`);
      if (session.messages.length >= count && ['completed', 'failed', 'idle'].includes(session.status)) {
        return session;
      }
    } catch {
      // not written yet
    }
  }
  fail(`${sessionId} did not settle`);
};
const say = async (sessionId, agentId, message) => {
  const before = await call('GET', `/sessions/${sessionId}`).then((found) => found.session.messages.length, () => 0);
  await call('POST', `/sessions/${sessionId}/messages`, { agentId, message });
  return settled(sessionId, before + 2);
};

try {
  console.log('--- agents, sign-ins and a named credential');
  await call('POST', '/agents', { name: 'Bob', instructions: 'Bob is an upgrade fixture agent.', provider: 'demo' });
  await call('PUT', '/credentials/anthropic', { type: 'oauth_token', value: `sk-ant-oat01-${SECRET('anthropic')}` });
  await call('PUT', '/credentials/openai', { type: 'api_key', value: `sk-${SECRET('openai')}` });
  await call('POST', '/credentials/named', { name: 'fixture.token', value: SECRET('named'), agentId: 'ava' });

  console.log('--- conversations');
  await say('fixture-ava-1', 'ava', 'Say hello');
  await say('fixture-ava-1', 'ava', JSON.stringify({ tool: 'demo.echo', input: { text: 'fixture' } }));
  await say('fixture-ava-1', 'ava', JSON.stringify({ tool: 'shell.run', input: { command: 'git --version' } }));
  await say('fixture-ava-1', 'ava', JSON.stringify({ tool: 'web.fetch', input: { url: 'https://example.com/' } }));
  await say('fixture-ava-1', 'ava', JSON.stringify({ tool: 'schedule.every', input: { every: '1d', prompt: 'Fixture: summarize the day.' } }));
  await say('fixture-bob-1', 'bob', 'Hello Bob');
  const grants = await call('GET', '/agents/ava/grants');
  const schedules = await call('GET', '/schedules');
  console.log(`grants: ${JSON.stringify(grants)}`);
  console.log(`schedules: ${JSON.stringify(schedules)}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

daemon.kill('SIGTERM');
await new Promise((resolve) => daemon.once('exit', resolve));
console.log(`serve stopped: ${daemon.exitCode ?? daemon.signalCode}`);

// ---------------------------------------------------------------- memories

const state = await import(pathToFileURL(path.join(install, 'node_modules', '@stratusagent', 'state', 'dist', 'index.js')).href);
const memory = state.createHomeMemoryStore({ homeDir: home, cwd: home });
await memory.append('ava', 'The deploy window is Tuesday (fixture fact).');
await memory.append('bob', 'Bob prefers short answers (fixture fact).');

// A file in Ava's workspace, the way an operator drops one into the visible
// folder. An empty workspace would not survive a git checkout.
writeFileSync(path.join(home, 'Agents', 'ava', 'workspace', 'notes.md'), 'Fixture notes in Ava\'s workspace.\n');

// ---------------------------------------------------------------- cleanup

for (const name of ['logs', 'stratusd.lock', 'gateway-token', 'stratusd.pid']) {
  rmSync(path.join(stratusHome, name), { recursive: true, force: true });
}
const config = JSON.parse(readFileSync(path.join(stratusHome, 'config.json'), 'utf8'));
delete config.plugins['stratus-plugin-release-smoke'];
delete config.api;
writeFileSync(path.join(stratusHome, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
const soul = path.join(stratusHome, 'agents', 'ava.md');
writeFileSync(soul, readFileSync(soul, 'utf8').replace('provider: smoke', 'provider: demo'));

// Stored as `stratus/`, because the repository ignores `.stratus/`. Links
// are copied as links; the test points them at its own home.
mkdirSync(out, { recursive: true });
cpSync(stratusHome, path.join(out, 'stratus'), { recursive: true, verbatimSymlinks: true });
if (existsSync(path.join(home, 'Agents'))) {
  cpSync(path.join(home, 'Agents'), path.join(out, 'Agents'), { recursive: true, verbatimSymlinks: true });
}
writeFileSync(path.join(out, 'home.json'), `${JSON.stringify({ home }, null, 2)}\n`);
rmSync(root, { recursive: true, force: true });
console.log(`--- wrote ${out}`);
