import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  chromiumProxyArgs,
  createEgressProxy,
  requestThroughPolicy,
} from '../src/index.ts';

/** A server on loopback, standing in for everything an agent must not reach. */
const startInternalService = async (): Promise<{ port: number; close: () => Promise<void> }> => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(`internal service reached: ${request.url}`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

test('a name that resolves to loopback is refused at the connection, not just at the URL', async (t) => {
  const service = await startInternalService();
  t.after(() => service.close());

  // `localhost` passes every check a URL string can be given — it is not a
  // literal address, and its scheme is fine. It dies where it has to: at
  // the resolution the socket itself uses.
  await assert.rejects(
    () => requestThroughPolicy(`http://localhost:${service.port}/api/v1/credentials`),
    /Refusing to connect to localhost/,
  );

  // And the service really was reachable — otherwise the test above would
  // pass just as well against a port nothing is listening on.
  const allowed = await requestThroughPolicy(`http://localhost:${service.port}/health`, {
    policy: { allowedHosts: ['localhost'] },
  });
  assert.equal(allowed.status, 200);
  assert.match(allowed.body, /internal service reached: \/health/);
});

test('a response is cut off at the byte cap rather than read whole', async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('x'.repeat(50_000));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;

  const response = await requestThroughPolicy(`http://localhost:${port}/big`, {
    policy: { allowedHosts: ['localhost'] },
    maxBytes: 1_000,
  });
  assert.equal(response.truncated, true);
  assert.ok(response.body.length < 50_000);
});

test('the browser proxy refuses a request the policy refuses, and forwards one it does not', async (t) => {
  const service = await startInternalService();
  t.after(() => service.close());

  const proxy = await createEgressProxy();
  t.after(() => proxy.close());

  const throughProxy = (target: string): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port: proxy.port, method: 'GET', path: target },
        (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            body += chunk;
          });
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
        },
      );
      request.on('error', reject);
      request.end();
    });

  const refused = await throughProxy(`http://localhost:${service.port}/api/v1/credentials`);
  assert.equal(refused.status, 403);
  assert.match(refused.body, /Refusing to connect to localhost/);
  assert.equal(proxy.refusals.length, 1);

  const blocked = await throughProxy('file:///etc/passwd');
  assert.equal(blocked.status, 403);
  assert.match(blocked.body, /only http:, https:/);

  // The same proxy, told this host is fine, carries the request through —
  // so the refusal above is the policy's doing and not a broken proxy.
  const open = await createEgressProxy({ allowedHosts: ['localhost'] });
  t.after(() => open.close());
  const allowed = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port: open.port, method: 'GET', path: `http://localhost:${service.port}/ok` },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.on('error', reject);
    request.end();
  });
  assert.equal(allowed.status, 200);
  assert.match(allowed.body, /internal service reached: \/ok/);
});

test('a browser is launched pinned to the proxy, loopback included', () => {
  const args = chromiumProxyArgs({ url: 'http://127.0.0.1:9999' });
  assert.ok(args.includes('--proxy-server=http://127.0.0.1:9999'));
  // Without this, Chromium bypasses the proxy for exactly the addresses the
  // proxy exists to refuse.
  assert.ok(args.includes('--proxy-bypass-list=<-loopback>'));
});
