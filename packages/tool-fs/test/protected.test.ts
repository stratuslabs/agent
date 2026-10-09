import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ToolRegistry, type JsonObject, type ProtectedPaths, type Session, type Tool } from '@stratusagent/core';

import { createFsPlugin } from '../src/index.ts';

const SECRET = 'sk-ant-api03-protected-paths-test';

/**
 * A home laid out the way the daemon's is, protected the way the daemon
 * protects it: the whole of `.stratus`, minus the workspaces, with the
 * credential store also named on its own.
 */
const newHome = async () => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'stratus-fs-protected-')));
  const stratus = path.join(home, '.stratus');
  const workspace = path.join(stratus, 'agents', 'ava', 'workspace');
  await mkdir(workspace, { recursive: true });
  const credentials = path.join(stratus, 'credentials.json');
  await writeFile(credentials, JSON.stringify({ anthropic: { api_key: SECRET } }));
  await writeFile(path.join(stratus, 'agents', 'juno-memory.jsonl'), `{"text":"juno remembers ${SECRET}"}\n`);
  await writeFile(path.join(workspace, 'notes.md'), `a note that mentions sk-ant-api03 in passing\n`);
  await mkdir(path.join(home, 'projects'), { recursive: true });
  await writeFile(path.join(home, 'projects', 'readme.md'), 'an ordinary file the operator meant to share\n');
  const protectedPaths: ProtectedPaths = {
    all: async () => [stratus, credentials],
    exempt: async () => [workspace],
  };
  return { home, stratus, workspace, credentials, protectedPaths };
};

const registryFor = async (config: JsonObject, protectedPaths?: ProtectedPaths): Promise<ToolRegistry> => {
  const tools = new ToolRegistry();
  await createFsPlugin(config).setup({
    bus: { emit: async () => undefined, subscribe: () => () => undefined } as never,
    tools,
    ...(protectedPaths !== undefined ? { protectedPaths } : {}),
  });
  return tools;
};

const session: Session = {
  id: 'session-ava',
  agent: { id: 'ava', name: 'ava' },
  status: 'running',
  messages: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const run = async (tools: ToolRegistry, name: string, input: JsonObject) => (tools.get(name) as Tool).execute(input, session);

test('without a protected set from the host, a root of ~ reads the credential store (the gap this closes)', async () => {
  const { home, credentials } = await newHome();
  const tools = await registryFor({ roots: [home] });
  const read = await run(tools, 'fs.read', { path: credentials }) as JsonObject;
  assert.match(String(read.content), new RegExp(SECRET));
});

test('a root of ~ cannot read the credential store, another agent’s memory, or list the home', async () => {
  const { home, stratus, credentials, protectedPaths } = await newHome();
  const tools = await registryFor({ roots: [home] }, protectedPaths);

  await assert.rejects(run(tools, 'fs.read', { path: credentials }), /keeps from every agent/);
  await assert.rejects(run(tools, 'fs.read', { path: '.stratus/agents/juno-memory.jsonl' }), /keeps from every agent/);
  await assert.rejects(run(tools, 'fs.list', { path: stratus }), /keeps from every agent/);
  await assert.rejects(run(tools, 'fs.search', { query: 'x', path: credentials }), /keeps from every agent/);

  // What the operator meant to share is untouched.
  const shared = await run(tools, 'fs.read', { path: 'projects/readme.md' }) as JsonObject;
  assert.match(String(shared.content), /ordinary file/);
});

test('the agent’s workspace inside the protected home stays readable and writable', async () => {
  const { workspace, home, protectedPaths } = await newHome();
  const tools = await registryFor({ roots: [home] }, protectedPaths);

  const read = await run(tools, 'fs.read', { path: path.join(workspace, 'notes.md') }) as JsonObject;
  assert.match(String(read.content), /a note/);
  await run(tools, 'fs.write', { path: path.join(workspace, 'out.md'), content: 'written' });
  assert.equal(await readFile(path.join(workspace, 'out.md'), 'utf8'), 'written');
  const listed = await run(tools, 'fs.list', { path: workspace }) as JsonObject;
  assert.ok((listed.entries as Array<{ name: string }>).some((entry) => entry.name === 'out.md'));
});

test('a write cannot create or replace a file in the protected home', async () => {
  const { stratus, credentials, home, protectedPaths } = await newHome();
  const tools = await registryFor({ roots: [home] }, protectedPaths);

  await assert.rejects(
    run(tools, 'fs.write', { path: path.join(stratus, 'agents', 'ava', 'whitelist.json'), content: '{}' }),
    /keeps from every agent/,
  );
  await assert.rejects(run(tools, 'fs.write', { path: credentials, content: '{}' }), /keeps from every agent/);
  assert.match(await readFile(credentials, 'utf8'), new RegExp(SECRET));
});

test('a search from ~ finds workspace text, skips the protected files by name, and never shows their content', async () => {
  const { home, protectedPaths } = await newHome();
  const tools = await registryFor({ roots: [home] }, protectedPaths);

  const found = await run(tools, 'fs.search', { query: 'sk-ant-api03' }) as JsonObject;
  const matches = found.matches as Array<{ path: string; text: string }>;
  assert.deepEqual(matches.map((match) => match.path), [path.join('.stratus', 'agents', 'ava', 'workspace', 'notes.md')]);
  assert.ok(matches.every((match) => !match.text.includes(SECRET)));
  const skipped = found.skipped as Array<{ path: string; reason: string }>;
  assert.ok(skipped.some((entry) => entry.path === path.join('.stratus', 'credentials.json') && /kept from every agent/.test(entry.reason)));
});

test('a hard link to the credential store from inside the workspace is refused', async () => {
  const { workspace, credentials, home, protectedPaths } = await newHome();
  await link(credentials, path.join(workspace, 'innocent.txt'));
  const tools = await registryFor({ roots: [home] }, protectedPaths);
  await assert.rejects(run(tools, 'fs.read', { path: path.join(workspace, 'innocent.txt') }), /keeps from every agent/);
});
