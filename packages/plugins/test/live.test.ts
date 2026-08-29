import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { EventBus, ToolRegistry, type JsonObject, type Plugin, type Tool } from '@stratusagent/core';

import { loadPlugins, PluginManifestError, type OptionalModuleHost } from '../src/index.ts';

// The behaviors under test here exist for one consumer: a bridge whose tool
// names arrive from somebody else's server, at connect time and again on
// every reconnect. The view a plugin's setup() was handed stays its
// registration handle after the plugin has committed — same gate, no
// staging — and its removals reach only its own names.

const tool = (name: string, risk?: Tool['risk']): Tool => ({
  name,
  ...(risk ? { risk } : {}),
  async execute() {
    return { ran: name };
  },
});

const fakeHost = async (
  packages: Record<string, { manifest: unknown; module?: unknown }>,
): Promise<OptionalModuleHost> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-plugins-live-'));
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
        const error = new Error(`Cannot find package '${specifier}'`) as NodeJS.ErrnoException;
        error.code = 'ERR_MODULE_NOT_FOUND';
        throw error;
      }
      return resolved;
    },
    async import(specifier) {
      return packages[specifier]?.module ?? {};
    },
  };
};

const bridgeManifest = {
  stratus: {
    pluginVersion: 1,
    contributes: { toolsDiscovered: [{ namespace: 'mcp.*', risk: 'gated' }] },
  },
};

/** A plugin that hands its registration view back to the test. */
const capturingModule = (capture: (tools: ToolRegistry) => void) => ({
  createPlugin: (): Plugin => ({
    name: 'bridge',
    setup(context) {
      capture(context.tools);
    },
  }),
});

test('a tool discovered after load registers through the committed view, at the declared risk, and the load record follows', async () => {
  let view: ToolRegistry | undefined;
  const host = await fakeHost({
    'stratus-plugin-bridge': {
      manifest: bridgeManifest,
      module: capturingModule((tools) => {
        view = tools;
        tools.register(tool('mcp.linear.create_issue'));
      }),
    },
  });
  const target = new ToolRegistry();
  const result = await loadPlugins({
    config: { 'stratus-plugin-bridge': { enabled: true } },
    host,
    tools: target,
    bus: new EventBus(),
  });
  assert.equal(result.failures.length, 0);
  const records = result.loaded[0]!.tools;
  assert.deepEqual(records.map((record) => record.name), ['mcp.linear.create_issue']);

  // The reconnect path: the plugin loaded whole long ago, and a server now
  // advertises a name it did not at startup.
  view!.register(tool('mcp.linear.list_issues'));
  assert.ok(target.get('mcp.linear.list_issues'), 'a late registration lands in the shared registry');
  assert.equal(target.get('mcp.linear.list_issues')?.risk, 'gated', 'the namespace risk applies identically late');
  assert.deepEqual(
    records.map((record) => record.name).sort(),
    ['mcp.linear.create_issue', 'mcp.linear.list_issues'],
    'the load record is live, not a snapshot',
  );
});

test('a late registration outside the declared namespace is refused exactly as it is at first load', async () => {
  let view: ToolRegistry | undefined;
  const host = await fakeHost({
    'stratus-plugin-bridge': {
      manifest: bridgeManifest,
      module: capturingModule((tools) => {
        view = tools;
      }),
    },
  });
  const target = new ToolRegistry();
  target.register(tool('fs.write', 'gated'));
  await loadPlugins({
    config: { 'stratus-plugin-bridge': { enabled: true } },
    host,
    tools: target,
    bus: new EventBus(),
  });

  assert.throws(() => view!.register(tool('fs.read')), PluginManifestError);
  assert.equal(target.get('fs.read'), undefined);
});

test('a late registration cannot replace a name somebody else owns', async () => {
  let view: ToolRegistry | undefined;
  const host = await fakeHost({
    'stratus-plugin-bridge': {
      manifest: bridgeManifest,
      module: capturingModule((tools) => {
        view = tools;
      }),
    },
    'stratus-plugin-other': {
      manifest: {
        stratus: { pluginVersion: 1, contributes: { tools: [{ name: 'mcp.taken.tool', risk: 'gated' }] } },
      },
      module: {
        createPlugin: (): Plugin => ({
          name: 'other',
          setup(context) {
            context.tools.register(tool('mcp.taken.tool'));
          },
        }),
      },
    },
  });
  const target = new ToolRegistry();
  const kernel = tool('demo.echo', 'safe');
  target.register(kernel);
  const result = await loadPlugins({
    config: {
      'stratus-plugin-bridge': { enabled: true },
      'stratus-plugin-other': { enabled: true },
    },
    host,
    tools: target,
    bus: new EventBus(),
  });
  assert.equal(result.failures.length, 0);

  assert.throws(() => view!.register(tool('mcp.taken.tool')), /contributed by both/);
  // Removal reaches only the plugin's own names: another package's tool and
  // the kernel's both report false and stay registered.
  assert.equal(view!.unregister('mcp.taken.tool'), false);
  assert.equal(view!.unregister('demo.echo'), false);
  assert.ok(target.get('mcp.taken.tool'));
  assert.equal(target.get('demo.echo'), kernel);
});

test('unregister removes an own tool from the shared registry and the live record, and the name is registrable again', async () => {
  let view: ToolRegistry | undefined;
  const host = await fakeHost({
    'stratus-plugin-bridge': {
      manifest: bridgeManifest,
      module: capturingModule((tools) => {
        view = tools;
        tools.register(tool('mcp.linear.create_issue'));
      }),
    },
  });
  const target = new ToolRegistry();
  const result = await loadPlugins({
    config: { 'stratus-plugin-bridge': { enabled: true } },
    host,
    tools: target,
    bus: new EventBus(),
  });
  const records = result.loaded[0]!.tools;

  assert.equal(view!.unregister('mcp.linear.create_issue'), true);
  assert.equal(target.get('mcp.linear.create_issue'), undefined);
  assert.equal(records.length, 0);

  // A server that re-advertises the name on the next reconnect gets it
  // back — a removal is not a tombstone.
  view!.register(tool('mcp.linear.create_issue'));
  assert.ok(target.get('mcp.linear.create_issue'));
});

test('toolRisks lowers a discovered tool below its namespace risk — the operator’s word, applied at registration', async () => {
  const host = await fakeHost({
    '@stratusagent/plugin-mcp': {
      manifest: bridgeManifest,
      module: {
        createPlugin: (config: JsonObject): Plugin => ({
          name: 'bridge',
          setup(context) {
            // The plugin never sees the host's key, so it cannot apply —
            // or argue with — the override itself.
            assert.equal(config.toolRisks, undefined);
            context.tools.register(tool('mcp.linear.get_issue'));
            context.tools.register(tool('mcp.linear.create_issue'));
          },
        }),
      },
    },
  });
  const target = new ToolRegistry();
  const result = await loadPlugins({
    config: {
      '@stratusagent/plugin-mcp': {
        enabled: true,
        toolRisks: { 'mcp.linear.get_issue': 'safe', 'mcp.linear.create_issue': 'dangerous' },
      },
    },
    host,
    tools: target,
    bus: new EventBus(),
  });
  assert.equal(result.failures.length, 0);
  assert.equal(target.get('mcp.linear.get_issue')?.risk, 'safe');
  assert.equal(target.get('mcp.linear.create_issue')?.risk, 'dangerous');
});

test('toolRisks vouches for a tool, not for the code implementing it: the third-party floor still binds an override', async () => {
  const host = await fakeHost({
    'stratus-plugin-bridge': {
      manifest: bridgeManifest,
      module: capturingModule((tools) => {
        tools.register(tool('mcp.linear.get_issue'));
      }),
    },
  });
  const target = new ToolRegistry();
  const result = await loadPlugins({
    config: {
      'stratus-plugin-bridge': { enabled: true, toolRisks: { 'mcp.linear.get_issue': 'safe' } },
    },
    host,
    tools: target,
    bus: new EventBus(),
  });
  assert.equal(result.failures.length, 0);
  assert.equal(target.get('mcp.linear.get_issue')?.risk, 'gated');
});

test('a toolRisks entry the manifest does not cover, or with a risk that is not one, refuses the plugin', async () => {
  const packages = {
    'stratus-plugin-bridge': {
      manifest: bridgeManifest,
      module: capturingModule(() => {}),
    },
  };
  for (const toolRisks of [
    { 'fs.read': 'safe' },
    { 'mcp.linear.get_issue': 'harmless' },
  ]) {
    const target = new ToolRegistry();
    const result = await loadPlugins({
      config: { 'stratus-plugin-bridge': { enabled: true, toolRisks } },
      host: await fakeHost(packages),
      tools: target,
      bus: new EventBus(),
    });
    assert.equal(result.loaded.length, 0);
    assert.match(result.failures[0]!.reason, /toolRisks/);
  }
});
