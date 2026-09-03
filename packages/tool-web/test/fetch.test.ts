import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { HOSTILE_URLS } from '@stratusagent/egress';
import { ToolRegistry, type JsonObject, type Session, type Tool } from '@stratusagent/core';

import { createWebPlugin, htmlToText } from '../src/index.ts';

const session: Session = {
  id: 'session-web',
  agent: { id: 'ava', name: 'Ava' },
  status: 'running',
  messages: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const fetchTool = async (config: JsonObject = {}): Promise<Tool> => {
  const tools = new ToolRegistry();
  await createWebPlugin(config).setup({
    bus: { emit: async () => undefined, subscribe: () => () => undefined } as never,
    tools,
  });
  return tools.get('web.fetch') as Tool;
};

test('web.fetch returns a page as readable text', async (t) => {
  const server = http.createServer((request, response) => {
    if (request.url === '/moved') {
      response.writeHead(302, { location: '/article' });
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><head><title>Tea &amp; Kettles</title>
      <style>body { color: red }</style></head>
      <body><nav>skip me</nav><article><h1>On kettles</h1><p>The kettle is in the cupboard.</p>
      <ul><li>one</li><li>two</li></ul></article>
      <script>console.log('not text')</script><footer>also skip</footer></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;

  const tool = await fetchTool({ allowedHosts: ['localhost'] });
  const result = await tool.execute({ url: `http://localhost:${port}/article` }, session) as JsonObject;

  assert.equal(result.status, 200);
  assert.equal(result.title, 'Tea & Kettles');
  assert.match(String(result.text), /On kettles/);
  assert.match(String(result.text), /The kettle is in the cupboard\./);
  assert.match(String(result.text), /- one/);
  // The parts of a page nobody asked for.
  assert.doesNotMatch(String(result.text), /not text/);
  assert.doesNotMatch(String(result.text), /color: red/);
  assert.doesNotMatch(String(result.text), /skip me/);

  const redirected = await tool.execute({ url: `http://localhost:${port}/moved` }, session) as JsonObject;
  assert.deepEqual(
    (redirected.redirects as string[]).map((hop) => new URL(hop).pathname),
    ['/moved', '/article'],
  );
});

test('the timeout bounds the whole exchange, redirects included', async (t) => {
  // Each hop answers well inside the timeout on its own; only the chain
  // exceeds it. A timer per hop would let this one through.
  const server = http.createServer((request, response) => {
    const n = Number(new URL(request.url ?? '/', 'http://x').searchParams.get('n') ?? 0);
    setTimeout(() => {
      if (n >= 3) {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('finally');
      } else {
        response.writeHead(302, { location: `/?n=${n + 1}` });
        response.end();
      }
    }, 150);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;

  const tool = await fetchTool({ allowedHosts: ['localhost'], timeoutMs: 300 });
  const startedAt = Date.now();
  await assert.rejects(
    tool.execute({ url: `http://localhost:${port}/` }, session),
    /Timed out after 300ms across \d redirect\(s\)/,
  );
  assert.ok(Date.now() - startedAt < 600, `gave up after ${Date.now() - startedAt}ms, not at the budget`);
});

test('a call may narrow maxBytes, never raise it', async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('x'.repeat(10_000));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;

  const tool = await fetchTool({ allowedHosts: ['localhost'], maxBytes: 500 });
  const lifted = await tool.execute({ url: `http://localhost:${port}/`, maxBytes: 1_000_000 }, session) as JsonObject;
  assert.equal(String(lifted.text).length, 500, 'a bigger maxBytes does not lift the cap');
  assert.equal(lifted.truncated, true);
  const narrowed = await tool.execute({ url: `http://localhost:${port}/`, maxBytes: 50 }, session) as JsonObject;
  assert.equal(String(narrowed.text).length, 50);
});

test('a redirect into an internal address is refused at the hop, not at the first URL', async (t) => {
  const internal = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('instance credentials');
  });
  await new Promise<void>((resolve) => internal.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => internal.close(() => resolve())));
  const internalPort = (internal.address() as AddressInfo).port;

  // A page whose own URL is unobjectionable, answering with a redirect
  // somewhere the agent may not go. This is the shape that makes
  // invocation-level approval insufficient: the approver saw the first URL.
  const bait = http.createServer((request, response) => {
    response.writeHead(302, {
      location: request.url === '/by-name'
        ? `http://localhost:${internalPort}/latest/meta-data/`
        : 'http://169.254.169.254/latest/meta-data/',
    });
    response.end();
  });
  await new Promise<void>((resolve) => bait.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => bait.close(() => resolve())));
  const baitPort = (bait.address() as AddressInfo).port;

  // Only the bait's own name is exempted, which is what an operator would
  // have written to let an agent reach one host.
  const tool = await fetchTool({ allowedHosts: ['127.0.0.1'] });

  await assert.rejects(
    () => tool.execute({ url: `http://127.0.0.1:${baitPort}/to-metadata` }, session),
    /169\.254\.169\.254 is link-local/,
  );

  // The same redirect written as a *name* rather than an address: nothing
  // in either URL is an address, so the refusal can only come from the
  // resolution the connection itself used.
  await assert.rejects(
    () => tool.execute({ url: `http://127.0.0.1:${baitPort}/by-name` }, session),
    /Refusing to connect to localhost/,
  );

  // And the internal service was genuinely reachable, so the refusals above
  // are the policy's doing rather than a port nothing was listening on.
  const permitted = await fetchTool({ allowedHosts: ['localhost'] });
  const reached = await permitted.execute(
    { url: `http://localhost:${internalPort}/latest/meta-data/` },
    session,
  ) as JsonObject;
  assert.match(String(reached.text), /instance credentials/);
});

test('web.fetch refuses the whole hostile table', async () => {
  const tool = await fetchTool();
  for (const entry of HOSTILE_URLS) {
    await assert.rejects(
      () => tool.execute({ url: entry.url }, session),
      (error: Error) => {
        assert.match(error.message, /Refusing|not a public address|Not a URL/);
        return true;
      },
      `should refuse ${entry.what}: ${entry.url}`,
    );
  }
});

test('the extractor keeps prose and drops furniture', () => {
  // Paragraphs keep their break; a line break inside one does not become one.
  assert.equal(htmlToText('<p>one</p><p>two</p>'), 'one\n\ntwo');
  assert.equal(htmlToText('<div>a<br>b</div>'), 'a\nb');
  // Numeric and common named entities decode; an unknown name is left as
  // written rather than guessed at or dropped.
  assert.equal(htmlToText('<p>tea &amp; toast &#8212; &#x2764;</p>'), 'tea & toast — ❤');
  assert.equal(htmlToText('<p>caf&eacute;</p>'), 'caf&eacute;');
  assert.equal(htmlToText('<!-- hidden --><p>shown</p>'), 'shown');
  // Inline formatting is removed, not spaced out. Every element that
  // separates words became a newline before this point, so a space here
  // would rewrite the page: `un expected` is a word the page does not
  // contain, and a model reading the extraction cannot tell it from one
  // that does.
  assert.equal(htmlToText('<p>un<em>expected</em> results</p>'), 'unexpected results');
  assert.equal(htmlToText('<p>The <strong>kettle</strong>.</p>'), 'The kettle.');
  assert.equal(htmlToText('<p>see <a href="/x">the docs</a>, then stop</p>'), 'see the docs, then stop');
  // …while the elements that do separate words still produce their break.
  assert.equal(htmlToText('<ul><li>one</li><li>two</li></ul>'), '- one\n- two');
  assert.equal(htmlToText('<script>var x = "<p>trap</p>";</script><p>real</p>'), 'real');
});
