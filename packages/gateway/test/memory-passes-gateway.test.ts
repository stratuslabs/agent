import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { MemoryPassHandle, StratusEvent } from '@stratusagent/core';
import { AllowAllApprovalPolicy, MEMORY_SAVE_PASS_REQUEST } from '@stratusagent/core';
import type { OptionalModuleHost } from '@stratusagent/plugins';
import {
  agentMemoryPassesFileIn,
  createHomeMemoryStore,
  createMemoryPassLedger,
  memoryPassEntries,
  stratusHomePath,
} from '@stratusagent/state';

import { createGateway } from '../src/index.ts';

// Spec 962 through the daemon: a plugin is handed `memoryPasses`, and a
// save pass runs as the agent on its provider with only its two tools.

const SOUL = [
  '---',
  'id: ava',
  'name: Ava',
  'provider: openai',
  'model: model-a',
  'tools: [memory.*]',
  '---',
  '',
  'You are Ava, and your persona is PERSONA-MARKER.',
  '',
].join('\n');

const openAiText = (text: string): Response =>
  new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const openAiToolCall = (name: string, args: object): Response =>
  new Response(JSON.stringify({
    choices: [{
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      },
    }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });

interface SeenRequest {
  model: string;
  system: string;
  firstUser: string;
  lastRole: string;
  tools: string[];
}

const readRequest = (init: RequestInit | undefined): SeenRequest => {
  const body = JSON.parse(String(init?.body ?? '{}')) as {
    model?: string;
    messages?: Array<{ role: string; content?: unknown }>;
    tools?: Array<{ function?: { name?: string } }>;
  };
  const messages = body.messages ?? [];
  const text = (content: unknown): string => typeof content === 'string'
    ? content
    : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? '').join('') : '';
  return {
    model: body.model ?? '',
    system: messages.filter((message) => message.role === 'system').map((message) => text(message.content)).join('\n'),
    firstUser: text(messages.find((message) => message.role === 'user')?.content),
    lastRole: messages.at(-1)?.role ?? '',
    tools: (body.tools ?? []).map((tool) => tool.function?.name ?? ''),
  };
};

const upkeepGateway = async (options: { config?: object; pass?: (request: SeenRequest) => Response } = {}) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-gw-pass-'));
  await mkdir(path.join(home, '.stratus', 'agents'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'agents', 'ava.md'), SOUL);
  if (options.config) {
    await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify(options.config));
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-gw-pass-pkgs-'));
  const directory = path.join(root, 'upkeep');
  await mkdir(path.join(directory, 'dist'), { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({
    name: 'stratus-plugin-upkeep',
    stratus: { pluginVersion: 1, contributes: {} },
  }));
  let handle: MemoryPassHandle | undefined;
  const module = {
    createPlugin: () => ({
      name: 'upkeep',
      setup(context: { memoryPasses?: MemoryPassHandle }) {
        handle = context.memoryPasses;
      },
    }),
  };
  const pluginHost: OptionalModuleHost = {
    resolve(specifier) {
      if (specifier !== 'stratus-plugin-upkeep') {
        throw new Error(`Cannot find package '${specifier}'`);
      }
      return pathToFileURL(path.join(directory, 'dist', 'index.js')).href;
    },
    async import() {
      return module;
    },
  };
  const passRequests: SeenRequest[] = [];
  const fetchFake = (async (_url: string | URL | Request, init?: RequestInit) => {
    const request = readRequest(init);
    if (request.firstUser.startsWith(MEMORY_SAVE_PASS_REQUEST)) {
      passRequests.push(request);
      if (options.pass) {
        return options.pass(request);
      }
      return request.lastRole === 'tool'
        ? openAiText('Saved one fact.')
        : openAiToolCall('memory_remember', { fact: 'Ava prefers tea in the morning.', kind: 'preference' });
    }
    return openAiText('Noted.');
  }) as typeof fetch;
  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchFake };
  const gateway = createGateway({
    env,
    idleTimeoutMs: 0,
    plugins: { 'stratus-plugin-upkeep': { enabled: true } },
    pluginHost,
    approvals: new AllowAllApprovalPolicy(),
    log: () => undefined,
    warn: () => undefined,
  });
  const events: StratusEvent[] = [];
  gateway.bus.subscribe((event: StratusEvent) => {
    events.push(event);
  });
  const ledger = createMemoryPassLedger(agentMemoryPassesFileIn(stratusHomePath(env), 'ava'));
  return { home, env, gateway, handle: () => handle, passRequests, events, ledger };
};

test('a plugin is handed memoryPasses, and a save pass runs as the agent with only recall and remember', async () => {
  const harness = await upkeepGateway();
  await harness.gateway.start();
  try {
    const handle = harness.handle();
    assert.ok(handle, 'the daemon gave the plugin no memoryPasses');
    await handle.start('ava', 'write');
    const turn = await harness.gateway.dispatch({ sessionId: 'cli-1', agentId: 'ava', userMessage: 'I always have tea in the morning.' });
    assert.equal(turn.status, 'completed');

    const outcome = await handle.run({ kind: 'save', agentId: 'ava', sessionId: 'cli-1', reason: 'quiet' });
    assert.equal(outcome.status, 'done');
    assert.equal(outcome.saved, 1);

    const [first] = harness.passRequests;
    assert.ok(first, 'the pass made no model call');
    assert.equal(first.model, 'model-a', 'the agent\'s own model by default');
    assert.deepEqual([...first.tools].sort(), ['memory_recall', 'memory_remember']);
    assert.match(first.system, /looking after your own long-term memory/);
    assert.doesNotMatch(first.system, /PERSONA-MARKER/, 'no persona');
    assert.match(first.firstUser, /I always have tea in the morning\./);
    assert.match(first.firstUser, /Noted\./);

    const memory = createHomeMemoryStore(harness.env);
    const [entry] = await memoryPassEntries(memory, 'ava', outcome.passId);
    assert.equal(entry?.content, 'Ava prefers tea in the morning.');
    assert.equal(entry?.origin?.sessionId, 'cli-1');
    assert.equal(await harness.gateway.store.get(`memory-pass:${outcome.passId}`), undefined, 'a pass session is never stored');
    assert.ok(harness.events.some((event) => event.type === 'memory.pass-completed' && event.passId === outcome.passId));

    const cheap = await harness.gateway.dispatch({ sessionId: 'cli-1', agentId: 'ava', userMessage: 'And green, not black.' });
    assert.equal(cheap.status, 'completed');
    await handle.run({ kind: 'save', agentId: 'ava', sessionId: 'cli-1', reason: 'quiet', model: 'model-cheap' });
    assert.equal(harness.passRequests.at(-1)?.model, 'model-cheap', 'exactly the model asked for');
    assert.doesNotMatch(harness.passRequests.at(-1)!.firstUser, /I always have tea/, 'the next pass starts at the watermark');
  } finally {
    await harness.gateway.stop();
  }
  const records = await harness.ledger.read();
  assert.equal(records[0]?.type, 'start');
  assert.equal(records.at(-1)?.type, 'stop', 'a stop writes the stop record');
});

test('a pass never falls back: a failing model fails the pass and gives the slice back', async () => {
  const harness = await upkeepGateway({
    config: { fallbackProvider: 'openai', fallbackModel: 'model-f' },
    pass: () => new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 500, headers: { 'content-type': 'application/json' } }),
  });
  await harness.gateway.start();
  try {
    const handle = harness.handle()!;
    await handle.start('ava', 'write');
    await harness.gateway.dispatch({ sessionId: 'cli-1', agentId: 'ava', userMessage: 'I always have tea in the morning.' });
    const outcome = await handle.run({ kind: 'save', agentId: 'ava', sessionId: 'cli-1', reason: 'quiet' });
    assert.deepEqual([outcome.status, outcome.reason], ['failed', 'model']);
    assert.ok(harness.passRequests.length > 0);
    assert.ok(harness.passRequests.every((request) => request.model === 'model-a'), 'no call went to the fallback model');
  } finally {
    await harness.gateway.stop();
  }
  const ends = (await harness.ledger.read()).filter((record) => record.type === 'end');
  assert.equal(ends.length, 1);
  assert.equal((ends[0] as { released: boolean }).released, true);
});
