import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  PREDATES_SAFE_TOOLS_FACT,
  agentsDirPath,
  mergeStateStamp,
  readStateStamp,
  runStateMigrations,
  stateFilePath,
  unlistedToolsFor,
} from '../src/index.ts';

// An omitted tools: list means safe tools only on a home this build set up.
// A home an older build already used keeps reading it as every tool, so an
// upgrade changes nothing an agent can do. 0005 records which kind of home
// this is in the state stamp and writes no soul.

const MIGRATION = '0005-safe-tools-default';
const BEFORE = ['0001-owner-only-state-files', '0002-provenance-labels', '0003-per-agent-state-layout', '0004-per-agent-workspaces'];

const AVA = `---
# Ava's soul, written by hand
name: Ava
provider: anthropic
---
You are Ava. Be brief.
`;

const home = async (stamp?: { schemaVersion: number; applied: string[] }) => {
  const env = { homeDir: await realpath(await mkdtemp(path.join(os.tmpdir(), 'stratus-safe-tools-'))) };
  await mkdir(agentsDirPath(env), { recursive: true });
  if (stamp !== undefined) {
    await writeFile(stateFilePath(env), JSON.stringify(stamp));
  }
  return env;
};

test('an upgraded home records that it predates the safe default, and its souls are not touched', async () => {
  // What 0.14.2 left behind: everything before this migration applied.
  const env = await home({ schemaVersion: 4, applied: BEFORE });
  const soulPath = path.join(agentsDirPath(env), 'ava.md');
  await writeFile(soulPath, AVA);
  assert.equal(unlistedToolsFor(env), 'every', 'before 0005 has run, an older build\'s stamp already reads as every tool');

  const applied = await runStateMigrations(env);
  assert.deepEqual(applied.map((migration) => migration.id), [MIGRATION]);
  assert.match(applied[0]?.detail ?? '', /souls with no tools: list keep every tool/);

  assert.equal(await readFile(soulPath, 'utf8'), AVA, 'the soul is byte-identical');
  const stamp = await readStateStamp(env);
  assert.deepEqual(stamp.applied, [...BEFORE, MIGRATION]);
  assert.deepEqual(stamp.facts, [PREDATES_SAFE_TOOLS_FACT]);
  assert.equal(unlistedToolsFor(env), 'every');

  // A soul written by hand after the upgrade is on the same home, so it
  // reads the same way, and running again changes nothing.
  await writeFile(path.join(agentsDirPath(env), 'bob.md'), '---\nname: Bob\n---\nYou are Bob.\n');
  assert.deepEqual(await runStateMigrations(env), []);
  assert.deepEqual((await readStateStamp(env)).facts, [PREDATES_SAFE_TOOLS_FACT]);
  assert.equal(unlistedToolsFor(env), 'every');
});

test('a fresh home records no such fact, so a soul with no tools list gets safe tools only', async () => {
  const env = await home();
  await writeFile(path.join(agentsDirPath(env), 'ava.md'), AVA);
  assert.equal(unlistedToolsFor(env), 'safe', 'no stamp at all is a fresh home');

  const applied = await runStateMigrations(env, { exclusive: true });
  assert.ok(applied.some((migration) => migration.id === MIGRATION));
  assert.equal(applied.find((migration) => migration.id === MIGRATION)?.detail, undefined);

  const stamp = JSON.parse(await readFile(stateFilePath(env), 'utf8')) as Record<string, unknown>;
  assert.equal('facts' in stamp, false, 'a stamp with no facts keeps the shape older builds wrote');
  assert.equal(unlistedToolsFor(env), 'safe');
});

test('a home an older build stamped reads as every tool even while this build defers the stamp', async () => {
  // A run that defers an exclusive migration writes no stamp, so 0005 is
  // not recorded yet. The older build's stamp is what says the home is old.
  const env = await home({ schemaVersion: 2, applied: BEFORE.slice(0, 2) });
  assert.equal(unlistedToolsFor(env), 'every');
});

test('a corrupt stamp reads as a fresh home, which fails closed to safe tools', async () => {
  const env = await home();
  await writeFile(stateFilePath(env), '{not json');
  assert.equal(unlistedToolsFor(env), 'safe');
});

test('merging stamps keeps a fact either side recorded', () => {
  const latest = { schemaVersion: 4, applied: [...BEFORE, MIGRATION], facts: [PREDATES_SAFE_TOOLS_FACT] };
  const next = { schemaVersion: 4, applied: [...BEFORE, MIGRATION] };
  assert.deepEqual(mergeStateStamp(latest, next).facts, [PREDATES_SAFE_TOOLS_FACT]);
  assert.deepEqual(mergeStateStamp(next, latest).facts, [PREDATES_SAFE_TOOLS_FACT]);
  assert.equal('facts' in mergeStateStamp(next, next), false);
});
