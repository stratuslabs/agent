import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  AllowAllApprovalPolicy,
  InMemoryAgentMemoryStore,
  MEMORY_STORE_CONTRACT_VERSION,
  type AgentDefinition,
  type JsonObject,
  type ModelProvider,
  type PluginContext,
  type ProviderResponse,
  type Session,
  type ToolCall,
  type ToolResult,
} from '@stratusagent/core';
import { MESSAGE_READ_IMAGE_BYTES, MESSAGE_READ_MAX_IMAGES } from '@stratusagent/agents';
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
  store.append = async (agentId, content, options) => {
    appends.push(`${agentId}: ${content}`);
    return originalAppend(agentId, content, options);
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
        context.memory?.register({ name: 'fixture', store, contract: MEMORY_STORE_CONTRACT_VERSION });
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
    assert.equal(ava.metadata?.executor, 'local-command');

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

  // An agent the host's own adapter already carries on this kind is not
  // a plugin's to claim: two adapters on one agent's channel would each
  // answer every message.
  const warnings: string[] = [];
  const contested = createGateway({
    env,
    idleTimeoutMs: 0,
    plugins: { 'stratus-plugin-fixture-channel': {} },
    pluginHost: host,
    hostChannelClaims: [{ kind: 'fixture', agents: ['ava'] }],
    log: () => {},
    warn: (line) => warnings.push(line),
  });
  await contested.start();
  try {
    assert.ok(warnings.some((line) => /channel collision: fixture for agent ava is already carried by the host/.test(line)), warnings.join('\n'));
    assert.deepEqual(contested.plugins().filter((entry) => entry.error === undefined), []);
  } finally {
    await contested.stop();
  }
});

test('outbound speech goes to the adapter that carries the agent when one kind has several', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\nprovider: sender\ntools: [message.send]\n---\n\nYou are Ava.\n');
  await writeSoul(home, 'juno.md', '---\nname: Juno\nid: juno\nprovider: sender\ntools: [message.send]\n---\n\nYou are Juno.\n');
  await writeSoul(home, 'mia.md', '---\nname: Mia\nid: mia\nprovider: sender\ntools: [message.send]\n---\n\nYou are Mia.\n');
  const posted: string[] = [];
  const channelPlugin = (label: string, agents: string[]) => plugin(label, (context) => {
    context.channels!.register({
      agents,
      adapter: {
        name: 'fixture',
        async start() {},
        async stop() {},
        async resolveOutbound(address) {
          return { async post(text: string) { posted.push(`${label} for ${address.agentId}: ${text}`); } };
        },
      },
    });
  });
  const host = await hostFor({
    'stratus-plugin-chan-a': { manifest: manifest({ channels: [{ name: 'fixture' }] }), module: channelPlugin('a', ['ava']) },
    'stratus-plugin-chan-b': { manifest: manifest({ channels: [{ name: 'fixture' }] }), module: channelPlugin('b', ['juno']) },
    'stratus-plugin-sender': {
      manifest: manifest({ providers: [{ name: 'sender' }] }),
      module: plugin('sender', (context) => {
        context.providers!.register({
          name: 'sender',
          create: () => ({
            name: 'sender',
            async generate({ session }): Promise<ProviderResponse> {
              if (session.messages.at(-1)?.role === 'tool') {
                return { parts: [{ type: 'text', text: 'sent' }] };
              }
              return { parts: [{ type: 'tool-call', call: { id: `${session.id}:send`, toolName: 'message.send', input: { destination: { channel: 'fixture', to: 'C1' }, text: `from ${session.agent.id}` } } }] };
            },
          }),
        });
      }),
    },
  });
  const gateway = createGateway({
    approvals: new AllowAllApprovalPolicy(),
    env: { homeDir: home, cwd: home, processEnv: {} },
    idleTimeoutMs: 0,
    plugins: { 'stratus-plugin-chan-a': {}, 'stratus-plugin-chan-b': {}, 'stratus-plugin-sender': {} },
    pluginHost: host,
    log: () => {},
    warn: () => {},
  });
  await gateway.start();
  try {
    await gateway.dispatch({ sessionId: 'out-juno', agentId: 'juno', userMessage: 'say something' });
    await gateway.dispatch({ sessionId: 'out-ava', agentId: 'ava', userMessage: 'say something' });
    assert.deepEqual(posted, ['b for juno: from juno', 'a for ava: from ava']);
    // An agent no adapter claims is refused, not handed to whichever
    // adapter started first: that one would post under another agent's
    // transport identity.
    const mia = await gateway.dispatch({ sessionId: 'out-mia', agentId: 'mia', userMessage: 'say something' });
    assert.match(JSON.stringify(mia.messages), /No running 'fixture' channel carries agent mia/);
    assert.deepEqual(posted, ['b for juno: from juno', 'a for ava: from ava']);
  } finally {
    await gateway.stop();
  }
});

test('message.send hands the thread to the adapter and the posted id back to the model', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\nprovider: sender\ntools: [message.send]\n---\n\nYou are Ava.\n');
  const addresses: JsonObject[] = [];
  const host = await hostFor({
    'stratus-plugin-chan': {
      manifest: manifest({ channels: [{ name: 'fixture' }] }),
      module: plugin('chan', (context) => {
        context.channels!.register({
          agents: ['ava'],
          adapter: {
            name: 'fixture',
            async start() {},
            async stop() {},
            async resolveOutbound(address) {
              addresses.push({ ...address });
              return { async post() { return { channel: address.to, ts: '1791400000.000200' }; } };
            },
          },
        });
      }),
    },
    'stratus-plugin-sender': {
      manifest: manifest({ providers: [{ name: 'sender' }] }),
      module: plugin('sender', (context) => {
        context.providers!.register({
          name: 'sender',
          create: () => ({
            name: 'sender',
            async generate({ session }): Promise<ProviderResponse> {
              if (session.messages.at(-1)?.role === 'tool') {
                return { parts: [{ type: 'text', text: 'sent' }] };
              }
              return { parts: [{ type: 'tool-call', call: { id: `${session.id}:send`, toolName: 'message.send', input: { destination: { channel: 'fixture', to: 'C1' }, text: 'details', thread: '1791400000.000100' } } }] };
            },
          }),
        });
      }),
    },
  });
  const gateway = createGateway({
    approvals: new AllowAllApprovalPolicy(),
    env: { homeDir: home, cwd: home, processEnv: {} },
    idleTimeoutMs: 0,
    plugins: { 'stratus-plugin-chan': {}, 'stratus-plugin-sender': {} },
    pluginHost: host,
    log: () => {},
    warn: () => {},
  });
  await gateway.start();
  try {
    const session = await gateway.dispatch({ sessionId: 'thread-ava', agentId: 'ava', userMessage: 'reply under the report' });
    // The speaker is the sending session, at the label its words carry, so
    // a channel can let the agent hear its own threaded post (card 364).
    assert.deepEqual(addresses, [{ agentId: 'ava', to: 'C1', thread: '1791400000.000100', speaker: { sessionId: 'thread-ava', trust: 'agent' } }]);
    const result = session.messages.find((message) => message.role === 'tool');
    assert.match(JSON.stringify(result), /1791400000\.000200/);
  } finally {
    await gateway.stop();
  }
});

test('message.read goes through the adapter that carries the calling agent, and is labelled external', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\nprovider: reader\ntools: [message.read]\n---\n\nYou are Ava.\n');
  await writeSoul(home, 'mia.md', '---\nname: Mia\nid: mia\nprovider: reader\ntools: [message.read]\n---\n\nYou are Mia.\n');
  const reads: string[] = [];
  const host = await hostFor({
    'stratus-plugin-chan-a': {
      manifest: manifest({ channels: [{ name: 'fixture' }] }),
      module: plugin('a', (context) => {
        context.channels!.register({
          agents: ['ava'],
          adapter: {
            name: 'fixture',
            async start() {},
            async stop() {},
            async readConversation(request) {
              reads.push(`${request.agentId}:${request.conversation}:${request.thread ?? '-'}:${request.limit}`);
              return { messages: [{ id: '1', author: 'U1', text: 'feedback here' }], more: false };
            },
          },
        });
      }),
    },
    'stratus-plugin-reader': {
      manifest: manifest({ providers: [{ name: 'reader' }] }),
      module: plugin('reader', (context) => {
        context.providers!.register({
          name: 'reader',
          create: () => ({
            name: 'reader',
            async generate({ session }): Promise<ProviderResponse> {
              if (session.messages.at(-1)?.role === 'tool') {
                return { parts: [{ type: 'text', text: 'read' }] };
              }
              return { parts: [{ type: 'tool-call', call: { id: `${session.id}:read`, toolName: 'message.read', input: { source: { channel: 'fixture', to: 'C1' }, thread: 'T1' } } }] };
            },
          }),
        });
      }),
    },
  });
  const gateway = createGateway({
    approvals: new AllowAllApprovalPolicy(),
    env: { homeDir: home, cwd: home, processEnv: {} },
    idleTimeoutMs: 0,
    plugins: { 'stratus-plugin-chan-a': {}, 'stratus-plugin-reader': {} },
    pluginHost: host,
    log: () => {},
    warn: () => {},
  });
  await gateway.start();
  try {
    const ava = await gateway.dispatch({ sessionId: 'read-ava', agentId: 'ava', userMessage: 'catch up' });
    assert.deepEqual(reads, ['ava:C1:T1:50']);
    const result = ava.messages.find((message) => message.role === 'tool');
    assert.match(JSON.stringify(result), /feedback here/);
    assert.match(JSON.stringify(result), /"trust":"external"/);
    // No adapter carries mia, so there is no app whose membership could
    // bound the read: refused, never served by ava's adapter.
    const mia = await gateway.dispatch({ sessionId: 'read-mia', agentId: 'mia', userMessage: 'catch up' });
    assert.match(JSON.stringify(mia.messages), /No running 'fixture' channel carries agent mia/);
    assert.deepEqual(reads, ['ava:C1:T1:50']);
  } finally {
    await gateway.stop();
  }
});

test('message.read asks the channel for images and the model gets them with the result, not in its text', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\nprovider: reader\ntools: [message.read]\n---\n\nYou are Ava.\n');
  // A 1×1 PNG with its size chunk and trailer: what the runner's image
  // check reads before it lets an image through.
  const png = Buffer.alloc(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(1, 16);
  png.writeUInt32BE(1, 20);
  const shot = Buffer.concat([png, Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])]).toString('base64');
  const asked: unknown[] = [];
  const host = await hostFor({
    'stratus-plugin-chan-a': {
      manifest: manifest({ channels: [{ name: 'fixture' }] }),
      module: plugin('a', (context) => {
        context.channels!.register({
          agents: ['ava'],
          adapter: {
            name: 'fixture',
            async start() {},
            async stop() {},
            async readConversation(request) {
              asked.push(request.images);
              return {
                messages: [{ id: '1', author: 'U1', text: 'the landing page', files: ['shot.png'], images: [{ mediaType: 'image/png', data: shot, name: 'shot.png' }] }],
                more: false,
              };
            },
          },
        });
      }),
    },
    'stratus-plugin-reader': {
      manifest: manifest({ providers: [{ name: 'reader' }] }),
      module: plugin('reader', (context) => {
        context.providers!.register({
          name: 'reader',
          create: () => ({
            name: 'reader',
            async generate({ session }): Promise<ProviderResponse> {
              if (session.messages.at(-1)?.role === 'tool') {
                return { parts: [{ type: 'text', text: 'seen' }] };
              }
              return { parts: [{ type: 'tool-call', call: { id: `${session.id}:read`, toolName: 'message.read', input: { source: { channel: 'fixture', to: 'C1' } } } }] };
            },
          }),
        });
      }),
    },
  });
  const gateway = createGateway({
    approvals: new AllowAllApprovalPolicy(),
    env: { homeDir: home, cwd: home, processEnv: {} },
    idleTimeoutMs: 0,
    plugins: { 'stratus-plugin-chan-a': {}, 'stratus-plugin-reader': {} },
    pluginHost: host,
    log: () => {},
    warn: () => {},
  });
  await gateway.start();
  try {
    const session = await gateway.dispatch({ sessionId: 'read-images', agentId: 'ava', userMessage: 'what did Dylan post?' });
    assert.deepEqual(asked, [{ count: MESSAGE_READ_MAX_IMAGES, bytes: MESSAGE_READ_IMAGE_BYTES }]);
    const result = session.messages.find((message) => message.role === 'tool');
    assert.deepEqual(result?.images, [{ mediaType: 'image/png', data: shot, name: 'shot.png' }]);
    assert.match(result?.content ?? '', /"shownImages":\["shot\.png"\]/);
    assert.doesNotMatch(result?.content ?? '', new RegExp(shot.replace(/[+/=]/g, '\\$&')));
  } finally {
    await gateway.stop();
  }
});

test('channel.create goes through the adapter that carries the calling agent, and is refused where none can create', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\nprovider: maker\ntools: [channel.create]\n---\n\nYou are Ava.\n');
  await writeSoul(home, 'mia.md', '---\nname: Mia\nid: mia\nprovider: maker\ntools: [channel.create]\n---\n\nYou are Mia.\n');
  const creates: string[] = [];
  let kind = 'fixture';
  const host = await hostFor({
    'stratus-plugin-chan-a': {
      manifest: manifest({ channels: [{ name: 'fixture' }] }),
      module: plugin('a', (context) => {
        context.channels!.register({
          agents: ['ava'],
          adapter: {
            name: 'fixture',
            async start() {},
            async stop() {},
            async createConversation(request) {
              creates.push(`${request.agentId}:${request.name}:${request.private === true}:${(request.invite ?? []).join(',')}`);
              return { conversation: 'C77', name: request.name, invited: request.invite ?? [], notInvited: [], notSet: [] };
            },
          },
        });
      }),
    },
    'stratus-plugin-maker': {
      manifest: manifest({ providers: [{ name: 'maker' }] }),
      module: plugin('maker', (context) => {
        context.providers!.register({
          name: 'maker',
          create: () => ({
            name: 'maker',
            async generate({ session }): Promise<ProviderResponse> {
              if (session.messages.at(-1)?.role === 'tool') {
                return { parts: [{ type: 'text', text: 'made' }] };
              }
              return { parts: [{ type: 'tool-call', call: { id: `${session.id}:create`, toolName: 'channel.create', input: { channel: kind, name: 'client-acme', private: true, invite: ['U1', 'mia'] } } }] };
            },
          }),
        });
      }),
    },
  });
  const gateway = createGateway({
    approvals: new AllowAllApprovalPolicy(),
    env: { homeDir: home, cwd: home, processEnv: {} },
    idleTimeoutMs: 0,
    plugins: { 'stratus-plugin-chan-a': {}, 'stratus-plugin-maker': {} },
    pluginHost: host,
    log: () => {},
    warn: () => {},
  });
  await gateway.start();
  try {
    const ava = await gateway.dispatch({ sessionId: 'create-ava', agentId: 'ava', userMessage: 'make the client channel' });
    assert.deepEqual(creates, ['ava:client-acme:true:U1,mia']);
    assert.match(JSON.stringify(ava.messages.find((message) => message.role === 'tool')), /\\"conversation\\":\\"C77\\"/);
    // No adapter carries mia: never served by ava's app.
    const mia = await gateway.dispatch({ sessionId: 'create-mia', agentId: 'mia', userMessage: 'make the client channel' });
    assert.match(JSON.stringify(mia.messages), /No running 'fixture' channel carries agent mia/);
    // A kind nothing running can create in.
    kind = 'discord';
    const elsewhere = await gateway.dispatch({ sessionId: 'create-elsewhere', agentId: 'ava', userMessage: 'make the client channel' });
    assert.match(JSON.stringify(elsewhere.messages), /No running channel can create 'discord' conversations/);
    assert.deepEqual(creates, ['ava:client-acme:true:U1,mia']);
  } finally {
    await gateway.stop();
  }
});

test('channel.join and channel.invite go through the adapter that carries the calling agent, and are refused where none can', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\nprovider: member\ntools: [channel.join, channel.invite]\n---\n\nYou are Ava.\n');
  await writeSoul(home, 'mia.md', '---\nname: Mia\nid: mia\nprovider: member\ntools: [channel.join, channel.invite]\n---\n\nYou are Mia.\n');
  const calls: string[] = [];
  let kind = 'fixture';
  let toolName = 'channel.join';
  const host = await hostFor({
    'stratus-plugin-chan-a': {
      manifest: manifest({ channels: [{ name: 'fixture' }] }),
      module: plugin('a', (context) => {
        context.channels!.register({
          agents: ['ava'],
          adapter: {
            name: 'fixture',
            async start() {},
            async stop() {},
            async joinConversation(request) {
              calls.push(`join:${request.agentId}:${request.conversation}`);
              return { conversation: request.conversation, alreadyMember: false };
            },
            async inviteToConversation(request) {
              calls.push(`invite:${request.agentId}:${request.conversation}:${request.invite.join(',')}`);
              return { invited: request.invite.slice(0, 1), notInvited: request.invite.slice(1).map((who) => ({ who, reason: 'Slack did not invite them (cant_invite).' })) };
            },
          },
        });
      }),
    },
    // Carries mia, and can create channels but not join or invite: the
    // capability is per method, so this never serves either tool.
    'stratus-plugin-chan-b': {
      manifest: manifest({ channels: [{ name: 'fixture' }] }),
      module: plugin('b', (context) => {
        context.channels!.register({
          agents: ['mia'],
          adapter: {
            name: 'fixture',
            async start() {},
            async stop() {},
            async createConversation(request) {
              return { conversation: 'C0', name: request.name, invited: [], notInvited: [], notSet: [] };
            },
          },
        });
      }),
    },
    'stratus-plugin-member': {
      manifest: manifest({ providers: [{ name: 'member' }] }),
      module: plugin('member', (context) => {
        context.providers!.register({
          name: 'member',
          create: () => ({
            name: 'member',
            async generate({ session }): Promise<ProviderResponse> {
              if (session.messages.at(-1)?.role === 'tool') {
                return { parts: [{ type: 'text', text: 'done' }] };
              }
              const input = toolName === 'channel.join'
                ? { channel: kind, conversation: 'C42' }
                : { channel: kind, conversation: 'C42', invite: ['U1', 'mia'] };
              return { parts: [{ type: 'tool-call', call: { id: `${session.id}:call`, toolName, input } }] };
            },
          }),
        });
      }),
    },
  });
  const gateway = createGateway({
    approvals: new AllowAllApprovalPolicy(),
    env: { homeDir: home, cwd: home, processEnv: {} },
    idleTimeoutMs: 0,
    plugins: { 'stratus-plugin-chan-a': {}, 'stratus-plugin-chan-b': {}, 'stratus-plugin-member': {} },
    pluginHost: host,
    log: () => {},
    warn: () => {},
  });
  await gateway.start();
  const toolResult = (session: { messages: Array<{ role: string }> }): string => JSON.stringify(session.messages.find((message) => message.role === 'tool'));
  try {
    const joined = await gateway.dispatch({ sessionId: 'join-ava', agentId: 'ava', userMessage: 'join ops' });
    assert.match(toolResult(joined), /\\"joined\\":true/);
    assert.match(toolResult(joined), /\\"alreadyMember\\":false/);
    toolName = 'channel.invite';
    const invited = await gateway.dispatch({ sessionId: 'invite-ava', agentId: 'ava', userMessage: 'add them' });
    assert.match(toolResult(invited), /\\"invited\\":\[\\"U1\\"\]/);
    assert.match(toolResult(invited), /cant_invite/);
    assert.deepEqual(calls, ['join:ava:C42', 'invite:ava:C42:U1,mia']);

    // mia's own adapter cannot join or invite, and ava's app never serves her.
    for (const name of ['channel.join', 'channel.invite']) {
      toolName = name;
      const mia = await gateway.dispatch({ sessionId: `${name}-mia`, agentId: 'mia', userMessage: 'go' });
      assert.match(JSON.stringify(mia.messages), name === 'channel.join'
        ? /No running 'fixture' channel carries agent mia, so it has no app to join a channel with/
        : /No running 'fixture' channel carries agent mia, so it has no app to invite anyone with/);
    }
    // A kind nothing running can join or invite in.
    kind = 'discord';
    toolName = 'channel.join';
    const elsewhereJoin = await gateway.dispatch({ sessionId: 'join-elsewhere', agentId: 'ava', userMessage: 'go' });
    assert.match(JSON.stringify(elsewhereJoin.messages), /No running channel can join 'discord' conversations/);
    toolName = 'channel.invite';
    const elsewhereInvite = await gateway.dispatch({ sessionId: 'invite-elsewhere', agentId: 'ava', userMessage: 'go' });
    assert.match(JSON.stringify(elsewhereInvite.messages), /No running channel can invite people to 'discord' conversations/);
    assert.deepEqual(calls, ['join:ava:C42', 'invite:ava:C42:U1,mia']);
  } finally {
    await gateway.stop();
  }
});

test('a message.read of a direct message is refused before any approval prompt, and a channel read still asks and runs', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\nprovider: reader\ntools: [message.read]\n---\n\nYou are Ava.\n');
  const reads: string[] = [];
  const asked: string[] = [];
  const host = await hostFor({
    'stratus-plugin-chan-a': {
      manifest: manifest({ channels: [{ name: 'fixture' }] }),
      module: plugin('a', (context) => {
        context.channels!.register({
          agents: ['ava'],
          adapter: {
            name: 'fixture',
            async start() {},
            async stop() {},
            async conversationKindFor(_agentId, conversation) {
              return conversation.startsWith('D') ? 'direct' : conversation.startsWith('C') ? 'channel' : undefined;
            },
            async readConversation(request) {
              reads.push(request.conversation);
              if (request.conversation.startsWith('D')) {
                throw new Error('fixture: direct messages are never read from outside them.');
              }
              return { messages: [{ id: '1', author: 'U1', text: 'channel text' }], more: false };
            },
          },
        });
      }),
    },
    'stratus-plugin-reader': {
      manifest: manifest({ providers: [{ name: 'reader' }] }),
      module: plugin('reader', (context) => {
        context.providers!.register({
          name: 'reader',
          create: () => ({
            name: 'reader',
            async generate({ session }): Promise<ProviderResponse> {
              if (session.messages.at(-1)?.role === 'tool') {
                return { parts: [{ type: 'text', text: 'done' }] };
              }
              const to = session.messages.at(-1)?.content ?? '';
              return { parts: [{ type: 'tool-call', call: { id: `${session.id}:read`, toolName: 'message.read', input: { source: { channel: 'fixture', to } } } }] };
            },
          }),
        });
      }),
    },
  });
  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: {} },
    idleTimeoutMs: 0,
    plugins: { 'stratus-plugin-chan-a': {}, 'stratus-plugin-reader': {} },
    pluginHost: host,
    approvals: { approve: async ({ call }) => { asked.push(call.toolName); return true; } },
    log: () => {},
    warn: () => {},
  });
  await gateway.start();
  try {
    const dm = await gateway.dispatch({ sessionId: 'read-dm', agentId: 'ava', userMessage: 'D123' });
    assert.deepEqual(asked, [], 'a DM read never reaches the approval policy');
    assert.deepEqual(reads, [], 'and never reaches the adapter');
    const refused = dm.messages.find((message) => message.toolResult?.callId === 'read-dm:read')?.toolResult;
    assert.equal(refused?.ok, false);
    assert.match(refused?.error ?? '', /direct message/);
    assert.match(refused?.error ?? '', /approval cannot unlock/);

    const channel = await gateway.dispatch({ sessionId: 'read-channel', agentId: 'ava', userMessage: 'C123' });
    assert.deepEqual(asked, ['message.read'], 'a channel read is still put to the policy');
    assert.deepEqual(reads, ['C123']);
    assert.match(JSON.stringify(channel.messages), /channel text/);

    // A conversation the adapter cannot describe is not refused up front:
    // it asks as before, and the adapter's own rule decides at read time.
    await gateway.dispatch({ sessionId: 'read-unknown', agentId: 'ava', userMessage: 'X9' });
    assert.deepEqual(asked, ['message.read', 'message.read']);
  } finally {
    await gateway.stop();
  }
});

test('message.read reads the direct message its own session is in, and every other DM read is still refused before any prompt', async () => {
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\nprovider: reader\ntools: [message.read]\n---\n\nYou are Ava.\n');
  const reads: Array<{ conversation: string; sessionId?: string }> = [];
  const asked: string[] = [];
  const OWN = 'fixture:ava:T1:D123';
  const host = await hostFor({
    'stratus-plugin-chan-a': {
      manifest: manifest({ channels: [{ name: 'fixture' }] }),
      module: plugin('a', (context) => {
        context.channels!.register({
          agents: ['ava'],
          adapter: {
            name: 'fixture',
            async start() {},
            async stop() {},
            async conversationKindFor(_agentId, conversation) {
              return conversation.startsWith('D') ? 'direct' : undefined;
            },
            sessionConversation(agentId, sessionId) {
              return agentId === 'ava' && sessionId === OWN ? 'D123' : undefined;
            },
            async readConversation(request) {
              reads.push({ conversation: request.conversation, ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}) });
              return { messages: [{ id: '1', author: 'U1', text: 'dm text' }], more: false };
            },
          },
        });
      }),
    },
    'stratus-plugin-reader': {
      manifest: manifest({ providers: [{ name: 'reader' }] }),
      module: plugin('reader', (context) => {
        context.providers!.register({
          name: 'reader',
          create: () => ({
            name: 'reader',
            async generate({ session }): Promise<ProviderResponse> {
              if (session.messages.at(-1)?.role === 'tool') {
                return { parts: [{ type: 'text', text: 'done' }] };
              }
              const to = session.messages.at(-1)?.content ?? '';
              const turn = session.messages.filter((message) => message.role === 'user').length;
              return { parts: [{ type: 'tool-call', call: { id: `read-${turn}`, toolName: 'message.read', input: { source: { channel: 'fixture', to } } } }] };
            },
          }),
        });
      }),
    },
  });
  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: {} },
    idleTimeoutMs: 0,
    plugins: { 'stratus-plugin-chan-a': {}, 'stratus-plugin-reader': {} },
    pluginHost: host,
    approvals: { approve: async ({ call }) => { asked.push(call.toolName); return true; } },
    log: () => {},
    warn: () => {},
  });
  await gateway.start();
  const resultOf = (session: { messages: Array<{ toolResult?: { callId: string; ok: boolean; error?: string; content?: unknown } }> }, callId: string) =>
    session.messages.filter((message) => message.toolResult?.callId === callId).at(-1)?.toolResult;
  try {
    // Its own DM: still gated, so the policy is asked, and the adapter is
    // told which session is reading.
    const own = await gateway.dispatch({ sessionId: OWN, agentId: 'ava', userMessage: 'D123' });
    assert.equal(resultOf(own, 'read-1')?.ok, true);
    assert.match(JSON.stringify(own.messages), /dm text/);
    assert.deepEqual(asked, ['message.read']);
    assert.deepEqual(reads, [{ conversation: 'D123', sessionId: OWN }]);

    // Another DM from the same session, a delegated session under it and a
    // session living elsewhere (a scheduled turn's id is the adapter's to
    // refuse, tested there): refused before the policy or the adapter is
    // asked.
    const other = await gateway.dispatch({ sessionId: OWN, agentId: 'ava', userMessage: 'D999' });
    const delegated = await gateway.dispatch({ sessionId: `${OWN}:delegate:ava:1`, agentId: 'ava', userMessage: 'D123' });
    const elsewhere = await gateway.dispatch({ sessionId: 'console-1', agentId: 'ava', userMessage: 'D123' });
    for (const [session, callId] of [[other, 'read-2'], [delegated, 'read-1'], [elsewhere, 'read-1']] as const) {
      const refused = resultOf(session, callId);
      assert.equal(refused?.ok, false);
      assert.match(refused?.error ?? '', /direct message/);
      assert.match(refused?.error ?? '', /approval cannot unlock/);
    }
    assert.deepEqual(asked, ['message.read'], 'no refused read reaches the policy');
    assert.equal(reads.length, 1, 'or the adapter');
  } finally {
    await gateway.stop();
  }
});

test('a slow DM lookup before message.read holds the watchdog on a provider that hosts its own loop', async () => {
  // The refusal check runs before any tool event, so on a streaming
  // provider that hosts its own loop nothing tells the watchdog a tool is
  // being judged. A channel lookup slower than the idle timeout must not
  // read as a stalled model.
  const home = await newHome();
  await writeSoul(home, 'ava.md', '---\nname: Ava\nid: ava\nprovider: anthropic\ntools: [message.read]\n---\n\nYou are Ava.\n');
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ anthropic: { type: 'oauth_token', value: 'sk-ant-oat' } }),
  );
  const IDLE_MS = 300;
  let toolText = '';
  const queryFn = ((params: { options?: unknown }) => {
    const options = params.options as {
      mcpServers?: Record<string, {
        instance?: { _registeredTools?: Record<string, { handler: (a: unknown, b: unknown) => Promise<unknown> }> };
      }>;
    };
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sdk-1' };
      yield {
        type: 'stream_event',
        session_id: 'sdk-1',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'reading' } },
      };
      const handler = options.mcpServers?.stratus?.instance?._registeredTools?.message_read?.handler;
      if (!handler) {
        throw new Error('the tool was not bridged');
      }
      toolText = JSON.stringify(await handler({ source: { channel: 'fixture', to: 'D123' } }, {}));
      yield { type: 'result', subtype: 'success', is_error: false, result: 'all done', session_id: 'sdk-1' };
    })();
  }) as never;
  const host = await hostFor({
    'stratus-plugin-chan-a': {
      manifest: manifest({ channels: [{ name: 'fixture' }] }),
      module: plugin('a', (context) => {
        context.channels!.register({
          agents: ['ava'],
          adapter: {
            name: 'fixture',
            async start() {},
            async stop() {},
            async conversationKindFor() {
              await new Promise((resolve) => setTimeout(resolve, IDLE_MS * 3));
              return 'direct';
            },
            async readConversation() {
              throw new Error('never reached');
            },
          },
        });
      }),
    },
  });
  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: {}, queryFn },
    idleTimeoutMs: IDLE_MS,
    plugins: { 'stratus-plugin-chan-a': {} },
    pluginHost: host,
    approvals: { approve: async () => true },
    log: () => {},
    warn: () => {},
  });
  await gateway.start();
  try {
    const session = await gateway.dispatch({ sessionId: 'slow-kind-1', agentId: 'ava', userMessage: 'read D123' });
    assert.equal(session.status, 'completed', `session failed: ${session.lastError ?? ''}`);
    assert.match(toolText, /approval cannot unlock/);
  } finally {
    await gateway.stop();
  }
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
    // The transcript says where its commands ran, under the registered name
    // — and no caller can say otherwise: the key is the daemon's.
    assert.equal(session.metadata?.executor, 'fixture');
    await assert.rejects(
      gateway.dispatch({ sessionId: 'exec-2', agentId: 'ava', userMessage: 'hi', metadata: { executor: 'sandbox' } }),
      /Session metadata key "executor" is reserved/,
    );
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

  // The record follows the daemon: a session begun before the executor
  // was selected is resumed with the executor that now runs its commands.
  const before = createGateway({ env: { homeDir: home, cwd: home, processEnv: {} }, idleTimeoutMs: 0, log: () => {}, warn: () => {} });
  await before.start();
  try {
    const first = await before.dispatch({ sessionId: 'exec-resumed', agentId: 'ava', userMessage: 'hello' });
    assert.equal(first.metadata?.executor, 'local-command');
  } finally {
    await before.stop();
  }
  const after = createGateway({
    env: { homeDir: home, cwd: home, processEnv: {} },
    idleTimeoutMs: 0,
    plugins: { 'stratus-plugin-fixture-executor': {} },
    pluginHost: host,
    executor: 'fixture',
    log: () => {},
    warn: () => {},
  });
  await after.start();
  try {
    const resumed = await after.dispatch({ sessionId: 'exec-resumed', agentId: 'ava', userMessage: 'please use the echo tool' });
    assert.equal(resumed.metadata?.executor, 'fixture');
  } finally {
    await after.stop();
  }

  const noStore = createGateway({
    env: { homeDir: home, cwd: home, processEnv: {} },
    idleTimeoutMs: 0,
    memoryStore: 'vector',
    log: () => {},
    warn: () => {},
  });
  await assert.rejects(noStore.start(), /selects memoryStore vector, which no loaded plugin registers\. Enable the plugin/);
});
