import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/sdk/client/stdio.js';
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

import {
  createMcpPlugin,
  normalizeCallResult,
  sanitizeToolSegment,
  sealedStdioEnv,
  pathGrant,
  type McpPluginOptions,
} from '../src/index.ts';

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

test('a call held across a reconnect that changed the tool is refused, not run against the replacement', async () => {
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
  await loadThroughView(plugin, target);
  const keepAlive = setInterval(() => {}, 50);
  try {
    // The runner holds the Tool object it resolved when the call was
    // issued — for a gated call, across the wait for a human's approval.
    const held = target.get('mcp.linear.create_issue')!;
    const heldUnchanged = target.get('mcp.linear.get_issue')!;

    // The server restarts advertising the same name with a different
    // definition; its sibling comes back identical.
    build.current = (server) => {
      server.registerTool(
        'create_issue',
        { description: 'Create an issue AND assign it.', inputSchema: { title: z.string() } },
        async ({ title }) => ({ content: [{ type: 'text', text: `created and assigned: ${title}` }] }),
      );
      server.registerTool(
        'get_issue',
        {
          description: 'Read an issue.',
          annotations: { readOnlyHint: true },
          inputSchema: { id: z.string() },
        },
        async ({ id }) => ({ content: [{ type: 'text', text: `issue ${id}` }] }),
      );
    };
    await handle.closeCurrent();
    await reconnected;

    // What a human approved is the original definition; the held call
    // must fail rather than feed its input to the replacement.
    await assert.rejects(
      held.execute({ title: 'Ship it' }, sessionFor('ava')),
      /changed on MCP server linear after this call was issued/,
    );
    // An identical descriptor keeps its identity across the reconnect, so
    // only an actual change fails a held call.
    assert.equal(await heldUnchanged.execute({ id: 'ENG-1' }, sessionFor('ava')), 'issue ENG-1');
    // A fresh call resolves the replacement tool from the registry and runs.
    const fresh = target.get('mcp.linear.create_issue')!;
    assert.equal(await fresh.execute({ title: 'Ship it' }, sessionFor('ava')), 'created and assigned: Ship it');
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

test('an empty-string pagination cursor is passed back verbatim, not dropped as falsy', async () => {
  const transportFor = async (): Promise<Transport> => {
    const server = new Server({ name: 'pager', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      // A compliant server may hand out any string as a cursor, "" included.
      // Dropped on truthiness, the client refetches this first page forever.
      if (request.params?.cursor === '') {
        return { tools: [{ name: 'second', inputSchema: { type: 'object' as const } }] };
      }
      return { tools: [{ name: 'first', inputSchema: { type: 'object' as const } }], nextCursor: '' };
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    return clientTransport;
  };
  const target = new ToolRegistry();
  const plugin = createMcpPlugin(
    { servers: { pager: { url: 'http://127.0.0.1:9/unused' } } },
    { transportFor, warn: () => {}, log: () => {}, reconnectDelayMs: () => 3_600_000 },
  );
  await loadThroughView(plugin, target);
  try {
    assert.deepEqual(
      target.list().map((tool) => tool.name).sort(),
      ['mcp.pager.first', 'mcp.pager.second'],
    );
  } finally {
    await plugin.dispose?.();
  }
});

test('discovery shares one connect budget across pages instead of resetting it per request', async () => {
  // Distinct cursors on every page, so only the deadline can end the walk —
  // and a fake clock that leaps forward on each read, so time "passes"
  // without the test waiting on anything.
  const transportFor = async (): Promise<Transport> => {
    const server = new Server({ name: 'slowpager', version: '1.0.0' }, { capabilities: { tools: {} } });
    let page = 0;
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      page += 1;
      return { tools: [], nextCursor: `page-${page}` };
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    return clientTransport;
  };
  let clock = 0;
  const warnings: string[] = [];
  const plugin = createMcpPlugin(
    { servers: { slowpager: { url: 'http://127.0.0.1:9/unused' } } },
    {
      transportFor,
      warn: (message) => warnings.push(message),
      log: () => {},
      reconnectDelayMs: () => 3_600_000,
      now: () => {
        const at = clock;
        clock += 8_000;
        return at;
      },
    },
  );
  const target = new ToolRegistry();
  await loadThroughView(plugin, target);
  try {
    assert.equal(target.list().length, 0);
    // With a fresh budget per page, this server's instant pages would run
    // into the page-count guard instead — a different refusal.
    assert.match(
      warnings.find((message) => message.includes('slowpager')) ?? '',
      /did not finish tool discovery within its 15000ms connect budget/,
    );
  } finally {
    await plugin.dispose?.();
  }
});

test('a connection that closes during discovery is not published as connected', async () => {
  const build = { current: linearTools };
  const handle = fakeServer(build);
  let transportForCalls = 0;
  let signalConnected = () => {};
  const connectedOnce = new Promise<void>((resolve) => {
    signalConnected = resolve;
  });
  // The first dial closes the moment the tools/list response has been
  // delivered — before connect() can publish the client — as a server
  // crashing right after answering would.
  const closingWrapperFor = async (): Promise<Transport> => {
    const inner = await handle.transportFor();
    const wrapper: Transport = {
      async start() {
        inner.onmessage = (message, extra) => {
          wrapper.onmessage?.(message, extra);
          const shaped = message as { result?: { tools?: unknown } };
          if (shaped.result?.tools !== undefined) {
            void inner.close();
          }
        };
        inner.onerror = (error) => wrapper.onerror?.(error);
        inner.onclose = () => wrapper.onclose?.();
        await inner.start();
      },
      send: (message, sendOptions) => inner.send(message, sendOptions),
      close: () => inner.close(),
    };
    return wrapper;
  };
  const target = new ToolRegistry();
  const plugin = createMcpPlugin(
    { servers: { linear: { url: 'http://127.0.0.1:9/unused' } } },
    {
      transportFor: () => {
        transportForCalls += 1;
        return transportForCalls === 1 ? closingWrapperFor() : handle.transportFor();
      },
      warn: () => {},
      log: () => {},
      reconnectDelayMs: () => 1,
      onConnected: () => signalConnected(),
    },
  );
  const keepAlive = setInterval(() => {}, 50);
  await loadThroughView(plugin, target);
  try {
    await connectedOnce;
    // The dead first dial was treated as a failed connect and retried —
    // never marked connected, which onConnected firing on attempt one
    // (with only one dial made) would betray.
    assert.equal(transportForCalls, 2);
    const tool = target.get('mcp.linear.get_issue');
    assert.ok(tool);
    assert.equal(await tool!.execute({ id: 'ENG-1' }, sessionFor('ava')), 'issue ENG-1');
  } finally {
    clearInterval(keepAlive);
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

test('a stdio server gets what the operator granted, and the transport inherits nothing on its own', () => {
  // StdioClientTransport spawns with { ...getDefaultEnvironment(), ...env },
  // so a scrubbed env is a floor the caller cannot lower by passing one. A
  // server mounted with `passEnv: []` received all six of the SDK's names
  // anyway, while tool-shell — same shared constant, direct spawn — did not.
  const sealed = sealedStdioEnv({ LINEAR_API_KEY: 'lin_api_test' });

  assert.equal(sealed.LINEAR_API_KEY, 'lin_api_test');
  for (const name of DEFAULT_INHERITED_ENV_VARS) {
    assert.ok(name in sealed, `${name} must be answered here, not left to the transport`);
    // Dropped by spawn rather than set empty: a server seeing no USER is not
    // the same as one seeing an empty USER.
    assert.equal(sealed[name], undefined, `${name} was not granted`);
  }

  // A granted name keeps its value and is never refused — the common case,
  // since PATH and HOME are both in DEFAULT_SUBPROCESS_PASS_ENV and on the
  // transport's list.
  const withPath = sealedStdioEnv({ PATH: '/usr/bin', HOME: '/home/agent' });
  assert.equal(withPath.PATH, '/usr/bin');
  assert.equal(withPath.HOME, '/home/agent');
  assert.equal(withPath.SHELL, undefined);
});

test('a bare command with no PATH granted is refused at load, not left to resolve somewhere', async () => {
  // The child's PATH is only what the config granted, so a bare command has
  // no search path — and the runtime signal cannot be trusted to say so: on
  // Windows the SDK spawns through cross-spawn, whose resolver hands an
  // absent PATH to `which`, which falls back to the daemon's own PATH. So a
  // bare command would resolve against exactly the environment this config
  // declined to grant.
  await assert.rejects(
    async () => {
      const plugin = createMcpPlugin({
        enabled: true,
        servers: { sealed: { command: 'npx', passEnv: [] } },
      });
      await plugin.setup?.({ bus: new EventBus(), tools: new ToolRegistry() } as never);
    },
    /passEnv does not grant PATH/,
  );

  // An absolute command needs no search path, so it is fine with none.
  const absolute = createMcpPlugin({
    enabled: true,
    servers: { sealed: { command: '/usr/bin/definitely-not-installed', passEnv: [] } },
  }, { warn: () => {} });
  await absolute.setup?.({ bus: new EventBus(), tools: new ToolRegistry() } as never);
  await absolute.dispose?.();

  // Granting PATH keeps a bare command working.
  const granted = createMcpPlugin({
    enabled: true,
    servers: { sealed: { command: 'definitely-not-on-any-path', env: { PATH: '/usr/bin' }, passEnv: [] } },
  }, { warn: () => {} });
  await granted.setup?.({ bus: new EventBus(), tools: new ToolRegistry() } as never);
  await granted.dispose?.();
});

test('every inherited name leaves the seal once, in the transport\'s spelling', () => {
  // The rule is not about PATH. It holds for every name the transport would
  // inherit, and it was written for PATH alone once already — which is how a
  // granted `UserProfile` ended up with no `USERPROFILE` entry to override
  // the daemon's copy with.
  //
  // The loop walks the SDK's own list, which is fixed to the host platform at
  // module load: the POSIX names here, the Windows ones on a Windows runner.
  // So this exercises the canonicalization mechanism through whichever names
  // exist, which is the part that is ours; which names the SDK lists is not.
  for (const name of DEFAULT_INHERITED_ENV_VARS) {
    const mixed = `${name[0]}${name.slice(1).toLowerCase()}`;

    // Windows: one spelling, canonical, carrying the grant.
    const win = sealedStdioEnv({ [mixed]: '/granted' }, 'win32');
    const winSpellings = Object.keys(win).filter((key) => key.toLowerCase() === name.toLowerCase());
    assert.deepEqual(winSpellings, [name], `win32 ${mixed}: one canonical spelling`);
    assert.equal(win[name], name === 'PATH' ? '/granted' : '/granted');

    // POSIX: a different casing is a different variable, so the inherited
    // name stays sealed and the operator's odd one is simply theirs.
    const posix = sealedStdioEnv({ [mixed]: '/granted' }, 'linux');
    if (mixed !== name) {
      assert.equal(posix[name], undefined, `linux ${mixed}: ${name} stays sealed`);
      assert.equal(posix[mixed], '/granted');
    }

    // Ungranted, either way: answered with a refusal rather than left out.
    for (const platform of ['win32', 'linux'] as const) {
      assert.ok(name in sealedStdioEnv({}, platform), `${platform}: ${name} must be answered`);
      assert.equal(sealedStdioEnv({}, platform)[name], undefined);
    }
  }
});

test('exactly one usable search path leaves the seal, whatever the grant looked like', () => {
  // An invariant test rather than a case list, because this has now been
  // wrong in three different ways and each fix addressed only the shape that
  // was reported. What must hold, on both platforms: the key the transport
  // merges under is present, it carries the granted value or nothing, and it
  // is never empty and never the daemon's.
  const grants: Array<Record<string, string>> = [
    {},
    { PATH: '/granted' },
    { Path: '/granted' },
    { PATH: '' },
    { Path: '' },
    { PATH: '/upper', Path: '/mixed' },
    { LINEAR_API_KEY: 'k' },
  ];

  for (const platform of ['win32', 'linux'] as const) {
    for (const granted of grants) {
      const sealed = sealedStdioEnv(granted, platform);
      assert.ok('PATH' in sealed, `${platform} ${JSON.stringify(granted)}: PATH must be answered`);
      assert.notEqual(sealed.PATH, '', 'an empty search path is a fallback to the daemon, never a grant');

      if (platform === 'win32') {
        // One spelling only: a second is the same variable, and which one the
        // runtime picks is not ours to guess.
        const spellings = Object.keys(sealed).filter((key) => key.toLowerCase() === 'path');
        assert.deepEqual(spellings, ['PATH'], `win32 ${JSON.stringify(granted)}: one spelling`);
      }

      const expected = pathGrant(granted, platform);
      assert.equal(sealed.PATH, expected, `${platform} ${JSON.stringify(granted)}: the granted value or nothing`);
    }
  }

  // The two shapes that were live leaks, named so a regression is legible.
  assert.equal(sealedStdioEnv({ Path: 'C:\\mcp-bin' }, 'win32').PATH, 'C:\\mcp-bin');
  assert.equal(sealedStdioEnv({ PATH: '' }, 'linux').PATH, undefined);
});

test('the search-path grant is spelled the way the platform spells it', () => {
  // Windows names are case-insensitive and `Path` is the spelling it uses, so
  // refusing that there would reject a config that granted the variable fine.
  assert.equal(pathGrant({ Path: '/custom/bin' }, 'win32'), '/custom/bin');
  assert.equal(pathGrant({ PATH: '/custom/bin' }, 'win32'), '/custom/bin');

  // POSIX names are case-sensitive and only PATH drives executable lookup.
  // Accepting `Path` there would pass a grant that does nothing: the child is
  // handed `Path`, `PATH` is sealed away as ungranted, and a bare command has
  // no search path at all — defeating the refusal this feeds.
  assert.equal(pathGrant({ PATH: '/custom/bin' }, 'linux'), '/custom/bin');
  assert.equal(pathGrant({ Path: '/custom/bin' }, 'linux'), undefined);
  assert.equal(sealedStdioEnv({ Path: '/custom/bin' }, 'linux').PATH, undefined);

  // The seal has to ask the same question the grant check asks. On Windows a
  // granted `Path` IS PATH — so rather than either sealing an uppercase
  // refusal beside it (the seal contradicting the grant) or leaving the
  // grant alone (the transport's own uppercase default then shadowing it),
  // the grant is canonicalized onto the one spelling the transport merges
  // under. Both of the other two shapes were live bugs.
  const windows = sealedStdioEnv({ Path: '/custom/bin' }, 'win32');
  assert.equal(windows.PATH, '/custom/bin', 'the grant, under the transport\'s spelling');
  assert.equal('Path' in windows, false, 'no second spelling of the same variable');

  // On POSIX they are genuinely different names, so the ungranted PATH is
  // still sealed away and only the useless `Path` survives — which is what
  // makes the load-time refusal fire for a bare command.
  const posix = sealedStdioEnv({ Path: '/custom/bin' }, 'linux');
  assert.equal(posix.Path, '/custom/bin');
  assert.equal(posix.PATH, undefined);
  assert.equal('PATH' in posix, true, 'sealed, not simply absent');
});
