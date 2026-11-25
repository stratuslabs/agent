import test from 'node:test';
import assert from 'node:assert/strict';

import { startApi, settles } from './harness.ts';

// Titles and title search on `GET /sessions`, through real turns.

const json = async <T>(response: Response): Promise<T> => response.json() as Promise<T>;

test('GET /sessions rows carry the first message as a title, and ?q= searches them', async () => {
  const harness = await startApi();
  try {
    const say = async (sessionId: string, message: string): Promise<void> => {
      const done = new Promise<void>((resolve) => {
        const off = harness.gateway.bus.subscribe((event) => {
          if (event.sessionId === sessionId && (event.type === 'session.completed' || event.type === 'session.failed')) {
            off();
            resolve();
          }
        });
      });
      const accepted = await harness.call(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, agentId: 'stratus' }),
      });
      assert.equal(accepted.status, 202);
      await settles(done, `the turn on ${sessionId}`);
    };
    await say('web:stratus:a', 'Plan the offsite agenda\nwith a few options');
    await say('web:stratus:b', 'Why did the deploy fail?');

    const listed = await json<{ sessions: Array<{ id: string; title?: string }> }>(await harness.call('/api/v1/sessions?agent=stratus'));
    assert.deepEqual(
      listed.sessions.map((row) => [row.id, row.title]).sort(),
      [['web:stratus:a', 'Plan the offsite agenda'], ['web:stratus:b', 'Why did the deploy fail?']],
    );
    const found = await json<{ sessions: Array<{ id: string }> }>(await harness.call('/api/v1/sessions?agent=stratus&q=DEPLOY'));
    assert.deepEqual(found.sessions.map((row) => row.id), ['web:stratus:b']);
    const everywhere = await json<{ sessions: Array<{ id: string }> }>(await harness.call('/api/v1/sessions?q=offsite'));
    assert.deepEqual(everywhere.sessions.map((row) => row.id), ['web:stratus:a']);

    const tooLong = await harness.call(`/api/v1/sessions?q=${'x'.repeat(201)}`);
    assert.equal(tooLong.status, 400);
    assert.equal((await json<{ error: { code: string } }>(tooLong)).error.code, 'invalid_query');
  } finally {
    await harness.stop();
  }
});
