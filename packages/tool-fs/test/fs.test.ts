import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  AgentRunner,
  InMemorySessionStore,
  ToolRegistry,
  type JsonObject,
  type ModelProvider,
  type Session,
  type Tool,
} from '@stratusagent/core';

import { createFsPlugin } from '../src/index.ts';

const registryFor = async (config: JsonObject): Promise<ToolRegistry> => {
  const tools = new ToolRegistry();
  await createFsPlugin(config).setup({ bus: { emit: async () => undefined, subscribe: () => () => undefined } as never, tools });
  return tools;
};

const sessionFor = (agentId: string, tools?: string[]): Session => ({
  id: `session-${agentId}`,
  agent: { id: agentId, name: agentId, ...(tools ? { tools } : {}) },
  status: 'running',
  messages: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const run = async (tools: ToolRegistry, name: string, input: JsonObject, session: Session) => {
  const tool = tools.get(name) as Tool;
  return tool.execute(input, session);
};

test('an agent reads and searches inside its root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-fs-'));
  await writeFile(path.join(root, 'notes.md'), 'the kettle is in the cupboard\nand the tea is not\n');
  await mkdir(path.join(root, 'sub'), { recursive: true });
  await writeFile(path.join(root, 'sub', 'deep.md'), 'kettle again\n');

  const tools = await registryFor({ roots: [root] });
  const session = sessionFor('ava');

  const read = await run(tools, 'fs.read', { path: 'notes.md' }, session) as JsonObject;
  assert.match(String(read.content), /kettle is in the cupboard/);
  assert.equal(read.truncated, false);

  const listed = await run(tools, 'fs.list', {}, session) as JsonObject;
  assert.deepEqual(
    (listed.entries as Array<{ name: string }>).map((entry) => entry.name).sort(),
    ['notes.md', 'sub'],
  );

  const found = await run(tools, 'fs.search', { query: 'kettle' }, session) as JsonObject;
  assert.deepEqual(
    (found.matches as Array<{ path: string }>).map((match) => match.path).sort(),
    ['notes.md', path.join('sub', 'deep.md')],
  );
});

test('two agents with different roots cannot read each other’s files', async () => {
  const ava = await mkdtemp(path.join(os.tmpdir(), 'stratus-fs-ava-'));
  const juno = await mkdtemp(path.join(os.tmpdir(), 'stratus-fs-juno-'));
  await writeFile(path.join(ava, 'diary.md'), 'ava’s diary');
  await writeFile(path.join(juno, 'diary.md'), 'juno’s diary');

  // One plugin instance, one config, two agents — which is exactly the
  // arrangement a plugin that resolved its roots at setup would get wrong.
  const tools = await registryFor({
    roots: [],
    agents: { ava: { roots: [ava] }, juno: { roots: [juno] } },
  });

  const asAva = await run(tools, 'fs.read', { path: 'diary.md' }, sessionFor('ava')) as JsonObject;
  assert.equal(asAva.content, 'ava’s diary');
  const asJuno = await run(tools, 'fs.read', { path: 'diary.md' }, sessionFor('juno')) as JsonObject;
  assert.equal(asJuno.content, 'juno’s diary');

  // The same call, by absolute path, into the other agent's root.
  await assert.rejects(
    () => run(tools, 'fs.read', { path: path.join(juno, 'diary.md') }, sessionFor('ava')),
    /outside every root this agent may reach/,
  );

  // An agent with no entry and no defaults has no filesystem at all,
  // rather than inheriting whichever roots were configured for someone else.
  await assert.rejects(
    () => run(tools, 'fs.read', { path: 'diary.md' }, sessionFor('rex')),
    /No filesystem roots are configured/,
  );
});

test('a symlink out of the root is neither readable nor writable, parent case included', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-fs-root-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'stratus-fs-outside-'));
  await writeFile(path.join(outside, 'credentials.json'), '{"anthropic":{"value":"sk-ant-secret"}}');

  // The two shapes: a link to a file, and a link to a directory that a
  // write can then reach *through*.
  await symlink(path.join(outside, 'credentials.json'), path.join(root, 'creds.json'));
  await symlink(outside, path.join(root, 'elsewhere'));

  const tools = await registryFor({ roots: [root] });
  const session = sessionFor('ava');

  await assert.rejects(
    () => run(tools, 'fs.read', { path: 'creds.json' }, session),
    /outside every root this agent may reach/,
  );
  await assert.rejects(
    () => run(tools, 'fs.read', { path: 'elsewhere/credentials.json' }, session),
    /outside every root/,
  );
  // Writing *through* the link: the string never leaves the root, and the
  // parent it would land in is another directory entirely.
  await assert.rejects(
    () => run(tools, 'fs.write', { path: 'elsewhere/planted.txt', content: 'x' }, session),
    /outside every root/,
  );
  // And writing *to* the link, which would follow it to the target.
  await assert.rejects(
    () => run(tools, 'fs.write', { path: 'creds.json', content: 'overwritten' }, session),
    /outside every root/,
  );
  // A lexical escape is refused too, though it is the easy half.
  await assert.rejects(
    () => run(tools, 'fs.read', { path: '../outside/credentials.json' }, session),
    /outside every root|No such file/,
  );

  // The file is still what it was.
  const written = await run(
    tools,
    'fs.read',
    { path: path.join(root, 'creds.json') },
    session,
  ).catch((error: Error) => error.message);
  assert.match(String(written), /outside every root/);
});

test('a write lands inside the root, creating its parents there', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-fs-write-'));
  const tools = await registryFor({ roots: [root] });
  const session = sessionFor('ava');

  const written = await run(tools, 'fs.write', { path: 'reports/june.md', content: 'done' }, session) as JsonObject;
  assert.equal(written.path, path.join('reports', 'june.md'));
  const read = await run(tools, 'fs.read', { path: 'reports/june.md' }, session) as JsonObject;
  assert.equal(read.content, 'done');

  const appended = await run(tools, 'fs.write', { path: 'reports/june.md', content: '!', append: true }, session) as JsonObject;
  assert.equal(appended.appended, true);
  assert.equal(((await run(tools, 'fs.read', { path: 'reports/june.md' }, session)) as JsonObject).content, 'done!');
});

test('a long file is truncated with the marker, and a binary one is not returned at all', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-fs-big-'));
  await writeFile(path.join(root, 'long.txt'), 'a'.repeat(5_000));
  await writeFile(path.join(root, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));

  const tools = await registryFor({ roots: [root], maxBytes: 100 });
  const session = sessionFor('ava');

  const long = await run(tools, 'fs.read', { path: 'long.txt' }, session) as JsonObject;
  assert.equal(long.truncated, true);
  assert.equal(String(long.content).length, 100);
  assert.equal(long.size, 5_000);

  const binary = await run(tools, 'fs.read', { path: 'image.png' }, session) as JsonObject;
  assert.equal(binary.binary, true);
  assert.equal(binary.content, undefined);
});

test('an agent allowed only reads cannot write, whatever the tool would have done', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-fs-allow-'));
  await writeFile(path.join(root, 'notes.md'), 'read me');
  const tools = await registryFor({ roots: [root] });

  let turn = 0;
  const provider: ModelProvider = {
    name: 'scripted',
    async generate() {
      turn += 1;
      if (turn === 1) {
        return { parts: [{ type: 'tool-call', call: { id: 'c1', toolName: 'fs.read', input: { path: 'notes.md' } } }] };
      }
      if (turn === 2) {
        return {
          parts: [{
            type: 'tool-call',
            call: { id: 'c2', toolName: 'fs.write', input: { path: 'notes.md', content: 'no' } },
          }],
        };
      }
      return { parts: [{ type: 'text', text: 'done' }] };
    },
  };

  const runner = new AgentRunner({ provider, tools, store: new InMemorySessionStore() });
  await runner.initialize();
  const session = await runner.run({
    sessionId: 'fs-allowlist',
    agent: { id: 'reader', name: 'Reader', tools: ['fs.read', 'fs.search'] },
    userMessage: 'what is in notes.md?',
  });

  const results = session.messages.filter((message) => message.role === 'tool');
  assert.equal(results[0]?.toolResult?.ok, true);
  assert.equal(results[1]?.toolResult?.ok, false);
  assert.match(results[1]?.toolResult?.error ?? '', /not permitted for agent reader: fs\.write/);
  // The file is unchanged, because the gate is before execution.
  const still = await run(tools, 'fs.read', { path: 'notes.md' }, sessionFor('reader')) as JsonObject;
  assert.equal(still.content, 'read me');
});

test('every tool this plugin registers is one its manifest declares', async () => {
  const manifest = (await import('../package.json', { with: { type: 'json' } })).default as {
    stratus: { contributes: { tools: Array<{ name: string; risk: string }> } };
  };
  const tools = await registryFor({ roots: [] });
  const declared = new Map(manifest.stratus.contributes.tools.map((entry) => [entry.name, entry.risk]));

  for (const tool of tools.list()) {
    assert.equal(declared.has(tool.name), true, `${tool.name} is registered but undeclared`);
    assert.equal(declared.get(tool.name), tool.risk, `${tool.name} risk disagrees with the manifest`);
  }
  assert.equal(tools.list().length, declared.size);
});

test('a fifo inside a root is refused rather than opened', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-fs-fifo-'));
  const fifo = path.join(root, 'pipe');
  // A named pipe with no writer: `open` on one blocks rather than failing,
  // so a tool that did not check would hang the turn forever.
  await new Promise<void>((resolve, reject) => {
    execFile('mkfifo', [fifo], (error) => (error ? reject(error) : resolve()));
  });

  const tools = await registryFor({ roots: [root] });
  // Given a way to lose: without the check this call never settles, and a
  // suite with no timeout would hang rather than report the regression.
  const outcome = await Promise.race([
    run(tools, 'fs.read', { path: 'pipe' }, sessionFor('ava')).then(
      () => 'read the pipe',
      (error: Error) => error.message,
    ),
    new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve('blocked'), 5_000);
      timer.unref?.();
    }),
  ]);

  assert.notEqual(outcome, 'blocked', 'fs.read blocked on a fifo instead of refusing it');
  assert.match(outcome, /is not a regular file/);
});
