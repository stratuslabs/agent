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
  AGENTS_FOLDER_RECORD,
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
  loadSoulFile,
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

test('checking whether links can be made leaves no probe link behind', async () => {
  // The probe is a dangling symlink. Node 24.0.0's rmSync returns without
  // removing one (no error, even without force), so a probe removed that way
  // stayed in the hidden agents directory after every start.
  const home = await newHome();
  const env = { homeDir: home, processEnv: {} };
  await mkdir(agentsDirPath(env), { recursive: true });

  assert.equal((await planAgentsHome(env)).agentsHome, path.join(home, 'Agents'));
  assert.equal(claimAgentsHome(env), path.join(home, 'Agents'));

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

test('a configured agents folder whose parents do not exist yet is on the home\'s filesystem, not another volume', async () => {
  const home = await newHome();
  const env = { homeDir: home, processEnv: { [AGENTS_DIR_ENV]: path.join(home, 'deep', 'er', 'Agents') } };
  await mkdir(agentWorkspacePath(env, 'ava'), { recursive: true });
  const plan = await planAgentsHome(env);
  assert.deepEqual(plan.workspaces, ['ava']);
  assert.deepEqual(plan.blocked, []);
});

test('a dangling hidden link at the new agent\'s name is taken, and the visible soul is never written', async () => {
  const home = await newHome();
  const env = { homeDir: home, processEnv: {} };
  const agentsHome = claimAgentsHome(env)!;
  await mkdir(agentsDirPath(env), { recursive: true });
  const visible = path.join(agentsHome, 'ava', 'soul.md');
  await symlink(visible, path.join(agentsDirPath(env), 'ava.md'));
  await assert.rejects(() => writeNewSoulFile(env, 'ava.md', 'ava', soulText('ava')), { code: 'EEXIST' });
  assert.equal(await exists(visible), false, 'the old link is not brought to life');
});

test('a cut-short workspace marker from before the rename is voided and the move goes ahead', async () => {
  const home = await newHome();
  const env = { homeDir: home, processEnv: {} };
  await mkdir(agentWorkspacePath(env, 'ava'), { recursive: true });
  await writeFile(path.join(agentWorkspacePath(env, 'ava'), 'note.txt'), 'kept');
  await writeFile(path.join(agentStateDirPath(env, 'ava'), '.workspace-surfacing'), '{"from":["/x');
  const report = await surfaceAgentsHome(env);
  assert.match(report ?? '', /moved 0 soul\(s\) and 1 workspace\(s\)/);
  assert.equal(await readFile(path.join(home, 'Agents', 'ava', 'workspace', 'note.txt'), 'utf8'), 'kept');
  assert.equal(await exists(path.join(agentStateDirPath(env, 'ava'), '.workspace-surfacing')), false);
});

/**
 * A home whose souls and workspaces were surfaced at one path, copied with
 * its links as they are (a restore, another user, another host path) to a
 * new one, and the original removed: the links in the copy still name the
 * old path.
 */
const copiedHome = async (agentIds: string[]): Promise<{ home: string; env: { homeDir: string; processEnv: Record<string, string> }; old: string }> => {
  const old = await newHome();
  const oldEnv = { homeDir: old, processEnv: {} };
  for (const id of agentIds) {
    await mkdir(agentWorkspacePath(oldEnv, id), { recursive: true });
    await writeFile(path.join(agentsDirPath(oldEnv), `${id}.md`), soulText(id));
    await writeFile(path.join(agentWorkspacePath(oldEnv, id), 'notes.md'), `${id}'s notes`);
  }
  assert.match((await surfaceAgentsHome(oldEnv)) ?? '', /moved/);
  const home = await newHome();
  await fs.promises.cp(path.join(old, '.stratus'), path.join(home, '.stratus'), { recursive: true, verbatimSymlinks: true });
  await fs.promises.cp(path.join(old, 'Agents'), path.join(home, 'Agents'), { recursive: true });
  await fs.promises.rm(old, { recursive: true, force: true });
  return { home, env: { homeDir: home, processEnv: {} }, old };
};

test('a home copied from another path re-points its soul and workspace links at this home\'s agents folder', async () => {
  const { home, env, old } = await copiedHome(['ava', 'bob']);
  const hiddenSoul = path.join(agentsDirPath(env), 'ava.md');
  const hiddenWorkspace = agentWorkspacePath(env, 'ava');
  assert.equal(await readlink(hiddenSoul), path.join(old, 'Agents', 'ava', 'soul.md'), 'the copy still names the old home');
  assert.deepEqual((await loadRosterSouls(env)).map((entry) => entry.soul.agent.id), [], 'before the repair every agent is lost');

  const plan = await planAgentsHome(env);
  // In the order the hidden folder lists them.
  assert.deepEqual(plan.relink.map((entry) => [entry.kind, entry.link, entry.to]), [
    ['workspace', hiddenWorkspace, path.join(home, 'Agents', 'ava', 'workspace')],
    ['soul', path.join(agentsDirPath(env), 'ava.md'), path.join(home, 'Agents', 'ava', 'soul.md')],
    ['workspace', agentWorkspacePath(env, 'bob'), path.join(home, 'Agents', 'bob', 'workspace')],
    ['soul', path.join(agentsDirPath(env), 'bob.md'), path.join(home, 'Agents', 'bob', 'soul.md')],
  ]);
  assert.deepEqual(plan.dangling, [], 'a link the pass will repair is pending, not broken');
  assert.deepEqual(plan.unlinked, [], 'a soul a link is about to be re-pointed at is not one nothing reads');
  assert.equal(plan.recorded, path.join(old, 'Agents'));

  const report = await surfaceAgentsHome(env);
  assert.match(report ?? '', new RegExp(`re-pointed 4 link\\(s\\) at ${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/Agents`));
  // Absolute, like every link this folder has.
  assert.equal(await readlink(hiddenSoul), path.join(home, 'Agents', 'ava', 'soul.md'));
  assert.equal(await readlink(hiddenWorkspace), path.join(home, 'Agents', 'ava', 'workspace'));
  assert.equal(await readFile(path.join(hiddenWorkspace, 'notes.md'), 'utf8'), 'ava\'s notes');
  assert.deepEqual((await loadRosterSouls(env)).map((entry) => entry.soul.agent.id).sort(), ['ava', 'bob']);
  assert.equal(await surfaceAgentsHome(env), undefined, 'a second pass has nothing to do');
  assert.deepEqual((await planAgentsHome(env)).relink, []);
  assert.equal(await readFile(path.join(agentsDirPath(env), AGENTS_FOLDER_RECORD), 'utf8'), `${path.join(home, 'Agents')}\n`, 'the record follows the links');
});

test('a copied home whose old agents folder had another name re-points into this home\'s ~/Agents', async () => {
  const old = await newHome();
  const oldFolder = path.join(old, 'Elsewhere');
  const oldEnv = { homeDir: old, processEnv: { [AGENTS_DIR_ENV]: oldFolder } };
  await mkdir(agentWorkspacePath(oldEnv, 'ava'), { recursive: true });
  await writeFile(path.join(agentsDirPath(oldEnv), 'ava.md'), soulText('ava'));
  assert.match((await surfaceAgentsHome(oldEnv)) ?? '', /moved/);
  const home = await newHome();
  await fs.promises.cp(path.join(old, '.stratus'), path.join(home, '.stratus'), { recursive: true, verbatimSymlinks: true });
  await fs.promises.cp(oldFolder, path.join(home, 'Agents'), { recursive: true });
  await fs.promises.rm(old, { recursive: true, force: true });
  const env = { homeDir: home, processEnv: {} };

  await surfaceAgentsHome(env);
  assert.equal(await readlink(path.join(agentsDirPath(env), 'ava.md')), path.join(home, 'Agents', 'ava', 'soul.md'));
  assert.equal(await readlink(agentWorkspacePath(env, 'ava')), path.join(home, 'Agents', 'ava', 'workspace'));
});

test('a link an operator pointed at storage that is offline is never re-pointed at the local copy', async () => {
  const { home, env } = await copiedHome(['ava']);
  await surfaceAgentsHome(env);
  // The operator copies Ava's folder to an external volume and points both
  // links there; the local copy stays behind. Then the volume goes away.
  const volume = await newHome();
  await fs.promises.cp(path.join(home, 'Agents', 'ava'), path.join(volume, 'Agents', 'ava'), { recursive: true });
  const hiddenSoul = path.join(agentsDirPath(env), 'ava.md');
  const hiddenWorkspace = agentWorkspacePath(env, 'ava');
  for (const [link, target] of [[hiddenSoul, path.join(volume, 'Agents', 'ava', 'soul.md')], [hiddenWorkspace, path.join(volume, 'Agents', 'ava', 'workspace')]] as const) {
    await fs.promises.unlink(link);
    await symlink(target, link);
  }
  await fs.promises.rm(volume, { recursive: true, force: true });

  const plan = await planAgentsHome(env);
  assert.deepEqual(plan.relink, [], 'nothing says these links were made for a home at that path');
  assert.equal(plan.dangling.length, 2);
  await surfaceAgentsHome(env);
  assert.equal(await readlink(hiddenSoul), path.join(volume, 'Agents', 'ava', 'soul.md'));
  assert.equal(await readlink(hiddenWorkspace), path.join(volume, 'Agents', 'ava', 'workspace'));
  assert.equal(await readFile(path.join(agentsDirPath(env), AGENTS_FOLDER_RECORD), 'utf8'), `${path.join(home, 'Agents')}\n`);
});

test('a copied home with no record re-points nothing, names the folder, and re-points once the operator records it', async () => {
  // Every home an earlier build surfaced: nothing in it says which folder its links were made for.
  const { home, env, old } = await copiedHome(['ava']);
  const record = path.join(agentsDirPath(env), AGENTS_FOLDER_RECORD);
  await fs.promises.rm(record);
  const hiddenSoul = path.join(agentsDirPath(env), 'ava.md');

  const plan = await planAgentsHome(env);
  assert.deepEqual(plan.relink, []);
  assert.equal(plan.recorded, undefined);
  assert.deepEqual(plan.elsewhere, [{ folder: path.join(old, 'Agents'), links: 2 }]);
  assert.equal(plan.dangling.length, 2);
  const report = await surfaceAgentsHome(env);
  assert.match(report ?? '', new RegExp(`2 link\\(s\\) point into ${path.join(old, 'Agents').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} at files that are gone`));
  assert.equal(await readlink(hiddenSoul), path.join(old, 'Agents', 'ava', 'soul.md'), 'left as it was');

  await writeFile(record, `${path.join(old, 'Agents')}\n`);
  assert.match((await surfaceAgentsHome(env)) ?? '', /re-pointed 2 link\(s\)/);
  assert.equal(await readlink(hiddenSoul), path.join(home, 'Agents', 'ava', 'soul.md'));
  assert.equal(await readFile(record, 'utf8'), `${path.join(home, 'Agents')}\n`);
});

test('a copied home that left its agents folder behind names the folder its links need, and re-points once it is copied and recorded', async () => {
  // Copied without ~/Agents, from a build with no record: nothing here has
  // the files yet, so nothing can be re-pointed, and copying the folder over
  // is not enough on its own.
  const { home, env, old } = await copiedHome(['ava']);
  const record = path.join(agentsDirPath(env), AGENTS_FOLDER_RECORD);
  await fs.promises.rm(record);
  const carried = await newHome();
  await fs.promises.cp(path.join(home, 'Agents'), path.join(carried, 'Agents'), { recursive: true });
  await fs.promises.rm(path.join(home, 'Agents'), { recursive: true });
  const hiddenSoul = path.join(agentsDirPath(env), 'ava.md');

  const plan = await planAgentsHome(env);
  assert.deepEqual(plan.relink, []);
  assert.deepEqual(plan.elsewhere, [{ folder: path.join(old, 'Agents'), links: 2 }]);
  assert.equal(plan.dangling.length, 2);

  // What doctor tells the operator: copy the folder in, record where it was, restart.
  await fs.promises.cp(path.join(carried, 'Agents'), path.join(home, 'Agents'), { recursive: true });
  const copiedOnly = await planAgentsHome(env);
  assert.deepEqual(copiedOnly.relink, [], 'copying alone re-points nothing without the record');
  assert.deepEqual(copiedOnly.elsewhere, [{ folder: path.join(old, 'Agents'), links: 2 }]);
  await writeFile(record, `${path.join(old, 'Agents')}\n`);
  assert.match((await surfaceAgentsHome(env)) ?? '', /re-pointed 2 link\(s\)/);
  assert.equal(await readlink(hiddenSoul), path.join(home, 'Agents', 'ava', 'soul.md'));
});

test('a copied home with its record, but not its agents folder, needs only the folder copied', async () => {
  const { home, env, old } = await copiedHome(['ava']);
  const carried = await newHome();
  await fs.promises.cp(path.join(home, 'Agents'), path.join(carried, 'Agents'), { recursive: true });
  await fs.promises.rm(path.join(home, 'Agents'), { recursive: true });

  const plan = await planAgentsHome(env);
  assert.equal(plan.recorded, path.join(old, 'Agents'));
  assert.deepEqual(plan.elsewhere, [{ folder: path.join(old, 'Agents'), links: 2 }]);
  await fs.promises.cp(path.join(carried, 'Agents'), path.join(home, 'Agents'), { recursive: true });
  assert.match((await surfaceAgentsHome(env)) ?? '', /re-pointed 2 link\(s\)/);
});

test('a link that could not be re-pointed keeps the old folder recorded, so the next start finishes it', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root writes through the mode');
    return;
  }
  const { home, env, old } = await copiedHome(['ava']);
  const stateDir = agentStateDirPath(env, 'ava');
  await fs.promises.chmod(stateDir, 0o500);
  t.after(() => fs.promises.chmod(stateDir, 0o700));
  const report = await surfaceAgentsHome(env);
  assert.match(report ?? '', /re-pointed 1 link\(s\)/);
  assert.match(report ?? '', /left in place: .*workspace/);
  const record = path.join(agentsDirPath(env), AGENTS_FOLDER_RECORD);
  assert.equal(await readFile(record, 'utf8'), `${path.join(old, 'Agents')}\n`);

  await fs.promises.chmod(stateDir, 0o700);
  assert.match((await surfaceAgentsHome(env)) ?? '', /re-pointed 1 link\(s\)/);
  assert.equal(await readlink(agentWorkspacePath(env, 'ava')), path.join(home, 'Agents', 'ava', 'workspace'));
  assert.equal(await readFile(record, 'utf8'), `${path.join(home, 'Agents')}\n`);
});

test('a broken link into some other folder does not hold the record back, so a second copy still re-points', async () => {
  const { home, env } = await copiedHome(['ava', 'bob']);
  // Bob's links name storage that is offline, not the folder the home was copied from.
  const volume = await newHome();
  for (const [link, target] of [
    [path.join(agentsDirPath(env), 'bob.md'), path.join(volume, 'Agents', 'bob', 'soul.md')],
    [agentWorkspacePath(env, 'bob'), path.join(volume, 'Agents', 'bob', 'workspace')],
  ] as const) {
    await fs.promises.unlink(link);
    await symlink(target, link);
  }
  await fs.promises.rm(volume, { recursive: true, force: true });

  assert.match((await surfaceAgentsHome(env)) ?? '', /re-pointed 2 link\(s\)/);
  const record = path.join(agentsDirPath(env), AGENTS_FOLDER_RECORD);
  assert.equal(await readFile(record, 'utf8'), `${path.join(home, 'Agents')}\n`, 'every link into the recorded folder was re-pointed');

  // The repaired home is copied again, and this one removed.
  const next = await newHome();
  await fs.promises.cp(path.join(home, '.stratus'), path.join(next, '.stratus'), { recursive: true, verbatimSymlinks: true });
  await fs.promises.cp(path.join(home, 'Agents'), path.join(next, 'Agents'), { recursive: true });
  await fs.promises.rm(home, { recursive: true, force: true });
  const nextEnv = { homeDir: next, processEnv: {} };
  assert.match((await surfaceAgentsHome(nextEnv)) ?? '', /re-pointed 2 link\(s\)/);
  assert.equal(await readlink(path.join(agentsDirPath(nextEnv), 'ava.md')), path.join(next, 'Agents', 'ava', 'soul.md'));
  assert.equal(await readlink(path.join(agentsDirPath(nextEnv), 'bob.md')), path.join(volume, 'Agents', 'bob', 'soul.md'), 'still the operator\'s');
});

test('a link into the recorded folder that cannot be inspected keeps the record, so the next start can still re-point it', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root searches through the mode');
    return;
  }
  // Copied to another user while the old home is still there, behind a
  // folder this user can't search: lstat fails with EACCES, not ENOENT.
  const { home, env, old } = await copiedHome(['ava']);
  await mkdir(old, { mode: 0o000 });
  t.after(() => fs.promises.chmod(old, 0o700).catch(() => undefined));
  const plan = await planAgentsHome(env);
  assert.deepEqual(plan.relink, [], 'it may still be there');
  await surfaceAgentsHome(env);
  const record = path.join(agentsDirPath(env), AGENTS_FOLDER_RECORD);
  assert.equal(await readFile(record, 'utf8'), `${path.join(old, 'Agents')}\n`, 'still the old folder');

  // The old home goes away: the next start re-points from the record.
  await fs.promises.chmod(old, 0o700);
  await fs.promises.rm(old, { recursive: true, force: true });
  assert.match((await surfaceAgentsHome(env)) ?? '', /re-pointed 2 link\(s\)/);
  assert.equal(await readlink(path.join(agentsDirPath(env), 'ava.md')), path.join(home, 'Agents', 'ava', 'soul.md'));
  assert.equal(await readFile(record, 'utf8'), `${path.join(home, 'Agents')}\n`);
});

test('a start with nothing to move records the agents folder its links name', async () => {
  const { env, home } = await copiedHome(['ava']);
  await surfaceAgentsHome(env);
  const record = path.join(agentsDirPath(env), AGENTS_FOLDER_RECORD);
  await fs.promises.rm(record);
  assert.equal(await surfaceAgentsHome(env), undefined);
  assert.equal(await readFile(record, 'utf8'), `${path.join(home, 'Agents')}\n`);
});

test('a re-pointed workspace keeps the provenance labels its ledger recorded at the old path', async () => {
  const old = await newHome();
  const oldEnv = { homeDir: old, processEnv: {} };
  await mkdir(path.join(agentWorkspacePath(oldEnv, 'ava'), 'mcp'), { recursive: true });
  await writeFile(path.join(agentsDirPath(oldEnv), 'ava.md'), soulText('ava'));
  await surfaceAgentsHome(oldEnv);
  const oldWorkspace = path.join(old, 'Agents', 'ava', 'workspace');
  await writeFile(path.join(oldWorkspace, 'mcp', 'chart.png'), 'bytes');
  await writeFile(path.join(oldWorkspace, LEDGER_FILENAME), `${JSON.stringify({ path: path.join(oldWorkspace, 'mcp', 'chart.png'), trust: 'external' })}\n`);
  const home = await newHome();
  await fs.promises.cp(path.join(old, '.stratus'), path.join(home, '.stratus'), { recursive: true, verbatimSymlinks: true });
  await fs.promises.cp(path.join(old, 'Agents'), path.join(home, 'Agents'), { recursive: true });
  await fs.promises.rm(old, { recursive: true, force: true });
  const env = { homeDir: home, processEnv: {} };

  await surfaceAgentsHome(env);
  const workspace = path.join(home, 'Agents', 'ava', 'workspace');
  const recorded = (await readFile(path.join(workspace, LEDGER_FILENAME), 'utf8'))
    .split('\n').filter(Boolean).map((line) => JSON.parse(line) as { path: string; trust: string });
  assert.ok(recorded.some((entry) => entry.path === path.join(workspace, 'mcp', 'chart.png') && entry.trust === 'external'), JSON.stringify(recorded));
});

test('a re-pointed workspace keeps the labels its ledger recorded under the old folder\'s real path', async () => {
  // The old agents folder sat behind a link, so the ledger names files by
  // the real path while the hidden links spell the linked one.
  const old = await newHome();
  await mkdir(path.join(old, 'real'));
  await symlink(path.join(old, 'real'), path.join(old, 'via'));
  const oldFolder = path.join(old, 'via', 'Agents');
  const oldEnv = { homeDir: old, processEnv: { [AGENTS_DIR_ENV]: oldFolder } };
  await mkdir(path.join(agentWorkspacePath(oldEnv, 'ava'), 'mcp'), { recursive: true });
  await writeFile(path.join(agentsDirPath(oldEnv), 'ava.md'), soulText('ava'));
  await surfaceAgentsHome(oldEnv);
  assert.equal(await readlink(agentWorkspacePath(oldEnv, 'ava')), path.join(oldFolder, 'ava', 'workspace'));
  const realWorkspace = path.join(old, 'real', 'Agents', 'ava', 'workspace');
  await writeFile(path.join(realWorkspace, 'mcp', 'chart.png'), 'bytes');
  await writeFile(path.join(realWorkspace, LEDGER_FILENAME), `${JSON.stringify({ path: path.join(realWorkspace, 'mcp', 'chart.png'), trust: 'external' })}\n`);
  const home = await newHome();
  await fs.promises.cp(path.join(old, '.stratus'), path.join(home, '.stratus'), { recursive: true, verbatimSymlinks: true });
  await fs.promises.cp(path.join(old, 'real', 'Agents'), path.join(home, 'Agents'), { recursive: true });
  await fs.promises.rm(old, { recursive: true, force: true });
  const env = { homeDir: home, processEnv: {} };

  assert.match((await surfaceAgentsHome(env)) ?? '', /re-pointed 2 link\(s\)/);
  const workspace = path.join(home, 'Agents', 'ava', 'workspace');
  const recorded = (await readFile(path.join(workspace, LEDGER_FILENAME), 'utf8'))
    .split('\n').filter(Boolean).map((line) => JSON.parse(line) as { path: string; trust: string });
  assert.ok(recorded.some((entry) => entry.path === path.join(workspace, 'mcp', 'chart.png') && entry.trust === 'external'), JSON.stringify(recorded));
});

test('a copy whose old home is still there keeps the record naming it, so a start after that home is gone still re-points', async () => {
  const { home, env, old } = await copiedHome(['ava']);
  // The old home is back (another user's, say), and its files still resolve.
  await fs.promises.cp(path.join(home, 'Agents'), path.join(old, 'Agents'), { recursive: true });
  const hiddenSoul = path.join(agentsDirPath(env), 'ava.md');
  assert.equal(await surfaceAgentsHome(env), undefined, 'a link whose target exists is left alone');
  assert.equal(await readlink(hiddenSoul), path.join(old, 'Agents', 'ava', 'soul.md'));
  const record = path.join(agentsDirPath(env), AGENTS_FOLDER_RECORD);
  assert.equal(await readFile(record, 'utf8'), `${path.join(old, 'Agents')}\n`, 'the links still name the old folder');

  await fs.promises.rm(old, { recursive: true, force: true });
  assert.match((await surfaceAgentsHome(env)) ?? '', /re-pointed 2 link\(s\)/);
  assert.equal(await readlink(hiddenSoul), path.join(home, 'Agents', 'ava', 'soul.md'));
  assert.equal(await readFile(record, 'utf8'), `${path.join(home, 'Agents')}\n`);
});

test('a dangling link is left alone, and named with where it points, unless this home has the same agent\'s file', async () => {
  const { home, env, old } = await copiedHome(['ava', 'bob', 'cat', 'dan', 'eve']);
  // Bob's soul is not in this home's folder.
  await fs.promises.rm(path.join(home, 'Agents', 'bob', 'soul.md'));
  // Cat's soul pointed into an operator's own checkout, not an agents folder.
  const catSoul = path.join(agentsDirPath(env), 'cat.md');
  await fs.promises.unlink(catSoul);
  await symlink(path.join(old, 'dotfiles', 'cat', 'soul.md'), catSoul);
  // Dan's names a file in his folder that is not a soul.
  const danSoul = path.join(agentsDirPath(env), 'dan.md');
  await fs.promises.unlink(danSoul);
  await symlink(path.join(old, 'Agents', 'dan', 'notes.md'), danSoul);
  await writeFile(path.join(home, 'Agents', 'dan', 'notes.md'), 'not a soul');
  // Eve's soul.md here is a folder, not a soul.
  await fs.promises.rm(path.join(home, 'Agents', 'eve', 'soul.md'));
  await mkdir(path.join(home, 'Agents', 'eve', 'soul.md'));
  // Ava's still resolves: another home at that path is somebody's, not this one's to take back.
  const elsewhere = await newHome();
  await mkdir(path.join(elsewhere, 'Agents', 'ava'), { recursive: true });
  await writeFile(path.join(elsewhere, 'Agents', 'ava', 'soul.md'), soulText('ava'));
  const avaSoul = path.join(agentsDirPath(env), 'ava.md');
  await fs.promises.unlink(avaSoul);
  await symlink(path.join(elsewhere, 'Agents', 'ava', 'soul.md'), avaSoul);

  const plan = await planAgentsHome(env);
  assert.deepEqual(plan.relink.map((entry) => entry.link), [
    agentWorkspacePath(env, 'ava'),
    agentWorkspacePath(env, 'bob'),
    agentWorkspacePath(env, 'cat'),
    agentWorkspacePath(env, 'dan'),
    agentWorkspacePath(env, 'eve'),
  ], 'only the workspaces, whose folders are all here');
  assert.deepEqual(plan.dangling, [
    `${path.join(agentsDirPath(env), 'bob.md')} -> ${path.join(old, 'Agents', 'bob', 'soul.md')}`,
    `${catSoul} -> ${path.join(old, 'dotfiles', 'cat', 'soul.md')}`,
    `${danSoul} -> ${path.join(old, 'Agents', 'dan', 'notes.md')}`,
    `${path.join(agentsDirPath(env), 'eve.md')} -> ${path.join(old, 'Agents', 'eve', 'soul.md')}`,
  ]);
  // Bob's and Eve's name the old agents folder, and Cat's another folder of
  // that shape, so doctor says how to re-point them if this home came from
  // there; Dan's link does not name a soul.
  assert.deepEqual(plan.elsewhere, [{ folder: path.join(old, 'Agents'), links: 2 }, { folder: path.join(old, 'dotfiles'), links: 1 }]);
  // Ava's link reads another home's soul and Dan's a file that isn't one, so
  // nothing reads theirs here; Cat's is the one his link would be re-pointed at.
  assert.deepEqual(plan.unlinked, [path.join(home, 'Agents', 'ava', 'soul.md'), path.join(home, 'Agents', 'dan', 'soul.md')]);

  await surfaceAgentsHome(env);
  assert.equal(await readlink(path.join(agentsDirPath(env), 'bob.md')), path.join(old, 'Agents', 'bob', 'soul.md'));
  assert.equal(await readlink(catSoul), path.join(old, 'dotfiles', 'cat', 'soul.md'));
  assert.equal(await readlink(danSoul), path.join(old, 'Agents', 'dan', 'notes.md'));
  assert.equal(await readlink(path.join(agentsDirPath(env), 'eve.md')), path.join(old, 'Agents', 'eve', 'soul.md'));
  assert.equal(await readlink(avaSoul), path.join(elsewhere, 'Agents', 'ava', 'soul.md'));
  assert.equal(await readFile(path.join(agentsDirPath(env), AGENTS_FOLDER_RECORD), 'utf8'), `${path.join(old, 'Agents')}\n`, 'kept while a link into the old folder is still broken');
  // The roster's warning says it is a link, and where to.
  await assert.rejects(
    () => loadSoulFile(path.join(agentsDirPath(env), 'bob.md')),
    new RegExp(`is a link to ${path.join(old, 'Agents', 'bob', 'soul.md').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, which does not exist`),
  );
});

test('a copied home whose agents folder lacks the marker re-points nothing', async () => {
  const { home } = await copiedHome(['ava']);
  await fs.promises.rm(path.join(home, 'Agents', AGENTS_HOME_MARKER));
  // Named outright, so the unmarked folder is still the one in use.
  const env = { homeDir: home, processEnv: { [AGENTS_DIR_ENV]: path.join(home, 'Agents') } };
  const hiddenSoul = path.join(agentsDirPath(env), 'ava.md');
  const before = await readlink(hiddenSoul);

  const plan = await planAgentsHome(env);
  assert.equal(plan.agentsHome, path.join(home, 'Agents'));
  assert.equal(plan.claimed, false);
  assert.deepEqual(plan.relink, []);
  await surfaceAgentsHome(env);
  assert.equal(await readlink(hiddenSoul), before);
});

test('a soul a broken link may still be re-pointed at is never listed as one nothing reads', async () => {
  // A pre-record home copied with its agents folder: the local soul is the
  // only copy the link can be re-pointed at, so doctor must not suggest deleting it.
  const { env, old } = await copiedHome(['ava']);
  await fs.promises.rm(path.join(agentsDirPath(env), AGENTS_FOLDER_RECORD));
  const plan = await planAgentsHome(env);
  assert.deepEqual(plan.unlinked, []);
  assert.deepEqual(plan.elsewhere, [{ folder: path.join(old, 'Agents'), links: 2 }]);
});

test('a copied home with no record, from an agents folder of any name, is named, and re-points once it is recorded', async () => {
  const old = await newHome();
  const oldFolder = path.join(old, 'People');
  const oldEnv = { homeDir: old, processEnv: { [AGENTS_DIR_ENV]: oldFolder } };
  await mkdir(agentWorkspacePath(oldEnv, 'ava'), { recursive: true });
  await writeFile(path.join(agentsDirPath(oldEnv), 'ava.md'), soulText('ava'));
  assert.match((await surfaceAgentsHome(oldEnv)) ?? '', /moved/);
  const home = await newHome();
  await fs.promises.cp(path.join(old, '.stratus'), path.join(home, '.stratus'), { recursive: true, verbatimSymlinks: true });
  await fs.promises.cp(oldFolder, path.join(home, 'Agents'), { recursive: true });
  await fs.promises.rm(old, { recursive: true, force: true });
  const env = { homeDir: home, processEnv: {} };
  const record = path.join(agentsDirPath(env), AGENTS_FOLDER_RECORD);
  await fs.promises.rm(record);

  const plan = await planAgentsHome(env);
  assert.deepEqual(plan.relink, []);
  assert.deepEqual(plan.elsewhere, [{ folder: oldFolder, links: 2 }]);
  assert.deepEqual(plan.unlinked, []);
  await writeFile(record, `${oldFolder}\n`);
  assert.match((await surfaceAgentsHome(env)) ?? '', /re-pointed 2 link\(s\)/);
  assert.equal(await readlink(path.join(agentsDirPath(env), 'ava.md')), path.join(home, 'Agents', 'ava', 'soul.md'));
});

test('a record that cannot be read is named and never replaced, so the next start can still use it', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root reads through the mode');
    return;
  }
  const { home, env, old } = await copiedHome(['ava']);
  const record = path.join(agentsDirPath(env), AGENTS_FOLDER_RECORD);
  await fs.promises.chmod(record, 0o000);
  t.after(() => fs.promises.chmod(record, 0o600));

  const plan = await planAgentsHome(env);
  const report = await surfaceAgentsHome(env);
  await fs.promises.chmod(record, 0o600);
  assert.equal(await readFile(record, 'utf8'), `${path.join(old, 'Agents')}\n`, 'the old folder is still recorded');
  assert.match(report ?? '', /could not read .*\.agents-folder/);
  assert.match(plan.recordUnreadable ?? '', /could not read .*\.agents-folder/);
  assert.deepEqual(plan.relink, []);
  assert.match((await surfaceAgentsHome(env)) ?? '', /re-pointed 2 link\(s\)/);
  assert.equal(await readlink(path.join(agentsDirPath(env), 'ava.md')), path.join(home, 'Agents', 'ava', 'soul.md'));
});
