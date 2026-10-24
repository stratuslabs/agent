import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ToolRegistry, type JsonObject, type Session, type Tool } from '@stratusagent/core';

import { createFsPlugin } from '../src/index.ts';

const registryFor = async (config: JsonObject): Promise<ToolRegistry> => {
  const tools = new ToolRegistry();
  await createFsPlugin(config).setup({
    bus: { emit: async () => undefined, subscribe: () => () => undefined } as never,
    tools,
  } as never);
  return tools;
};

const session: Session = {
  id: 'session-git-dir',
  agent: { id: 'ava', name: 'ava' },
  status: 'running',
  messages: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  metadata: {},
};

const run = async (tools: ToolRegistry, name: string, input: JsonObject) =>
  (tools.get(name) as Tool).execute(input, session);

const layout = async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'stratus-fs-git-')));
  await mkdir(path.join(root, 'repo', '.git'), { recursive: true });
  await writeFile(path.join(root, 'repo', '.git', 'config'), '[core]\n\tbare = false\n');
  await mkdir(path.join(root, 'elsewhere'), { recursive: true });
  // A repository whose `.git` is a link to a directory named something else.
  await mkdir(path.join(root, 'linked-gitdir'), { recursive: true });
  await mkdir(path.join(root, 'linked'), { recursive: true });
  await symlink(path.join(root, 'linked-gitdir'), path.join(root, 'linked', '.git'));
  return { root, tools: await registryFor({ roots: [root] }) };
};

// Git runs programs a repository's config names (core.fsmonitor, diff and
// filter drivers) even for `git status`. An agent that could write a `.git`
// could turn one approved git command into any command.
test('fs.write never writes inside a .git directory or a .git file', async () => {
  const { root, tools } = await layout();
  for (const target of [
    'repo/.git/config',
    'repo/.git/hooks/pre-commit',
    'fresh/.git/config',
    'fresh/.git',
    'repo/.GIT/config',
    'linked/.git/config',
  ]) {
    await assert.rejects(run(tools, 'fs.write', { path: target, content: '[core]\n\tfsmonitor = x\n' }), /\.git/, target);
  }
  assert.equal(await readFile(path.join(root, 'repo', '.git', 'config'), 'utf8'), '[core]\n\tbare = false\n');
  await assert.rejects(stat(path.join(root, 'fresh')), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(root, 'linked-gitdir', 'config')), { code: 'ENOENT' });
  // Files beside a repository are ordinary files.
  await run(tools, 'fs.write', { path: 'repo/.gitignore', content: 'dist/\n' });
  await run(tools, 'fs.write', { path: 'repo/src/.github-notes.md', content: 'x' });
  assert.equal(await readFile(path.join(root, 'repo', '.gitignore'), 'utf8'), 'dist/\n');
});

test('fs.move never moves into or out of a .git directory', async () => {
  const { root, tools } = await layout();
  await mkdir(path.join(root, 'staged'), { recursive: true });
  await writeFile(path.join(root, 'staged', 'config'), '[core]\n\tfsmonitor = x\n');
  await writeFile(path.join(root, 'staged', 'HEAD'), 'ref: refs/heads/main\n');
  await assert.rejects(run(tools, 'fs.move', { from: 'staged', to: 'elsewhere/.git' }), /\.git/);
  await assert.rejects(run(tools, 'fs.move', { from: 'staged/config', to: 'repo/.git/config' }), /\.git/);
  await assert.rejects(run(tools, 'fs.move', { from: 'repo/.git/config', to: 'elsewhere/config' }), /\.git/);
  await assert.rejects(stat(path.join(root, 'elsewhere', '.git')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(root, 'repo', '.git', 'config'), 'utf8'), '[core]\n\tbare = false\n');
  // A whole repository can still move.
  await run(tools, 'fs.move', { from: 'repo', to: 'elsewhere/repo' });
  assert.equal(await readFile(path.join(root, 'elsewhere', 'repo', '.git', 'config'), 'utf8'), '[core]\n\tbare = false\n');
});

test('a root that is itself a .git directory is refused like any other', async () => {
  const { root } = await layout();
  const tools = await registryFor({ roots: [path.join(root, 'repo', '.git')] });
  await assert.rejects(run(tools, 'fs.write', { path: 'config', content: '[core]\n\tfsmonitor = x\n' }), /\.git/);
  assert.equal(await readFile(path.join(root, 'repo', '.git', 'config'), 'utf8'), '[core]\n\tbare = false\n');
});

test('fs.write never writes the global git config a root covers', async () => {
  const { root } = await layout();
  // A root at the home directory is an ordinary choice.
  const tools = await registryFor({ roots: [root], home: root });
  const planted = '[core]\n\tfsmonitor = x\n';
  for (const target of ['.gitconfig', '~/.gitconfig', 'dotfiles/.gitconfig', '.config/git/config', '.config/git/attributes']) {
    await assert.rejects(run(tools, 'fs.write', { path: target, content: planted }), /git/, target);
  }
  await assert.rejects(stat(path.join(root, '.gitconfig')), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(root, '.config', 'git')), { code: 'ENOENT' });
  // Through a link, too: a dotfiles checkout linked into place.
  await mkdir(path.join(root, 'dots'), { recursive: true });
  await mkdir(path.join(root, '.config'), { recursive: true });
  await symlink(path.join(root, 'dots'), path.join(root, '.config', 'git'));
  await assert.rejects(run(tools, 'fs.write', { path: '.config/git/config', content: planted }), /git/);
  await assert.rejects(stat(path.join(root, 'dots', 'config')), { code: 'ENOENT' });
  // Other files under .config are ordinary.
  await run(tools, 'fs.write', { path: '.config/app/settings.json', content: '{}' });
});

test('fs.move never builds git config by moving a directory into place', async () => {
  const { root } = await layout();
  const tools = await registryFor({ roots: [root], home: root });
  await mkdir(path.join(root, 'staged', 'git'), { recursive: true });
  // Written before the guard could see where it would end up.
  await writeFile(path.join(root, 'staged', 'git', 'config'), '[core]\n\tfsmonitor = x\n');
  await assert.rejects(run(tools, 'fs.move', { from: 'staged', to: '.config' }), /git/);
  await assert.rejects(stat(path.join(root, '.config')), { code: 'ENOENT' });
  // Moving a directory somewhere unrelated is fine.
  await run(tools, 'fs.move', { from: 'staged', to: 'archive' });
  assert.equal(await readFile(path.join(root, 'archive', 'git', 'config'), 'utf8'), '[core]\n\tfsmonitor = x\n');
});

test('fs.write never writes into a git directory a .git file names, whatever its name', async () => {
  const { root, tools } = await layout();
  // `git init --separate-git-dir ../metadata`: the work tree's `.git` is a
  // file, and the git directory has an ordinary name.
  await mkdir(path.join(root, 'metadata', 'objects'), { recursive: true });
  await mkdir(path.join(root, 'metadata', 'refs'), { recursive: true });
  await writeFile(path.join(root, 'metadata', 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(path.join(root, 'metadata', 'config'), '[core]\n\tbare = false\n');
  await mkdir(path.join(root, 'tree'), { recursive: true });
  await writeFile(path.join(root, 'tree', '.git'), 'gitdir: ../metadata\n');
  // A linked worktree's git directory has a commondir file, not objects.
  await mkdir(path.join(root, 'wt-meta'), { recursive: true });
  await writeFile(path.join(root, 'wt-meta', 'HEAD'), 'ref: refs/heads/topic\n');
  await writeFile(path.join(root, 'wt-meta', 'commondir'), '../metadata\n');
  const planted = '[core]\n\tfsmonitor = x\n';
  for (const target of ['metadata/config', 'metadata/hooks/pre-commit', 'wt-meta/config.worktree']) {
    await assert.rejects(run(tools, 'fs.write', { path: target, content: planted }), /git/, target);
  }
  assert.equal(await readFile(path.join(root, 'metadata', 'config'), 'utf8'), '[core]\n\tbare = false\n');
  await assert.rejects(stat(path.join(root, 'wt-meta', 'config.worktree')), { code: 'ENOENT' });
  // A directory with only some of those names is ordinary.
  await mkdir(path.join(root, 'notes'), { recursive: true });
  await writeFile(path.join(root, 'notes', 'HEAD'), 'not git\n');
  await run(tools, 'fs.write', { path: 'notes/config', content: 'x' });
});

test('fs.move never moves a file into a git directory a .git file names', async () => {
  const { root, tools } = await layout();
  await mkdir(path.join(root, 'metadata', 'objects'), { recursive: true });
  await mkdir(path.join(root, 'metadata', 'refs'), { recursive: true });
  await writeFile(path.join(root, 'metadata', 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(path.join(root, 'staged-config'), '[core]\n\tfsmonitor = x\n');
  await assert.rejects(run(tools, 'fs.move', { from: 'staged-config', to: 'metadata/config' }), /git/);
  await assert.rejects(stat(path.join(root, 'metadata', 'config')), { code: 'ENOENT' });
});

test('fs.write never writes a GIT_CONFIG_SYSTEM file the daemon was given', async () => {
  const { root, tools } = await layout();
  const previous = process.env.GIT_CONFIG_SYSTEM;
  process.env.GIT_CONFIG_SYSTEM = path.join(root, 'etc', 'gitconfig-system');
  try {
    await assert.rejects(run(tools, 'fs.write', { path: 'etc/gitconfig-system', content: '[core]\n\tfsmonitor = x\n' }), /git/);
    await assert.rejects(stat(path.join(root, 'etc', 'gitconfig-system')), { code: 'ENOENT' });
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_SYSTEM;
    else process.env.GIT_CONFIG_SYSTEM = previous;
  }
});
