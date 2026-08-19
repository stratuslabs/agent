import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ToolRegistry, type JsonObject, type Session, type Tool } from '@stratusagent/core';

import {
  createBrowserPlugin,
  type BrowserContextLike,
  type BrowserDriver,
  type BrowserLike,
  type PageLike,
  type RouteLike,
} from '../src/index.ts';

interface Recorder {
  launches: number;
  contexts: number;
  closedContexts: number;
  closedBrowsers: number;
  visited: string[];
  routes: Array<(route: RouteLike) => void | Promise<void>>;
}

const fakeDriver = (recorder: Recorder, page?: Partial<PageLike>): BrowserDriver => ({
  async launch() {
    recorder.launches += 1;
    const browser: BrowserLike = {
      async newContext() {
        recorder.contexts += 1;
        const context: BrowserContextLike = {
          async newPage() {
            let current = 'about:blank';
            const stub: PageLike = {
              async goto(url) {
                recorder.visited.push(url);
                current = url;
                return { status: () => 200 };
              },
              url: () => current,
              async title() {
                return 'Example Domain';
              },
              async content() {
                return '<html><body><p>hello</p></body></html>';
              },
              async evaluate() {
                return 'On kettles\nThe kettle is in the cupboard.';
              },
              async screenshot(options) {
                // Faithful to Playwright: given a path, it writes the file
                // there. The tool's job is to have chosen a good one.
                const bytes = Buffer.from('png');
                if (options.path) {
                  await writeFile(options.path, bytes);
                }
                return bytes;
              },
              async click() {},
              async fill() {},
              async route(_pattern, handler) {
                recorder.routes.push(handler);
              },
              async close() {},
              ...page,
            };
            return stub;
          },
          async close() {
            recorder.closedContexts += 1;
          },
        };
        return context;
      },
      async close() {
        recorder.closedBrowsers += 1;
      },
    };
    return browser;
  },
});

const emptyRecorder = (): Recorder => ({
  launches: 0,
  contexts: 0,
  closedContexts: 0,
  closedBrowsers: 0,
  visited: [],
  routes: [],
});

const sessionFor = (id: string, agentId = 'ava'): Session => ({
  id,
  agent: { id: agentId, name: agentId },
  status: 'running',
  messages: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const pluginWith = async (config: JsonObject, recorder: Recorder) => {
  const tools = new ToolRegistry();
  const plugin = createBrowserPlugin(config, { driver: fakeDriver(recorder) });
  await plugin.setup({ bus: { emit: async () => undefined, subscribe: () => () => undefined } as never, tools });
  return { plugin, tools, tool: (name: string) => tools.get(name) as Tool };
};

test('one browser, a context per conversation, dropped when idle', async (t) => {
  const recorder = emptyRecorder();
  const { plugin, tool } = await pluginWith({ allowedHosts: ['example.com'], idleMs: 60_000 }, recorder);
  t.after(() => plugin.close());

  await tool('browser.goto').execute({ url: 'https://example.com/a' }, sessionFor('conversation-1'));
  await tool('browser.goto').execute({ url: 'https://example.com/b' }, sessionFor('conversation-1'));
  await tool('browser.goto').execute({ url: 'https://example.com/c' }, sessionFor('conversation-2'));

  // One browser however many conversations; one context each, so two
  // conversations never share a login.
  assert.equal(recorder.launches, 1);
  assert.equal(recorder.contexts, 2);

  // The clock is the caller's, so this asserts a decision rather than
  // racing a timer: nothing is idle yet at t+0.
  assert.deepEqual(await plugin.sweepIdle(Date.now()), []);
  const swept = await plugin.sweepIdle(Date.now() + 61_000);
  assert.deepEqual(swept.sort(), ['conversation-1', 'conversation-2']);
  assert.equal(recorder.closedContexts, 2);
  // And the browser goes with the last conversation — an idle Chromium
  // overnight is the leak this pack would otherwise cause.
  assert.equal(recorder.closedBrowsers, 1);
});

test('the concurrency cap drops the oldest conversation, not the newest', async (t) => {
  const recorder = emptyRecorder();
  const evicted: string[] = [];
  const { plugin, tool } = await pluginWith({ allowedHosts: ['example.com'], maxContexts: 2 }, recorder);
  t.after(() => plugin.close());
  void evicted;

  await tool('browser.goto').execute({ url: 'https://example.com/1' }, sessionFor('one'));
  await tool('browser.goto').execute({ url: 'https://example.com/2' }, sessionFor('two'));
  await tool('browser.goto').execute({ url: 'https://example.com/3' }, sessionFor('three'));

  assert.equal(recorder.contexts, 3);
  assert.equal(recorder.closedContexts, 1);
  // The one that has been waiting longest is the one that goes.
  await tool('browser.goto').execute({ url: 'https://example.com/2b' }, sessionFor('two'));
  assert.equal(recorder.contexts, 3, 'session two should still have its context');
});

test('a file: URL is refused before the browser is asked to navigate', async (t) => {
  const recorder = emptyRecorder();
  const { plugin, tool } = await pluginWith({}, recorder);
  t.after(() => plugin.close());

  await assert.rejects(
    () => tool('browser.goto').execute({ url: 'file:///home/ada/.stratus/credentials.json' }, sessionFor('s')),
    /only http:, https:/,
  );
  await assert.rejects(
    () => tool('browser.read').execute({ url: 'http://169.254.169.254/latest/meta-data/' }, sessionFor('s')),
    /link-local/,
  );
  // Never handed to the browser at all: by the time an interception handler
  // sees a local URL, the read has had its chance.
  assert.deepEqual(recorder.visited, []);
});

test('every request the page makes faces the scheme policy, not only the navigation', async (t) => {
  const recorder = emptyRecorder();
  const { plugin, tool } = await pluginWith({ allowedHosts: ['example.com'] }, recorder);
  t.after(() => plugin.close());

  await tool('browser.goto').execute({ url: 'https://example.com/' }, sessionFor('s'));
  const handler = recorder.routes[0];
  assert.ok(handler, 'the page should have been routed');

  const aborted: string[] = [];
  const continued: string[] = [];
  const routeFor = (url: string): RouteLike => ({
    request: () => ({ url: () => url }),
    async abort() {
      aborted.push(url);
    },
    async continue() {
      continued.push(url);
    },
  });

  // A subresource, a redirect target, and a perfectly ordinary image.
  await handler(routeFor('file:///etc/passwd'));
  await handler(routeFor('http://169.254.169.254/latest/meta-data/'));
  await handler(routeFor('https://example.com/logo.png'));

  assert.deepEqual(aborted, ['file:///etc/passwd', 'http://169.254.169.254/latest/meta-data/']);
  assert.deepEqual(continued, ['https://example.com/logo.png']);

  // What was blocked reaches the agent, so a half-rendered page is not a
  // mystery it has to guess at.
  const result = await tool('browser.read').execute({}, sessionFor('s')) as JsonObject;
  assert.equal((result.blockedRequests as string[]).length, 2);
  assert.match(String(result.text), /kettle is in the cupboard/);
});

test('a screenshot lands in the agent’s own workspace and comes back as a path', async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'stratus-shots-'));
  const recorder = emptyRecorder();
  const { plugin, tool } = await pluginWith({ allowedHosts: ['example.com'], workspaceRoot }, recorder);
  t.after(() => plugin.close());

  const result = await tool('browser.screenshot').execute(
    { url: 'https://example.com/' },
    sessionFor('s', 'ava'),
  ) as JsonObject;

  // `file` is the key a channel acts on: an ok result carrying one is
  // delivered as an attachment, which is what makes "screenshot example.com
  // and show me" end in a picture rather than a path.
  assert.match(String(result.file), new RegExp(`${path.sep}ava${path.sep}screenshots${path.sep}`));
  const written = await readdir(path.join(workspaceRoot, 'ava', 'screenshots'));
  assert.equal(written.length, 1);

  // Without somewhere to write, it says so rather than picking a directory
  // on the operator's behalf.
  const homeless = await pluginWith({ allowedHosts: ['example.com'] }, emptyRecorder());
  t.after(() => homeless.plugin.close());
  await assert.rejects(
    () => homeless.tool('browser.screenshot').execute({ url: 'https://example.com/' }, sessionFor('s')),
    /nowhere to write/,
  );
});

test('acting is dangerous and reading is not, exactly as the manifest declares', async () => {
  const manifest = (await import('../package.json', { with: { type: 'json' } })).default as {
    stratus: { contributes: { tools: Array<{ name: string; risk: string }> } };
  };
  const recorder = emptyRecorder();
  const { plugin, tools } = await pluginWith({}, recorder);
  await plugin.close();

  assert.deepEqual(
    tools.list().map((tool) => [tool.name, tool.risk]),
    manifest.stratus.contributes.tools.map((entry) => [entry.name, entry.risk]),
  );
  assert.equal(tools.get('browser.act')?.risk, 'dangerous');
});
