import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
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

test('a call may narrow the read and match caps, never raise them', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-fs-cap-'));
  await writeFile(path.join(root, 'long.txt'), 'needle\n'.repeat(1_000));

  const tools = await registryFor({ roots: [root], maxBytes: 100, maxMatches: 5 });
  const session = sessionFor('ava');

  const lifted = await run(tools, 'fs.read', { path: 'long.txt', maxBytes: 1_000_000 }, session) as JsonObject;
  assert.equal(String(lifted.content).length, 100, 'a bigger maxBytes does not lift the cap');
  assert.equal(lifted.truncated, true);
  const narrowed = await run(tools, 'fs.read', { path: 'long.txt', maxBytes: 10 }, session) as JsonObject;
  assert.equal(String(narrowed.content).length, 10, 'a smaller one narrows it');

  const matches = await run(tools, 'fs.search', { query: 'needle', maxMatches: 500 }, session) as JsonObject;
  assert.equal((matches.matches as unknown[]).length, 5);
  assert.equal(matches.truncated, true);
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

test('searching one file searches that file, not its neighbours', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-fs-scope-'));
  await mkdir(path.join(root, 'notes'), { recursive: true });
  await writeFile(path.join(root, 'notes', 'today.md'), 'kettle in the cupboard\n');
  await writeFile(path.join(root, 'notes', 'private.md'), 'kettle, and a password\n');

  const tools = await registryFor({ roots: [root] });
  const session = sessionFor('ava');

  const scoped = await run(tools, 'fs.search', { query: 'kettle', path: 'notes/today.md' }, session) as JsonObject;
  assert.deepEqual(
    (scoped.matches as Array<{ path: string }>).map((match) => match.path),
    [path.join('notes', 'today.md')],
  );

  // The directory form still walks, so scoping a file is a narrowing rather
  // than a lost capability.
  const wide = await run(tools, 'fs.search', { query: 'kettle', path: 'notes' }, session) as JsonObject;
  assert.equal((wide.matches as unknown[]).length, 2);
});

test('a large file named outright is searched, and one a walk skips is named in the result', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-fs-large-'));
  await mkdir(path.join(root, 'logs'), { recursive: true });
  // Over the walk limit, in lines the line limit leaves whole, with the
  // only needle on the last one.
  await writeFile(path.join(root, 'logs', 'big.log'), `${'x'.repeat(600_000)}\n${'y'.repeat(600_000)}\nneedle at the end\n`);
  await writeFile(path.join(root, 'logs', 'small.log'), 'nothing here\n');

  const tools = await registryFor({ roots: [root] });
  const session = sessionFor('ava');

  const named = await run(tools, 'fs.search', { query: 'needle', path: 'logs/big.log' }, session) as JsonObject;
  assert.deepEqual(
    (named.matches as Array<{ path: string; line: number }>).map((match) => [match.path, match.line]),
    [[path.join('logs', 'big.log'), 3]],
  );
  assert.equal(named.skipped, undefined);

  const walked = await run(tools, 'fs.search', { query: 'needle', path: 'logs' }, session) as JsonObject;
  assert.deepEqual(walked.matches, []);
  const skipped = walked.skipped as Array<{ path: string; bytes: number; reason: string }>;
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0]!.path, path.join('logs', 'big.log'));
  assert.match(skipped[0]!.reason, /over the 1 MB walk limit/);
});

test('a named file that is one enormous line is searched in bounded memory, and the result says where it stopped', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-fs-line-'));
  // 3 million characters, no newline: a needle inside the first million and
  // another beyond it.
  await writeFile(path.join(root, 'minified.js'), `${'a'.repeat(500_000)}early${'b'.repeat(1_500_000)}late${'c'.repeat(1_000_000)}`);
  const tools = await registryFor({ roots: [root] });
  const session = sessionFor('ava');

  const early = await run(tools, 'fs.search', { query: 'early', path: 'minified.js' }, session) as JsonObject;
  assert.equal((early.matches as unknown[]).length, 1);
  assert.match(String((early.skipped as Array<{ reason: string }>)[0]?.reason), /longer than 1 million characters/);
  const late = await run(tools, 'fs.search', { query: 'late', path: 'minified.js' }, session) as JsonObject;
  assert.deepEqual(late.matches, [], 'past the first million characters of a line, nothing is searched');
  assert.equal(late.skippedTotal, 1);
});

test('a line of exactly the limit was searched whole, and the result does not say otherwise', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-fs-exact-'));
  const needle = 'needle';
  await writeFile(path.join(root, 'exact.txt'), `${'a'.repeat(1_000_000 - needle.length)}${needle}\nsecond line\n`);
  await writeFile(path.join(root, 'over.txt'), `${'a'.repeat(1_000_001)}\n`);
  const tools = await registryFor({ roots: [root] });
  const session = sessionFor('ava');

  const exact = await run(tools, 'fs.search', { query: needle, path: 'exact.txt' }, session) as JsonObject;
  assert.equal((exact.matches as unknown[]).length, 1);
  assert.equal(exact.skipped, undefined, 'nothing of this line went unsearched');

  const over = await run(tools, 'fs.search', { query: needle, path: 'over.txt' }, session) as JsonObject;
  assert.equal(over.skippedTotal, 1);

  // Characters, not UTF-16 code units: 600,000 emoji are 1.2 million
  // units and 600,000 characters, and the needle after them is found.
  await writeFile(path.join(root, 'emoji.txt'), `${'😀'.repeat(600_000)}${needle}\n`);
  const astral = await run(tools, 'fs.search', { query: needle, path: 'emoji.txt' }, session) as JsonObject;
  assert.equal((astral.matches as unknown[]).length, 1, 'a line of 600,000 characters is within the limit');
  assert.equal(astral.skipped, undefined);
});

test('a named file that turns binary after its first pages is reported as binary, with nothing matched', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-fs-latebinary-'));
  // Text for well past the first 8 KB — a needle in it — and then a NUL.
  await writeFile(
    path.join(root, 'mixed.bin'),
    Buffer.concat([Buffer.from(`needle here\n${'plain text\n'.repeat(4_000)}`), Buffer.from([0, 1, 2, 3])]),
  );
  const tools = await registryFor({ roots: [root] });
  const result = await run(tools, 'fs.search', { query: 'needle', path: 'mixed.bin' }, sessionFor('ava')) as JsonObject;
  assert.deepEqual(result.matches, [], 'a match in the text before the NUL is not a result of a text file');
  const skipped = result.skipped as Array<{ path: string; bytes: number; reason: string }>;
  assert.equal(skipped[0]?.reason, 'binary');
  assert.equal(skipped[0]?.bytes, 11 + 11 * 4_000 + 1 + 4);

  // The match cap does not end the reading either: a NUL after more
  // matches than the cap allows still makes the file binary.
  await writeFile(
    path.join(root, 'capped.bin'),
    Buffer.concat([Buffer.from('needle\n'.repeat(5)), Buffer.from('plain text\n'.repeat(10_000)), Buffer.from([0])]),
  );
  const capped = await run(tools, 'fs.search', { query: 'needle', path: 'capped.bin', maxMatches: 2 }, sessionFor('ava')) as JsonObject;
  assert.deepEqual(capped.matches, []);
  assert.equal(capped.truncated, false);
  assert.equal((capped.skipped as Array<{ reason: string }>)[0]?.reason, 'binary');
});

test('a virtual file that reports no size is still read when named', { skip: !existsSync('/proc/version') }, async () => {
  // procfs says `size: 0` for files that have content; the size that bounds
  // the stream must not be taken as proof there is nothing to read.
  const tools = await registryFor({ roots: ['/proc'] });
  const result = await run(tools, 'fs.search', { query: 'Linux', path: 'version' }, sessionFor('ava')) as JsonObject;
  assert.equal((result.matches as unknown[]).length, 1, '/proc/version names the kernel');
});

test('a virtual file that reports no size is read up to the walk limit, and the result says so', { skip: !existsSync('/proc/kallsyms') }, async (t) => {
  // procfs again, this time a file whose content runs to megabytes while
  // its size stays zero: the cap that stands in for a size stops the read.
  let bytes = 0;
  try {
    bytes = (await readFile('/proc/kallsyms')).length;
  } catch {
    bytes = 0;
  }
  if (bytes <= 1_000_000) {
    t.skip('/proc/kallsyms is not over the cap here');
    return;
  }
  const tools = await registryFor({ roots: ['/proc'] });
  const result = await run(tools, 'fs.search', { query: 'no such symbol name', path: 'kallsyms' }, sessionFor('ava')) as JsonObject;
  assert.deepEqual(result.matches, []);
  const skipped = result.skipped as Array<{ bytes: number; reason: string }>;
  assert.match(skipped[0]?.reason ?? '', /reports no size, and was searched in its first 1 MB only/);
  assert.equal(skipped[0]?.bytes, 0);
});

test('a file whose size the cap exactly matches is not reported as clipped', async () => {
  // The unsized path reads one byte past the cap to know there was more.
  // A regular file of exactly the cap is bounded by its own size, so this
  // covers the arithmetic the unsized path shares with it: read to the end
  // and report nothing skipped.
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-fs-exactcap-'));
  const needle = 'needle';
  await writeFile(path.join(root, 'atcap.txt'), `${'a'.repeat(1_000_000 - needle.length - 1)}${needle}\n`);
  const tools = await registryFor({ roots: [root] });
  const result = await run(tools, 'fs.search', { query: needle, path: 'atcap.txt' }, sessionFor('ava')) as JsonObject;
  assert.equal((result.matches as unknown[]).length, 1);
  assert.equal(result.skipped, undefined, 'a file read to its end reports nothing skipped');
});

test('a whole-word match at a clipped line\'s edge is judged by the file, not by where the search stopped', async () => {
  // The line is cut at a million characters. A query ending exactly there
  // looks like a whole word if you only read what was kept — the file says
  // otherwise, and the code point that came next is what settles it.
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-fs-wordedge-'));
  const needle = 'needle';
  const lead = 'a '.repeat((1_000_000 - needle.length) / 2);
  await writeFile(path.join(root, 'cut.txt'), `${lead}${needle}xtra and more past the cut\n`);
  await writeFile(path.join(root, 'whole.txt'), `${lead}${needle} and more past the cut\n`);
  const tools = await registryFor({ roots: [root] });
  const session = sessionFor('ava');

  const cut = await run(tools, 'fs.search', { query: needle, path: 'cut.txt', wholeWord: true }, session) as JsonObject;
  assert.deepEqual(cut.matches, [], 'the word runs on past the cut, so it is not a whole word');

  const whole = await run(tools, 'fs.search', { query: needle, path: 'whole.txt', wholeWord: true }, session) as JsonObject;
  assert.equal((whole.matches as unknown[]).length, 1, 'a word that really ends at the cut still matches');
});

test('the skipped list is capped, and the count says how many there were', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-fs-skipmany-'));
  const big = 'x'.repeat(1_000_001);
  for (let i = 0; i < 60; i += 1) {
    await writeFile(path.join(root, `big-${i}.log`), big);
  }
  const tools = await registryFor({ roots: [root] });
  const walked = await run(tools, 'fs.search', { query: 'needle' }, sessionFor('ava')) as JsonObject;
  assert.equal((walked.skipped as unknown[]).length, 50);
  assert.equal(walked.skippedTotal, 60);
});

test('a search pattern is literal text, so no query can stall the process', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-fs-redos-'));
  await writeFile(path.join(root, 'notes.md'), `a(b)c ${'a'.repeat(4_000)}\n`);
  const tools = await registryFor({ roots: [root] });
  const session = sessionFor('ava');

  // Regex metacharacters are matched as themselves rather than compiled.
  const literal = await run(tools, 'fs.search', { query: 'a(b)c' }, session) as JsonObject;
  assert.equal((literal.matches as unknown[]).length, 1);

  // The pattern that would have hung the daemon: catastrophic backtracking
  // on the long line above, on the only thread there is, with no way to
  // interrupt it. As literal text it simply matches nothing.
  const hostile = await run(tools, 'fs.search', { query: '(a+)+$' }, session) as JsonObject;
  assert.deepEqual(hostile.matches, []);

  // And the case the expressive form was mostly wanted for is still here.
  await writeFile(path.join(root, 'words.md'), 'cupboard\ncup\n');
  const words = await run(tools, 'fs.search', { query: 'cup', wholeWord: true, path: 'words.md' }, session) as JsonObject;
  assert.deepEqual((words.matches as Array<{ text: string }>).map((match) => match.text), ['cup']);
});

test('searching a fifo is refused rather than waited on', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-fs-search-fifo-'));
  const fifo = path.join(root, 'pipe');
  await new Promise<void>((resolve, reject) => {
    execFile('mkfifo', [fifo], (error) => (error ? reject(error) : resolve()));
  });
  await writeFile(path.join(root, 'notes.md'), 'kettle\n');

  const tools = await registryFor({ roots: [root] });
  const session = sessionFor('ava');

  // The same trap `fs.read` has, one tool over: `readFile` on a fifo with
  // no writer waits, and `fs.search` is `safe` — so it waits unattended.
  const outcome = await Promise.race([
    run(tools, 'fs.search', { query: 'kettle', path: 'pipe' }, session).then(
      () => 'searched the pipe',
      (error: Error) => error.message,
    ),
    new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve('blocked'), 5_000);
      timer.unref?.();
    }),
  ]);
  assert.notEqual(outcome, 'blocked', 'fs.search blocked on a fifo instead of refusing it');
  assert.match(outcome, /is not a regular file/);

  // Walking a directory that contains one is unaffected: a fifo is never a
  // directory entry the walk yields.
  const walked = await run(tools, 'fs.search', { query: 'kettle' }, session) as JsonObject;
  assert.equal((walked.matches as unknown[]).length, 1);
});
