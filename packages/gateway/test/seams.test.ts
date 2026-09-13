import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  InMemoryAgentMemoryStore,
  type AgentDefinition,
  type ModelProvider,
  type PluginContext,
  type ProviderResponse,
  type Session,
  type ToolCall,
  type ToolResult,
} from '@stratusagent/core';
import { createLocalCommandExecutor } from '@stratusagent/executor-local';
import type { OptionalModuleHost } from '@stratusagent/plugins';
import { createFileCredentialResolver, saveChannelTransportSecrets } from '@stratusagent/state';

import { createGateway, type Gateway } from '../src/index.ts';

const newHome = async (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'stratus-gw-seams-'));

const writeSoul = async (home: string, file: string, contents: string): Promise<void> => {
  const dir = path.join(home, '.stratus', 'agents');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, file), contents);
};

const hostFor = async (
  packages: Record<string, { manifest: unknown; module?: unknown }>,
): Promise<OptionalModuleHost> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-gw-seam-pkgs-'));
  const entries = new Map<string, string>();
  for (const [name, entry] of Object.entries(packages)) {
    const directory = path.join(root, name.replace(/[@/]/g, '_'));
    await mkdir(path.join(directory, 'dist'), { recursive: true });
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, ...(entry.manifest as object) }));
    entries.set(name, pathToFileURL(path.join(directory, 'dist', 'index.js')).href);
  }
  return {
    resolve(specifier) {
      const resolved = entries.get(specifier);
      if (!resolved) {
        throw new Error(`Cannot find package '${specifier}'`);
      }
      return resolved;
    },
    async import(specifier) {
      return packages[specifier]?.module ?? {};
    },
  };
};

const manifest = (contributes: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  stratus: { pluginVersion: 1, contributes, ...extra },
});

const plugin = (name: string, setup: (context: PluginContext) => void | Promise<void>, dispose?: () => void) => ({
  createPlugin: () => ({ name, setup, ...(dispose ? { dispose } : {}) }),
});

/**
 * A provider that remembers a fact, recalls it, then answers — the shape a
 * memory test needs from a contributed provider, since the built-in demo
 * provider calls only demo.echo.
 */
const rememberingProvider = (name: string, model: string | undefined): ModelProvider => ({
  name,
  async generate({ session }): Promise<ProviderResponse> {
    const last = session.messages.at(-1);
    if (last?.role !== 'tool') {
      return { parts: [{ type: 'tool-call', call: { id: `${session.id}:remember`, toolName: 'memory.remember', input: { fact: `${session.agent.id} likes ${model ?? 'defaults'}` } } }] };
    }
    if (last.toolResult?.toolName === 'memory.remember') {
      return { parts: [{ type: 'tool-call', call: { id: `${session.id}:recall`, toolName: 'memory.recall', input: { query: 'likes' } } }] };
    }
    const recalled = JSON.stringify(last.toolResult?.output ?? null);
    return { parts: [{ type: 'text', text: `served by ${name} on ${model ?? 'its default'}; recalled ${recalled}` }] };
  },
});

test('a plugin provider serves a run a soul selected, and a plugin memory store backs remember and recall per agent', async () => {
  const home = await newHome();
  const built: string[] = [];
  const appends: string[] = [];
  const store = new InMemoryAgentMemoryStore();
  const originalAppend = store.append.bind(store);
  store.append = async (agentId, content, metadata, provenance) => {
    appends.push(`${agentId}: ${content}`);
    return originalAppend(agentId, content, metadata, provenance);
  };
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\nprovider: fixture\nmodel: tiny\ntools: [memory.remember, memory.recall]\n---\n\nYou are Ava.\n');
  await writeSoul(home, 'juno.md', '---\nname: Juno\nid: juno\nprovider: fixture\ntools: [memory.remember, memory.recall]\n---\n\nYou are Juno.\n');

  const host = await hostFor({
    'stratus-plugin-fixture-seams': {
      manifest: manifest({ providers: [{ name: 'fixture' }], memory: [{ name: 'fixture' }] }),
      module: plugin('seams', (context) => {
        context.providers?.register({
          name: 'fixture',
          create(selection) {
            built.push(selection.model ?? '(default)');
            return rememberingProvider('fixture', selection.model);
          },
        });
        context.memory?.register({ name: 'fixture', store });
      }),
    },
  });

  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: {} },
    idleTimeoutMs: 0,
    plugins: { 'stratus-plugin-fixture-seams': {} },
    pluginHost: host,
    memoryStore: 'fixture',
    log: () => {},
    warn: () => {},
  });
  await gateway.start();
  try {
    const ava = await gateway.dispatch({ sessionId: 'ava-1', agentId: 'ava', userMessage: 'hello' });
    const avaReply = [...ava.messages].reverse().find((message) => message.role === 'assistant')?.content ?? '';
    assert.match(avaReply, /served by fixture on tiny; recalled .*ava likes tiny/);
    assert.equal(ava.metadata?.provider, 'plugin:fixture');
    assert.equal(ava.metadata?.model, 'tiny');

    // Juno's soul pins no model: the provider is built for its own default,
    // and juno's recall finds juno's fact and never ava's.
    const juno = await gateway.dispatch({ sessionId: 'juno-1', agentId: 'juno', userMessage: 'hello' });
    const junoReply = [...juno.messages].reverse().find((message) => message.role === 'assistant')?.content ?? '';
    assert.match(junoReply, /served by fixture on its default; recalled .*juno likes defaults/);
    assert.doesNotMatch(junoReply, /ava likes/);

    // Once per selection: two agents on two models are two builds, a third
    // turn on either is not a third.
    await gateway.dispatch({ sessionId: 'ava-2', agentId: 'ava', userMessage: 'again' });
    assert.deepEqual(built, ['tiny', '(default)']);
    assert.deepEqual(appends, ['ava: ava likes tiny', 'juno: juno likes defaults', 'ava: ava likes tiny']);

    assert.deepEqual(gateway.providers().at(-1), { name: 'fixture', package: 'stratus-plugin-fixture-seams' });
    const status = gateway.plugins().find((entry) => entry.package === 'stratus-plugin-fixture-seams');
    assert.deepEqual(status?.providers, ['fixture']);
    assert.deepEqual(status?.memory, ['fixture']);
  } finally {
    await gateway.stop();
  }
});

test('a plugin channel starts from its stored transport secrets, receives an inbound message, and no agent can resolve those secrets', async () => {
  const home = await newHome();
  const env = { homeDir: home, cwd: home, processEnv: {} };
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\nprovider: demo\ncredentials: [botToken]\n---\n\nYou are Ava.\n');
  await saveChannelTransportSecrets(env, 'fixture', 'ava', { botToken: 'fixture-bot-token' });

  const lifecycle: string[] = [];
  let received: Session | undefined;
  const host = await hostFor({
    'stratus-plugin-fixture-channel': {
      manifest: manifest({ channels: [{ name: 'fixture' }] }),
      module: plugin('channel', async (context) => {
        const secrets = await context.channels!.transportSecrets('fixture');
        lifecycle.push(`secrets ${JSON.stringify(secrets)}`);
        context.channels!.register({
          agents: Object.keys(secrets),
          adapter: {
            name: 'fixture',
            async start(gateway) {
              lifecycle.push('start');
              // The transport's first inbound message, dispatched the way a
              // real adapter dispatches: through the gateway it was started with.
              received = await (gateway as Gateway).dispatch({ sessionId: 'fixture:ava:1', agentId: 'ava', userMessage: 'hello from the transport' });
            },
            async stop() {
              lifecycle.push('stop');
            },
          },
        });
      }, () => lifecycle.push('dispose')),
    },
  });

  const gateway = createGateway({
    env,
    idleTimeoutMs: 0,
    plugins: { 'stratus-plugin-fixture-channel': {} },
    pluginHost: host,
    log: () => {},
    warn: () => {},
  });
  await gateway.start();
  try {
    assert.equal(received?.status, 'completed');
    assert.equal(received?.agent.id, 'ava');
    assert.deepEqual(gateway.plugins()[0]?.channels, [{ kind: 'fixture', agents: ['ava'] }]);
    // The invariant the host-owned path exists for: the token an agent's
    // own allowlist names is not the transport's, whatever the name.
    const ava = gateway.agents().find((agent) => agent.id === 'ava') as AgentDefinition;
    assert.equal(await createFileCredentialResolver(env).resolve(ava, 'botToken'), undefined);
  } finally {
    await gateway.stop();
  }
  // Channels stop, then plugins dispose — the documented order.
  assert.deepEqual(lifecycle, ['secrets {"ava":{"botToken":"fixture-bot-token"}}', 'start', 'stop', 'dispose']);
});

test('a plugin executor selected by the config runs the commands, and a selection nothing registers refuses to start', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\nprovider: demo\n---\n\nYou are Ava.\n');
  const ran: string[] = [];
  let disposed = 0;
  const direct = createLocalCommandExecutor();
  const host = await hostFor({
    'stratus-plugin-fixture-executor': {
      manifest: manifest({ executors: [{ name: 'fixture' }] }),
      module: plugin('executor', (context) => {
        context.executors?.register({
          name: 'fixture',
          executor: {
            async execute(call: ToolCall, tool, session, executionContext): Promise<ToolResult> {
              ran.push(call.toolName);
              return direct.execute(call, tool, session, executionContext);
            },
          },
        });
      }, () => { disposed += 1; }),
    },
  });

  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: {} },
    idleTimeoutMs: 0,
    plugins: { 'stratus-plugin-fixture-executor': {} },
    pluginHost: host,
    executor: 'fixture',
    log: () => {},
    warn: () => {},
  });
  await gateway.start();
  try {
    const session = await gateway.dispatch({ sessionId: 'exec-1', agentId: 'ava', userMessage: 'please use the echo tool' });
    assert.equal(session.status, 'completed');
    assert.deepEqual(ran, ['demo.echo']);
    assert.deepEqual(gateway.plugins()[0]?.executors, ['fixture']);
  } finally {
    await gateway.stop();
  }
  assert.equal(disposed, 1);

  // The operator selected a sandbox that is not there: refused, not
  // quietly run on the host — and the plugins that did load are let go.
  const refused = createGateway({
    env: { homeDir: home, cwd: home, processEnv: {} },
    idleTimeoutMs: 0,
    plugins: { 'stratus-plugin-fixture-executor': {} },
    pluginHost: host,
    executor: 'docker',
    log: () => {},
    warn: () => {},
  });
  await assert.rejects(refused.start(), /selects executor docker, which no loaded plugin registers \(registered: fixture\)/);
  assert.equal(disposed, 2);

  const noStore = createGateway({
    env: { homeDir: home, cwd: home, processEnv: {} },
    idleTimeoutMs: 0,
    memoryStore: 'vector',
    log: () => {},
    warn: () => {},
  });
  await assert.rejects(noStore.start(), /selects memoryStore vector, which no loaded plugin registers\. Enable the plugin/);
});
