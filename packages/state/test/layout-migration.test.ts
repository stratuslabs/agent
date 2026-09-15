import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
  hasBracketedLegacyState,
  legacyStateHeld,
  fleetDbPath,
  legacyMemoryFilePath,
  legacySessionDbPath,
  legacySessionDbIn,
  hasBracketedLegacyStateIn,
  pendingStateMigrations,
  readStateStamp,
  runStateMigrations,
  stateFilePath,
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
  // A deferring run records *nothing*, not even the two it just ran: a
  // partial stamp written from its snapshot is what can land on top of a
  // complete one written by the exclusive run beside it, and take migration
  // 0003 back out of the record. The two it ran are idempotent and run
  // again next time, which is the cheaper half of that trade.
  assert.deepEqual(await readStateStamp(env), { schemaVersion: 0, applied: [] });
  assert.deepEqual(
    (await pendingStateMigrations(env)).map((migration) => migration.id),
    ['0001-owner-only-state-files', '0002-provenance-labels', '0003-per-agent-state-layout'],
  );

  // The memories move anyway, because nothing about them needs the bracket
  // and an upgrade must never look like the agent forgot.
  await drainSharedMemory(env);
  const memory = createHomeMemoryStore(env);
  assert.deepEqual((await memory.list('ava')).entries.map((entry) => entry.content), ['likes jazz']);

  // A caller that does hold the home finishes the job.
  const exclusive = await runStateMigrations(env, { exclusive: true });
  assert.deepEqual(
    exclusive.map((result) => result.id),
    ['0001-owner-only-state-files', '0002-provenance-labels', '0003-per-agent-state-layout'],
  );
  assert.deepEqual(sessionIdsIn(agentSessionDbPath(env, 'ava')), ['a-1', 'a-2']);
  // And now the stamp, once and whole.
  assert.equal((await readStateStamp(env)).schemaVersion, STATE_SCHEMA_VERSION);
  assert.deepEqual(await pendingStateMigrations(env), []);
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
  // And a third pass over the same file adds nothing: the copy dedupes by
  // line, which is what lets it run on every command.
  assert.equal(await drainSharedMemory(env), undefined);
});

test('the drain copies, so a daemon of the older build keeps reading its own file', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await seedSharedState(home);

  // The old daemon reads `memory.jsonl` by pathname on every listing and
  // takes ENOENT as an empty store, so a drain that moved the file would
  // make its agents answer mid-conversation as though they had forgotten
  // everything — the same failure the early copy exists to avoid, pointed
  // at the old process instead of the new one.
  const before = await readFile(legacyMemoryFilePath(env), 'utf8');
  await drainSharedMemory(env);
  assert.equal(await readFile(legacyMemoryFilePath(env), 'utf8'), before, 'the old reader still has its file, byte for byte');
  // The new build has it too, from its own file.
  assert.deepEqual((await createHomeMemoryStore(env).list('ava')).entries.map((entry) => entry.content), ['likes jazz']);

  // Retiring it is the exclusive half's, where that reader is gone by
  // definition — and the derived index goes with it.
  await runStateMigrations(env, { exclusive: true });
  await assert.rejects(() => stat(legacyMemoryFilePath(env)));
  await stat(`${legacyMemoryFilePath(env)}.migrated`);
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
  // file does not overwrite grants somebody has since changed — and it is
  // named rather than silently skipped.
  assert.match(detail, /ava\.whitelist\.json/);
  const kept = JSON.parse(await readFile(current, 'utf8')) as { tools: Array<{ tool: string }> };
  assert.deepEqual(kept.tools.map((grant) => grant.tool), ['web.fetch']);
  // Kept under the archive name rather than at the old one, which would
  // read as a home the move never reached — see the unservable-home test.
  await stat(path.join(agentsDirPath(env), 'ava.whitelist.json.migrated'));
  await assert.rejects(() => stat(path.join(agentsDirPath(env), 'ava.whitelist.json')));
});

test('an id whose directory name is already a file is quarantined, not a crash', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await seedSharedState(home);
  // A legacy id held to path safety but not to the slug shape — `ava.md` is
  // a valid id — whose state directory is the name its own soul file
  // already has. `mkdir` throws EEXIST on that, and an exception here would
  // abort the migration, leave the shared database unarchived, and stop
  // `stratus serve` from coming up at all.
  await writeFile(path.join(agentsDirPath(env), 'collide.md'), '---\nname: Collide\nid: collide.md\n---\n\nYou collide.\n');
  const at = '2026-01-01T00:00:00.000Z';
  const db = new DatabaseSync(legacySessionDbPath(env));
  db.prepare('INSERT OR REPLACE INTO sessions (id, agent_id, status, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('c-1', 'collide.md', 'completed', JSON.stringify({ id: 'c-1' }), at, at);
  db.close();

  const applied = await runStateMigrations(env, { exclusive: true });
  const detail = applied.map((result) => result.detail ?? '').join(' ');
  assert.match(detail, /QUARANTINED/);
  assert.match(detail, /collide\.md/);
  // The rest of the fleet moved around it, and the original is archived —
  // which is what lets the daemon start at all.
  assert.deepEqual(sessionIdsIn(agentSessionDbPath(env, 'ava')), ['a-1', 'a-2']);
  await stat(`${legacySessionDbPath(env)}.migrated`);
});

test('a grant written before the move lands in the file the move will carry', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await seedSharedState(home);
  await runStateMigrations(env);

  // The window: the older daemon still serving, so the grants are still
  // under the old name, and a `stratus grants revoke` that cannot reach a
  // control API falls back to the files. Writing the NEW path here would
  // fork the list — the migration would find its destination occupied,
  // leave the old file aside as it must, and lose every revocation the old
  // daemon wrote to it afterwards.
  const store = createFileCommandWhitelist({ directory: agentsDirPath(env) });
  await store.rememberTool('ava', { tool: 'web.fetch', grantedAt: '2026-03-01T00:00:00.000Z' });
  await assert.rejects(() => stat(whitelistPathFor(agentsDirPath(env), 'ava')));
  const legacy = JSON.parse(await readFile(path.join(agentsDirPath(env), 'ava.whitelist.json'), 'utf8')) as {
    scopes: unknown[];
    tools: Array<{ tool: string }>;
  };
  assert.equal(legacy.scopes.length, 1, 'the scope that was already there came through');
  assert.deepEqual(legacy.tools.map((grant) => grant.tool), ['web.fetch']);

  // And the move then carries the one file, with both grants in it.
  await runStateMigrations(env, { exclusive: true });
  const moved = createFileCommandWhitelist({ directory: agentsDirPath(env) });
  assert.deepEqual((await moved.toolGrantsFor('ava')).map((grant) => grant.tool), ['web.fetch']);
  assert.deepEqual((await moved.scopesFor('ava')).map((scope) => scope.command), ['git']);
});

test('a grant write never recreates the old file the move has already taken', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await seedSharedState(home);
  await runStateMigrations(env);

  // The gap the exclusive move can land in: a file-fallback grant write
  // resolves the old path, and the rename happens before it writes. A plain
  // `writeFile` would recreate the old name after the migration had already
  // copied and stamped — the grants the daemon now reads would be missing
  // this write, and the legacy file left behind would make every later
  // `start()` refuse the home as un-migrated, with no migration left to run.
  const store = createFileCommandWhitelist({ directory: agentsDirPath(env) });
  await store.scopesFor('ava'); // resolve and cache, as a revoke does first
  await runStateMigrations(env, { exclusive: true });
  await store.rememberTool('ava', { tool: 'web.fetch', grantedAt: '2026-03-01T00:00:00.000Z' });

  await assert.rejects(() => stat(path.join(agentsDirPath(env), 'ava.whitelist.json')));
  const moved = JSON.parse(await readFile(whitelistPathFor(agentsDirPath(env), 'ava'), 'utf8')) as {
    tools: Array<{ tool: string }>;
  };
  assert.deepEqual(moved.tools.map((grant) => grant.tool), ['web.fetch']);
  // And the home does not read as un-migrated, which is the wedge.
  assert.equal(await hasBracketedLegacyState(env), false);
});

test('an empty database left at the old pathname is not mistaken for un-migrated state', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await seedSharedState(home);
  await runStateMigrations(env, { exclusive: true });
  // The archive beside it is what makes the husk a husk.

  // SQLite creates a database on open and `DatabaseSync` has no
  // open-without-create, so a process that resolved the old pathname a
  // moment before the rename leaves an empty husk behind it. Read as "this
  // home is un-migrated", that husk is a permanent refusal over a file with
  // nothing in it — and the migration that would clear it is already
  // stamped as applied.
  const husk = new DatabaseSync(legacySessionDbPath(env));
  husk.exec('CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, next_fire_at TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL)');
  husk.close();

  assert.equal(await hasBracketedLegacyState(env), false);
  assert.deepEqual(await legacyStateHeld(env), { sessions: 0, schedules: 0 });
});

test('a directory name the platform refuses is quarantined like any other unusable name', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await seedSharedState(home);
  // The collision case stands in for the class: `isValidAgentId` answers
  // path *safety*, which is not the same question as whether the platform
  // will take the name — `CON` and a trailing dot are valid ids here and
  // refused by Windows. Whatever the errno, one agent's unusable name must
  // not abort the migration for the fleet.
  await writeFile(path.join(agentsDirPath(env), 'taken.md'), 'a soul file in the way');
  const at = '2026-01-01T00:00:00.000Z';
  const db = new DatabaseSync(legacySessionDbPath(env));
  db.prepare('INSERT OR REPLACE INTO sessions (id, agent_id, status, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('t-1', 'taken.md', 'completed', JSON.stringify({ id: 't-1' }), at, at);
  db.close();

  const applied = await runStateMigrations(env, { exclusive: true });
  const detail = applied.map((result) => result.detail ?? '').join(' ');
  assert.match(detail, /QUARANTINED/);
  assert.match(detail, /taken\.md/);
  // Named with the reason the filesystem gave, so an operator can tell a
  // name collision from a full disk.
  assert.match(detail, /EEXIST|ENOTDIR/);
  assert.deepEqual(sessionIdsIn(agentSessionDbPath(env, 'ava')), ['a-1', 'a-2']);
});

test('a grant file whose agent directory is a file is quarantined, not a crash', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await seedSharedState(home);
  // The grant stage's version of the collision: `agents/blocked.md` is a
  // file, `blocked.md` is a valid legacy id, and its grants sit beside the
  // souls under the old name. Probing the target under that file throws
  // ENOTDIR, which from inside the migration aborts the upgrade and leaves
  // the daemon unable to start.
  await writeFile(path.join(agentsDirPath(env), 'blocked.md'), 'a soul file in the way');
  await writeFile(
    path.join(agentsDirPath(env), 'blocked.md.whitelist.json'),
    `${JSON.stringify({ version: 1, scopes: [] })}\n`,
  );

  const applied = await runStateMigrations(env, { exclusive: true });
  const detail = applied.map((result) => result.detail ?? '').join(' ');
  assert.match(detail, /QUARANTINED/);
  assert.match(detail, /blocked\.md/);
  // The upgrade completed around it: the archive exists and the other
  // agents moved.
  await stat(`${legacySessionDbPath(env)}.migrated`);
  assert.deepEqual(sessionIdsIn(agentSessionDbPath(env, 'ava')), ['a-1', 'a-2']);
});

test('a legacy database that will not answer counts as holding something', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  // "Cannot tell" must not read as "nothing to lose": a refusal over a file
  // this build cannot make sense of is the safe direction.
  await writeFile(legacySessionDbPath(env), 'this is not a database');
  assert.equal(await hasBracketedLegacyState(env), true);
});

test('an empty database with no archive beside it still needs the bracket', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  // A home initialized a minute ago: no conversations yet, and a daemon of
  // the older build holding that very file open, about to write the first.
  // Row count alone cannot tell this from a spent husk, and migrating it
  // without the claim would send that first turn into a file already
  // renamed out of the way.
  const fresh = new DatabaseSync(legacySessionDbPath(env));
  fresh.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
  fresh.close();

  assert.deepEqual(await legacyStateHeld(env), { sessions: 0, schedules: 0 });
  assert.equal(await hasBracketedLegacyState(env), true);
  // So the ordinary path defers it, and the stamp stays back.
  assert.deepEqual(
    (await runStateMigrations(env)).map((result) => result.id),
    ['0001-owner-only-state-files', '0002-provenance-labels'],
  );
  await stat(legacySessionDbPath(env));
});

test('the bracket is asked about the state directory in use, not the home', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  // A host that pointed the stores somewhere other than ~/.stratus: the
  // sessions it would strand are in the directory it chose, so that is the
  // directory the question is about.
  const elsewhere = path.join(home, 'elsewhere');
  await mkdir(elsewhere, { recursive: true });
  const at = '2026-01-01T00:00:00.000Z';
  const db = new DatabaseSync(legacySessionDbIn(elsewhere));
  db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
  db.prepare('INSERT INTO sessions (id, agent_id, status, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('e-1', 'ava', 'completed', '{}', at, at);
  db.close();

  assert.equal(await hasBracketedLegacyStateIn(elsewhere), true);
  // And the home itself is untouched and clean, which is exactly the answer
  // that would have let those sessions be stranded silently.
  assert.equal(await hasBracketedLegacyState(env), false);
});

test('an id whose directory is a file does not break the copy that runs before every command', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await seedSharedState(home);
  // `agents/ava.md` is a file, and `ava.md` is a valid legacy id, so the
  // destination read under it fails with ENOTDIR. This copy runs before
  // every CLI command, so rethrowing would refuse `serve` — and every other
  // state-writing command — indefinitely, over one agent's unusable name.
  await writeFile(path.join(agentsDirPath(env), 'blocked.md'), 'a soul file in the way');
  await appendFile(
    legacyMemoryFilePath(env),
    `${JSON.stringify({ id: 'blocked:memory:1', agentId: 'blocked.md', content: 'nowhere to go', createdAt: '2026-01-01T00:00:00.000Z' })}\n`,
  );

  const drained = await drainSharedMemory(env);
  assert.match(drained ?? '', /QUARANTINED/);
  assert.match(drained ?? '', /blocked\.md/);
  // The agents that can move still moved.
  const memory = createHomeMemoryStore(env);
  assert.deepEqual((await memory.list('ava')).entries.map((entry) => entry.content), ['likes jazz']);
});

test('a grant file the move could not take does not leave the home unservable', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await seedSharedState(home);
  // The collision again, but asking the question the stage after it asks:
  // `agents/blocked.md` is a file, so `blocked.md` never gets a directory
  // and its grant file cannot move.
  await writeFile(path.join(agentsDirPath(env), 'blocked.md'), 'a soul file in the way');
  await writeFile(
    path.join(agentsDirPath(env), 'blocked.md.whitelist.json'),
    `${JSON.stringify({ version: 1, scopes: [] })}\n`,
  );

  await runStateMigrations(env, { exclusive: true });

  // A quarantined file left under the old name is not one agent's problem
  // but the whole home's: the detector reads any `<id>.whitelist.json` as
  // state the move has not reached, and this migration is stamped whether
  // or not every file could move — so the refusal would stand for good,
  // and the `stratus update` it names will not re-run a stamped migration.
  assert.equal(await hasBracketedLegacyState(env), false);
  assert.deepEqual(await pendingStateMigrations(env), []);
  // Kept rather than deleted, like every other original: the grants are
  // recoverable by hand, and the agent meanwhile has none.
  await stat(path.join(agentsDirPath(env), 'blocked.md.whitelist.json.migrated'));
  await assert.rejects(() => stat(path.join(agentsDirPath(env), 'blocked.md.whitelist.json')));
});

test('an agent id ending in .whitelist.json is a state directory, not a legacy grant file', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await seedSharedState(home);
  // Legal, because ids are held to path safety rather than to a slug
  // shape — and this one's state directory is spelled exactly like a
  // legacy grant file. Read as one, it refuses the home for good: 0003 is
  // stamped by then and would never clear it.
  const stateDir = path.join(agentsDirPath(env), 'team.whitelist.json');
  await mkdir(stateDir, { recursive: true });

  await runStateMigrations(env, { exclusive: true });

  assert.equal(await hasBracketedLegacyState(env), false);
  // And the move left it alone: renaming it would have carried one agent's
  // whole directory inside another agent's.
  assert.equal((await stat(stateDir)).isDirectory(), true);
  assert.equal((await stat(whitelistPathFor(agentsDirPath(env), 'ava'))).isFile(), true);
});

test('an agent directory made by its first memory write is owner-only', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  // Memory before sessions: nothing has made this agent's directory yet, so
  // the append is what creates it. Under the usual umask a bare recursive
  // mkdir leaves it 0755, and the per-agent directory is 0700 by contract —
  // it holds that agent's conversations, memories and grants.
  await createHomeMemoryStore(env).append('ava', 'likes jazz');

  const directory = path.dirname(agentMemoryFilePath(env, 'ava'));
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(agentMemoryFilePath(env, 'ava'))).mode & 0o777, 0o600);
});

test('an agent directory an older build left world-readable is tightened by the next write', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  const directory = path.dirname(agentMemoryFilePath(env, 'ava'));
  await mkdir(directory, { recursive: true, mode: 0o755 });
  await chmod(directory, 0o755);

  await createHomeMemoryStore(env).append('ava', 'likes jazz');

  // `mkdir` applies its mode only when it creates, so the tighten has to be
  // its own step or an upgrade keeps whatever the old build left.
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
});

test('a retirement a kill interrupted is finished, not left holding the only copy', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await seedSharedState(home);
  const at = '2026-04-01T00:00:00.000Z';

  // What a kill between the claim and the archive leaves: the shared file
  // renamed out of the way under a unique name, holding records no other
  // pathname reaches. The rename is atomic precisely so this is the only
  // state it can be left in — and it has to be finished, not stepped over.
  await writeFile(
    `${legacyMemoryFilePath(env)}.retiring-2c9b1f70-0000-4000-8000-000000000000`,
    `${JSON.stringify({ id: 'ava:memory:late', agentId: 'ava', content: 'remembered on the way out', createdAt: at })}\n`,
  );

  await runStateMigrations(env, { exclusive: true });

  const memory = createHomeMemoryStore(env);
  assert.deepEqual(
    (await memory.list('ava')).entries.map((entry) => entry.content).sort(),
    ['likes jazz', 'remembered on the way out'],
  );
  // And the claim is gone, since nothing appended to it while it was placed.
  assert.deepEqual((await readdir(stratusHomePath(env))).filter((name) => name.includes('.retiring-')), []);
});

test('a leftover claim is finished by any command, not only by the migration', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await mkdir(agentsDirPath(env), { recursive: true });
  // The state `placeClaim` leaves when the file was still growing — and
  // migration 0003 is stamped by then, so `applyPerAgentLayout` never runs
  // again. If the every-command drain does not finish these, the records in
  // them are reachable by nothing at all.
  await writeFile(
    `${legacyMemoryFilePath(env)}.retiring-7a1e4c60-0000-4000-8000-000000000000`,
    `${JSON.stringify({ id: 'ava:memory:left', agentId: 'ava', content: 'left in a claim', createdAt: '2026-04-01T00:00:00.000Z' })}\n`,
  );

  await drainSharedMemory(env);

  assert.deepEqual(
    (await createHomeMemoryStore(env).list('ava')).entries.map((entry) => entry.content),
    ['left in a claim'],
  );
  assert.deepEqual((await readdir(stratusHomePath(env))).filter((name) => name.includes('.retiring-')), []);
});

test('retiring the shared file appends to an earlier archive rather than renaming over it', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await seedSharedState(home);

  // An archive an earlier retirement wrote. The shared file comes back
  // afterwards — the store opens it by pathname on every append, so an
  // older build recreates it — and a rename would take this with it,
  // destroying the only copy of whatever that pass could not place.
  await writeFile(
    `${legacyMemoryFilePath(env)}.migrated`,
    `${JSON.stringify({ id: 'ava:memory:older', agentId: 'ava', content: 'from an earlier pass', createdAt: '2026-01-01T00:00:00.000Z' })}\n`,
  );

  await runStateMigrations(env, { exclusive: true });

  const archived = await readFile(`${legacyMemoryFilePath(env)}.migrated`, 'utf8');
  assert.match(archived, /from an earlier pass/);
  assert.match(archived, /likes jazz/);
});

test('an agent directory that is a symlink is quarantined, not written through', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await seedSharedState(home);
  // A name the old layout did not reserve, pointed somewhere else. `mkdir`
  // is satisfied by it, and the writes would land wherever it points —
  // and the startup sweep reads entry types, so it would not see a
  // directory there at all and those sessions could never be resumed.
  const elsewhere = path.join(home, 'elsewhere');
  await mkdir(elsewhere, { recursive: true });
  await symlink(elsewhere, path.join(agentsDirPath(env), 'ava'));

  const applied = await runStateMigrations(env, { exclusive: true });
  const detail = applied.map((result) => result.detail ?? '').join(' ');
  assert.match(detail, /QUARANTINED/);
  assert.match(detail, /ava/);

  // Nothing of ava's was written through the link, and the rest of the
  // fleet moved around it.
  assert.deepEqual(await readdir(elsewhere), []);
  assert.deepEqual(sessionIdsIn(agentSessionDbPath(env, 'ghost')), ['g-1']);
});

test('a claim holding bytes that are not valid UTF-8 is still placed and still removed', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await seedSharedState(home);
  const claim = `${legacyMemoryFilePath(env)}.retiring-3d0c2a81-0000-4000-8000-000000000000`;
  // A torn append is exactly how this arises: a writer that predates the
  // home claim is interrupted mid multi-byte sequence. Decoding replaces
  // the broken bytes with U+FFFD, which is *longer* than what is on disk —
  // so a claim compared by its decoded length never matches its own size,
  // is never unlinked, and is re-placed by every command from then on.
  await writeFile(claim, Buffer.concat([
    Buffer.from(`${JSON.stringify({ id: 'ava:memory:one', agentId: 'ava', content: 'placed from the claim', createdAt: '2026-04-01T00:00:00.000Z' })}\n`),
    Buffer.from([0xe2, 0x28]),
  ]));

  await runStateMigrations(env, { exclusive: true });

  const memory = createHomeMemoryStore(env);
  assert.ok((await memory.list('ava')).entries.some((entry) => entry.content === 'placed from the claim'));
  // Removed — comparing a *decoded* length against the file's size would
  // never match, leaving the claim holding its bytes and re-placing them on
  // every command for ever.
  assert.deepEqual((await readdir(stratusHomePath(env))).filter((name) => name.includes('.retiring-')), []);
});

test('a retry does not rename a husk over the archive it already wrote', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await seedSharedState(home);

  await runStateMigrations(env, { exclusive: true });
  const archived = sessionIdsIn(`${legacySessionDbPath(env)}.migrated`);
  assert.ok(archived.length > 0, 'the first pass archived the original');

  // What a kill *before the stamp* leaves: the move done, nothing recorded,
  // so the next run redoes it. (The stamp is written once, at the end — so
  // removing it is exactly the state that kill leaves behind.) Plus the
  // empty `sessions.db` a `stratus schedules` puts back at the old name in
  // the meantime, because SQLite creates one on open. Renaming that over the
  // archive would take every row this pass preserved with it.
  await rm(stateFilePath(env), { force: true });
  new DatabaseSync(legacySessionDbPath(env)).close();
  await runStateMigrations(env, { exclusive: true });

  assert.deepEqual(sessionIdsIn(`${legacySessionDbPath(env)}.migrated`), archived);
});

test('an owned memory directory that is a symlink is refused, not written through', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  const elsewhere = path.join(home, 'elsewhere');
  await mkdir(elsewhere, { recursive: true });
  await symlink(elsewhere, path.join(agentsDirPath(env), 'ava'));

  await assert.rejects(
    () => createHomeMemoryStore(env).append('ava', 'likes jazz'),
    (error: unknown) => error instanceof Error && /symlink/.test(error.message),
  );
  assert.deepEqual(await readdir(elsewhere), []);
});

test('a retry does not rename a recreated grant file over the archive it already wrote', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await seedSharedState(home);
  // A grant file the move cannot take, so the first pass archives it.
  await writeFile(path.join(agentsDirPath(env), 'blocked.md'), 'a soul file in the way');
  await writeFile(
    path.join(agentsDirPath(env), 'blocked.md.whitelist.json'),
    `${JSON.stringify({ version: 1, scopes: [{ command: 'git', args: ['push'] }] })}\n`,
  );

  await runStateMigrations(env, { exclusive: true });
  const archived = await readFile(path.join(agentsDirPath(env), 'blocked.md.whitelist.json.migrated'), 'utf8');
  assert.match(archived, /git/);

  // The kill-before-the-stamp retry again, with an older build having put a
  // grant file back at the old name in between.
  await rm(stateFilePath(env), { force: true });
  await writeFile(
    path.join(agentsDirPath(env), 'blocked.md.whitelist.json'),
    `${JSON.stringify({ version: 1, scopes: [] })}\n`,
  );
  await runStateMigrations(env, { exclusive: true });

  // The first pass's grants are still there, not replaced by the empty list.
  assert.equal(await readFile(path.join(agentsDirPath(env), 'blocked.md.whitelist.json.migrated'), 'utf8'), archived);
});
