import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AgentWorkspaces } from '@stratusagent/core';

import { allAgentWorkspaces, workspacePreparer, workspaceResolver } from '../src/index.ts';

/** A host that knows its own layout, as the loader hands it over. */
const fakeWorkspaces = (home: string): AgentWorkspaces => ({
  forAgent: (agentId) => path.join(home, 'agents', agentId, 'workspace'),
  prepare: (agentId) => path.join(home, 'agents', agentId, 'workspace'),
  all: async () => [path.join(home, 'agents', 'ava', 'workspace'), path.join(home, 'agents', 'bea', 'workspace')],
});

test('the host answers where an agent’s workspace is, and a plugin never joins the id itself', () => {
  const resolve = workspaceResolver(fakeWorkspaces('/home/ada/.stratus'), undefined);
  assert.equal(resolve?.('ava'), '/home/ada/.stratus/agents/ava/workspace');
  // Which is the whole point of the seam: the id is not the last segment,
  // so a plugin that appended it would have written the wrong path.
  assert.notEqual(resolve?.('ava'), path.join('/home/ada/.stratus/agents', 'ava'));
});

test('a caller about to write asks the host to make the directory; one that only names it does not', () => {
  // The whole reason there are two. Preparing can fail — the directory sits
  // in the agent's state directory and may be unmakeable — and what fails
  // with it should be only what needed it: a ledger *read* names a file
  // that may not exist, and must not go down with a write's directory.
  const asked: string[] = [];
  const host: AgentWorkspaces = {
    forAgent: (agentId) => `/home/ada/.stratus/agents/${agentId}/workspace`,
    prepare: (agentId) => {
      asked.push(agentId);
      return `/home/ada/.stratus/agents/${agentId}/workspace`;
    },
    all: async () => [],
  };
  assert.equal(workspaceResolver(host, undefined)?.('ava'), '/home/ada/.stratus/agents/ava/workspace');
  assert.deepEqual(asked, []);
  assert.equal(workspacePreparer(host, undefined)?.('ava'), '/home/ada/.stratus/agents/ava/workspace');
  assert.deepEqual(asked, ['ava']);

  // Under a configured root the two are the same answer: it is not a state
  // directory, so there is nothing for the host to secure and plugins make
  // what they need beneath it.
  assert.equal(workspacePreparer(host, '/data/shots')?.('ava'), path.join('/data/shots', 'ava'));
  assert.deepEqual(asked, ['ava']);
});

test('a workspaceRoot an operator wrote down wins over the host’s layout', () => {
  // Precedence, not preference. The loader no longer fills this key with
  // the host's answer, so a value here is one somebody chose — and
  // relocating a plugin's output by writing it down is documented.
  const resolve = workspaceResolver(fakeWorkspaces('/home/ada/.stratus'), '/data/shots');
  assert.equal(resolve?.('ava'), path.join('/data/shots', 'ava'));
  // And under a configured root the old contract still holds: one
  // directory per agent, directly under it.
  assert.equal(workspaceResolver(undefined, '/data/shots')?.('bea'), path.join('/data/shots', 'bea'));
});

test('a host that supplies neither leaves the plugin with nowhere to write, and says so by returning nothing', () => {
  assert.equal(workspaceResolver(undefined, undefined), undefined);
  // Empty is not a root: it would join to a relative path, which is the
  // process's working directory and nobody's workspace.
  assert.equal(workspaceResolver(undefined, ''), undefined);
  // With a seam, an empty root falls through to it rather than winning.
  assert.equal(workspaceResolver(fakeWorkspaces('/home/ada/.stratus'), '')?.('ava'), '/home/ada/.stratus/agents/ava/workspace');
});

test('every workspace on the host comes from the seam, and from a configured root’s own entries', async () => {
  assert.deepEqual(
    await allAgentWorkspaces(fakeWorkspaces('/home/ada/.stratus'), undefined),
    ['/home/ada/.stratus/agents/ava/workspace', '/home/ada/.stratus/agents/bea/workspace'],
  );
  // The configured root's entries are the agents — the same reading of the
  // key that `workspaceResolver` gives it — and it wins here too.
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-ws-'));
  await mkdir(path.join(root, 'ava'), { recursive: true });
  await symlink(await mkdtemp(path.join(os.tmpdir(), 'stratus-vol-')), path.join(root, 'bea'));
  // Not an agent: a file cannot hold a ledger of its own.
  await writeFile(path.join(root, 'README.txt'), 'why these are here');
  assert.deepEqual(
    [...await allAgentWorkspaces(fakeWorkspaces('/home/ada/.stratus'), root)].sort(),
    [path.join(root, 'ava'), path.join(root, 'bea')],
  );
});

test('a root that is not there yet holds no agents, because the guard runs before the first write', async () => {
  const missing = path.join(await mkdtemp(path.join(os.tmpdir(), 'stratus-ws-')), 'not-yet');
  assert.deepEqual(await allAgentWorkspaces(undefined, missing), []);
  assert.deepEqual(await allAgentWorkspaces(undefined, undefined), []);
});

test('a root that cannot be listed is not an empty one: the guard must not fail open', async () => {
  // This list is what `ledgerGuard` is built from, and an empty one is a
  // guard that answers "not a ledger" to every path — so a swallowed
  // failure lets `fs.write` truncate the one file it must never touch. The
  // cases that reach this in production are a root that is executable but
  // not listable (its children still writable by name) and a transient
  // `EMFILE`; a loop stands in for them here, because a suite running as
  // root cannot be denied by mode bits.
  const root = path.join(await mkdtemp(path.join(os.tmpdir(), 'stratus-ws-')), 'loop');
  await symlink(root, root);
  await assert.rejects(() => allAgentWorkspaces(undefined, root), /ELOOP/);
});
