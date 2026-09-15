import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createFileCommandWhitelist, whitelistPathFor } from '@stratusagent/permissions';

import {
  STATE_SCHEMA_VERSION,
  agentMemoryFilePath,
  agentSessionDbPath,
  agentsDirPath,
  createHomeMemoryStore,
  drainSharedMemory,
  fleetDbPath,
  legacyMemoryFilePath,
  legacySessionDbPath,
  pendingStateMigrations,
  readStateStamp,
  runStateMigrations,
  stratusHomePath,
} from '../src/index.ts';

const newHome = async (): Promise<string> => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-layout-'));
  await mkdir(agentsDirPath({ homeDir: home }), { recursive: true });
  return home;
};

/**
 * A `~/.stratus` as an older build left it: one shared session database
 * holding every agent's conversations and the fleet's schedules, one shared
 * memory file, and a grant file per agent beside the souls.
 */
const seedSharedState = async (home: string): Promise<void> => {
  const env = { homeDir: home };
  const db = new DatabaseSync(legacySessionDbPath(env));
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      next_fire_at TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  const insert = db.prepare('INSERT OR REPLACE INTO sessions (id, agent_id, status, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  const at = '2026-01-01T00:00:00.000Z';
  for (const [id, agentId, status] of [
    ['a-1', 'ava', 'completed'],
    ['a-2', 'ava', 'pending_approval'],
    // A soul nobody restored yet: the gateway keeps its sessions when it
    // drops the soul, so the migration must carry them anyway.
    ['g-1', 'ghost', 'completed'],
    // Legacy shapes `isValidAgentId` deliberately still accepts.
    ['l-1', 'Ava_1', 'completed'],
    // And one that cannot key a directory at all.
    ['x-1', '../escape', 'completed'],
  ] as const) {
    const body = JSON.stringify({ id, agent: { id: agentId, name: agentId }, status, messages: [], createdAt: at, updatedAt: at });
    insert.run(id, agentId, status, body, at, at);
  }
  db.prepare('INSERT OR REPLACE INTO schedules (id, agent_id, next_fire_at, body, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('sched-1', 'ava', '2026-02-01T07:00:00.000Z', JSON.stringify({ id: 'sched-1', agentId: 'ava' }), at);
  db.close();

  await writeFile(legacyMemoryFilePath(env), [
    JSON.stringify({ id: 'ava:memory:1', agentId: 'ava', content: 'likes jazz', createdAt: at }),
    JSON.stringify({ id: 'ghost:memory:1', agentId: 'ghost', content: 'a dropped soul remembers', createdAt: at }),
    JSON.stringify({ id: 'bad:memory:1', agentId: '../escape', content: 'nowhere to put this', createdAt: at }),
    'not json at all',
    '',
  ].join('\n'));

  await writeFile(
    path.join(agentsDirPath(env), 'ava.whitelist.json'),
    `${JSON.stringify({ version: 1, scopes: [{ command: 'git', args: ['push'] }] })}\n`,
  );
};

const sessionIdsIn = (filePath: string): string[] => {
  const db = new DatabaseSync(filePath);
  const rows = db.prepare('SELECT id FROM sessions ORDER BY id').all() as Array<{ id: string }>;
  db.close();
  return rows.map((row) => row.id);
};

test('the layout migration moves every shared resource and preserves the originals', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await seedSharedState(home);

  const applied = await runStateMigrations(env, { exclusive: true });
  assert.ok(applied.map((result) => result.id).includes('0003-per-agent-state-layout'), applied.map((result) => result.id).join(', '));
  await drainSharedMemory(env);

  // Sessions, split by the stored agent id — including an agent whose soul
  // is absent, and a legacy id shape that is path-safe but not a slug.
  assert.deepEqual(sessionIdsIn(agentSessionDbPath(env, 'ava')), ['a-1', 'a-2']);
  assert.deepEqual(sessionIdsIn(agentSessionDbPath(env, 'ghost')), ['g-1']);
  assert.deepEqual(sessionIdsIn(agentSessionDbPath(env, 'Ava_1')), ['l-1']);

  // Schedules are fleet infrastructure and go to the fleet database, not
  // into whichever agent's file happened to be open.
  const fleet = new DatabaseSync(fleetDbPath(env));
  assert.deepEqual(
    (fleet.prepare('SELECT id, agent_id FROM schedules').all() as Array<{ id: string; agent_id: string }>)
      .map((row) => `${row.id}/${row.agent_id}`),
    ['sched-1/ava'],
  );
  // And no conversation body rides along into a fleet-wide file.
  assert.equal(
    (fleet.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get()),
    undefined,
  );
  fleet.close();

  // Memories, per agent, still readable through the store the daemon uses.
  const memory = createHomeMemoryStore(env);
  assert.deepEqual((await memory.list('ava')).entries.map((entry) => entry.content), ['likes jazz']);
  assert.deepEqual((await memory.list('ghost')).entries.map((entry) => entry.content), ['a dropped soul remembers']);

  // Grants, in the agent's own directory, where the daemon now reads them.
  const grants = JSON.parse(await readFile(whitelistPathFor(agentsDirPath(env), 'ava'), 'utf8')) as { scopes: unknown[] };
  assert.equal(grants.scopes.length, 1);

  // Every original is still on disk under an archived name — repointing a
  // store at a path the migration did not populate is how history vanishes,
  // and a preserved original is what makes that recoverable.
  await stat(`${legacySessionDbPath(env)}.migrated`);
  await stat(`${legacyMemoryFilePath(env)}.migrated`);
  await assert.rejects(() => stat(legacySessionDbPath(env)));
  await assert.rejects(() => stat(legacyMemoryFilePath(env)));

  // The per-agent directories are owner-only, like the credentials file.
  assert.equal((await stat(path.dirname(agentSessionDbPath(env, 'ava')))).mode & 0o777, 0o700);
  assert.equal((await stat(agentSessionDbPath(env, 'ava'))).mode & 0o777, 0o600);
  assert.equal((await stat(agentMemoryFilePath(env, 'ava'))).mode & 0o777, 0o600);
});

test('an id that cannot key a directory is quarantined loudly, never dropped', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await seedSharedState(home);

  const applied = await runStateMigrations(env, { exclusive: true });
  const drained = await drainSharedMemory(env);
  const detail = [...applied.map((result) => result.detail ?? ''), drained ?? ''].join(' ');
  assert.match(detail, /QUARANTINED/);
  assert.match(detail, /\.\.\/escape/);
  // "Quarantined" means the rows are still where they were, in the
  // preserved original — not written to a path derived from an id that
  // could leave the directory.
  assert.deepEqual(sessionIdsIn(`${legacySessionDbPath(env)}.migrated`).includes('x-1'), true);
  const archived = await readFile(`${legacyMemoryFilePath(env)}.migrated`, 'utf8');
  assert.match(archived, /nowhere to put this/);
  // And nothing outside the agents directory was created for it — which is
  // where `../escape` would have landed had the id reached a join.
  await assert.rejects(() => stat(path.join(stratusHomePath(env), 'escape')));
});

test('a second start does not re-migrate, and adds no duplicate rows', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await seedSharedState(home);

  await runStateMigrations(env, { exclusive: true });
  await drainSharedMemory(env);
  const again = await runStateMigrations(env, { exclusive: true });
  assert.deepEqual(again, []);
  assert.equal(await drainSharedMemory(env), undefined);
  assert.deepEqual(sessionIdsIn(agentSessionDbPath(env, 'ava')), ['a-1', 'a-2']);
  const memories = (await readFile(agentMemoryFilePath(env, 'ava'), 'utf8'))
    .split('\n')
    .filter((line) => line.trim().length > 0);
  assert.equal(memories.length, 1);
});

test('a run killed before the sources are renamed resumes without duplicating anything', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await seedSharedState(home);

  // What a kill between the per-agent writes and the rename leaves: the
  // destinations are populated and the sources are still there, which must
  // not read as "already done" and must not double the rows on the re-run.
  await runStateMigrations(env, { exclusive: true });
  await drainSharedMemory(env);
  const sessionsAfterFirst = sessionIdsIn(agentSessionDbPath(env, 'ava'));
  const { rename } = await import('node:fs/promises');
  await rename(`${legacySessionDbPath(env)}.migrated`, legacySessionDbPath(env));
  await rename(`${legacyMemoryFilePath(env)}.migrated`, legacyMemoryFilePath(env));
  const { applyPerAgentLayout } = await import('../src/layout-migration.ts');
  await applyPerAgentLayout(env);
  await drainSharedMemory(env);

  assert.deepEqual(sessionIdsIn(agentSessionDbPath(env, 'ava')), sessionsAfterFirst);
  const memories = (await readFile(agentMemoryFilePath(env, 'ava'), 'utf8'))
    .split('\n')
    .filter((line) => line.trim().length > 0);
  assert.equal(memories.length, 1);
});

test('the sessions and grants wait for a caller that holds the home; the memory drain does not', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await seedSharedState(home);

  // The ordinary path — any command on any install, with a daemon of the
  // older build possibly still writing that database and that grant file.
  const automatic = await runStateMigrations(env);
  assert.deepEqual(
    automatic.map((result) => result.id),
    ['0001-owner-only-state-files', '0002-provenance-labels'],
  );
  await stat(legacySessionDbPath(env));
  await stat(path.join(agentsDirPath(env), 'ava.whitelist.json'));
  assert.deepEqual((await pendingStateMigrations(env)).map((migration) => migration.id), ['0003-per-agent-state-layout']);
  // And the home is not stamped as fully migrated while the move is
  // pending, so an older build is not refused over state it can still read.
  assert.notEqual((await readStateStamp(env)).schemaVersion, STATE_SCHEMA_VERSION);

  // The memories move anyway, because nothing about them needs the bracket
  // and an upgrade must never look like the agent forgot.
  await drainSharedMemory(env);
  const memory = createHomeMemoryStore(env);
  assert.deepEqual((await memory.list('ava')).entries.map((entry) => entry.content), ['likes jazz']);

  // A caller that does hold the home finishes the job.
  const exclusive = await runStateMigrations(env, { exclusive: true });
  assert.deepEqual(exclusive.map((result) => result.id), ['0003-per-agent-state-layout']);
  assert.deepEqual(sessionIdsIn(agentSessionDbPath(env, 'ava')), ['a-1', 'a-2']);
  assert.equal((await readStateStamp(env)).schemaVersion, STATE_SCHEMA_VERSION);
});

test('a grant file the move has not reached yet is still the one that is read', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await seedSharedState(home);
  // The window the bracket creates: a newer build installed, the older
  // daemon still serving, so the grants are still under the old name. A
  // read that looked only at the new path would report an agent with no
  // standing grants — and would hide a revocation the still-serving daemon
  // had just written there.
  await runStateMigrations(env);
  const store = createFileCommandWhitelist({ directory: agentsDirPath(env) });
  assert.deepEqual((await store.scopesFor('ava')).map((scope) => scope.command), ['git']);

  await runStateMigrations(env, { exclusive: true });
  const after = createFileCommandWhitelist({ directory: agentsDirPath(env) });
  assert.deepEqual((await after.scopesFor('ava')).map((scope) => scope.command), ['git']);
});

test('a memory record written after one drain is taken by the next', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await seedSharedState(home);
  // Everything the registry has to say about this home, said: after this
  // there is no pending migration left to pick anything up.
  await runStateMigrations(env, { exclusive: true });
  await drainSharedMemory(env);
  assert.deepEqual(await runStateMigrations(env, { exclusive: true }), []);

  // The file store opens the JSONL by pathname on every append, so a daemon
  // of the older build writing one more fact does not land in the claimed
  // inode — it recreates the shared file. A stamped one-shot would have
  // recorded itself as done and left this record where nothing looks.
  const at = '2026-01-02T00:00:00.000Z';
  await writeFile(
    legacyMemoryFilePath(env),
    `${JSON.stringify({ id: 'ava:memory:late', agentId: 'ava', content: 'written after the drain', createdAt: at })}\n`,
  );

  assert.notEqual(await drainSharedMemory(env), undefined);
  const memory = createHomeMemoryStore(env);
  assert.deepEqual(
    (await memory.list('ava')).entries.map((entry) => entry.content),
    ['likes jazz', 'written after the drain'],
  );
  await assert.rejects(() => stat(legacyMemoryFilePath(env)));
});

test('a home with nothing shared to move is migrated by the ordinary path', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  const applied = await runStateMigrations(env);
  assert.ok(applied.map((result) => result.id).includes('0003-per-agent-state-layout'));
  assert.deepEqual(applied.map((result) => result.detail).filter((detail) => detail !== undefined), []);
  // A fresh install must not be left holding an old stamp waiting for a
  // daemon start it may not get for days.
  assert.equal((await readStateStamp(env)).schemaVersion, STATE_SCHEMA_VERSION);
});

test('a grant file already in the new place is never written over by the old one', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await seedSharedState(home);
  const current = whitelistPathFor(agentsDirPath(env), 'ava');
  await mkdir(path.dirname(current), { recursive: true });
  await writeFile(current, `${JSON.stringify({ version: 1, scopes: [], tools: [{ tool: 'web.fetch', grantedAt: '2026-03-01T00:00:00.000Z' }] })}\n`);

  const applied = await runStateMigrations(env, { exclusive: true });
  const detail = applied.map((result) => result.detail ?? '').join(' ');
  // The agent's own directory is the one the daemon reads, so the older
  // file stays put rather than overwriting grants somebody has since
  // changed — and it is named rather than silently skipped.
  assert.match(detail, /ava\.whitelist\.json/);
  const kept = JSON.parse(await readFile(current, 'utf8')) as { tools: Array<{ tool: string }> };
  assert.deepEqual(kept.tools.map((grant) => grant.tool), ['web.fetch']);
  await stat(path.join(agentsDirPath(env), 'ava.whitelist.json'));
});
