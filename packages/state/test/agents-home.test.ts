import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { LEDGER_FILENAME, protectedPathGuard } from '@stratusagent/plugins';

import {
  AGENTS_DIR_ENV,
  AGENTS_HOME_MARKER,
  agentStateDirPath,
  agentWorkspacePath,
  agentsDirPath,
  claimAgentsHome,
  claimSoulFile,
  createAgentWorkspaces,
  createHostProtectedPaths,
  grantSoulCredential,
  loadRosterSouls,
  planAgentsHome,
  resolveAgentsHome,
  surfaceAgentsHome,
  writeNewSoulFile,
} from '../src/index.ts';

// Canonical from the start: macOS hands out tmpdirs under `/var`, which is a
// link to `/private/var`, and the ledger records canonical paths.
const newHome = async (): Promise<string> => realpath(await mkdtemp(path.join(os.tmpdir(), 'stratus-agents-home-')));

const soulText = (id: string): string => `---\nid: ${id}\nname: ${id}\n---\nYou are ${id}.\n`;

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await lstat(filePath);
    return true;
  } catch {
    return false;
  }
};

/** Whether this volume folds case, which decides what an existing `~/agents` is. */
const foldsCase = async (directory: string): Promise<boolean> => {
  await writeFile(path.join(directory, 'case-probe'), '');
  return exists(path.join(directory, 'CASE-PROBE'));
};

test('a fresh home claims ~/Agents and marks it as Stratus\'s', async () => {
  const home = await newHome();
  const env = { homeDir: home, processEnv: {} };
  assert.equal(resolveAgentsHome(env), path.join(home, 'Agents'));
  assert.equal(await exists(path.join(home, 'Agents')), false, 'resolving creates nothing');

  assert.equal(claimAgentsHome(env), path.join(home, 'Agents'));
  assert.ok((await stat(path.join(home, 'Agents', AGENTS_HOME_MARKER))).isFile());
  // And nothing left over from the staged claim.
  assert.deepEqual((await readdir(home)).filter((name) => name.startsWith('.stratus-agents-')), []);
  assert.equal(claimAgentsHome(env), path.join(home, 'Agents'), 'a second claim finds the first');
});

test('an ~/Agents somebody else made is never used, and ~/Stratus is claimed instead', async () => {
  const home = await newHome();
  const env = { homeDir: home, processEnv: {} };
  await mkdir(path.join(home, 'Agents'));
  await writeFile(path.join(home, 'Agents', 'notes.md'), 'theirs');

  assert.equal(claimAgentsHome(env), path.join(home, 'Stratus'));
  assert.deepEqual(await readdir(path.join(home, 'Agents')), ['notes.md']);
  assert.ok((await stat(path.join(home, 'Stratus', AGENTS_HOME_MARKER))).isFile());
});

test('an existing lowercase ~/agents counts as ~/Agents on a volume that folds case', async (t) => {
  const home = await newHome();
  if (!(await foldsCase(home))) {
    t.skip('this volume is case-sensitive, so ~/agents and ~/Agents are different folders');
    return;
  }
  const env = { homeDir: home, processEnv: {} };
  await mkdir(path.join(home, 'agents'));
  assert.equal(claimAgentsHome(env), path.join(home, 'Stratus'));
});

test('with both names taken nothing is claimed, and STRATUS_AGENTS_DIR chooses one', async () => {
  const home = await newHome();
  await mkdir(path.join(home, 'Agents'));
  await writeFile(path.join(home, 'Stratus'), 'a file, not a folder');
  assert.equal(claimAgentsHome({ homeDir: home, processEnv: {} }), undefined);

  const chosen = { homeDir: home, processEnv: { [AGENTS_DIR_ENV]: '~/Work/agents' } };
  assert.equal(claimAgentsHome(chosen), path.join(home, 'Work', 'agents'));
  assert.ok((await stat(path.join(home, 'Work', 'agents', AGENTS_HOME_MARKER))).isFile());

  const off = { homeDir: await newHome(), processEnv: { [AGENTS_DIR_ENV]: 'off' } };
  assert.equal(claimAgentsHome(off), undefined, 'off turns the folder off even where ~/Agents is free');
  assert.ok((await lstat(createAgentWorkspaces(off).prepare('ava'))).isDirectory());

  const inside = { homeDir: home, processEnv: { [AGENTS_DIR_ENV]: path.join(home, '.stratus', 'mine') } };
  assert.throws(() => resolveAgentsHome(inside), /inside .*\.stratus/);
});

test('a new agent\'s workspace is made in its visible folder and linked from the hidden path', async () => {
  const home = await newHome();
  const env = { homeDir: home, processEnv: {} };
  const workspace = createAgentWorkspaces(env).prepare('ava');

  assert.equal(workspace, agentWorkspacePath(env, 'ava'));
  assert.ok((await lstat(workspace)).isSymbolicLink());
  assert.equal(await readlink(workspace), path.join(home, 'Agents', 'ava', 'workspace'));
  assert.ok((await stat(path.join(home, 'Agents', 'ava', 'workspace'))).isDirectory());
  // The state stays hidden: only the workspace is in the visible folder.
  assert.deepEqual(await readdir(path.join(home, 'Agents', 'ava')), ['workspace']);
  assert.equal((await stat(agentStateDirPath(env, 'ava'))).mode & 0o777, 0o700);
});

test('a workspace folder somebody deleted comes back empty on the next write, rather than a dangling link', async () => {
  const home = await newHome();
  const env = { homeDir: home, processEnv: {} };
  const workspaces = createAgentWorkspaces(env);
  workspaces.prepare('ava');
  const visible = path.join(home, 'Agents', 'ava', 'workspace');
  await import('node:fs/promises').then((fs) => fs.rm(path.join(home, 'Agents', 'ava'), { recursive: true }));

  assert.deepEqual((await planAgentsHome(env)).dangling, [`${agentWorkspacePath(env, 'ava')} -> ${visible}`]);
  workspaces.prepare('ava');
  assert.ok((await stat(visible)).isDirectory());
  assert.deepEqual((await planAgentsHome(env)).dangling, []);
});

test('a workspace an operator linked somewhere else is left exactly where they put it', async () => {
  const home = await newHome();
  const env = { homeDir: home, processEnv: {} };
  const elsewhere = path.join(home, 'big-disk', 'ava');
  await mkdir(elsewhere, { recursive: true });
  await mkdir(agentStateDirPath(env, 'ava'), { recursive: true });
  await symlink(elsewhere, agentWorkspacePath(env, 'ava'));

  createAgentWorkspaces(env).prepare('ava');
  await surfaceAgentsHome(env);

  assert.equal(await readlink(agentWorkspacePath(env, 'ava')), elsewhere);
  assert.equal(await exists(path.join(home, 'Agents', 'ava')), false);
});

test('stratus agent new writes the soul into the agent\'s folder, and the roster reads it through the link', async () => {
  const home = await newHome();
  const env = { homeDir: home, processEnv: {} };
  const { agent, soulPath } = await claimSoulFile(env, { name: 'Ava', instructions: 'Be useful.' }, (a) => soulText(a.id), () => {});

  assert.equal(soulPath, path.join(agentsDirPath(env), `${agent.id}.md`));
  assert.equal(await readlink(soulPath), path.join(home, 'Agents', agent.id, 'soul.md'));
  assert.equal(await readFile(path.join(home, 'Agents', agent.id, 'soul.md'), 'utf8'), soulText(agent.id));
  const roster = await loadRosterSouls(env);
  assert.deepEqual(roster.map((entry) => entry.soul.agent.id), [agent.id]);

  // A soul edited where a person sees it is the soul the roster serves.
  await writeFile(path.join(home, 'Agents', agent.id, 'soul.md'), soulText(agent.id).replace('You are', 'You remain'));
  assert.match((await loadRosterSouls(env))[0]?.soul.agent.instructions ?? '', /You remain/);
});

test('a soul file already in the agent\'s folder is a taken name, not one to overwrite', async () => {
  const home = await newHome();
  const env = { homeDir: home, processEnv: {} };
  claimAgentsHome(env);
  await mkdir(path.join(home, 'Agents', 'ava'), { recursive: true });
  await writeFile(path.join(home, 'Agents', 'ava', 'soul.md'), 'kept');

  await assert.rejects(() => writeNewSoulFile(env, 'ava.md', 'ava', soulText('ava')), { code: 'EEXIST' });
  assert.equal(await readFile(path.join(home, 'Agents', 'ava', 'soul.md'), 'utf8'), 'kept');
  assert.equal(await exists(path.join(agentsDirPath(env), 'ava.md')), false);

  // `template add --force` is the one caller that replaces it.
  await writeNewSoulFile(env, 'ava.md', 'ava', soulText('ava'), { replace: true });
  assert.equal(await readFile(path.join(agentsDirPath(env), 'ava.md'), 'utf8'), soulText('ava'));
});

test('a credential grant rewrites the visible soul and keeps the link', async () => {
  const home = await newHome();
  const env = { homeDir: home, processEnv: {} };
  const soulPath = await writeNewSoulFile(env, 'ava.md', 'ava', soulText('ava'));

  assert.equal(await grantSoulCredential(soulPath, 'github.token', 'ava'), true);
  assert.ok((await lstat(soulPath)).isSymbolicLink());
  assert.match(await readFile(path.join(home, 'Agents', 'ava', 'soul.md'), 'utf8'), /github\.token/);
});

test('an agent cannot write its visible soul even with the agents folder as a root', async () => {
  const home = await newHome();
  const env = { homeDir: home, processEnv: {} };
  await writeNewSoulFile(env, 'ava.md', 'ava', soulText('ava'));
  createAgentWorkspaces(env).prepare('ava');

  const guard = await protectedPathGuard(createHostProtectedPaths(env));
  const visibleSoul = path.join(home, 'Agents', 'ava', 'soul.md');
  assert.notEqual(await guard(visibleSoul), undefined, 'the soul is protected under its visible name');
  assert.equal(await guard(path.join(home, 'Agents', 'ava', 'workspace', 'report.md')), undefined, 'the workspace is not');
});

test('serve moves an existing soul and workspace into the agents folder and re-records the ledger there', async () => {
  const home = await newHome();
  const env = { homeDir: home, processEnv: {} };
  const hiddenSoul = path.join(agentsDirPath(env), 'ava.md');
  const hiddenWorkspace = agentWorkspacePath(env, 'ava');
  await mkdir(path.join(hiddenWorkspace, 'mcp'), { recursive: true });
  await writeFile(hiddenSoul, soulText('ava'));
  await writeFile(path.join(hiddenWorkspace, 'mcp', 'chart.png'), 'bytes');
  await writeFile(
    path.join(hiddenWorkspace, LEDGER_FILENAME),
    `${JSON.stringify({ path: path.join(hiddenWorkspace, 'mcp', 'chart.png'), trust: 'external' })}\n`,
  );

  const report = await surfaceAgentsHome(env);
  assert.match(report ?? '', /moved 1 soul\(s\) and 1 workspace\(s\)/);

  const visible = path.join(home, 'Agents', 'ava');
  assert.equal(await readlink(hiddenSoul), path.join(visible, 'soul.md'));
  assert.equal(await readlink(hiddenWorkspace), path.join(visible, 'workspace'));
  assert.equal(await readFile(path.join(visible, 'workspace', 'mcp', 'chart.png'), 'utf8'), 'bytes');
  const recorded = (await readFile(path.join(visible, 'workspace', LEDGER_FILENAME), 'utf8'))
    .split('\n').filter(Boolean).map((line) => (JSON.parse(line) as { path: string }).path);
  assert.ok(recorded.includes(path.join(visible, 'workspace', 'mcp', 'chart.png')), 'the label follows the file');
  assert.equal(await exists(path.join(agentStateDirPath(env, 'ava'), '.workspace-surfacing')), false);

  assert.equal(await surfaceAgentsHome(env), undefined, 'a second pass has nothing to do');
  assert.deepEqual((await loadRosterSouls(env)).map((entry) => entry.soul.agent.id), ['ava']);
});

test('a workspace move interrupted after the rename is finished by the next pass', async () => {
  const home = await newHome();
  const env = { homeDir: home, processEnv: {} };
  const hiddenWorkspace = agentWorkspacePath(env, 'ava');
  const visibleWorkspace = path.join(home, 'Agents', 'ava', 'workspace');
  claimAgentsHome(env);
  await mkdir(visibleWorkspace, { recursive: true });
  await mkdir(agentStateDirPath(env, 'ava'), { recursive: true });
  await writeFile(
    path.join(visibleWorkspace, LEDGER_FILENAME),
    `${JSON.stringify({ path: path.join(hiddenWorkspace, 'page.md'), trust: 'external' })}\n`,
  );
  await writeFile(path.join(visibleWorkspace, 'page.md'), 'fetched');
  // The state a crash between the rename and the link leaves behind.
  await writeFile(
    path.join(agentStateDirPath(env, 'ava'), '.workspace-surfacing'),
    JSON.stringify({ from: [hiddenWorkspace], to: visibleWorkspace }),
  );

  await surfaceAgentsHome(env);

  assert.equal(await readlink(hiddenWorkspace), visibleWorkspace);
  assert.match(await readFile(path.join(visibleWorkspace, LEDGER_FILENAME), 'utf8'), new RegExp(JSON.stringify(path.join(visibleWorkspace, 'page.md')).slice(1, -1)));
  assert.equal(await exists(path.join(agentStateDirPath(env, 'ava'), '.workspace-surfacing')), false);
});

test('a soul move interrupted after the hard link is finished, not reported as a conflict', async () => {
  const home = await newHome();
  const env = { homeDir: home, processEnv: {} };
  const hiddenSoul = path.join(agentsDirPath(env), 'ava.md');
  await mkdir(agentsDirPath(env), { recursive: true });
  await writeFile(hiddenSoul, soulText('ava'));
  claimAgentsHome(env);
  await mkdir(path.join(home, 'Agents', 'ava'));
  await import('node:fs/promises').then((fs) => fs.link(hiddenSoul, path.join(home, 'Agents', 'ava', 'soul.md')));

  const report = await surfaceAgentsHome(env);
  assert.match(report ?? '', /moved 1 soul/);
  assert.ok((await lstat(hiddenSoul)).isSymbolicLink());
});

test('an agent folder that already holds a different soul or workspace is left alone and named', async () => {
  const home = await newHome();
  const env = { homeDir: home, processEnv: {} };
  const hiddenSoul = path.join(agentsDirPath(env), 'ava.md');
  await mkdir(agentWorkspacePath(env, 'ava'), { recursive: true });
  await writeFile(hiddenSoul, soulText('ava'));
  claimAgentsHome(env);
  await mkdir(path.join(home, 'Agents', 'ava', 'workspace'), { recursive: true });
  await writeFile(path.join(home, 'Agents', 'ava', 'soul.md'), 'somebody else\'s');

  const report = await surfaceAgentsHome(env);
  assert.match(report ?? '', /left in place: ava\.md .*; ava's workspace/);
  assert.ok((await lstat(hiddenSoul)).isFile());
  assert.ok((await lstat(agentWorkspacePath(env, 'ava'))).isDirectory());
  assert.equal(await readFile(path.join(home, 'Agents', 'ava', 'soul.md'), 'utf8'), 'somebody else\'s');
});

test('with no agents folder available, souls and workspaces stay hidden and nothing is moved', async () => {
  const home = await newHome();
  const env = { homeDir: home, processEnv: {} };
  await mkdir(path.join(home, 'Agents'));
  await mkdir(path.join(home, 'Stratus'));
  const hiddenSoul = path.join(agentsDirPath(env), 'ava.md');
  await mkdir(agentsDirPath(env), { recursive: true });
  await writeFile(hiddenSoul, soulText('ava'));

  assert.equal(await surfaceAgentsHome(env), undefined);
  assert.ok((await lstat(hiddenSoul)).isFile());
  const workspace = createAgentWorkspaces(env).prepare('bea');
  assert.ok((await lstat(workspace)).isDirectory(), 'a new workspace is a real hidden directory, as before');
  assert.equal((await claimSoulFile(env, { instructions: 'x' }, (a) => soulText(a.id), () => {})).soulPath.endsWith('.md'), true);
});

test('one agent whose move cannot finish is reported, and the others still move', async () => {
  const home = await newHome();
  const env = { homeDir: home, processEnv: {} };
  claimAgentsHome(env);
  for (const id of ['ava', 'bea']) {
    await mkdir(agentWorkspacePath(env, id), { recursive: true });
  }
  // Ava's workspace already moved, and a real hidden directory is back while
  // the marker is still there: the case `finishWorkspace` refuses rather than
  // guesses.
  await mkdir(path.join(home, 'Agents', 'ava', 'workspace'), { recursive: true });
  await writeFile(
    path.join(agentStateDirPath(env, 'ava'), '.workspace-surfacing'),
    JSON.stringify({ from: [agentWorkspacePath(env, 'ava')], to: path.join(home, 'Agents', 'ava', 'workspace') }),
  );

  const report = await surfaceAgentsHome(env);
  assert.match(report ?? '', /moved 0 soul\(s\) and 1 workspace\(s\)/);
  assert.match(report ?? '', /ava's workspace \(.*was recreated while its workspace was moving/);
  assert.ok((await lstat(agentWorkspacePath(env, 'bea'))).isSymbolicLink());
});

test('template add --force leaves the visible soul alone when the hidden name is taken meanwhile', async () => {
  const home = await newHome();
  const env = { homeDir: home, processEnv: {} };
  claimAgentsHome(env);
  await mkdir(path.join(home, 'Agents', 'ava'), { recursive: true });
  await writeFile(path.join(home, 'Agents', 'ava', 'soul.md'), 'kept');
  // Another process recreated the roster entry after the caller unlinked it.
  await mkdir(agentsDirPath(env), { recursive: true });
  await writeFile(path.join(agentsDirPath(env), 'ava.md'), 'theirs');

  await assert.rejects(
    () => writeNewSoulFile(env, 'ava.md', 'ava', soulText('ava'), { replace: true }),
    { code: 'EEXIST' },
  );
  assert.equal(await readFile(path.join(home, 'Agents', 'ava', 'soul.md'), 'utf8'), 'kept');
  assert.equal(await readFile(path.join(agentsDirPath(env), 'ava.md'), 'utf8'), 'theirs');
  assert.deepEqual((await readdir(path.join(home, 'Agents', 'ava'))).filter((name) => name.endsWith('.tmp')), []);
});

test('where symlinks cannot be made (Windows without Developer Mode), souls and workspaces stay hidden', async (t) => {
  const home = await newHome();
  const env = { homeDir: home, processEnv: {} };
  const denied = (): never => {
    throw Object.assign(new Error('EPERM: operation not permitted, symlink'), { code: 'EPERM' });
  };
  t.mock.method(fs, 'symlinkSync', denied);
  t.mock.method(fs.promises, 'symlink', async () => denied());
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  assert.equal(claimAgentsHome(env), undefined);
  const soulPath = await writeNewSoulFile(env, 'ava.md', 'ava', soulText('ava'));
  assert.equal(soulPath, path.join(agentsDirPath(env), 'ava.md'));
  assert.ok((await lstat(soulPath)).isFile());
  assert.equal(await exists(path.join(home, 'Agents')), false, 'no visible folder is claimed that nothing links into');
  await surfaceAgentsHome(env);
  assert.ok((await lstat(soulPath)).isFile(), 'the existing soul is not moved either');
  assert.equal(await exists(path.join(home, 'Agents')), false);
});

test('a workspace move interrupted before the rename starts over instead of refusing forever', async () => {
  const home = await newHome();
  const env = { homeDir: home, processEnv: {} };
  const hiddenWorkspace = agentWorkspacePath(env, 'ava');
  const visibleWorkspace = path.join(home, 'Agents', 'ava', 'workspace');
  claimAgentsHome(env);
  await mkdir(hiddenWorkspace, { recursive: true });
  await writeFile(path.join(hiddenWorkspace, 'notes.md'), 'kept');
  // The state a crash between writing the marker and the rename leaves behind.
  await mkdir(path.dirname(visibleWorkspace), { recursive: true });
  await writeFile(
    path.join(agentStateDirPath(env, 'ava'), '.workspace-surfacing'),
    JSON.stringify({ from: [hiddenWorkspace], to: visibleWorkspace }),
  );

  const report = await surfaceAgentsHome(env);
  assert.match(report ?? '', /moved 0 soul\(s\) and 1 workspace\(s\)/);
  assert.doesNotMatch(report ?? '', /left in place/);
  assert.equal(await readlink(hiddenWorkspace), visibleWorkspace);
  assert.equal(await readFile(path.join(visibleWorkspace, 'notes.md'), 'utf8'), 'kept');
  assert.equal(await exists(path.join(agentStateDirPath(env, 'ava'), '.workspace-surfacing')), false);
  assert.equal(await surfaceAgentsHome(env), undefined, 'a second pass has nothing to do');
});

test('a soul move interrupted after a copy (no hard links) is finished, not reported as a conflict', async () => {
  const home = await newHome();
  const env = { homeDir: home, processEnv: {} };
  const hiddenSoul = path.join(agentsDirPath(env), 'ava.md');
  await mkdir(agentsDirPath(env), { recursive: true });
  await writeFile(hiddenSoul, soulText('ava'));
  claimAgentsHome(env);
  // The state a crash between the copy fallback and the link leaves behind:
  // the same bytes at both names, under different inodes.
  await mkdir(path.join(home, 'Agents', 'ava'));
  await writeFile(path.join(home, 'Agents', 'ava', 'soul.md'), soulText('ava'));

  const report = await surfaceAgentsHome(env);
  assert.match(report ?? '', /moved 1 soul/);
  assert.doesNotMatch(report ?? '', /left in place/);
  assert.equal(await readlink(hiddenSoul), path.join(home, 'Agents', 'ava', 'soul.md'));
});

test('the plan names the folder only where it can be used, and creates nothing', async (t) => {
  const home = await newHome();
  const env = { homeDir: home, processEnv: {} };
  await mkdir(agentsDirPath(env), { recursive: true });
  const denied = (): never => {
    throw Object.assign(new Error('EPERM: operation not permitted, symlink'), { code: 'EPERM' });
  };
  t.mock.method(fs, 'symlinkSync', denied);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  const plan = await planAgentsHome(env);
  assert.equal(plan.agentsHome, undefined, 'no folder is reported that claiming would refuse');
  assert.match(plan.reason ?? '', /symlinks/);
  assert.equal(await exists(path.join(home, 'Agents')), false);
  assert.deepEqual((await readdir(agentsDirPath(env))).filter((name) => name.startsWith('.link-probe-')), []);
});

test('the plan lists what the next pass would move, and is empty after it', async () => {
  const home = await newHome();
  const env = { homeDir: home, processEnv: {} };
  await mkdir(agentWorkspacePath(env, 'ava'), { recursive: true });
  await writeFile(path.join(agentsDirPath(env), 'ava.md'), soulText('ava'));

  const before = await planAgentsHome(env);
  assert.equal(before.agentsHome, path.join(home, 'Agents'));
  assert.equal(before.claimed, false);
  assert.deepEqual(before.souls, ['ava.md']);
  assert.deepEqual(before.workspaces, ['ava']);
  assert.equal(await exists(path.join(home, 'Agents')), false, 'planning creates nothing');

  await surfaceAgentsHome(env);
  const after = await planAgentsHome(env);
  assert.equal(after.claimed, true);
  assert.deepEqual(after.souls, []);
  assert.deepEqual(after.workspaces, []);
  assert.deepEqual(after.unlinked, []);
});

test('agent new interrupted after writing the visible soul finishes on retry instead of leaving an orphan', async () => {
  const home = await newHome();
  const env = { homeDir: home, processEnv: {} };
  await mkdir(agentsDirPath(env), { recursive: true });
  claimAgentsHome(env);
  // The state a crash between the visible write and the hidden link leaves.
  const visible = path.join(home, 'Agents', 'ava', 'soul.md');
  await mkdir(path.dirname(visible), { recursive: true });
  await writeFile(visible, soulText('ava'));
  assert.deepEqual((await planAgentsHome(env)).unlinked, [visible], 'doctor can name it');

  const soulPath = await writeNewSoulFile(env, 'ava.md', 'ava', soulText('ava'));
  assert.equal(await readlink(soulPath), visible);
  assert.deepEqual((await planAgentsHome(env)).unlinked, []);
});

test('a different soul already in an unlinked agent folder is still a taken name', async () => {
  const home = await newHome();
  const env = { homeDir: home, processEnv: {} };
  await mkdir(agentsDirPath(env), { recursive: true });
  claimAgentsHome(env);
  const visible = path.join(home, 'Agents', 'ava', 'soul.md');
  await mkdir(path.dirname(visible), { recursive: true });
  await writeFile(visible, 'somebody wrote this');

  await assert.rejects(() => writeNewSoulFile(env, 'ava.md', 'ava', soulText('ava')), { code: 'EEXIST' });
  assert.equal(await readFile(visible, 'utf8'), 'somebody wrote this');
  assert.equal(await exists(path.join(agentsDirPath(env), 'ava.md')), false);
});

test('a workspace link whose whole agents folder was deleted gets the folder back as ours, marker included', async () => {
  const home = await newHome();
  const env = { homeDir: home, processEnv: {} };
  createAgentWorkspaces(env).prepare('ava');
  await fs.promises.rm(path.join(home, 'Agents'), { recursive: true, force: true });

  createAgentWorkspaces(env).prepare('ava');
  assert.ok((await stat(path.join(home, 'Agents', AGENTS_HOME_MARKER))).isFile(), 'the recreated folder is still marked as Stratus\'s');
  assert.ok((await stat(path.join(home, 'Agents', 'ava', 'workspace'))).isDirectory());
  assert.equal(resolveAgentsHome(env), path.join(home, 'Agents'), 'new agents keep going to the same folder, not ~/Stratus');
});

test('agent new that loses a race to an identical request leaves the winner\'s soul in place', async (t) => {
  const home = await newHome();
  const env = { homeDir: home, processEnv: {} };
  await mkdir(agentsDirPath(env), { recursive: true });
  claimAgentsHome(env);
  const visible = path.join(home, 'Agents', 'ava', 'soul.md');
  const hidden = path.join(agentsDirPath(env), 'ava.md');
  const realSymlink = fs.promises.symlink;
  // A second identical request adopts this write's soul and links it first.
  t.mock.method(fs.promises, 'symlink', async (target: string, linkPath: string, kind?: string) => {
    if (linkPath === hidden) {
      await realSymlink(visible, hidden, 'file');
      throw Object.assign(new Error(`EEXIST: file already exists, symlink '${linkPath}'`), { code: 'EEXIST' });
    }
    return realSymlink(target, linkPath, kind as 'file');
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  await assert.rejects(() => writeNewSoulFile(env, 'ava.md', 'ava', soulText('ava')), { code: 'EEXIST' });
  assert.equal(await readFile(visible, 'utf8'), soulText('ava'), 'the soul the winner linked is still there');
  assert.equal(await readFile(hidden, 'utf8'), soulText('ava'), 'and the roster still reads it');
});

test('a soul copied across volumes never overwrites one written into the agent folder meanwhile', async (t) => {
  const home = await newHome();
  const env = { homeDir: home, processEnv: {} };
  const hiddenSoul = path.join(agentsDirPath(env), 'ava.md');
  const visible = path.join(home, 'Agents', 'ava', 'soul.md');
  await mkdir(agentsDirPath(env), { recursive: true });
  await writeFile(hiddenSoul, soulText('ava'));
  claimAgentsHome(env);
  t.mock.method(fs.promises, 'link', async () => {
    throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
  });
  const realCopy = fs.promises.copyFile;
  // template add --force installs a new soul while the copy is staged.
  t.mock.method(fs.promises, 'copyFile', async (from: string, to: string, mode?: number) => {
    await realCopy(from, to, mode);
    await writeFile(visible, 'replacement');
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  const report = await surfaceAgentsHome(env);
  assert.match(report ?? '', /left in place/);
  assert.equal(await readFile(visible, 'utf8'), 'replacement');
  assert.equal(await readFile(hiddenSoul, 'utf8'), soulText('ava'), 'the hidden soul is not swapped for a link');
  assert.ok((await lstat(hiddenSoul)).isFile());
  assert.deepEqual((await readdir(path.dirname(visible))).filter((name) => name.endsWith('.copy')), []);
});

test('an ~/Agents that cannot be read moves nothing and does not stop the start', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    t.skip('mode 000 does not deny access here');
    return;
  }
  const home = await newHome();
  const env = { homeDir: home, processEnv: {} };
  const locked = path.join(home, 'Agents');
  await mkdir(locked);
  await writeFile(path.join(locked, AGENTS_HOME_MARKER), '');
  const hiddenSoul = path.join(agentsDirPath(env), 'ava.md');
  await mkdir(agentsDirPath(env), { recursive: true });
  await writeFile(hiddenSoul, soulText('ava'));
  await fs.promises.chmod(locked, 0o000);
  t.after(() => fs.promises.chmod(locked, 0o755));

  // Ours or somebody else's cannot be told from here, so neither name is
  // used: ~/Stratus would split the agents across two folders if it was ours.
  assert.equal(resolveAgentsHome(env), undefined);
  assert.equal(await surfaceAgentsHome(env), undefined);
  assert.match((await planAgentsHome(env)).reason ?? '', /cannot be read/);
  assert.ok((await lstat(hiddenSoul)).isFile(), 'the soul stays where it was');
  assert.equal(await exists(path.join(home, 'Stratus')), false);
});

test('a move the pass will always leave in place is blocked in the plan, not pending', async () => {
  const home = await newHome();
  const env = { homeDir: home, processEnv: {} };
  await mkdir(agentWorkspacePath(env, 'ava'), { recursive: true });
  await writeFile(path.join(agentsDirPath(env), 'ava.md'), soulText('ava'));
  // Something else is already at both visible names.
  await mkdir(path.join(home, 'Agents', 'ava', 'workspace'), { recursive: true });
  await writeFile(path.join(home, 'Agents', AGENTS_HOME_MARKER), '');
  await writeFile(path.join(home, 'Agents', 'ava', 'soul.md'), soulText('ava') + 'Edited elsewhere.\n');

  await surfaceAgentsHome(env);
  const plan = await planAgentsHome(env);
  assert.deepEqual(plan.souls, [], 'nothing pending: an update would skip it again');
  assert.deepEqual(plan.workspaces, []);
  assert.equal(plan.blocked.length, 2);
  assert.match(plan.blocked.join('\n'), /ava\.md .*already exists/);
  assert.match(plan.blocked.join('\n'), /ava's workspace .*already exists/);
});

test('STRATUS_AGENTS_DIR is refused when a link leads it into the Stratus home', async () => {
  const home = await newHome();
  await mkdir(agentsDirPath({ homeDir: home, processEnv: {} }), { recursive: true });
  const alias = path.join(home, 'alias');
  await symlink(path.join(home, '.stratus', 'agents'), alias);
  for (const named of [alias, path.join(alias, 'mine')]) {
    const env = { homeDir: home, processEnv: { [AGENTS_DIR_ENV]: named } };
    assert.throws(() => resolveAgentsHome(env), /inside .*\.stratus/, named);
  }
});

test('an ~/Agents that is ours is used even when ~/Stratus cannot be read', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    t.skip('mode 000 does not deny access here');
    return;
  }
  const home = await newHome();
  const env = { homeDir: home, processEnv: {} };
  assert.equal(claimAgentsHome(env), path.join(home, 'Agents'));
  const other = path.join(home, 'Stratus');
  await mkdir(other);
  await fs.promises.chmod(other, 0o000);
  t.after(() => fs.promises.chmod(other, 0o755));
  assert.equal(resolveAgentsHome(env), path.join(home, 'Agents'));
});

test('one agent whose state cannot be inspected is named, and the others still plan and move', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    t.skip('mode 000 does not deny access here');
    return;
  }
  const home = await newHome();
  const env = { homeDir: home, processEnv: {} };
  await mkdir(agentWorkspacePath(env, 'ava'), { recursive: true });
  await writeFile(path.join(agentsDirPath(env), 'ava.md'), soulText('ava'));
  const locked = agentStateDirPath(env, 'bea');
  await mkdir(path.join(locked, 'workspace'), { recursive: true });
  await fs.promises.chmod(locked, 0o000);
  t.after(() => fs.promises.chmod(locked, 0o755));

  const plan = await planAgentsHome(env);
  assert.deepEqual(plan.souls, ['ava.md']);
  assert.deepEqual(plan.workspaces, ['ava']);
  assert.match(plan.blocked.join('\n'), /bea \(could not be inspected: EACCES\)/);
  const report = await surfaceAgentsHome(env);
  assert.match(report ?? '', /moved 1 soul\(s\) and 1 workspace\(s\)/);
  assert.match(report ?? '', /left in place: bea/);
});
