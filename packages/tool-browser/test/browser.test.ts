import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
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
  /** The proxy each launch was pointed at, so a test can send a request through it. */
  proxyUrls: string[];
  contextProxyUrls: string[];
  contexts: number;
  closedContexts: number;
  closedBrowsers: number;
  visited: string[];
  routes: Array<(route: RouteLike) => void | Promise<void>>;
}

const fakeDriver = (recorder: Recorder, page?: Partial<PageLike>): BrowserDriver => ({
  async launch(options) {
    recorder.launches += 1;
    recorder.proxyUrls.push(String(options.proxy?.server ?? ''));
    const browser: BrowserLike = {
      async newContext(options) {
        recorder.contexts += 1;
        recorder.contextProxyUrls.push(String(options?.proxy?.server ?? ''));
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
  proxyUrls: [],
  contextProxyUrls: [],
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

test('a page whose script never yields is given up on within the timeout, and the next call gets a fresh page', async (t) => {
  // Playwright bounds navigation, not `evaluate` or `title`; a busy main
  // thread answers neither. The first read hangs forever; the second page
  // answers, which is what a fresh context buys.
  const recorder = emptyRecorder();
  let reads = 0;
  const tools = new ToolRegistry();
  const plugin = createBrowserPlugin(
    { allowedHosts: ['example.com'], navigationTimeoutMs: 50 },
    {
      driver: fakeDriver(recorder, {
        evaluate: () => (reads++ === 0 ? new Promise<never>(() => {}) : Promise.resolve('answered')),
      }),
    },
  );
  await plugin.setup({ bus: { emit: async () => undefined, subscribe: () => () => undefined } as never, tools });
  t.after(() => plugin.dispose?.());
  const read = tools.get('browser.read') as Tool;
  const session = sessionFor('busy');

  // Raced against a bound of its own, so a read that never gives up fails
  // this assertion instead of hanging the suite.
  const outcome = await Promise.race([
    read.execute({ url: 'https://example.com/' }, session).then(() => 'answered', (error: Error) => error.message),
    new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), 2_000)),
  ]);
  assert.match(outcome, /did not answer for its text within 50ms.*fresh page/);
  assert.equal(recorder.closedContexts, 1, 'the unresponsive context was closed');

  const again = await read.execute({ url: 'https://example.com/' }, session) as JsonObject;
  assert.equal(again.text, 'answered');
  assert.equal(recorder.contexts, 2, 'the second call ran in a fresh context');
});

test('giving up on a page is itself bounded, when even closing its context hangs', async (t) => {
  // A transport wedged enough that the first `context.close()` never
  // settles either. The call still comes back within the timeout with the
  // same error, and the next call runs in a fresh context; the close
  // carries on unwaited.
  let reads = 0;
  let contexts = 0;
  let closes = 0;
  const routes: Array<(route: RouteLike) => void | Promise<void>> = [];
  const driver: BrowserDriver = {
    async launch() {
      return {
        async newContext() {
          contexts += 1;
          return {
            async newPage() {
              return {
                async goto() {
                  return { status: () => 200 };
                },
                url: () => 'https://example.com/',
                async title() {
                  return 'Example Domain';
                },
                async content() {
                  return '';
                },
                evaluate: () => (reads++ === 0 ? new Promise<never>(() => {}) : Promise.resolve('answered')),
                async screenshot() {
                  return Buffer.from('png');
                },
                async click() {},
                async fill() {},
                async route(_pattern, handler) {
                  routes.push(handler);
                },
                async close() {},
              };
            },
            close: () => (closes++ === 0 ? new Promise<never>(() => {}) : Promise.resolve()),
          };
        },
        async close() {},
      };
    },
  };
  const tools = new ToolRegistry();
  const plugin = createBrowserPlugin({ allowedHosts: ['example.com'], navigationTimeoutMs: 50 }, { driver });
  await plugin.setup({ bus: { emit: async () => undefined, subscribe: () => () => undefined } as never, tools });
  t.after(() => plugin.dispose());
  const read = tools.get('browser.read') as Tool;
  const session = sessionFor('wedged');

  // The page that is about to hang was refused something first.
  await tools.get('browser.goto')!.execute({ url: 'https://example.com/' }, session);
  await routes[0]!({
    request: () => ({ url: () => 'file:///etc/passwd' }),
    async abort() {},
    async continue() {},
  });

  const outcome = await Promise.race([
    read.execute({}, session).then(() => 'answered', (error: Error) => error.message),
    new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), 2_000)),
  ]);
  assert.match(outcome, /did not answer for its text within 50ms.*fresh page/);

  const again = await read.execute({ url: 'https://example.com/' }, session) as JsonObject;
  assert.equal(again.text, 'answered');
  assert.equal(contexts, 2, 'the second call ran in a fresh context');
  // The refusal belonged to the page that was given up on; the fresh page
  // is not told about it, even though the old context never finished closing.
  assert.equal(again.blockedRequests, undefined, 'the abandoned page\'s refusals went with it');
});

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

test('every tool carries the risk the manifest declares, acting included', async () => {
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
  // `gated`, and judged per site from here on. The manifest is the loader's
  // view of the same fact, so a risk lowered in one and not the other is a
  // tool an operator was told one thing about and got another.
  assert.equal(tools.get('browser.act')?.risk, 'gated');
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

test('a refusal is reported once, to the conversation whose page was browsing, and not to one that began later', async (t) => {
  const recorder = emptyRecorder();
  const { plugin, tool } = await pluginWith({ allowedHosts: ['example.com'] }, recorder);
  t.after(() => plugin.dispose());

  await tool('browser.goto').execute({ url: 'https://example.com/' }, sessionFor('first'));
  const proxy = new URL(recorder.contextProxyUrls[0]!);
  // What the page does when a script on it fetches a local address: the
  // request reaches the proxy, and the proxy refuses it.
  const through = (): Promise<number> =>
    new Promise((resolve, reject) => {
      const request = http.request(
        { host: proxy.hostname, port: Number(proxy.port), method: 'GET', path: 'http://localhost:1/health' },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode ?? 0));
        },
      );
      request.on('error', reject);
      request.end();
    });
  assert.equal(await through(), 403);

  // Every result reports, the act included — the next result is the next
  // result, whichever tool produced it.
  const reported = await tool('browser.act').execute({ action: 'click', selector: '#go' }, sessionFor('first')) as JsonObject;
  assert.match(String((reported.blockedRequests as string[])[0]), /localhost/);
  const again = await tool('browser.read').execute({}, sessionFor('first')) as JsonObject;
  assert.equal(again.blockedRequests, undefined, 'a refusal is reported once');

  // A conversation that began after the refusal was never browsing when it
  // happened, and is told nothing about it.
  await tool('browser.goto').execute({ url: 'https://example.com/' }, sessionFor('later'));
  const later = await tool('browser.read').execute({}, sessionFor('later')) as JsonObject;
  assert.equal(later.blockedRequests, undefined);
});

test('a refusal in one conversation is never reported to another under the same policy', async (t) => {
  const recorder = emptyRecorder();
  const { plugin, tool } = await pluginWith({ allowedHosts: ['example.com'] }, recorder);
  t.after(() => plugin.dispose());

  // Two conversations, one policy, one browser — and a proxy each.
  await tool('browser.goto').execute({ url: 'https://example.com/' }, sessionFor('one'));
  await tool('browser.goto').execute({ url: 'https://example.com/' }, sessionFor('two'));
  assert.equal(recorder.launches, 1);
  assert.equal(new Set(recorder.contextProxyUrls).size, 2, 'each context browses through its own proxy');

  // A page in the first conversation is refused a local address, with the
  // whole URL in the reason — which is what must stay out of the second.
  const proxy = new URL(recorder.contextProxyUrls[0]!);
  await new Promise<void>((resolve, reject) => {
    const request = http.request(
      { host: proxy.hostname, port: Number(proxy.port), method: 'GET', path: 'http://127.0.0.1:1/secret?token=abc' },
      (response) => {
        response.resume();
        response.on('end', () => resolve());
      },
    );
    request.on('error', reject);
    request.end();
  });

  const other = await tool('browser.read').execute({}, sessionFor('two')) as JsonObject;
  assert.equal(other.blockedRequests, undefined, 'the other conversation is told nothing');
  const own = await tool('browser.read').execute({}, sessionFor('one')) as JsonObject;
  assert.match(String((own.blockedRequests as string[])[0]), /token=abc/);
});

test('a refusal survives a call that fails after it, and is reported by the next one', async (t) => {
  // The refusal list is emptied by reading it. A `title()` that throws
  // after the drain would take the refusals with it, and no result would
  // ever carry them — so nothing is drained until the result is certain.
  const recorder = emptyRecorder();
  let titles = 0;
  const tools = new ToolRegistry();
  const plugin = createBrowserPlugin(
    { allowedHosts: ['example.com'] },
    {
      driver: fakeDriver(recorder, {
        // The second call is the one that fails, after the refusal below.
        title: () => (titles++ === 1 ? Promise.reject(new Error('Target page, context or browser has been closed')) : Promise.resolve('Example Domain')),
      }),
    },
  );
  await plugin.setup({ bus: { emit: async () => undefined, subscribe: () => () => undefined } as never, tools });
  t.after(() => plugin.dispose());
  const goto = tools.get('browser.goto') as Tool;
  const session = sessionFor('kept');

  await goto.execute({ url: 'https://example.com/' }, session);

  // What the page was refused before the failing call.
  const proxy = new URL(recorder.contextProxyUrls[0]!);
  await new Promise<void>((resolve, reject) => {
    const request = http.request(
      { host: proxy.hostname, port: Number(proxy.port), method: 'GET', path: 'http://127.0.0.1:1/health' },
      (response) => {
        response.resume();
        response.on('end', () => resolve());
      },
    );
    request.on('error', reject);
    request.end();
  });

  await assert.rejects(goto.execute({ url: 'https://example.com/' }, session), /has been closed/);

  const next = await goto.execute({ url: 'https://example.com/' }, session) as JsonObject;
  assert.match(String((next.blockedRequests as string[])[0]), /127\.0\.0\.1/);
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

test('the origin browser.act is judged by comes from the page, never from the call', async (t) => {
  const recorder = emptyRecorder();
  const { plugin, tool } = await pluginWith({ allowedHosts: ['example.com', 'other.example.com'] }, recorder);
  t.after(() => plugin.dispose());
  const act = tool('browser.act');
  const session = sessionFor('acting');

  // Before anything is navigated to there is no page, so there is no origin
  // and no scope can cover the call. Asking must not open one either: this
  // runs while the call is still being *judged*, and a lookup that launched
  // a browser would start one for a call about to be refused.
  assert.equal(act.originFor?.(session), undefined);
  assert.equal(recorder.launches, 0);

  await tool('browser.goto').execute({ url: 'https://example.com/reports/17?token=abc' }, session);
  // The origin of where it is, not the URL: a grant an operator reads as
  // "may act on example.com" must not carry a path or a query with it.
  assert.equal(act.originFor?.(session), 'https://example.com');

  // It follows the page. A conversation that navigates elsewhere is judged
  // against where it now is, so a grant for one site does not travel.
  await tool('browser.goto').execute({ url: 'https://other.example.com/' }, session);
  assert.equal(act.originFor?.(session), 'https://other.example.com');

  // And it is that conversation's page. Contexts are per conversation, and
  // so is the question of where a click would land.
  assert.equal(act.originFor?.(sessionFor('elsewhere')), undefined);

  // A context the idle sweep has closed leaves no origin behind, rather
  // than the last one it happened to be on.
  await plugin.sweepIdle(Date.now() + 10 * 60_000);
  assert.equal(act.originFor?.(session), undefined);
});
