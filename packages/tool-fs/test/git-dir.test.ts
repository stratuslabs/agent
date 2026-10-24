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
