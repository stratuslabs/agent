import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { ChatGPTAuthError, listenForCallback } from '../src/index.ts';

const portOf = (redirectUri: string): number => Number(new URL(redirectUri).port);

const get = async (url: string): Promise<{ status: number; body: string; csp: string | null }> => {
  const response = await fetch(url);
  return { status: response.status, body: await response.text(), csp: response.headers.get('content-security-policy') };
};

const refusesConnections = async (port: number): Promise<boolean> => {
  try {
    await fetch(`http://127.0.0.1:${port}/auth/callback`);
    return false;
  } catch {
    return true;
  }
};

test('the listener hands back the callback carrying the attempt state, answers the browser, then closes', async (t) => {
  const listener = await listenForCallback({ ports: [0] });
  t.after(() => listener.close());
  assert.match(listener.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
  const waiting = listener.waitFor('state-1');

  const browser = await get(`${listener.redirectUri}?code=c1&state=state-1&client_id=oaiapp_x`);
  assert.equal(browser.status, 200);
  assert.match(browser.body, /Go back to your terminal to finish/);
  assert.equal(browser.csp, "default-src 'none'");

  const params = await waiting;
  assert.equal(params.get('code'), 'c1');
  assert.equal(params.get('client_id'), 'oaiapp_x');
  // Closed by the listener itself, not by this test.
  assert.equal(await refusesConnections(portOf(listener.redirectUri)), true);
  await listener.close();
});

test('a request with another state or path does not end the sign-in', async (t) => {
  const listener = await listenForCallback({ ports: [0] });
  t.after(() => listener.close());
  const waiting = listener.waitFor('state-1');
  const origin = new URL(listener.redirectUri).origin;

  assert.equal((await get(`${listener.redirectUri}?code=c0&state=forged`)).status, 400);
  assert.equal((await get(`${listener.redirectUri}?error=access_denied`)).status, 400);
  assert.equal((await get(`${origin}/callback?code=c0&state=state-1`)).status, 404);

  const declined = await get(`${listener.redirectUri}?error=access_denied&state=state-1`);
  assert.equal(declined.status, 200);
  assert.match(declined.body, /didn't finish/);
  assert.equal((await waiting).get('error'), 'access_denied');
});

test('the preferred port being taken falls back to the next one', async (t) => {
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen({ port: 0, host: '127.0.0.1' }, resolve));
  const address = blocker.address();
  assert.ok(typeof address === 'object' && address !== null);
  try {
    const listener = await listenForCallback({ ports: [address.port, 0] });
    t.after(() => listener.close());
    assert.notEqual(portOf(listener.redirectUri), address.port);
    await listener.close();
    await assert.rejects(listenForCallback({ ports: [address.port] }), /No port was free/);
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});

test('no callback before the timeout ends the wait with a timeout error and closes the listener', async (t) => {
  const listener = await listenForCallback({ ports: [0] });
  t.after(() => listener.close());
  const error = await listener.waitFor('state-1', { timeoutMs: 20 }).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof ChatGPTAuthError);
  assert.equal(error.code, 'timeout');
  assert.equal(await refusesConnections(portOf(listener.redirectUri)), true);
});

test('aborting the wait cancels the sign-in and closes the listener', async (t) => {
  const listener = await listenForCallback({ ports: [0] });
  t.after(() => listener.close());
  const controller = new AbortController();
  const waiting = listener.waitFor('state-1', { signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting, (error: unknown) => error instanceof ChatGPTAuthError && error.code === 'cancelled');
  assert.equal(await refusesConnections(portOf(listener.redirectUri)), true);

  const already = await listenForCallback({ ports: [0] });
  t.after(() => already.close());
  await assert.rejects(already.waitFor('s', { signal: AbortSignal.abort() }), (error: unknown) => error instanceof ChatGPTAuthError && error.code === 'cancelled');
  await already.close();
});
