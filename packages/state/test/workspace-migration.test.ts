import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { whitelistPathFor } from '@stratusagent/permissions';

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
  assert.equal(workspaces.forAgent('ava'), agentWorkspacePath(env, 'ava'));
  // Nothing on disk yet: `all()` is asked before the first write, by the
  // ledger guard, so an empty home is an empty answer rather than a throw —
  // including a home with no `agents/` at all, which is every install
  // before its first agent.
  assert.deepEqual(await workspaces.all(), []);
  const fresh = await mkdtemp(path.join(os.tmpdir(), 'stratus-fresh-'));
  assert.deepEqual(await createAgentWorkspaces({ homeDir: fresh }).all(), []);

  await mkdir(path.join(agentsDirPath(env), 'ava'), { recursive: true });
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
  const outside = path.join(home, 'notes', 'vendor.md');
  await seedWorkspace(home, 'ava', {
    // An MCP server's image: written inside the workspace and recorded
    // there, with no operator configuration involved. A rename moves the
    // file and leaves the record naming a path nothing is at any more —
    // which reads back as the agent's own words, silently.
    'mcp/linear/chart-1-0.png': 'bytes',
    'fs-provenance.jsonl': [
      ledgerLine(path.join(legacyWorkspace, 'mcp', 'linear', 'chart-1-0.png')),
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
  const paths = raw.split('\n').flatMap((line) => {
    try {
      const parsed = JSON.parse(line) as { path?: string };
      return typeof parsed.path === 'string' ? [parsed.path] : [];
    } catch {
      return [];
    }
  });
  assert.deepEqual(paths, [path.join(workspace, 'mcp', 'linear', 'chart-1-0.png'), outside]);
  assert.match(raw, /\{"path":"\/half-written",/);
  // The label rode along with the path, not just the path.
  const moved = raw.split('\n').map((line) => { try { return JSON.parse(line) as { path?: string; trust?: string }; } catch { return {}; } })
    .find((record) => record.path === path.join(workspace, 'mcp', 'linear', 'chart-1-0.png'));
  assert.equal(moved?.trust, 'external');
});
