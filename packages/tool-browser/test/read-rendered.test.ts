import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { ToolRegistry, type JsonObject, type Session, type Tool } from '@stratusagent/core';

import type { OptionalModuleHost } from '@stratusagent/plugins';

import { macSandboxRefusal } from '../src/driver.ts';
import { createBrowserPlugin } from '../src/index.ts';

/**
 * Any Chromium installed under `PLAYWRIGHT_BROWSERS_PATH`, whatever its
 * revision: one installed for a different Playwright than this package's
 * renders a page just as well, and the default lookup asks for its own.
 */
const installedChromiums = async (): Promise<JsonObject[]> => {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root) {
    return [];
  }
  const entries = await readdir(root).catch(() => [] as string[]);
  return entries
    .filter((entry) => /^chromium-\d+$/.test(entry))
    .flatMap((entry) => ['chrome-linux64', 'chrome-linux'].map((build) => path.join(root, entry, build, 'chrome')))
    .filter((candidate) => existsSync(candidate))
    .map((executablePath) => ({ executablePath }));
};

/**
 * The tests here run a real browser, because what they check — which text
 * is rendered, and whether Chromium starts sandboxed — exists only in a
 * real one; a fake page's `evaluate` returns whatever the fake says. They
 * use a browser named by `CHROME_PATH`, the Chromium Playwright finds, one
 * installed beside it, or the Chrome a CI runner ships with, and skip with
 * a reason only when there is none of them.
 */
const launchable = async (): Promise<JsonObject | undefined> => {
  const { chromium } = await import('playwright-core');
  const named = process.env.CHROME_PATH ? [{ executablePath: process.env.CHROME_PATH }] : [];
  for (const settings of [...named, {}, ...await installedChromiums(), { channel: 'chrome' }]) {
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

/**
 * The rendering tests launch the way the probe above does, without
 * Chromium's own sandbox: they check what a page renders, on hosts (a CI
 * container, an agent's sandboxed shell) that may not allow the sandbox.
 * The sandbox has its own test, at the end.
 */
const RENDER_ONLY = { chromiumSandbox: false };

const session: Session = {
  id: 'read-rendered',
  agent: { id: 'ava', name: 'Ava' },
  status: 'running',
  messages: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const PAGE = `<!doctype html><html><head><style>.gone { display: none }</style></head><body>
<nav>NAVIGATION</nav>
<article style="display: none"><p>DECOY_ARTICLE</p></article>
<article>
  <p>first paragraph</p>
  <p hidden>HIDDEN_ATTRIBUTE</p>
  <p style="display:none">INLINE_NONE</p>
  <p class="gone">CLASS_NONE</p>
  <p style="visibility: hidden">VISIBILITY_HIDDEN</p>
  <script>var SCRIPT_TEXT = 1;</script>
  <p>second paragraph</p>
</article>
</body></html>`;

test('browser.read returns what the page renders, not its hidden text', async (t) => {
  const settings = await launchable();
  if (settings === undefined) {
    t.skip('no Chromium or Chrome to render the page in');
    return;
  }

  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;

  const plugin = createBrowserPlugin({ ...settings, ...RENDER_ONLY, allowedHosts: ['localhost'] });
  t.after(() => plugin.dispose());
  const tools = new ToolRegistry();
  await plugin.setup({
    bus: { emit: async () => undefined, subscribe: () => () => undefined } as never,
    tools,
  });
  const read = tools.get('browser.read') as Tool;

  const result = await read.execute({ url: `http://localhost:${port}/` }, session) as JsonObject;
  const text = String(result.text);

  assert.match(text, /first paragraph/);
  assert.match(text, /second paragraph/);
  // Read from the rendered page, paragraphs stay apart; the clone this
  // replaced ran them together.
  assert.match(text, /first paragraph\s*\n\s*second paragraph/);
  for (const hidden of ['HIDDEN_ATTRIBUTE', 'INLINE_NONE', 'CLASS_NONE', 'VISIBILITY_HIDDEN', 'SCRIPT_TEXT', 'NAVIGATION']) {
    assert.doesNotMatch(text, new RegExp(hidden), `${hidden} is not on the rendered page`);
  }
  // An invisible article is skipped for the visible one, rather than read
  // as raw text because it is first.
  assert.doesNotMatch(text, /DECOY_ARTICLE/);
});

test('browser.read hides the furniture under a CSP that forbids inline styles, and skips a visibility-hidden article', async (t) => {
  const settings = await launchable();
  if (settings === undefined) {
    t.skip('no Chromium or Chrome to render the page in');
    return;
  }

  // A page that allows no inline style at all — so a <style> element the
  // extraction inserts is ignored, and only a mechanism outside the
  // page's style policy hides anything.
  // The page's own styling comes from a stylesheet on its origin, since
  // its policy blocks its inline `style` attributes as much as ours.
  const server = http.createServer((request, response) => {
    if (request.url === '/site.css') {
      response.writeHead(200, { 'content-type': 'text/css' });
      response.end('.invisible { visibility: hidden }');
      return;
    }
    if (request.url === '/watch.js') {
      // The page reporting, after a read, whether its menu is shown again.
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end(`new MutationObserver(() => {
        document.getElementById('out').textContent = 'nav-display=' + getComputedStyle(document.querySelector('nav')).display;
      }).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['style'] });`);
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'self'; style-src 'self'",
    });
    response.end(`<!doctype html><html><head><link rel="stylesheet" href="/site.css"></head><body>
<nav style="COLOR : red;;">NAVIGATION</nav><header>HEADER</header>
<article class="invisible"><p>INVISIBLE_ARTICLE</p></article>
<article><p>the article</p><p id="out"></p><aside>ASIDE</aside><form>FORM</form></article>
<footer>FOOTER</footer>
<script src="/watch.js"></script>
</body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;

  const plugin = createBrowserPlugin({ ...settings, ...RENDER_ONLY, allowedHosts: ['localhost'] });
  t.after(() => plugin.dispose());
  const tools = new ToolRegistry();
  await plugin.setup({
    bus: { emit: async () => undefined, subscribe: () => () => undefined } as never,
    tools,
  });
  const read = tools.get('browser.read') as Tool;

  const result = await read.execute({ url: `http://localhost:${port}/` }, session) as JsonObject;
  const text = String(result.text);
  // A `visibility: hidden` article is rendered and empty; chosen, it would
  // hide the article that is actually there.
  assert.match(text, /the article/);
  for (const furniture of ['NAVIGATION', 'HEADER', 'ASIDE', 'FORM', 'FOOTER', 'INVISIBLE_ARTICLE']) {
    assert.doesNotMatch(text, new RegExp(furniture), `${furniture} is not the article`);
  }

  // Under this policy a re-set style attribute is not applied, so putting
  // the attribute string back alone would leave the menu hidden for good.
  const after = await read.execute({}, session) as JsonObject;
  assert.match(String(after.text), /nav-display=block/);

});

test('browser.read leaves the page as it found it, style attributes byte for byte', async (t) => {
  const settings = await launchable();
  if (settings === undefined) {
    t.skip('no Chromium or Chrome to render the page in');
    return;
  }

  // The page watches its own furniture: whatever the read leaves behind in
  // the attribute, the page writes into its article, where the next read
  // sees it. A style attribute is the page's to compare and select on, and
  // the CSSOM re-serializes the whole of it when one property is touched.
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><body>
<nav id="menu" style="COLOR : red;;color:blue">menu</nav>
<header id="plain">header</header>
<article><p>article</p><p id="out">untouched</p></article>
<script>
  const out = document.getElementById('out');
  new MutationObserver(() => {
    out.textContent = 'menu=' + document.getElementById('menu').getAttribute('style')
      + ' plain=' + document.getElementById('plain').getAttribute('style');
  }).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['style'] });
</script>
</body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;

  const plugin = createBrowserPlugin({ ...settings, ...RENDER_ONLY, allowedHosts: ['localhost'] });
  t.after(() => plugin.dispose());
  const tools = new ToolRegistry();
  await plugin.setup({
    bus: { emit: async () => undefined, subscribe: () => () => undefined } as never,
    tools,
  });
  const read = tools.get('browser.read') as Tool;

  await read.execute({ url: `http://localhost:${port}/` }, session);
  const after = await read.execute({}, session) as JsonObject;
  assert.match(String(after.text), /menu=COLOR : red;;color:blue plain=null/);
});

test('browser.read reads a display: contents article, and a hidden body\'s visible child', async (t) => {
  const settings = await launchable();
  if (settings === undefined) {
    t.skip('no Chromium or Chrome to render the page in');
    return;
  }

  const pages: Record<string, string> = {
    // No box of its own, and its text is on screen: passing over it for a
    // later article would drop the page's actual content.
    '/contents': `<!doctype html><html><body>
<article style="display: contents"><p>FIRST_ARTICLE</p><p hidden>HIDDEN_CHILD</p></article>
<article><p>SECOND_ARTICLE</p></article></body></html>`,
    // Nothing qualifies but the body, which is hidden while one child is
    // shown — the child is what a reader sees.
    '/body': `<!doctype html><html><body style="visibility: hidden">
<p>HIDDEN_TEXT</p><p style="visibility: visible">SHOWN_TEXT</p></body></html>`,
    // An article inside a display: none parent has no box: innerText on it
    // would be the raw text, so it must be passed over.
    '/boxless': `<!doctype html><html><body>
<div style="display: none"><article><p>BOXLESS_ARTICLE</p></article></div>
<article><p>REAL_ARTICLE</p></article></body></html>`,
  };
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(pages[request.url ?? ''] ?? '');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;

  const plugin = createBrowserPlugin({ ...settings, ...RENDER_ONLY, allowedHosts: ['localhost'] });
  t.after(() => plugin.dispose());
  const tools = new ToolRegistry();
  await plugin.setup({
    bus: { emit: async () => undefined, subscribe: () => () => undefined } as never,
    tools,
  });
  const read = tools.get('browser.read') as Tool;
  const textOf = async (route: string): Promise<string> =>
    String((await read.execute({ url: `http://localhost:${port}${route}` }, session) as JsonObject).text);

  const contents = await textOf('/contents');
  assert.match(contents, /FIRST_ARTICLE/);
  assert.doesNotMatch(contents, /HIDDEN_CHILD|SECOND_ARTICLE/);

  const body = await textOf('/body');
  assert.match(body, /SHOWN_TEXT/);
  assert.doesNotMatch(body, /HIDDEN_TEXT/);

  const boxless = await textOf('/boxless');
  assert.match(boxless, /REAL_ARTICLE/);
  assert.doesNotMatch(boxless, /BOXLESS_ARTICLE/);
});

test("a real Chromium starts with its own sandbox by default, or the launch says why it can't and how to opt out", async (t) => {
  const settings = await launchable();
  if (settings === undefined) {
    t.skip('no Chromium or Chrome to launch');
    return;
  }

  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><p>SANDBOX_PAGE</p>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://localhost:${(server.address() as AddressInfo).port}/`;

  // The real playwright-core, with what the plugin hands chromium.launch
  // written down on the way through.
  const launched: Array<Record<string, unknown>> = [];
  const moduleHost: OptionalModuleHost = {
    resolve: (specifier) => import.meta.resolve(specifier),
    async import(specifier) {
      const real = await import(specifier) as { chromium: { launch(options: Record<string, unknown>): Promise<unknown> } };
      return {
        chromium: {
          launch(options: Record<string, unknown>) {
            launched.push(options);
            return real.chromium.launch(options);
          },
        },
      };
    },
  };
  const readWith = async (config: JsonObject): Promise<{ text?: string; error?: string }> => {
    const plugin = createBrowserPlugin({ ...settings, ...config, allowedHosts: ['localhost'] }, { moduleHost });
    t.after(() => plugin.dispose());
    const tools = new ToolRegistry();
    await plugin.setup({ bus: { emit: async () => undefined, subscribe: () => () => undefined } as never, tools });
    // Bounded, so a page that never opens fails here instead of hanging the
    // suite: that hang is the failure the macOS check exists to prevent.
    // The losing timer is cleared, or it holds the test process open for
    // the full 30 seconds after a call that answered.
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        (tools.get('browser.read') as Tool).execute({ url }, session).then(
          (result) => ({ text: String((result as JsonObject).text) }),
          (error: Error) => ({ error: error.message }),
        ),
        new Promise<{ error: string }>((resolve) => {
          timer = setTimeout(() => resolve({ error: 'no answer within 30s' }), 30_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const refusal = process.platform === 'darwin' ? await macSandboxRefusal() : undefined;
  const sandboxed = await readWith({});
  if (refusal !== undefined) {
    // An agent's own shell on macOS, inside sandbox-exec: Chromium is never
    // started, and the error says why and what to set.
    assert.match(String(sandboxed.error), /Chromium's sandbox can't start here/);
    assert.match(String(sandboxed.error), /"chromiumSandbox": false/);
    assert.equal(launched.length, 0);
    t.diagnostic(`this host refuses a nested sandbox (${refusal}); checked the error`);
  } else if (sandboxed.error !== undefined) {
    // The one failure allowed: a Linux host without unprivileged user
    // namespaces. A Mac outside a sandbox must start it.
    assert.notEqual(process.platform, 'darwin', sandboxed.error);
    assert.match(sandboxed.error, /Chromium sandboxing failed|No usable sandbox/);
    assert.match(sandboxed.error, /"chromiumSandbox": false/);
    t.diagnostic("Chromium refused its sandbox on this host; checked the error");
  } else {
    assert.match(String(sandboxed.text), /SANDBOX_PAGE/);
    assert.equal(launched.at(-1)?.chromiumSandbox, true);
    t.diagnostic("rendered with Chromium's sandbox on");
  }

  // The opt-out works wherever the browser does.
  const unsandboxed = await readWith({ chromiumSandbox: false });
  assert.equal(unsandboxed.error, undefined);
  assert.match(String(unsandboxed.text), /SANDBOX_PAGE/);
  assert.equal(launched.at(-1)?.chromiumSandbox, false);
});
