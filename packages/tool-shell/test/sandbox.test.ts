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
  extra: { planSandbox?: typeof planSandbox; warn?: (message: string) => void; processEnv?: NodeJS.ProcessEnv } = {},
) => {
  const tool = createShellTool(config, {
    workspaces: fixture.workspaces,
    protectedPaths: fixture.protectedPaths,
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
  // Codex P1 4309344603: the visible spellings of what the home links to.
  ["another agent's workspace by its visible path", (f) => `cat ${path.join(f.visible, 'carl', 'workspace', 'notes.md')}`],
  ["another agent's soul by its visible path", (f) => `cat ${path.join(f.visible, 'carl', 'soul.md')}`],
  // Codex P1 4309587628.
  ['a token inside the writable cache', (f) => `cat ${path.join(f.userHome, '.cache', 'huggingface', 'token')}`],
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
  assert.equal(first.ok, true, JSON.stringify(first));
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

test('sandbox "auto" with no workspace to confine to says so before running unconfined', async () => {
  // Codex P1 4309587622.
  resetSandboxWarning();
  const warnings: string[] = [];
  const tool = createShellTool({}, { home: os.tmpdir(), processEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, warn: (line) => warnings.push(line) });
  const result = await createLocalCommandExecutor().execute({ id: 'c', toolName: 'shell.run', input: { command: 'true' } }, tool, session('ava'));
  assert.equal(result.ok, true, JSON.stringify(result.output));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /without a sandbox because this agent has no workspace/);
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
