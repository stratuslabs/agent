import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';

import {
  AgentRunner,
  EventBus,
  ToolRegistry,
  resolveToolRisk,
  type JsonObject,
  type ModelProvider,
  type Plugin,
  type Session,
  type Tool,
} from '@stratusagent/core';
import { ManifestBoundToolRegistry, parsePluginManifest } from '@stratusagent/plugins';

import { createMcpPlugin, normalizeCallResult, sanitizeToolSegment, type McpPluginOptions } from '../src/index.ts';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const sessionFor = (agentId: string): Session => ({
  id: `${agentId}-session`,
  agent: { id: agentId, name: agentId },
  status: 'running',
  messages: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

/**
 * The registration view the loader would build for this exact package —
 * from the shipped manifest, so these tests exercise the real contract
 * (`toolsDiscovered: mcp.*` at `gated`) rather than a bare registry.
 */
const viewFor = async (target: ToolRegistry): Promise<ManifestBoundToolRegistry> => {
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')) as unknown;
  const manifest = parsePluginManifest(packageJson, '@stratusagent/plugin-mcp');
  return new ManifestBoundToolRegistry({ manifest, target, trusted: true });
};

/** Load the plugin the way the loader does: setup through the view, then commit. */
const loadThroughView = async (plugin: Plugin, target: ToolRegistry): Promise<ManifestBoundToolRegistry> => {
  const view = await viewFor(target);
  await plugin.setup({ bus: new EventBus(), tools: view });
  view.commit(new Map());
  return view;
};

interface FakeServerHandle {
  transportFor: () => Promise<Transport>;
  /** Close the server end of the latest connection, as a dying server would. */
  closeCurrent: () => Promise<void>;
}

/**
 * An in-memory MCP server the bridge dials through the `transportFor`
 * seam. Each dial builds a fresh server from the current `build` function,
 * so a reconnect can find a different tool list — which is exactly the
 * case under test.
 */
const fakeServer = (build: { current: (server: McpServer) => void }): FakeServerHandle => {
  let serverSide: Transport | undefined;
  return {
    async transportFor() {
      const server = new McpServer({ name: 'fake', version: '1.0.0' });
      build.current(server);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      serverSide = serverTransport;
      await server.connect(serverTransport);
      return clientTransport;
    },
    async closeCurrent() {
      await serverSide?.close();
    },
  };
};

const linearTools = (server: McpServer): void => {
  server.registerTool(
    'create_issue',
    {
      description: 'Create an issue.',
      inputSchema: { title: z.string() },
    },
    async ({ title }) => ({ content: [{ type: 'text', text: `created: ${title}` }] }),
  );
  server.registerTool(
    'get_issue',
    {
      description: 'Read an issue.',
      // The server's own word that this is harmless — which is exactly the
      // input the trust model says not to take at face value.
      annotations: { readOnlyHint: true },
      inputSchema: { id: z.string() },
    },
    async ({ id }) => ({ content: [{ type: 'text', text: `issue ${id}` }] }),
  );
};

const pluginFor = (handle: FakeServerHandle, config: JsonObject = {}, options: McpPluginOptions = {}): Plugin =>
  createMcpPlugin(
    { servers: { linear: { url: 'http://127.0.0.1:9/unused' } }, ...config },
    { transportFor: () => handle.transportFor(), warn: () => {}, log: () => {}, ...options },
  );

test('discovered tools register as mcp.<server>.<tool>, gated even when the server calls them read-only', async () => {
  const handle = fakeServer({ current: linearTools });
  const target = new ToolRegistry();
  const plugin = pluginFor(handle);
  await loadThroughView(plugin, target);
  try {
    const names = target.list().map((tool) => tool.name).sort();
    assert.deepEqual(names, ['mcp.linear.create_issue', 'mcp.linear.get_issue']);
    // The readOnlyHint changed nothing: risk is ours, and every bridged
    // tool floors at gated until the operator's toolRisks says otherwise.
    assert.equal(resolveToolRisk(target.get('mcp.linear.get_issue')), 'gated');
    assert.equal(resolveToolRisk(target.get('mcp.linear.create_issue')), 'gated');
    const descriptor = target.get('mcp.linear.create_issue');
    assert.equal((descriptor?.parameters as JsonObject | undefined)?.type, 'object');
  } finally {
    await plugin.dispose?.();
  }
});

test('a call round-trips: arguments over, text back as a plain string', async () => {
  const handle = fakeServer({ current: linearTools });
  const target = new ToolRegistry();
  const plugin = pluginFor(handle);
  await loadThroughView(plugin, target);
  try {
    const result = await target.get('mcp.linear.create_issue')!.execute({ title: 'Fix the flake' }, sessionFor('ava'));
    assert.equal(result, 'created: Fix the flake');
  } finally {
    await plugin.dispose?.();
  }
});

test('an agent whose soul allowlists mcp.linear.* calls a bridged tool; one without cannot', async () => {
  const handle = fakeServer({ current: linearTools });
  const target = new ToolRegistry();
  const plugin = pluginFor(handle);
  await loadThroughView(plugin, target);
  try {
    const provider: ModelProvider = {
      name: 'scripted',
      async generate({ session }) {
        if (session.messages.at(-1)?.role === 'tool') {
          return { parts: [{ type: 'text', text: 'done' }] };
        }
        return {
          parts: [{
            type: 'tool-call',
            call: { id: 'call-1', toolName: 'mcp.linear.get_issue', input: { id: 'ENG-1' } },
          }],
        };
      },
    };
    const runner = new AgentRunner({ provider, tools: target });

    const granted = await runner.run({
      sessionId: 'granted',
      agent: { id: 'ava', name: 'Ava', tools: ['mcp.linear.*'] },
      userMessage: 'look up ENG-1',
    });
    const grantedResult = granted.messages.find((message) => message.role === 'tool')?.toolResult;
    assert.equal(grantedResult?.ok, true);
    assert.equal(grantedResult?.output, 'issue ENG-1');

    const refused = await runner.run({
      sessionId: 'refused',
      agent: { id: 'juno', name: 'Juno', tools: ['fs.*'] },
      userMessage: 'look up ENG-1',
    });
    const refusedResult = refused.messages.find((message) => message.role === 'tool')?.toolResult;
    assert.equal(refusedResult?.ok, false);
    assert.match(refusedResult?.error ?? '', /not permitted/);
  } finally {
    await plugin.dispose?.();
  }
});

test('a result the server marks isError fails the tool call instead of reading as output', async () => {
  const handle = fakeServer({
    current: (server) => {
      server.registerTool('explode', { description: 'Always fails.' }, async () => ({
        content: [{ type: 'text', text: 'the backend said no' }],
        isError: true,
      }));
    },
  });
  const target = new ToolRegistry();
  const plugin = pluginFor(handle);
  await loadThroughView(plugin, target);
  try {
    await assert.rejects(
      target.get('mcp.linear.explode')!.execute({}, sessionFor('ava')),
      /the backend said no/,
    );
  } finally {
    await plugin.dispose?.();
  }
});

test('structured content passes through, and an image lands in the per-agent workspace as a files entry', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const handle = fakeServer({
    current: (server) => {
      server.registerTool(
        'chart',
        {
          description: 'Render a chart.',
          outputSchema: { points: z.number() },
        },
        async () => ({
          content: [
            { type: 'text', text: 'rendered' },
            { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
          ],
          structuredContent: { points: 4 },
        }),
      );
    },
  });
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'stratus-mcp-ws-'));
  const target = new ToolRegistry();
  const plugin = pluginFor(handle, { workspaceRoot });
  await loadThroughView(plugin, target);
  try {
    const output = await target.get('mcp.linear.chart')!.execute({}, sessionFor('ava')) as JsonObject;
    assert.equal(output.text, 'rendered');
    assert.deepEqual(output.structured, { points: 4 });
    const files = output.files as string[];
    assert.equal(files.length, 1);
    // Per agent, under the server's own directory — the same containment
    // screenshots get, and `files` is the key a channel uploads from,
    // which is how this image reaches Slack.
    assert.ok(files[0]!.startsWith(path.join(workspaceRoot, 'ava', 'mcp', 'linear') + path.sep));
    assert.ok(files[0]!.endsWith('.png'));
    assert.deepEqual(await readFile(files[0]!), png);
    assert.deepEqual(await readdir(path.join(workspaceRoot, 'ava', 'mcp', 'linear')), [path.basename(files[0]!)]);
  } finally {
    await plugin.dispose?.();
  }
});

test('a server that is unreachable at startup leaves the rest serving, with an install-hint log line', async () => {
  const handle = fakeServer({ current: linearTools });
  const warnings: string[] = [];
  const plugin = createMcpPlugin(
    {
      servers: {
        linear: { url: 'http://127.0.0.1:9/unused' },
        flaky: { url: 'http://127.0.0.1:9/unused' },
      },
    },
    {
      transportFor: (spec) => {
        if (spec.name === 'flaky') {
          throw new Error('connection refused');
        }
        return handle.transportFor();
      },
      warn: (message) => warnings.push(message),
      log: () => {},
      // Far away, so nothing reconnects underneath the assertions.
      reconnectDelayMs: () => 3_600_000,
    },
  );
  const target = new ToolRegistry();
  await loadThroughView(plugin, target);
  try {
    assert.ok(target.get('mcp.linear.create_issue'), 'the reachable server still mounted');
    assert.equal(target.list().some((tool) => tool.name.startsWith('mcp.flaky.')), false);
    const hint = warnings.find((message) => message.includes('flaky'));
    assert.ok(hint, 'the unreachable server was reported');
    assert.match(hint!, /servers\.flaky/);
    assert.match(hint!, /connection refused/);
  } finally {
    await plugin.dispose?.();
  }
});

test('a tool discovered only on reconnect registers, and one no longer advertised unregisters', async () => {
  const build = { current: linearTools };
  const handle = fakeServer(build);
  const target = new ToolRegistry();
  let connections = 0;
  let signalReconnected = () => {};
  const reconnected = new Promise<void>((resolve) => {
    signalReconnected = resolve;
  });
  const plugin = pluginFor(handle, {}, {
    reconnectDelayMs: () => 1,
    onConnected: () => {
      connections += 1;
      if (connections === 2) {
        signalReconnected();
      }
    },
  });
  const view = await loadThroughView(plugin, target);
  // The bridge's reconnect timer is unref'd on purpose (a one-shot CLI run
  // must not be held open by a dead server), so the test keeps the event
  // loop alive itself while it waits on the reconnect gate.
  const keepAlive = setInterval(() => {}, 50);
  try {
    assert.ok(target.get('mcp.linear.get_issue'));
    assert.equal(target.get('mcp.linear.list_projects'), undefined);

    // The server restarts with a different tool list: get_issue is gone,
    // list_projects is new.
    build.current = (server) => {
      server.registerTool(
        'create_issue',
        { description: 'Create an issue.', inputSchema: { title: z.string() } },
        async ({ title }) => ({ content: [{ type: 'text', text: `created: ${title}` }] }),
      );
      server.registerTool('list_projects', { description: 'List projects.' }, async () => ({
        content: [{ type: 'text', text: 'projects: one' }],
      }));
    };
    await handle.closeCurrent();
    await reconnected;

    const added = target.get('mcp.linear.list_projects');
    assert.ok(added, 'a tool discovered only on reconnect registers');
    assert.equal(resolveToolRisk(added), 'gated', 'the namespace risk applies identically on reconnect');
    assert.equal(target.get('mcp.linear.get_issue'), undefined, 'a tool no longer advertised unregisters');
    assert.equal(await added!.execute({}, sessionFor('ava')), 'projects: one');
    // And the committed view is still the boundary: nothing outside mcp.*
    // can have appeared through the reconnect path.
    assert.throws(() => view.register({ name: 'fs.write', async execute() { return null; } } as Tool));
  } finally {
    clearInterval(keepAlive);
    await plugin.dispose?.();
  }
});

test('an HTTP session lost mid-call marks the server down and reconnects — onclose never fires on that path', async () => {
  // A sessionful Streamable HTTP server that restarted: the handshake
  // worked, and later requests fail on the wire (a 404 for the stale
  // mcp-session-id) without the transport ever closing. The bridge must
  // notice on the call path or it re-sends into the dead session forever.
  const build = { current: linearTools };
  const handle = fakeServer(build);
  let failSends = false;
  const failingWrapperFor = async (): Promise<Transport> => {
    const inner = await handle.transportFor();
    const wrapper: Transport = {
      async start() {
        inner.onmessage = (message, extra) => wrapper.onmessage?.(message, extra);
        inner.onerror = (error) => wrapper.onerror?.(error);
        inner.onclose = () => wrapper.onclose?.();
        await inner.start();
      },
      async send(message, sendOptions) {
        if (failSends) {
          throw new StreamableHTTPError(404, 'Error POSTing to endpoint: session not found');
        }
        await inner.send(message, sendOptions);
      },
      async close() {
        await inner.close();
      },
    };
    return wrapper;
  };

  let connections = 0;
  let signalReconnected = () => {};
  const reconnected = new Promise<void>((resolve) => {
    signalReconnected = resolve;
  });
  const target = new ToolRegistry();
  const plugin = createMcpPlugin(
    { servers: { linear: { url: 'http://127.0.0.1:9/unused' } } },
    {
      // The first connect goes through the failing wrapper; the reconnect
      // dials the restarted server directly.
      transportFor: () => (connections === 0 ? failingWrapperFor() : handle.transportFor()),
      warn: () => {},
      log: () => {},
      reconnectDelayMs: () => 1,
      onConnected: () => {
        connections += 1;
        if (connections === 2) {
          signalReconnected();
        }
      },
    },
  );
  await loadThroughView(plugin, target);
  const keepAlive = setInterval(() => {}, 50);
  try {
    const tool = target.get('mcp.linear.get_issue')!;
    assert.equal(await tool.execute({ id: 'ENG-1' }, sessionFor('ava')), 'issue ENG-1');

    failSends = true;
    await assert.rejects(tool.execute({ id: 'ENG-2' }, sessionFor('ava')), /session not found/);
    // The very next call — before the reconnect can have run — refuses as
    // disconnected instead of re-sending into the dead session, which is
    // the state transition the fix exists for.
    await assert.rejects(tool.execute({ id: 'ENG-3' }, sessionFor('ava')), /is not connected/);

    await reconnected;
    assert.equal(await tool.execute({ id: 'ENG-4' }, sessionFor('ava')), 'issue ENG-4');
  } finally {
    clearInterval(keepAlive);
    await plugin.dispose?.();
  }
});

test('two server tools that fold to one bridged name refuse the server at load', async () => {
  const handle = fakeServer({
    current: (server) => {
      server.registerTool('do_thing', { description: 'One.' }, async () => ({ content: [] }));
      server.registerTool('DO_THING', { description: 'Two.' }, async () => ({ content: [] }));
    },
  });
  const target = new ToolRegistry();
  const plugin = pluginFor(handle);
  const view = await viewFor(target);
  await assert.rejects(
    Promise.resolve(plugin.setup({ bus: new EventBus(), tools: view })),
    /both bridge to mcp\.linear\.do_thing/,
  );
  await plugin.dispose?.();
});

test('a server name that cannot be a name segment is refused as configuration', () => {
  assert.throws(
    () => createMcpPlugin({ servers: { 'Linear Prod': { url: 'http://127.0.0.1:9/' } } }),
    /Server name/,
  );
  assert.throws(
    () => createMcpPlugin({ servers: { linear: {} } }),
    /exactly one of "command" \(stdio\) or "url"/,
  );
  assert.throws(() => createMcpPlugin({}), /needs a "servers" object/);
});

test('dispose() cuts a connect still mid-handshake instead of waiting out its timeout', async () => {
  // A transport whose server end never answers: connect() suspends
  // awaiting the initialize response, which is exactly when a daemon
  // stopping must not have to wait for the connect timeout — for a stdio
  // server the pending transport is a live child process.
  let closeCalled = false;
  let handed = () => {};
  const transportHanded = new Promise<void>((resolve) => {
    handed = resolve;
  });
  const hanging: Transport = {
    async start() {},
    async send() {},
    async close() {
      closeCalled = true;
      this.onclose?.();
    },
  };
  const plugin = createMcpPlugin(
    { servers: { slow: { url: 'http://127.0.0.1:9/unused' } } },
    {
      transportFor: () => {
        handed();
        return hanging;
      },
      warn: () => {},
      log: () => {},
    },
  );
  const target = new ToolRegistry();
  const view = await viewFor(target);
  const settingUp = plugin.setup({ bus: new EventBus(), tools: view });
  await transportHanded;
  // One macrotask turn drains every microtask, which carries connect() to
  // its suspension point — awaiting a response that never comes.
  await new Promise((resolve) => setImmediate(resolve));

  await plugin.dispose?.();
  assert.equal(closeCalled, true, 'dispose reached the in-flight transport directly');
  // Unblocked by the close, not by a timeout: the rejected handshake takes
  // the unreachable-server path and setup resolves.
  await settingUp;
});

test('a mistyped grant is refused, never silently ignored', () => {
  // A passEnv that is not an array of names would silently fall back to
  // the default list — the server starts without its token and fails
  // somewhere far from the actual mistake.
  assert.throws(
    () => createMcpPlugin({ servers: { s: { command: 'srv', passEnv: 'GITHUB_TOKEN' } } }),
    /passEnv must be an array of strings/,
  );
  assert.throws(
    () => createMcpPlugin({ servers: { s: { command: 'srv', args: [1] } } }),
    /args must be an array of strings/,
  );
  // A setting on the wrong transport kind is a belief about the server
  // that is not true — headers an operator thinks carry a bearer token,
  // env they think reaches a subprocess.
  assert.throws(
    () => createMcpPlugin({ servers: { s: { command: 'srv', headers: { Authorization: 'Bearer x' } } } }),
    /headers only applies to an HTTP server/,
  );
  assert.throws(
    () => createMcpPlugin({ servers: { s: { url: 'http://127.0.0.1:9/', env: { KEY: 'v' } } } }),
    /env only applies to a stdio server/,
  );
});

test('a server that pages tools/list forever is refused as unreachable instead of holding setup', async () => {
  const transportFor = async (): Promise<Transport> => {
    const server = new Server({ name: 'pager', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [], nextCursor: 'again' }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    return clientTransport;
  };
  const warnings: string[] = [];
  const plugin = createMcpPlugin(
    { servers: { pager: { url: 'http://127.0.0.1:9/unused' } } },
    { transportFor, warn: (message) => warnings.push(message), log: () => {}, reconnectDelayMs: () => 3_600_000 },
  );
  const target = new ToolRegistry();
  await loadThroughView(plugin, target);
  try {
    assert.equal(target.list().length, 0);
    assert.match(warnings.find((message) => message.includes('pager')) ?? '', /pages of tools\/list/);
  } finally {
    await plugin.dispose?.();
  }
});

test('a binary block cannot steer the written path: the server-side tool name is folded before it names a file', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'stratus-mcp-traversal-'));
  const output = await normalizeCallResult(
    { content: [{ type: 'image', data: Buffer.from('x').toString('base64'), mimeType: 'image/png' }] },
    { server: 'linear', tool: '../../../escape', agentId: 'ava', workspaceRoot },
  ) as JsonObject;
  const [file] = output.files as string[];
  const directory = path.join(workspaceRoot, 'ava', 'mcp', 'linear');
  assert.ok(file!.startsWith(directory + path.sep), `stayed inside the server directory: ${file}`);
  assert.ok(path.basename(file!).startsWith('escape-'));
});

test('two writes in the same millisecond get distinct files', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'stratus-mcp-serial-'));
  const block = { content: [{ type: 'image', data: Buffer.from('x').toString('base64'), mimeType: 'image/png' }] };
  const context = { server: 'linear', tool: 'chart', agentId: 'ava', workspaceRoot, now: () => 42 };
  const first = await normalizeCallResult(block, context) as JsonObject;
  const second = await normalizeCallResult(block, context) as JsonObject;
  assert.notEqual((first.files as string[])[0], (second.files as string[])[0]);
});

test('a failing result writes nothing: isError is settled before any block touches the disk', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'stratus-mcp-iserror-'));
  await assert.rejects(
    normalizeCallResult(
      {
        isError: true,
        content: [
          { type: 'image', data: Buffer.from('x').toString('base64'), mimeType: 'image/png' },
          { type: 'text', text: 'it broke' },
        ],
      },
      { server: 'linear', tool: 'chart', agentId: 'ava', workspaceRoot },
    ),
    /it broke/,
  );
  await assert.rejects(readdir(path.join(workspaceRoot, 'ava', 'mcp', 'linear')), /ENOENT/);
});

test('sanitizeToolSegment folds foreign names into the tool-name shape', () => {
  assert.equal(sanitizeToolSegment('createIssue'), 'createissue');
  assert.equal(sanitizeToolSegment('Create Issue!'), 'create_issue_');
  assert.equal(sanitizeToolSegment('--flag'), 'flag');
  assert.equal(sanitizeToolSegment('!!!'), undefined);
});

test('a stdio server runs under the scrubbed environment: granted names arrive, the daemon secrets do not', async () => {
  // Outside test/, where `node --test` with no arguments would run it as a
  // test file — a stdio server parked on the runner's stdin never exits.
  const fixture = path.join(packageRoot, 'fixtures', 'env-echo-server.mjs');
  const plugin = createMcpPlugin(
    {
      servers: {
        envy: {
          command: process.execPath,
          args: [fixture],
          env: { STRATUS_TEST_GRANTED: 'yes' },
        },
      },
    },
    {
      processEnv: {
        ...process.env,
        ANTHROPIC_API_KEY: 'sk-ant-secret',
        STRATUS_TEST_DAEMON_SECRET: 'daemon-only',
      },
      warn: () => {},
      log: () => {},
    },
  );
  const target = new ToolRegistry();
  await loadThroughView(plugin, target);
  try {
    const tool = target.get('mcp.envy.read_env');
    assert.ok(tool, 'the stdio server connected and its tool registered');
    const raw = await tool!.execute({}, sessionFor('ava'));
    const seen = JSON.parse(raw as string) as Record<string, string | null>;
    assert.equal(seen.anthropicKey, null, 'ANTHROPIC_API_KEY is not readable from a bridged stdio server');
    assert.equal(seen.daemonSecret, null);
    assert.equal(seen.granted, 'yes');
    assert.notEqual(seen.path, null, 'the harmless default inheritance still arrives');
  } finally {
    await plugin.dispose?.();
  }
});
