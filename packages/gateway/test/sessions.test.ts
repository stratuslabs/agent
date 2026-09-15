import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Session } from '@stratusagent/core';
import { agentSessionDbIn, fleetDbIn } from '@stratusagent/state';

import {
  FleetSessionIndex,
  SessionIdTakenError,
  ShardedSessionStore,
  SqliteSessionStore,
} from '../src/sessions.ts';

const newStateDir = (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'stratus-sessions-'));

const session = (id: string, agentId: string, status: Session['status'] = 'completed'): Omit<Session, 'createdAt' | 'updatedAt'> => ({
  id,
  agent: { id: agentId, name: agentId },
  status,
  messages: [],
});

test('each agent writes to its own database, and nothing else is in it', async () => {
  const stateDir = await newStateDir();
  const store = new ShardedSessionStore({ stateDir });
  await store.create(session('a-1', 'ava'));
  await store.create(session('b-1', 'bea'));
  store.close();

  // The isolation claim is structural, so it is checked structurally: open
  // one agent's file directly and there is no row of the other's to filter.
  const ava = new SqliteSessionStore(agentSessionDbIn(stateDir, 'ava'));
  assert.deepEqual(ava.rows().map((row) => row.id), ['a-1']);
  assert.equal(await ava.get('b-1'), undefined);
  ava.close();
});

test('a session id another agent already holds is refused at the create seam', async () => {
  const stateDir = await newStateDir();
  const store = new ShardedSessionStore({ stateDir });
  await store.create(session('shared-id', 'ava'));

  await assert.rejects(
    () => store.create(session('shared-id', 'bea')),
    (error: unknown) => error instanceof SessionIdTakenError && /never cross agent identities/.test(error.message),
  );
  // And nothing of bea's was written on the way to the refusal: the claim
  // is what the create is gated on, not a cleanup after it.
  assert.equal((await store.get('shared-id'))?.agent.id, 'ava');
  store.close();

  const bea = new SqliteSessionStore(agentSessionDbIn(stateDir, 'bea'));
  assert.deepEqual(bea.rows(), []);
  bea.close();
});

test('re-creating an id the same agent holds is the caller re-opening its own session', async () => {
  const stateDir = await newStateDir();
  const store = new ShardedSessionStore({ stateDir });
  await store.create(session('a-1', 'ava'));
  await store.create(session('a-1', 'ava', 'running'));
  assert.equal((await store.get('a-1'))?.status, 'running');
  store.close();
});

test('a lookup with no agent in hand resolves through the index to the right store', async () => {
  const stateDir = await newStateDir();
  const store = new ShardedSessionStore({ stateDir });
  await store.create(session('a-1', 'ava'));
  await store.create(session('b-1', 'bea'));

  // What GET /sessions/:id has: an id and nothing else.
  assert.equal((await store.get('a-1'))?.agent.id, 'ava');
  assert.equal((await store.get('b-1'))?.agent.id, 'bea');
  assert.equal(await store.get('nobody-1'), undefined);
  store.close();
});

test('the fleet-wide reads answer across every sharded store', async () => {
  const stateDir = await newStateDir();
  const store = new ShardedSessionStore({ stateDir });
  await store.create(session('a-1', 'ava'));
  await store.create(session('a-2', 'ava', 'pending_approval'));
  await store.create(session('b-1', 'bea', 'running'));

  // A single-store walk would miss bea's running turn and ava's parked one
  // depending on which file it happened to open — which is an agent whose
  // parked approval never resumes.
  assert.deepEqual(store.countByStatus(), { completed: 1, pending_approval: 1, running: 1 });
  assert.deepEqual(await store.listIdsByStatus('pending_approval'), ['a-2']);
  assert.deepEqual(await store.listIdsByStatus('running'), ['b-1']);
  assert.deepEqual(store.list().map((row) => row.id).sort(), ['a-1', 'a-2', 'b-1']);
  assert.deepEqual(store.list('ava').map((row) => row.id).sort(), ['a-1', 'a-2']);
  assert.equal(store.list(undefined, 2).length, 2);

  const activity = store.lastActivityByAgent();
  assert.equal(activity.ava?.activeSessions, 1);
  assert.equal(activity.bea?.activeSessions, 1);
  assert.ok(activity.ava?.lastActiveAt && Date.parse(activity.ava.lastActiveAt) > 0);
  store.close();
});

test('a crash after the index claim and before the store write leaves a released id', async () => {
  const stateDir = await newStateDir();
  // Exactly what a kill between the two durable writes leaves: the claim
  // landed, the conversation did not.
  const index = new FleetSessionIndex(fleetDbIn(stateDir));
  index.claim({ id: 'half-1', agentId: 'ava', status: 'running', createdAt: 'x', updatedAt: 'x' });
  index.close();

  const store = new ShardedSessionStore({ stateDir });
  const report = await store.reconcile();
  assert.deepEqual(report.released, ['half-1']);
  // Released means the id is free again, not that a stranded claim answers
  // for a conversation nobody can reach.
  assert.equal(await store.get('half-1'), undefined);
  await store.create(session('half-1', 'bea'));
  assert.equal((await store.get('half-1'))?.agent.id, 'bea');
  store.close();
});

test('a conversation the index lost is re-indexed from the store, which is the record', async () => {
  const stateDir = await newStateDir();
  // The other side of the same kill: the shard write landed and the index
  // row did not — or an operator restored a store file by hand.
  const shard = new SqliteSessionStore(agentSessionDbIn(stateDir, 'ava'));
  await shard.create(session('orphan-1', 'ava', 'pending_approval'));
  shard.close();

  const store = new ShardedSessionStore({ stateDir });
  const report = await store.reconcile();
  assert.deepEqual(report.reindexed, ['orphan-1']);
  assert.equal((await store.get('orphan-1'))?.agent.id, 'ava');
  // And the recovery sweep can see it, which is the point: an unreachable
  // parked turn is one nobody ever resumes or fails.
  assert.deepEqual(await store.listIdsByStatus('pending_approval'), ['orphan-1']);
  store.close();
});

test('the same session id in two agents stores fails loudly, naming both', async () => {
  const stateDir = await newStateDir();
  for (const agentId of ['ava', 'bea']) {
    const shard = new SqliteSessionStore(agentSessionDbIn(stateDir, agentId));
    await shard.create(session('duplicate-1', agentId));
    shard.close();
  }

  const store = new ShardedSessionStore({ stateDir });
  await assert.rejects(
    () => store.reconcile(),
    (error: unknown) => error instanceof Error
      && /duplicate-1/.test(error.message)
      && /ava/.test(error.message)
      && /bea/.test(error.message),
  );
  store.close();
});

test('a directory that is not an agents is not walked as one', async () => {
  const stateDir = await newStateDir();
  const store = new ShardedSessionStore({ stateDir });
  await store.create(session('a-1', 'ava'));
  store.close();

  // A stray file beside the per-agent directories — an editor's backup, a
  // half-written soul — is not a store, and the reconcile must not treat
  // whatever it finds as an agent id to join.
  await writeFile(path.join(stateDir, 'agents', 'notes.txt'), 'not an agent');
  const reopened = new ShardedSessionStore({ stateDir });
  const report = await reopened.reconcile();
  assert.deepEqual(report, { released: [], reindexed: [] });
  reopened.close();
});

test('a reconcile with nothing to fix changes nothing, so a restart is not a rewrite', async () => {
  const stateDir = await newStateDir();
  const store = new ShardedSessionStore({ stateDir });
  await store.create(session('a-1', 'ava'));
  await store.create(session('b-1', 'bea', 'pending_approval'));
  assert.deepEqual(await store.reconcile(), { released: [], reindexed: [] });
  store.close();

  const reopened = new ShardedSessionStore({ stateDir });
  assert.deepEqual(await reopened.reconcile(), { released: [], reindexed: [] });
  reopened.close();
});

test('an agent id that cannot key a path never reaches a join', async () => {
  const stateDir = await newStateDir();
  const store = new ShardedSessionStore({ stateDir });
  await assert.rejects(
    () => store.create(session('escape-1', '../../elsewhere')),
    /single path segment/,
  );
  store.close();
  await rm(stateDir, { recursive: true, force: true });
});
