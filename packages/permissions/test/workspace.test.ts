import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ApprovalContext, Session, Tool } from '@stratusagent/core';

import { analyzeCommand, createPermissionPolicy, readsInsideWorkspace } from '../src/index.ts';

const layout = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-autonomy-'));
  const workspace = path.join(root, 'agents', 'nova', 'workspace');
  const repo = path.join(workspace, 'app');
  const outside = path.join(root, 'secret.txt');
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await writeFile(path.join(repo, 'src', 'main.ts'), 'export const x = 1;\n');
  await writeFile(outside, 'token\n');
  await symlink(outside, path.join(repo, 'leak.txt'));
  await symlink(root, path.join(repo, 'up'));
  await mkdir(path.join(root, 'elsewhere', 'child'), { recursive: true });
  await writeFile(path.join(root, 'elsewhere', 'secret'), 'token\n');
  await symlink(path.join(root, 'elsewhere', 'child'), path.join(repo, 'hop'));
  return { root, workspace, repo, outside };
};

test('a read inside the workspace is judged inside, and one that leaves it is not', async () => {
  const { workspace, repo, outside } = await layout();
  const inside = async (command: string, cwd = repo) => readsInsideWorkspace(analyzeCommand(command), cwd, workspace);

  for (const command of [
    'cat src/main.ts',
    'ls',
    'ls -la src',
    'head -n 5 src/main.ts',
    'tail -20 src/main.ts',
    'wc -l src/main.ts',
    'grep -rn export src',
    'grep -rn export',
    "grep -e 'a|b' src/main.ts",
    'rg export',
    'rg --files',
    'rg -n "x = 1" src',
    'find . -name main.ts -type f',
    'find src -maxdepth 2',
    `cat ${path.join(repo, 'src', 'main.ts')}`,
    'ls missing-dir',
    'grep --color=always export src/main.ts',
    'ls src/../src',
  ]) {
    assert.equal(await inside(command), true, `should be inside: ${command}`);
  }

  for (const command of [
    `cat ${outside}`,
    'cat ../../../../secret.txt',
    // Symlinks are judged by where they land.
    'cat leak.txt',
    'ls up',
    'grep -r token up',
    // `..` after a symlink is the parent of where the link points.
    'cat hop/../secret',
    // `$` and backticks expand inside double quotes.
    'cat "$HOME/.ssh/id_rsa"',
    'cat "`echo x`"',
    // An optional-argument flag must not swallow the pattern.
    'grep --color root /etc/passwd',
    'grep - /etc/passwd',
    'rg - /etc/passwd',
    // Globs and home are paths this parser never saw.
    'cat *.txt',
    'cat ~/x',
    'grep export $HOME',
    // Flags that follow links out, run programs, or write.
    'grep -R token .',
    'rg --follow token',
    'rg --pre cat token',
    'find . -exec cat {} +',
    'find -L .',
    'find . -delete',
    'find . -fprint out.txt',
    'tail -f src/main.ts',
    // Commands that aren't readers at all.
    'cp src/main.ts /tmp/x',
    'rm src/main.ts',
    'sed -n 1p src/main.ts',
    // grep with no file and no -r reads stdin: not this rule's call.
    'grep',
  ]) {
    assert.equal(await inside(command), false, `should not be inside: ${command}`);
  }

  // The working directory must be inside too, or relative paths mean
  // something else.
  assert.equal(await inside('ls', os.tmpdir()), false);
});

const shell: Tool = {
  name: 'shell.run',
  description: 'Run a shell command.',
  risk: 'gated',
  parameters: { type: 'object' },
  commandFor: (input) => (typeof input.command === 'string' ? input.command : undefined),
  execute: async () => null,
};

test('autonomy lets reads run unattended for the agents it is on for, pipelines included', async () => {
  const { workspace, repo } = await layout();
  const tool: Tool = { ...shell, cwdFor: () => repo };
  const contextFor = (agentId: string, command: string): ApprovalContext => ({
    tool,
    risk: 'gated',
    call: { id: 'c1', toolName: 'shell.run', input: { command } },
    session: { id: `s-${agentId}`, agent: { id: agentId, name: agentId }, status: 'running', messages: [] } as unknown as Session,
  } as ApprovalContext);
  const decisions: string[] = [];
  const policy = createPermissionPolicy({
    mode: 'headless',
    onDecision: (decision) => decisions.push(decision.reason),
    commands: { workspace: { directoryFor: (agentId) => (agentId === 'nova' ? workspace : undefined) } },
  });

  assert.equal(await policy.approve(contextFor('nova', 'grep -rn export src')), true);
  assert.match(decisions.at(-1) ?? '', /autonomy: workspace/);
  assert.equal(await policy.approve(contextFor('nova', 'git log | grep export')), true);
  assert.equal(await policy.approve(contextFor('nova', 'cat src/main.ts | wc -l')), true);
  // Off for this agent: the same read asks (and headless refuses).
  assert.equal(await policy.approve(contextFor('blair', 'grep -rn export src')), false);
  // On, but not a read, or not inside.
  assert.equal(await policy.approve(contextFor('nova', 'cat leak.txt')), false);
  assert.equal(await policy.approve(contextFor('nova', 'cat src/main.ts | sh')), false);
  assert.equal(await policy.approve(contextFor('nova', 'rm src/main.ts')), false);
  // A tool that can't say where it runs is never judged by this rule.
  const blind = createPermissionPolicy({ mode: 'headless', commands: { workspace: { directoryFor: () => workspace } } });
  assert.equal(await blind.approve({ ...contextFor('nova', 'cat src/main.ts'), tool: shell }), false);
});
