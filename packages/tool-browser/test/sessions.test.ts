import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import {
  BrowserSessionPool,
  type BrowserContextLike,
  type BrowserDriver,
  type PageLike,
} from '../src/index.ts';

const stubPage = (): PageLike => ({
  async goto() {
    return { status: () => 200 };
  },
  url: () => 'about:blank',
  async title() {
    return '';
  },
  async content() {
    return '';
  },
  async evaluate() {
    return undefined;
  },
  async screenshot() {
    return Buffer.alloc(0);
  },
  async click() {},
  async fill() {},
  async route() {},
  async close() {},
});

test('a release whose context close settles late does not take the browser from the fresh context that replaced it', async (t) => {
  // The first context's close hangs until the test lets it go — past the
  // bound the tool waits on, the way a wedged transport does — and by then
  // the same conversation has a fresh context in the same browser.
  let contexts = 0;
  let closedBrowsers = 0;
  let finishClose!: () => void;
  const closeHeld = new Promise<void>((resolve) => { finishClose = resolve; });
  const driver: BrowserDriver = {
    async launch() {
      return {
        async newContext() {
          contexts += 1;
          const held = contexts === 1;
          const context: BrowserContextLike = {
            async newPage() {
              return stubPage();
            },
            close: () => (held ? closeHeld : Promise.resolve()),
          };
          return context;
        },
        async close() {
          closedBrowsers += 1;
        },
      };
    },
  };
  const pool = new BrowserSessionPool({ driver, idleMs: 60_000 });
  t.after(() => pool.close());

  await pool.pageFor('a', 1);
  const stale = pool.release('a');
  // The tool gave up waiting; the conversation's next call opens afresh.
  await pool.pageFor('a', 2);
  assert.equal(contexts, 2);
  assert.equal(pool.browserCount, 1);

  finishClose();
  assert.equal(await stale, true);
  // The first browser went with its last context — retired the moment the
  // release began, without waiting on the close — and the replacement
  // lives in a fresh one, which the late-settling close leaves alone.
  assert.equal(closedBrowsers, 1, 'only the browser the stale context lived in was closed');
  assert.equal(pool.browserCount, 1);
  assert.equal(pool.size, 1);
});

test('an idle sweep that reaches a context its session has already replaced leaves the replacement alone', async (t) => {
  // Two idle contexts. The sweep drops the first, whose close is held;
  // meanwhile the second times out, is released, and its session opens a
  // fresh context. When the sweep gets to its snapshot of the second, that
  // context is gone and the id belongs to the replacement.
  let contexts = 0;
  let finishFirstClose!: () => void;
  const firstClose = new Promise<void>((resolve) => { finishFirstClose = resolve; });
  const driver: BrowserDriver = {
    async launch() {
      return {
        async newContext() {
          contexts += 1;
          const held = contexts === 1;
          const context: BrowserContextLike = {
            async newPage() {
              return stubPage();
            },
            close: () => (held ? firstClose : Promise.resolve()),
          };
          return context;
        },
        async close() {},
      };
    },
  };
  const pool = new BrowserSessionPool({ driver, idleMs: 100 });
  t.after(() => pool.close());

  await pool.pageFor('a', 1);
  await pool.pageFor('b', 2);
  const sweep = pool.sweepIdle(1_000);
  assert.equal(await pool.release('b'), true);
  await pool.pageFor('b', 1_001);
  assert.equal(pool.size, 1);

  // (The first browser did go, rightly: with `a` on its way out and `b`
  // released, nothing held it, and the replacement launched a new one.)
  finishFirstClose();
  assert.deepEqual(await sweep, ['a', 'b']);
  assert.equal(pool.size, 1, 'the replacement context is still held');
  assert.equal(pool.browserCount, 1, 'and so is the browser it lives in');
});

test('an eviction listener that throws is reported, and the context and browser are still closed', async (t) => {
  let closedContexts = 0;
  let closedBrowsers = 0;
  const errors: unknown[] = [];
  const driver: BrowserDriver = {
    async launch() {
      return {
        async newContext() {
          const context: BrowserContextLike = {
            async newPage() {
              return stubPage();
            },
            async close() {
              closedContexts += 1;
            },
          };
          return context;
        },
        async close() {
          closedBrowsers += 1;
        },
      };
    },
  };
  const pool = new BrowserSessionPool({
    driver,
    idleMs: 60_000,
    onEvicted: () => {
      throw new Error('the listener is broken');
    },
    onError: (error) => {
      errors.push(error);
    },
  });
  t.after(() => pool.close());

  await pool.pageFor('a', 1);
  assert.equal(await pool.release('a'), true);
  assert.equal(closedContexts, 1, 'the context was closed despite the listener');
  assert.equal(closedBrowsers, 1, 'and the browser, which nothing held any more');
  assert.equal(errors.length, 1);
  assert.match(String((errors[0] as Error).message), /the listener is broken/);
});

test('a release names the page that timed out, and leaves a replacement that took its place alone', async (t) => {
  const driver: BrowserDriver = {
    async launch() {
      return {
        async newContext() {
          const context: BrowserContextLike = {
            async newPage() {
              return stubPage();
            },
            async close() {},
          };
          return context;
        },
        async close() {},
      };
    },
  };
  const pool = new BrowserSessionPool({ driver, idleMs: 60_000 });
  t.after(() => pool.close());

  const first = await pool.pageFor('a', 1);
  assert.equal(await pool.release('a'), true);
  const replacement = await pool.pageFor('a', 2);
  assert.notEqual(replacement, first);

  // The timeout that belonged to the first page fires now, after the
  // sweep took that page and a concurrent call opened this one.
  assert.equal(await pool.release('a', first), false, 'the page named is gone; nothing to release');
  assert.equal(pool.size, 1, 'the replacement is still held');
  assert.equal(await pool.release('a', replacement), true);
  assert.equal(pool.size, 0);
});

test('a browser whose last context never finishes closing is retired at once, and the next call launches afresh', async (t) => {
  let launches = 0;
  let closedBrowsers = 0;
  const driver: BrowserDriver = {
    async launch() {
      launches += 1;
      const held = launches === 1;
      return {
        async newContext() {
          const context: BrowserContextLike = {
            async newPage() {
              return stubPage();
            },
            close: () => (held ? new Promise<never>(() => {}) : Promise.resolve()),
          };
          return context;
        },
        async close() {
          closedBrowsers += 1;
        },
      };
    },
  };
  const pool = new BrowserSessionPool({ driver, idleMs: 60_000 });
  t.after(() => pool.close());

  await pool.pageFor('a', 1);
  // Not awaited: the context's close never settles, so neither does this.
  void pool.release('a');
  assert.equal(pool.browserCount, 0, 'the browser left the pool with its last context');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closedBrowsers, 1, 'and was closed without waiting on the context');

  await pool.pageFor('a', 2);
  assert.equal(launches, 2, 'the next call got a fresh browser, not the wedged one');
});

test('a browser whose close never settles still has its proxy closed', async (t) => {
  let proxyUrl = '';
  const driver: BrowserDriver = {
    async launch(options) {
      proxyUrl = options.proxy.server;
      return {
        async newContext() {
          const context: BrowserContextLike = {
            async newPage() {
              return stubPage();
            },
            async close() {},
          };
          return context;
        },
        close: () => new Promise<never>(() => {}),
      };
    },
  };
  const pool = new BrowserSessionPool({ driver, idleMs: 60_000 });
  await pool.pageFor('a', 1);
  const proxy = new URL(proxyUrl);
  const reaches = (): Promise<boolean> =>
    new Promise((resolve) => {
      const socket = net.connect(Number(proxy.port), proxy.hostname);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
  assert.equal(await reaches(), true, 'the proxy is listening while the browser is up');

  // Not awaited: the browser's close never settles, so neither does this.
  void pool.release('a');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(await reaches(), false, 'the proxy was closed without waiting on the browser');
  t.after(() => undefined);
});

test('releasing an unresponsive page neither waits for another conversation\'s admission nor closes the browser it is being admitted into', async (t) => {
  // The second context to be opened blocks until the test lets it through:
  // a `newContext` that hangs, the way a wedged Chromium does.
  let contexts = 0;
  let closedBrowsers = 0;
  let entered!: () => void;
  const enteredNewContext = new Promise<void>((resolve) => { entered = resolve; });
  let proceed!: () => void;
  const gate = new Promise<void>((resolve) => { proceed = resolve; });
  const driver: BrowserDriver = {
    async launch() {
      return {
        async newContext() {
          contexts += 1;
          if (contexts === 2) {
            entered();
            await gate;
          }
          const context: BrowserContextLike = {
            async newPage() {
              return stubPage();
            },
            async close() {},
          };
          return context;
        },
        async close() {
          closedBrowsers += 1;
        },
      };
    },
  };
  const pool = new BrowserSessionPool({ driver, idleMs: 60_000 });
  t.after(() => pool.close());

  await pool.pageFor('a', 1);
  const second = pool.pageFor('b', 2);
  await enteredNewContext;

  // `a` is the browser's only session as far as the session set can see;
  // `b` has chosen that browser and is opening its context in it. The
  // release must come back now, not after `b`'s context does.
  const released = await Promise.race([
    pool.release('a'),
    new Promise<'still waiting'>((resolve) => setTimeout(() => resolve('still waiting'), 1_000)),
  ]);
  assert.equal(released, true);
  assert.equal(closedBrowsers, 0, 'the browser b is being admitted into stayed open');
  assert.equal(pool.browserCount, 1);

  proceed();
  await second;
  assert.equal(pool.size, 1);
  assert.equal(pool.browserCount, 1);
  assert.equal(closedBrowsers, 0);

  // And with b gone too, nothing holds the browser.
  assert.equal(await pool.release('b'), true);
  assert.equal(pool.browserCount, 0);
  assert.equal(closedBrowsers, 1);
});

/**
 * A browser the test can kill. `die()` does what Playwright's `Browser`
 * does when Chromium goes away: it emits `disconnected`. `hangPages`
 * makes `newPage` never settle, which is what a Chromium that died during
 * page creation did under a nested macOS sandbox.
 */
interface KillableBrowser {
  die(): void;
  closes: number;
  pagesAsked: number;
}

const killableDriver = (options: { hangPages?: (launch: number) => boolean; disconnects?: boolean } = {}) => {
  const browsers: KillableBrowser[] = [];
  let pageAsked: () => void = () => {};
  const driver: BrowserDriver = {
    async launch() {
      const launch = browsers.length + 1;
      const listeners: Array<() => void> = [];
      const handle: KillableBrowser = {
        die: () => {
          for (const listener of listeners) {
            listener();
          }
        },
        closes: 0,
        pagesAsked: 0,
      };
      browsers.push(handle);
      return {
        async newContext() {
          const context: BrowserContextLike = {
            newPage() {
              handle.pagesAsked += 1;
              pageAsked();
              return options.hangPages?.(launch) ? new Promise<PageLike>(() => {}) : Promise.resolve(stubPage());
            },
            async close() {},
          };
          return context;
        },
        async close() {
          handle.closes += 1;
        },
        ...(options.disconnects === false
          ? {}
          : {
            on(event: 'disconnected', listener: () => void) {
              if (event === 'disconnected') {
                listeners.push(listener);
              }
            },
          }),
      };
    },
  };
  /** Resolves the next time any browser is asked for a page. */
  const nextPageAsked = (): Promise<void> => new Promise((resolve) => { pageAsked = resolve; });
  return { driver, browsers, nextPageAsked };
};

test('a browser that dies while a page is being opened fails that call, and the next call launches a fresh one', { timeout: 5_000 }, async (t) => {
  const { driver, browsers, nextPageAsked } = killableDriver({ hangPages: (launch) => launch === 1 });
  const pool = new BrowserSessionPool({ driver });
  t.after(() => pool.close());

  const asked = nextPageAsked();
  const opening = pool.pageFor('a', 1);
  await asked;
  browsers[0]!.die();
  await assert.rejects(opening, /browser quit while this page was opening.*next browser call starts a fresh one/i);
  assert.equal(pool.browserCount, 0, 'the dead browser is out of the pool');

  // The admission queue moved on, and the dead browser is not handed out again.
  await pool.pageFor('a', 2);
  assert.equal(browsers.length, 2);
  assert.equal(pool.browserCount, 1);
  assert.equal(pool.size, 1);
});

test('a browser that dies takes its conversations\' pages with it, and their next call opens a fresh browser', { timeout: 5_000 }, async (t) => {
  const { driver, browsers } = killableDriver();
  const evicted: Array<{ sessionId: string; reason: string }> = [];
  const pool = new BrowserSessionPool({ driver, onEvicted: (event) => evicted.push(event) });
  t.after(() => pool.close());

  const before = await pool.pageFor('a', 1);
  await pool.pageFor('b', 1);
  assert.equal(pool.size, 2);

  browsers[0]!.die();
  assert.equal(pool.size, 0, 'no conversation is left holding a page in a browser that is gone');
  assert.equal(pool.browserCount, 0);
  assert.deepEqual(evicted.map((event) => `${event.sessionId}:${event.reason}`).sort(), ['a:disconnected', 'b:disconnected']);

  const after = await pool.pageFor('a', 2);
  assert.notEqual(after, before);
  assert.equal(browsers.length, 2, 'the next call launched a fresh browser');
  assert.equal(pool.browserCount, 1);
});

test('a browser that disconnects after it was closed on purpose leaves its replacement alone', { timeout: 5_000 }, async (t) => {
  // Playwright emits `disconnected` for a browser the pool closed itself,
  // and that close can settle after the conversation has a fresh browser
  // under the same policy.
  const { driver, browsers } = killableDriver();
  const evicted: string[] = [];
  const pool = new BrowserSessionPool({ driver, onEvicted: ({ sessionId }) => evicted.push(sessionId) });
  t.after(() => pool.close());

  await pool.pageFor('a', 1);
  assert.equal(await pool.release('a'), true);
  await pool.pageFor('a', 2);
  assert.equal(browsers.length, 2);
  evicted.length = 0;

  browsers[0]!.die();
  assert.equal(pool.size, 1);
  assert.equal(pool.browserCount, 1);
  assert.deepEqual(evicted, []);
  assert.equal(browsers[1]!.closes, 0);
});

test('a browser that dies as it hands over a page does not leave that page with the conversation', { timeout: 5_000 }, async (t) => {
  // The page and the disconnect arrive together: the open has already won
  // its race by the time the browser is known to be gone.
  const browsers: KillableBrowser[] = [];
  const base = killableDriver();
  const driver: BrowserDriver = {
    async launch(options) {
      const browser = await base.driver.launch(options);
      const handle = base.browsers[base.browsers.length - 1]!;
      browsers.push(handle);
      if (browsers.length > 1) {
        return browser;
      }
      return {
        ...browser,
        async newContext(contextOptions) {
          const context = await browser.newContext(contextOptions);
          return {
            ...context,
            newPage() {
              const page = context.newPage();
              handle.die();
              return page;
            },
          };
        },
      };
    },
  };
  const pool = new BrowserSessionPool({ driver });
  t.after(() => pool.close());

  await assert.rejects(pool.pageFor('a', 1), /browser quit while this page was opening/i);
  assert.equal(pool.size, 0, 'the page from the dead browser was not kept');
  await pool.pageFor('a', 2);
  assert.equal(browsers.length, 2);
  assert.equal(pool.size, 1);
});

test('a page that never opens fails within the timeout, and the browser is replaced for every call after it', { timeout: 5_000 }, async (t) => {
  // No `disconnected` to go on: the browser is wedged rather than gone.
  const { driver, browsers, nextPageAsked } = killableDriver({ hangPages: (launch) => launch === 1, disconnects: false });
  const pool = new BrowserSessionPool({ driver });
  t.after(() => pool.close());

  const asked = nextPageAsked();
  const startedAt = Date.now();
  const opening = pool.pageFor('a', 1, {}, 50);
  // Queued behind the wedged admission, from another conversation.
  const queued = pool.pageFor('b', 1, {}, 2_000);
  await asked;
  await assert.rejects(opening, /did not open a page within 50ms.*closed.*next browser call starts a fresh one/i);
  assert.ok(Date.now() - startedAt < 1_000, 'the call came back near its timeout');
  assert.equal(browsers[0]!.closes, 1, 'the wedged browser was closed');

  await queued;
  assert.equal(browsers.length, 2, 'the call queued behind it got a fresh browser');
  await pool.pageFor('a', 2, {}, 50);
  assert.equal(pool.size, 2);
  assert.equal(pool.browserCount, 1);
});

test('a page that opens within the timeout keeps its browser', { timeout: 5_000 }, async (t) => {
  const { driver, browsers } = killableDriver({ disconnects: false });
  const pool = new BrowserSessionPool({ driver });
  t.after(() => pool.close());

  await pool.pageFor('a', 1, {}, 50);
  // Past the bound: a timer left running would close a healthy browser.
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(browsers[0]!.closes, 0);
  assert.equal(pool.browserCount, 1);
  await pool.pageFor('b', 2, {}, 50);
  assert.equal(browsers.length, 1);
});
