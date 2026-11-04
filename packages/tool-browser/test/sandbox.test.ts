import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { ToolRegistry, type Session, type Tool } from '@stratusagent/core';
import { parsePluginManifest, validatePluginConfig, type OptionalModuleHost } from '@stratusagent/plugins';

import {
  createBrowserPlugin,
  createPlaywrightDriver,
  type BrowserDriver,
  type BrowserLike,
  type LaunchOptions,
} from '../src/index.ts';

const proxy = { server: 'http://127.0.0.1:1', bypass: '<-loopback>' };
const OPT_OUT = /"chromiumSandbox": false/;

/**
 * A `playwright-core` that records what `chromium.launch` was given, and
 * fails the way the real one does when told to.
 */
const fakePlaywright = (fail?: string) => {
  const launches: Array<Record<string, unknown>> = [];
  const host: OptionalModuleHost = {
    resolve: () => 'playwright-core',
    import: async () => ({
      chromium: {
        async launch(options: Record<string, unknown>): Promise<BrowserLike> {
          launches.push(options);
          if (fail) {
            throw new Error(fail);
          }
          return { newContext: async () => { throw new Error('not used'); }, close: async () => undefined };
        },
      },
    }),
  };
  return { host, launches };
};

const allowed = async () => undefined;

test("the driver turns Chromium's own sandbox on unless told otherwise", async () => {
  const { host, launches } = fakePlaywright();
  const driver = createPlaywrightDriver(host, { sandboxRefusal: allowed });

  await driver.launch({ headless: true, proxy });
  await driver.launch({ headless: true, proxy, chromiumSandbox: true });
  await driver.launch({ headless: true, proxy, chromiumSandbox: false });

  // Playwright's own default is false, which passes --no-sandbox; leaving
  // the option out is the bug this guards against.
  assert.deepEqual(launches.map((options) => options.chromiumSandbox), [true, true, false]);
});

test('a host that refuses the sandbox fails the launch with an error naming the opt-out, before Chromium starts', async () => {
  // macOS: a daemon already inside a sandbox (sandbox-exec) cannot start
  // Chromium's. Chromium itself does not fail the launch there: its helpers
  // die and the first page never opens. So the driver asks first.
  const { host, launches } = fakePlaywright();
  let asked = 0;
  const driver = createPlaywrightDriver(host, {
    sandboxRefusal: async () => {
      asked += 1;
      return 'sandbox-exec: sandbox_apply: Operation not permitted';
    },
  });

  await assert.rejects(driver.launch({ headless: true, proxy }), (error: Error) => {
    assert.match(error.message, /sandbox_apply: Operation not permitted/);
    assert.match(error.message, OPT_OUT);
    assert.doesNotMatch(error.message, /playwright install/, 'not the missing-browser advice');
    return true;
  });
  assert.equal(launches.length, 0, 'Chromium was never started');
  assert.equal(asked, 1);
});

test('with the sandbox turned off the driver does not ask whether the host allows it', async () => {
  const { host, launches } = fakePlaywright();
  let asked = 0;
  const driver = createPlaywrightDriver(host, {
    sandboxRefusal: async () => {
      asked += 1;
      return 'refused';
    },
  });

  await driver.launch({ headless: true, proxy, chromiumSandbox: false });
  assert.equal(asked, 0);
  assert.equal(launches.length, 1);
});

test("Chromium's own sandbox failure (Linux) is reported as that, with the opt-out", async () => {
  // What Playwright 1.64 throws when Chromium prints "No usable sandbox!":
  // it rewrites the log to this box.
  const { host } = fakePlaywright(
    'browserType.launch: Target page, context or browser has been closed\nBrowser logs:\n\nChromium sandboxing failed!\n'
    + '================================\nTo avoid the sandboxing issue, do either of the following:\n',
  );
  const driver = createPlaywrightDriver(host, { sandboxRefusal: allowed, runsAsRoot: () => false });

  await assert.rejects(driver.launch({ headless: true, proxy }), (error: Error) => {
    assert.match(error.message, /Chromium sandboxing failed!/);
    assert.match(error.message, /user namespaces/);
    assert.match(error.message, OPT_OUT);
    assert.doesNotMatch(error.message, /playwright install/);
    return true;
  });
});

test('as root, the same failure says to run the daemon as another user, not to allow user namespaces', async () => {
  // Chromium refuses to sandbox as root ("Running as root without
  // --no-sandbox is not supported. See https://crbug.com/638180.") and
  // Playwright rewrites that line to the same box as "No usable sandbox!",
  // so the message alone can't tell the two apart. No namespace setting
  // fixes this one.
  const { host } = fakePlaywright(
    'browserType.launch: Target page, context or browser has been closed\nBrowser logs:\n\nChromium sandboxing failed!\n'
    + '================================\nTo avoid the sandboxing issue, do either of the following:\n',
  );
  const driver = createPlaywrightDriver(host, { sandboxRefusal: allowed, runsAsRoot: () => true });

  await assert.rejects(driver.launch({ headless: true, proxy }), (error: Error) => {
    assert.match(error.message, /Chromium sandboxing failed!/);
    assert.match(error.message, /as root/);
    assert.match(error.message, /non-root user/);
    assert.doesNotMatch(error.message, /user namespaces/);
    assert.match(error.message, OPT_OUT);
    return true;
  });
});

test('a missing browser still gets the install advice, not the sandbox one', async () => {
  const { host } = fakePlaywright("browserType.launch: Executable doesn't exist at /ms-playwright/chromium-1234/chrome");
  const driver = createPlaywrightDriver(host, { sandboxRefusal: allowed });

  await assert.rejects(driver.launch({ headless: true, proxy }), (error: Error) => {
    assert.match(error.message, /Executable doesn't exist/);
    assert.match(error.message, /npx playwright install chromium/);
    assert.doesNotMatch(error.message, /chromiumSandbox/);
    return true;
  });
});

const session: Session = {
  id: 'sandbox-config',
  agent: { id: 'ava', name: 'Ava' },
  status: 'running',
  messages: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

/** Records each launch's options; the page is just enough for `browser.goto`. */
const recordingDriver = (launches: LaunchOptions[]): BrowserDriver => ({
  async launch(options) {
    launches.push(options);
    return {
      async newContext() {
        return {
          async newPage() {
            let current = 'about:blank';
            return {
              async goto(url: string) {
                current = url;
                return { status: () => 200 };
              },
              url: () => current,
              title: async () => 'Example Domain',
              content: async () => '<p>hello</p>',
              evaluate: async () => 'hello',
              screenshot: async () => Buffer.alloc(0),
              click: async () => undefined,
              fill: async () => undefined,
              route: async () => undefined,
              close: async () => undefined,
            };
          },
          close: async () => undefined,
        };
      },
      close: async () => undefined,
    };
  },
});

const VARIABLE = 'STRATUS_BROWSER_CHROMIUM_SANDBOX';

for (const [config, env, expected] of [
  [{}, {}, true],
  [{ chromiumSandbox: true }, {}, true],
  [{ chromiumSandbox: false }, {}, false],
  // The Docker browser image sets the variable: the config lives in the
  // volume, so the image can't put the key there.
  [{}, { [VARIABLE]: 'false' }, false],
  [{}, { [VARIABLE]: '0' }, false],
  [{}, { [VARIABLE]: 'true' }, true],
  [{}, { [VARIABLE]: '1' }, true],
  [{}, { [VARIABLE]: '' }, true],
  // A key in the config is the operator saying so, and wins either way.
  [{ chromiumSandbox: true }, { [VARIABLE]: 'false' }, true],
  [{ chromiumSandbox: false }, { [VARIABLE]: 'true' }, false],
] as const) {
  test(`plugin config ${JSON.stringify(config)} with env ${JSON.stringify(env)} launches with chromiumSandbox ${expected}`, async (t) => {
    const launches: LaunchOptions[] = [];
    const tools = new ToolRegistry();
    const plugin = createBrowserPlugin(
      { allowedHosts: ['example.com'], ...config },
      { driver: recordingDriver(launches), env },
    );
    await plugin.setup({ bus: { emit: async () => undefined, subscribe: () => () => undefined } as never, tools });
    t.after(() => plugin.dispose());

    await (tools.get('browser.goto') as Tool).execute({ url: 'https://example.com/' }, session);

    assert.equal(launches.length, 1);
    assert.equal(launches[0]?.chromiumSandbox, expected);
  });
}

test("the plugin's config schema accepts chromiumSandbox, and only as a boolean", async () => {
  // The schema refuses keys it doesn't name, so without an entry the
  // daemon would refuse a config carrying the opt-out.
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const manifest = parsePluginManifest(packageJson, '@stratusagent/tool-browser');

  validatePluginConfig(manifest, { enabled: true, chromiumSandbox: false });
  validatePluginConfig(manifest, { enabled: true, chromiumSandbox: true });
  assert.throws(() => validatePluginConfig(manifest, { enabled: true, chromiumSandbox: 'off' }), /chromiumSandbox/);
});

test(`a ${VARIABLE} that is not true, false, 1 or 0 refuses the plugin, naming the variable`, () => {
  // Read as "on" it would look like the image's opt-out applied when it
  // didn't; read as "off" a typo would drop the sandbox. Neither is a guess
  // to make quietly.
  for (const value of ['off', 'no', 'FALSE ', 'disabled']) {
    assert.throws(
      () => createBrowserPlugin({}, { driver: recordingDriver([]), env: { [VARIABLE]: value } }),
      (error: Error) => {
        assert.match(error.message, new RegExp(VARIABLE));
        assert.match(error.message, new RegExp(JSON.stringify(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        return true;
      },
    );
  }
});
