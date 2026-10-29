import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  EventBus,
  ToolRegistry,
  type EventIngestHandle,
  type EventIngestResult,
  type JsonObject,
  type Plugin,
  type PluginContext,
} from '@stratusagent/core';

import {
  loadPlugins,
  parsePluginManifest,
  type OptionalModuleHost,
  type PluginEventSourceHost,
} from '../src/index.ts';

// Card 590 phase 2: a plugin feeds events (a poller, a bridge) through
// `PluginContext.events`, bound to the source ids its manifest declares, the
// way a plugin's tools are bound to the names it declares.

const fakeHost = async (
  packages: Record<string, { manifest: unknown; module?: unknown }>,
): Promise<OptionalModuleHost> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-plugin-events-'));
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

const manifest = (eventSources: unknown, tools: unknown[] = []) => ({
  stratus: { pluginVersion: 1, contributes: { tools, eventSources } },
});

/** A plugin that keeps the handle it was given and, optionally, feeds an event during setup. */
const keeper = (handles: Array<EventIngestHandle | undefined>, during?: (events: EventIngestHandle) => Promise<unknown>) => ({
  createPlugin: (): Plugin => ({
    name: 'keeper',
    async setup(context: PluginContext) {
      handles.push(context.events);
      if (during && context.events) {
        await during(context.events);
      }
    },
  }),
});

interface Ingested {
  packageName: string;
  sourceId: string;
  event: JsonObject;
}

const fakeEventHost = (reserved: string[] = []) => {
  const registered: Array<[string, string[]]> = [];
  const ingested: Ingested[] = [];
  const host: PluginEventSourceHost = {
    reserved,
    register(packageName, sourceIds) {
      registered.push([packageName, [...sourceIds]]);
    },
    async ingest(packageName, sourceId, event): Promise<EventIngestResult> {
      ingested.push({ packageName, sourceId, event });
      return { status: 'unmatched' };
    },
  };
  return { host, registered, ingested };
};

const EVENT: JsonObject = { specversion: '1.0', id: 'e-1', source: 'https://github.com/stratuslabs/agent', type: 'com.github.pull_request_review.submitted' };

const parse = (eventSources: unknown) => parsePluginManifest({ name: 'stratus-plugin-poll', ...manifest(eventSources) }, 'stratus-plugin-poll');

test('a manifest declares the event sources its plugin feeds, by name', () => {
  assert.deepEqual(parse([{ name: 'github' }, { name: 'board-poll' }]).contributes.eventSources, [{ name: 'github' }, { name: 'board-poll' }]);
  assert.deepEqual(parse(undefined).contributes.eventSources, []);
});

test('a manifest whose event sources are not names is refused before any code runs', () => {
  assert.throws(() => parse('github'), /contributes\.eventSources must be an array/);
  assert.throws(() => parse([{ name: 'GitHub' }]), /"GitHub" is not an event source name/);
  assert.throws(() => parse([{ name: 'a'.repeat(65) }]), /is not an event source name/);
  assert.throws(() => parse([{ name: 'github' }, { name: 'github' }]), /declares "github" twice/);
});

test('a loaded plugin feeds its declared source through the host, named as itself', async () => {
  const handles: Array<EventIngestHandle | undefined> = [];
  const host = await fakeHost({ 'stratus-plugin-poll': { manifest: manifest([{ name: 'github' }]), module: keeper(handles) } });
  const events = fakeEventHost();

  const result = await loadPlugins({ config: { 'stratus-plugin-poll': {} }, host, tools: new ToolRegistry(), bus: new EventBus(), eventSources: events.host });

  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.loaded[0]?.eventSources, ['github']);
  assert.deepEqual(events.registered, [['stratus-plugin-poll', ['github']]]);
  const handle = handles[0];
  assert.ok(handle, 'a host that takes plugin events hands every plugin the slot');
  assert.deepEqual(await handle.ingest('github', EVENT), { status: 'unmatched' });
  assert.deepEqual(events.ingested, [{ packageName: 'stratus-plugin-poll', sourceId: 'github', event: EVENT }]);
});

test('an event for a source the manifest does not declare is refused, naming what it does declare', async () => {
  const handles: Array<EventIngestHandle | undefined> = [];
  const host = await fakeHost({ 'stratus-plugin-poll': { manifest: manifest([{ name: 'github' }]), module: keeper(handles) } });
  const events = fakeEventHost();
  await loadPlugins({ config: { 'stratus-plugin-poll': {} }, host, tools: new ToolRegistry(), bus: new EventBus(), eventSources: events.host });

  await assert.rejects(() => handles[0]!.ingest('stripe', EVENT), /source "stripe", which its manifest does not declare.*declares: github/);
  assert.deepEqual(events.ingested, []);
});

test('an event fed during setup is refused: nothing commits until the plugin has loaded whole', async () => {
  const handles: Array<EventIngestHandle | undefined> = [];
  let refusal: unknown;
  const module = keeper(handles, async (events) => {
    refusal = await events.ingest('github', EVENT).then(() => undefined, (error: unknown) => error);
  });
  const host = await fakeHost({ 'stratus-plugin-eager': { manifest: manifest([{ name: 'github' }]), module } });
  const events = fakeEventHost();

  const result = await loadPlugins({ config: { 'stratus-plugin-eager': {} }, host, tools: new ToolRegistry(), bus: new EventBus(), eventSources: events.host });

  assert.deepEqual(result.failures, []);
  assert.match(refusal instanceof Error ? refusal.message : String(refusal), /before it finished loading/);
  assert.deepEqual(events.ingested, []);
});

test('a plugin refused at load registers no source, and its handle refuses every event after', async () => {
  const handles: Array<EventIngestHandle | undefined> = [];
  const module = {
    createPlugin: (): Plugin => ({
      name: 'half',
      setup(context) {
        handles.push(context.events);
        // Undeclared, so the whole plugin is refused at commit.
        context.tools.register({ name: 'half.undeclared', async execute() { return 'x'; } });
      },
    }),
  };
  const host = await fakeHost({ 'stratus-plugin-half': { manifest: manifest([{ name: 'github' }], [{ name: 'half.ok', risk: 'safe' }]), module } });
  const events = fakeEventHost();

  const result = await loadPlugins({ config: { 'stratus-plugin-half': {} }, host, tools: new ToolRegistry(), bus: new EventBus(), eventSources: events.host });

  assert.equal(result.failures.length, 1);
  assert.deepEqual(events.registered, []);
  await assert.rejects(() => handles[0]!.ingest('github', EVENT), /did not load/);
  assert.deepEqual(events.ingested, []);
});

test('a plugin declaring a source the config already serves is refused whole, before its code runs', async () => {
  let imported = false;
  const host = await fakeHost({
    'stratus-plugin-poll': { manifest: manifest([{ name: 'github' }]), module: { get createPlugin() { imported = true; return keeper([]).createPlugin; } } },
  });
  const events = fakeEventHost(['github']);

  const result = await loadPlugins({ config: { 'stratus-plugin-poll': {} }, host, tools: new ToolRegistry(), bus: new EventBus(), eventSources: events.host });

  assert.deepEqual(result.loaded, []);
  assert.match(result.failures[0]?.reason ?? '', /event source "github", which is already configured in the "events" block/);
  assert.equal(imported, false);
  assert.deepEqual(events.registered, []);
});

test('two plugins declaring one source: the second is refused, naming the first', async () => {
  const host = await fakeHost({
    'stratus-plugin-a': { manifest: manifest([{ name: 'github' }]), module: keeper([]) },
    'stratus-plugin-b': { manifest: manifest([{ name: 'github' }]), module: keeper([]) },
  });
  const events = fakeEventHost();

  const result = await loadPlugins({
    config: { 'stratus-plugin-a': {}, 'stratus-plugin-b': {} },
    host,
    tools: new ToolRegistry(),
    bus: new EventBus(),
    eventSources: events.host,
  });

  assert.deepEqual(result.loaded.map((plugin) => plugin.package), ['stratus-plugin-a']);
  assert.match(result.failures[0]?.reason ?? '', /stratus-plugin-b declares event source "github", which is already fed by stratus-plugin-a/);
  assert.deepEqual(events.registered, [['stratus-plugin-a', ['github']]]);
});

test('a host that takes no plugin events hands no handle', async () => {
  const handles: Array<EventIngestHandle | undefined> = [];
  const host = await fakeHost({ 'stratus-plugin-poll': { manifest: manifest([{ name: 'github' }]), module: keeper(handles) } });

  const result = await loadPlugins({ config: { 'stratus-plugin-poll': {} }, host, tools: new ToolRegistry(), bus: new EventBus() });

  assert.deepEqual(result.failures, []);
  assert.equal(handles.length, 1);
  assert.equal(handles[0], undefined);
});
