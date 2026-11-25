import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  agentMemoryFilePath,
  agentStateDirPath,
  agentsDirPath,
  credentialsPath,
  fleetDbPath,
  globalConfigPath,
  loadRosterSouls,
  runStateMigrations,
  stratusPersona,
} from '../src/index.ts';

// The agent that answered runs with no soul used to live in code, as
// `stratus`. A home that used it gets it back as a soul file on upgrade, so
// its sessions, memory, grants, schedules and Slack app carry on; a home
// that never used it gets nothing.

const freshHome = async () => ({ homeDir: await mkdtemp(path.join(os.tmpdir(), 'stratus-soul-migration-')) });

const ownSoul = (env: { homeDir: string }) => path.join(agentsDirPath(env), 'stratus.md');

const readConfig = async (env: { homeDir: string }): Promise<Record<string, unknown> | undefined> => {
  try {
    return JSON.parse(await readFile(globalConfigPath(env), 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
};

const exists = async (filePath: string): Promise<boolean> => stat(filePath).then(() => true, () => false);

const migrate = async (env: { homeDir: string }): Promise<string> =>
  (await runStateMigrations(env, { exclusive: true }))
    .filter((result) => result.id === '0007-stratus-agent-soul')
    .map((result) => result.detail ?? '')
    .join(' ');

const seedMemory = async (env: { homeDir: string }, agentId: string): Promise<void> => {
  await mkdir(agentStateDirPath(env, agentId), { recursive: true });
  await writeFile(
    agentMemoryFilePath(env, agentId),
    `${JSON.stringify({ id: `${agentId}:memory:1`, agentId, content: 'the deploy runs on Fridays', createdAt: '2026-01-01T00:00:00.000Z' })}\n`,
  );
};

const assertStratusSoul = async (env: { homeDir: string }): Promise<void> => {
  const roster = await loadRosterSouls(env, (line) => assert.fail(`unexpected roster warning: ${line}`));
  const stratus = roster.find((entry) => entry.soul.agent.id === 'stratus');
  assert.ok(stratus, `expected a stratus soul, got ${JSON.stringify(roster.map((entry) => entry.soul.agent.id))}`);
  assert.equal(stratus.soul.agent.name, 'Stratus');
  // What the code gave it, written where the person can see and narrow it.
  assert.deepEqual(stratus.soul.agent.tools, ['*']);
  assert.equal(stratus.soul.agent.instructions, stratusPersona('Stratus'));
};

test('a fresh home gets no agent and no config', async () => {
  const env = await freshHome();
  assert.equal(await migrate(env), '');
  assert.equal(await exists(ownSoul(env)), false);
  assert.equal(await readConfig(env), undefined);
});

test('a home with only empty directories under stratus did not use it', async () => {
  const env = await freshHome();
  await mkdir(path.join(agentStateDirPath(env, 'stratus'), 'workspace', 'files'), { recursive: true });
  assert.equal(await migrate(env), '');
  assert.equal(await exists(ownSoul(env)), false);
});

test('a home with stratus memory gets a stratus soul, made the default, other config kept', async () => {
  const env = await freshHome();
  await seedMemory(env, 'stratus');
  await mkdir(path.dirname(globalConfigPath(env)), { recursive: true });
  await writeFile(globalConfigPath(env), `${JSON.stringify({ provider: 'anthropic', model: 'claude-test', approvals: { mode: 'remote' }, futureKey: { kept: true } })}\n`);

  const detail = await migrate(env);

  await assertStratusSoul(env);
  assert.match(detail, /stratus\.md/);
  assert.match(detail, /default agent/);
  assert.deepEqual(await readConfig(env), {
    provider: 'anthropic',
    model: 'claude-test',
    approvals: { mode: 'remote' },
    futureKey: { kept: true },
    soul: ownSoul(env),
  });
  // Its memory is where it was, read under the same id.
  assert.match(await readFile(agentMemoryFilePath(env, 'stratus'), 'utf8'), /Fridays/);
});

test('a home with no config file gets one naming only the soul', async () => {
  const env = await freshHome();
  await seedMemory(env, 'stratus');
  await migrate(env);
  await assertStratusSoul(env);
  assert.deepEqual(await readConfig(env), { soul: ownSoul(env) });
});

test('memories under a legacy default id count as using it', async () => {
  const env = await freshHome();
  await seedMemory(env, 'demo-agent');
  await migrate(env);
  await assertStratusSoul(env);
});

test('a Slack app stored for stratus counts as using it', async () => {
  const env = await freshHome();
  await mkdir(path.dirname(credentialsPath(env)), { recursive: true });
  await writeFile(credentialsPath(env), JSON.stringify({ channels: { slack: { stratus: { appToken: 'xapp-test', botToken: 'xoxb-test' } } } }));
  await migrate(env);
  await assertStratusSoul(env);
});

test('a schedule for stratus counts as using it', async () => {
  const env = await freshHome();
  await mkdir(path.dirname(fleetDbPath(env)), { recursive: true });
  const db = new DatabaseSync(fleetDbPath(env));
  db.exec('CREATE TABLE schedules (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, next_fire_at TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL)');
  db.prepare('INSERT INTO schedules VALUES (?, ?, ?, ?, ?)').run('s-1', 'stratus', '2026-12-01T00:00:00.000Z', '{}', '2026-11-01T00:00:00.000Z');
  db.close();
  await migrate(env);
  await assertStratusSoul(env);
});

test('a schedule for another agent does not', async () => {
  const env = await freshHome();
  await mkdir(path.dirname(fleetDbPath(env)), { recursive: true });
  const db = new DatabaseSync(fleetDbPath(env));
  db.exec('CREATE TABLE schedules (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, next_fire_at TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL)');
  db.prepare('INSERT INTO schedules VALUES (?, ?, ?, ?, ?)').run('s-1', 'ava', '2026-12-01T00:00:00.000Z', '{}', '2026-11-01T00:00:00.000Z');
  db.close();
  assert.equal(await migrate(env), '');
  assert.equal(await exists(ownSoul(env)), false);
});

test('a home with a default soul keeps it, and still gets the stratus soul', async () => {
  const env = await freshHome();
  await seedMemory(env, 'stratus');
  const ava = path.join(agentsDirPath(env), 'ava.md');
  await mkdir(agentsDirPath(env), { recursive: true });
  await writeFile(ava, '---\nname: Ava\nid: ava\n---\n\nYou are Ava.\n');
  await writeFile(globalConfigPath(env), `${JSON.stringify({ soul: ava })}\n`);

  const detail = await migrate(env);

  await assertStratusSoul(env);
  assert.deepEqual(await readConfig(env), { soul: ava });
  assert.doesNotMatch(detail, /default agent/);
});

test('a roster soul already declaring stratus takes the state over, and nothing is written beside it', async () => {
  const env = await freshHome();
  await seedMemory(env, 'stratus');
  await mkdir(agentsDirPath(env), { recursive: true });
  const legacy = path.join(agentsDirPath(env), 'legacy.md');
  await writeFile(legacy, '---\nname: Old Friend\nid: stratus\ntools: [memory.recall]\n---\n\nYou are an old friend.\n');

  const detail = await migrate(env);

  assert.equal(await exists(ownSoul(env)), false);
  const roster = await loadRosterSouls(env, () => {});
  assert.deepEqual(roster.map((entry) => [entry.soul.agent.id, entry.soul.agent.name]), [['stratus', 'Old Friend']]);
  assert.match(detail, /legacy\.md already declares the id stratus/);
  assert.deepEqual(await readConfig(env), { soul: legacy });
});

test('a default soul outside agents/ that declares stratus is left as the agent', async () => {
  const env = await freshHome();
  await seedMemory(env, 'stratus');
  const elsewhere = path.join(env.homeDir, 'souls', 'mine.md');
  await mkdir(path.dirname(elsewhere), { recursive: true });
  await writeFile(elsewhere, '---\nname: Mine\nid: stratus\n---\n\nYou are mine.\n');
  await mkdir(path.dirname(globalConfigPath(env)), { recursive: true });
  await writeFile(globalConfigPath(env), `${JSON.stringify({ soul: elsewhere })}\n`);

  await migrate(env);

  // Two souls on one state directory is what the gateway refuses.
  assert.equal(await exists(ownSoul(env)), false);
  assert.deepEqual(await readConfig(env), { soul: elsewhere });
});

test('an unreadable config is left alone, and the soul is still written', async () => {
  const env = await freshHome();
  await seedMemory(env, 'stratus');
  await mkdir(path.dirname(globalConfigPath(env)), { recursive: true });
  await writeFile(globalConfigPath(env), '{ not json');

  const detail = await migrate(env);

  await assertStratusSoul(env);
  assert.equal(await readFile(globalConfigPath(env), 'utf8'), '{ not json');
  assert.match(detail, /could not read/);
});

test('a second run writes nothing and says nothing', async () => {
  const env = await freshHome();
  await seedMemory(env, 'stratus');
  await migrate(env);
  const soulBefore = await readFile(ownSoul(env), 'utf8');
  const configBefore = await readFile(globalConfigPath(env), 'utf8');

  // Straight at the registry entry, past the stamp that would skip it: a
  // crash can lose the record of a completed run.
  const { STATE_MIGRATIONS } = await import('../src/index.ts');
  const entry = STATE_MIGRATIONS.find((migration) => migration.id === '0007-stratus-agent-soul');
  assert.ok(entry);
  assert.equal(await entry.apply(env), undefined);
  assert.equal(await readFile(ownSoul(env), 'utf8'), soulBefore);
  assert.equal(await readFile(globalConfigPath(env), 'utf8'), configBefore);
});

test('a stratus.md that is another agent\'s is kept, and the soul goes beside it', async () => {
  const env = await freshHome();
  await seedMemory(env, 'stratus');
  await mkdir(agentsDirPath(env), { recursive: true });
  const ava = '---\nname: Ava\nid: ava\n---\n\nYou are Ava.\n';
  await writeFile(ownSoul(env), ava);

  const detail = await migrate(env);

  // Ava's file as it was, and Ava never made the default for stratus.
  assert.equal(await readFile(ownSoul(env), 'utf8'), ava);
  await assertStratusSoul(env);
  const beside = path.join(agentsDirPath(env), 'stratus-agent.md');
  assert.equal(await exists(beside), true);
  assert.deepEqual(await readConfig(env), { soul: beside });
  assert.match(detail, /stratus-agent\.md/);
});

test('a soul whose id differs from stratus only in case is not taken for it', async () => {
  const env = await freshHome();
  await seedMemory(env, 'stratus');
  await mkdir(agentsDirPath(env), { recursive: true });
  const capital = path.join(agentsDirPath(env), 'capital.md');
  await writeFile(capital, '---\nname: Capital\nid: Stratus\n---\n\nYou are Capital.\n');
  await writeFile(globalConfigPath(env), `${JSON.stringify({ provider: 'anthropic' })}\n`);

  const detail = await migrate(env);

  // A second soul would make two ids the roster refuses; adopting it would
  // hand the state under agents/stratus to an agent whose state directory
  // is agents/Stratus wherever case does not fold. Neither, and it says so.
  assert.equal(await exists(ownSoul(env)), false);
  const roster = await loadRosterSouls(env, () => {});
  assert.deepEqual(roster.map((entry) => entry.soul.agent.id), ['Stratus']);
  assert.deepEqual(await readConfig(env), { provider: 'anthropic' });
  assert.match(detail, /capital\.md declares the id Stratus/);
  assert.match(detail, /id: stratus/);
});

for (const [label, raw] of [['an array', '[]'], ['null', 'null'], ['a number', '7']] as const) {
  test(`a config that is ${label} is left alone, and the soul is still written`, async () => {
    const env = await freshHome();
    await seedMemory(env, 'stratus');
    await mkdir(path.dirname(globalConfigPath(env)), { recursive: true });
    await writeFile(globalConfigPath(env), raw);

    const detail = await migrate(env);

    await assertStratusSoul(env);
    assert.equal(await readFile(globalConfigPath(env), 'utf8'), raw);
    assert.match(detail, /could not read/);
  });
}
