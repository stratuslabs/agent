import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AgentWorkspaces, JsonObject, ProtectedPaths, Session } from '@stratusagent/core';
import { createLocalCommandExecutor } from '@stratusagent/executor-local';

import {
  credentialAgentEndpoints,
  bwrapArgs,
  createShellTool,
  DEFAULT_VISIBLE_HOME_PATHS,
  darwinProfile,
  planSandbox as realPlanSandbox,
  resetSandboxWarning,
  relocatedCredentials,
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
const fixtureHome = async (root = os.tmpdir()) => {
  const userHome = await realpath(await mkdtemp(path.join(root, 'stratus-sandbox-')));
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
  // A token a CLI keeps inside an otherwise writable cache.
  await mkdir(path.join(userHome, '.cache', 'huggingface'), { recursive: true });
  await writeFile(path.join(userHome, '.cache', 'huggingface', 'token'), 'hf_SECRET');
  // The visible agents folder, the way the daemon surfaces it: the hidden
  // workspace and soul paths are links into ~/Stratus/<id>/.
  const visible = path.join(userHome, 'Stratus');
  const carlVisible = path.join(visible, 'carl', 'workspace');
  await mkdir(carlVisible, { recursive: true });
  await writeFile(path.join(carlVisible, 'notes.md'), 'carl-private');
  await mkdir(path.join(stratusHome, 'agents', 'carl'), { recursive: true });
  await symlink(carlVisible, path.join(stratusHome, 'agents', 'carl', 'workspace'));
  await writeFile(path.join(visible, 'carl', 'soul.md'), 'carl-soul');
  await symlink(path.join(visible, 'carl', 'soul.md'), path.join(stratusHome, 'agents', 'carl.md'));
  // A control socket of the kind a container runtime leaves on a host.
  const socket = path.join(userHome, 'run', 'ctl.sock');
  await mkdir(path.dirname(socket), { recursive: true });
  const carlWorkspace = path.join(stratusHome, 'agents', 'carl', 'workspace');
  const protectedPaths: ProtectedPaths = {
    all: async () => [stratusHome, path.join(stratusHome, 'credentials.json'), path.join(stratusHome, 'agents', 'carl.md')],
    exempt: async () => [workspace, otherWorkspace, carlWorkspace],
  };
  const workspaces: AgentWorkspaces = {
    forAgent: (agentId) => path.join(stratusHome, 'agents', agentId, 'workspace'),
    prepare: (agentId) => path.join(stratusHome, 'agents', agentId, 'workspace'),
    all: async () => [workspace, otherWorkspace, carlWorkspace],
  };
  return { userHome, stratusHome, workspace, otherWorkspace, workspaces, protectedPaths, visible, socket };
};

const run = async (
  config: JsonObject,
  fixture: Awaited<ReturnType<typeof fixtureHome>>,
  command: string,
  extra: { planSandbox?: typeof planSandbox; warn?: (message: string) => void; processEnv?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; agentId?: string } = {},
) => {
  const tool = createShellTool(config, {
    ...(extra.platform ? { platform: extra.platform } : {}),
    workspaces: fixture.workspaces,
    protectedPaths: fixture.protectedPaths,
    home: fixture.userHome,
    processEnv: extra.processEnv ?? { PATH: process.env.PATH ?? '/usr/bin:/bin', SECRET_TOKEN: 'env-secret' },
    ...(extra.planSandbox ? { planSandbox: extra.planSandbox } : {}),
    ...(extra.warn ? { warn: extra.warn } : {}),
  });
  return createLocalCommandExecutor().execute({ id: 'c', toolName: 'shell.run', input: { command } }, tool, session(extra.agentId ?? 'ava'));
};

const output = (result: Awaited<ReturnType<typeof run>>): { stdout: string; stderr: string } => {
  const value = result.output as { stdout?: string; stderr?: string } | null;
  return { stdout: value?.stdout ?? '', stderr: value?.stderr ?? '' };
};

// ---- the escape suite: every read must fail sandboxed and work unconfined ----

// Real walls only where this host can build them: macOS, or Linux with a
// working bwrap. Elsewhere the suite is skipped, and says so. CI does not
// install bwrap yet, so on CI the Linux backend is covered only at the
// argument level (bwrapArgs).
const sandboxedHere = realPlanSandbox({ workspace: os.tmpdir(), denied: [], writable: [] }, '/bin/sh', []).kind === 'sandboxed';
const NEEDS = 'needs a working sandbox here (macOS sandbox-exec, or bwrap on Linux)';

const ESCAPES: Array<[string, (f: Awaited<ReturnType<typeof fixtureHome>>) => string]> = [
  ['the credential store', (f) => `cat ${path.join(f.stratusHome, 'credentials.json')}`],
  ['the daemon config', (f) => `cat ${path.join(f.stratusHome, 'config.json')}`],
  ["another agent's workspace", (f) => `cat ${path.join(f.otherWorkspace, 'notes.md')}`],
  ['an ssh key', (f) => `cat ${path.join(f.userHome, '.ssh', 'id_ed25519')}`],
  ['the credential store through a workspace symlink', () => 'ln -sf ../../../credentials.json link && cat link'],
  // Codex P1 4309344603: the visible spellings of what the home links to.
  ["another agent's workspace by its visible path", (f) => `cat ${path.join(f.visible, 'carl', 'workspace', 'notes.md')}`],
  ["another agent's soul by its visible path", (f) => `cat ${path.join(f.visible, 'carl', 'soul.md')}`],
  // Codex P1 4309587628.
  ['a token inside the writable cache', (f) => `cat ${path.join(f.userHome, '.cache', 'huggingface', 'token')}`],
  // open-by-default.md Phase 2: the rest of the home is hidden by default.
  ['a file elsewhere in the home', (f) => `cat ${path.join(f.userHome, 'outside.txt')}`],
];

for (const [what, command] of ESCAPES) {
  test(`a sandboxed command cannot read ${what}, and an unconfined one can`, { skip: !sandboxedHere && NEEDS }, async () => {
    const fixture = await fixtureHome();
    const confined = await run({}, fixture, command(fixture));
    assert.equal(confined.ok, false, `sandboxed ${what} read should fail`);
    assert.doesNotMatch(output(confined).stdout, /sk-secret|anthropic|bea-private|carl-private|carl-soul|PRIVATE KEY|hf_SECRET/);
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

test('with no sandbox setting a command is refused where no sandbox can start', async () => {
  const fixture = await fixtureHome();
  const result = await run({}, fixture, 'echo hi', { planSandbox: unavailable });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /commands must run sandboxed \(sandbox: "required"\)/);
});

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
  const first = await run({ sandbox: 'auto' }, fixture, 'echo one', { planSandbox: unavailable, warn: (m) => warnings.push(m) });
  const second = await run({ sandbox: 'auto' }, fixture, 'echo two', { planSandbox: unavailable, warn: (m) => warnings.push(m) });
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
  await run({ sandbox: 'auto', deniedPaths: ['~/vault'], writablePaths: ['~/.gradle'] }, fixture, 'true', {
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
  // A socket under a denied path refuses connect(2), one form per path.
  const two = darwinProfile({ workspace: '/nonexistent/w', denied: ['/nonexistent/a', '/nonexistent/b'], writable: [] });
  assert.match(two, /\(deny network-outbound \(remote unix-socket \(subpath "\/nonexistent\/a"\)\) \(remote unix-socket \(subpath "\/nonexistent\/b"\)\)\)/);
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

test('a denied path reached through a symlinked directory is covered at its real path only', async () => {
  // CI with bwrap: /var/run is a link to /run, and bwrap resolves an absolute
  // link against the host root while it builds the new one, so a mount on
  // /var/run/docker.sock failed every command. The real path covers both names.
  const fixture = await fixtureHome();
  const real = await realpath(await mkdtemp(path.join(os.tmpdir(), 'stratus-real-run-')));
  await writeFile(path.join(real, 'docker.sock'), '');
  await mkdir(path.join(real, 'cache'));
  const alias = path.join(fixture.userHome, 'var-run');
  await symlink(real, alias);
  const args = bwrapArgs({ workspace: fixture.workspace, denied: [path.join(alias, 'docker.sock'), path.join(real, 'docker.sock')], writable: [path.join(alias, 'cache')] }, '/bin/sh', []);
  const joined = args.join(' ');
  assert.ok(joined.includes(`--ro-bind /dev/null ${path.join(real, 'docker.sock')}`));
  assert.ok(joined.includes(`--bind ${path.join(real, 'cache')} ${path.join(real, 'cache')}`));
  assert.ok(!joined.includes(alias), joined);
  assert.equal(args.filter((arg) => arg === path.join(real, 'docker.sock')).length, 1);
});

test('a sandboxed command cannot connect to a denied control socket, and an unconfined one can', { skip: !sandboxedHere && NEEDS }, async () => {
  // Codex P1 4309344608: a read-only view of a socket still accepts a
  // connection, and a container runtime's socket is the whole host.
  const fixture = await fixtureHome();
  const net = await import('node:net');
  const server = net.createServer((client) => client.end());
  await new Promise<void>((resolve) => server.listen(fixture.socket, resolve));
  try {
    const connect = `${process.execPath} -e "require('net').connect('${fixture.socket}').on('connect',()=>{console.log('CONNECTED');process.exit(0)}).on('error',(e)=>{console.log(e.code);process.exit(3)})"`;
    const confined = await run({ deniedPaths: [fixture.socket] }, fixture, connect);
    assert.doesNotMatch(output(confined).stdout, /CONNECTED/, JSON.stringify(confined.output));
    const unconfined = await run({ sandbox: 'off' }, fixture, connect);
    assert.match(output(unconfined).stdout, /CONNECTED/, JSON.stringify(unconfined.output));
  } finally {
    server.close();
  }
});

test('container runtime sockets are denied by default', async () => {
  const fixture = await fixtureHome();
  let seen: Parameters<typeof planSandbox>[0] | undefined;
  await run({}, fixture, 'true', { planSandbox: (policy) => { seen = policy; return unavailable(policy, '', []); }, warn: () => {} });
  for (const socket of ['/var/run/docker.sock', '/run/containerd/containerd.sock', '/run/podman/podman.sock']) {
    assert.ok(seen!.denied.includes(socket), socket);
  }
});

test('the policy denies what the host protects and every other agent\'s workspace, by their real paths too', async () => {
  const fixture = await fixtureHome();
  let seen: Parameters<typeof planSandbox>[0] | undefined;
  await run({}, fixture, 'true', { planSandbox: (policy) => { seen = policy; return unavailable(policy, '', []); }, warn: () => {} });
  assert.ok(seen!.denied.includes(path.join(fixture.stratusHome, 'agents', 'carl.md')));
  assert.ok(seen!.denied.includes(path.join(fixture.stratusHome, 'agents', 'carl', 'workspace')));
  assert.ok(seen!.denied.includes(fixture.otherWorkspace));
  assert.ok(!seen!.denied.includes(fixture.workspace), 'never its own workspace');
});

test('a workspace that holds a denied path does not give it back', { skip: !sandboxedHere && NEEDS }, async () => {
  // Codex P1 4309388132: with no workspace seam and no cwd, the fallback
  // can be the user's home, and the workspace was given back after the
  // denials, so `~/.ssh` and the Stratus home showed through again.
  const fixture = await fixtureHome();
  const tool = createShellTool({ cwd: fixture.userHome, sandbox: 'required' }, {
    home: fixture.userHome,
    processEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  });
  const read = (command: string) => createLocalCommandExecutor().execute({ id: 'c', toolName: 'shell.run', input: { command } }, tool, session('ava'));
  for (const target of [path.join(fixture.userHome, '.ssh', 'id_ed25519'), path.join(fixture.stratusHome, 'credentials.json')]) {
    const result = await read(`cat ${target}`);
    assert.equal(result.ok, false, `${target}: ${JSON.stringify(result.output)}`);
    assert.doesNotMatch(output(result).stdout, /PRIVATE KEY|sk-secret/);
  }
  // The rest of it is still the workspace.
  const ok = await read('echo hi > note.txt && cat outside.txt note.txt');
  assert.equal(ok.ok, true, JSON.stringify(ok.output));
  assert.equal(output(ok).stdout, "outsidehi\n");
});

test('an operator denied path inside the workspace stays denied', { skip: !sandboxedHere && NEEDS }, async () => {
  // Codex P1 4309587626: the workspace was given back after the denials.
  const fixture = await fixtureHome();
  await writeFile(path.join(fixture.workspace, '.env'), 'DB_PASSWORD=hunter2');
  const confined = await run({ deniedPaths: [path.join(fixture.workspace, '.env')] }, fixture, 'cat .env');
  assert.equal(confined.ok, false, JSON.stringify(confined.output));
  assert.doesNotMatch(output(confined).stdout, /hunter2/);
  const rest = await run({ deniedPaths: [path.join(fixture.workspace, '.env')] }, fixture, 'echo ok > x && cat x');
  assert.equal(output(rest).stdout, 'ok\n');
});

test('bwrap covers a denied path inside the workspace again after binding the workspace', async () => {
  const fixture = await fixtureHome();
  const joined = bwrapArgs({ workspace: fixture.userHome, denied: [fixture.stratusHome], writable: [] }, '/bin/sh', []).join(' ');
  assert.ok(joined.lastIndexOf(`--tmpfs ${fixture.stratusHome}`) > joined.indexOf(`--bind ${fixture.userHome} ${fixture.userHome}`), joined);
});

test('with a workspaceRoot, the other agents\' workspaces under it are denied', { skip: !sandboxedHere && NEEDS }, async () => {
  // Codex P1 4309587619: siblings came only from the host seam.
  const fixture = await fixtureHome();
  const root = path.join(fixture.userHome, 'work');
  await mkdir(path.join(root, 'ava'), { recursive: true });
  await mkdir(path.join(root, 'bea'), { recursive: true });
  await writeFile(path.join(root, 'bea', 'notes.md'), 'bea-private');
  const command = `cat ${path.join(root, 'bea', 'notes.md')}`;
  const confined = await run({ workspaceRoot: root }, fixture, command);
  assert.equal(confined.ok, false, JSON.stringify(confined.output));
  assert.doesNotMatch(output(confined).stdout, /bea-private/);
  const own = await run({ workspaceRoot: root }, fixture, 'echo mine > m && cat m');
  assert.equal(output(own).stdout, 'mine\n');
});


test('with no workspace and no cwd, required refuses instead of granting the process directory', async () => {
  // Codex P1 4310573233 / 4310550266: falling back to process.cwd() made
  // wherever the host started (a home, `/`, a repository with
  // node_modules/.bin on PATH) writable inside a "required" sandbox.
  const fixture = await fixtureHome();
  let planned = false;
  const tool = createShellTool({}, {
    home: fixture.userHome,
    processEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    planSandbox: (policy) => { planned = true; return unavailable(policy, '', []); },
  });
  const result = await createLocalCommandExecutor().execute({ id: 'c', toolName: 'shell.run', input: { command: 'echo hi' } }, tool, session('ava'));
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /no workspace to confine commands to/);
  assert.match(result.error ?? '', /cwd/);
  assert.equal(planned, false, 'no sandbox is planned around the process directory');
});

test('with no workspace and no cwd, auto runs unconfined and says so once', async () => {
  resetSandboxWarning();
  const fixture = await fixtureHome();
  const warnings: string[] = [];
  const tool = createShellTool({ sandbox: 'auto' }, {
    home: fixture.userHome,
    processEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    planSandbox: () => { throw new Error('should not plan'); },
    warn: (m) => warnings.push(m),
  });
  const exec = (command: string) => createLocalCommandExecutor().execute({ id: 'c', toolName: 'shell.run', input: { command } }, tool, session('ava'));
  assert.equal((await exec('echo one')).ok, true);
  assert.equal((await exec('echo two')).ok, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /no workspace/);
});

const capture = async (
  config: JsonObject,
  fixture: Awaited<ReturnType<typeof fixtureHome>>,
  extra: Omit<Parameters<typeof createShellTool>[1], 'planSandbox'> = {},
) => {
  let seen: Parameters<typeof planSandbox>[0] | undefined;
  let workspaceExisted: boolean | undefined;
  const tool = createShellTool(config, {
    workspaces: fixture.workspaces,
    protectedPaths: fixture.protectedPaths,
    home: fixture.userHome,
    processEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    warn: () => {},
    ...extra,
    planSandbox: (policy, shell, args) => {
      seen = policy;
      workspaceExisted = existsSync(policy.workspace);
      return unavailable(policy, shell, args);
    },
  });
  const result = await createLocalCommandExecutor().execute({ id: 'c', toolName: 'shell.run', input: { command: 'true' } }, tool, session('ava'));
  return { result, seen, workspaceExisted };
};

test('the user runtime directory is denied whole, with every service and agent socket in it', async () => {
  // Codex P1 4314782586: /run/user/$UID/bus reaches the user's systemd, and
  // rootless Docker and Podman listen there too. Codex P1 4315253857: so do
  // gpg-agent's ssh socket and systemd's ssh-agent, so the directory goes whole.
  const fixture = await fixtureHome();
  const runtime = path.join(fixture.userHome, 'xdg-runtime');
  const { seen } = await capture({}, fixture, { processEnv: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: runtime } });
  const uidDir = `/run/user/${process.getuid?.() ?? 0}`;
  for (const dir of [runtime, uidDir]) {
    assert.ok(seen!.denied.includes(dir), dir);
  }
});

test('ssh and gpg agent sockets are denied wherever the daemon can find them', async () => {
  // Codex P1 4315253857: a read-only view of a socket still accepts connect(2),
  // and an agent signs with keys whose files are hidden. Measured on macOS:
  // a sandboxed `ssh-add -l` reached launchd's agent in /private/tmp.
  const fixture = await fixtureHome();
  const agentSock = path.join(fixture.userHome, 'elsewhere', 'agent.sock');
  const { seen } = await capture({}, fixture, { processEnv: { PATH: '/usr/bin:/bin', SSH_AUTH_SOCK: agentSock } });
  assert.ok(seen!.denied.includes(agentSock), 'SSH_AUTH_SOCK');
  for (const entry of ['.1password', 'Library/Group Containers/2BUA8C4S2C.com.1password', 'Library/Containers/com.maxgoedjen.Secretive.SecretAgent']) {
    assert.ok(seen!.denied.includes(path.join(fixture.userHome, entry)), entry);
  }
  // launchd makes one per login session, named at random.
  assert.deepEqual(
    credentialAgentEndpoints({ SSH_AUTH_SOCK: 'relative.sock' }, 'darwin', () => ['com.apple.launchd.AbC123', 'other', 'com.apple.launchd.x']),
    ['/private/tmp/com.apple.launchd.AbC123', '/private/tmp/com.apple.launchd.x'],
  );
  assert.deepEqual(credentialAgentEndpoints({ SSH_AUTH_SOCK: '/tmp/ssh-q/agent.1' }, 'linux', () => ['com.apple.launchd.AbC123']), ['/tmp/ssh-q/agent.1']);
});

test('a workspaceRoot that cannot be listed refuses the command rather than hiding no siblings', { skip: process.getuid?.() === 0 && 'root lists anything' }, async () => {
  // Codex P1 4314782600: EACCES was read as "no other agents".
  const fixture = await fixtureHome();
  const root = path.join(fixture.userHome, 'work');
  await mkdir(path.join(root, 'ava'), { recursive: true });
  await mkdir(path.join(root, 'bea'), { recursive: true });
  await chmod(root, 0o100);
  try {
    const { result, seen } = await capture({ workspaceRoot: root }, fixture);
    assert.equal(result.ok, false, JSON.stringify(result.output));
    assert.equal(seen, undefined, 'never planned');
  } finally {
    await chmod(root, 0o755);
  }
  // A root that is not there yet holds no siblings, and the command runs.
  const missing = await capture({ workspaceRoot: path.join(fixture.userHome, 'nowhere') }, fixture);
  assert.ok(missing.seen, JSON.stringify(missing.result.output));
});

test('the workspace is prepared before it is bound, even when a configured cwd wins', async () => {
  // Codex P1 4314782607: bwrap --bind needs the source to exist.
  const fixture = await fixtureHome();
  await rm(fixture.workspace, { recursive: true });
  const project = path.join(fixture.userHome, 'project');
  await mkdir(project);
  const workspaces: AgentWorkspaces = {
    ...fixture.workspaces,
    prepare: (agentId) => {
      const dir = fixture.workspaces.forAgent(agentId);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
  };
  const { seen, workspaceExisted } = await capture({ cwd: project }, { ...fixture, workspaces }, { workspaces });
  assert.equal(seen!.workspace, fixture.workspace);
  assert.equal(workspaceExisted, true);
});

test('on Linux, missing writable caches are created before bwrap starts, and no macOS Library folders', async () => {
  // Codex P2 4314782623: the root is read-only, so a cache bwrap skipped could never be made.
  const fixture = await fixtureHome();
  const extra = path.join(fixture.userHome, 'opt-cache');
  await capture({ writablePaths: [extra] }, fixture, { platform: 'linux' });
  assert.ok(existsSync(extra));
  assert.ok(existsSync(path.join(fixture.userHome, '.pnpm-store')));
  assert.ok(existsSync(path.join(fixture.userHome, '.bun', 'install', 'cache')));
  assert.ok(!existsSync(path.join(fixture.userHome, 'Library')));
});

test('a sandboxed command can fill a writable cache that did not exist yet', { skip: !sandboxedHere && NEEDS }, async () => {
  const fixture = await fixtureHome();
  const cache = path.join(fixture.userHome, 'fresh-cache');
  const result = await run({ writablePaths: [cache] }, fixture, `mkdir -p ${cache}/pkg && echo ok > ${cache}/pkg/f && cat ${cache}/pkg/f`);
  assert.equal(output(result).stdout, 'ok\n', JSON.stringify(result.output));
});

test('a temp directory other than /tmp gets its own private tmpfs on Linux, before anything binds over it', async (t) => {
  // Codex P2 4315505054: with TMPDIR elsewhere, only /tmp was writable.
  const fixture = await fixtureHome();
  // On Linux the fixture home is under /tmp, which needs no tmpfs of its
  // own, so the custom temp directory lives beside this test file instead.
  const custom = await realpath(await mkdtemp(path.join(path.dirname(new URL(import.meta.url).pathname), '.scratch-tmp-')));
  t.after(() => rm(custom, { recursive: true, force: true }));
  assert.ok(!custom.startsWith('/tmp/'), custom);
  const cache = path.join(custom, 'cache');
  await mkdir(cache, { recursive: true });
  const joined = bwrapArgs({ workspace: fixture.workspace, denied: [], writable: [cache], tmp: custom }, '/bin/sh', []).join(' ');
  assert.ok(joined.includes(`--tmpfs ${custom}`), joined);
  assert.ok(joined.indexOf(`--tmpfs ${custom}`) < joined.indexOf(`--bind ${cache} ${cache}`), 'writable paths bind over it');
  // Under /tmp it is covered already; one holding the workspace would hide it.
  await mkdir('/tmp/stratus-test-tmp', { recursive: true }).catch(() => undefined);
  for (const tmp of ['/tmp/stratus-test-tmp', '/tmp', path.dirname(fixture.workspace), '/']) {
    const other = bwrapArgs({ workspace: fixture.workspace, denied: [], writable: [], tmp }, '/bin/sh', []);
    const covered = other.filter((arg, i) => arg === '--tmpfs' && other[i + 1] === tmp).length;
    assert.equal(covered, tmp === '/tmp' ? 1 : 0, tmp);
  }
});

test('stored tokens of common developer CLIs are denied', async () => {
  // Codex P1 4315505028: `cargo login` stores the registry token in
  // ~/.cargo/credentials.toml (legacy ~/.cargo/credentials), or under $CARGO_HOME.
  const fixture = await fixtureHome();
  const cargoHome = path.join(fixture.userHome, 'rust', 'cargo');
  const { seen } = await capture({}, fixture, { processEnv: { PATH: '/usr/bin:/bin', CARGO_HOME: cargoHome } });
  for (const entry of [
    '.cargo/credentials.toml', '.cargo/credentials', '.gem/credentials', '.config/hub', '.config/glab-cli',
    '.terraform.d/credentials.tfrc.json', '.vault-token', '.pulumi/credentials.json', '.m2/settings.xml',
    '.m2/settings-security.xml', '.gradle/gradle.properties', '.composer/auth.json', '.config/composer/auth.json',
    '.databrickscfg', '.config/doctl', '.oci', '.config/hcloud', '.claude/.credentials.json', '.codex/auth.json',
  ]) {
    assert.ok(seen!.denied.includes(path.join(fixture.userHome, entry)), entry);
  }
  for (const entry of ['credentials.toml', 'credentials']) {
    assert.ok(seen!.denied.includes(path.join(cargoHome, entry)), `$CARGO_HOME/${entry}`);
  }
});

// ---- the hidden home ----

const policyOf = async (config: JsonObject, fixture: Awaited<ReturnType<typeof fixtureHome>>, extra: { platform?: NodeJS.Platform; agentId?: string; processEnv?: NodeJS.ProcessEnv } = {}) => {
  let seen: Parameters<typeof planSandbox>[0] | undefined;
  const result = await run(config, fixture, 'true', { ...extra, planSandbox: (policy) => { seen = policy; return unavailable(policy, '', []); }, warn: () => {} });
  return { seen, result };
};

test('the home is hidden by default except toolchains, caches, and readablePaths', async () => {
  const fixture = await fixtureHome();
  const { seen } = await policyOf({ readablePaths: ['~/projects'] }, fixture);
  assert.equal(seen!.home?.path, fixture.userHome);
  for (const entry of ['.gitconfig', '.cargo', '.rustup', '.nvm', '.local/bin', '.npm']) {
    assert.ok(seen!.home!.visible.includes(path.join(fixture.userHome, entry)), entry);
  }
  assert.ok(seen!.home!.visible.includes(path.join(fixture.userHome, 'projects')));
  assert.ok(!seen!.home!.visible.some((entry) => entry === fixture.userHome), 'never the whole home');
  // Credentials inside a visible toolchain stay in the denied list.
  assert.ok(seen!.denied.includes(path.join(fixture.userHome, '.cargo', 'credentials.toml')));
  assert.ok(DEFAULT_VISIBLE_HOME_PATHS.every((entry) => !path.isAbsolute(entry)));
});

test('home: "visible" leaves the rest of the home readable, and an unknown value is refused', async () => {
  const fixture = await fixtureHome();
  const { seen } = await policyOf({ home: 'visible' }, fixture);
  assert.equal(seen!.home, undefined);
  const bad = await run({ home: 'open' }, fixture, 'true', { warn: () => {} });
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? '', /home must be "hidden" or "visible"; got "open"/);
});

test('the macOS profile hides the home, gives toolchains back, then denies credentials inside them', () => {
  const profile = darwinProfile({
    workspace: '/nonexistent/h/.stratus/agents/ava/workspace',
    denied: ['/nonexistent/h/.stratus', '/nonexistent/h/.cargo/credentials.toml'],
    writable: ['/nonexistent/h/.npm'],
    home: { path: '/nonexistent/h', visible: ['/nonexistent/h/.cargo', '/nonexistent/h/.npm'] },
  });
  const hide = profile.indexOf('(deny file-read-data file-read-xattr (subpath "/nonexistent/h"))');
  const socket = profile.indexOf('(deny network-outbound (remote unix-socket (subpath "/nonexistent/h")))');
  const back = profile.indexOf('(allow file-read-data file-read-xattr (subpath "/nonexistent/h/.cargo") (subpath "/nonexistent/h/.npm"))');
  const creds = profile.indexOf('(subpath "/nonexistent/h/.cargo/credentials.toml")');
  const writes = profile.indexOf('(deny file-write* (subpath "/"))');
  assert.ok(writes < hide && hide < back && socket < back && back < creds, profile);
});

test('bwrap covers the home with a tmpfs and binds toolchains back read-only before the writable caches', async () => {
  const fixture = await fixtureHome();
  const cargo = path.join(fixture.userHome, '.cargo');
  const npm = path.join(fixture.userHome, '.npm');
  await mkdir(cargo, { recursive: true });
  await mkdir(npm, { recursive: true });
  const joined = bwrapArgs({
    workspace: fixture.workspace,
    denied: [fixture.stratusHome],
    writable: [npm],
    home: { path: fixture.userHome, visible: [cargo, npm, path.join(fixture.userHome, '.missing')] },
  }, '/bin/sh', []).join(' ');
  const cover = joined.indexOf(`--tmpfs ${fixture.userHome} `);
  const back = joined.indexOf(`--ro-bind ${cargo} ${cargo}`);
  const write = joined.indexOf(`--bind ${npm} ${npm}`);
  const hide = joined.indexOf(`--tmpfs ${fixture.stratusHome}`);
  assert.ok(cover > 0 && cover < back && back < write && write < hide, joined);
  assert.ok(!joined.includes('.missing'));
});

test('a toolchain under the hidden home stays readable, and a credential inside it does not', { skip: !sandboxedHere && NEEDS }, async () => {
  const fixture = await fixtureHome();
  await mkdir(path.join(fixture.userHome, '.cargo', 'bin'), { recursive: true });
  await writeFile(path.join(fixture.userHome, '.cargo', 'bin', 'tool'), 'cargo-tool');
  await writeFile(path.join(fixture.userHome, '.cargo', 'credentials.toml'), 'cargo-secret');
  await writeFile(path.join(fixture.userHome, '.gitconfig'), 'gitconfig-ok');
  const ok = await run({}, fixture, `cat ${path.join(fixture.userHome, '.gitconfig')} ${path.join(fixture.userHome, '.cargo', 'bin', 'tool')}`);
  assert.equal(ok.ok, true, JSON.stringify(ok.output));
  assert.equal(output(ok).stdout, 'gitconfig-okcargo-tool');
  const creds = await run({}, fixture, `cat ${path.join(fixture.userHome, '.cargo', 'credentials.toml')}`);
  assert.equal(creds.ok, false);
  assert.doesNotMatch(output(creds).stdout, /cargo-secret/);
});

test('home: "visible" and readablePaths open the home again, and credentials stay hidden', { skip: !sandboxedHere && NEEDS }, async (t) => {
  // Outside /tmp: bwrap gives every command an empty /tmp, which would hide a
  // fixture home there whatever home says (os.tmpdir() is /tmp on Linux CI).
  const root = await mkdtemp(path.join(process.cwd(), '.sandbox-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await fixtureHome(root);
  const outside = path.join(fixture.userHome, 'outside.txt');
  // Here, unlike under /tmp, it is the hidden home that keeps it unreadable.
  const hidden = await run({}, fixture, `cat ${outside}`);
  assert.equal(hidden.ok, false, JSON.stringify(hidden.output));
  const visible = await run({ home: 'visible' }, fixture, `cat ${outside}`);
  assert.equal(output(visible).stdout, 'outside', JSON.stringify(visible.output));
  await mkdir(path.join(fixture.userHome, 'projects'), { recursive: true });
  await writeFile(path.join(fixture.userHome, 'projects', 'a.txt'), 'project-a');
  const listed = await run({ readablePaths: ['~/projects'] }, fixture, `cat ${path.join(fixture.userHome, 'projects', 'a.txt')}`);
  assert.equal(output(listed).stdout, 'project-a', JSON.stringify(listed.output));
  const key = await run({ home: 'visible' }, fixture, `cat ${path.join(fixture.userHome, '.ssh', 'id_ed25519')}`);
  assert.equal(key.ok, false);
});

test('a configured cwd under the hidden home stays readable', { skip: !sandboxedHere && NEEDS }, async () => {
  // Codex P1 4316843343: on macOS the home deny covered a configured cwd
  // under the home, so commands started there but could not read it.
  const fixture = await fixtureHome();
  const project = path.join(fixture.userHome, 'work', 'foo');
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, 'src.txt'), 'project-src');
  const result = await run({ cwd: project }, fixture, 'cat src.txt && ls');
  assert.equal(result.ok, true, JSON.stringify(result.output));
  assert.match(output(result).stdout, /^project-src/);
  // The rest of the home stays hidden.
  const outside = await run({ cwd: project }, fixture, `cat ${path.join(fixture.userHome, 'outside.txt')}`);
  assert.equal(outside.ok, false);
});

test('the macOS profile gives a configured cwd back for reading after hiding the home', () => {
  const profile = darwinProfile({
    workspace: '/nonexistent/h/.stratus/agents/ava/workspace',
    cwd: '/nonexistent/h/work/foo',
    denied: ['/nonexistent/h/.stratus'],
    writable: [],
    home: { path: '/nonexistent/h', visible: [] },
  });
  const hide = profile.indexOf('(deny file-read-data file-read-xattr (subpath "/nonexistent/h"))');
  const back = profile.indexOf('(allow file-read-data file-read-xattr (subpath "/nonexistent/h/work/foo"))');
  assert.ok(hide >= 0 && back > hide, profile);
});

test('a credential store an environment variable moves is denied where it was moved', async () => {
  // Codex P1 4316301467: gh keeps its token under $GH_CONFIG_DIR, else
  // $XDG_CONFIG_HOME/gh, so the fixed ~/.config/gh left a moved one readable.
  // Swept for the other stores whose location a variable sets.
  const fixture = await fixtureHome();
  const elsewhere = path.join(path.dirname(fixture.userHome), 'elsewhere');
  const at = (name: string) => path.join(elsewhere, name);
  const processEnv: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    GH_CONFIG_DIR: at('gh'),
    XDG_CONFIG_HOME: at('xdg-config'),
    XDG_CACHE_HOME: at('xdg-cache'),
    DOCKER_CONFIG: at('docker'),
    DOCKER_HOST: `unix://${at('docker.sock')}`,
    CONTAINER_HOST: `unix://${at('podman.sock')}`,
    KUBECONFIG: `${at('kube-a')}:${at('kube-b')}`,
    AWS_SHARED_CREDENTIALS_FILE: at('aws-credentials'),
    AWS_CONFIG_FILE: at('aws-config'),
    GNUPGHOME: at('gnupg'),
    CLOUDSDK_CONFIG: at('gcloud'),
    AZURE_CONFIG_DIR: at('azure'),
    NPM_CONFIG_USERCONFIG: at('npmrc-upper'),
    npm_config_userconfig: at('npmrc-lower'),
    PASSWORD_STORE_DIR: at('pass'),
    CARGO_HOME: at('cargo'),
    PULUMI_HOME: at('pulumi'),
    TF_CLI_CONFIG_FILE: at('terraformrc'),
    GRADLE_USER_HOME: at('gradle'),
    COMPOSER_HOME: at('composer'),
    DATABRICKS_CONFIG_FILE: at('databrickscfg'),
    CLAUDE_CONFIG_DIR: at('claude'),
    CODEX_HOME: at('codex'),
    HF_HOME: at('hf'),
    HF_TOKEN_PATH: at('hf-token'),
    GLAB_CONFIG_DIR: at('glab'),
    HUB_CONFIG: at('hub'),
    OP_CONFIG_DIR: at('op'),
  };
  const { seen } = await capture({}, fixture, { processEnv });
  for (const expected of [
    at('gh'), at('xdg-config/gh'), at('xdg-config/git/credentials'), at('xdg-config/gcloud'),
    at('xdg-cache/huggingface/token'), at('docker'), at('docker.sock'), at('podman.sock'), at('kube-a'), at('kube-b'),
    at('aws-credentials'), at('aws-config'), at('gnupg'), at('gcloud'), at('azure'), at('npmrc-upper'), at('npmrc-lower'),
    at('pass'), at('cargo/credentials.toml'), at('cargo/credentials'), at('pulumi/credentials.json'), at('terraformrc'),
    at('gradle/gradle.properties'), at('composer/auth.json'), at('databrickscfg'), at('claude/.credentials.json'),
    at('codex/auth.json'), at('hf/token'), at('hf/stored_tokens'), at('hf-token'), at('glab'), at('hub'), at('op'),
  ]) {
    assert.ok(seen!.denied.includes(expected), expected);
  }
});

test('a moved credential location that is relative, or holds the home or the workspace, is not denied', () => {
  const home = '/Users/ava';
  const workspace = '/Users/ava/.stratus/agents/ava/workspace';
  const found = relocatedCredentials({
    GH_CONFIG_DIR: 'relative/gh',
    DOCKER_CONFIG: '/',
    GNUPGHOME: home,
    AZURE_CONFIG_DIR: workspace,
    DOCKER_HOST: 'tcp://127.0.0.1:2375',
    KUBECONFIG: ':relative:/etc/kube',
  }, home, workspace);
  assert.deepEqual(found, ['/etc/kube']);
});

test('the gateway token a mounted secret supplies is denied where it is mounted', () => {
  // Codex P1 4330123135: the host protects only ~/.stratus/gateway-token,
  // and the documented Docker setup reads it from /run/secrets instead.
  const found = relocatedCredentials({ STRATUS_GATEWAY_TOKEN_FILE: '/run/secrets/stratus-gateway-token' }, '/home/ava', '/home/ava/.stratus/agents/ava/workspace');
  assert.deepEqual(found, ['/run/secrets/stratus-gateway-token']);
});

test('a hidden home reached through a symlinked directory is covered and given back at its real path', async () => {
  // Codex P1 4330384998: bwrap cannot mount through a linked directory, so
  // an alias spelling of the home failed every command before it started.
  const real = await realpath(await mkdtemp(path.join(os.tmpdir(), 'stratus-real-home-')));
  await mkdir(path.join(real, '.cargo'));
  await mkdir(path.join(real, '.local', 'rustup'), { recursive: true });
  await symlink(path.join(real, '.local', 'rustup'), path.join(real, '.rustup'));
  const aliasRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'stratus-alias-')));
  const alias = path.join(aliasRoot, 'home');
  await symlink(real, alias);
  const workspace = path.join(real, '.stratus', 'agents', 'ava', 'workspace');
  await mkdir(workspace, { recursive: true });
  const args = bwrapArgs({
    workspace,
    denied: [],
    writable: [],
    home: { path: alias, visible: [path.join(alias, '.cargo'), path.join(alias, '.rustup')] },
  }, '/bin/sh', []);
  const joined = args.join(' ');
  assert.ok(joined.includes(`--tmpfs ${real} `), joined);
  assert.ok(joined.includes(`--ro-bind ${path.join(real, '.cargo')} ${path.join(real, '.cargo')}`), joined);
  // A visible entry that links elsewhere in the home: both names come back.
  assert.ok(joined.includes(`--ro-bind ${path.join(real, '.local', 'rustup')} ${path.join(real, '.rustup')}`), joined);
  assert.ok(joined.includes(`--ro-bind ${path.join(real, '.local', 'rustup')} ${path.join(real, '.local', 'rustup')}`), joined);
  assert.ok(!joined.includes(alias), joined);
});

test('readablePaths inside the Stratus home are readable, and what is denied around and inside them is not', { skip: !sandboxedHere && NEEDS }, async (t) => {
  // An agent's own integration config (gitconfig, gh) that the host keeps
  // under ~/.stratus/integrations/<id>: 0.13.0 denied it with the rest of
  // the Stratus home, so git failed in every sandboxed command.
  const root = await mkdtemp(path.join(process.cwd(), '.sandbox-integrations-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await fixtureHome(root);
  const integration = path.join(fixture.stratusHome, 'integrations', 'ava');
  await mkdir(integration, { recursive: true });
  await writeFile(path.join(integration, 'gitconfig'), '[user]\n\tname = ava\n');
  await writeFile(path.join(integration, 'private.key'), 'integration-secret');
  const config = { readablePaths: ['~/.stratus/integrations/ava'], deniedPaths: ['~/.stratus/integrations/ava/private.key'] };
  const read = await run(config, fixture, `cat ${path.join(integration, 'gitconfig')}`);
  assert.match(output(read).stdout, /name = ava/, JSON.stringify(read.output));
  for (const target of [path.join(fixture.stratusHome, 'credentials.json'), path.join(fixture.otherWorkspace, 'notes.md'), path.join(integration, 'private.key')]) {
    const denied = await run(config, fixture, `cat ${target}`);
    assert.equal(denied.ok, false, `${target}: ${JSON.stringify(denied.output)}`);
  }
  const write = await run(config, fixture, `echo x > ${path.join(integration, 'gitconfig')}`);
  assert.equal(write.ok, false, JSON.stringify(write.output));
  const workspace = await run(config, fixture, 'echo ok > note.txt && cat note.txt');
  assert.equal(output(workspace).stdout.trim(), 'ok', JSON.stringify(workspace.output));
});

test('readable paths come after the denials, and denials inside them come after that', async () => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'stratus-readable-')));
  const stratus = path.join(home, '.stratus');
  const workspace = path.join(stratus, 'agents', 'ava', 'workspace');
  const integration = path.join(stratus, 'integrations', 'ava');
  const secret = path.join(integration, 'gh');
  await mkdir(workspace, { recursive: true });
  await mkdir(secret, { recursive: true });
  const policy = { workspace, denied: [stratus, secret], writable: [], readable: [integration] };
  const profile = darwinProfile(policy);
  const allow = profile.indexOf(`(allow file-read-data file-read-xattr (subpath "${integration}"))`);
  assert.ok(allow > profile.indexOf(`(subpath "${stratus}")`), profile);
  assert.ok(profile.lastIndexOf(`(subpath "${secret}")`) > allow, profile);
  const args = bwrapArgs(policy, '/bin/sh', []).join(' ');
  const bound = args.indexOf(`--ro-bind ${integration} ${integration}`);
  assert.ok(bound > args.indexOf(`--tmpfs ${stratus} `), args);
  assert.ok(bound < args.indexOf(`--bind ${workspace} ${workspace}`), args);
  assert.ok(args.lastIndexOf(`--tmpfs ${secret}`) > bound, args);
});

test('writablePaths inside the Stratus home are writable, and what is denied around and inside them is not', { skip: !sandboxedHere && NEEDS }, async (t) => {
  // An agent's own HOME that the host keeps under
  // ~/.stratus/integrations/<id>/home: CLIs that save their own config
  // (vercel, gh, gcloud) got EPERM there, since the Stratus home's denial
  // came after the writable paths.
  const root = await mkdtemp(path.join(process.cwd(), '.sandbox-agent-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await fixtureHome(root);
  const agentHome = path.join(fixture.stratusHome, 'integrations', 'ava', 'home');
  await mkdir(agentHome, { recursive: true });
  await writeFile(path.join(agentHome, 'private.key'), 'integration-secret');
  const config = { writablePaths: ['~/.stratus/integrations/ava/home'], deniedPaths: ['~/.stratus/integrations/ava/home/private.key'] };
  const saved = path.join(agentHome, 'Library', 'Application Support', 'cli', 'auth.json');
  const write = await run(config, fixture, `mkdir -p "${path.dirname(saved)}" && echo '{}' > "${saved}" && cat "${saved}"`);
  assert.equal(output(write).stdout.trim(), '{}', JSON.stringify(write.output));
  for (const target of [path.join(fixture.stratusHome, 'credentials.json'), path.join(fixture.otherWorkspace, 'notes.md'), path.join(agentHome, 'private.key')]) {
    const denied = await run(config, fixture, `cat ${target}`);
    assert.equal(denied.ok, false, `${target}: ${JSON.stringify(denied.output)}`);
  }
  // Beside the agent's home stays denied. On macOS the write fails; under
  // bwrap the denial is an empty tmpfs, so the write may land there, but
  // either way nothing reaches the real directory.
  const beside = path.join(fixture.stratusHome, 'integrations', 'ava', 'other.txt');
  const outside = await run(config, fixture, `echo x > ${beside}`);
  assert.equal(existsSync(beside), false, JSON.stringify(outside.output));
});

test('on Linux, a deniedPaths entry inside writablePaths that does not exist yet is refused, since bwrap could not mask it', async () => {
  // Codex P2 4332582670: realOnly drops an absent path, so the command could
  // create and use it inside the writable bind.
  const fixture = await fixtureHome();
  const agentHome = path.join(fixture.stratusHome, 'integrations', 'ava', 'home');
  await mkdir(agentHome, { recursive: true });
  const config = { writablePaths: ['~/.stratus/integrations/ava/home'], deniedPaths: ['~/.stratus/integrations/ava/home/.ssh'] };
  let planned = false;
  const refused = await run(config, fixture, 'true', { platform: 'linux', planSandbox: (policy) => { planned = true; return unavailable(policy, '', []); }, warn: () => {} });
  assert.equal(refused.ok, false, JSON.stringify(refused.output));
  assert.equal(planned, false);
  assert.match(refused.error ?? '', /shell\.run refused: deniedPaths names .*\.ssh, inside writablePaths .*, and it does not exist/);
  assert.equal(existsSync(path.join(agentHome, '.ssh')), false, 'nothing is created on the host to make it maskable');
  // Once it exists it can be masked, so the command is planned; and macOS
  // denies an absent path natively, so it is never refused there.
  const { seen: darwin } = await policyOf(config, fixture, { platform: 'darwin' });
  assert.ok(darwin, 'darwin plans with the path absent');
  await mkdir(path.join(agentHome, '.ssh'));
  const { seen: linux } = await policyOf(config, fixture, { platform: 'linux' });
  assert.ok(linux, 'linux plans once the path exists');
});

test('on Linux, an absent deniedPaths entry reached through a symlinked parent is still refused inside writablePaths', async () => {
  // Codex P2 4332701171: the absent path cannot be realpath'd whole, so the
  // check resolves its nearest existing ancestor before comparing.
  const fixture = await fixtureHome();
  const agentHome = path.join(fixture.stratusHome, 'integrations', 'ava', 'home');
  await mkdir(agentHome, { recursive: true });
  const alias = path.join(fixture.userHome, 'alias');
  await symlink(path.join(fixture.stratusHome, 'integrations', 'ava'), alias);
  const config = { writablePaths: ['~/.stratus/integrations/ava/home'], deniedPaths: [path.join(alias, 'home', '.ssh')] };
  let planned = false;
  const refused = await run(config, fixture, 'true', { platform: 'linux', planSandbox: (policy) => { planned = true; return unavailable(policy, '', []); }, warn: () => {} });
  assert.equal(refused.ok, false, JSON.stringify(refused.output));
  assert.equal(planned, false);
  assert.match(refused.error ?? '', /shell\.run refused: deniedPaths names .*\.ssh, inside writablePaths .*, and it does not exist/);
});

test('on Linux, an absent credential location the environment names inside writablePaths is refused too', async () => {
  // Codex P1 4336171867: the check read only settings.deniedPaths, while the
  // writable bind is restored over every denial, so a relocated credential
  // store or agent socket that did not exist yet could be created and used.
  const fixture = await fixtureHome();
  const agentHome = path.join(fixture.stratusHome, 'integrations', 'ava', 'home');
  await mkdir(agentHome, { recursive: true });
  const config = { writablePaths: ['~/.stratus/integrations/ava/home'] };
  for (const [name, value, absent] of [
    ['GH_CONFIG_DIR', path.join(agentHome, '.config', 'gh'), path.join(agentHome, '.config', 'gh')],
    ['SSH_AUTH_SOCK', path.join(agentHome, 'agent.sock'), path.join(agentHome, 'agent.sock')],
  ] as const) {
    const processEnv = { PATH: '/usr/bin:/bin', [name]: value };
    let planned = false;
    const refused = await run(config, fixture, 'true', { platform: 'linux', processEnv, planSandbox: (policy) => { planned = true; return unavailable(policy, '', []); }, warn: () => {} });
    assert.equal(refused.ok, false, `${name}: ${JSON.stringify(refused.output)}`);
    assert.equal(planned, false, name);
    assert.match(refused.error ?? '', /shell\.run refused: .*must stay hidden from commands, is inside writablePaths .*, and does not exist/, name);
    assert.equal(existsSync(absent), false, `${name}: nothing is created on the host`);
    // macOS denies an absent path as written, so it plans there.
    const { seen: darwin } = await policyOf(config, fixture, { platform: 'darwin', processEnv });
    assert.ok(darwin, `${name}: darwin plans with the path absent`);
  }
  // A credential location outside every writable path is masked or absent
  // under a read-only root either way, so it does not refuse.
  const { seen: elsewhere } = await policyOf(config, fixture, { platform: 'linux', processEnv: { PATH: '/usr/bin:/bin', GH_CONFIG_DIR: path.join(fixture.userHome, 'nowhere', 'gh') } });
  assert.ok(elsewhere, 'linux plans when the absent denial is outside writablePaths');
  // The fixed built-in list is not refused on (card 605 tracks it): a grant
  // of ~/.gradle with no gradle.properties yet keeps working.
  const { seen: gradle } = await policyOf({ writablePaths: ['~/.gradle'] }, fixture, { platform: 'linux', processEnv: { PATH: '/usr/bin:/bin' } });
  assert.ok(gradle, 'linux plans a ~/.gradle grant with gradle.properties absent');
});

test('on Linux, an absent deniedPaths entry inside the agent\'s workspace is refused, since bwrap could not mask it there either', async () => {
  // Card 605: the workspace is a writable bind like writablePaths, so an
  // absent denial inside it could be created and used by a command.
  const fixture = await fixtureHome();
  const secret = path.join(fixture.workspace, '.env');
  const config = { deniedPaths: ['~/.stratus/agents/ava/workspace/.env'] };
  let planned = false;
  const refused = await run(config, fixture, 'true', { platform: 'linux', planSandbox: (policy) => { planned = true; return unavailable(policy, '', []); }, warn: () => {} });
  assert.equal(refused.ok, false, JSON.stringify(refused.output));
  assert.equal(planned, false);
  assert.match(refused.error ?? '', /shell\.run refused: deniedPaths names .*\.env, inside the agent's workspace .*, and it does not exist/);
  assert.match(refused.error ?? '', /Create it \(an empty file or directory\) before running commands, or remove it from deniedPaths/);
  assert.equal(existsSync(secret), false, 'nothing is created on the host');
  const { seen: darwin } = await policyOf(config, fixture, { platform: 'darwin' });
  assert.ok(darwin, 'darwin plans with the path absent');
  await writeFile(secret, '');
  const { seen: linux } = await policyOf(config, fixture, { platform: 'linux' });
  assert.ok(linux, 'linux plans once the path exists');
});

test('on Linux, an absent denial inside a configured working directory is refused, whether deniedPaths or the environment names it', async () => {
  const fixture = await fixtureHome();
  const projects = path.join(fixture.userHome, 'projects');
  await mkdir(projects, { recursive: true });
  const denied = await run({ cwd: '~/projects', deniedPaths: ['~/projects/secrets'] }, fixture, 'true', { platform: 'linux', planSandbox: (policy) => unavailable(policy, '', []), warn: () => {} });
  assert.equal(denied.ok, false, JSON.stringify(denied.output));
  assert.match(denied.error ?? '', /shell\.run refused: deniedPaths names .*secrets, inside the working directory .*projects, and it does not exist/);
  const processEnv = { PATH: '/usr/bin:/bin', SSH_AUTH_SOCK: path.join(projects, 'agent.sock') };
  const socket = await run({ cwd: '~/projects' }, fixture, 'true', { platform: 'linux', processEnv, planSandbox: (policy) => unavailable(policy, '', []), warn: () => {} });
  assert.equal(socket.ok, false, JSON.stringify(socket.output));
  assert.match(socket.error ?? '', /must stay hidden from commands, is inside the working directory .*projects, and does not exist/);
  assert.equal(existsSync(path.join(projects, 'secrets')), false);
  // Absent denials outside every writable bind still plan.
  const { seen } = await policyOf({ cwd: '~/projects', deniedPaths: ['~/elsewhere/secrets'] }, fixture, { platform: 'linux' });
  assert.ok(seen, 'linux plans when the absent denial is outside the workspace and working directory');
});

test('on Linux, an absent denial under an existing denied directory is not refused, since that directory is masked whole', async () => {
  // Codex P2 4349031916: bwrap masks the existing parent after the cwd and
  // workspace binds, so nothing under it can be created or read.
  const fixture = await fixtureHome();
  const projects = path.join(fixture.userHome, 'projects');
  await mkdir(path.join(projects, 'secrets'), { recursive: true });
  await mkdir(path.join(fixture.workspace, 'private'), { recursive: true });
  const nested = { cwd: '~/projects', deniedPaths: ['~/projects/secrets', '~/projects/secrets/token', '~/.stratus/agents/ava/workspace/private', '~/.stratus/agents/ava/workspace/private/key'] };
  const { seen } = await policyOf(nested, fixture, { platform: 'linux' });
  assert.ok(seen, 'linux plans: every absent entry sits under an existing masked directory');
  // A writable path inside the denied directory gives part of it back, so
  // an absent denial inside that part is refused as before.
  await mkdir(path.join(projects, 'secrets', 'open'), { recursive: true });
  const reopened = await run(
    { cwd: '~/projects', writablePaths: ['~/projects/secrets/open'], deniedPaths: ['~/projects/secrets', '~/projects/secrets/open/token'] },
    fixture, 'true', { platform: 'linux', planSandbox: (policy) => unavailable(policy, '', []), warn: () => {} },
  );
  assert.equal(reopened.ok, false, JSON.stringify(reopened.output));
  assert.match(reopened.error ?? '', /deniedPaths names .*open.token, inside writablePaths .*open, and it does not exist/);
});

test('granted writable paths come after the denials and the readable paths, and denials inside them come after that', async () => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'stratus-writable-')));
  const stratus = path.join(home, '.stratus');
  const workspace = path.join(stratus, 'agents', 'ava', 'workspace');
  const integration = path.join(stratus, 'integrations', 'ava');
  const agentHome = path.join(integration, 'home');
  const secret = path.join(agentHome, '.ssh');
  await mkdir(workspace, { recursive: true });
  await mkdir(secret, { recursive: true });
  const policy = { workspace, denied: [stratus, secret], writable: [agentHome], readable: [integration], grantedWritable: [agentHome] };
  const profile = darwinProfile(policy);
  const allow = profile.indexOf(`(allow file-read-data file-read-xattr file-read* file-write* (subpath "${agentHome}"))`);
  assert.ok(allow > profile.indexOf(`(deny file-read-data file-read-xattr file-write* (subpath "${stratus}")`), profile);
  assert.ok(allow > profile.indexOf(`(allow file-read-data file-read-xattr (subpath "${integration}"))`), profile);
  assert.ok(profile.lastIndexOf(`(subpath "${secret}")`) > allow, profile);
  const args = bwrapArgs(policy, '/bin/sh', []).join(' ');
  const bound = args.lastIndexOf(`--bind ${agentHome} ${agentHome}`);
  assert.ok(bound > args.indexOf(`--tmpfs ${stratus} `), args);
  assert.ok(bound > args.indexOf(`--ro-bind ${integration} ${integration}`), args);
  assert.ok(bound < args.indexOf(`--bind ${workspace} ${workspace}`), args);
  assert.ok(args.lastIndexOf(`--tmpfs ${secret}`) > bound, args);
});

test('writablePaths that name the Stratus home, a directory above it, or one holding a protected file are refused', async () => {
  // A named writable path wins over the denials around it, so one that
  // holds the Stratus home would reopen writes to credentials and config.
  const fixture = await fixtureHome();
  for (const entry of ['~/.stratus', '~', path.dirname(fixture.userHome), '~/Stratus', '~/.stratus/agents']) {
    let planned = false;
    const refused = await run({ writablePaths: [entry] }, fixture, 'true', { planSandbox: (policy) => { planned = true; return unavailable(policy, '', []); }, warn: () => {} });
    assert.equal(refused.ok, false, `${entry}: ${JSON.stringify(refused.output)}`);
    assert.equal(planned, false, `${entry}: refused before any command is planned`);
    assert.match(refused.error ?? "", /shell\.run refused: writablePaths names /, entry);
  }
  // Codex P1 4332701160: a path inside another agent's workspace is refused
  // too, by its hidden or its visible spelling, existing or not.
  await mkdir(path.join(fixture.otherWorkspace, 'sub'), { recursive: true });
  for (const entry of [path.join(fixture.otherWorkspace, 'sub'), path.join(fixture.visible, 'carl', 'workspace', 'sub'), '~/.stratus/agents/carl/workspace/new']) {
    let planned = false;
    const refused = await run({ writablePaths: [entry] }, fixture, 'true', { planSandbox: (policy) => { planned = true; return unavailable(policy, '', []); }, warn: () => {} });
    assert.equal(refused.ok, false, `${entry}: ${JSON.stringify(refused.output)}`);
    assert.equal(planned, false, `${entry}: refused before any command is planned`);
    assert.match(refused.error ?? '', /shell\.run refused: writablePaths names .*another agent's workspace/, entry);
  }
  const { seen } = await policyOf({ writablePaths: ['~/.stratus/integrations/ava/home'] }, fixture);
  assert.deepEqual(seen!.grantedWritable, [path.join(fixture.userHome, '.stratus', 'integrations', 'ava', 'home')]);
});

test('a writablePaths entry inside a directory the host protects, other than the Stratus home, is refused (Codex P1 4334075011)', async () => {
  // A gateway with its own stateDir protects it; a writable path under it
  // would be re-granted after the denial and open the sessions to commands.
  const fixture = await fixtureHome();
  const stateDir = path.join(fixture.userHome, 'state-elsewhere');
  await mkdir(path.join(stateDir, 'sessions'), { recursive: true });
  const inner = fixture.protectedPaths;
  const withState = { ...fixture, protectedPaths: { ...inner, all: async () => [...await inner.all(), stateDir] } };
  for (const entry of [path.join(stateDir, 'sessions'), path.join(stateDir, 'not-yet')]) {
    let planned = false;
    const refused = await run({ writablePaths: [entry] }, withState, 'true', { planSandbox: (policy) => { planned = true; return unavailable(policy, '', []); }, warn: () => {} });
    assert.equal(refused.ok, false, `${entry}: ${JSON.stringify(refused.output)}`);
    assert.equal(planned, false, `${entry}: refused before any command is planned`);
    assert.match(refused.error ?? '', /shell\.run refused: writablePaths names .*, which is inside .*state-elsewhere, a directory the host protects/, entry);
  }
  // The Stratus home stays the one exception: an agent's own home inside it.
  const { seen } = await policyOf({ writablePaths: ['~/.stratus/integrations/ava/home'] }, withState);
  assert.deepEqual(seen!.grantedWritable, [path.join(fixture.userHome, '.stratus', 'integrations', 'ava', 'home')]);
});

test('inside the Stratus home only the agent\'s own integrations/<id>/home or its own workspace may be writable (Codex P1 4334240775)', async () => {
  // The Stratus home is denied and writablePaths are granted after it, so
  // any descendant named here would be reopened: sessions, the daemon's
  // state, another agent's integration home, the agent's own credentials
  // beside its home. Only the two places this agent already owns pass.
  const fixture = await fixtureHome();
  const stratus = fixture.stratusHome;
  await mkdir(path.join(stratus, 'sessions'), { recursive: true });
  await mkdir(path.join(stratus, 'integrations', 'bea', 'home'), { recursive: true });
  await mkdir(path.join(stratus, 'integrations', 'ava', 'home'), { recursive: true });
  const alias = path.join(fixture.userHome, 'sessions-alias');
  await symlink(path.join(stratus, 'sessions'), alias);
  for (const entry of [
    '~/.stratus/sessions',
    '~/.stratus/not-yet',
    '~/.stratus/integrations/bea/home',
    '~/.stratus/integrations/ava',
    '~/.stratus/integrations/ava/other',
    '~/.stratus/agents/ava',
    alias,
  ]) {
    let planned = false;
    const refused = await run({ writablePaths: [entry] }, fixture, 'true', { planSandbox: (policy) => { planned = true; return unavailable(policy, '', []); }, warn: () => {} });
    assert.equal(refused.ok, false, `${entry}: ${JSON.stringify(refused.output)}`);
    assert.equal(planned, false, `${entry}: refused before any command is planned`);
    assert.match(refused.error ?? '', /shell\.run refused: writablePaths names .*inside the Stratus home/, entry);
  }
  for (const entry of ['~/.stratus/integrations/ava/home', '~/.stratus/integrations/ava/home/.config', '~/.stratus/agents/ava/workspace/build']) {
    const { seen } = await policyOf({ writablePaths: [entry] }, fixture);
    assert.ok(seen, `${entry}: planned`);
    assert.equal(seen!.grantedWritable!.length, 1, entry);
  }
});

test('a writablePaths entry inside the agent\'s own home or workspace that links elsewhere in the Stratus home is refused (Codex P1 4335097416)', async () => {
  // The written spelling is allowlisted, but the real one is what the
  // sandbox grants, so a link out of the agent's own subtree would open
  // sessions or daemon state. Every placement must stay inside it.
  const fixture = await fixtureHome();
  const stratus = fixture.stratusHome;
  await mkdir(path.join(stratus, 'sessions'), { recursive: true });
  await mkdir(path.join(stratus, 'integrations', 'ava', 'home'), { recursive: true });
  await mkdir(fixture.workspaces.forAgent('ava'), { recursive: true });
  await symlink(path.join(stratus, 'sessions'), path.join(stratus, 'integrations', 'ava', 'home', 'cache'));
  await symlink(path.join(stratus, 'sessions'), path.join(fixture.workspaces.forAgent('ava'), 'out'));
  for (const entry of ['~/.stratus/integrations/ava/home/cache', '~/.stratus/integrations/ava/home/cache/new', '~/.stratus/agents/ava/workspace/out']) {
    const refused = await run({ writablePaths: [entry] }, fixture, 'true', { planSandbox: (policy) => unavailable(policy, '', []), warn: () => {} });
    assert.equal(refused.ok, false, `${entry}: ${JSON.stringify(refused.output)}`);
    assert.match(refused.error ?? '', /shell\.run refused: writablePaths names .*inside the Stratus home/, entry);
  }
});

test('an in-home writablePaths entry that links outside the Stratus home is refused too (Codex P1 4337364107)', async () => {
  // The previous check held only placements inside the home to the owned
  // subtree, so a link to ~/.ssh passed and its real path was re-granted
  // after the credential denial. An in-home entry must stay owned whole.
  const fixture = await fixtureHome();
  const agentHome = path.join(fixture.stratusHome, 'integrations', 'ava', 'home');
  await mkdir(agentHome, { recursive: true });
  await symlink(path.join(fixture.userHome, '.ssh'), path.join(agentHome, 'cache'));
  for (const entry of ['~/.stratus/integrations/ava/home/cache', '~/.stratus/integrations/ava/home/cache/new']) {
    const refused = await run({ writablePaths: [entry] }, fixture, 'true', { planSandbox: (policy) => unavailable(policy, '', []), warn: () => {} });
    assert.equal(refused.ok, false, `${entry}: ${JSON.stringify(refused.output)}`);
    assert.match(refused.error ?? '', /shell\.run refused: writablePaths names .*inside the Stratus home/, entry);
  }
  // The home itself, a real directory, is still granted.
  const { seen } = await policyOf({ writablePaths: ['~/.stratus/integrations/ava/home'] }, fixture);
  assert.ok(seen, 'the own home still plans');
});

test('the own integration home is allowlisted for every valid agent id, not only slug-shaped ones (Codex P2 4335097425)', async () => {
  const fixture = await fixtureHome();
  for (const agentId of ['my agent', 'team,alpha', 'Agënt']) {
    await mkdir(path.join(fixture.stratusHome, 'integrations', agentId, 'home'), { recursive: true });
    const { seen, result } = await policyOf({ writablePaths: [`~/.stratus/integrations/${agentId}/home`] }, fixture, { agentId });
    assert.ok(seen, `${agentId}: ${JSON.stringify(result)}`);
    assert.deepEqual(seen!.grantedWritable, [path.join(fixture.userHome, '.stratus', 'integrations', agentId, 'home')]);
  }
});
