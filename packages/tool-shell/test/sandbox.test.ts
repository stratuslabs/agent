import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AgentWorkspaces, JsonObject, Session } from '@stratusagent/core';
import { createLocalCommandExecutor } from '@stratusagent/executor-local';

import {
  bwrapArgs,
  createShellTool,
  darwinProfile,
  planSandbox as realPlanSandbox,
  resetSandboxWarning,
  stratusHomesFor,
  type planSandbox,
} from '../src/index.ts';

const session = (agentId = 'ava'): Session => ({
  id: `session-${agentId}`,
  agent: { id: agentId, name: agentId },
  status: 'running',
  messages: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

/**
 * A user home holding a Stratus home with two agents and the usual
 * credential files, laid out the way the daemon lays it out.
 */
const fixtureHome = async () => {
  const userHome = await realpath(await mkdtemp(path.join(os.tmpdir(), 'stratus-sandbox-')));
  const stratusHome = path.join(userHome, '.stratus');
  const workspace = path.join(stratusHome, 'agents', 'ava', 'workspace');
  const otherWorkspace = path.join(stratusHome, 'agents', 'bea', 'workspace');
  await mkdir(workspace, { recursive: true });
  await mkdir(otherWorkspace, { recursive: true });
  await mkdir(path.join(userHome, '.ssh'), { recursive: true });
  await writeFile(path.join(stratusHome, 'credentials.json'), '{"anthropic":"sk-secret"}');
  await writeFile(path.join(stratusHome, 'config.json'), '{"provider":"anthropic"}');
  await writeFile(path.join(otherWorkspace, 'notes.md'), 'bea-private');
  await writeFile(path.join(userHome, '.ssh', 'id_ed25519'), 'PRIVATE KEY');
  await writeFile(path.join(userHome, 'outside.txt'), 'outside');
  const workspaces: AgentWorkspaces = {
    forAgent: (agentId) => path.join(stratusHome, 'agents', agentId, 'workspace'),
    prepare: (agentId) => path.join(stratusHome, 'agents', agentId, 'workspace'),
    all: async () => [workspace, otherWorkspace],
  };
  return { userHome, stratusHome, workspace, otherWorkspace, workspaces };
};

const run = async (
  config: JsonObject,
  fixture: Awaited<ReturnType<typeof fixtureHome>>,
  command: string,
  extra: { planSandbox?: typeof planSandbox; warn?: (message: string) => void; processEnv?: NodeJS.ProcessEnv } = {},
) => {
  const tool = createShellTool(config, {
    workspaces: fixture.workspaces,
    home: fixture.userHome,
    processEnv: extra.processEnv ?? { PATH: process.env.PATH ?? '/usr/bin:/bin', SECRET_TOKEN: 'env-secret' },
    ...(extra.planSandbox ? { planSandbox: extra.planSandbox } : {}),
    ...(extra.warn ? { warn: extra.warn } : {}),
  });
  return createLocalCommandExecutor().execute({ id: 'c', toolName: 'shell.run', input: { command } }, tool, session('ava'));
};

const output = (result: Awaited<ReturnType<typeof run>>): { stdout: string; stderr: string } => {
  const value = result.output as { stdout?: string; stderr?: string } | null;
  return { stdout: value?.stdout ?? '', stderr: value?.stderr ?? '' };
};

// ---- the escape suite: every read must fail sandboxed and work unconfined ----

// Real walls only where this host can build them: macOS, or Linux with a
// working bwrap (CI installs it). Elsewhere the suite is skipped, and says so.
const sandboxedHere = realPlanSandbox({ workspace: os.tmpdir(), denied: [], writable: [] }, '/bin/sh', []).kind === 'sandboxed';
const NEEDS = 'needs a working sandbox here (macOS sandbox-exec, or bwrap on Linux)';

const ESCAPES: Array<[string, (f: Awaited<ReturnType<typeof fixtureHome>>) => string]> = [
  ['the credential store', (f) => `cat ${path.join(f.stratusHome, 'credentials.json')}`],
  ['the daemon config', (f) => `cat ${path.join(f.stratusHome, 'config.json')}`],
  ["another agent's workspace", (f) => `cat ${path.join(f.otherWorkspace, 'notes.md')}`],
  ['an ssh key', (f) => `cat ${path.join(f.userHome, '.ssh', 'id_ed25519')}`],
  ['the credential store through a workspace symlink', () => 'ln -sf ../../../credentials.json link && cat link'],
];

for (const [what, command] of ESCAPES) {
  test(`a sandboxed command cannot read ${what}, and an unconfined one can`, { skip: !sandboxedHere && NEEDS }, async () => {
    const fixture = await fixtureHome();
    const confined = await run({}, fixture, command(fixture));
    assert.equal(confined.ok, false, `sandboxed ${what} read should fail`);
    assert.doesNotMatch(output(confined).stdout, /sk-secret|anthropic|bea-private|PRIVATE KEY/);
    const unconfined = await run({ sandbox: 'off' }, fixture, command(fixture));
    assert.equal(unconfined.ok, true, `unconfined ${what} read should work, or the case proves nothing: ${JSON.stringify(unconfined.output)}`);
  });
}

test('a sandboxed command cannot write outside its workspace', { skip: !sandboxedHere && NEEDS }, async () => {
  const fixture = await fixtureHome();
  // Outside temp, which the fixture home itself lives in and which stays
  // writable: the package directory, cleaned up if the wall ever fails.
  const target = path.join(process.cwd(), `.sandbox-planted-${process.pid}`);
  await rm(target, { force: true });
  const confined = await run({}, fixture, `echo planted > ${target}`);
  const planted = existsSync(target);
  await rm(target, { force: true });
  assert.equal(confined.ok, false);
  assert.equal(planted, false);
  const rcFile = path.join(fixture.stratusHome, 'config.json');
  await run({}, fixture, `echo '{}' > ${rcFile}`);
  assert.equal(await readFile(rcFile, 'utf8'), '{"provider":"anthropic"}');
});

test('ordinary work still runs sandboxed: files, git, and a subshell in the workspace', { skip: !sandboxedHere && NEEDS }, async () => {
  const fixture = await fixtureHome();
  const result = await run({}, fixture, [
    'echo hello > note.txt && cat note.txt',
    'git init -q && git -c user.email=a@b -c user.name=a add note.txt && git -c user.email=a@b -c user.name=a commit -q -m one && git log --oneline | wc -l | tr -d " "',
    'pwd',
    'ls /usr/bin >/dev/null && echo toolchain',
  ].join(' && '));
  assert.equal(result.ok, true, JSON.stringify(result.output));
  const { stdout } = output(result);
  assert.match(stdout, /^hello\n1\n/);
  assert.match(stdout, new RegExp(fixture.workspace.replaceAll('/', '\\/')));
  assert.match(stdout, /toolchain/);
});

test('the environment a command gets is still only what was granted', { skip: !sandboxedHere && NEEDS }, async () => {
  const fixture = await fixtureHome();
  const result = await run({}, fixture, 'echo "[$SECRET_TOKEN]"');
  assert.equal(output(result).stdout, '[]\n');
});

// ---- modes ----

const unavailable: typeof planSandbox = () => ({ kind: 'unavailable', reason: 'bwrap cannot create a sandbox here (permission denied)' });

test('sandbox "required" refuses when no sandbox can start, and names why and what to change', async () => {
  const fixture = await fixtureHome();
  const result = await run({ sandbox: 'required' }, fixture, 'echo hi', { planSandbox: unavailable });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /shell\.run refused: commands must run sandboxed \(sandbox: "required"\), and bwrap cannot create a sandbox here \(permission denied\)/);
  assert.match(result.error ?? '', /set sandbox to "off"/);
});

test('sandbox "auto" runs unconfined where no sandbox can start, and says so once', async () => {
  resetSandboxWarning();
  const fixture = await fixtureHome();
  const warnings: string[] = [];
  const first = await run({}, fixture, 'echo one', { planSandbox: unavailable, warn: (m) => warnings.push(m) });
  const second = await run({}, fixture, 'echo two', { planSandbox: unavailable, warn: (m) => warnings.push(m) });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /commands run without a sandbox because bwrap cannot create a sandbox here/);
});

test('sandbox "off" never plans a sandbox, and an unknown value is refused', async () => {
  const fixture = await fixtureHome();
  let planned = false;
  const result = await run({ sandbox: 'off' }, fixture, 'echo hi', { planSandbox: (...args) => { planned = true; return unavailable(...args); } });
  assert.equal(result.ok, true);
  assert.equal(planned, false);
  const bad = await run({ sandbox: 'yes' }, fixture, 'echo hi');
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? '', /sandbox must be "auto", "required", or "off"; got "yes"/);
});

test('the policy hides the Stratus home and credentials and keeps the agent workspace', async () => {
  const fixture = await fixtureHome();
  let seen: Parameters<typeof planSandbox>[0] | undefined;
  await run({ deniedPaths: ['~/vault'], writablePaths: ['~/.gradle'] }, fixture, 'true', {
    planSandbox: (policy) => { seen = policy; return unavailable(policy, '', []); },
    warn: () => {},
  });
  assert.ok(seen);
  assert.equal(seen.workspace, fixture.workspace);
  assert.ok(seen.denied.includes(fixture.stratusHome));
  assert.ok(seen.denied.includes(path.join(fixture.userHome, '.ssh')));
  assert.ok(seen.denied.includes(path.join(fixture.userHome, 'vault')));
  assert.ok(seen.writable.includes(path.join(fixture.userHome, '.gradle')));
  assert.ok(seen.writable.includes(path.join(fixture.userHome, '.npm')));
});

// ---- pure pieces ----

test('the Stratus home is the configured one and the one a default-layout workspace sits in', () => {
  assert.deepEqual(stratusHomesFor('/srv/state/agents/ava/workspace', {}, '/home/u'), ['/home/u/.stratus', '/srv/state']);
  assert.deepEqual(stratusHomesFor('/work/ava', { STRATUS_HOME: '/data/stratus' }, '/home/u'), ['/data/stratus']);
});

test('the macOS profile gives the workspace back after hiding the home, and refuses keychain lookups', () => {
  const profile = darwinProfile({ workspace: '/nonexistent/h/.stratus/agents/ava/workspace', denied: ['/nonexistent/h/.stratus'], writable: [] });
  const deny = profile.indexOf('(deny file-read-data file-read-xattr file-write* (subpath "/nonexistent/h/.stratus"))');
  const giveBack = profile.indexOf('(allow file-read-data file-read-xattr file-read* file-write* (subpath "/nonexistent/h/.stratus/agents/ava/workspace"))');
  assert.ok(deny > 0 && giveBack > deny, profile);
  assert.match(profile, /\(deny mach-lookup \(global-name "com\.apple\.SecurityServer"\)/);
  assert.match(profile, /\(allow file-read-data [^\n]*\(literal "\/nonexistent\/h\/\.stratus\/agents"\)/);
  assert.throws(() => darwinProfile({ workspace: '/w"x', denied: [], writable: [] }), /quote, backslash, or newline/);
});

test('bwrap binds the root read-only, covers denied paths, and binds the workspace back last', async () => {
  const fixture = await fixtureHome();
  const args = bwrapArgs({ workspace: fixture.workspace, denied: [fixture.stratusHome, path.join(fixture.userHome, '.ssh', 'id_ed25519'), '/does/not/exist'], writable: [] }, '/bin/sh', ['-c', 'true']);
  const joined = args.join(' ');
  assert.match(joined, /^--ro-bind \/ \/ --dev \/dev --proc \/proc --tmpfs \/tmp/);
  assert.ok(joined.includes(`--tmpfs ${fixture.stratusHome}`));
  assert.ok(joined.includes(`--ro-bind /dev/null ${path.join(fixture.userHome, '.ssh', 'id_ed25519')}`));
  assert.ok(!joined.includes('/does/not/exist'));
  assert.ok(joined.indexOf(`--bind ${fixture.workspace} ${fixture.workspace}`) > joined.indexOf(`--tmpfs ${fixture.stratusHome}`));
  assert.match(joined, /--unshare-pid --unshare-ipc --die-with-parent --new-session -- \/bin\/sh -c true$/);
});

test('a workspace that is a symlink is bound from its real path under both names', async () => {
  const fixture = await fixtureHome();
  const real = await realpath(await mkdtemp(path.join(os.tmpdir(), 'stratus-real-ws-')));
  const linked = path.join(fixture.userHome, 'linked-ws');
  await symlink(real, linked);
  const joined = bwrapArgs({ workspace: linked, denied: [], writable: [] }, '/bin/sh', []).join(' ');
  assert.ok(joined.includes(`--bind ${real} ${linked}`));
  assert.ok(joined.includes(`--bind ${real} ${real}`));
});
