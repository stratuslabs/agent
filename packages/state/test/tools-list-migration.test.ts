import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseSoul } from '@stratusagent/agents';

import {
  agentsDirPath,
  globalConfigPath,
  readStateStamp,
  runStateMigrations,
  stateFilePath,
  stratusHomePath,
} from '../src/index.ts';

// An omitted tools: list now means safe tools only. A home an older build
// already used gets tools: ["*"] written into each soul that had no list,
// so the upgrade changes nothing an agent can do; a fresh install does not.

const MIGRATION = '0005-explicit-tools-lists';
const BEFORE = ['0001-owner-only-state-files', '0002-provenance-labels', '0003-per-agent-state-layout', '0004-per-agent-workspaces'];

const home = async (options: { upgraded: boolean }) => {
  const env = { homeDir: await realpath(await mkdtemp(path.join(os.tmpdir(), 'stratus-tools-list-'))) };
  await mkdir(agentsDirPath(env), { recursive: true });
  if (options.upgraded) {
    // What 0.14.2 left behind: everything before this migration applied.
    await writeFile(stateFilePath(env), JSON.stringify({ schemaVersion: 4, applied: BEFORE }));
  }
  return env;
};

const soulAt = async (filePath: string, source: string): Promise<string> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, source);
  return filePath;
};

const AVA = `---
# Ava's soul, written by hand
name: Ava
provider: anthropic
---
You are Ava. Be brief.
`;

test('on an upgraded home a soul with no tools list gets tools: ["*"], and nothing else about it changes', async () => {
  const env = await home({ upgraded: true });
  const soulPath = await soulAt(path.join(agentsDirPath(env), 'ava.md'), AVA);
  const before = parseSoul(AVA, { seed: soulPath });

  const applied = await runStateMigrations(env);
  assert.deepEqual(applied.map((migration) => migration.id), [MIGRATION]);
  assert.match(applied[0]?.detail ?? '', /tools: \["\*"\] into the soul of ava/);

  const written = await readFile(soulPath, 'utf8');
  const after = parseSoul(written, { seed: soulPath });
  assert.deepEqual(after.agent.tools, ['*']);
  assert.equal(after.agent.name, before.agent.name);
  assert.equal(after.agent.id, before.agent.id);
  assert.equal(after.agent.instructions, before.agent.instructions);
  assert.equal(after.provider, 'anthropic');
  // A text edit, not a re-render: the author's comment and key order stay.
  assert.ok(written.includes("# Ava's soul, written by hand\nname: Ava\nprovider: anthropic\n---\nYou are Ava. Be brief.\n"));
  assert.ok(written.startsWith('---\n# Added on upgrade'));

  assert.deepEqual((await readStateStamp(env)).applied, [...BEFORE, MIGRATION]);
  // Recorded, so a soul written after the upgrade keeps the new default.
  assert.deepEqual(await runStateMigrations(env), []);
});

test('on a fresh install a hand-written soul is left alone, so it gets the new default', async () => {
  const env = await home({ upgraded: false });
  const soulPath = await soulAt(path.join(agentsDirPath(env), 'ava.md'), AVA);

  // What a fresh home's ordinary commands do (0003 and 0004 deferred), then
  // its first `stratus serve`, which finishes and stamps.
  await runStateMigrations(env);
  await runStateMigrations(env, { exclusive: true });

  assert.equal(await readFile(soulPath, 'utf8'), AVA);
  assert.ok((await readStateStamp(env)).applied.includes(MIGRATION));
});

test('a soul that has a tools list, an empty one included, is not touched', async () => {
  const env = await home({ upgraded: true });
  const listed = `---\nname: Kai\ntools: [fs.*]\n---\nKai.\n`;
  const empty = `---\nname: Bea\ntools: []\n---\nBea.\n`;
  const kai = await soulAt(path.join(agentsDirPath(env), 'kai.md'), listed);
  const bea = await soulAt(path.join(agentsDirPath(env), 'bea.md'), empty);

  const applied = await runStateMigrations(env);
  assert.equal(applied[0]?.detail, undefined);
  assert.equal(await readFile(kai, 'utf8'), listed);
  assert.equal(await readFile(bea, 'utf8'), empty);
});

test('a soul with no frontmatter gets a fenced tools line on top, and keeps its generated name and id', async () => {
  const env = await home({ upgraded: true });
  const prose = 'Just prose, no frontmatter.\n';
  const soulPath = await soulAt(path.join(agentsDirPath(env), 'plain.md'), prose);
  const before = parseSoul(prose, { seed: soulPath });

  await runStateMigrations(env);
  const after = parseSoul(await readFile(soulPath, 'utf8'), { seed: soulPath });
  assert.deepEqual(after.agent.tools, ['*']);
  assert.equal(after.agent.id, before.agent.id);
  assert.equal(after.agent.name, before.agent.name);
  assert.equal(after.agent.instructions, 'Just prose, no frontmatter.');
});

test('a soul with Windows line endings keeps them', async () => {
  const env = await home({ upgraded: true });
  const soulPath = await soulAt(path.join(agentsDirPath(env), 'ava.md'), AVA.replace(/\n/g, '\r\n'));

  await runStateMigrations(env);
  const written = await readFile(soulPath, 'utf8');
  assert.deepEqual(parseSoul(written, { seed: soulPath }).agent.tools, ['*']);
  assert.equal(written.replace(/\r\n/g, '').includes('\n'), false);
});

test('a linked soul is edited behind its link, and the link stays a link', async () => {
  const env = await home({ upgraded: true });
  const visible = await soulAt(path.join(env.homeDir, 'Stratus', 'ava', 'soul.md'), AVA);
  const link = path.join(agentsDirPath(env), 'ava.md');
  await symlink(visible, link);

  await runStateMigrations(env);
  assert.equal((await lstat(link)).isSymbolicLink(), true);
  assert.deepEqual(parseSoul(await readFile(visible, 'utf8'), { seed: link }).agent.tools, ['*']);
});

test('the configured default soul outside the agents directory is covered when its path is absolute', async () => {
  const env = await home({ upgraded: true });
  const outside = await soulAt(path.join(env.homeDir, 'souls', 'ava.md'), AVA);
  await writeFile(globalConfigPath(env), JSON.stringify({ soul: outside }));

  await runStateMigrations(env);
  assert.deepEqual(parseSoul(await readFile(outside, 'utf8'), { seed: outside }).agent.tools, ['*']);
});

test('a relative configured soul is not guessed at, since it resolves against whoever reads it', async () => {
  const env = await home({ upgraded: true });
  const relative = path.join('souls', 'ava.md');
  const outside = await soulAt(path.join(stratusHomePath(env), relative), AVA);
  await writeFile(globalConfigPath(env), JSON.stringify({ soul: relative }));

  await runStateMigrations(env);
  assert.equal(await readFile(outside, 'utf8'), AVA);
});

test('a soul that does not load is left as it was and named in the report', async () => {
  const env = await home({ upgraded: true });
  const broken = `---\nname: Ava\nlistens: sometimes\n---\nAva.\n`;
  const soulPath = await soulAt(path.join(agentsDirPath(env), 'ava.md'), broken);

  const applied = await runStateMigrations(env);
  assert.equal(await readFile(soulPath, 'utf8'), broken);
  assert.match(applied[0]?.detail ?? '', /left .*ava\.md as it was/);
});
