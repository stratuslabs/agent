import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserSessionPool, type BrowserDriver, type BrowserLike } from '../src/index.ts';

interface RealBrowser {
  newBrowserCDPSession(): Promise<{ send(method: 'SystemInfo.getProcessInfo'): Promise<{ processInfo: Array<{ type: string; id: number }> }> }>;
}

/**
 * The browser process's pid, from Chromium itself: a launched Playwright
 * browser talks over a pipe and does not hand out its process.
 */
const browserPid = async (browser: RealBrowser): Promise<number> => {
  const session = await browser.newBrowserCDPSession();
  const { processInfo } = await session.send('SystemInfo.getProcessInfo');
  const main = processInfo.find((entry) => entry.type === 'browser');
  assert.ok(main, 'Chromium reported its browser process');
  return main.id;
};

/**
 * The Chromium Playwright finds, or the Chrome a CI runner ships with.
 * Undefined when there is neither, and the test skips with that reason.
 */
const launchable = async (): Promise<{ channel?: string } | undefined> => {
  const { chromium } = await import('playwright-core');
  for (const settings of [{}, { channel: 'chrome' }]) {
    try {
      const browser = await chromium.launch({ headless: true, ...settings });
      await browser.close();
      return settings;
    } catch {
      // Not installed this way; try the next.
    }
  }
  return undefined;
};

const until = async (condition: () => boolean, ms: number): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`still waiting after ${ms}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/**
 * A real Chromium, killed the way a crash or the OOM killer would. What
 * this checks lives in Playwright, not in the pool: that a browser which
 * dies says so with `disconnected`, which is what takes it out of the pool.
 */
test('a real browser that is killed leaves the pool, and the next call launches a fresh one', async (t) => {
  const settings = await launchable();
  if (settings === undefined) {
    t.skip('no Chromium or Chrome to kill');
    return;
  }
  const { chromium } = await import('playwright-core');
  const launched: RealBrowser[] = [];
  const driver: BrowserDriver = {
    async launch(options) {
      const browser = await chromium.launch({ headless: options.headless, proxy: options.proxy, ...settings });
      launched.push(browser as unknown as RealBrowser);
      return browser as unknown as BrowserLike;
    },
  };
  const evicted: string[] = [];
  const pool = new BrowserSessionPool({ driver, onEvicted: ({ sessionId, reason }) => evicted.push(`${sessionId}:${reason}`) });
  t.after(() => pool.close());

  const first = await pool.pageFor('a', 1, {}, 30_000);
  assert.equal(pool.browserCount, 1);
  process.kill(await browserPid(launched[0]!), 'SIGKILL');

  await until(() => pool.browserCount === 0, 10_000);
  assert.equal(pool.size, 0);
  assert.deepEqual(evicted, ['a:disconnected']);

  const second = await pool.pageFor('a', 2, {}, 30_000);
  assert.notEqual(second, first);
  assert.equal(launched.length, 2, 'the next call launched a fresh browser');
  assert.equal(await second.evaluate('1 + 1'), 2, 'and the fresh page works');
});
