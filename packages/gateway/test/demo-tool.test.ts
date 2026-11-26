import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createGateway } from '../src/index.ts';

// demo.echo is there for the offline demo provider, which calls it to show
// a tool round trip. The daemon still registers and lists it, but only an
// agent running on the demo provider is given it.

const newHome = async (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'stratus-gw-demo-tool-'));

const writeSoul = async (home: string, file: string, contents: string): Promise<void> => {
  const dir = path.join(home, '.stratus', 'agents');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, file), contents);
};

const openAi = (message: Record<string, unknown>): Response =>
  new Response(
    JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', ...message } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const toolNamesOf = (body: string): string[] =>
  ((JSON.parse(body) as { tools?: Array<{ function?: { name?: string } }> }).tools ?? [])
    .map((tool) => tool.function?.name ?? '');

test('an agent on a real provider is not offered demo.echo, and one on the demo provider still runs it', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\n---\n\nYou are Ava.\n');
  await writeSoul(home, 'dee.md', '---\nname: Dee\nprovider: demo\n---\n\nYou are Dee.\n');
  const bodies: string[] = [];
  const gateway = createGateway({
    env: {
      homeDir: home,
      cwd: home,
      processEnv: { OPENAI_API_KEY: 'sk-test' },
      fetch: (async (_url: unknown, init?: RequestInit) => {
        bodies.push(String(init?.body));
        return openAi({ content: 'hello' });
      }) as typeof fetch,
    },
    idleTimeoutMs: 0,
    warn: () => {},
  });
  await gateway.start();
  try {
    const real = await gateway.dispatch({ sessionId: 'ava-1', agentId: 'ava', userMessage: 'please use the echo tool' });
    assert.equal(real.status, 'completed');
    const offered = toolNamesOf(bodies[0] ?? '{}');
    assert.ok(offered.includes('memory_recall'), offered.join(', '));
    assert.ok(!offered.includes('demo_echo'), offered.join(', '));

    // Same daemon, same registry: the demo agent's call runs.
    const demo = await gateway.dispatch({ sessionId: 'dee-1', agentId: 'dee', userMessage: 'please use the echo tool' });
    assert.equal(demo.status, 'completed');
    const echoed = demo.messages.find((message) => message.role === 'tool')?.toolResult;
    assert.equal(echoed?.toolName, 'demo.echo');
    assert.equal(echoed?.ok, true);
    assert.deepEqual(echoed?.output, {
      received: 'please use the echo tool',
      uppercase: 'PLEASE USE THE ECHO TOOL',
      length: 24,
    });

    // Still the kernel's name, listed as before, so no plugin can take it.
    assert.ok(gateway.tools().some((tool) => tool.name === 'demo.echo'));
  } finally {
    await gateway.stop();
  }
});

test('a real provider that names demo.echo anyway is refused, even for a soul that lists it, and nothing runs', async () => {
  // The wire name comes back untranslated, since it was never offered, so
  // the runner refuses it by name before anything could run it.
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nprovider: openai\nmodel: model-a\ntools:\n  - demo.echo\n  - memory.recall\n---\n\nYou are Ava.\n');
  let calls = 0;
  const gateway = createGateway({
    env: {
      homeDir: home,
      cwd: home,
      processEnv: { OPENAI_API_KEY: 'sk-test' },
      fetch: (async () => {
        calls += 1;
        return calls === 1
          ? openAi({
              tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'demo_echo', arguments: JSON.stringify({ text: 'hi' }) } }],
            })
          : openAi({ content: 'no echo here' });
      }) as typeof fetch,
    },
    idleTimeoutMs: 0,
    warn: () => {},
  });
  await gateway.start();
  try {
    const session = await gateway.dispatch({ sessionId: 'ava-2', agentId: 'ava', userMessage: 'echo hi' });
    assert.equal(session.status, 'completed');
    const result = session.messages.find((message) => message.role === 'tool')?.toolResult;
    assert.equal(result?.ok, false);
    assert.equal(result?.output ?? null, null);
    assert.match(String(result?.error), /^Tool not (found|permitted)\b.*demo[._]echo$/);
  } finally {
    await gateway.stop();
  }
});
