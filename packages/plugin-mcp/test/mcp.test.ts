import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, renameSync, statSync, symlinkSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
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
import { createFileLedger } from '@stratusagent/plugins';
import { ManifestBoundToolRegistry, parsePluginManifest } from '@stratusagent/plugins';

import {
  createMcpPlugin,
  normalizeCallResult,
  PLUGIN_MCP_VERSION,
  sanitizeToolSegment,
  sealedStdioEnv,
  pathGrant,
  resolveCommandPath,
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
  /** Put a raw message on the wire from the server end, bypassing the server. */
  sendRaw: (message: JSONRPCMessage) => Promise<void>;
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
    async sendRaw(message) {
      await serverSide?.send(message);
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

test('the version the bridge introduces itself with is the version it was published as', async () => {
  // PLUGIN_MCP_VERSION is a second copy of a number that lives in
  // package.json, and it is the one somebody else's server sees: it is the
  // `clientInfo.version` of every handshake, which a server may log or key
  // compatibility on. A release bumps the manifest; nothing makes it bump the
  // constant, and nothing fails if it does not. Same reasoning, and same
  // test, as the CLI's and the control API's own version pins.
  const manifest = JSON.parse(
    await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
  ) as { version: string };

  assert.equal(
    PLUGIN_MCP_VERSION,
    manifest.version,
    'PLUGIN_MCP_VERSION drifted from package.json — the bridge would introduce itself as a version it is not',
  );
});

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
    // A server's bytes on disk, written without `fs.write`: recorded in the
    // same ledger `tool-fs` reads, so a later `fs.read` of the file carries
    // the label this result did rather than arriving as the agent's own.
    const ledger = createFileLedger(workspaceRoot);
    assert.equal(await ledger.lookup('ava', files[0]!), 'external');
  } finally {
    await plugin.dispose?.();
  }
});

test('an image written through a linked workspace is recorded under the path a read would ask for', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const handle = fakeServer({
    current: (server) => {
      server.registerTool('chart', { description: 'Render a chart.' }, async () => ({
        content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }],
      }));
    },
  });
  // The operator moved the workspaces onto another volume and left a link;
  // `fs.read` canonicalizes every path before it asks the ledger, so a
  // record under the link's spelling would never be found.
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-mcp-ws-'));
  const real = path.join(home, 'volume', 'workspaces');
  await mkdir(real, { recursive: true });
  const linked = path.join(home, 'workspaces');
  await symlink(real, linked);
  const target = new ToolRegistry();
  const plugin = pluginFor(handle, { workspaceRoot: linked });
  await loadThroughView(plugin, target);
  try {
    const output = await target.get('mcp.linear.chart')!.execute({}, sessionFor('ava')) as JsonObject;
    const [file] = output.files as string[];
    assert.ok(file);
    assert.equal(file, await realpath(file));
    assert.ok(file.startsWith(path.join(await realpath(real), 'ava', 'mcp', 'linear') + path.sep));
    assert.equal(await createFileLedger(linked).lookup('ava', file), 'external');
  } finally {
    await plugin.dispose?.();
  }
});

test('an image written under a plugin-specific workspace is recorded in the host’s ledger, not one of its own', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const handle = fakeServer({
    current: (server) => {
      server.registerTool('chart', { description: 'Render a chart.' }, async () => ({
        content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }],
      }));
    },
  });
  const artifacts = await mkdtemp(path.join(os.tmpdir(), 'stratus-mcp-artifacts-'));
  const ledgerRoot = await mkdtemp(path.join(os.tmpdir(), 'stratus-mcp-ledger-'));
  const target = new ToolRegistry();
  const plugin = pluginFor(handle, { workspaceRoot: artifacts, ledgerRoot });
  await loadThroughView(plugin, target);
  try {
    const output = await target.get('mcp.linear.chart')!.execute({}, sessionFor('ava')) as JsonObject;
    const [file] = output.files as string[];
    assert.ok(file!.startsWith(path.join(await realpath(artifacts), 'ava') + path.sep));
    assert.equal(await createFileLedger(ledgerRoot).lookup('ava', file!), 'external');
    assert.equal(await createFileLedger(artifacts).lookup('ava', file!), undefined);
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
        // A credential in the endpoint — userinfo, a path segment, a query
        // value — must not reach the log through the hint that names it.
        flaky: { url: 'http://svc:hunter2@127.0.0.1:9/mcp/pathtoken?sig=secretsig' },
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
    assert.equal(hint!.includes('hunter2'), false, hint);
    assert.equal(hint!.includes('secretsig'), false, hint);
    assert.equal(hint!.includes('pathtoken'), false, hint);
    assert.match(hint!, /the endpoint \(http:\/\/127\.0\.0\.1:9\)/);
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

test('lifecycle lines reach the host’s log when the plugin was created without one of its own', async () => {
  // The loader hands the daemon's structured log to setup(); created
  // without log/warn options, the plugin must take it up — before this,
  // every disconnect warning went to console.error and `stratus logs`
  // showed a server dropping as nothing at all.
  const handle = fakeServer({ current: linearTools });
  const target = new ToolRegistry();
  const lines: string[] = [];
  const warnings: string[] = [];
  let connections = 0;
  let signalReconnected = () => {};
  const reconnected = new Promise<void>((resolve) => {
    signalReconnected = resolve;
  });
  const plugin = createMcpPlugin(
    { servers: { linear: { url: 'http://127.0.0.1:9/unused' } } },
    {
      transportFor: () => handle.transportFor(),
      reconnectDelayMs: () => 1,
      onConnected: () => {
        connections += 1;
        if (connections === 2) {
          signalReconnected();
        }
      },
    },
  );
  const view = await viewFor(target);
  await plugin.setup({
    bus: new EventBus(),
    tools: view,
    log: (message) => lines.push(message),
    warn: (message) => warnings.push(message),
  });
  view.commit(new Map());
  const keepAlive = setInterval(() => {}, 50);
  try {
    assert.ok(lines.some((message) => message.includes('mcp server linear connected')), `log: ${lines.join(' | ')}`);
    await handle.closeCurrent();
    await reconnected;
    assert.ok(warnings.some((message) => message.includes('mcp server linear disconnected')), `warn: ${warnings.join(' | ')}`);
  } finally {
    clearInterval(keepAlive);
    await plugin.dispose?.();
  }
});

test('a transport error is logged, and the call it killed says why instead of only "Connection closed"', async () => {
  // What the SDK's stdio reader does with a reply over its buffer limit:
  // report the overflow on onerror, then close the connection. The call in
  // flight sees a bare ConnectionClosed from the SDK.
  let clientTransport: Transport | undefined;
  const handle = fakeServer({
    current: (server) => {
      server.registerTool('big', { description: 'A reply too large to read.' }, async () => {
        clientTransport?.onerror?.(new Error('ReadBuffer exceeded maximum size of 10485760 bytes'));
        // The SDK's close is asynchronous, and stdout it had already
        // queued can still be delivered before the process is gone; a
        // valid message here must not talk the cause out of the record.
        await handle.sendRaw({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
        await handle.closeCurrent();
        return { content: [{ type: 'text', text: 'never delivered' }] };
      });
    },
  });
  const target = new ToolRegistry();
  const warnings: string[] = [];
  // A stdio server: the overflow is its reader's, and only its errors are
  // read as one.
  const plugin = createMcpPlugin(
    { servers: { linear: { command: process.execPath } } },
    {
      warn: (message) => warnings.push(message),
      log: () => {},
      reconnectDelayMs: () => 3_600_000,
      transportFor: async () => {
        clientTransport = await handle.transportFor();
        return clientTransport;
      },
    },
  );
  await loadThroughView(plugin, target);
  try {
    await assert.rejects(
      target.get('mcp.linear.big')!.execute({}, sessionFor('ava')),
      /Connection closed — the server sent a single message larger than the 10485760-byte stdio limit/,
    );
    assert.match(
      warnings.find((message) => message.includes('transport error')) ?? '',
      /mcp server linear transport error: the server sent a single message larger than the 10485760-byte stdio limit/,
    );
  } finally {
    await plugin.dispose?.();
  }
});

test('a protocol-level client error is neither logged nor blamed for a later close, and a parse error is logged without the line', async () => {
  // The SDK routes its own protocol errors through client.onerror too, and
  // a reply arriving after its request timed out becomes "Received a
  // response for an unknown message ID: <the whole response>". That is a
  // tool result; it must reach neither the daemon log nor the error text
  // of whatever fails next. A non-JSON line on stdout is the transport's
  // error, and the line it quotes is a server's stray logging.
  let clientTransport: Transport | undefined;
  const handle = fakeServer({ current: linearTools });
  const target = new ToolRegistry();
  const warnings: string[] = [];
  const plugin = pluginFor(handle, {}, {
    warn: (message) => warnings.push(message),
    reconnectDelayMs: () => 3_600_000,
    transportFor: async () => {
      clientTransport = await handle.transportFor();
      return clientTransport;
    },
  });
  await loadThroughView(plugin, target);
  try {
    const payload = 'secret-result-'.repeat(1000);
    await handle.sendRaw({ jsonrpc: '2.0', id: 999, result: { content: [{ type: 'text', text: payload }] } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(warnings.some((message) => message.includes('transport error')), false, warnings.join(' | '));

    // This server is URL-backed: an HTTP error quoting a body that happens
    // to contain the stdio reader's overflow phrase is still a body, and
    // is bounded like one rather than rewritten as an overflow.
    clientTransport?.onerror?.(new Error(`Streamable HTTP error: Error POSTing to endpoint: ReadBuffer exceeded maximum size of ${'9'.repeat(5000)} bytes`));
    const quoted = warnings.filter((message) => message.includes('transport error')).at(-1) ?? '';
    assert.ok(quoted.length < 400, `${quoted.length} chars`);
    assert.equal(quoted.includes('stdio limit'), false);

    // This server is URL-backed: a SyntaxError here is a body that was not
    // JSON-RPC, and the stdout/stderr advice would be nonsense for it.
    clientTransport?.onerror?.(new SyntaxError('Unexpected token \'g\', "garbage: token=abc" is not valid JSON'));
    const parse = warnings.filter((message) => message.includes('transport error')).at(-1) ?? '';
    assert.match(parse, /answered with a body that is not valid JSON-RPC/);
    assert.equal(parse.includes('garbage'), false);

    // A round trip that completes clears the remembered error, so the
    // close that follows is reported as what it is: a bare closure.
    assert.equal(await target.get('mcp.linear.get_issue')!.execute({ id: '7' }, sessionFor('ava')), 'issue 7');
    const pending = target.get('mcp.linear.get_issue')!.execute({ id: '8' }, sessionFor('ava'));
    await handle.closeCurrent();
    await assert.rejects(pending, (error: Error) => {
      assert.equal(error.message, 'MCP error -32000: Connection closed');
      return true;
    });
    assert.equal(warnings.some((message) => message.includes(payload.slice(0, 40))), false);
  } finally {
    await plugin.dispose?.();
  }
});

test('every line the plugin logs is bounded, whatever a server named its tool', async () => {
  // MCP puts no length on a tool name, and the daemon log rotates at 8 MB;
  // the "connected" and "added" lines carry the name, so the bound is on
  // the line, not on any one thing composed into it.
  // A raw Server, because McpServer's registerTool validates names and a
  // remote server's tools/list is under no such obligation.
  // The name reaches a line when it is discovered on a reconnect, so the
  // server advertises nothing on its first dial and the long name on its
  // second.
  const longName = 'x'.repeat(20_000);
  let dials = 0;
  let serverSide: Transport | undefined;
  const transportFor = async (): Promise<Transport> => {
    dials += 1;
    const advertised = dials === 1 ? [] : [{ name: longName, inputSchema: { type: 'object' as const } }];
    const server = new Server({ name: 'verbose', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: advertised }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    serverSide = serverTransport;
    await server.connect(serverTransport);
    return clientTransport;
  };
  const lines: string[] = [];
  let connections = 0;
  let signalReconnected = () => {};
  const reconnected = new Promise<void>((resolve) => {
    signalReconnected = resolve;
  });
  const plugin = createMcpPlugin(
    { servers: { verbose: { url: 'http://127.0.0.1:9/unused' } } },
    {
      transportFor,
      log: (message) => lines.push(message),
      warn: (message) => lines.push(message),
      reconnectDelayMs: () => 1,
      onConnected: () => {
        connections += 1;
        if (connections === 2) {
          signalReconnected();
        }
      },
    },
  );
  await loadThroughView(plugin, new ToolRegistry());
  const keepAlive = setInterval(() => {}, 50);
  try {
    await serverSide?.close();
    await reconnected;
    assert.ok(lines.some((line) => line.includes('xxxx')), 'the name reached a log line');
    for (const line of lines) {
      assert.ok(line.length <= 1001, `${line.length} chars`);
    }
  } finally {
    clearInterval(keepAlive);
    await plugin.dispose?.();
  }
});

test('a transport error the SDK keeps the connection through is never blamed for a later close', async () => {
  // A stdin EPIPE, like a schema miss or a stray line, is reported and
  // then read past; with nothing valid arriving afterwards, a server that
  // dies during the next call is still reported as exactly that.
  let clientTransport: Transport | undefined;
  const handle = fakeServer({
    current: (server) => {
      linearTools(server);
      server.registerTool('die', { description: 'Exit mid-call.' }, async () => {
        await handle.closeCurrent();
        return { content: [{ type: 'text', text: 'never delivered' }] };
      });
    },
  });
  const target = new ToolRegistry();
  const plugin = createMcpPlugin(
    { servers: { linear: { command: process.execPath } } },
    {
      transportFor: async () => {
        clientTransport = await handle.transportFor();
        return clientTransport;
      },
      warn: () => {},
      log: () => {},
      reconnectDelayMs: () => 3_600_000,
    },
  );
  await loadThroughView(plugin, target);
  try {
    clientTransport?.onerror?.(new Error('write EPIPE'));
    await assert.rejects(
      target.get('mcp.linear.die')!.execute({}, sessionFor('ava')),
      (error: Error) => {
        assert.equal(error.message, 'MCP error -32000: Connection closed');
        return true;
      },
    );
  } finally {
    await plugin.dispose?.();
  }
});

test('a stdio server’s parse error names its stdout, and every error the log gets is bounded', async () => {
  // The same SyntaxError from a stdio server is stray logging on stdout.
  let stdioTransport: Transport | undefined;
  const stdioHandle = fakeServer({
    current: (server) => {
      linearTools(server);
      server.registerTool('die', { description: 'Exit mid-call.' }, async () => {
        await stdioHandle.closeCurrent();
        return { content: [{ type: 'text', text: 'never delivered' }] };
      });
    },
  });
  const stdioWarnings: string[] = [];
  const stdioPlugin = createMcpPlugin(
    { servers: { linear: { command: process.execPath } } },
    {
      transportFor: async () => {
        stdioTransport = await stdioHandle.transportFor();
        return stdioTransport;
      },
      warn: (message) => stdioWarnings.push(message),
      log: () => {},
      reconnectDelayMs: () => 3_600_000,
    },
  );
  const target = new ToolRegistry();
  await loadThroughView(stdioPlugin, target);
  try {
    stdioTransport?.onerror?.(new SyntaxError('Unexpected token \'g\', "garbage" is not valid JSON'));
    const parse = stdioWarnings.find((message) => message.includes('transport error')) ?? '';
    assert.match(parse, /wrote a line to stdout that is not JSON-RPC/);
    assert.equal(parse.includes('garbage'), false);

    // The SDK skips the line and keeps the connection, so the stray line
    // is never what a later close was about: with nothing valid arriving
    // in between, a server that dies during the next call is reported as
    // exactly that.
    await assert.rejects(
      target.get('mcp.linear.die')!.execute({}, sessionFor('ava')),
      (error: Error) => {
        assert.equal(error.message, 'MCP error -32000: Connection closed');
        return true;
      },
    );
  } finally {
    await stdioPlugin.dispose?.();
  }

  // The SDK quotes a failed POST's whole response body in the error; the
  // reconnect and the unreachable-at-startup paths forward errors to the
  // same log, so they are bounded too.
  const body = 'Streamable HTTP error: Error POSTing to endpoint: ' + '<html>'.repeat(2000);
  let dials = 0;
  let signalReconnectFailed = () => {};
  const reconnectFailed = new Promise<void>((resolve) => {
    signalReconnectFailed = resolve;
  });
  const handle = fakeServer({ current: linearTools });
  const warnings: string[] = [];
  const plugin = pluginFor(handle, {}, {
    reconnectDelayMs: () => 1,
    transportFor: async () => {
      dials += 1;
      if (dials > 1) {
        throw new Error(body);
      }
      return handle.transportFor();
    },
    warn: (message) => {
      warnings.push(message);
      if (message.includes('reconnect failed')) {
        signalReconnectFailed();
      }
    },
  });
  await loadThroughView(plugin, new ToolRegistry());
  const keepAlive = setInterval(() => {}, 50);
  try {
    await handle.closeCurrent();
    await reconnectFailed;
    const line = warnings.find((message) => message.includes('reconnect failed')) ?? '';
    assert.ok(line.length < 400, `${line.length} chars`);
    assert.ok(line.endsWith('…'));
  } finally {
    clearInterval(keepAlive);
    await plugin.dispose?.();
  }

  const unreachableWarnings: string[] = [];
  const unreachable = pluginFor(handle, {}, {
    reconnectDelayMs: () => 3_600_000,
    transportFor: async () => {
      throw new Error(body);
    },
    warn: (message) => unreachableWarnings.push(message),
  });
  await loadThroughView(unreachable, new ToolRegistry());
  try {
    const line = unreachableWarnings.find((message) => message.includes('is unreachable')) ?? '';
    assert.ok(line.length > 0 && line.length < 600, `${line.length} chars`);
  } finally {
    await unreachable.dispose?.();
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

test('a link planted at a binary block’s recorded path is never written through', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'stratus-mcp-link-'));
  const block = { content: [{ type: 'image', data: Buffer.from('server bytes').toString('base64'), mimeType: 'image/png' }] };
  const context = { server: 'linear', tool: 'chart', agentId: 'ava', workspaceRoot, now: () => 7, ledger: createFileLedger(workspaceRoot) };
  // The file names are `<tool>-<stamp>-<serial>`, and the serial counts up
  // by one per block, so the next name is known once one has been seen —
  // which is what a peer watching the ledger's records would see too.
  const [first] = (await normalizeCallResult(block, context) as JsonObject).files as string[];
  const serial = Number(/-(\d+)\.png$/.exec(first!)![1]);
  const next = path.join(path.dirname(first!), `chart-7-${serial + 1}.png`);
  // A victim the link points at: the agent's own file, and the ledger.
  const victim = path.join(workspaceRoot, 'victim.md');
  await writeFile(victim, 'mine');
  await symlink(victim, next);
  await assert.rejects(() => normalizeCallResult(block, context), /appeared between its provenance record and its write/);
  assert.equal(await readFile(victim, 'utf8'), 'mine');
  // Over-marked, which is the safe direction: the record stands.
  assert.equal(await context.ledger.lookup('ava', next), 'external');
});

test('an artifact directory swapped for a link between its resolution and the open lands no bytes', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'stratus-mcp-dirswap-'));
  const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'stratus-mcp-elsewhere-'));
  const block = { content: [{ type: 'image', data: Buffer.from('server bytes').toString('base64'), mimeType: 'image/png' }] };
  const directory = path.join(workspaceRoot, 'ava', 'mcp', 'linear');
  // The clock seam runs after the directory is created and canonicalized
  // and before the open — exactly where a peer's swap would land.
  const context = {
    server: 'linear',
    tool: 'chart',
    agentId: 'ava',
    workspaceRoot,
    ledger: createFileLedger(workspaceRoot),
    now: () => {
      renameSync(directory, `${directory}.moved`);
      symlinkSync(elsewhere, directory);
      return 7;
    },
  };
  await assert.rejects(() => normalizeCallResult(block, context), /moved between its provenance record and its write/);
  // The create went through the link; nothing else did.
  for (const name of readdirSync(elsewhere)) {
    assert.equal(statSync(path.join(elsewhere, name)).size, 0);
  }
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

test('a bare command resolves inside the granted search path and nowhere else', async () => {
  // cross-spawn's Windows resolver searches `process.cwd()` before anything
  // the operator granted — `which/which.js` says so in its own comment. The
  // daemon's working directory is not a grant, so the bridge resolves the
  // command itself and hands the transport a path it need not search.
  //
  // The Windows rules are exercised from here through the `platform`
  // parameter: what differs there is the candidate list and the absence of
  // an execute bit, and neither needs a Windows kernel to check.
  const granted = await mkdtemp(path.join(os.tmpdir(), 'stratus-mcp-path-'));
  const ungranted = await mkdtemp(path.join(os.tmpdir(), 'stratus-mcp-nopath-'));
  await writeFile(path.join(granted, 'srv.CMD'), '@echo off\n');
  await writeFile(path.join(ungranted, 'other.CMD'), '@echo off\n');

  assert.equal(resolveCommandPath('srv', { PATH: granted }, 'win32'), path.join(granted, 'srv.CMD'));
  // A directory nobody granted is not searched, whatever is sitting in it.
  assert.equal(resolveCommandPath('other', { PATH: granted }, 'win32'), undefined);
  // Windows names are case-insensitive, and `Path` is the spelling it uses.
  assert.equal(resolveCommandPath('srv', { Path: granted }, 'win32'), path.join(granted, 'srv.CMD'));
  // PATHEXT decides what counts as runnable, and only a granted one is read:
  // the daemon's own is not part of the search this config declared.
  assert.equal(resolveCommandPath('srv', { PATH: granted, PATHEXT: '.EXE' }, 'win32'), undefined);
  assert.equal(
    resolveCommandPath('srv', { PATH: granted, PATHEXT: '.EXE;.CMD' }, 'win32'),
    path.join(granted, 'srv.CMD'),
  );
  // A quoted entry is a directory, not a directory whose name has quotes —
  // but only a *balanced* pair, the way `which` reads it. A lone quote is a
  // malformed entry, and stripping it would search a directory the granted
  // string does not name.
  assert.equal(resolveCommandPath('srv', { PATH: `"${granted}"` }, 'win32'), path.join(granted, 'srv.CMD'));
  assert.equal(resolveCommandPath('srv', { PATH: `"${granted}` }, 'win32'), undefined);
  assert.equal(resolveCommandPath('srv', { PATH: `${granted}"` }, 'win32'), undefined);

  // An extension the granted PATHEXT does not permit is not runnable, even
  // when the command names it outright — `isexe` checks the unsuffixed
  // candidate too, so taking it here would let a file Windows would refuse
  // mask the one beside it that it would run.
  await writeFile(path.join(granted, 'srv.js'), '\n');
  assert.equal(resolveCommandPath('srv.js', { PATH: granted, PATHEXT: '.EXE' }, 'win32'), undefined);
  assert.equal(
    resolveCommandPath('srv.js', { PATH: granted, PATHEXT: '.JS' }, 'win32'),
    path.join(granted, 'srv.js'),
  );
  await writeFile(path.join(granted, 'srv.js.EXE'), '\n');
  assert.equal(
    resolveCommandPath('srv.js', { PATH: granted, PATHEXT: '.EXE' }, 'win32'),
    path.join(granted, 'srv.js.EXE'),
  );

  // Ungranted, the fallback is the one `which` already uses. A wider set
  // would make a bare command resolve to file types that resolve to nothing
  // today: replacing a lookup is not an occasion to widen what it will run.
  await writeFile(path.join(granted, 'scripted.VBS'), '\n');
  assert.equal(resolveCommandPath('scripted', { PATH: granted }, 'win32'), undefined);
  assert.equal(
    resolveCommandPath('scripted', { PATH: granted, PATHEXT: '.VBS' }, 'win32'),
    path.join(granted, 'scripted.VBS'),
  );

  // POSIX: the execute bit is what makes a candidate runnable, so a
  // same-named file earlier on the path that cannot be run is passed over
  // rather than resolved to and then failing at spawn.
  const first = await mkdtemp(path.join(os.tmpdir(), 'stratus-mcp-first-'));
  const second = await mkdtemp(path.join(os.tmpdir(), 'stratus-mcp-second-'));
  await writeFile(path.join(first, 'srv'), '#!/bin/sh\n');
  await writeFile(path.join(second, 'srv'), '#!/bin/sh\n');
  await chmod(path.join(second, 'srv'), 0o755);
  assert.equal(resolveCommandPath('srv', { PATH: `${first}:${second}` }, 'linux'), path.join(second, 'srv'));

  await chmod(path.join(first, 'srv'), 0o755);
  assert.equal(resolveCommandPath('srv', { PATH: `${first}:${second}` }, 'linux'), path.join(first, 'srv'));

  // An empty entry means the current directory to a shell. Here it means
  // nothing: the cwd is the directory this whole resolver exists to exclude.
  assert.equal(resolveCommandPath('srv', { PATH: `:${second}` }, 'linux'), path.join(second, 'srv'));
  assert.equal(resolveCommandPath('srv', { PATH: '' }, 'linux'), undefined);
  assert.equal(resolveCommandPath('srv', {}, 'linux'), undefined);

  // A relative entry IS honoured — `./node_modules/.bin` is a directory
  // somebody chose, unlike the zero-length one a stray colon leaves behind.
  // It resolves against the directory the child will run in, and comes back
  // absolute: a relative result would be re-read against the server's `cwd`,
  // so the file checked here and the file spawned there could differ.
  const project = await mkdtemp(path.join(os.tmpdir(), 'stratus-mcp-project-'));
  await mkdir(path.join(project, 'bin'));
  await writeFile(path.join(project, 'bin', 'srv'), '#!/bin/sh\n');
  await chmod(path.join(project, 'bin', 'srv'), 0o755);
  assert.equal(
    resolveCommandPath('srv', { PATH: 'bin' }, 'linux', project),
    path.join(project, 'bin', 'srv'),
  );
  assert.equal(resolveCommandPath('srv', { PATH: 'bin' }, 'linux', second), undefined);
});

test('an empty search-path entry is not the working directory, end to end', async () => {
  // The POSIX shape of the same hole Windows has implicitly. `which` reads an
  // empty PATH entry as the current directory — and cross-spawn chdirs to the
  // server's own `cwd` before resolving — so a `srv` sitting in the working
  // directory wins over the one in the directory the operator granted. Which
  // shim actually ran is the observable: both start the same server, and each
  // records itself first.
  const bin = await mkdtemp(path.join(os.tmpdir(), 'stratus-mcp-bin-'));
  const work = await mkdtemp(path.join(os.tmpdir(), 'stratus-mcp-cwd-'));
  const ran = path.join(bin, 'ran');
  const fixture = path.join(packageRoot, 'fixtures', 'env-echo-server.mjs');
  for (const [dir, label] of [[bin, 'granted'], [work, 'cwd']] as const) {
    const shim = path.join(dir, 'srv');
    await writeFile(
      shim,
      `#!/bin/sh\nprintf '%s' ${JSON.stringify(label)} > ${JSON.stringify(ran)}\n`
        + `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)}\n`,
    );
    await chmod(shim, 0o755);
  }

  const plugin = createMcpPlugin(
    { servers: { envy: { command: 'srv', cwd: work, env: { PATH: `:${bin}` }, passEnv: [] } } },
    { warn: () => {}, log: () => {} },
  );
  const target = new ToolRegistry();
  try {
    await loadThroughView(plugin, target);
    assert.ok(target.get('mcp.envy.read_env'), 'the resolved path is one the spawn could actually run');
    assert.equal(await readFile(ran, 'utf8'), 'granted', 'the granted directory was searched, the cwd was not');
  } finally {
    await plugin.dispose?.();
  }
});

test('a command missing from the granted path leaves the daemon serving, not the plugin failed', async () => {
  // Not a config failure: the config is answerable, the binary just is not
  // there yet. `McpConfigError` would take the whole plugin — and with it
  // every other agent's tools — down over a package that has not finished
  // installing.
  const empty = await mkdtemp(path.join(os.tmpdir(), 'stratus-mcp-empty-'));
  const warnings: string[] = [];
  const plugin = createMcpPlugin(
    { servers: { missing: { command: 'not-installed', env: { PATH: empty }, passEnv: [] } } },
    { warn: (message) => warnings.push(message), log: () => {} },
  );
  const target = new ToolRegistry();
  try {
    await loadThroughView(plugin, target);
    assert.ok(
      warnings.some((message) => /was not found on the PATH this server was granted/.test(message)),
      `the warning names the fix; got ${JSON.stringify(warnings)}`,
    );
  } finally {
    await plugin.dispose?.();
  }
});

test('a relative search-path entry is the server\'s working directory, not the daemon\'s', async () => {
  // The mismatch a self-written resolver introduces if it forgets which
  // directory it is standing in: cross-spawn chdirs to the server's `cwd`
  // before resolving, so `PATH: "bin"` alongside `cwd` has always meant
  // `<cwd>/bin` — the shape `npx` from a project checkout takes. Statting it
  // against the daemon's directory instead asks about a different file, and
  // answering with a relative path lets the spawn re-resolve it against a
  // third one.
  const project = await mkdtemp(path.join(os.tmpdir(), 'stratus-mcp-proj-'));
  await mkdir(path.join(project, 'bin'));
  const shim = path.join(project, 'bin', 'srv');
  await writeFile(
    shim,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} `
      + `${JSON.stringify(path.join(packageRoot, 'fixtures', 'env-echo-server.mjs'))}\n`,
  );
  await chmod(shim, 0o755);

  const plugin = createMcpPlugin(
    { servers: { envy: { command: 'srv', cwd: project, env: { PATH: 'bin' }, passEnv: [] } } },
    { warn: () => {}, log: () => {} },
  );
  const target = new ToolRegistry();
  try {
    await loadThroughView(plugin, target);
    assert.ok(target.get('mcp.envy.read_env'), 'the entry resolved against the server\'s own directory');
  } finally {
    await plugin.dispose?.();
  }
});
