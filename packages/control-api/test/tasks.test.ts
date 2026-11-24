import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { fleetDbPath } from '@stratusagent/state';

import { startApi, type Harness } from './harness.ts';

// AGT-357 PR 4: background tasks over the control API. The rows are written
// straight into the daemon's fleet.db after it started, so the restart sweep
// has already run and leaves them alone; what a cancel does to a running
// worker is the gateway's own suite's (test/background-tasks.test.ts).

const json = async <T>(response: Response): Promise<T> => response.json() as Promise<T>;

const signIn = async (harness: Harness): Promise<string> => {
  const minted = await harness.call('/api/v1/auth/ott', { method: 'POST' });
  assert.equal(minted.status, 200);
  const { url } = await minted.json() as { url: string };
  const exchanged = await fetch(url, { redirect: 'manual' });
  assert.equal(exchanged.status, 302);
  const setCookie = exchanged.headers.get('set-cookie');
  assert.ok(setCookie, 'the exchange sets a session cookie');
  return setCookie.split(';')[0] ?? '';
};

interface Seed {
  id: string;
  agentId: string;
  status: string;
  delivery: string;
  createdAt: string;
  endedAt?: string;
}

/** Rows as the gateway's task store writes them, from a second connection the way another process would. */
const seed = (harness: Harness, rows: Seed[]): void => {
  const db = new DatabaseSync(fleetDbPath({ homeDir: harness.home }));
  try {
    for (const row of rows) {
      db.prepare(`
        INSERT INTO tasks (id, agent_id, worker_agent_id, origin_session_id, worker_session_id, prompt_digest, status, delivery, created_at, updated_at, ended_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.id,
        row.agentId,
        row.agentId,
        `api-${row.id}`,
        `api-${row.id}:delegate:${row.agentId}:1:${row.id}`,
        'digest-of-SECRET-PROMPT',
        row.status,
        row.delivery,
        row.createdAt,
        row.endedAt ?? row.createdAt,
        row.endedAt ?? '',
      );
    }
  } finally {
    db.close();
  }
};

const stoppedBy = (harness: Harness, id: string): string => {
  const db = new DatabaseSync(fleetDbPath({ homeDir: harness.home }));
  try {
    return (db.prepare('SELECT stopped_by FROM tasks WHERE id = ?').get(id) as { stopped_by: string }).stopped_by;
  } finally {
    db.close();
  }
};

test('GET /api/v1/tasks lists every agent\'s tasks, ids and status only, and ?agent= narrows it to one', async () => {
  const harness = await startApi();
  try {
    assert.deepEqual(await json(await harness.call('/api/v1/tasks')), { tasks: [] });
    seed(harness, [
      { id: 't_DONE', agentId: 'blair', status: 'completed', delivery: 'delivered', createdAt: '2026-11-13T10:00:00.000Z', endedAt: '2026-11-13T10:05:00.000Z' },
      { id: 't_RUN', agentId: 'stratus', status: 'running', delivery: 'pending', createdAt: '2026-11-13T11:00:00.000Z' },
    ]);

    const listed = await json<{ tasks: Array<Record<string, unknown>> }>(await harness.call('/api/v1/tasks'));
    assert.deepEqual(listed.tasks.map((task) => [task.id, task.agentId, task.status, task.delivery]), [
      ['t_RUN', 'stratus', 'running', 'pending'],
      ['t_DONE', 'blair', 'completed', 'delivered'],
    ]);
    assert.deepEqual(Object.keys(listed.tasks[1]!).sort(), [
      'agentId', 'createdAt', 'delivery', 'endedAt', 'id', 'originSessionId', 'status', 'steps', 'updatedAt', 'workerAgentId', 'workerSessionId',
    ]);
    assert.equal(JSON.stringify(listed).includes('SECRET-PROMPT'), false, 'not even the prompt digest leaves the daemon');

    const blair = await json<{ tasks: Array<Record<string, unknown>> }>(await harness.call('/api/v1/tasks?agent=blair'));
    assert.deepEqual(blair.tasks.map((task) => task.id), ['t_DONE']);
  } finally {
    await harness.stop();
  }
});

test('POST /api/v1/tasks/:id/cancel stops a task as the CLI with a token and as the dashboard with a cookie', async () => {
  const harness = await startApi();
  try {
    seed(harness, [
      { id: 't_ONE', agentId: 'stratus', status: 'running', delivery: 'pending', createdAt: '2026-11-13T11:00:00.000Z' },
      { id: 't_TWO', agentId: 'stratus', status: 'waiting_approval', delivery: 'pending', createdAt: '2026-11-13T11:01:00.000Z' },
      { id: 't_DONE', agentId: 'stratus', status: 'failed', delivery: 'delivered', createdAt: '2026-11-13T10:00:00.000Z', endedAt: '2026-11-13T10:01:00.000Z' },
    ]);

    const bearer = await harness.call('/api/v1/tasks/t_ONE/cancel', { method: 'POST' });
    assert.equal(bearer.status, 200);
    assert.deepEqual(await bearer.json(), { task: 't_ONE', stopped: true });
    assert.equal(stoppedBy(harness, 't_ONE'), 'cli');

    // A second cancel keeps the first stopper, and says so.
    const again = await harness.call('/api/v1/tasks/t_ONE/cancel', { method: 'POST' });
    assert.deepEqual(await again.json(), { task: 't_ONE', stopped: true, already: true, stoppedBy: 'cli' });

    const cookie = await signIn(harness);
    // A cookie is ambient, so a cancel from another origin is refused before it reaches the task.
    const foreign = await harness.call('/api/v1/tasks/t_TWO/cancel', {
      method: 'POST', auth: 'cookie', cookie, headers: { origin: 'http://evil.example' },
    });
    assert.equal(foreign.status, 403);
    assert.equal(stoppedBy(harness, 't_TWO'), '');
    const dashboard = await harness.call('/api/v1/tasks/t_TWO/cancel', {
      method: 'POST', auth: 'cookie', cookie, headers: { origin: harness.url },
    });
    assert.equal(dashboard.status, 200);
    assert.deepEqual(await dashboard.json(), { task: 't_TWO', stopped: true });
    assert.equal(stoppedBy(harness, 't_TWO'), 'dashboard');

    const finished = await harness.call('/api/v1/tasks/t_DONE/cancel', { method: 'POST' });
    assert.equal(finished.status, 200);
    assert.deepEqual(await finished.json(), { task: 't_DONE', stopped: false, status: 'failed' });
    assert.equal(stoppedBy(harness, 't_DONE'), '', 'nothing is written for a finished task');

    const missing = await harness.call('/api/v1/tasks/t_NOPE/cancel', { method: 'POST' });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json() as { error: { code: string } }).error.code, 'task_not_found');

    const listed = await json<{ tasks: Array<Record<string, unknown>> }>(await harness.call('/api/v1/tasks'));
    assert.deepEqual(listed.tasks.map((task) => [task.id, task.stoppedBy]), [['t_TWO', 'dashboard'], ['t_ONE', 'cli'], ['t_DONE', undefined]]);
  } finally {
    await harness.stop();
  }
});
