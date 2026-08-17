import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  agentsDirPath,
  createFileMemoryStore,
  loadRosterSouls,
  loadSoulFile,
  memoryFilePath,
  resolveRuntimeConfig,
  saveCredentials,
} from '../src/index.ts';

const tempHome = await mkdtemp(path.join(os.tmpdir(), 'stratus-state-'));

test('file memory store appends and lists per agent with read-time dedupe', async () => {
  const store = createFileMemoryStore(memoryFilePath({ homeDir: tempHome }));
  await store.append('ava', 'likes short answers');
  await store.append('scout', 'reads everything');
  const entries = await store.list('ava');
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.content, 'likes short answers');
});

test('roster loading returns parsed souls and skips unreadable files with a warning', async () => {
  const env = { homeDir: tempHome };
  await mkdir(agentsDirPath(env), { recursive: true });
  await writeFile(path.join(agentsDirPath(env), 'ava.md'), '---\nname: Ava\n---\n\nYou are Ava.\n');
  // A directory with a .md name is unreadable as a soul file and must be
  // skipped without taking the rest of the roster down.
  await mkdir(path.join(agentsDirPath(env), 'broken.md'), { recursive: true });

  const warnings: string[] = [];
  const roster = await loadRosterSouls(env, (message) => warnings.push(message));

  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /broken\.md/);
  const ava = roster.find((entry) => entry.soul.agent.name === 'Ava');
  assert.ok(ava);
  assert.equal(ava.soul.agent.instructions, 'You are Ava.');
});

test('soul identity is seeded by path so ids stay stable across loads', async () => {
  const env = { homeDir: tempHome };
  const soulPath = path.join(agentsDirPath(env), 'anon.md');
  await mkdir(agentsDirPath(env), { recursive: true });
  await writeFile(soulPath, 'Just a persona, no frontmatter.\n');
  const first = await loadSoulFile(soulPath);
  const second = await loadSoulFile(soulPath);
  assert.equal(first.agent.id, second.agent.id);
});

test('credentials file is written owner-read-only', async () => {
  const env = { homeDir: tempHome };
  await saveCredentials(env, { anthropic: { type: 'api_key', value: 'sk-test' } });
  const filePath = path.join(tempHome, '.stratus', 'credentials.json');
  const mode = (await stat(filePath)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('runtime config defaults to the demo provider with no configuration', async () => {
  const config = await resolveRuntimeConfig({}, {
    homeDir: tempHome,
    cwd: tempHome,
    processEnv: {},
  });
  assert.equal(config.provider, 'demo');
});
