import test from 'node:test';
import assert from 'node:assert/strict';

import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { ToolRegistry, type Session, type Tool } from '@stratusagent/core';
import { HOSTILE_URLS } from '@stratusagent/egress';
import { createWebPlugin } from '@stratusagent/tool-web';

import { createBrowserPlugin, type BrowserDriver } from '../src/index.ts';

/**
 * The acceptance criterion this file exists for: `web.fetch` refuses the
 * same addresses and schemes as `browser.*`, proven by running the *same*
 * table through both. If the shared module is ever forked, this is what
 * fails — and it fails in whichever package forked it, because both halves
 * read the one list.
 */

const session: Session = {
  id: 'shared-policy',
  agent: { id: 'ava', name: 'Ava' },
  status: 'running',
  messages: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

/**
 * A browser that makes its requests the way Chromium does: through whatever
 * proxy it was launched with. Nothing here refuses anything on its own, so
 * every refusal below is the policy's — and a browser stub that simply
 * returned success would prove nothing at all about a *name* like
 * `localhost`, whose refusal happens at the connection.
 */
const proxyHonouringDriver = (): BrowserDriver => ({
  async launch(options) {
    const fetchThroughProxy = (proxy: URL, target: string): Promise<void> => new Promise((resolve, reject) => {
      const request = http.request(
        { host: proxy.hostname, port: Number(proxy.port), method: 'GET', path: target },
        (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            body += chunk;
          });
          response.on('end', () => {
            if ((response.statusCode ?? 0) >= 400) {
              reject(new Error(body || `HTTP ${response.statusCode}`));
              return;
            }
            resolve();
          });
        },
      );
      request.on('error', reject);
      request.end();
    });

    return {
      async newContext(contextOptions) {
        // A context's own proxy when it has one, the browser's otherwise —
        // which is what Chromium does.
        const proxy = new URL(contextOptions?.proxy?.server ?? options.proxy.server);
        return {
          async newPage() {
            let current = 'about:blank';
            return {
              async goto(url: string) {
                if (url.startsWith('http://')) {
                  await fetchThroughProxy(proxy, url);
                }
                current = url;
                return { status: () => 200 };
              },
              url: () => current,
              async title() {
                return 'anything';
              },
              async content() {
                return '';
              },
              async evaluate() {
                return '';
              },
              async screenshot() {
                return Buffer.from('');
              },
              async click() {},
              async fill() {},
              async route() {},
              async close() {},
            };
          },
          async close() {},
        };
      },
      async close() {},
    };
  },
});

const toolsFor = async (): Promise<{ web: Tool; browser: Tool; close: () => Promise<void> }> => {
  const registry = new ToolRegistry();
  const bus = { emit: async () => undefined, subscribe: () => () => undefined } as never;
  await createWebPlugin({}).setup({ bus, tools: registry });
  const browserPlugin = createBrowserPlugin({}, { driver: proxyHonouringDriver() });
  await browserPlugin.setup({ bus, tools: registry });
  return {
    web: registry.get('web.fetch') as Tool,
    browser: registry.get('browser.goto') as Tool,
    close: async () => { await browserPlugin.dispose(); },
  };
};

test('web.fetch and browser.goto refuse the same hostile URLs', async (t) => {
  const { web, browser, close } = await toolsFor();
  t.after(() => close());

  for (const entry of HOSTILE_URLS) {
    const webRefusal = await web.execute({ url: entry.url }, session).then(
      () => undefined,
      (error: Error) => error.message,
    );
    const browserRefusal = await browser.execute({ url: entry.url }, session).then(
      () => undefined,
      (error: Error) => error.message,
    );

    assert.ok(webRefusal, `web.fetch should refuse ${entry.what}: ${entry.url}`);
    assert.ok(browserRefusal, `browser.goto should refuse ${entry.what}: ${entry.url}`);
  }
});

test('a per-agent policy is enforced where connections are made, not only where URLs are read', async (t) => {
  // An internal service, reachable only by name — so nothing in the URL
  // gives it away and only the connection can refuse it.
  const service = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('internal service reached');
  });
  await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => service.close(() => resolve())));
  const port = (service.address() as AddressInfo).port;

  const registry = new ToolRegistry();
  const plugin = createBrowserPlugin(
    // The permissive default, with one agent locked down under it.
    { allowedHosts: ['localhost'], agents: { ava: { allowedHosts: [] } } },
    { driver: proxyHonouringDriver() },
  );
  await plugin.setup({
    bus: { emit: async () => undefined, subscribe: () => () => undefined } as never,
    tools: registry,
  });
  t.after(() => plugin.dispose());
  const goto = registry.get('browser.goto') as Tool;

  const asAgent = (agentId: string): Session => ({
    ...session,
    id: `session-${agentId}`,
    agent: { id: agentId, name: agentId },
  });

  // Juno has the default exemption and gets through.
  const reached = await goto.execute({ url: `http://localhost:${port}/` }, asAgent('juno'));
  assert.ok(reached);

  // Ava's config takes it away. Nothing about the URL differs — the
  // refusal has to come from the proxy her browser was launched with,
  // which is the whole reason she gets her own.
  await assert.rejects(
    () => goto.execute({ url: `http://localhost:${port}/` }, asAgent('ava')),
    /Refusing to connect to localhost/,
  );
});
