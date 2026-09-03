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

test('a proxied connection the browser abandons is torn down upstream, and close() tears down the rest', async (t) => {
  // A server that never stops talking: the only way its socket closes is
  // if the proxy closes it.
  const upstreamClosed: Array<() => void> = [];
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.write('start ');
    const timer = setInterval(() => response.write('x'), 20);
    response.socket?.on('close', () => {
      clearInterval(timer);
      upstreamClosed.shift()?.();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => {
    // Force-closed: a connection this test proves was leaked would
    // otherwise hold `server.close()` open forever.
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const port = (server.address() as AddressInfo).port;
  const proxy = await createEgressProxy({ allowedHosts: ['localhost'] });
  t.after(() => proxy.close());

  // A bounded wait for the upstream socket to close — the gate, with a way
  // to lose: an upstream nobody tears down fails the assertion at 3s.
  const nextUpstreamClose = (): Promise<'closed' | 'still open'> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve('still open'), 3_000);
      upstreamClosed.push(() => {
        clearTimeout(timer);
        resolve('closed');
      });
    });

  const abandon = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port: proxy.port, method: 'GET', path: `http://localhost:${port}/forever` },
        (response) => {
          response.once('data', () => {
            // What a browser does with a page it left: the socket goes,
            // without an end.
            request.destroy();
            resolve();
          });
        },
      );
      request.on('error', reject);
      request.end();
    });

  const first = nextUpstreamClose();
  await abandon();
  assert.equal(await first, 'closed', 'the upstream socket is torn down when the browser side is');

  // A connection still in use when the proxy closes goes with it.
  const second = nextUpstreamClose();
  await new Promise<void>((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port: proxy.port, method: 'GET', path: `http://localhost:${port}/forever` },
      (response) => response.once('data', () => resolve()),
    );
    request.on('error', () => {});
    request.on('error', reject);
    request.end();
  });
  await proxy.close();
  assert.equal(await second, 'closed', 'close() tears down the upstream sockets it still has');
});

test('a browser is launched pinned to the proxy, loopback included', () => {
  const args = chromiumProxyArgs({ url: 'http://127.0.0.1:9999' });
  assert.ok(args.includes('--proxy-server=http://127.0.0.1:9999'));
  // Without this, Chromium bypasses the proxy for exactly the addresses the
  // proxy exists to refuse.
  assert.ok(args.includes('--proxy-bypass-list=<-loopback>'));
});

test('a permitted connection is never reused by a policy that would have refused it', async (t) => {
  const service = await startInternalService();
  t.after(() => service.close());
  const target = `http://localhost:${service.port}/`;

  // One policy that may reach this host, used first so a socket to it
  // exists and is warm.
  const allowed = await requestThroughPolicy(target, { policy: { allowedHosts: ['localhost'] } });
  assert.equal(allowed.status, 200);

  // A second policy that may not. Node's global agent pools sockets by
  // host and port and knows nothing about `lookup`, so a shared pool would
  // hand this request the connection above — no resolution, no check, and
  // a policy bypass that gets likelier the busier the process is.
  await assert.rejects(
    () => requestThroughPolicy(target, { policy: {} }),
    /Refusing to connect to localhost/,
  );

  // And the same, one layer up: two proxies, two policies, one host.
  const open = await createEgressProxy({ allowedHosts: ['localhost'] });
  const strict = await createEgressProxy({});
  t.after(() => Promise.all([open.close(), strict.close()]));

  const through = (proxy: { port: number }): Promise<number> => new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port: proxy.port, method: 'GET', path: target },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      },
    );
    request.on('error', reject);
    request.end();
  });

  assert.equal(await through(open), 200);
  assert.equal(await through(strict), 403);
});

test('the timeout bounds the whole exchange, not just a quiet socket', async (t) => {
  // A server that dribbles: one byte at a time, often enough that an
  // inactivity timer never fires. Without a wall-clock deadline this
  // request runs until the server tires of it.
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    const dribble = setInterval(() => response.write('x'), 20);
    response.on('close', () => clearInterval(dribble));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => {
    // Connections first: this server never stops writing on its own, so
    // waiting for it to drain is waiting forever — and a cleanup that
    // hangs would turn a failed assertion back into a hung suite.
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const port = (server.address() as AddressInfo).port;

  // Given a way to lose: without the deadline this never settles, and a
  // suite with no timeout would hang rather than report the regression.
  const attempt = requestThroughPolicy(`http://localhost:${port}/slow`, {
    policy: { allowedHosts: ['localhost'] },
    timeoutMs: 300,
  }).then(() => 'completed', (error: Error) => error.message);

  const outcome = await Promise.race([
    attempt,
    new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve('still running'), 5_000);
      timer.unref?.();
    }),
  ]);

  assert.notEqual(outcome, 'still running', 'the request outlived its own timeout');
  assert.match(outcome, /Timed out after 300ms/);
});

test('a CONNECT authority with a bracketed IPv6 host is parsed, not split on every colon', async (t) => {
  const proxy = await createEgressProxy();
  t.after(() => proxy.close());

  const connect = (authority: string): Promise<void> => new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: proxy.port,
      method: 'CONNECT',
      path: authority,
    });
    request.on('connect', (_response, socket) => {
      socket.destroy();
      resolve();
    });
    request.on('response', (response) => {
      response.resume();
      response.on('end', () => resolve());
    });
    request.on('error', reject);
    request.end();
  });

  // Split on every colon, `[fd00::1]:443` yields a host of `[`, which is
  // then looked up in DNS — so the refusal would name a bracket, and an
  // IPv6-literal address a browser is *allowed* to reach would fail as if
  // the policy had refused it.
  await connect('[fd00::1]:443');
  assert.match(proxy.refusals.at(-1) ?? '', /fd00::1/);
  assert.doesNotMatch(proxy.refusals.at(-1) ?? '', /connect to \[/);

  // No port is 443, not a parse failure.
  await connect('[fd00::1]');
  assert.match(proxy.refusals.at(-1) ?? '', /fd00::1/);

  // And the ordinary form still parses as it did.
  await connect('nothing.invalid:443');
  assert.match(proxy.refusals.at(-1) ?? '', /nothing\.invalid/);
});
