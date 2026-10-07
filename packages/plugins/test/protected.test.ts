import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ProtectedPaths } from '@stratusagent/core';

import { protectedPathGuard } from '../src/index.ts';

const fakeProtected = (all: readonly string[], exempt: readonly string[] = []): ProtectedPaths => ({
  all: async () => all,
  exempt: async () => exempt,
});

const newHome = async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'stratus-protected-')));
  const home = path.join(base, '.stratus');
  const workspace = path.join(home, 'agents', 'ava', 'workspace');
  await mkdir(workspace, { recursive: true });
  const credentials = path.join(home, 'credentials.json');
  await writeFile(credentials, '{"anthropic":{"api_key":"sk-ant-secret"}}');
  return { base, home, workspace, credentials };
};

test('a host that supplies nothing protects nothing', async () => {
  const { credentials } = await newHome();
  const guard = await protectedPathGuard(undefined);
  assert.equal(await guard(credentials), undefined);
});

test('everything under a protected directory is protected, and an exempt directory inside it is not', async () => {
  const { home, workspace, credentials } = await newHome();
  const guard = await protectedPathGuard(fakeProtected([home, credentials], [workspace]));

  assert.equal(await guard(credentials), credentials);
  assert.equal(await guard(path.join(home, 'agents', 'ava', 'memory.jsonl')), home);
  assert.equal(await guard(path.join(home, 'agents', 'juno', 'sessions.db')), home);
  assert.equal(await guard(home), home);
  assert.equal(await guard(path.join(workspace, 'notes.md')), undefined);
  assert.equal(await guard(workspace), undefined);
  // A sibling that only shares a prefix is not inside.
  assert.equal(await guard(`${home}-other/file`), undefined);
});

test('a protected path inside an exempt directory stays protected', async () => {
  const { workspace } = await newHome();
  const secret = path.join(workspace, 'keys');
  const guard = await protectedPathGuard(fakeProtected([secret], [workspace]));
  assert.equal(await guard(path.join(secret, 'deploy')), secret);
  assert.equal(await guard(path.join(workspace, 'notes.md')), undefined);
});

test('the canonical spelling of a protected home behind a link is protected too', async () => {
  const { base, home } = await newHome();
  const linked = path.join(base, 'linked-stratus');
  await symlink(home, linked);
  // The host names the link; the root resolver hands the guard real paths.
  const guard = await protectedPathGuard(fakeProtected([linked]));
  assert.equal(await guard(path.join(home, 'credentials.json')), linked);
});

test('a hard link to a protected file is refused by inode, even from an exempt workspace', async () => {
  const { home, workspace, credentials } = await newHome();
  const planted = path.join(workspace, 'innocent.txt');
  await link(credentials, planted);
  const guard = await protectedPathGuard(fakeProtected([home, credentials], [workspace]));
  assert.equal(await guard(planted), credentials);
  // An ordinary file beside it is still reachable.
  await writeFile(path.join(workspace, 'plain.txt'), 'hello');
  assert.equal(await guard(path.join(workspace, 'plain.txt')), undefined);
});

test('a path that does not exist yet under a protected directory is protected, so a write cannot create it', async () => {
  const { home, workspace } = await newHome();
  const guard = await protectedPathGuard(fakeProtected([home], [workspace]));
  assert.equal(await guard(path.join(home, 'agents', 'ava', 'whitelist.json')), home);
  assert.equal(await guard(path.join(workspace, 'new.md')), undefined);
});
