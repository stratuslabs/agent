import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { allowedOrigins, ensureGatewayToken } from '../src/auth.ts';
import { authority } from '../src/index.ts';
import { newHome, openSocket, rawGet, rawPost, startApi } from './harness.ts';

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
      ['GET', '/api/v1/agents/ava'],
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

test('a wildcard bind accepts the address it was opened for', async () => {
  // `--host 0.0.0.0` is the documented way to reach the dashboard from
  // another machine, and `0.0.0.0` is not an address any browser sends: the
  // page would load over the LAN or Tailscale address and then every write
  // and the whole event stream would 403, because the fixed origin set can
  // only name the wildcard literal and loopback.
  const harness = await startApi({ options: { host: '0.0.0.0' } });
  try {
    const cookie = await signIn(harness);
    const port = Number(new URL(harness.url).port);
    const lan = `192.0.2.10:${port}`;

    // A browser on the LAN address: `Host` is what it connected to, `Origin`
    // is the page it connected from, and they agree.
    const sameOrigin = await rawPost(port, '/api/v1/roster/reload', {
      cookie,
      host: lan,
      origin: `http://${lan}`,
    });
    assert.equal(sameOrigin.status, 200);

    // A page on another port of that same address is still refused: the
    // check that `SameSite` cannot make survives the wildcard.
    const otherPort = await rawPost(port, '/api/v1/roster/reload', {
      cookie,
      host: lan,
      origin: 'http://192.0.2.10:9999',
    });
    assert.equal(otherPort.status, 403);
    assert.equal(JSON.parse(otherPort.body).error.code, 'origin_not_allowed');

    // And the event stream, which has no CORS to fall back on.
    const wsUrl = `ws://127.0.0.1:${port}/api/v1/events`;
    const stream = await openSocket(wsUrl, { headers: { cookie, host: lan, origin: `http://${lan}` } });
    assert.equal(stream.opened, true);
    stream.socket.close();
  } finally {
    await harness.stop();
  }
});

test('an origin that does not match the request host is refused', async () => {
  // The Host fallback is a same-origin check, not a loosening: it accepts an
  // origin equal to the address the browser connected to, and nothing else.
  // These are the two cases it must keep refusing — the ones `SameSite`
  // cannot, because it ignores ports entirely.
  const harness = await startApi();
  try {
    const cookie = await signIn(harness);
    const port = Number(new URL(harness.url).port);

    // Same host, another port: a hostile page next door.
    const otherPort = await rawPost(port, '/api/v1/roster/reload', {
      cookie,
      host: `127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port + 1}`,
    });
    assert.equal(otherPort.status, 403);
    assert.equal(JSON.parse(otherPort.body).error.code, 'origin_not_allowed');

    // Another host entirely.
    const otherHost = await rawPost(port, '/api/v1/roster/reload', {
      cookie,
      host: `127.0.0.1:${port}`,
      origin: 'http://evil.example',
    });
    assert.equal(otherHost.status, 403);
  } finally {
    await harness.stop();
  }
});

test('a TLS-terminating tunnel is not locked out of its own dashboard', async () => {
  // Remote access is documented as a tunnel's job, and a tunnel terminates
  // TLS in front of a loopback daemon: the browser's origin is
  // `https://gateway.example` while this server speaks plain HTTP, so an
  // origin set that can only say `http://` loads the page and then refuses
  // every write and the whole event stream.
  const harness = await startApi();
  try {
    const cookie = await signIn(harness);
    const port = Number(new URL(harness.url).port);
    const publicHost = 'gateway.example';

    const write = await rawPost(port, '/api/v1/roster/reload', {
      cookie,
      host: publicHost,
      origin: `https://${publicHost}`,
    });
    assert.equal(write.status, 200);

    const stream = await openSocket(`ws://127.0.0.1:${port}/api/v1/events`, {
      headers: { cookie, host: publicHost, origin: `https://${publicHost}` },
    });
    assert.equal(stream.opened, true);
    stream.socket.close();

    // Still exactly the address it arrived on, and no more.
    const elsewhere = await rawPost(port, '/api/v1/roster/reload', {
      cookie,
      host: publicHost,
      origin: 'https://gateway.example.evil.test',
    });
    assert.equal(elsewhere.status, 403);
  } finally {
    await harness.stop();
  }
});

test('an empty token file is refused rather than raced over', async () => {
  const home = await newHome();
  const tokenPath = path.join(home, '.stratus', 'gateway-token');
  await mkdir(path.dirname(tokenPath), { recursive: true });
  await writeFile(tokenPath, '');

  // Repairing it cannot be made safe — two daemons both see the empty file,
  // both replace it, and the loser authenticates against a secret no client
  // can read. Refusing is one command to fix and locks nobody out.
  await assert.rejects(
    ensureGatewayToken({ homeDir: home }),
    (error: Error) => error.message.includes(tokenPath) && /empty/i.test(error.message),
  );
  // And it is left alone for the operator to look at.
  assert.equal(await readFile(tokenPath, 'utf8'), '');
});

test('a fresh claim publishes a complete file, never an empty one', async () => {
  const home = await newHome();
  const tokenPath = path.join(home, '.stratus', 'gateway-token');

  // Two daemons starting together on one home: exactly one claim wins, and
  // the loser adopts the winner's token rather than its own.
  const [first, second] = await Promise.all([
    ensureGatewayToken({ homeDir: home }),
    ensureGatewayToken({ homeDir: home }),
  ]);
  assert.ok(first.length > 0);
  assert.equal(first, second);
  assert.equal((await readFile(tokenPath, 'utf8')).trim(), first);
  assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);

  // The claim is published by linking an already-written file into place, so
  // there is no window in which the token exists but is empty — and no
  // staging file left behind either.
  const strays = (await readdir(path.dirname(tokenPath))).filter((entry) => entry.startsWith('gateway-token.'));
  assert.deepEqual(strays, [], `staging files were left behind: ${strays.join(', ')}`);
});

test('a session minted through TLS is Secure; a loopback one is not', async () => {
  const harness = await startApi();
  try {
    const port = Number(new URL(harness.url).port);
    const minted = await rawPost(port, '/api/v1/auth/ott', { authorization: `Bearer ${harness.token}` });
    const { path } = JSON.parse(minted.body) as { path: string };

    // The same exchange, arriving as a tunnel would forward it. Cookies are
    // scoped by host and not by scheme, so a flagless one minted on a public
    // hostname rides any later plain-HTTP request to it — the redirect to
    // HTTPS above all — in cleartext.
    const throughTls = await rawGet(port, path, {
      host: 'gateway.example',
      'x-forwarded-proto': 'https',
    });
    assert.equal(throughTls.status, 302);
    assert.match(throughTls.setCookie ?? '', /Secure/);
    assert.match(throughTls.setCookie ?? '', /HttpOnly/);

    const second = await rawPost(port, '/api/v1/auth/ott', { authorization: `Bearer ${harness.token}` });
    const direct = await rawGet(port, (JSON.parse(second.body) as { path: string }).path, {});
    assert.equal(direct.status, 302);
    // And not on loopback, where a Secure cookie would never come back and
    // the flag would break every request while reading as hardening.
    assert.doesNotMatch(direct.setCookie ?? '', /Secure/);
  } finally {
    await harness.stop();
  }
});
