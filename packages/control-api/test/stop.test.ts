import test from 'node:test';
import assert from 'node:assert/strict';

import { startApi, settles, type Harness } from './harness.ts';

// Stopping a turn from outside a channel: `POST /sessions/:id/stop`. The turn
// is held open by a provider request that only ends when its signal aborts,
// so the stop is the only thing that can end it.

const json = async <T>(response: Response): Promise<T> => response.json() as Promise<T>;

/** A model call that never answers: it ends only when the turn's signal aborts. */
const hangingFetch = (onCall: () => void): typeof fetch =>
  (async (_input: unknown, init?: RequestInit) => {
    onCall();
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }) as typeof fetch;

const startHanging = async (): Promise<{ harness: Harness; called: Promise<void> }> => {
  let reached: () => void = () => {};
  const called = new Promise<void>((resolve) => { reached = resolve; });
  const harness = await startApi({
    env: {
      processEnv: { STRATUS_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test' },
      fetch: hangingFetch(() => reached()),
    },
  });
  return { harness, called };
};

const signIn = async (harness: Harness): Promise<string> => {
  const minted = await harness.call('/api/v1/auth/ott', { method: 'POST' });
  const { url } = await minted.json() as { url: string };
  const exchanged = await fetch(url, { redirect: 'manual' });
  return (exchanged.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
};

const ended = (harness: Harness, sessionId: string): Promise<{ type: string; error?: string }> =>
  new Promise((resolve) => {
    const off = harness.gateway.bus.subscribe((event) => {
      if (event.sessionId === sessionId && (event.type === 'session.completed' || event.type === 'session.failed')) {
        off();
        resolve(event as { type: string; error?: string });
      }
    });
  });

test('POST /sessions/:id/stop ends a running turn, says who stopped it, and is harmless once nothing runs', async () => {
  const { harness, called } = await startHanging();
  try {
    const sessionId = 'web:stratus:stop-me';
    const end = ended(harness, sessionId);
    const accepted = await harness.call(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'write me a very long essay', agentId: 'stratus' }),
    });
    assert.equal(accepted.status, 202);
    // The model call is in flight, so the turn is running and nothing but a
    // stop can end it.
    await settles(called, 'the model call');

    const cookie = await signIn(harness);
    const stop = await harness.call(`/api/v1/sessions/${encodeURIComponent(sessionId)}/stop`, {
      method: 'POST',
      auth: 'cookie',
      cookie,
      headers: { origin: harness.url },
    });
    assert.equal(stop.status, 200);
    assert.deepEqual(await json(stop), { sessionId, stopped: 1, tasks: 0 });

    const event = await settles(end, 'the stopped turn');
    assert.equal(event.type, 'session.failed');
    assert.match(event.error ?? '', /Stopped from the dashboard\./);
    const stored = await harness.gateway.store.get(sessionId);
    assert.equal(stored?.status, 'failed');

    // Nothing runs now. Not an error: a second click is the same request.
    const again = await harness.call(`/api/v1/sessions/${encodeURIComponent(sessionId)}/stop`, { method: 'POST' });
    assert.equal(again.status, 200);
    assert.deepEqual(await json(again), { sessionId, stopped: 0, tasks: 0 });
  } finally {
    await harness.stop();
  }
});

test('a stop through a bearer token names the control API, and an unknown session is a 404', async () => {
  const { harness, called } = await startHanging();
  try {
    const sessionId = 'web:stratus:bearer-stop';
    const end = ended(harness, sessionId);
    await harness.call(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello', agentId: 'stratus' }),
    });
    await settles(called, 'the model call');

    const stop = await harness.call(`/api/v1/sessions/${encodeURIComponent(sessionId)}/stop`, { method: 'POST' });
    assert.equal(stop.status, 200);
    assert.equal((await json<{ stopped: number }>(stop)).stopped, 1);
    const event = await settles(end, 'the stopped turn');
    assert.match(event.error ?? '', /Stopped through the control API\./);

    const unknown = await harness.call('/api/v1/sessions/web%3Astratus%3Anobody/stop', { method: 'POST' });
    assert.equal(unknown.status, 404);
    assert.equal((await json<{ error: { code: string } }>(unknown)).error.code, 'session_not_found');
  } finally {
    await harness.stop();
  }
});
