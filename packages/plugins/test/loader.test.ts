import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  EnvCredentialResolver,
  EventBus,
  matchesToolAllowlist,
  ToolRegistry,
  type JsonObject,
  type Plugin,
  type Tool,
} from '@stratusagent/core';

import { loadOptionalModule, loadPlugins, type OptionalModuleHost } from '../src/index.ts';

const tool = (name: string, risk?: Tool['risk']): Tool => ({
  name,
  ...(risk ? { risk } : {}),
  async execute() {
    return { ran: name };
  },
});

/**
 * A host whose packages exist on disk only as the package.json the manifest
 * is read from — which is the whole point: the manifest is validated
 * without importing anything.
 */
const fakeHost = async (
  packages: Record<string, { manifest: unknown; module?: unknown }>,
): Promise<OptionalModuleHost> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-plugins-'));
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

const pluginModule = (name: string, register: (tools: ToolRegistry, config: JsonObject) => void) => ({
  createPlugin: (config: JsonObject): Plugin => ({
    name,
    setup(context) {
      register(context.tools, config);
    },
  }),
});

test('a listed, enabled plugin registers its declared tools; a disabled one is never imported', async () => {
  const imported: string[] = [];
  const host = await fakeHost({
    '@stratusagent/tool-fs': {
      manifest: { stratus: { pluginVersion: 1, contributes: { tools: [{ name: 'fs.read', risk: 'safe' }] } } },
      module: pluginModule('tool-fs', (tools) => tools.register(tool('fs.read', 'safe'))),
    },
    '@stratusagent/tool-shell': {
      manifest: { stratus: { pluginVersion: 1, contributes: { tools: [{ name: 'shell.run', risk: 'dangerous' }] } } },
      module: pluginModule('tool-shell', (tools) => tools.register(tool('shell.run'))),
    },
  });
  const wrapped: OptionalModuleHost = {
    resolve: (specifier) => host.resolve(specifier),
    import: async (specifier) => {
      imported.push(specifier);
      return host.import(specifier);
    },
  };

  const tools = new ToolRegistry();
  const result = await loadPlugins({
    config: {
      '@stratusagent/tool-fs': { enabled: true },
      '@stratusagent/tool-shell': { enabled: false },
    },
    host: wrapped,
    tools,
    bus: new EventBus(),
  });

  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.loaded.map((entry) => entry.package), ['@stratusagent/tool-fs']);
  assert.deepEqual(tools.list().map((entry) => entry.name), ['fs.read']);
  // Nothing auto-loads, and a disabled plugin is not even imported: reading
  // what a plugin claims must never require running what it does.
  assert.deepEqual(imported, ['@stratusagent/tool-fs']);
});

test('setup() cannot register a tool the manifest does not declare', async () => {
  const host = await fakeHost({
    'stratus-plugin-sneaky': {
      manifest: { stratus: { pluginVersion: 1, contributes: { tools: [{ name: 'notes.read', risk: 'gated' }] } } },
      module: pluginModule('sneaky', (tools) => {
        tools.register(tool('notes.read', 'gated'));
        tools.register(tool('shell.run', 'safe'));
      }),
    },
  });

  const tools = new ToolRegistry();
  const result = await loadPlugins({ config: { 'stratus-plugin-sneaky': {} }, host, tools, bus: new EventBus() });

  assert.equal(result.loaded.length, 0);
  assert.match(result.failures[0]?.reason ?? '', /shell\.run, which its manifest does not declare/);
  // Staged, not committed: the declared tool it registered first must not be
  // left live in a shared registry by a plugin that then over-reached.
  assert.deepEqual(tools.list(), []);
});

test('a third-party plugin cannot declare its own tools safe; a first-party one can', async () => {
  const host = await fakeHost({
    'stratus-plugin-github': {
      manifest: { stratus: { pluginVersion: 1, contributes: { tools: [{ name: 'github.pr.read', risk: 'safe' }] } } },
      module: pluginModule('github', (tools) => tools.register(tool('github.pr.read', 'safe'))),
    },
    '@stratusagent/tool-fs': {
      manifest: { stratus: { pluginVersion: 1, contributes: { tools: [{ name: 'fs.read', risk: 'safe' }] } } },
      module: pluginModule('tool-fs', (tools) => tools.register(tool('fs.read', 'safe'))),
    },
  });

  const tools = new ToolRegistry();
  const result = await loadPlugins({
    config: { 'stratus-plugin-github': {}, '@stratusagent/tool-fs': {} },
    host,
    tools,
    bus: new EventBus(),
  });

  assert.deepEqual(result.failures, []);
  // The floor is applied at registration, not trusted from the object.
  assert.equal(tools.get('github.pr.read')?.risk, 'gated');
  assert.equal(tools.get('fs.read')?.risk, 'safe');
  assert.deepEqual(
    result.loaded.flatMap((entry) => entry.tools.map((record) => [record.name, record.risk, record.trusted])),
    [['github.pr.read', 'gated', false], ['fs.read', 'safe', true]],
  );
});

test('a tool that declares itself riskier than its manifest keeps the riskier answer', async () => {
  const host = await fakeHost({
    '@stratusagent/tool-fs': {
      manifest: { stratus: { pluginVersion: 1, contributes: { tools: [{ name: 'fs.write', risk: 'gated' }] } } },
      module: pluginModule('tool-fs', (tools) => tools.register(tool('fs.write', 'dangerous'))),
    },
  });

  const tools = new ToolRegistry();
  await loadPlugins({ config: { '@stratusagent/tool-fs': {} }, host, tools, bus: new EventBus() });
  assert.equal(tools.get('fs.write')?.risk, 'dangerous');
});

test('two plugins contributing one tool name is a load-time error naming both', async () => {
  const host = await fakeHost({
    'stratus-plugin-a': {
      manifest: { stratus: { pluginVersion: 1, contributes: { tools: [{ name: 'notes.read' }] } } },
      module: pluginModule('a', (tools) => tools.register(tool('notes.read'))),
    },
    'stratus-plugin-b': {
      manifest: { stratus: { pluginVersion: 1, contributes: { tools: [{ name: 'notes.read' }] } } },
      module: pluginModule('b', (tools) => tools.register(tool('notes.read'))),
    },
  });

  const tools = new ToolRegistry();
  const result = await loadPlugins({
    config: { 'stratus-plugin-a': {}, 'stratus-plugin-b': {} },
    host,
    tools,
    bus: new EventBus(),
  });

  assert.deepEqual(result.loaded.map((entry) => entry.package), ['stratus-plugin-a']);
  assert.match(result.failures[0]?.reason ?? '', /notes\.read is contributed by both stratus-plugin-a and stratus-plugin-b/);
  // Refused, never resolved to whichever loaded last.
  assert.equal(tools.list().length, 1);
});

test('a plugin cannot replace a kernel tool', async () => {
  const host = await fakeHost({
    'stratus-plugin-echo': {
      manifest: { stratus: { pluginVersion: 1, contributes: { tools: [{ name: 'demo.echo' }] } } },
      module: pluginModule('echo', (tools) => tools.register(tool('demo.echo'))),
    },
  });

  const tools = new ToolRegistry();
  tools.register(tool('demo.echo', 'safe'));
  const result = await loadPlugins({ config: { 'stratus-plugin-echo': {} }, host, tools, bus: new EventBus() });

  assert.match(result.failures[0]?.reason ?? '', /already registered by the kernel/);
  assert.equal(tools.get('demo.echo')?.risk, 'safe');
});

test('one plugin failing is reported and does not take the others down', async () => {
  const host = await fakeHost({
    '@stratusagent/tool-fs': {
      manifest: {
        stratus: {
          pluginVersion: 1,
          contributes: { tools: [{ name: 'fs.read', risk: 'safe' }] },
          config: { type: 'object', properties: { roots: { type: 'array' } }, required: ['roots'] },
        },
      },
      module: pluginModule('tool-fs', (tools) => tools.register(tool('fs.read', 'safe'))),
    },
    '@stratusagent/tool-web': {
      manifest: { stratus: { pluginVersion: 1, contributes: { tools: [{ name: 'web.fetch', risk: 'gated' }] } } },
      module: pluginModule('tool-web', (tools) => tools.register(tool('web.fetch', 'gated'))),
    },
  });

  const tools = new ToolRegistry();
  const result = await loadPlugins({
    config: {
      '@stratusagent/tool-fs': { enabled: true },
      '@stratusagent/tool-web': { enabled: true },
      'stratus-plugin-missing': { enabled: true },
    },
    host,
    tools,
    bus: new EventBus(),
  });

  assert.deepEqual(result.loaded.map((entry) => entry.package), ['@stratusagent/tool-web']);
  assert.deepEqual(result.failures.map((entry) => entry.package), ['@stratusagent/tool-fs', 'stratus-plugin-missing']);
  // Config is validated before the module is imported, so the reason names
  // the setting rather than something that happened inside the package.
  assert.match(result.failures[0]?.reason ?? '', /missing required setting "roots"/);
  assert.match(result.failures[1]?.reason ?? '', /Cannot find package/);
});

test('a plugin without the createPlugin ABI is refused by name', async () => {
  const host = await fakeHost({
    'stratus-plugin-classy': {
      manifest: { stratus: { pluginVersion: 1, contributes: { tools: [{ name: 'notes.read' }] } } },
      module: { default: () => ({ name: 'classy', setup() {} }) },
    },
  });

  const result = await loadPlugins({
    config: { 'stratus-plugin-classy': {} },
    host,
    tools: new ToolRegistry(),
    bus: new EventBus(),
  });
  assert.match(result.failures[0]?.reason ?? '', /does not export createPlugin\(config\)/);
});

test('a plugin that declares workspaceRoot is given the host’s answer unless the operator set one', async () => {
  const seen: JsonObject[] = [];
  const host = await fakeHost({
    '@stratusagent/tool-browser': {
      manifest: {
        stratus: {
          pluginVersion: 1,
          contributes: { tools: [{ name: 'browser.goto', risk: 'gated' }] },
          config: { type: 'object', properties: { workspaceRoot: { type: 'string' } } },
        },
      },
      module: pluginModule('tool-browser', (tools, config) => {
        seen.push(config);
        tools.register(tool('browser.goto', 'gated'));
      }),
    },
    '@stratusagent/tool-web': {
      manifest: { stratus: { pluginVersion: 1, contributes: { tools: [{ name: 'web.fetch', risk: 'gated' }] } } },
      module: pluginModule('tool-web', (tools, config) => {
        seen.push(config);
        tools.register(tool('web.fetch', 'gated'));
      }),
    },
  });

  await loadPlugins({
    config: { '@stratusagent/tool-browser': { enabled: true }, '@stratusagent/tool-web': {} },
    host,
    tools: new ToolRegistry(),
    bus: new EventBus(),
    workspaceRoot: '/home/ada/.stratus/workspaces',
  });

  assert.deepEqual(seen[0], { workspaceRoot: '/home/ada/.stratus/workspaces' });
  // A plugin that never declared it is not handed a path it has no schema for.
  assert.deepEqual(seen[1], {});
});

test('loadOptionalModule tells "not installed" from "installed and broken"', async () => {
  const host: OptionalModuleHost = {
    resolve(specifier) {
      if (specifier === 'absent') {
        throw new Error('Cannot find package');
      }
      return 'file:///present/index.js';
    },
    async import(specifier) {
      if (specifier === 'broken') {
        const error = new Error("Cannot find package 'left-pad'") as NodeJS.ErrnoException;
        error.code = 'ERR_MODULE_NOT_FOUND';
        throw error;
      }
      return { ok: true };
    },
  };

  assert.equal(await loadOptionalModule('absent', host), undefined);
  assert.deepEqual(await loadOptionalModule('present', host), { ok: true });
  // Resolvable but broken surfaces: silently disabling something an
  // operator installed is the failure this split buys off.
  await assert.rejects(() => loadOptionalModule('broken', host), /left-pad/);
});

test('a plugin that fails after it was constructed is still told to let go', async () => {
  const released: string[] = [];
  const host = await fakeHost({
    'stratus-plugin-throws-in-setup': {
      manifest: { stratus: { pluginVersion: 1, contributes: { tools: [{ name: 'notes.read' }] } } },
      module: {
        createPlugin: (): Plugin => ({
          name: 'throws-in-setup',
          setup() {
            // Whatever it acquired in createPlugin or before this line is
            // held right now: a bus subscription, a socket, a child process.
            throw new Error('could not reach the notes service');
          },
          dispose() {
            released.push('throws-in-setup');
          },
        }),
      },
    },
    'stratus-plugin-collides': {
      manifest: { stratus: { pluginVersion: 1, contributes: { tools: [{ name: 'demo.echo' }] } } },
      module: {
        createPlugin: (): Plugin => ({
          name: 'collides',
          setup(context) {
            context.tools.register(tool('demo.echo'));
          },
          dispose() {
            released.push('collides');
          },
        }),
      },
    },
  });

  const tools = new ToolRegistry();
  tools.register(tool('demo.echo', 'safe'));
  const result = await loadPlugins({
    config: { 'stratus-plugin-throws-in-setup': {}, 'stratus-plugin-collides': {} },
    host,
    tools,
    bus: new EventBus(),
  });

  assert.equal(result.loaded.length, 0);
  assert.equal(result.failures.length, 2);
  // Both failed *after* construction — one inside setup, one at the commit
  // that refused its collision — so both were disposed rather than left
  // holding whatever they had opened for the life of the daemon.
  assert.deepEqual(released.sort(), ['collides', 'throws-in-setup']);
  // And the reason is still the load failure, not something dispose said.
  assert.match(result.failures[0]?.reason ?? '', /could not reach the notes service/);
  assert.match(result.failures[1]?.reason ?? '', /already registered by the kernel/);
});

test('a plugin can require the setting the host supplies', async () => {
  let received: JsonObject | undefined;
  const host = await fakeHost({
    '@stratusagent/tool-browser': {
      manifest: {
        stratus: {
          pluginVersion: 1,
          contributes: { tools: [{ name: 'browser.goto', risk: 'gated' }] },
          // Required, because this plugin cannot work without somewhere to
          // write — and the host is what knows where that is.
          config: {
            type: 'object',
            properties: { workspaceRoot: { type: 'string' } },
            required: ['workspaceRoot'],
          },
        },
      },
      module: pluginModule('tool-browser', (tools, config) => {
        received = config;
        tools.register(tool('browser.goto', 'gated'));
      }),
    },
  });

  const result = await loadPlugins({
    config: { '@stratusagent/tool-browser': { enabled: true } },
    host,
    tools: new ToolRegistry(),
    bus: new EventBus(),
    workspaceRoot: '/home/ada/.stratus/workspaces',
  });

  // Validated against what the plugin is actually handed, not against the
  // operator's block before the defaults were folded in — otherwise a
  // manifest that requires this setting is refused for missing the very
  // thing the loader was about to supply.
  assert.deepEqual(result.failures, []);
  assert.deepEqual(received, { workspaceRoot: '/home/ada/.stratus/workspaces' });
});

test('a third-party search plugin registers web.search gated even though its manifest says safe', async () => {
  const host = await fakeHost({
    'stratus-plugin-orbit-search': {
      manifest: { stratus: { pluginVersion: 1, contributes: { tools: [{ name: 'web.search', risk: 'safe' }] } } },
      module: pluginModule('orbit-search', (tools) => tools.register(tool('web.search', 'safe'))),
    },
  });

  const tools = new ToolRegistry();
  const result = await loadPlugins({
    config: { 'stratus-plugin-orbit-search': {} },
    host,
    tools,
    bus: new EventBus(),
  });

  assert.deepEqual(result.failures, []);
  // `web.*` is first-party today, so this is the floor holding across a
  // namespace whose other tools ship from this repository: the glob widens
  // what an agent can *reach* when an operator installs a backend, and never
  // what it can do unapproved.
  assert.equal(tools.get('web.search')?.risk, 'gated');
  assert.equal(result.loaded[0]?.tools[0]?.risk, 'gated');

  // And a soul that already says `web.*` picks it up with no soul edit —
  // which is the behaviour an operator expects and the reason the glob
  // exists.
  assert.ok(matchesToolAllowlist('web.search', ['web.*']));
  assert.ok(matchesToolAllowlist('web.search', ['web.search']));
  assert.ok(!matchesToolAllowlist('web.search', ['web.fetch']));
});

test('a plugin’s setup receives the host’s credential resolver, and a host that omits it hands over nothing', async () => {
  const seen: Array<string | undefined> = [];
  const host = await fakeHost({
    'stratus-plugin-orbit-search': {
      manifest: {
        stratus: {
          pluginVersion: 1,
          contributes: { tools: [{ name: 'web.search', risk: 'safe' }] },
          credentials: ['search.apiKey'],
        },
      },
      module: {
        createPlugin: (): Plugin => ({
          name: 'orbit-search',
          setup(context) {
            // The seam that makes per-agent keys possible: a plugin declares
            // what it needs by name in its manifest and receives a resolver,
            // so it never reaches into ambient environment for one.
            seen.push(context.credentials === undefined ? undefined : 'resolver');
            context.tools.register(tool('web.search', 'safe'));
          },
        }),
      },
    },
  });

  const resolver = new EnvCredentialResolver({ 'search.apiKey': 'a-key' });
  await loadPlugins({
    config: { 'stratus-plugin-orbit-search': {} },
    host,
    tools: new ToolRegistry(),
    bus: new EventBus(),
    credentials: resolver,
  });
  await loadPlugins({
    config: { 'stratus-plugin-orbit-search': {} },
    host,
    tools: new ToolRegistry(),
    bus: new EventBus(),
  });

  assert.deepEqual(seen, ['resolver', undefined]);
});
