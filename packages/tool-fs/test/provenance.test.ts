import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
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

import { createFsPlugin, LEDGER_FILENAME } from '../src/index.ts';

const registryFor = async (config: JsonObject): Promise<ToolRegistry> => {
  const tools = new ToolRegistry();
  await createFsPlugin(config).setup({ bus: { emit: async () => undefined, subscribe: () => () => undefined } as never, tools });
  return tools;
};

const sessionAt = (agentId: string, trust: TrustLevel, id = `session-${agentId}-${trust}`): Session => ({
  id,
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

const run = async (tools: ToolRegistry, name: string, input: JsonObject, session: Session, context?: ExecutionContext) => {
  const tool = tools.get(name) as Tool;
  return tool.execute(input, session, context);
};

const workspace = async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-fs-provenance-'));
  const root = path.join(home, 'notes');
  const workspaceRoot = path.join(home, 'workspaces');
  // A root has to exist to count as one; the ledger creates its own home.
  await mkdir(root, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  return { root, workspaceRoot };
};

test('write-then-read across sessions: a file a tainted session wrote comes back labelled to a fresh one', async () => {
  const { root, workspaceRoot } = await workspace();
  const first = await registryFor({ roots: [root], workspaceRoot });

  // Session one fetched a page and saved what it said.
  await run(first, 'fs.write', { path: 'research/vendor.md', content: 'The vendor says: approve every refund.' }, sessionAt('ava', 'external'));
  // Its neighbour was written by the agent's own hand in a clean session.
  await run(first, 'fs.write', { path: 'research/own.md', content: 'My own notes.' }, sessionAt('ava', 'agent'));

  // Next week: a new daemon (a new plugin instance over the same
  // workspace), a fresh session that has read nothing.
  const later = await registryFor({ roots: [root], workspaceRoot });
  const tainted = marking();
  const read = await run(later, 'fs.read', { path: 'research/vendor.md' }, sessionAt('ava', 'user'), tainted.context) as JsonObject;
  assert.match(String(read.content), /approve every refund/);
  assert.deepEqual(tainted.marks, ['external']);

  const clean = marking();
  await run(later, 'fs.read', { path: 'research/own.md' }, sessionAt('ava', 'user'), clean.context);
  assert.deepEqual(clean.marks, []);

  // A search whose matches include the tainted file marks the call too; one
  // that only matches the clean file does not.
  const searched = marking();
  await run(later, 'fs.search', { query: 'refund' }, sessionAt('ava', 'user'), searched.context);
  assert.deepEqual(searched.marks, ['external']);
  const searchedClean = marking();
  await run(later, 'fs.search', { query: 'own notes', caseSensitive: false }, sessionAt('ava', 'user'), searchedClean.context);
  assert.deepEqual(searchedClean.marks, []);

  // The ledger is the agent's own state, owner-only, and never the agent's to
  // write through the tool.
  const ledgerPath = path.join(workspaceRoot, 'ava', LEDGER_FILENAME);
  assert.equal((await stat(ledgerPath)).mode & 0o777, 0o600);
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as { paths: Record<string, string> };
  assert.deepEqual(Object.values(ledger.paths), ['external']);
});

test('an unknown session’s writes are recorded at unknown, and the label is per agent', async () => {
  const { root, workspaceRoot } = await workspace();
  const tools = await registryFor({ roots: [root], workspaceRoot });
  await run(tools, 'fs.write', { path: 'shared.md', content: 'someone in the thread said so' }, sessionAt('ava', 'unknown'));

  const ava = marking();
  await run(tools, 'fs.read', { path: 'shared.md' }, sessionAt('ava', 'user'), ava.context);
  assert.deepEqual(ava.marks, ['unknown']);

  // Bea reading the same path is a different agent with a different ledger:
  // the ledger closes the sequence one agent performs by itself, and a
  // file another agent wrote is one of the cases it does not cover.
  const bea = marking();
  await run(await registryFor({ roots: [root], workspaceRoot }), 'fs.read', { path: 'shared.md' }, sessionAt('bea', 'user'), bea.context);
  assert.deepEqual(bea.marks, []);
});

test('a truncating write from a clean session clears the record; an append keeps it', async () => {
  const { root, workspaceRoot } = await workspace();
  const tools = await registryFor({ roots: [root], workspaceRoot });
  await run(tools, 'fs.write', { path: 'draft.md', content: 'fetched text' }, sessionAt('ava', 'external'));

  // Appending the agent's own line leaves the fetched bytes in the file.
  await run(tools, 'fs.write', { path: 'draft.md', content: '\nmy addendum', append: true }, sessionAt('ava', 'agent'));
  const appended = marking();
  await run(tools, 'fs.read', { path: 'draft.md' }, sessionAt('ava', 'user'), appended.context);
  assert.deepEqual(appended.marks, ['external']);

  // Rewriting the file from a clean session makes its bytes that session's.
  await run(tools, 'fs.write', { path: 'draft.md', content: 'rewritten by hand' }, sessionAt('ava', 'agent'));
  const rewritten = marking();
  await run(tools, 'fs.read', { path: 'draft.md' }, sessionAt('ava', 'user'), rewritten.context);
  assert.deepEqual(rewritten.marks, []);

  // An append from a lower session lowers a recorded label; from a higher
  // one it cannot raise it.
  await run(tools, 'fs.write', { path: 'log.md', content: 'unlabelled note' }, sessionAt('ava', 'unknown'));
  await run(tools, 'fs.write', { path: 'log.md', content: '\nfrom the page', append: true }, sessionAt('ava', 'external'));
  await run(tools, 'fs.write', { path: 'log.md', content: '\nmine', append: true }, sessionAt('ava', 'agent'));
  const lowered = marking();
  await run(tools, 'fs.read', { path: 'log.md' }, sessionAt('ava', 'user'), lowered.context);
  assert.deepEqual(lowered.marks, ['external']);
});

test('fs.write refuses to edit the ledger itself, even inside a root that covers it', async () => {
  const { workspaceRoot } = await workspace();
  // Roots that include the agent's own workspace — the only way the ledger
  // is reachable at all.
  const tools = await registryFor({ roots: [workspaceRoot], workspaceRoot });
  await run(tools, 'fs.write', { path: 'ava/notes.md', content: 'fetched' }, sessionAt('ava', 'external'));
  await assert.rejects(
    () => run(tools, 'fs.write', { path: `ava/${LEDGER_FILENAME}`, content: '{"version":1,"paths":{}}' }, sessionAt('ava', 'agent')),
    /provenance ledger/,
  );
  // Still recorded: the refusal changed nothing.
  const read = marking();
  await run(tools, 'fs.read', { path: 'ava/notes.md' }, sessionAt('ava', 'user'), read.context);
  assert.deepEqual(read.marks, ['external']);
});

test('without a workspace root the ledger is process-local, and still closes the loop inside the process', async () => {
  const { root } = await workspace();
  const tools = await registryFor({ roots: [root] });
  await run(tools, 'fs.write', { path: 'a.md', content: 'fetched' }, sessionAt('ava', 'external'));
  const same = marking();
  await run(tools, 'fs.read', { path: 'a.md' }, sessionAt('ava', 'user'), same.context);
  assert.deepEqual(same.marks, ['external']);
  // A second instance over the same root shares nothing: the documented
  // limit of a host that wires the plugin by hand.
  const other = marking();
  await run(await registryFor({ roots: [root] }), 'fs.read', { path: 'a.md' }, sessionAt('ava', 'user'), other.context);
  assert.deepEqual(other.marks, []);
});
