import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, stat, symlink, writeFile } from 'node:fs/promises';
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
  inspectAgentsHome,
  loadRosterSouls,
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

  assert.deepEqual((await inspectAgentsHome(env)).dangling, [`${agentWorkspacePath(env, 'ava')} -> ${visible}`]);
  workspaces.prepare('ava');
  assert.ok((await stat(visible)).isDirectory());
  assert.deepEqual((await inspectAgentsHome(env)).dangling, []);
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
  // Ava's hidden workspace is a real directory again while a marker says it
  // already moved: the case `finishWorkspace` refuses rather than guesses.
  await writeFile(
    path.join(agentStateDirPath(env, 'ava'), '.workspace-surfacing'),
    JSON.stringify({ from: [agentWorkspacePath(env, 'ava')], to: path.join(home, 'Agents', 'ava', 'workspace') }),
  );

  const report = await surfaceAgentsHome(env);
  assert.match(report ?? '', /moved 0 soul\(s\) and 1 workspace\(s\)/);
  assert.match(report ?? '', /ava's workspace \(.*was recreated while its workspace was moving/);
  assert.ok((await lstat(agentWorkspacePath(env, 'bea'))).isSymbolicLink());
});
