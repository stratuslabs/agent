import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  SESSION_TRUST_METADATA_KEY,
  ToolRegistry,
  type ExecutionContext,
  type JsonObject,
  type Session,
  type Tool,
  type TrustLevel,
} from '@stratusagent/core';

import { createFileLedger, createFsPlugin, LEDGER_FILENAME } from '../src/index.ts';

const registryFor = async (config: JsonObject, protectedPaths?: string[]): Promise<ToolRegistry> => {
  const tools = new ToolRegistry();
  await createFsPlugin(config).setup({
    bus: { emit: async () => undefined, subscribe: () => () => undefined } as never,
    tools,
    ...(protectedPaths !== undefined
      ? { protectedPaths: { all: async () => protectedPaths, exempt: async () => [] } }
      : {}),
  } as never);
  return tools;
};

const sessionAt = (agentId: string, trust: TrustLevel): Session => ({
  id: `session-${agentId}-${trust}`,
  agent: { id: agentId, name: agentId },
  status: 'running',
  messages: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  metadata: { [SESSION_TRUST_METADATA_KEY]: trust },
});

const marking = (): { context: ExecutionContext; marks: TrustLevel[] } => {
  const marks: TrustLevel[] = [];
  return { context: { markTrust: (trust) => marks.push(trust) }, marks };
};

const run = async (tools: ToolRegistry, name: string, input: JsonObject, session: Session, context?: ExecutionContext) =>
  (tools.get(name) as Tool).execute(input, session, context);

// Canonical from the start: on macOS the temp dir sits behind /var -> /private/var,
// and the ledger records canonical paths.
const home = async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'stratus-fs-move-')));
  const root = path.join(base, 'notes');
  const workspaceRoot = path.join(base, 'workspaces');
  await mkdir(root, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  return { base, root, workspaceRoot };
};

const readMarks = async (tools: ToolRegistry, file: string) => {
  const marks = marking();
  await run(tools, 'fs.read', { path: file }, sessionAt('ava', 'user'), marks.context);
  return marks.marks;
};

test('a labelled file keeps its label at the new path, and the old path is gone', async () => {
  const { root, workspaceRoot } = await home();
  const tools = await registryFor({ roots: [root], workspaceRoot });
  await run(tools, 'fs.write', { path: 'fetched.md', content: 'From a web page.' }, sessionAt('ava', 'external'));
  assert.deepEqual(await readMarks(tools, 'fetched.md'), ['external']);

  const moved = await run(tools, 'fs.move', { from: 'fetched.md', to: 'archive/fetched.md' }, sessionAt('ava', 'agent')) as JsonObject;
  assert.equal(moved.to, path.join('archive', 'fetched.md'));
  await assert.rejects(stat(path.join(root, 'fetched.md')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(root, 'archive', 'fetched.md'), 'utf8'), 'From a web page.');

  // A new plugin instance, so the label is the ledger file's and not anything in memory.
  const later = await registryFor({ roots: [root], workspaceRoot });
  assert.deepEqual(await readMarks(later, 'archive/fetched.md'), ['external']);
});

test('a directory move carries every nested label, and a label held by a parent directory', async () => {
  const { root, workspaceRoot } = await home();
  const tools = await registryFor({ roots: [root], workspaceRoot });
  await mkdir(path.join(root, 'project', 'deep'), { recursive: true });
  await run(tools, 'fs.write', { path: 'project/deep/a.md', content: 'a' }, sessionAt('ava', 'external'));
  await run(tools, 'fs.write', { path: 'project/b.md', content: 'b' }, sessionAt('ava', 'unknown'));
  await run(tools, 'fs.write', { path: 'project/own.md', content: 'mine' }, sessionAt('ava', 'agent'));
  // A file whose only label is its parent's: the parent was named by a tainted session.
  await run(tools, 'fs.write', { path: 'inbox/x/file.md', content: 'x' }, sessionAt('ava', 'external'));
  await writeFile(path.join(root, 'inbox', 'x', 'plain.md'), 'plain');

  await run(tools, 'fs.move', { from: 'project', to: 'done/project' }, sessionAt('ava', 'agent'));
  await run(tools, 'fs.move', { from: 'inbox/x/plain.md', to: 'plain.md' }, sessionAt('ava', 'agent'));

  const later = await registryFor({ roots: [root], workspaceRoot });
  assert.deepEqual(await readMarks(later, 'done/project/deep/a.md'), ['external']);
  assert.deepEqual(await readMarks(later, 'done/project/b.md'), ['unknown']);
  assert.deepEqual(await readMarks(later, 'done/project/own.md'), []);
  assert.deepEqual(await readMarks(later, 'plain.md'), ['external']);
});

test('an unrecorded file stays unrecorded when a clean session moves it', async () => {
  const { root, workspaceRoot } = await home();
  const tools = await registryFor({ roots: [root], workspaceRoot });
  await writeFile(path.join(root, 'mine.md'), 'mine');
  await run(tools, 'fs.move', { from: 'mine.md', to: 'renamed.md' }, sessionAt('ava', 'agent'));
  assert.deepEqual(await readMarks(tools, 'renamed.md'), []);
  await assert.rejects(stat(path.join(workspaceRoot, 'ava', LEDGER_FILENAME)), { code: 'ENOENT' });
});

test('a tainted session’s move labels the destination at the lower of the two labels', async () => {
  const { root, workspaceRoot } = await home();
  const tools = await registryFor({ roots: [root], workspaceRoot });
  await writeFile(path.join(root, 'mine.md'), 'mine');
  await run(tools, 'fs.write', { path: 'web.md', content: 'w' }, sessionAt('ava', 'external'));
  await run(tools, 'fs.move', { from: 'mine.md', to: 'chosen/name.md' }, sessionAt('ava', 'unknown'));
  await run(tools, 'fs.move', { from: 'web.md', to: 'web2.md' }, sessionAt('ava', 'unknown'));
  assert.deepEqual(await readMarks(tools, 'chosen/name.md'), ['unknown']);
  assert.deepEqual(await readMarks(tools, 'web2.md'), ['external']);
});

test('a move outside the roots, onto something existing, or of a symlink is refused and moves nothing', async () => {
  const { base, root, workspaceRoot } = await home();
  const outside = path.join(base, 'outside');
  await mkdir(outside);
  const tools = await registryFor({ roots: [root], workspaceRoot });
  await writeFile(path.join(root, 'a.md'), 'a');
  await writeFile(path.join(root, 'b.md'), 'b');
  await writeFile(path.join(outside, 'secret.md'), 's');
  await symlink(path.join(outside, 'secret.md'), path.join(root, 'link.md'));
  const session = sessionAt('ava', 'agent');

  await assert.rejects(run(tools, 'fs.move', { from: 'a.md', to: path.join(outside, 'a.md') }, session), /outside every root/);
  await assert.rejects(run(tools, 'fs.move', { from: path.join(outside, 'secret.md'), to: 'secret.md' }, session), /outside every root/);
  await assert.rejects(run(tools, 'fs.move', { from: 'a.md', to: 'b.md' }, session), /already exists/);
  await assert.rejects(run(tools, 'fs.move', { from: 'link.md', to: 'moved-link.md' }, session), /symlink/);
  await mkdir(path.join(root, 'dir'));
  await assert.rejects(run(tools, 'fs.move', { from: 'dir', to: 'dir/inner' }, session), /into itself/);

  assert.equal(await readFile(path.join(root, 'a.md'), 'utf8'), 'a');
  assert.equal(await readFile(path.join(root, 'b.md'), 'utf8'), 'b');
  assert.equal(await readFile(path.join(outside, 'secret.md'), 'utf8'), 's');
});

test('the ledger, a directory holding it, and protected paths cannot be moved', async () => {
  const { root } = await home();
  // A root that covers the agent's workspace, the way an operator's broad root can.
  const workspaceRoot = path.join(root, 'workspaces');
  await mkdir(workspaceRoot);
  const guarded = path.join(root, 'guarded');
  await mkdir(guarded);
  await writeFile(path.join(guarded, 'keys.json'), '{}');
  const tools = await registryFor({ roots: [root], workspaceRoot }, [guarded]);
  await run(tools, 'fs.write', { path: 'web.md', content: 'w' }, sessionAt('ava', 'external'));
  const ledger = path.join(workspaceRoot, 'ava', LEDGER_FILENAME);
  await stat(ledger);
  const session = sessionAt('ava', 'agent');

  await assert.rejects(run(tools, 'fs.move', { from: ledger, to: 'ledger-copy.jsonl' }, session), /provenance ledger/);
  await assert.rejects(run(tools, 'fs.move', { from: path.join(workspaceRoot, 'ava'), to: 'elsewhere' }, session), /provenance ledger/);
  await assert.rejects(run(tools, 'fs.move', { from: 'workspaces', to: 'elsewhere' }, session), /provenance ledger/);
  await assert.rejects(run(tools, 'fs.move', { from: 'guarded/keys.json', to: 'keys.json' }, session), /keeps from every agent/);
  await assert.rejects(run(tools, 'fs.move', { from: 'web.md', to: 'guarded/web.md' }, session), /keeps from every agent/);
  await assert.rejects(run(tools, 'fs.move', { from: 'guarded', to: 'unguarded' }, session), /keeps from every agent/);
  await stat(ledger);
});

test('a label recorded at the old path while the move runs is carried too', async () => {
  const { root, workspaceRoot } = await home();
  const forAgent = (agentId: string) => path.join(workspaceRoot, agentId);
  // A second process (a `stratus run`) records a tainted write under the old
  // path after this move took its first look at the ledger. The host's
  // workspace listing is asked once for the first guard check and again for
  // the re-check just before the rename, so the second ask is where it lands.
  const peer = createFileLedger(forAgent, forAgent);
  const original = path.join(root, 'dir', 'late.md');
  let asked = 0;
  const workspaces = {
    forAgent,
    prepare: (agentId: string) => forAgent(agentId),
    all: async () => {
      asked += 1;
      if (asked === 2) {
        await mkdir(forAgent('ava'), { recursive: true });
        await peer.recordWrite('ava', original, 'external');
      }
      return [forAgent('ava')];
    },
  };
  const tools = new ToolRegistry();
  await createFsPlugin({ roots: [root] }).setup({
    bus: { emit: async () => undefined, subscribe: () => () => undefined } as never,
    tools,
    workspaces,
  } as never);
  await mkdir(path.join(root, 'dir'));
  await writeFile(original, 'late');

  await run(tools, 'fs.move', { from: 'dir', to: 'moved' }, sessionAt('ava', 'agent'));
  assert.equal(asked, 2);
  const marks = marking();
  await run(tools, 'fs.read', { path: 'moved/late.md' }, sessionAt('ava', 'user'), marks.context);
  assert.deepEqual(marks.marks, ['external']);
});

test('a directory with many labelled files is carried in one ledger append', async () => {
  const { root, workspaceRoot } = await home();
  const tools = await registryFor({ roots: [root], workspaceRoot });
  const count = 200;
  for (let index = 0; index < count; index += 1) {
    await run(tools, 'fs.write', { path: `tree/f${index}.md`, content: 'fetched' }, sessionAt('ava', 'external'));
  }
  const ledgerFile = path.join(workspaceRoot, 'ava', LEDGER_FILENAME);
  const linesBefore = (await readFile(ledgerFile, 'utf8')).trim().split('\n').length;

  const moved = await run(tools, 'fs.move', { from: 'tree', to: 'archive/tree' }, sessionAt('ava', 'agent')) as JsonObject;
  assert.equal(moved.labelsCarried, count + 1);
  const lines = (await readFile(ledgerFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { path: string; at: string });
  const added = lines.slice(linesBefore);
  assert.equal(added.length, count + 1);
  // One batch: every carried record shares the append's timestamp.
  assert.equal(new Set(added.map((line) => line.at)).size, 1);
  assert.deepEqual(await readMarks(tools, 'archive/tree/f199.md'), ['external']);
});

test('the file ledger batch records only tainted paths that change', async () => {
  const { workspaceRoot } = await home();
  const ledger = createFileLedger((agentId) => path.join(workspaceRoot, agentId));
  await ledger.recordWrite('ava', '/x/a', 'unknown');
  await ledger.recordWrites!('ava', [['/x/a', 'unknown'], ['/x/b', 'agent'], ['/x/c', 'unknown'], ['/x/a', 'external']]);
  const lines = (await readFile(path.join(workspaceRoot, 'ava', LEDGER_FILENAME), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 3);
  assert.deepEqual(await ledger.snapshot('ava'), { '/x/a': 'external', '/x/c': 'unknown' });
});

test('a batch larger than one ledger write lands as whole records', async () => {
  const { workspaceRoot } = await home();
  const ledger = createFileLedger((agentId) => path.join(workspaceRoot, agentId));
  const entries = Array.from({ length: 1500 }, (_, index) => [`/x/${'d'.repeat(100)}/${index}`, 'external'] as const);
  await ledger.recordWrites!('ava', entries);
  const lines = (await readFile(path.join(workspaceRoot, 'ava', LEDGER_FILENAME), 'utf8')).trim().split('\n');
  assert.ok(lines.join('\n').length > 128 * 1024);
  assert.equal(lines.length, 1500);
  assert.equal(Object.keys(await ledger.snapshot('ava')).length, 1500);
});
