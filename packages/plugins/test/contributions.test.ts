import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ChannelRegistry,
  ContributionRegistry,
  EventBus,
  InMemoryAgentMemoryStore,
  ToolRegistry,
  type ChannelAdapterLike,
  type ExecutorContribution,
  type MemoryStoreContribution,
  type Plugin,
  type PluginContext,
  type ProviderContribution,
} from '@stratusagent/core';

import { loadPlugins, parsePluginManifest, type OptionalModuleHost } from '../src/index.ts';

const fakeHost = async (
  packages: Record<string, { manifest: unknown; module?: unknown }>,
): Promise<OptionalModuleHost> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-contributions-'));
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

const pluginModule = (name: string, setup: (context: PluginContext) => void | Promise<void>) => ({
  createPlugin: (): Plugin => ({ name, setup }),
});

const manifest = (contributes: Record<string, unknown>) => ({ stratus: { pluginVersion: 1, contributes } });

const provider = (name: string): ProviderContribution => ({
  name,
  create: () => ({ name, async generate() { return { parts: [] }; } }),
});

const adapter = (name: string): ChannelAdapterLike => ({ name, async start() {}, async stop() {} });

const memory = (name: string): MemoryStoreContribution => ({ name, store: new InMemoryAgentMemoryStore() });

const executor = (name: string): ExecutorContribution => ({
  name,
  executor: { async execute(call) { return { callId: call.id, toolName: call.toolName, ok: true, output: null, trust: 'agent' }; } },
});

const targets = () => ({
  providers: new ContributionRegistry<ProviderContribution>(),
  channels: new ChannelRegistry(),
  memory: new ContributionRegistry<MemoryStoreContribution>(),
  executors: new ContributionRegistry<ExecutorContribution>(),
});

test('a plugin registers each of the four kinds through its handle, and the host sees them by name', async () => {
  const host = await fakeHost({
    'stratus-plugin-everything': {
      manifest: manifest({
        providers: [{ name: 'fixture' }],
        channels: [{ name: 'fixture' }],
        memory: [{ name: 'fixture' }],
        executors: [{ name: 'fixture' }],
      }),
      module: pluginModule('everything', (context) => {
        context.providers?.register(provider('fixture'));
        context.channels?.register({ adapter: adapter('fixture'), agents: ['ava', 'juno'] });
        context.memory?.register(memory('fixture'));
        context.executors?.register(executor('fixture'));
      }),
    },
  });
  const registries = targets();
  const result = await loadPlugins({
    config: { 'stratus-plugin-everything': {} },
    host,
    tools: new ToolRegistry(),
    bus: new EventBus(),
    ...registries,
  });

  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.loaded[0]?.contributions, {
    providers: ['fixture'],
    channels: [{ kind: 'fixture', agents: ['ava', 'juno'] }],
    memory: ['fixture'],
    executors: ['fixture'],
  });
  assert.equal(registries.providers.get('fixture')?.create({}).name, 'fixture');
  assert.equal(registries.channels.claimed('fixture', 'ava'), true);
  assert.ok(registries.memory.get('fixture'));
  assert.ok(registries.executors.get('fixture'));
});

test('a plugin that registers a kind its manifest does not declare fails at load, naming the package and the kind', async () => {
  const host = await fakeHost({
    'stratus-plugin-overreach': {
      manifest: manifest({ channels: [{ name: 'discord' }] }),
      module: pluginModule('overreach', (context) => {
        context.providers?.register(provider('sneaky'));
      }),
    },
  });
  const registries = targets();
  const result = await loadPlugins({
    config: { 'stratus-plugin-overreach': {} },
    host,
    tools: new ToolRegistry(),
    bus: new EventBus(),
    ...registries,
  });

  assert.equal(result.loaded.length, 0);
  assert.match(result.failures[0]?.reason ?? '', /stratus-plugin-overreach tried to register provider sneaky, which its manifest does not declare/);
  assert.deepEqual(registries.providers.names(), []);
});

test('two plugins registering the same provider name fail at load rather than one silently winning', async () => {
  const host = await fakeHost({
    'stratus-plugin-first': {
      manifest: manifest({ providers: [{ name: 'ollama' }] }),
      module: pluginModule('first', (context) => context.providers?.register(provider('ollama'))),
    },
    'stratus-plugin-second': {
      manifest: manifest({ providers: [{ name: 'ollama' }] }),
      module: pluginModule('second', (context) => context.providers?.register(provider('ollama'))),
    },
  });
  const registries = targets();
  const result = await loadPlugins({
    config: { 'stratus-plugin-first': {}, 'stratus-plugin-second': {} },
    host,
    tools: new ToolRegistry(),
    bus: new EventBus(),
    ...registries,
  });

  assert.deepEqual(result.loaded.map((entry) => entry.package), ['stratus-plugin-first']);
  assert.match(result.failures[0]?.reason ?? '', /provider name collision: ollama is contributed by both stratus-plugin-first and stratus-plugin-second/);
  assert.deepEqual(registries.providers.names(), ['ollama']);
});

test('channels key on (agent, kind): one agent on two kinds is fine, the same kind twice for one agent is a collision', async () => {
  const host = await fakeHost({
    'stratus-plugin-slackish': {
      manifest: manifest({ channels: [{ name: 'slackish' }] }),
      module: pluginModule('slackish', (context) => context.channels?.register({ adapter: adapter('slackish'), agents: ['ava'] })),
    },
    'stratus-plugin-discord': {
      manifest: manifest({ channels: [{ name: 'discord' }] }),
      module: pluginModule('discord', (context) => context.channels?.register({ adapter: adapter('discord'), agents: ['ava'] })),
    },
    'stratus-plugin-discord-too': {
      manifest: manifest({ channels: [{ name: 'discord' }] }),
      module: pluginModule('discord-too', (context) => context.channels?.register({ adapter: adapter('discord'), agents: ['juno', 'ava'] })),
    },
  });
  const registries = targets();
  const result = await loadPlugins({
    config: { 'stratus-plugin-slackish': {}, 'stratus-plugin-discord': {}, 'stratus-plugin-discord-too': {} },
    host,
    tools: new ToolRegistry(),
    bus: new EventBus(),
    ...registries,
  });

  assert.deepEqual(result.loaded.map((entry) => entry.package), ['stratus-plugin-slackish', 'stratus-plugin-discord']);
  assert.match(result.failures[0]?.reason ?? '', /channel collision: discord for agent ava is contributed by both stratus-plugin-discord and stratus-plugin-discord-too/);
  // Refused whole: juno was claimable, and is not claimed.
  assert.equal(registries.channels.claimed('discord', 'juno'), false);
  assert.deepEqual(registries.channels.list().map((entry) => entry.adapter.name), ['slackish', 'discord']);
});

test('a plugin that registers a provider and then throws leaves nothing live', async () => {
  const host = await fakeHost({
    'stratus-plugin-half': {
      manifest: manifest({ providers: [{ name: 'half' }], tools: [{ name: 'half.read', risk: 'gated' }] }),
      module: pluginModule('half', (context) => {
        context.providers?.register(provider('half'));
        context.tools.register({ name: 'half.read', async execute() { return null; } });
        throw new Error('setup gave up');
      }),
    },
  });
  const registries = targets();
  const tools = new ToolRegistry();
  const result = await loadPlugins({ config: { 'stratus-plugin-half': {} }, host, tools, bus: new EventBus(), ...registries });

  assert.match(result.failures[0]?.reason ?? '', /setup gave up/);
  assert.deepEqual(registries.providers.names(), []);
  assert.deepEqual(tools.list(), []);
});

test('a channel plugin receives its transport secrets through the host-owned path, for a declared kind only', async () => {
  const asked: string[] = [];
  let received: unknown;
  let refused: unknown;
  const host = await fakeHost({
    'stratus-plugin-discord': {
      manifest: manifest({ channels: [{ name: 'discord' }] }),
      module: pluginModule('discord', async (context) => {
        received = await context.channels?.transportSecrets('discord');
        refused = await context.channels?.transportSecrets('slack').catch((error: unknown) => error);
        context.channels?.register({ adapter: adapter('discord'), agents: Object.keys(received as object) });
      }),
    },
  });
  const registries = targets();
  const result = await loadPlugins({
    config: { 'stratus-plugin-discord': {} },
    host,
    tools: new ToolRegistry(),
    bus: new EventBus(),
    ...registries,
    channelSecrets: async (kind) => {
      asked.push(kind);
      return { ava: { botToken: 'discord-bot-token' } };
    },
  });

  assert.deepEqual(result.failures, []);
  assert.deepEqual(asked, ['discord']);
  assert.deepEqual(received, { ava: { botToken: 'discord-bot-token' } });
  assert.match((refused as Error).message, /transport secrets of channel slack, which its manifest does not declare/);
  assert.equal(registries.channels.claimed('discord', 'ava'), true);
});

test('a host that stores no channel secrets says so, rather than handing a channel plugin an empty roster', async () => {
  let refused: unknown;
  const host = await fakeHost({
    'stratus-plugin-discord': {
      manifest: manifest({ channels: [{ name: 'discord' }] }),
      module: pluginModule('discord', async (context) => {
        refused = await context.channels?.transportSecrets('discord').catch((error: unknown) => error);
      }),
    },
  });
  const result = await loadPlugins({ config: { 'stratus-plugin-discord': {} }, host, tools: new ToolRegistry(), bus: new EventBus() });
  assert.deepEqual(result.failures, []);
  assert.match((refused as Error).message, /stores no channel transport secrets/);
});

test('a registration after setup() returned is refused: these kinds have no live discovery', async () => {
  let handle: PluginContext['providers'];
  const host = await fakeHost({
    'stratus-plugin-late': {
      manifest: manifest({ providers: [{ name: 'late' }] }),
      module: pluginModule('late', (context) => {
        handle = context.providers;
      }),
    },
  });
  const registries = targets();
  const result = await loadPlugins({ config: { 'stratus-plugin-late': {} }, host, tools: new ToolRegistry(), bus: new EventBus(), ...registries });
  assert.deepEqual(result.failures, []);
  assert.throws(() => handle?.register(provider('late')), /after it had loaded/);
  assert.deepEqual(registries.providers.names(), []);
});

test('a manifest may not declare a built-in provider name, nor a name that is not one', () => {
  assert.throws(
    () => parsePluginManifest({ name: 'stratus-plugin-x', ...manifest({ providers: [{ name: 'anthropic' }] }) }, 'stratus-plugin-x'),
    /provider anthropic is built in/,
  );
  assert.throws(
    () => parsePluginManifest({ name: 'stratus-plugin-x', ...manifest({ executors: [{ name: 'plugin:docker' }] }) }, 'stratus-plugin-x'),
    /is not a executors name/,
  );
  assert.throws(
    () => parsePluginManifest({ name: 'stratus-plugin-x', ...manifest({ memory: [{ name: 'a' }, { name: 'a' }] }) }, 'stratus-plugin-x'),
    /declares "a" twice/,
  );
  const parsed = parsePluginManifest({ name: 'stratus-plugin-x', ...manifest({ channels: [{ name: 'discord' }] }) }, 'stratus-plugin-x');
  assert.deepEqual(parsed.contributes.channels, [{ name: 'discord' }]);
  assert.deepEqual(parsed.contributes.providers, []);
});

test('a plugin contributing a kind the host does not carry still loads, and the contribution is recorded', async () => {
  const host = await fakeHost({
    'stratus-plugin-memory': {
      manifest: manifest({ memory: [{ name: 'vector' }] }),
      module: pluginModule('memory', (context) => context.memory?.register(memory('vector'))),
    },
  });
  const result = await loadPlugins({ config: { 'stratus-plugin-memory': {} }, host, tools: new ToolRegistry(), bus: new EventBus() });
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.loaded[0]?.contributions.memory, ['vector']);
});
