import test from 'node:test';
import assert from 'node:assert/strict';

import { createHomeMemoryStore } from '@stratusagent/state';

import { newHome, startApi } from './harness.ts';

// An agent's memory over the control API: the list an operator reviews and
// the forget that clears one fact. Seeded through the same file store the
// daemon reads, before it starts.

const json = async <T>(response: Response): Promise<T> => response.json() as Promise<T>;

const forget = (call: (pathname: string, init?: RequestInit) => Promise<Response>, agentId: string, entryId: string): Promise<Response> =>
  call(`/api/v1/agents/${agentId}/memory/forget`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entryId }),
  });

interface Listed {
  agentId: string;
  entries: Array<{ id: string; content: string; trust: string; validity: string; pinned: boolean; kind?: string; about?: string[] }>;
}

test('GET /agents/:id/memory lists live facts with trust, validity and pins, and forget removes one', async () => {
  const home = await newHome();
  const seeded = createHomeMemoryStore({ homeDir: home });
  const kept = await seeded.append('stratus', 'Dylan prefers short replies.', { kind: 'preference', about: ['Dylan'] });
  const dropped = await seeded.append('stratus', 'The staging deploy is on Fridays.', { kind: 'semantic' });
  const expired = await seeded.append('stratus', 'The office was closed last week.', { validUntil: '2020-01-01T00:00:00.000Z' });
  await seeded.pin?.('stratus', kept.id);
  await seeded.append('someone-else', 'Not stratus\'s to show.');

  const harness = await startApi({ home });
  try {
    const listed = await json<Listed>(await harness.call('/api/v1/agents/stratus/memory'));
    assert.equal(listed.agentId, 'stratus');
    assert.deepEqual(listed.entries.map((entry) => entry.id), [kept.id, dropped.id, expired.id], 'oldest first, only this agent\'s');
    const byId = new Map(listed.entries.map((entry) => [entry.id, entry]));
    assert.equal(byId.get(kept.id)?.pinned, true);
    assert.equal(byId.get(kept.id)?.kind, 'preference');
    assert.deepEqual(byId.get(kept.id)?.about, ['Dylan']);
    assert.equal(byId.get(dropped.id)?.pinned, false);
    // Shown as expired rather than hidden: the operator decides about it.
    assert.equal(byId.get(expired.id)?.validity, 'expired');
    assert.equal(byId.get(kept.id)?.validity, 'current');
    assert.ok(['user', 'agent', 'unknown', 'external'].includes(byId.get(kept.id)?.trust ?? ''));

    const forgotten = await forget(harness.call, 'stratus', dropped.id);
    assert.equal(forgotten.status, 200);
    assert.deepEqual(await json(forgotten), { agentId: 'stratus', entryId: dropped.id, forgotten: true });

    const after = await json<Listed>(await harness.call('/api/v1/agents/stratus/memory'));
    assert.deepEqual(after.entries.map((entry) => entry.id), [kept.id, expired.id]);
    // A tombstone: the record still has it, as `stratus memory audit` shows.
    const audit = await createHomeMemoryStore({ homeDir: home }).audit('stratus');
    assert.ok(audit.find((entry) => entry.id === dropped.id)?.forgottenAt, 'the forgotten entry stays in the record');

    const again = await forget(harness.call, 'stratus', dropped.id);
    assert.equal(again.status, 404);
    assert.equal((await json<{ error: { code: string } }>(again)).error.code, 'memory_entry_not_found');
    // One agent's id cannot reach another's facts.
    const crossed = await forget(harness.call, 'someone-else', kept.id);
    assert.equal(crossed.status, 404);
  } finally {
    await harness.stop();
  }
});

test('an agent off the roster still lists, and an id that is not one is refused before any read', async () => {
  const home = await newHome();
  await createHomeMemoryStore({ homeDir: home }).append('retired', 'Left over from an agent whose soul is gone.');
  const harness = await startApi({ home });
  try {
    const listed = await json<Listed>(await harness.call('/api/v1/agents/retired/memory'));
    assert.equal(listed.entries.length, 1);
    assert.deepEqual((await json<Listed>(await harness.call('/api/v1/agents/nobody/memory'))).entries, []);

    const bad = await harness.call('/api/v1/agents/..%2Fescape/memory');
    assert.equal(bad.status, 400);
    assert.equal((await json<{ error: { code: string } }>(bad)).error.code, 'invalid_agent_id');
  } finally {
    await harness.stop();
  }
});

test('an entry id that is only dots is still forgotten, since it travels in the body', async () => {
  const home = await newHome();
  // A plugin store or an import may choose any id; the built-in store's
  // import keeps the one it is given.
  const seeded = createHomeMemoryStore({ homeDir: home });
  assert.ok(seeded.importEntries, 'the built-in store imports');
  await seeded.importEntries('stratus', [{ id: '..', agentId: 'stratus', content: 'An odd id.', createdAt: '2026-11-24T00:00:00.000Z' }]);
  const harness = await startApi({ home });
  try {
    const listed = await json<Listed>(await harness.call('/api/v1/agents/stratus/memory'));
    assert.ok(listed.entries.some((entry) => entry.id === '..'));
    const forgotten = await forget(harness.call, 'stratus', '..');
    assert.equal(forgotten.status, 200);
    assert.deepEqual((await json<Listed>(await harness.call('/api/v1/agents/stratus/memory'))).entries, []);
    const missing = await harness.call('/api/v1/agents/stratus/memory/forget', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(missing.status, 400);
  } finally {
    await harness.stop();
  }
});
