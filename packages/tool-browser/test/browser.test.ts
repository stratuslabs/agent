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

test('a call may narrow maxTextBytes, never raise it', async (t) => {
  const recorder = emptyRecorder();
  const tools = new ToolRegistry();
  const plugin = createBrowserPlugin(
    { allowedHosts: ['example.com'], maxTextBytes: 20 },
    { driver: fakeDriver(recorder, { async evaluate() { return 'x'.repeat(1_000); } }) },
  );
  await plugin.setup({ bus: { emit: async () => undefined, subscribe: () => () => undefined } as never, tools });
  t.after(() => plugin.dispose?.());
  const read = tools.get('browser.read') as Tool;

  const lifted = await read.execute({ url: 'https://example.com/', maxBytes: 1_000_000 }, sessionFor('s1')) as JsonObject;
  assert.equal(lifted.truncated, true);
  assert.ok(String(lifted.text).startsWith('x'.repeat(20) + '\n'), 'a bigger maxBytes does not lift the cap');
  const narrowed = await read.execute({ url: 'https://example.com/', maxBytes: 5 }, sessionFor('s1')) as JsonObject;
  assert.ok(String(narrowed.text).startsWith('xxxxx\n'));
});

test('one browser, a context per conversation, dropped when idle', async (t) => {
  const recorder = emptyRecorder();
  const { plugin, tool } = await pluginWith({ allowedHosts: ['example.com'], idleMs: 60_000 }, recorder);
  t.after(() => plugin.dispose());

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
  t.after(() => plugin.dispose());
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
  t.after(() => plugin.dispose());

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
  t.after(() => plugin.dispose());

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
  t.after(() => plugin.dispose());

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
  t.after(() => homeless.plugin.dispose());
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
  await plugin.dispose();

  assert.deepEqual(
    tools.list().map((tool) => [tool.name, tool.risk]),
    manifest.stratus.contributes.tools.map((entry) => [entry.name, entry.risk]),
  );
  assert.equal(tools.get('browser.act')?.risk, 'dangerous');
});

test('the plugin is torn down through the hook a host actually calls', async () => {
  const recorder = emptyRecorder();
  const { plugin, tool } = await pluginWith({ allowedHosts: ['example.com'] }, recorder);

  await tool('browser.goto').execute({ url: 'https://example.com/' }, sessionFor('s'));
  assert.equal(recorder.launches, 1);

  // `dispose` is the kernel's teardown hook, and the only one the gateway
  // and the CLI call. A plugin that named its cleanup anything else would
  // leave a Chromium and a listening proxy behind every shutdown — and a
  // `stratus run` that never exits.
  assert.equal(typeof (plugin as { dispose?: unknown }).dispose, 'function');
  await plugin.dispose();
  assert.equal(recorder.closedContexts, 1);
  assert.equal(recorder.closedBrowsers, 1);
});

test('an agent whose policy is narrower than the default gets a browser that enforces it', async (t) => {
  const recorder = emptyRecorder();
  // A permissive default, and one agent locked down under it — the shape an
  // operator writes to exempt everyone but Ava, or to exempt only Ava.
  const { plugin, tool } = await pluginWith(
    { allowPrivateAddresses: true, agents: { ava: { allowPrivateAddresses: false } } },
    recorder,
  );
  t.after(() => plugin.dispose());

  await tool('browser.goto').execute({ url: 'https://example.com/' }, sessionFor('juno-1', 'juno'));
  await tool('browser.goto').execute({ url: 'https://example.com/' }, sessionFor('ava-1', 'ava'));

  // Two browsers, because a proxy is chosen when Chromium launches: a
  // context inside the permissive browser could not have enforced Ava's
  // narrower policy, and interception cannot narrow a hostname without
  // re-opening the rebinding race the proxy closes.
  assert.equal(recorder.launches, 2);

  // Ava's own policy is what refuses hers, at her browser's proxy.
  await assert.rejects(
    () => tool('browser.goto').execute({ url: 'http://169.254.169.254/' }, sessionFor('ava-1', 'ava')),
    /link-local/,
  );
  // And the permissive agent still has what the default granted: the two
  // are enforced separately rather than one winning.
  const permitted = await tool('browser.goto').execute(
    { url: 'http://169.254.169.254/' },
    sessionFor('juno-1', 'juno'),
  ) as JsonObject;
  assert.equal(permitted.url, 'http://169.254.169.254/');

  // A third agent with no entry shares the default's browser rather than
  // launching a third.
  await tool('browser.goto').execute({ url: 'https://example.com/' }, sessionFor('rex-1', 'rex'));
  assert.equal(recorder.launches, 2);
});

test('one agent’s blocked requests are not reported to another', async (t) => {
  const recorder = emptyRecorder();
  const { plugin, tool } = await pluginWith({ allowedHosts: ['example.com'] }, recorder);
  t.after(() => plugin.dispose());

  await tool('browser.goto').execute({ url: 'https://example.com/' }, sessionFor('ava-session', 'ava'));
  await tool('browser.goto').execute({ url: 'https://example.com/' }, sessionFor('juno-session', 'juno'));

  const [avaRoute, junoRoute] = recorder.routes;
  assert.ok(avaRoute && junoRoute, 'both pages were routed');

  const routeFor = (url: string): RouteLike => ({
    request: () => ({ url: () => url }),
    async abort() {},
    async continue() {},
  });
  // Ava's page asks for something with a secret in it and is refused.
  await avaRoute(routeFor('file:///home/ada/.stratus/credentials.json?token=ava-secret'));

  const ava = await tool('browser.read').execute({}, sessionFor('ava-session', 'ava')) as JsonObject;
  assert.match(String((ava.blockedRequests as string[])[0]), /ava-secret/);

  // Juno's page was refused nothing, and must not be handed Ava's URL —
  // the contexts are isolated, and a report assembled process-wide would
  // hand back exactly what that isolation exists to prevent.
  const juno = await tool('browser.read').execute({}, sessionFor('juno-session', 'juno')) as JsonObject;
  assert.equal(juno.blockedRequests, undefined);
});

test('the idle sweep runs on its own timer, not only when a caller asks for it', async (t) => {
  // A mocked clock rather than a slept-through one: this asserts that the
  // pool schedules the sweep, and a test that waited for a real interval
  // would be racing the machine it runs on.
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });

  const recorder = emptyRecorder();
  const { plugin, tool } = await pluginWith({ allowedHosts: ['example.com'], idleMs: 60_000 }, recorder);
  t.after(() => plugin.dispose());

  await tool('browser.goto').execute({ url: 'https://example.com/' }, sessionFor('quiet'));
  assert.equal(recorder.launches, 1);
  assert.equal(recorder.closedContexts, 0);

  // Nobody calls sweepIdle here. `idleMs` has to mean something on its own,
  // or it is a setting that reads as a promise the daemon never keeps.
  t.mock.timers.tick(60_000);
  await new Promise((resolve) => {
    setImmediate(resolve);
  });

  assert.equal(recorder.closedContexts, 1, 'the idle context was closed by the timer');
  assert.equal(recorder.closedBrowsers, 1, 'and the browser went with its last conversation');
});

test('the context cap holds when a burst of conversations starts at once', async (t) => {
  const recorder = emptyRecorder();
  const { plugin, tool } = await pluginWith({ allowedHosts: ['example.com'], maxContexts: 2 }, recorder);
  t.after(() => plugin.dispose());

  // Creating a context yields — a real driver talks to a browser — which is
  // what makes an unserialized check-then-create wrong: every call in the
  // burst sees room before any of them has taken it.

  await Promise.all(
    ['one', 'two', 'three', 'four', 'five'].map((name) =>
      tool('browser.goto').execute({ url: 'https://example.com/' }, sessionFor(name))),
  );

  // Five conversations, a cap of two: three contexts were evicted as they
  // went, and at no point were more than two open.
  assert.equal(recorder.contexts, 5);
  assert.equal(recorder.closedContexts, 3);
  assert.equal(recorder.contexts - recorder.closedContexts, 2);
});

test('a context that never got a page is closed, and a browser nobody holds goes with it', async (t) => {
  const recorder = emptyRecorder();
  // Chromium dying during page initialization: `newContext` succeeded,
  // `newPage` did not.
  const driver: BrowserDriver = {
    async launch() {
      recorder.launches += 1;
      return {
        async newContext() {
          recorder.contexts += 1;
          return {
            async newPage() {
              throw new Error('Target page, context or browser has been closed');
            },
            async close() {
              recorder.closedContexts += 1;
            },
          };
        },
        async close() {
          recorder.closedBrowsers += 1;
        },
      };
    },
  };

  const tools = new ToolRegistry();
  const plugin = createBrowserPlugin({ allowedHosts: ['example.com'] }, { driver });
  await plugin.setup({ bus: { emit: async () => undefined, subscribe: () => () => undefined } as never, tools });
  t.after(() => plugin.dispose());

  await assert.rejects(
    () => (tools.get('browser.goto') as Tool).execute({ url: 'https://example.com/' }, sessionFor('s')),
    /has been closed/,
  );

  // Neither is tracked anywhere the idle sweep or shutdown would find, so
  // this is the only place they can be released.
  assert.equal(recorder.closedContexts, 1);
  assert.equal(recorder.closedBrowsers, 1);

  // And the dead browser is not handed to the next caller.
  await assert.rejects(
    () => (tools.get('browser.goto') as Tool).execute({ url: 'https://example.com/' }, sessionFor('t')),
    /has been closed/,
  );
  assert.equal(recorder.launches, 2);
});
