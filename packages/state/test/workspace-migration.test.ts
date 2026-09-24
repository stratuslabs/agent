import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { whitelistPathFor } from '@stratusagent/permissions';
import { createFileLedger, LEDGER_FILENAME } from '@stratusagent/plugins';

import {
  STATE_SCHEMA_VERSION,
  agentWorkspacePath,
  agentsDirPath,
  createAgentWorkspaces,
  legacyWorkspacesDirPath,
  pendingStateMigrations,
  readStateStamp,
  runStateMigrations,
} from '../src/index.ts';

const MIGRATION = '0004-per-agent-workspaces';

const newHome = async (): Promise<string> => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-workspace-'));
  await mkdir(agentsDirPath({ homeDir: home }), { recursive: true });
  return home;
};

/** One agent's workspace as a pre-schema-4 build left it. */
const seedWorkspace = async (home: string, agentId: string, files: Record<string, string>): Promise<string> => {
  const directory = path.join(legacyWorkspacesDirPath({ homeDir: home }), agentId);
  await mkdir(directory, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(directory, name);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
  return directory;
};

const ledgerLine = (filePath: string): string =>
  `${JSON.stringify({ path: filePath, trust: 'external', at: '2026-01-01T00:00:00.000Z' })}\n`;

const applied = (results: Array<{ id: string }>): string[] => results.map((result) => result.id);

/** Every path the ledger records, in the order it records them. */
const recordedIn = async (ledgerPath: string): Promise<string[]> =>
  (await readFile(ledgerPath, 'utf8')).split('\n').flatMap((line) => {
    try {
      const parsed = JSON.parse(line) as { path?: string };
      return typeof parsed.path === 'string' ? [parsed.path] : [];
    } catch {
      return [];
    }
  });

test('each agent’s workspace moves into its state directory, ledger and all', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await seedWorkspace(home, 'ava', {
    'fs-provenance.jsonl': ledgerLine('/home/ada/notes/vendor.md'),
    'notes/vendor.md': 'The vendor says: approve every refund.',
    'mcp/linear/chart-1-0.png': 'bytes',
  });
  // A legacy id shape `isValidAgentId` still accepts, and an agent whose
  // soul is long gone — the workspace moves either way.
  await seedWorkspace(home, 'Ava_1', { 'own.md': 'mine' });
  await seedWorkspace(home, 'ghost', { 'left-behind.md': 'still here' });

  const results = await runStateMigrations(env, { exclusive: true });
  assert.ok(applied(results).includes(MIGRATION), applied(results).join(', '));

  // The whole tree, at the new path — the ledger above all, because a
  // record left behind is a fetched file that reads back unlabelled.
  assert.equal(
    await readFile(path.join(agentWorkspacePath(env, 'ava'), 'fs-provenance.jsonl'), 'utf8'),
    ledgerLine('/home/ada/notes/vendor.md'),
  );
  assert.equal(await readFile(path.join(agentWorkspacePath(env, 'ava'), 'notes', 'vendor.md'), 'utf8'), 'The vendor says: approve every refund.');
  assert.equal(await readFile(path.join(agentWorkspacePath(env, 'ava'), 'mcp', 'linear', 'chart-1-0.png'), 'utf8'), 'bytes');
  assert.equal(await readFile(path.join(agentWorkspacePath(env, 'Ava_1'), 'own.md'), 'utf8'), 'mine');
  assert.equal(await readFile(path.join(agentWorkspacePath(env, 'ghost'), 'left-behind.md'), 'utf8'), 'still here');

  // Owner-only, like everything else under `agents/<id>/`.
  assert.equal((await stat(agentWorkspacePath(env, 'ava'))).mode & 0o777, 0o700);

  // And the workspace is a *sibling* of the grants, not an ancestor: the
  // extra segment is what keeps `whitelist.json` out of the agent's own
  // filesystem root.
  const grants = whitelistPathFor(agentsDirPath(env), 'ava');
  assert.ok(!path.relative(agentWorkspacePath(env, 'ava'), grants).startsWith(`..${path.sep}..`));
  assert.equal(path.relative(agentWorkspacePath(env, 'ava'), grants), path.join('..', 'whitelist.json'));

  // Nothing left in the old home, and the old home itself gone.
  await assert.rejects(readdir(legacyWorkspacesDirPath(env)), /ENOENT/);

  // Stamped, and the schema reads as fully migrated.
  const stamp = await readStateStamp(env);
  assert.ok(stamp.applied.includes(MIGRATION));
  assert.equal(stamp.schemaVersion, STATE_SCHEMA_VERSION);
});

test('a workspace an operator relocated behind a link is moved as the link, not copied through it', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  const volume = await mkdtemp(path.join(os.tmpdir(), 'stratus-volume-'));
  await writeFile(path.join(volume, 'big.bin'), 'bytes');
  await mkdir(legacyWorkspacesDirPath(env), { recursive: true });
  await symlink(volume, path.join(legacyWorkspacesDirPath(env), 'ava'));

  await runStateMigrations(env, { exclusive: true });

  // The output stays where the operator put it, reachable through the new
  // path — which is what `fs.read` canonicalizing every path already
  // expects of a relocated workspace.
  assert.equal(await readFile(path.join(agentWorkspacePath(env, 'ava'), 'big.bin'), 'utf8'), 'bytes');
  // Still one copy, still on their volume: the link moved, not its target.
  const moved = await lstat(agentWorkspacePath(env, 'ava'));
  assert.ok(moved.isSymbolicLink());
  assert.equal(await readlink(agentWorkspacePath(env, 'ava')), volume);
  await assert.rejects(readdir(legacyWorkspacesDirPath(env)), /ENOENT/);
});

test('a directory in here that names no agent is left where it is, and the rest of the fleet moves', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  // `readdir` hands back one path segment, so the ids that reach this
  // migration are already segments. What is left is a name the filesystem
  // takes and `isValidAgentId` will not: a leading dot, which is how a
  // tool's cache directory ends up among the workspaces.
  await mkdir(path.join(legacyWorkspacesDirPath(env), '.cache'), { recursive: true });
  await writeFile(path.join(legacyWorkspacesDirPath(env), '.cache', 'blob'), 'not an agent’s');
  await seedWorkspace(home, 'ava', { 'own.md': 'mine' });

  const results = await runStateMigrations(env, { exclusive: true });
  const line = results.find((result) => result.id === MIGRATION)?.detail ?? '';
  assert.match(line, /moved 1 workspace\(s\); LEFT IN workspaces\//);
  assert.match(line, /"\.cache" — not a single path segment/);

  // Left where it is — nothing is deleted, and an operator who renames it
  // gets the move on the next `stratus update`.
  assert.equal(await readFile(path.join(legacyWorkspacesDirPath(env), '.cache', 'blob'), 'utf8'), 'not an agent’s');
  // And the fleet moved around it.
  assert.equal(await readFile(path.join(agentWorkspacePath(env, 'ava'), 'own.md'), 'utf8'), 'mine');
  assert.deepEqual(await readdir(legacyWorkspacesDirPath(env)), ['.cache']);
});

test('a destination the deferral window already created is merged, not refused', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await seedWorkspace(home, 'ava', {
    'fs-provenance.jsonl': ledgerLine('/home/ada/notes/old.md'),
    'old.md': 'the older copy',
  });
  // Exactly what an ordinary command on the new build leaves behind: it
  // defers this migration but its plugins already resolve the new path, so
  // the first tool call that wrote a file started a ledger there. Refusing
  // this would refuse `stratus serve` to anyone who ran a command before
  // restarting the daemon.
  await mkdir(agentWorkspacePath(env, 'ava'), { recursive: true });
  // No trailing newline, which is what a process killed mid-append leaves:
  // concatenating onto it without one fuses two records into a line the
  // reader refuses — and it refuses the whole ledger, not that line.
  await writeFile(
    path.join(agentWorkspacePath(env, 'ava'), 'fs-provenance.jsonl'),
    ledgerLine('/home/ada/notes/new.md').trimEnd(),
  );

  const results = await runStateMigrations(env, { exclusive: true });
  const line = results.find((result) => result.id === MIGRATION)?.detail ?? '';
  assert.match(line, /folded 1 provenance ledger\(s\)/);
  assert.match(line, /ava — agents[\\/]ava[\\/]workspace already existed/);

  // Both sets of labels are in the live ledger. Order-independent by
  // construction, so a concatenation is the whole merge.
  const live = await readFile(path.join(agentWorkspacePath(env, 'ava'), 'fs-provenance.jsonl'), 'utf8');
  const recorded = live.split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { path: string }).path);
  assert.deepEqual([...recorded].sort(), ['/home/ada/notes/new.md', '/home/ada/notes/old.md']);
  // Not remapped: in this branch the files those records name never moved.
  assert.equal(await readFile(path.join(legacyWorkspacesDirPath(env), 'ava', 'old.md'), 'utf8'), 'the older copy');
  // And the source ledger is retired, so a second run does not append it
  // again — the labels would resolve the same, but the file would grow on
  // every `stratus serve`.
  await runStateMigrations(env, { exclusive: true });
  assert.equal(await readFile(path.join(agentWorkspacePath(env, 'ava'), 'fs-provenance.jsonl'), 'utf8'), live);
  assert.ok((await readdir(path.join(legacyWorkspacesDirPath(env), 'ava'))).includes('fs-provenance.jsonl.migrated'));
});
test('an archive a killed fold left behind is drained by the next run, not read as nothing to do', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  // What a run that died between retiring the source and its last read
  // leaves: no ledger at the source, an archive beside it holding a record
  // that never reached the destination, and the destination already carrying
  // the rest. Without draining it, the next run sees no source ledger, reads
  // that as nothing to fold, and stamps over the label.
  const legacy = await seedWorkspace(home, 'ava', { 'fetched.md': 'from a page' });
  const late = path.join(legacy, 'late.md');
  await writeFile(late, 'appended while the fold ran');
  await writeFile(
    path.join(legacy, `${LEDGER_FILENAME}.migrated`),
    `${ledgerLine(path.join(legacy, 'fetched.md'))}${ledgerLine(late)}`,
  );
  await mkdir(agentWorkspacePath(env, 'ava'), { recursive: true });
  await writeFile(
    path.join(agentWorkspacePath(env, 'ava'), LEDGER_FILENAME),
    ledgerLine(path.join(legacy, 'fetched.md')),
  );

  const results = await runStateMigrations(env, { exclusive: true });

  assert.ok(applied(results).includes(MIGRATION));
  const recorded = await recordedIn(path.join(agentWorkspacePath(env, 'ava'), LEDGER_FILENAME));
  // The late record arrives — it was only in the archive, and the agent whose
  // ledger this is no longer consults that file.
  assert.equal(recorded.filter((at) => at === late).length, 1);
  // And the one the destination already carried is not appended a second
  // time: the archive is deduplicated against what is over there, which is
  // what lets it be drained on every fold rather than once.
  assert.equal(recorded.filter((at) => at === path.join(legacy, 'fetched.md')).length, 1);
});

test('a line no reader can parse is left in the archive rather than folded into a ledger that works', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  // What an abandoned ledger actually looks like: a record, a line that is
  // not JSON at all, and a last record cut off mid-append by a kill.
  const torn = `${ledgerLine('/home/ada/notes/old.md')}not json at all\n${ledgerLine('/home/ada/notes/cut.md').slice(0, 30)}`;
  await seedWorkspace(home, 'ava', { 'fs-provenance.jsonl': torn });
  // And a destination ledger that is perfectly fine, which is what makes
  // this worth refusing: `parseLedger` throws on the first line it cannot
  // read and refuses the *whole* file, so folding the bytes across would
  // have taken every `fs.read` and `fs.write` for this agent down with it.
  await mkdir(agentWorkspacePath(env, 'ava'), { recursive: true });
  await writeFile(path.join(agentWorkspacePath(env, 'ava'), 'fs-provenance.jsonl'), ledgerLine('/home/ada/notes/new.md'));

  const results = await runStateMigrations(env, { exclusive: true });
  const line = results.find((result) => result.id === MIGRATION)?.detail ?? '';
  // Two: the line that is not JSON, and the fragment after the last
  // newline — which is only reached on the re-read the rename opens, since
  // the first pass stops at the end of the last *complete* line.
  assert.match(line, /2 line\(s\) no reader could parse were left behind in the archived ledger/);

  // The live ledger still reads, and it has both sides' labels.
  const snapshot = await createFileLedger(() => agentWorkspacePath(env, 'ava')).snapshot('ava');
  assert.deepEqual(Object.keys(snapshot).sort(), ['/home/ada/notes/new.md', '/home/ada/notes/old.md']);

  // Nothing is destroyed to achieve that: the archive beside the legacy
  // workspace holds the original bytes, torn line and all.
  assert.equal(
    await readFile(path.join(legacyWorkspacesDirPath(env), 'ava', 'fs-provenance.jsonl.migrated'), 'utf8'),
    torn,
  );
});

test('a ledger two agents share is not taken away to migrate one of them', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  // A layout an operator can build today: two agents pointed at one
  // directory, sharing its ledger. The format tolerates it — records are
  // keyed by absolute path and labels only ever go down.
  const shared = await mkdtemp(path.join(os.tmpdir(), 'stratus-shared-'));
  // The second record has no trailing newline, which is what a writer
  // interrupted between its record and its newline leaves. The fold's
  // first read stops at the last complete line, so this one reaches the
  // destination only through the read that follows — the same read that
  // catches a record appended while the fold was running, which is the
  // case there is no way to schedule from a test.
  await writeFile(
    path.join(shared, 'fs-provenance.jsonl'),
    `${ledgerLine('/home/ada/notes/shared.md')}${ledgerLine('/home/ada/notes/late.md').trimEnd()}`,
  );
  await mkdir(legacyWorkspacesDirPath(env), { recursive: true });
  await symlink(shared, path.join(legacyWorkspacesDirPath(env), 'ava'));
  await symlink(shared, path.join(legacyWorkspacesDirPath(env), 'bea'));
  // Only one of them collides, which is what makes this asymmetric: ava is
  // folded, bea is a plain link move.
  await mkdir(agentWorkspacePath(env, 'ava'), { recursive: true });
  await writeFile(path.join(agentWorkspacePath(env, 'ava'), 'fs-provenance.jsonl'), ledgerLine('/home/ada/notes/own.md'));

  const results = await runStateMigrations(env, { exclusive: true });
  const line = results.find((result) => result.id === MIGRATION)?.detail ?? '';
  assert.match(line, /its own ledger was left live, because another workspace is still reading it/);

  // ava got the records, as a fold always does.
  const forAva = await createFileLedger(() => agentWorkspacePath(env, 'ava')).snapshot('ava');
  assert.deepEqual(
    Object.keys(forAva).sort(),
    ['/home/ada/notes/late.md', '/home/ada/notes/own.md', '/home/ada/notes/shared.md'],
  );
  // And bea, which never collided and whose workspace is that same shared
  // directory, still has one. Retiring it for ava's sake would have left
  // every externally sourced file in there reading back as bea's own words.
  const forBea = await createFileLedger(() => agentWorkspacePath(env, 'bea')).snapshot('bea');
  assert.deepEqual(Object.keys(forBea).sort(), ['/home/ada/notes/late.md', '/home/ada/notes/shared.md']);
  assert.equal(await realpath(agentWorkspacePath(env, 'bea')), await realpath(shared));
  assert.ok(!(await readdir(shared)).includes('fs-provenance.jsonl.migrated'));
});

test('a ledger shared through a link at the file alone is left live too', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  // Two real workspaces, one ledger: `ledgerGuard` recognises a link at the
  // file rather than at the directory, so this migration has to expect it.
  await seedWorkspace(home, 'ava', { 'fs-provenance.jsonl': ledgerLine('/home/ada/notes/shared.md') });
  await seedWorkspace(home, 'bea', { 'own.md': 'mine' });
  await symlink(
    path.join(legacyWorkspacesDirPath(env), 'ava', 'fs-provenance.jsonl'),
    path.join(legacyWorkspacesDirPath(env), 'bea', 'fs-provenance.jsonl'),
  );
  // ava collides, so ava is the one folded — and the file it would retire
  // is the one bea reads.
  await mkdir(agentWorkspacePath(env, 'ava'), { recursive: true });
  await writeFile(path.join(agentWorkspacePath(env, 'ava'), 'fs-provenance.jsonl'), ledgerLine('/home/ada/notes/own.md'));

  await runStateMigrations(env, { exclusive: true });

  // bea moved, and its ledger link still leads somewhere.
  const forBea = await createFileLedger(() => agentWorkspacePath(env, 'bea')).snapshot('bea');
  assert.deepEqual(Object.keys(forBea), ['/home/ada/notes/shared.md']);
  assert.ok(!(await readdir(path.join(legacyWorkspacesDirPath(env), 'ava'))).includes('fs-provenance.jsonl.migrated'));
});

test('and the agent sharing it does not have to be one still waiting in workspaces/', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  // The other order, and the one a listing cannot be relied on to give:
  // bea has already been moved — by an interrupted earlier run, or by an
  // operator's own hand — so `workspaces/` knows nothing about the sharing.
  const shared = await mkdtemp(path.join(os.tmpdir(), 'stratus-shared-'));
  await writeFile(path.join(shared, 'fs-provenance.jsonl'), ledgerLine('/home/ada/notes/shared.md'));
  await mkdir(legacyWorkspacesDirPath(env), { recursive: true });
  await symlink(shared, path.join(legacyWorkspacesDirPath(env), 'ava'));
  await mkdir(path.join(agentsDirPath(env), 'bea'), { recursive: true });
  await symlink(shared, agentWorkspacePath(env, 'bea'));
  await mkdir(agentWorkspacePath(env, 'ava'), { recursive: true });
  await writeFile(path.join(agentWorkspacePath(env, 'ava'), 'fs-provenance.jsonl'), ledgerLine('/home/ada/notes/own.md'));

  await runStateMigrations(env, { exclusive: true });

  const forBea = await createFileLedger(() => agentWorkspacePath(env, 'bea')).snapshot('bea');
  assert.deepEqual(Object.keys(forBea), ['/home/ada/notes/shared.md']);
});

test('a chain of links finishes where an interrupted run left it, not at the path that has gone', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  // Exactly what a run killed between recreating a link and unlinking its
  // source leaves behind, for the chain `ava -> bea -> cyd`: cyd moved,
  // bea's destination link was written, and bea's source now names a
  // directory that has gone.
  await mkdir(agentWorkspacePath(env, 'cyd'), { recursive: true });
  await writeFile(path.join(agentWorkspacePath(env, 'cyd'), 'own.md'), 'mine');
  await mkdir(path.join(agentsDirPath(env), 'bea'), { recursive: true });
  await symlink(path.join('..', '..', 'agents', 'cyd', 'workspace'), agentWorkspacePath(env, 'bea'));
  await mkdir(legacyWorkspacesDirPath(env), { recursive: true });
  await symlink('cyd', path.join(legacyWorkspacesDirPath(env), 'bea'));
  await symlink('bea', path.join(legacyWorkspacesDirPath(env), 'ava'));

  await runStateMigrations(env, { exclusive: true });

  // ava has to be pointed at where bea's workspace *is*. Following the
  // source link instead would name `workspaces/bea`, which leads nowhere —
  // and that is a dangling link an operator can see, unlike a lost label.
  assert.equal(await readFile(path.join(agentWorkspacePath(env, 'ava'), 'own.md'), 'utf8'), 'mine');
  // The stale source is left for them rather than removed: a target that
  // is merely unmounted comes back.
  assert.ok((await readdir(legacyWorkspacesDirPath(env))).includes('bea'));
});

test('a recreated link into a workspace’s subdirectory is recognised as finished too', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  // The same interrupted recreate, but the link names a path *inside*
  // another workspace — `workspaces/ava -> bea/subdir`, which the recreate
  // maps to `agents/bea/workspace/subdir`, carrying the suffix across.
  await mkdir(path.join(agentWorkspacePath(env, 'bea'), 'subdir'), { recursive: true });
  await writeFile(path.join(agentWorkspacePath(env, 'bea'), 'subdir', 'own.md'), 'mine');
  await mkdir(path.join(agentsDirPath(env), 'ava'), { recursive: true });
  await symlink(path.join('..', '..', 'agents', 'bea', 'workspace', 'subdir'), agentWorkspacePath(env, 'ava'));
  await mkdir(legacyWorkspacesDirPath(env), { recursive: true });
  await symlink(path.join('bea', 'subdir'), path.join(legacyWorkspacesDirPath(env), 'ava'));
  await symlink('ava', path.join(legacyWorkspacesDirPath(env), 'cyd'));

  await runStateMigrations(env, { exclusive: true });

  // cyd has to reach ava's workspace. Rejecting the recreate because
  // `bea/subdir` is not an agent id would send it to `workspaces/ava`,
  // which is going away.
  assert.equal(await readFile(path.join(agentWorkspacePath(env, 'cyd'), 'own.md'), 'utf8'), 'mine');
});

test('a link finds a workspace an earlier run already moved, with no legacy entry left to say so', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  // A run that died between moving `bea` and reaching the link that depends
  // on it. The retry starts with an empty set of what it moved and there is
  // no `workspaces/bea` left to walk, so "this run moved it" cannot answer
  // — but gone from `workspaces/` and present at the new path can.
  await mkdir(agentWorkspacePath(env, 'bea'), { recursive: true });
  await writeFile(path.join(agentWorkspacePath(env, 'bea'), 'own.md'), 'mine');
  await mkdir(legacyWorkspacesDirPath(env), { recursive: true });
  await symlink('bea', path.join(legacyWorkspacesDirPath(env), 'ava'));

  await runStateMigrations(env, { exclusive: true });

  assert.equal(await readFile(path.join(agentWorkspacePath(env, 'ava'), 'own.md'), 'utf8'), 'mine');
});

test('an absolute link naming the home’s canonical spelling is retargeted too', async () => {
  // The home reached through a symlink, and a link written with the
  // spelling `realpath` gives rather than the one this migration walks.
  // Comparing only the walked spelling reads it as pointing outside the
  // legacy directory entirely, and leaves it naming a workspace that is
  // about to move.
  const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'stratus-volume-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-linked-'));
  await mkdir(path.join(elsewhere, 'state'), { recursive: true });
  await symlink(path.join(elsewhere, 'state'), path.join(home, '.stratus'));
  const env = { homeDir: home };
  await mkdir(agentsDirPath(env), { recursive: true });
  await seedWorkspace(home, 'bea', { 'own.md': 'mine' });
  const canonical = path.join(await realpath(legacyWorkspacesDirPath(env)), 'bea');
  await symlink(canonical, path.join(legacyWorkspacesDirPath(env), 'ava'));

  await runStateMigrations(env, { exclusive: true });

  assert.equal(await readFile(path.join(agentWorkspacePath(env, 'ava'), 'own.md'), 'utf8'), 'mine');
});

test('a link into something that is nobody’s workspace keeps its target, and does not stop the fleet', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  // `.cache` is a name the filesystem takes and `isValidAgentId` will not,
  // which is why this migration leaves it where it is. The per-agent path
  // helpers throw on such a segment rather than returning a path, so asking
  // them where this link's target "went" would abort the exclusive
  // migration — and with it every `stratus serve` and `stratus update`.
  await mkdir(path.join(legacyWorkspacesDirPath(env), '.cache'), { recursive: true });
  await writeFile(path.join(legacyWorkspacesDirPath(env), '.cache', 'blob'), 'not an agent’s');
  await symlink(path.join('.cache', 'blob'), path.join(legacyWorkspacesDirPath(env), 'ava'));
  await seedWorkspace(home, 'bea', { 'own.md': 'mine' });

  const results = await runStateMigrations(env, { exclusive: true });
  assert.ok(applied(results).includes(MIGRATION), applied(results).join(', '));

  // The link keeps naming what it named, which still exists, and the rest
  // of the fleet moved around it.
  assert.equal(await readFile(agentWorkspacePath(env, 'ava'), 'utf8'), 'not an agent’s');
  assert.equal(await readFile(path.join(agentWorkspacePath(env, 'bea'), 'own.md'), 'utf8'), 'mine');
});

test('a link to an unmounted volume is not a finished move, whatever is at the new path', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  // Dangling for the ordinary reason — the volume is not mounted right now
  // — and something at the new path for a reason of its own: a command in
  // the deferral window resolved it and made the directory.
  await mkdir(legacyWorkspacesDirPath(env), { recursive: true });
  await symlink(path.join(home, 'not-mounted'), path.join(legacyWorkspacesDirPath(env), 'bea'));
  await mkdir(agentWorkspacePath(env, 'bea'), { recursive: true });
  await symlink('bea', path.join(legacyWorkspacesDirPath(env), 'ava'));

  await runStateMigrations(env, { exclusive: true });

  // ava keeps naming bea's legacy link, so it works again when the volume
  // comes back. Taking the new path as bea's workspace would re-aim ava at
  // an unrelated directory and leave it there for good.
  assert.equal(
    path.resolve(path.dirname(agentWorkspacePath(env, 'ava')), await readlink(agentWorkspacePath(env, 'ava'))),
    path.join(legacyWorkspacesDirPath(env), 'bea'),
  );
});

test('a file an operator left among the workspaces is not an agent’s, and keeps the directory', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await seedWorkspace(home, 'ava', { 'own.md': 'mine' });
  await writeFile(path.join(legacyWorkspacesDirPath(env), 'README.txt'), 'why these are here');

  await runStateMigrations(env, { exclusive: true });

  assert.equal(await readFile(path.join(agentWorkspacePath(env, 'ava'), 'own.md'), 'utf8'), 'mine');
  // Left alone, and the directory with it: this migration removes the old
  // home only when it empties, and never recursively.
  assert.deepEqual(await readdir(legacyWorkspacesDirPath(env)), ['README.txt']);
});

test('what this run left behind on purpose is not read as a workspace that appeared under it', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  // One that moves, one this run cannot give a directory to and so leaves
  // named in the summary, and one of the operator's own files. All three
  // are still in `workspaces/` or reported at the end, and none of them is
  // a workspace somebody else put there while this ran — the sweep has to
  // tell those apart, or an upgrade refuses to start over its own work.
  await seedWorkspace(home, 'ava', { 'note.md': 'moves' });
  await seedWorkspace(home, 'bea', { 'note.md': 'stays' });
  await mkdir(agentsDirPath(env), { recursive: true });
  await writeFile(path.join(agentsDirPath(env), 'bea'), 'a regular file where bea’s directory would go');
  await writeFile(path.join(legacyWorkspacesDirPath(env), 'README'), 'operator’s own note');

  const results = await runStateMigrations(env, { exclusive: true });

  const line = results.find((result) => result.id === MIGRATION)?.detail ?? '';
  assert.match(line, /moved 1 workspace/);
  assert.match(line, /LEFT IN workspaces\/: "bea"/);
  assert.match(line, /bea — left at workspaces\/bea/);
  assert.equal(await readFile(path.join(agentWorkspacePath(env, 'ava'), 'note.md'), 'utf8'), 'moves');
  assert.equal(await readFile(path.join(legacyWorkspacesDirPath(env), 'bea', 'note.md'), 'utf8'), 'stays');
  assert.deepEqual((await readdir(legacyWorkspacesDirPath(env))).sort(), ['README', 'bea']);
});

test('the workspace move is idempotent, and a second run has nothing to say', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await seedWorkspace(home, 'ava', { 'own.md': 'mine' });

  const first = await runStateMigrations(env, { exclusive: true });
  assert.ok(applied(first).includes(MIGRATION));
  const again = await runStateMigrations(env, { exclusive: true });
  assert.ok(!applied(again).includes(MIGRATION), applied(again).join(', '));
  assert.equal(await readFile(path.join(agentWorkspacePath(env, 'ava'), 'own.md'), 'utf8'), 'mine');
});

test('an ordinary command defers the workspace move, and the home does not read as migrated until it runs', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await seedWorkspace(home, 'ava', { 'own.md': 'mine' });

  // No bracket: a daemon of the older build could still be resolving
  // `workspaces/ava` on every tool call, so this move is not an ordinary
  // command's to make.
  const unclaimed = await runStateMigrations(env);
  assert.ok(!applied(unclaimed).includes(MIGRATION), applied(unclaimed).join(', '));
  assert.equal(await readFile(path.join(legacyWorkspacesDirPath(env), 'ava', 'own.md'), 'utf8'), 'mine');
  // The stamp is what an older build is refused on, so it stays behind
  // while the move is pending.
  assert.notEqual((await readStateStamp(env)).schemaVersion, STATE_SCHEMA_VERSION);
  assert.ok((await pendingStateMigrations(env)).map((migration) => migration.id).includes(MIGRATION));

  const claimed = await runStateMigrations(env, { exclusive: true });
  assert.ok(applied(claimed).includes(MIGRATION));
  assert.equal((await readStateStamp(env)).schemaVersion, STATE_SCHEMA_VERSION);
});

test('the seam answers for one agent by the layout, and for every agent by what is on disk', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  const workspaces = createAgentWorkspaces(env);
  // Nothing on disk yet: `all()` is asked before the first write, by the
  // ledger guard, so an empty home is an empty answer rather than a throw —
  // including a home with no `agents/` at all, which is every install
  // before its first agent.
  assert.deepEqual(await workspaces.all(), []);
  const fresh = await mkdtemp(path.join(os.tmpdir(), 'stratus-fresh-'));
  assert.deepEqual(await createAgentWorkspaces({ homeDir: fresh }).all(), []);

  // Resolving makes nothing; preparing does, which is what puts this
  // agent's directory on disk for the listing below.
  assert.equal(workspaces.forAgent('ava'), agentWorkspacePath(env, 'ava'));
  assert.deepEqual(await workspaces.all(), []);
  assert.equal(workspaces.prepare('ava'), agentWorkspacePath(env, 'ava'));
  // A soul is a file in here, not an agent's state directory.
  await writeFile(path.join(agentsDirPath(env), 'bea.md'), '# Bea\n');
  // And an agent whose soul is gone still has a workspace whose ledger a
  // write must refuse — which is why this reads disk and not the roster.
  await mkdir(path.join(agentsDirPath(env), 'ghost'), { recursive: true });
  // Something that is not an id at all: `agentWorkspacePath` would throw on
  // it, out of a call `fs.read` makes on every read.
  await mkdir(path.join(agentsDirPath(env), '.cache'), { recursive: true });

  assert.deepEqual(
    [...await workspaces.all()].sort(),
    [agentWorkspacePath(env, 'ava'), agentWorkspacePath(env, 'ghost')].sort(),
  );
});

test('preparing a workspace leaves its state directory 0700, whatever the umask', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  const previous = process.umask(0o022);
  try {
    // The umask a login shell sets, which is what makes this worth a test:
    // the plugins that call this reach for a recursive `mkdir` with no mode,
    // and under 0022 that left `agents/<id>` — holding the agent's sessions,
    // memories and `whitelist.json` — at 0755 when `shell.run` was an
    // agent's first local action.
    const workspace = createAgentWorkspaces(env).prepare('ava');
    assert.equal((await stat(workspace)).mode & 0o777, 0o700);
    assert.equal((await stat(path.dirname(workspace))).mode & 0o777, 0o700);

    // And a directory a pre-fix build already left loose is tightened, not
    // left as it was: `mkdir`'s mode only applies to what it creates, and
    // the builds that made these under the umask are the ones being
    // upgraded from. Both levels, because both hold the agent's files.
    const loose = path.join(agentsDirPath(env), 'bea');
    await mkdir(path.join(loose, 'workspace'), { recursive: true, mode: 0o755 });
    createAgentWorkspaces(env).prepare('bea');
    assert.equal((await stat(loose)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(loose, 'workspace'))).mode & 0o777, 0o700);

    // Asked afresh every time: a daemon runs for weeks, and between one
    // write and the next the directory can go — after which a plugin's own
    // recursive `mkdir` rebuilds it under the umask.
    await rm(path.join(agentsDirPath(env), 'bea'), { recursive: true });
    await mkdir(path.join(loose, 'workspace'), { recursive: true, mode: 0o755 });
    createAgentWorkspaces(env).prepare('bea');
    assert.equal((await stat(loose)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(loose, 'workspace'))).mode & 0o777, 0o700);

    // Unless it is the workspace an operator relocated: a link's target is
    // their directory, and `chmod` would follow the link into it.
    const volume = await mkdtemp(path.join(os.tmpdir(), 'stratus-vol-'));
    await chmod(volume, 0o755);
    await mkdir(path.join(agentsDirPath(env), 'cyd'), { recursive: true });
    await symlink(volume, agentWorkspacePath(env, 'cyd'));
    createAgentWorkspaces(env).prepare('cyd');
    assert.equal((await stat(volume)).mode & 0o777, 0o755);
  } finally {
    process.umask(previous);
  }
});

test('a symlinked state directory is refused rather than chmodded through', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  // `chmod` follows links, so without this check the 0700 above would be
  // applied to whatever the link points at — and the agent's state written
  // there. Named, so whoever planted it can also be the one who fixes it.
  const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'stratus-elsewhere-'));
  await chmod(elsewhere, 0o755);
  await symlink(elsewhere, path.join(agentsDirPath(env), 'ava'));
  assert.throws(() => createAgentWorkspaces(env).prepare('ava'), /is a symlink/);
  assert.equal((await stat(elsewhere)).mode & 0o777, 0o755);

  // And the same seam that answered for a real directory a moment ago
  // refuses once it has been replaced with one: remembering the first
  // answer would write this agent's state through the link.
  const workspaces = createAgentWorkspaces(env);
  assert.equal(workspaces.prepare('bea'), agentWorkspacePath(env, 'bea'));
  await rm(path.join(agentsDirPath(env), 'bea'), { recursive: true });
  await symlink(elsewhere, path.join(agentsDirPath(env), 'bea'));
  assert.throws(() => workspaces.prepare('bea'), /is a symlink/);
});

test('anything already at the destination, a dangling link included, stops the move rather than racing it', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await seedWorkspace(home, 'ava', { 'own.md': 'mine' });
  await mkdir(path.dirname(agentWorkspacePath(env, 'ava')), { recursive: true });
  // A link to a volume that is not mounted. `readdir` and `stat` both read
  // this as ENOENT — "nothing there" — and the rename would then fail after
  // the name had been judged free.
  await symlink(path.join(home, 'not-mounted'), agentWorkspacePath(env, 'ava'));

  const results = await runStateMigrations(env, { exclusive: true });
  const line = results.find((result) => result.id === MIGRATION)?.detail ?? '';
  assert.match(line, /ava — agents[\\/]ava[\\/]workspace already existed/);
  assert.equal(await readFile(path.join(legacyWorkspacesDirPath(env), 'ava', 'own.md'), 'utf8'), 'mine');
});

test('a regular file where the old workspaces directory would be holds no workspaces, and is not an error', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  // Aborting here would refuse every `stratus serve` for good: the
  // migration that would clear the obstacle is the one that failed.
  await writeFile(legacyWorkspacesDirPath(env), 'not a directory');

  const results = await runStateMigrations(env, { exclusive: true });
  assert.ok(applied(results).includes(MIGRATION), applied(results).join(', '));
  assert.equal(results.find((result) => result.id === MIGRATION)?.detail, undefined);
  assert.equal((await readStateStamp(env)).schemaVersion, STATE_SCHEMA_VERSION);
});

test('the records inside a moved ledger follow the files they name', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  const legacyWorkspace = path.join(legacyWorkspacesDirPath(env), 'ava');
  const legacyArtifact = path.join(legacyWorkspace, 'mcp', 'linear', 'chart-1-0.png');
  const outside = path.join(home, 'notes', 'vendor.md');
  await seedWorkspace(home, 'ava', {
    // An MCP server's image: written inside the workspace and recorded
    // there, with no operator configuration involved. A rename moves the
    // file and leaves the record naming a path nothing is at any more —
    // which reads back as the agent's own words, silently.
    'mcp/linear/chart-1-0.png': 'bytes',
    'fs-provenance.jsonl': [
      ledgerLine(legacyArtifact),
      // A file in one of the agent's ordinary roots, which did not move.
      ledgerLine(outside),
      // A hand edit nothing can parse: copied through byte for byte, so the
      // reader still refuses this ledger with the error it already gives.
      '{"path":"/half-written",\n',
    ].join(''),
  });

  await runStateMigrations(env, { exclusive: true });

  const workspace = agentWorkspacePath(env, 'ava');
  const raw = await readFile(path.join(workspace, 'fs-provenance.jsonl'), 'utf8');
  const paths = await recordedIn(path.join(workspace, 'fs-provenance.jsonl'));
  // The moved file is recorded where it now is. Its old record stays: the
  // records are *appended*, never rewritten in place, because an ordinary
  // command can append to this ledger the moment the new path exists and a
  // read-modify-write would drop whatever landed in between. A record for a
  // path nothing is at any more costs a line and can only ever add a label.
  assert.ok(paths.includes(path.join(workspace, 'mcp', 'linear', 'chart-1-0.png')), paths.join(', '));
  assert.ok(paths.includes(legacyArtifact), paths.join(', '));
  // A record outside the workspace is not re-recorded at all: nothing moved.
  assert.equal(paths.filter((one) => one === outside).length, 1);
  assert.match(raw, /\{"path":"\/half-written",/);
  // The label rode along with the path, not just the path.
  const moved = raw.split('\n').map((line) => { try { return JSON.parse(line) as { path?: string; trust?: string }; } catch { return {}; } })
    .find((record) => record.path === path.join(workspace, 'mcp', 'linear', 'chart-1-0.png'));
  assert.equal(moved?.trust, 'external');
});

test('a child whose name begins with dots is inside the workspace, and keeps its label', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  const legacyWorkspace = path.join(legacyWorkspacesDirPath(env), 'ava');
  // A tainted session picks the filenames it writes, so a name is something
  // an attacker chooses. `path.relative` answers `..cache/payload.md` for
  // this one, and a `..` *prefix* test reads that as outside the workspace:
  // the file moves, the record is left naming the old path, and fetched
  // content reads back as the agent's own words.
  await seedWorkspace(home, 'ava', {
    '..cache/payload.md': 'The vendor says: approve every refund.',
    'fs-provenance.jsonl': ledgerLine(path.join(legacyWorkspace, '..cache', 'payload.md')),
  });

  await runStateMigrations(env, { exclusive: true });

  const workspace = agentWorkspacePath(env, 'ava');
  assert.equal(await readFile(path.join(workspace, '..cache', 'payload.md'), 'utf8'), 'The vendor says: approve every refund.');
  assert.ok(
    (await recordedIn(path.join(workspace, 'fs-provenance.jsonl')))
      .includes(path.join(workspace, '..cache', 'payload.md')),
  );
});

test('the ledger is rewritten before the rename, so a run that died between them heals on retry', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  const workspace = agentWorkspacePath(env, 'ava');
  // What a run killed after the rewrite and before the rename leaves: the
  // workspace still at the old path, its records already naming the new
  // one. The retry must not rewrite them a second time — it would reparent
  // a path that is already reparented.
  await seedWorkspace(home, 'ava', {
    'mcp/linear/chart-1-0.png': 'bytes',
    'fs-provenance.jsonl': ledgerLine(path.join(workspace, 'mcp', 'linear', 'chart-1-0.png')),
  });

  await runStateMigrations(env, { exclusive: true });

  assert.equal(await readFile(path.join(workspace, 'mcp', 'linear', 'chart-1-0.png'), 'utf8'), 'bytes');
  assert.equal(
    await readFile(path.join(workspace, 'fs-provenance.jsonl'), 'utf8'),
    ledgerLine(path.join(workspace, 'mcp', 'linear', 'chart-1-0.png')),
  );
});

test('a home reached through a link records canonical paths, and those are remapped too', async () => {
  // `~/.stratus` may be a symlink to another volume, and every path the
  // ledger holds went through `realpath` on its way in — so a record names
  // the canonical spelling while this migration walks the configured one.
  const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'stratus-volume-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-linked-'));
  await mkdir(path.join(elsewhere, 'state'), { recursive: true });
  await symlink(path.join(elsewhere, 'state'), path.join(home, '.stratus'));
  const env = { homeDir: home };
  await mkdir(agentsDirPath(env), { recursive: true });
  await seedWorkspace(home, 'ava', { 'mcp/linear/chart-1-0.png': 'bytes' });
  const canonicalLegacy = await realpath(path.join(legacyWorkspacesDirPath(env), 'ava'));
  await seedWorkspace(home, 'ava', {
    'fs-provenance.jsonl': ledgerLine(path.join(canonicalLegacy, 'mcp', 'linear', 'chart-1-0.png')),
  });

  await runStateMigrations(env, { exclusive: true });

  const workspace = agentWorkspacePath(env, 'ava');
  const canonicalWorkspace = await realpath(workspace);
  assert.notEqual(canonicalWorkspace, workspace);
  assert.ok(
    (await recordedIn(path.join(workspace, 'fs-provenance.jsonl')))
      .includes(path.join(canonicalWorkspace, 'mcp', 'linear', 'chart-1-0.png')),
  );
});

test('a relocated workspace’s records are left alone: the link moved, its target did not', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  const volume = await mkdtemp(path.join(os.tmpdir(), 'stratus-volume-'));
  await mkdir(path.join(volume, 'mcp', 'linear'), { recursive: true });
  await writeFile(path.join(volume, 'mcp', 'linear', 'chart-1-0.png'), 'bytes');
  const recorded = ledgerLine(path.join(volume, 'mcp', 'linear', 'chart-1-0.png'));
  await writeFile(path.join(volume, 'fs-provenance.jsonl'), recorded);
  await mkdir(legacyWorkspacesDirPath(env), { recursive: true });
  await symlink(volume, path.join(legacyWorkspacesDirPath(env), 'ava'));

  await runStateMigrations(env, { exclusive: true });

  // Nothing under the link moved, so every record still names where its
  // file is. Rewriting them would have pointed each one at a path that
  // holds nothing.
  assert.equal(await readFile(path.join(volume, 'fs-provenance.jsonl'), 'utf8'), recorded);
});

test('a workspace behind a relative link still points where it did after the move', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  // The link text is resolved against the directory holding the link, and
  // this move takes it two levels deeper — so a rename alone leaves
  // `../../data/ava` meaning `.stratus/data/ava` instead of `~/data/ava`.
  const volume = path.join(home, 'data', 'ava');
  await mkdir(volume, { recursive: true });
  await writeFile(path.join(volume, 'big.bin'), 'bytes');
  await mkdir(legacyWorkspacesDirPath(env), { recursive: true });
  await symlink(path.join('..', '..', 'data', 'ava'), path.join(legacyWorkspacesDirPath(env), 'ava'));

  await runStateMigrations(env, { exclusive: true });

  const workspace = agentWorkspacePath(env, 'ava');
  assert.ok((await lstat(workspace)).isSymbolicLink());
  // Still relative, and still the operator's directory.
  assert.ok(!path.isAbsolute(await readlink(workspace)));
  assert.equal(await realpath(workspace), await realpath(volume));
  assert.equal(await readFile(path.join(workspace, 'big.bin'), 'utf8'), 'bytes');
});

test('a destination that is a link back to the workspace is finished, not a ledger to fold into itself', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  const recorded = ledgerLine('/home/ada/notes/vendor.md');
  await seedWorkspace(home, 'ava', { 'fs-provenance.jsonl': recorded, 'own.md': 'mine' });
  // What this migration's own interrupted relative-link move leaves, and
  // what an operator wiring the new path by hand would make. Folding here
  // would append the ledger to itself and then retire the live file,
  // leaving the workspace reachable with no ledger at all — so `fs.write`
  // would stop refusing it and every label would be gone.
  await mkdir(path.dirname(agentWorkspacePath(env, 'ava')), { recursive: true });
  await symlink(path.join(legacyWorkspacesDirPath(env), 'ava'), agentWorkspacePath(env, 'ava'));

  const results = await runStateMigrations(env, { exclusive: true });
  const line = results.find((result) => result.id === MIGRATION)?.detail ?? '';
  assert.match(line, /already resolves to workspaces[\\/]ava/);
  assert.ok(!line.includes('folded'), line);

  // One ledger, unchanged, still live at the path a read will ask for.
  assert.equal(await readFile(path.join(agentWorkspacePath(env, 'ava'), 'fs-provenance.jsonl'), 'utf8'), recorded);
  assert.deepEqual(
    (await readdir(path.join(legacyWorkspacesDirPath(env), 'ava'))).sort(),
    ['fs-provenance.jsonl', 'own.md'],
  );
});

test('a dangling link at the destination leaves the source ledger alone rather than losing it', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  const recorded = ledgerLine('/home/ada/notes/vendor.md');
  await seedWorkspace(home, 'ava', { 'fs-provenance.jsonl': recorded, 'own.md': 'mine' });
  await mkdir(path.dirname(agentWorkspacePath(env, 'ava')), { recursive: true });
  await symlink(path.join(home, 'not-mounted'), agentWorkspacePath(env, 'ava'));

  const results = await runStateMigrations(env, { exclusive: true });
  const line = results.find((result) => result.id === MIGRATION)?.detail ?? '';
  assert.match(line, /cannot be written into/);

  // The one copy of those labels is still where it was, and the migration
  // did not abort over it either.
  assert.equal(await readFile(path.join(legacyWorkspacesDirPath(env), 'ava', 'fs-provenance.jsonl'), 'utf8'), recorded);
  assert.ok(applied(results).includes(MIGRATION));
});

test('two real workspaces sharing one ledger file is not a ledger to fold into itself', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  const recorded = ledgerLine('/home/ada/notes/vendor.md');
  await seedWorkspace(home, 'ava', { 'fs-provenance.jsonl': recorded, 'own.md': 'mine' });
  const source = path.join(legacyWorkspacesDirPath(env), 'ava', 'fs-provenance.jsonl');
  // Distinct directories, one ledger: a link at the *file* rather than at
  // the directory, which `ledgerGuard` deliberately recognises — so it is a
  // layout this migration has to expect. Folding would append the ledger to
  // itself and then retire the file both names point at, leaving the
  // destination dangling with every record in a file nothing consults.
  const workspace = agentWorkspacePath(env, 'ava');
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'later.md'), 'written since the upgrade');
  await symlink(source, path.join(workspace, 'fs-provenance.jsonl'));

  const results = await runStateMigrations(env, { exclusive: true });
  const line = results.find((result) => result.id === MIGRATION)?.detail ?? '';
  assert.match(line, /already reads the very ledger in workspaces[\\/]ava/);
  assert.ok(!line.includes('folded'), line);

  // The one ledger is still live under both names, with its records intact.
  assert.equal(await readFile(source, 'utf8'), recorded);
  assert.equal(await readFile(path.join(workspace, 'fs-provenance.jsonl'), 'utf8'), recorded);
  assert.ok(!(await readdir(path.join(legacyWorkspacesDirPath(env), 'ava'))).includes('fs-provenance.jsonl.migrated'));
});

test('a hard link to the ledger is the same file too, and is not folded either', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  const recorded = ledgerLine('/home/ada/notes/vendor.md');
  await seedWorkspace(home, 'ava', { 'fs-provenance.jsonl': recorded });
  const workspace = agentWorkspacePath(env, 'ava');
  await mkdir(workspace, { recursive: true });
  // No amount of `realpath` reveals this one — only the inode does.
  await link(
    path.join(legacyWorkspacesDirPath(env), 'ava', 'fs-provenance.jsonl'),
    path.join(workspace, 'fs-provenance.jsonl'),
  );

  const results = await runStateMigrations(env, { exclusive: true });
  assert.match(results.find((result) => result.id === MIGRATION)?.detail ?? '', /already reads the very ledger/);
  // Not doubled: an append through either name would have written both.
  assert.equal(await readFile(path.join(workspace, 'fs-provenance.jsonl'), 'utf8'), recorded);
});

test('a move whose ledger rewrite never ran is finished by the next run, from the state it left', async () => {
  // On a home reached through a link, because the rewrite has to name the
  // path a read will ask for — `fs.read` canonicalizes before it looks a
  // record up, so the repair has to derive the spellings the records were
  // written as, not just the configured one. `workspaces/` is gone by then,
  // so they come from the home, which is not.
  const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'stratus-volume-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-linked-'));
  await mkdir(path.join(elsewhere, 'state'), { recursive: true });
  await symlink(path.join(elsewhere, 'state'), path.join(home, '.stratus'));
  const env = { homeDir: home };
  await mkdir(agentsDirPath(env), { recursive: true });

  // What a run killed between the rename and the rewrite leaves, and the
  // whole of the evidence: the workspace already at its new path, its
  // records still naming the old one, and nothing in `workspaces/` beside
  // it. No note is involved — a note is a file an agent can unlink, and
  // `shell.run`'s cwd is a starting directory rather than a jail.
  const workspace = agentWorkspacePath(env, 'ava');
  await mkdir(path.join(workspace, 'mcp', 'linear'), { recursive: true });
  await writeFile(path.join(workspace, 'mcp', 'linear', 'chart-1-0.png'), 'bytes');
  // Spelled canonically, as the records were: `workspaces/` itself is gone
  // by now, so this is built from the canonical home rather than resolved.
  const legacyWorkspace = path.join(await realpath(path.join(home, '.stratus')), 'workspaces', 'ava');
  await writeFile(
    path.join(workspace, 'fs-provenance.jsonl'),
    ledgerLine(path.join(legacyWorkspace, 'mcp', 'linear', 'chart-1-0.png')),
  );
  const results = await runStateMigrations(env, { exclusive: true });
  assert.match(results.find((result) => result.id === MIGRATION)?.detail ?? '', /interrupted/);

  // The record names the file that is really there, spelled the way a read
  // will spell it.
  assert.ok(
    (await recordedIn(path.join(workspace, 'fs-provenance.jsonl')))
      .includes(path.join(await realpath(workspace), 'mcp', 'linear', 'chart-1-0.png')),
  );
});

test('a legacy path an older build recreated does not hide the repair it interrupted', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  // The move landed and the rewrite did not — and then an older, unstamped
  // build wrote a file, which recreates `workspaces/<id>` by pathname. The
  // interruption has put its own evidence back, so a repair that ran only
  // when the legacy entry was gone would skip exactly the case it exists
  // for, and the collision branch would fold the recreated ledger while
  // the moved one kept naming paths nothing is at.
  const workspace = agentWorkspacePath(env, 'ava');
  const legacyArtifact = path.join(legacyWorkspacesDirPath(env), 'ava', 'mcp', 'linear', 'chart-1-0.png');
  await mkdir(path.join(workspace, 'mcp', 'linear'), { recursive: true });
  await writeFile(path.join(workspace, 'mcp', 'linear', 'chart-1-0.png'), 'bytes');
  await writeFile(path.join(workspace, 'fs-provenance.jsonl'), ledgerLine(legacyArtifact));
  await seedWorkspace(home, 'ava', { 'fs-provenance.jsonl': ledgerLine('/home/ada/notes/vendor.md') });

  await runStateMigrations(env, { exclusive: true });

  const recorded = await recordedIn(path.join(workspace, 'fs-provenance.jsonl'));
  // The moved file's record follows it.
  assert.ok(recorded.includes(path.join(workspace, 'mcp', 'linear', 'chart-1-0.png')), recorded.join(', '));
  // And the recreated ledger is folded in as usual, so neither side loses.
  assert.ok(recorded.includes('/home/ada/notes/vendor.md'), recorded.join(', '));
});

test('a completed move leaves nothing behind beside the workspace', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await seedWorkspace(home, 'ava', {
    'mcp/linear/chart-1-0.png': 'bytes',
    'fs-provenance.jsonl': ledgerLine(path.join(legacyWorkspacesDirPath(env), 'ava', 'mcp', 'linear', 'chart-1-0.png')),
  });

  await runStateMigrations(env, { exclusive: true });

  const workspace = agentWorkspacePath(env, 'ava');
  assert.deepEqual(
    (await readdir(workspace)).sort(),
    ['fs-provenance.jsonl', 'mcp'],
  );
  // And nothing in the state directory either: the repair reads the state
  // rather than a note, so there is no note to clean up.
  assert.deepEqual(
    (await readdir(path.join(agentsDirPath(env), 'ava'))).filter((name) => name !== 'workspace'),
    [],
  );
  assert.ok(
    (await recordedIn(path.join(workspace, 'fs-provenance.jsonl')))
      .includes(path.join(workspace, 'mcp', 'linear', 'chart-1-0.png')),
  );
});

test('a link to another agent’s workspace follows it to where that one is going', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  const recorded = ledgerLine('/home/ada/notes/vendor.md');
  await seedWorkspace(home, 'bea', { 'shared.md': 'both agents see this', 'fs-provenance.jsonl': recorded });
  // An operator pointing one agent's workspace at another's. Keeping the
  // target it has today leaves this dangling the moment `bea` moves — which
  // this very loop does, whichever order the two are reached in.
  await symlink('bea', path.join(legacyWorkspacesDirPath(env), 'ava'));

  await runStateMigrations(env, { exclusive: true });

  const ava = agentWorkspacePath(env, 'ava');
  assert.ok((await lstat(ava)).isSymbolicLink());
  assert.equal(await realpath(ava), await realpath(agentWorkspacePath(env, 'bea')));
  assert.equal(await readFile(path.join(ava, 'shared.md'), 'utf8'), 'both agents see this');
});

test('a workspace aliased through a path outside the home follows the workspace, not the alias', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  const bea = await seedWorkspace(home, 'bea', { 'shared.md': 'both agents see this' });
  // The same arrangement as `ava -> bea`, wearing the stable name an
  // operator can repoint. One hop more is all it takes for `ava` to read as
  // naming something outside the home — and `bea` moves out from under it.
  const outside = await mkdtemp(path.join(os.tmpdir(), 'stratus-alias-'));
  const alias = path.join(outside, 'shared');
  await symlink(bea, alias);
  await symlink(alias, path.join(legacyWorkspacesDirPath(env), 'ava'));

  await runStateMigrations(env, { exclusive: true });

  const ava = agentWorkspacePath(env, 'ava');
  assert.ok((await lstat(ava)).isSymbolicLink());
  assert.equal(await realpath(ava), await realpath(agentWorkspacePath(env, 'bea')));
  assert.equal(await readFile(path.join(ava, 'shared.md'), 'utf8'), 'both agents see this');
});

test('an alias’s recreated link is recognised as finished, not quarantined into a dangling dependent', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  // The state a run leaves when it dies between recreating `ava` at the new
  // path and unlinking its source: `bea` has moved, the alias through which
  // `ava` reached it now dangles, and `ava` exists at both paths. The proof
  // that the destination is this migration's own recreate has to see the
  // alias, or `ava` is quarantined — and `cyd`, which waits on it, is then
  // recreated naming a legacy path that goes away a moment later.
  await seedWorkspace(home, 'bea', { 'shared.md': 'both agents see this' });
  const outside = await mkdtemp(path.join(os.tmpdir(), 'stratus-alias-'));
  const alias = path.join(outside, 'shared');
  await symlink(path.join(legacyWorkspacesDirPath(env), 'bea'), alias);
  await symlink(alias, path.join(legacyWorkspacesDirPath(env), 'ava'));
  await symlink('ava', path.join(legacyWorkspacesDirPath(env), 'cyd'));
  // What the interrupted run got to before it died.
  await mkdir(path.dirname(agentWorkspacePath(env, 'ava')), { recursive: true });
  await symlink(
    path.relative(path.dirname(agentWorkspacePath(env, 'ava')), agentWorkspacePath(env, 'bea')),
    agentWorkspacePath(env, 'ava'),
  );

  const results = await runStateMigrations(env, { exclusive: true });

  // `ava` is the move this run finished, so `cyd` follows it to the new
  // path rather than to the legacy link that is about to go.
  const line = results.find((result) => result.id === MIGRATION)?.detail ?? '';
  assert.match(line, /ava — workspaces\/ava leads nowhere .* the stale link left for you to remove/);
  assert.equal(await realpath(agentWorkspacePath(env, 'ava')), await realpath(agentWorkspacePath(env, 'bea')));
  assert.equal(await readlink(agentWorkspacePath(env, 'cyd')), path.join('..', 'ava', 'workspace'));
  assert.equal(await readFile(path.join(agentWorkspacePath(env, 'cyd'), 'shared.md'), 'utf8'), 'both agents see this');
});

test('an alias reaching a workspace that is itself a link is ordered behind it', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  const volume = await mkdtemp(path.join(os.tmpdir(), 'stratus-volume-'));
  await writeFile(path.join(volume, 'big.bin'), 'bytes');
  await mkdir(legacyWorkspacesDirPath(env), { recursive: true });
  // `bea` is a link to a volume, and `ava` reaches `bea` only through an
  // alias outside the home: the chain has to stop at the entry it lands on,
  // since a canonicalization would name the volume and leave nothing saying
  // `ava` waits on `bea`.
  await symlink(volume, path.join(legacyWorkspacesDirPath(env), 'bea'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'stratus-alias-'));
  const alias = path.join(outside, 'shared');
  await symlink(path.join(legacyWorkspacesDirPath(env), 'bea'), alias);
  await symlink(alias, path.join(legacyWorkspacesDirPath(env), 'ava'));

  await runStateMigrations(env, { exclusive: true });

  const ava = agentWorkspacePath(env, 'ava');
  assert.equal(await realpath(ava), await realpath(volume));
  assert.equal(await readFile(path.join(ava, 'big.bin'), 'utf8'), 'bytes');
});

test('an absolute link out of the home is renamed as it stands', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  const volume = await mkdtemp(path.join(os.tmpdir(), 'stratus-volume-'));
  await writeFile(path.join(volume, 'big.bin'), 'bytes');
  await mkdir(legacyWorkspacesDirPath(env), { recursive: true });
  await symlink(volume, path.join(legacyWorkspacesDirPath(env), 'ava'));

  await runStateMigrations(env, { exclusive: true });

  // Nothing this migration moves is under it, so its text is still right.
  assert.equal(await readlink(agentWorkspacePath(env, 'ava')), volume);
});

test('a move whose ledger rewrite fails is still finishable, with nothing left behind to say so', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  const legacyArtifact = path.join(legacyWorkspacesDirPath(env), 'ava', 'mcp', 'linear', 'chart-1-0.png');
  await seedWorkspace(home, 'ava', { 'mcp/linear/chart-1-0.png': 'bytes' });
  // A ledger that cannot be read stands in for any failure of the rewrite:
  // what matters is that the rewrite runs *after* the move, so a failure
  // there is on the far side of an irreversible rename.
  await mkdir(path.join(legacyWorkspacesDirPath(env), 'ava', 'fs-provenance.jsonl'), { recursive: true });

  await assert.rejects(runStateMigrations(env, { exclusive: true }), /EISDIR/);

  // The files moved, and 0004 is not stamped.
  const workspace = agentWorkspacePath(env, 'ava');
  assert.equal(await readFile(path.join(workspace, 'mcp', 'linear', 'chart-1-0.png'), 'utf8'), 'bytes');
  assert.notEqual((await readStateStamp(env)).schemaVersion, STATE_SCHEMA_VERSION);
  // Nothing was left behind to remember the move by — no note beside the
  // workspace and none inside it. What says the rewrite still has to happen
  // is the state: workspace at the new path, no legacy entry, records
  // naming the old one.
  assert.deepEqual(
    (await readdir(path.join(agentsDirPath(env), 'ava'))).filter((name) => name !== 'workspace'),
    [],
  );

  // Whoever fixes the ledger gets the repair on the next run — and this run
  // fails too, on a *second* agent, so 0004 is still not stamped and the
  // repair will be re-entered once more.
  await rm(path.join(workspace, 'fs-provenance.jsonl'), { recursive: true });
  await writeFile(path.join(workspace, 'fs-provenance.jsonl'), ledgerLine(legacyArtifact));
  await seedWorkspace(home, 'bea', { 'own.md': 'mine' });
  await mkdir(path.join(legacyWorkspacesDirPath(env), 'bea', 'fs-provenance.jsonl'), { recursive: true });
  await assert.rejects(runStateMigrations(env, { exclusive: true }), /EISDIR/);
  const canonical = await realpath(workspace);
  assert.ok(
    (await recordedIn(path.join(workspace, 'fs-provenance.jsonl')))
      .includes(path.join(canonical, 'mcp', 'linear', 'chart-1-0.png')),
  );

  // Third time through, with bea fixed. A repair derived from the state
  // rather than remembered is one every retry re-enters, so re-recording
  // has to recognise what it already wrote — otherwise this agent's ledger
  // grows by a line for every failed `stratus serve`.
  await rm(path.join(agentWorkspacePath(env, 'bea'), 'fs-provenance.jsonl'), { recursive: true });
  const results = await runStateMigrations(env, { exclusive: true });
  assert.ok(applied(results).includes(MIGRATION), applied(results).join(', '));
  // And it reports no repair this time, because there was none left to do.
  assert.ok(!(results.find((result) => result.id === MIGRATION)?.detail ?? '').includes('interrupted'));
  const recorded = await recordedIn(path.join(workspace, 'fs-provenance.jsonl'));
  assert.equal(recorded.filter((one) => one.startsWith(canonical)).length, 1, recorded.join(', '));
});

test('a record appended while the move is finishing is not lost', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  const workspace = agentWorkspacePath(env, 'ava');
  const legacyArtifact = path.join(legacyWorkspacesDirPath(env), 'ava', 'mcp', 'linear', 'chart-1-0.png');
  await mkdir(path.join(workspace, 'mcp', 'linear'), { recursive: true });
  await writeFile(path.join(workspace, 'mcp', 'linear', 'chart-1-0.png'), 'bytes');
  await writeFile(path.join(workspace, 'fs-provenance.jsonl'), ledgerLine(legacyArtifact));
  // An ordinary command appends here the moment the new path exists — it
  // takes no home lock, and the rename has already exposed the workspace.
  // A read-modify-write of this file would drop whichever of these two
  // landed second; an append cannot.
  const concurrent = '/home/ada/notes/fetched-just-now.md';
  await writeFile(
    path.join(workspace, 'fs-provenance.jsonl'),
    `${ledgerLine(legacyArtifact)}${ledgerLine(concurrent)}`,
  );

  await runStateMigrations(env, { exclusive: true });

  const recorded = await recordedIn(path.join(workspace, 'fs-provenance.jsonl'));
  assert.ok(recorded.includes(path.join(workspace, 'mcp', 'linear', 'chart-1-0.png')), recorded.join(', '));
  assert.ok(recorded.includes(concurrent), recorded.join(', '));
});

test('a link to a workspace that did not move keeps naming where that workspace still is', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  const shared = ledgerLine('/home/ada/notes/vendor.md');
  await seedWorkspace(home, 'bea', { 'shared.md': 'the files both agents see', 'fs-provenance.jsonl': shared });
  await symlink('bea', path.join(legacyWorkspacesDirPath(env), 'ava'));
  // `bea`'s destination is already taken — an ordinary command on the new
  // build created it during the deferral window — so `bea` stays where it
  // is and only its ledger is folded. Sending `ava` to that destination
  // would swap the files it has always seen for a different workspace.
  await mkdir(agentWorkspacePath(env, 'bea'), { recursive: true });
  await writeFile(path.join(agentWorkspacePath(env, 'bea'), 'written-since.md'), 'by an ordinary command');

  await runStateMigrations(env, { exclusive: true });

  const ava = agentWorkspacePath(env, 'ava');
  assert.equal(await readFile(path.join(ava, 'shared.md'), 'utf8'), 'the files both agents see');
  assert.equal(await realpath(ava), await realpath(path.join(legacyWorkspacesDirPath(env), 'bea')));
});


test('the path a repair re-records from is derived, so nothing drags the ledger under the workspace', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  const workspace = agentWorkspacePath(env, 'ava');
  const legacyArtifact = path.join(legacyWorkspacesDirPath(env), 'ava', 'mcp', 'linear', 'chart-1-0.png');
  await mkdir(path.join(workspace, 'mcp', 'linear'), { recursive: true });
  await writeFile(path.join(workspace, 'mcp', 'linear', 'chart-1-0.png'), 'bytes');
  const outside = '/home/ada/notes/vendor.md';
  await writeFile(
    path.join(workspace, 'fs-provenance.jsonl'),
    `${ledgerLine(legacyArtifact)}${ledgerLine(outside)}`,
  );
  // A crashed move, repaired from the state: `workspaces/<id>` with the id
  // taken from the directory this agent's state is in, and nothing read
  // from anywhere. Were that source ever widened — to `/`, say — every
  // record in the file would be dragged under the workspace and every
  // unrelated file the agent had fetched would start reading as though it
  // lived there.

  await runStateMigrations(env, { exclusive: true });

  const recorded = await recordedIn(path.join(workspace, 'fs-provenance.jsonl'));
  // The record inside the workspace follows it.
  assert.ok(recorded.includes(path.join(workspace, 'mcp', 'linear', 'chart-1-0.png')), recorded.join(', '));
  // And the record outside stays where it is, undragged.
  assert.ok(!recorded.some((one) => one.startsWith(path.join(workspace, 'home'))), recorded.join(', '));
  assert.ok(recorded.includes(outside), recorded.join(', '));
});


test('a chain of workspace links resolves whichever order they are listed in', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await seedWorkspace(home, 'cyd', { 'shared.md': 'the files all three see' });
  // `ava -> bea -> cyd`, with the referencing links listed before what they
  // point at. Ordering directories before links only settles a link whose
  // target is a real directory; a link to a link needs the passes.
  await symlink('bea', path.join(legacyWorkspacesDirPath(env), 'ava'));
  await symlink('cyd', path.join(legacyWorkspacesDirPath(env), 'bea'));

  await runStateMigrations(env, { exclusive: true });

  for (const agentId of ['ava', 'bea', 'cyd']) {
    assert.equal(
      await readFile(path.join(agentWorkspacePath(env, agentId), 'shared.md'), 'utf8'),
      'the files all three see',
      agentId,
    );
  }
  await assert.rejects(readdir(legacyWorkspacesDirPath(env)), /ENOENT/);
});

test('a cycle member that cannot be given a directory is not announced as moving', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await mkdir(legacyWorkspacesDirPath(env), { recursive: true });
  await symlink('bea', path.join(legacyWorkspacesDirPath(env), 'ava'));
  await symlink('ava', path.join(legacyWorkspacesDirPath(env), 'bea'));
  // `ava` has nowhere to land: a regular file sits where its state
  // directory would go. Announcing it as moving anyway would point `bea`
  // at `agents/ava/workspace`, which never appears — and `bea`'s own
  // legacy entry is unlinked as it goes, so nothing would be left naming
  // anything.
  await writeFile(path.join(agentsDirPath(env), 'ava'), 'not a directory');

  const results = await runStateMigrations(env, { exclusive: true });
  const line = results.find((result) => result.id === MIGRATION)?.detail ?? '';
  assert.match(line, /ava/);

  assert.equal(
    path.resolve(path.dirname(agentWorkspacePath(env, 'bea')), await readlink(agentWorkspacePath(env, 'bea'))),
    path.join(legacyWorkspacesDirPath(env), 'ava'),
  );
});

test('a link at the legacy directory itself keeps it, rather than having it swept away', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  // An operator saying this agent's workspace is the whole of `workspaces/`.
  // There is no agent id in that target to follow, so the link keeps naming
  // the directory — and the sweep that removes `workspaces/` once it empties
  // would then leave it naming nothing.
  await seedWorkspace(home, 'bea', { 'own.md': 'mine' });
  await symlink('.', path.join(legacyWorkspacesDirPath(env), 'ava'));

  const results = await runStateMigrations(env, { exclusive: true });
  assert.ok(applied(results).includes(MIGRATION), applied(results).join(', '));

  // bea moved out, `workspaces/` emptied — and stayed, because ava names it.
  assert.equal(await readFile(path.join(agentWorkspacePath(env, 'bea'), 'own.md'), 'utf8'), 'mine');
  assert.equal(await realpath(agentWorkspacePath(env, 'ava')), await realpath(legacyWorkspacesDirPath(env)));
  assert.deepEqual(await readdir(legacyWorkspacesDirPath(env)), []);
});

test('a cycle whose destination is occupied is quarantined, not an aborted upgrade', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await mkdir(legacyWorkspacesDirPath(env), { recursive: true });
  await symlink('bea', path.join(legacyWorkspacesDirPath(env), 'ava'));
  await symlink('ava', path.join(legacyWorkspacesDirPath(env), 'bea'));
  // Something already at ava's new path. The source is a cycle, so `stat`
  // through it is `ELOOP` — and asking anything that resolves it would
  // abort the exclusive migration, taking `serve` and `update` with it, for
  // a layout this migration handles happily when the destination is free.
  await mkdir(agentWorkspacePath(env, 'ava'), { recursive: true });
  await writeFile(path.join(agentWorkspacePath(env, 'ava'), 'own.md'), 'mine');

  const results = await runStateMigrations(env, { exclusive: true });
  assert.ok(applied(results).includes(MIGRATION), applied(results).join(', '));
  assert.match(results.find((result) => result.id === MIGRATION)?.detail ?? '', /ava — .*leads nowhere/);
  // Nothing of either side is touched.
  assert.equal(await readFile(path.join(agentWorkspacePath(env, 'ava'), 'own.md'), 'utf8'), 'mine');
  assert.equal(await readlink(path.join(legacyWorkspacesDirPath(env), 'ava')), 'bea');
});

test('a legacy directory a previous run left a link at is not swept by the next one', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  // What a run killed after recreating `workspaces/ava -> .` and unlinking
  // its source leaves: the retry never visits `ava`, so remembering what
  // *this* run moved answers nothing.
  await seedWorkspace(home, 'bea', { 'own.md': 'mine' });
  await mkdir(path.join(agentsDirPath(env), 'ava'), { recursive: true });
  await symlink(path.join('..', '..', 'workspaces'), agentWorkspacePath(env, 'ava'));

  await runStateMigrations(env, { exclusive: true });

  assert.equal(await readFile(path.join(agentWorkspacePath(env, 'bea'), 'own.md'), 'utf8'), 'mine');
  assert.equal(await realpath(agentWorkspacePath(env, 'ava')), await realpath(legacyWorkspacesDirPath(env)));
});

test('a cycle somewhere else in the fleet does not stop another agent’s ledger fold', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await seedWorkspace(home, 'ava', { 'fs-provenance.jsonl': ledgerLine('/home/ada/notes/old.md') });
  await mkdir(agentWorkspacePath(env, 'ava'), { recursive: true });
  await writeFile(path.join(agentWorkspacePath(env, 'ava'), 'fs-provenance.jsonl'), ledgerLine('/home/ada/notes/new.md'));
  // Nothing to do with ava. Deciding whether ava's ledger is shared walks
  // every other workspace, and `stat` through a cycle is `ELOOP` — which
  // would abort the upgrade over a layout this migration handles.
  await symlink('cyd', path.join(legacyWorkspacesDirPath(env), 'bea'));
  await symlink('bea', path.join(legacyWorkspacesDirPath(env), 'cyd'));

  const results = await runStateMigrations(env, { exclusive: true });
  assert.ok(applied(results).includes(MIGRATION), applied(results).join(', '));

  const recorded = await recordedIn(path.join(agentWorkspacePath(env, 'ava'), 'fs-provenance.jsonl'));
  assert.deepEqual([...recorded].sort(), ['/home/ada/notes/new.md', '/home/ada/notes/old.md']);
});

test('a workspace that reaches the legacy directory through another link keeps it too', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await seedWorkspace(home, 'bea', { 'own.md': 'mine' });
  // The operator's own indirection: ava's workspace names a path of theirs
  // which points back here. Comparing link text sees two unrelated paths
  // and sweeps the directory both of them resolve to.
  const indirect = path.join(await mkdtemp(path.join(os.tmpdir(), 'stratus-indirect-')), 'ws');
  await symlink(legacyWorkspacesDirPath(env), indirect);
  await symlink(indirect, path.join(legacyWorkspacesDirPath(env), 'ava'));

  await runStateMigrations(env, { exclusive: true });

  assert.equal(await readFile(path.join(agentWorkspacePath(env, 'bea'), 'own.md'), 'utf8'), 'mine');
  assert.equal(await realpath(agentWorkspacePath(env, 'ava')), await realpath(legacyWorkspacesDirPath(env)));
});

test('links that point at each other are left as they are rather than looping forever', async () => {
  const home = await newHome();
  const env = { homeDir: home };
  await mkdir(legacyWorkspacesDirPath(env), { recursive: true });
  // Neither can ever move to a resolved target, so the passes have to give
  // up rather than defer each other indefinitely.
  await symlink('bea', path.join(legacyWorkspacesDirPath(env), 'ava'));
  await symlink('ava', path.join(legacyWorkspacesDirPath(env), 'bea'));

  const results = await runStateMigrations(env, { exclusive: true });
  assert.ok(applied(results).includes(MIGRATION), applied(results).join(', '));
  // Both moved, still pointing at *each other* — which is what they did
  // before, and not this migration's to repair. Naming the legacy paths
  // instead would be worse than it found them: those are unlinked as the
  // cycle moves, so each end would point at nothing at all.
  assert.ok((await lstat(agentWorkspacePath(env, 'ava'))).isSymbolicLink());
  assert.ok((await lstat(agentWorkspacePath(env, 'bea'))).isSymbolicLink());
  const reached = async (agentId: string): Promise<string> =>
    path.resolve(path.dirname(agentWorkspacePath(env, agentId)), await readlink(agentWorkspacePath(env, agentId)));
  assert.equal(await reached('ava'), agentWorkspacePath(env, 'bea'));
  assert.equal(await reached('bea'), agentWorkspacePath(env, 'ava'));
  await assert.rejects(readdir(legacyWorkspacesDirPath(env)), /ENOENT/);
});
