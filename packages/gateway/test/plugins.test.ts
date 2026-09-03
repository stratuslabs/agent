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

test('a tool a plugin registers after load — discovery on reconnect — is reported with its provenance, not as the kernel’s', async () => {
  const home = await newHome();
  let view: { register(tool: unknown): void } | undefined;
  const host = await hostFor({
    'stratus-plugin-bridge': {
      manifest: {
        stratus: { pluginVersion: 1, contributes: { toolsDiscovered: [{ namespace: 'mcp.*', risk: 'gated' }] } },
      },
      module: {
        createPlugin: () => ({
          name: 'bridge',
          setup(context: { tools: { register(tool: unknown): void } }) {
            view = context.tools;
            context.tools.register({ name: 'mcp.linear.create_issue', async execute() { return null; } });
          },
        }),
      },
    },
  });

  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: {} },
    idleTimeoutMs: 0,
    plugins: { 'stratus-plugin-bridge': { enabled: true } },
    pluginHost: host,
    log: () => {},
    warn: () => {},
  });

  await gateway.start();
  try {
    // The bridge's server reconnects and advertises a name it did not at
    // startup. Provenance is derived per read from the plugin's live
    // records, so the catalog must say whose code this is — a snapshot
    // taken at load would report it as the kernel's.
    view!.register({ name: 'mcp.linear.list_projects', async execute() { return null; } });

    const late = gateway.tools().find((tool) => tool.name === 'mcp.linear.list_projects');
    assert.equal(late?.package, 'stratus-plugin-bridge');
    assert.equal(late?.trusted, false);
    assert.equal(late?.risk, 'gated');
    const record = gateway.plugins().find((plugin) => plugin.package === 'stratus-plugin-bridge');
    assert.deepEqual(
      record?.tools?.map((tool) => tool.name).sort(),
      ['mcp.linear.create_issue', 'mcp.linear.list_projects'],
    );
  } finally {
    await gateway.stop();
  }
});

test('the daemon hands a plugin a credential resolver bound to the calling agent', async () => {
  const home = await newHome();
  await mkdir(path.join(home, '.stratus', 'agents'), { recursive: true });
  // Two agents, both allowlisting the name; only one has a key of its own.
  for (const [id, name] of [['ava', 'Ava'], ['juno', 'Juno']]) {
    await writeFile(
      path.join(home, '.stratus', 'agents', `${id}.md`),
      `---\nid: ${id}\nname: ${name}\ntools: [web.*]\ncredentials: [search.apiKey]\n---\n\nYou research things.\n`,
    );
  }
  await writeFile(
    path.join(home, '.stratus', 'credentials.json'),
    JSON.stringify({ named: { shared: { 'search.apiKey': 'fleet-key' }, agents: { ava: { 'search.apiKey': 'ava-key' } } } }),
  );

  let resolver: { resolve(agent: { id: string; name: string; credentials?: string[] }, name: string): Promise<string | undefined> } | undefined;
  const host = await hostFor({
    'stratus-plugin-demosearch': {
      manifest: {
        stratus: {
          pluginVersion: 1,
          contributes: { tools: [{ name: 'web.search', risk: 'safe' }] },
          credentials: ['search.apiKey'],
        },
      },
      module: {
        createPlugin: () => ({
          name: 'demosearch',
          setup(context: { tools: { register(tool: unknown): void }; credentials?: typeof resolver }) {
            resolver = context.credentials;
            context.tools.register({
              name: 'web.search',
              risk: 'safe',
              async execute() {
                return null;
              },
            });
          },
        }),
      },
    },
  });

  const gateway = createGateway({
    env: { homeDir: home, cwd: home, processEnv: {} },
    idleTimeoutMs: 0,
    plugins: { 'stratus-plugin-demosearch': { enabled: true } },
    pluginHost: host,
    log: () => undefined,
    warn: () => undefined,
  });

  await gateway.start();
  try {
    // The line under test is one call site in the daemon, and without it a
    // search backend has no way to reach any key at all — while every unit
    // test around it still passes.
    assert.ok(resolver, 'the daemon gave the plugin no credential resolver');

    const ava = { id: 'ava', name: 'Ava', credentials: ['search.apiKey'] };
    const juno = { id: 'juno', name: 'Juno', credentials: ['search.apiKey'] };
    // Read from the real credentials file, and per agent: its own entry
    // before the fleet's shared one.
    assert.equal(await resolver.resolve(ava, 'search.apiKey'), 'ava-key');
    assert.equal(await resolver.resolve(juno, 'search.apiKey'), 'fleet-key');

    // Both gates still bind through the daemon's resolver: the soul's list…
    await assert.rejects(
      () => resolver!.resolve({ id: 'bare', name: 'Bare' }, 'search.apiKey'),
      /not allowed to access credential/,
    );
    // …and the plugin's own manifest.
    await assert.rejects(
      () => resolver!.resolve(ava, 'github.token'),
      /which its manifest does not declare/,
    );
  } finally {
    await gateway.stop();
  }
});
