import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PAUSED_MESSAGE } from '@stratusagent/gateway';
import { startApi } from './harness.ts';

const json = async <T>(response: Response): Promise<T> => response.json() as Promise<T>;

const put = (body: unknown): RequestInit => ({
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('PUT /intake pauses and resumes, and health says which', async () => {
  const harness = await startApi();
  try {
    assert.deepEqual(await json(await harness.call('/api/v1/intake')), { paused: false });

    const paused = await harness.call('/api/v1/intake', put({ paused: true, message: 'Paused: the usage limit is reached.' }));
    assert.equal(paused.status, 200);
    const state = await json<{ paused: boolean; message?: string; since?: string }>(paused);
    assert.equal(state.paused, true);
    assert.equal(state.message, 'Paused: the usage limit is reached.');

    const health = await json<{ ok: boolean; intake: { paused: boolean } }>(await harness.call('/api/v1/health'));
    // Still ok: a paused daemon is healthy, it is just not taking work.
    assert.equal(health.ok, true);
    assert.equal(health.intake.paused, true);

    // A new message is refused at the door, with the pause's own sentence,
    // rather than handed a turn id for a turn that can never run.
    const refused = await harness.call('/api/v1/sessions/api-1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello', agentId: 'stratus' }),
    });
    assert.equal(refused.status, 503);
    assert.deepEqual(await json(refused), {
      error: { code: 'intake_paused', message: 'Paused: the usage limit is reached.' },
    });

    const resumed = await harness.call('/api/v1/intake', put({ paused: false }));
    assert.deepEqual(await json(resumed), { paused: false });
    const completed = new Promise<void>((resolve) => {
      const off = harness.gateway.bus.subscribe((event) => {
        if (event.sessionId === 'api-1' && (event.type === 'session.completed' || event.type === 'session.failed')) {
          off();
          resolve();
        }
      });
    });
    const accepted = await harness.call('/api/v1/sessions/api-1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello', agentId: 'stratus' }),
    });
    assert.equal(accepted.status, 202);
    await completed;
  } finally {
    await harness.stop();
  }
});

test('PUT /intake refuses a malformed body and leaves intake as it was', async () => {
  const harness = await startApi();
  try {
    for (const body of [{}, { paused: 'yes' }, { paused: false, message: 'x' }, { paused: true, message: 'x'.repeat(501) }]) {
      const response = await harness.call('/api/v1/intake', put(body));
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal((await json<{ error: { code: string } }>(response)).error.code, 'invalid_body');
    }
    assert.deepEqual(await json(await harness.call('/api/v1/intake')), { paused: false });

    // No message: the default sentence answers.
    await harness.call('/api/v1/intake', put({ paused: true }));
    const refused = await harness.call('/api/v1/sessions/api-2/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    assert.equal((await json<{ error: { message: string } }>(refused)).error.message, DEFAULT_PAUSED_MESSAGE);
    await harness.call('/api/v1/intake', put({ paused: false }));
  } finally {
    await harness.stop();
  }
});

test('/intake needs the token like every other route', async () => {
  const harness = await startApi();
  try {
    const response = await fetch(`${harness.url}/api/v1/intake`, put({ paused: true }));
    assert.equal(response.status, 401);
    assert.deepEqual(await json(await harness.call('/api/v1/intake')), { paused: false });
  } finally {
    await harness.stop();
  }
});
