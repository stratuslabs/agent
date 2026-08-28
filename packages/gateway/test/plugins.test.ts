import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { OptionalModuleHost } from '@stratusagent/plugins';

import { createGateway } from '../src/index.ts';

const newHome = async (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'stratus-gw-plugins-'));

/**
 * A package that exists as far as the loader needs: a package.json on disk
 * for the manifest, and a module handed over separately — which is the
 * point, since the manifest is validated before anything is imported.
 */
const hostFor = async (
  packages: Record<string, { manifest: unknown; module?: unknown }>,
): Promise<OptionalModuleHost> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-gw-pkgs-'));
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

test('a configured plugin is loaded before dispatch, and reported with its provenance', async () => {
  const home = await newHome();
  const log: string[] = [];
  const warn: string[] = [];
  let disposed = 0;
  let workspaceRoot: unknown;

  const host = await hostFor({
    'stratus-plugin-notes': {
      manifest: {
        stratus: {
          pluginVersion: 1,
          contributes: { tools: [{ name: 'notes.read', risk: 'safe' }] },
          config: { type: 'object', properties: { workspaceRoot: { type: 'string' } } },
        },
      },
      module: {
        createPlugin: (config: Record<string, unknown>) => {
          workspaceRoot = config.workspaceRoot;
          return {
            name: 'notes',
            setup(context: { tools: { register(tool: unknown): void } }) {
              context.tools.register({
                name: 'notes.read',
                description: 'Read a note.',
                risk: 'safe',
                async execute() {
                  return null;
                },
              });
            },
            dispose() {
              disposed += 1;
            },
          };
        },
      },
    },
  });

  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: {} },
    idleTimeoutMs: 0,
    plugins: {
      'stratus-plugin-notes': { enabled: true },
      'stratus-plugin-missing': { enabled: true },
      'stratus-plugin-off': { enabled: false },
    },
    pluginHost: host,
    log: (line) => log.push(line),
    warn: (line) => warn.push(line),
  });

  await gateway.start();
  try {
    const tools = gateway.tools();
    const notes = tools.find((tool) => tool.name === 'notes.read');
    assert.equal(notes?.package, 'stratus-plugin-notes');
    // A third-party package cannot declare its own tool `safe`, whatever
    // both its manifest and its object say.
    assert.equal(notes?.risk, 'gated');
    assert.equal(notes?.trusted, false);
    // Kernel tools are listed too, with no package — the honest answer for
    // them rather than an omission.
    assert.equal(tools.find((tool) => tool.name === 'demo.echo')?.package, undefined);

    // The host supplies the workspace root; the plugin does not re-derive
    // ~/.stratus/workspaces for itself.
    assert.equal(workspaceRoot, path.join(home, '.stratus', 'workspaces'));

    const plugins = gateway.plugins();
    assert.equal(plugins.find((plugin) => plugin.package === 'stratus-plugin-notes')?.tools?.length, 1);
    // A plugin an operator enabled that did not load is named, not silently
    // absent.
    assert.match(plugins.find((plugin) => plugin.package === 'stratus-plugin-missing')?.error ?? '', /Cannot find package/);
    assert.ok(warn.some((line) => line.includes('stratus-plugin-missing did not load')));
    // And one that was turned off is not listed as either.
    assert.equal(plugins.some((plugin) => plugin.package === 'stratus-plugin-off'), false);
    assert.ok(log.some((line) => line.includes('plugin stratus-plugin-notes loaded')));
  } finally {
    await gateway.stop();
  }

  // Shut down with the daemon: a plugin holding a browser and a socket is
  // the reason this hook exists.
  assert.equal(disposed, 1);
});

test('a plugin that fails does not stop the daemon serving the ones that did not', async () => {
  const home = await newHome();
  const warn: string[] = [];
  const host = await hostFor({
    'stratus-plugin-good': {
      manifest: { stratus: { pluginVersion: 1, contributes: { tools: [{ name: 'good.read', risk: 'gated' }] } } },
      module: {
        createPlugin: () => ({
          name: 'good',
          setup(context: { tools: { register(tool: unknown): void } }) {
            context.tools.register({ name: 'good.read', risk: 'gated', async execute() { return null; } });
          },
        }),
      },
    },
    'stratus-plugin-overreaching': {
      manifest: { stratus: { pluginVersion: 1, contributes: { tools: [{ name: 'fine.read', risk: 'gated' }] } } },
      module: {
        createPlugin: () => ({
          name: 'overreaching',
          setup(context: { tools: { register(tool: unknown): void } }) {
            context.tools.register({ name: 'fine.read', risk: 'gated', async execute() { return null; } });
            context.tools.register({ name: 'shell.run', risk: 'safe', async execute() { return null; } });
          },
        }),
      },
    },
  });

  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: {} },
    idleTimeoutMs: 0,
    plugins: { 'stratus-plugin-good': {}, 'stratus-plugin-overreaching': {} },
    pluginHost: host,
    log: () => {},
    warn: (line) => warn.push(line),
  });

  await gateway.start();
  try {
    const names = gateway.tools().map((tool) => tool.name);
    assert.ok(names.includes('good.read'), 'the plugin that loaded is serving');
    // Refused whole: the declared tool it registered first must not survive
    // in a registry every agent shares.
    assert.ok(!names.includes('fine.read'));
    assert.ok(!names.includes('shell.run'));
    assert.ok(warn.some((line) => /does not declare/.test(line)));
  } finally {
    await gateway.stop();
  }
});

test('a startup that fails after the plugins loaded still lets them go', async () => {
  const home = await newHome();
  let disposed = 0;
  const host = await hostFor({
    'stratus-plugin-holds-something': {
      manifest: { stratus: { pluginVersion: 1, contributes: { tools: [{ name: 'notes.read', risk: 'gated' }] } } },
      module: {
        createPlugin: () => ({
          name: 'holds-something',
          setup(context: { tools: { register(tool: unknown): void } }) {
            context.tools.register({ name: 'notes.read', risk: 'gated', async execute() { return null; } });
          },
          dispose() {
            disposed += 1;
          },
        }),
      },
    },
  });

  // Two souls claiming one id: the roster refuses, which is a failure
  // *after* the plugins are up. `stratus serve` awaits start() before the
  // try/finally that would call stop(), so this is the only chance a
  // plugin gets to release a browser, a socket, or a subscription.
  await mkdir(path.join(home, '.stratus', 'agents'), { recursive: true });
  for (const file of ['one.md', 'two.md']) {
    await writeFile(
      path.join(home, '.stratus', 'agents', file),
      '---\nname: Ava\nid: ava\n---\n\nYou are Ava.\n',
    );
  }

  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: {} },
    idleTimeoutMs: 0,
    plugins: { 'stratus-plugin-holds-something': {} },
    pluginHost: host,
    log: () => {},
    warn: () => {},
  });

  await assert.rejects(() => gateway.start());
  assert.equal(disposed, 1, 'the plugin was disposed when startup failed');

  // And stopping afterwards does not dispose it a second time.
  await gateway.stop();
  assert.equal(disposed, 1);
});

test('a contested bare alias disappears from every listing, plugins() included', async () => {
  const home = await newHome();
  // Built by hand rather than through hostFor because these packages ship
  // a file besides package.json — the SKILL.md the manifest points at.
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-gw-skillpkgs-'));
  const entries = new Map<string, string>();
  const skillSource = (label: string): string =>
    `---\ndescription: Use when the task calls for ${label}.\n---\n\n# ${label}\n`;
  for (const name of ['stratus-plugin-acme', 'stratus-plugin-zephyr']) {
    const directory = path.join(root, name.replace(/[@/]/g, '_'));
    await mkdir(path.join(directory, 'dist'), { recursive: true });
    await mkdir(path.join(directory, 'skills'), { recursive: true });
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({
      name,
      stratus: { pluginVersion: 1, contributes: { skills: [{ id: 'pr-review', path: './skills/SKILL.md' }] } },
    }));
    await writeFile(path.join(directory, 'skills', 'SKILL.md'), skillSource(name));
    entries.set(name, pathToFileURL(path.join(directory, 'dist', 'index.js')).href);
  }
  const host: OptionalModuleHost = {
    resolve(specifier) {
      const resolved = entries.get(specifier);
      if (!resolved) {
        throw new Error(`Cannot find package '${specifier}'`);
      }
      return resolved;
    },
    async import(specifier) {
      return { createPlugin: () => ({ name: specifier, setup() {} }) };
    },
  };

  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: {} },
    idleTimeoutMs: 0,
    plugins: {
      'stratus-plugin-acme': { enabled: true },
      'stratus-plugin-zephyr': { enabled: true },
    },
    pluginHost: host,
    log: () => {},
    warn: () => {},
  });

  await gateway.start();
  try {
    // Both skills serve, qualified; the bare id belongs to neither — and
    // no listing may advertise an alias skill.read would refuse. The
    // first plugin held the alias briefly at load, which is exactly the
    // snapshot plugins() must not echo.
    const catalog = gateway.skills();
    assert.deepEqual(
      catalog.map((skill) => skill.id).sort(),
      ['stratus-plugin-acme:pr-review', 'stratus-plugin-zephyr:pr-review'],
    );
    assert.ok(catalog.every((skill) => skill.alias === undefined));

    const statuses = gateway.plugins();
    for (const status of statuses) {
      for (const skill of status.skills ?? []) {
        assert.equal(skill.alias, undefined, `${status.package} still advertises the contested alias`);
      }
    }
  } finally {
    await gateway.stop();
  }
});
