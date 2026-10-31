import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';

import { openSocket, startApi } from './harness.ts';

/** A GET naming its own `Host`, which `fetch` will not let a caller set. */
const get = (
  port: number,
  pathname: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port, path: pathname, method: 'GET', headers },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.on('error', reject);
    request.end();
  });

test('a loopback bind refuses a request addressed to any other host name', async () => {
  // DNS rebinding: a page on evil.example re-resolves its own name to
  // 127.0.0.1, so the browser connects here while still sending
  // `Host: evil.example`. Nothing a browser sends can tell that apart from a
  // tunnel except the name itself, and a loopback daemon knows its names.
  const harness = await startApi();
  try {
    const port = Number(new URL(harness.url).port);
    const bearer = `Bearer ${harness.token}`;
    for (const host of [`evil.example:${port}`, 'evil.example', `localhost.evil.example:${port}`, `127.0.0.1.evil.example:${port}`]) {
      // Even the route that needs nothing, and even with the token: the name
      // is checked before anything is answered.
      const live = await get(port, '/api/v1/livez', { host });
      assert.equal(live.status, 403, host);
      const body = JSON.parse(live.body) as { error: { code: string; message: string } };
      assert.equal(body.error.code, 'host_not_allowed', host);

      const health = await get(port, '/api/v1/health', { host, authorization: bearer });
      assert.equal(health.status, 403, host);

      const dashboard = await get(port, '/', { host, authorization: bearer });
      assert.equal(dashboard.status, 403, host);
    }

    // The message names the way in for a legitimate tunnel.
    const refused = await get(port, '/api/v1/livez', { host: 'gateway.example' });
    const { error } = JSON.parse(refused.body) as { error: { message: string } };
    assert.match(error.message, /api\.publicUrl/);
    assert.match(error.message, /gateway\.example/);

    // And the event stream, which a page could otherwise open from there.
    const stream = await openSocket(`ws://127.0.0.1:${port}/api/v1/events`, {
      headers: { authorization: bearer, host: `evil.example:${port}` },
    });
    assert.equal(stream.opened, false);
    assert.equal(stream.status, 403);
  } finally {
    await harness.stop();
  }
});

test('a loopback bind answers to its loopback names', async () => {
  const harness = await startApi();
  try {
    const port = Number(new URL(harness.url).port);
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LocalHost:${port}`, `[::1]:${port}`, 'localhost', '127.0.0.1']) {
      const live = await get(port, '/api/v1/livez', { host });
      assert.equal(live.status, 200, host);
    }
    const stream = await openSocket(`ws://127.0.0.1:${port}/api/v1/events`, {
      headers: { authorization: `Bearer ${harness.token}`, host: `localhost:${port}` },
    });
    assert.equal(stream.opened, true);
    stream.socket.close();
  } finally {
    await harness.stop();
  }
});

test('a tunnel reaches a loopback daemon under the name api.publicUrl gives it', async () => {
  // Tailscale Serve, Cloudflare Tunnel and ngrok all pass the public name
  // through as `Host`, so that name is what the daemon has to be told.
  const harness = await startApi({ options: { publicUrl: 'https://Gateway.example/' } });
  try {
    const port = Number(new URL(harness.url).port);
    for (const host of ['gateway.example', 'gateway.example:443', 'GATEWAY.EXAMPLE']) {
      const live = await get(port, '/api/v1/livez', { host });
      assert.equal(live.status, 200, host);
    }
    const stream = await openSocket(`ws://127.0.0.1:${port}/api/v1/events`, {
      headers: { authorization: `Bearer ${harness.token}`, host: 'gateway.example' },
    });
    assert.equal(stream.opened, true);
    stream.socket.close();

    // Only that name: another one is still a rebinding page.
    const other = await get(port, '/api/v1/livez', { host: 'gateway.example.evil.test' });
    assert.equal(other.status, 403);
    // Loopback still works beside it.
    const local = await get(port, '/api/v1/livez', { host: `127.0.0.1:${port}` });
    assert.equal(local.status, 200);
  } finally {
    await harness.stop();
  }
});

test('a wildcard bind checks no host name, since it cannot know its own', async () => {
  // `0.0.0.0` is reached over LAN or Tailscale addresses the daemon cannot
  // list, and it is already a deliberate exposure the operator was warned of.
  const harness = await startApi({ options: { host: '0.0.0.0' } });
  try {
    const port = Number(new URL(harness.url).port);
    const live = await get(port, '/api/v1/livez', { host: `192.0.2.10:${port}` });
    assert.equal(live.status, 200);
  } finally {
    await harness.stop();
  }
});

test('a Host header a browser could not have sent is not read for the name inside it', async () => {
  const { hostAllowed, allowedHostNames } = await import('../src/auth.ts');
  const names = allowedHostNames('127.0.0.1', undefined);
  // URL parsing would read 127.0.0.1 out of each of these.
  for (const header of ['evil.example@127.0.0.1', 'evil.example:80@localhost', '127.0.0.1/evil', 'localhost\\evil', '127.0.0.1 evil', '127.0.0.1#x']) {
    assert.equal(hostAllowed(names, header), false, header);
  }
  // An HTTP/1.0 client that names no host is not a browser.
  assert.equal(hostAllowed(names, undefined), true);
  // A bind to another loopback address answers to that address too.
  assert.equal(hostAllowed(allowedHostNames('127.0.0.2', undefined), '127.0.0.2:4123'), true);
  // And a non-loopback bind checks nothing.
  assert.equal(allowedHostNames('0.0.0.0', 'https://gateway.example'), undefined);
});
