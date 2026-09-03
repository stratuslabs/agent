import test from 'node:test';
import assert from 'node:assert/strict';

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
  assert.equal(closedBrowsers, 0, 'the browser the fresh context lives in is still up');
  assert.equal(pool.browserCount, 1);
  assert.equal(pool.size, 1);
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
