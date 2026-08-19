import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { allowedOrigins, ensureGatewayToken } from '../src/auth.ts';
import { authority } from '../src/index.ts';
import { newHome, openSocket, startApi } from './harness.ts';

/**
 * A cookie, extracted from the one-time-token exchange the way a browser
 * would take it.
 */
const signIn = async (harness: Awaited<ReturnType<typeof startApi>>): Promise<string> => {
  const minted = await harness.call('/api/v1/auth/ott', { method: 'POST' });
  assert.equal(minted.status, 200);
  const { url } = await minted.json() as { url: string };

  const exchanged = await fetch(url, { redirect: 'manual' });
  assert.equal(exchanged.status, 302);
  assert.equal(exchanged.headers.get('location'), '/');
  const setCookie = exchanged.headers.get('set-cookie');
  assert.ok(setCookie, 'the exchange sets a session cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  return setCookie.split(';')[0] ?? '';
};

test('every route and the WS upgrade reject a request with no credential', async () => {
  const harness = await startApi();
  try {
    const unauthenticated = [
      ['GET', '/api/v1/health'],
      ['GET', '/api/v1/agents'],
      ['POST', '/api/v1/agents'],
      ['PUT', '/api/v1/agents/ava'],
      ['GET', '/api/v1/sessions'],
      ['GET', '/api/v1/sessions/s-1'],
      ['POST', '/api/v1/sessions/s-1/messages'],
      ['GET', '/api/v1/approvals'],
      ['POST', '/api/v1/approvals'],
      ['GET', '/api/v1/catalog/models'],
      ['GET', '/api/v1/credentials'],
      ['POST', '/api/v1/credentials/verify'],
      ['PUT', '/api/v1/credentials/anthropic'],
      ['PUT', '/api/v1/credentials/channels/slack'],
      ['GET', '/api/v1/config'],
      ['PUT', '/api/v1/config'],
      ['POST', '/api/v1/roster/reload'],
      ['POST', '/api/v1/auth/ott'],
    ] as const;

    for (const [method, pathname] of unauthenticated) {
      const response = await harness.call(pathname, { method, auth: 'none' });
      assert.equal(response.status, 401, `${method} ${pathname} should be unauthorized`);
      const body = await response.json() as { error: { code: string } };
      assert.equal(body.error.code, 'unauthorized', `${method} ${pathname}`);
    }

    // The upgrade is the one that would otherwise slip through: it is not a
    // route, and nothing about a WebSocket handshake is covered by the checks
    // an ordinary request goes through.
    const refused = await openSocket(`${harness.url.replace('http', 'ws')}/api/v1/events`);
    assert.equal(refused.opened, false);
    assert.equal(refused.status, 401);

    // And a wrong token is a rejection, not a fallthrough to anything else.
    const wrong = await harness.call('/api/v1/health', {
      auth: 'none',
      headers: { authorization: 'Bearer not-the-token' },
    });
    assert.equal(wrong.status, 401);
  } finally {
    await harness.stop();
  }
});

test('the gateway token file is 0600', async () => {
  const harness = await startApi();
  try {
    const stats = await stat(path.join(harness.home, '.stratus', 'gateway-token'));
    assert.equal(stats.mode & 0o777, 0o600);

    // The discovery file carries a pid and a port, and sits beside the
    // credentials — same posture.
    const info = await stat(path.join(harness.home, '.stratus', 'gateway.json'));
    assert.equal(info.mode & 0o777, 0o600);
  } finally {
    await harness.stop();
  }
});

test('a one-time token is rejected on second use', async () => {
  const harness = await startApi();
  try {
    const minted = await harness.call('/api/v1/auth/ott', { method: 'POST' });
    const { url } = await minted.json() as { url: string };

    const first = await fetch(url, { redirect: 'manual' });
    assert.equal(first.status, 302);

    // Spent, whether or not the first use succeeded. A URL travels through a
    // browser launcher, a history, and possibly a log — one trip is all it
    // gets.
    const second = await fetch(url, { redirect: 'manual' });
    assert.equal(second.status, 401);
    const body = await second.json() as { error: { code: string } };
    assert.equal(body.error.code, 'invalid_one_time_token');

    // A token that was never minted is refused the same way.
    const forged = await fetch(`${harness.url}/api/v1/auth/session?ott=made-up`, { redirect: 'manual' });
    assert.equal(forged.status, 401);
  } finally {
    await harness.stop();
  }
});

test('a session cookie authenticates, and cannot mint another session', async () => {
  const harness = await startApi();
  try {
    const cookie = await signIn(harness);

    const withCookie = await harness.call('/api/v1/health', { auth: 'cookie', cookie });
    assert.equal(withCookie.status, 200);

    // The mint is the bootstrap for cookie sessions. A cookie minting another
    // would turn a stolen session into a permanent, re-shareable credential.
    const escalation = await harness.call('/api/v1/auth/ott', { method: 'POST', auth: 'cookie', cookie });
    assert.equal(escalation.status, 403);
    const body = await escalation.json() as { error: { code: string } };
    assert.equal(body.error.code, 'bearer_required');
  } finally {
    await harness.stop();
  }
});

test('a cookie request from another origin is refused, and a bearer one is not', async () => {
  const harness = await startApi();
  try {
    const cookie = await signIn(harness);
    const port = new URL(harness.url).port;
    // The exact case the origin check exists for: SameSite ignores ports, so
    // a page on another port of this same host is "same site" and its
    // requests carry this cookie automatically.
    const foreign = `http://127.0.0.1:${Number(port) + 1}`;

    const refused = await harness.call('/api/v1/roster/reload', {
      method: 'POST',
      auth: 'cookie',
      cookie,
      headers: { origin: foreign },
    });
    assert.equal(refused.status, 403);
    const body = await refused.json() as { error: { code: string } };
    assert.equal(body.error.code, 'origin_not_allowed');

    // The gateway's own origin is fine.
    const allowed = await harness.call('/api/v1/roster/reload', {
      method: 'POST',
      auth: 'cookie',
      cookie,
      headers: { origin: harness.url },
    });
    assert.equal(allowed.status, 200);

    // Reads with no Origin at all still work — an address bar sends none.
    const read = await harness.call('/api/v1/health', { auth: 'cookie', cookie });
    assert.equal(read.status, 200);

    // A bearer token carries no ambient authority: nothing attaches it on a
    // page's behalf, so an origin cannot be used to forge one.
    const bearer = await harness.call('/api/v1/roster/reload', {
      method: 'POST',
      headers: { origin: foreign },
    });
    assert.equal(bearer.status, 200);
  } finally {
    await harness.stop();
  }
});

test('a cookie WS upgrade is origin-bound; a bearer upgrade connects', async () => {
  const harness = await startApi();
  try {
    const cookie = await signIn(harness);
    const wsUrl = `${harness.url.replace('http', 'ws')}/api/v1/events`;
    const port = new URL(harness.url).port;

    // WebSockets get no CORS protection at all — this check is the only
    // thing standing between a hostile local page and the whole event stream.
    const foreign = await openSocket(wsUrl, {
      headers: { cookie, origin: `http://127.0.0.1:${Number(port) + 1}` },
    });
    assert.equal(foreign.opened, false);
    assert.equal(foreign.status, 403);

    const sameOrigin = await openSocket(wsUrl, { headers: { cookie, origin: harness.url } });
    assert.equal(sameOrigin.opened, true);
    sameOrigin.socket.close();

    const bearer = await openSocket(wsUrl, { headers: { authorization: `Bearer ${harness.token}` } });
    assert.equal(bearer.opened, true);
    bearer.socket.close();
  } finally {
    await harness.stop();
  }
});

test('a wrong verb answers 405 and names what is allowed', async () => {
  const harness = await startApi();
  try {
    const response = await harness.call('/api/v1/health', { method: 'DELETE' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET');

    const missing = await harness.call('/api/v1/nope');
    assert.equal(missing.status, 404);
  } finally {
    await harness.stop();
  }
});

test('two daemons starting on one fresh home agree on the token', async () => {
  const home = await newHome();
  // Both observe no token file and both generate one. Without an exclusive
  // create, the loser goes on authenticating against a value no client can
  // read — its API reachable by nobody, with nothing saying so.
  const [first, second] = await Promise.all([
    ensureGatewayToken({ homeDir: home }),
    ensureGatewayToken({ homeDir: home }),
  ]);

  assert.equal(first, second);
  assert.equal((await readFile(path.join(home, '.stratus', 'gateway-token'), 'utf8')).trim(), first);
  assert.equal((await stat(path.join(home, '.stratus', 'gateway-token'))).mode & 0o777, 0o600);
});

test('an IPv6 bind is advertised and origin-checked with brackets', () => {
  // `http://::1:4123` is not a URL. The API parses every incoming path
  // against its own advertised origin, so an unbracketed one would fail every
  // request to a server that bound perfectly well.
  assert.equal(authority('::1', 4123), '[::1]:4123');
  assert.equal(authority('127.0.0.1', 4123), '127.0.0.1:4123');

  const origins = allowedOrigins('::1', 4123);
  assert.ok(origins.has('http://[::1]:4123'));
  assert.ok(!origins.has('http://::1:4123'));

  // A non-loopback IPv6 bind gets exactly its own bracketed origin.
  const remote = allowedOrigins('fd00::1', 8080);
  assert.deepEqual([...remote], ['http://[fd00::1]:8080']);
});
