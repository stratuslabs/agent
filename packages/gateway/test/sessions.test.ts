import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
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

test('a gateway started on a home whose pre-15a state has not moved refuses rather than serving it', async () => {
  const { createGateway } = await import('../src/index.ts');
  const { legacySessionDbPath } = await import('@stratusagent/state');
  const { DatabaseSync } = await import('node:sqlite');
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-unmigrated-'));
  const env = { homeDir: home, cwd: home, processEnv: {} };
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  // A shared session database with a conversation in it, as a build before
  // the per-agent layout left it. Serving over it is the quiet failure: the
  // stores open on the new paths, find nothing, and the fleet starts a
  // second population beside every session and schedule it already had.
  // Rows, not just the filename — an empty database at that path is a husk
  // some other process created and has nothing to strand.
  const seeded = new DatabaseSync(legacySessionDbPath(env));
  seeded.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, status TEXT NOT NULL,
      body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )
  `);
  seeded
    .prepare('INSERT INTO sessions (id, agent_id, status, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('old-1', 'ava', 'completed', '{}', 'x', 'x');
  seeded.close();

  const gateway = createGateway({ env, idleTimeoutMs: 0 });
  await assert.rejects(() => gateway.start(), /pre-per-agent state/);
  await gateway.stop();
  await rm(home, { recursive: true, force: true });
});

test('the refusal asks about the state directory the stores were opened on', async () => {
  const { createGateway } = await import('../src/index.ts');
  const { legacySessionDbIn } = await import('@stratusagent/state');
  const { DatabaseSync } = await import('node:sqlite');
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-elsewhere-'));
  const env = { homeDir: home, cwd: home, processEnv: {} };
  // A host that pointed the stores somewhere other than ~/.stratus. The
  // sessions it would strand are in the directory it chose, so asking about
  // the home instead answers "fine" and strands them silently.
  const stateDir = path.join(home, 'elsewhere');
  await mkdir(stateDir, { recursive: true });
  const seeded = new DatabaseSync(legacySessionDbIn(stateDir));
  seeded.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, status TEXT NOT NULL,
      body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )
  `);
  seeded
    .prepare('INSERT INTO sessions (id, agent_id, status, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('old-1', 'ava', 'completed', '{}', 'x', 'x');
  seeded.close();

  const gateway = createGateway({ env, idleTimeoutMs: 0, stateDir });
  await assert.rejects(() => gateway.start(), (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    // Names the directory it actually found the state in, and says that
    // `stratus update` is not the remedy for a directory it does not know.
    return message.includes(stateDir) && /state directory of your own choosing/.test(message);
  });
  await gateway.stop();
  await rm(home, { recursive: true, force: true });
});

test('a save that moves a session to another agent is refused, not written twice', async () => {
  const stateDir = await newStateDir();
  const store = new ShardedSessionStore({ stateDir });
  const opened = await store.create(session('s-1', 'ava'));

  // What an embedder handing back a session with a changed `agent.id` would
  // otherwise do: a second copy in bea's shard, the index quietly repointed
  // at it, ava's transcript still on disk in a store nothing resolves to —
  // and the next start refusing to serve at all, because the reconcile
  // finds one id in two shards.
  await assert.rejects(
    () => store.save({ ...opened, agent: { id: 'bea', name: 'bea' } }),
    (error: unknown) => error instanceof SessionIdTakenError && /never cross agent identities/.test(error.message),
  );

  assert.equal((await store.get('s-1'))?.agent.id, 'ava');
  // And the reconcile still passes, which is the property the refusal
  // keeps: one id in two shards is what makes it fail loudly and the next
  // start refuse the home entirely.
  assert.deepEqual(await store.reconcile(), { released: [], reindexed: [] });
  store.close();

  const bea = new SqliteSessionStore(agentSessionDbIn(stateDir, 'bea'));
  assert.deepEqual(bea.rows(), []);
  bea.close();
});

test('a save claims the id before it writes, so a concurrent save cannot take it too', async () => {
  const stateDir = await newStateDir();
  const store = new ShardedSessionStore({ stateDir });
  const at = '2026-01-01T00:00:00.000Z';
  const unindexed = (agentId: string): Session => ({
    ...session('s-1', agentId),
    agent: { id: agentId, name: agentId },
    createdAt: at,
    updatedAt: at,
  });

  // An id no `create` ever claimed — the case an embedder reaches by saving
  // a session it built itself. Deliberately not awaited: `save` claims
  // synchronously and then awaits the shard write, so this is exactly the
  // window where a second caller runs. Reading the index and *then* writing
  // the file leaves that whole write between the question and the answer,
  // and both callers write a shard — which the next start refuses to serve
  // over, because the reconcile finds one id under two agents.
  const first = store.save(unindexed('ava'));
  await assert.rejects(
    () => store.save(unindexed('bea')),
    (error: unknown) => error instanceof SessionIdTakenError && /never cross agent identities/.test(error.message),
  );
  await first;

  assert.equal((await store.get('s-1'))?.agent.id, 'ava');
  assert.deepEqual(await store.reconcile(), { released: [], reindexed: [] });
  store.close();

  const bea = new SqliteSessionStore(agentSessionDbIn(stateDir, 'bea'));
  assert.deepEqual(bea.rows(), []);
  bea.close();
});

test('a directory under agents/ that holds no shard is not an agent to reconcile', async () => {
  const stateDir = await newStateDir();
  const store = new ShardedSessionStore({ stateDir });
  await store.create(session('a-1', 'ava'));

  // Something an operator keeps under `agents/` — the old layout reserved
  // no such names, so nothing told them not to. Opening a store here would
  // create `sessions.db` inside it and chmod the directory to 0700 on every
  // start.
  const theirs = path.join(stateDir, 'agents', 'backups');
  await mkdir(theirs, { recursive: true, mode: 0o755 });
  await writeFile(path.join(theirs, 'notes.txt'), 'mine\n');

  assert.deepEqual(await store.reconcile(), { released: [], reindexed: [] });
  store.close();

  await assert.rejects(() => stat(path.join(theirs, 'sessions.db')));
  assert.equal((await stat(theirs)).mode & 0o777, 0o755);
});

test('an agent directory that is a symlink is refused at the live shard, not written through', async () => {
  const stateDir = await newStateDir();
  const elsewhere = path.join(stateDir, 'elsewhere');
  await mkdir(elsewhere, { recursive: true });
  await mkdir(path.join(stateDir, 'agents'), { recursive: true });
  await symlink(elsewhere, path.join(stateDir, 'agents', 'ava'));

  // The migration quarantines this, but a session created after it is a
  // different way in: written through the link and indexed as though it
  // were here, then released at the next start — the sweep reads entry
  // types and sees no directory — and the conversation is unreachable.
  const store = new ShardedSessionStore({ stateDir });
  await assert.rejects(
    () => store.create(session('a-1', 'ava')),
    (error: unknown) => error instanceof Error && /symlink/.test(error.message),
  );
  store.close();

  assert.deepEqual(await readdir(elsewhere), []);
});

test('a sessions.db that is a symlink is neither swept nor opened', async () => {
  const stateDir = await newStateDir();
  const elsewhere = path.join(stateDir, 'elsewhere.db');
  const theirs = path.join(stateDir, 'agents', 'archive');
  await mkdir(theirs, { recursive: true });
  await writeFile(elsewhere, '');
  await symlink(elsewhere, path.join(theirs, 'sessions.db'));

  const store = new ShardedSessionStore({ stateDir });
  await store.create(session('a-1', 'ava'));

  // The sweep must not read this as an agent's shard: following the link
  // creates the table, indexes the rows and tightens the mode in whatever
  // it points at, none of which is ours.
  assert.deepEqual(await store.reconcile(), { released: [], reindexed: [] });
  // And a live open through the link is refused rather than followed.
  await assert.rejects(
    () => store.create(session('b-1', 'archive')),
    (error: unknown) => error instanceof Error && /symlink/.test(error.message),
  );
  store.close();

  assert.equal((await stat(elsewhere)).size, 0);
});

test('a symlinked state home is still usable: the fleet index is not an agent directory', async () => {
  const real = await newStateDir();
  const linked = path.join(await newStateDir(), 'home');
  await symlink(real, linked);

  // A home on another disk, reached through a link — a supported setup, and
  // the one the per-agent symlink refusal must not reach. `~/.stratus` is
  // the operator's path to choose; `agents/<id>` is one Stratus picks.
  const store = new ShardedSessionStore({ stateDir: linked, ownedDirectory: true });
  const opened = await store.create(session('a-1', 'ava'));
  assert.equal(opened.agent.id, 'ava');
  assert.equal((await store.get('a-1'))?.agent.id, 'ava');
  store.close();
});
