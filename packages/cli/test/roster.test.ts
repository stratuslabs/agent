import './home-guard.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runCli } from '../src/index.ts';
import { rosterSoulsWithConfigured } from '../src/roster.ts';

// A home with one roster soul (remy) and a configured default soul that
// lives outside the agents directory and declares `id`.
const homeWithConfiguredSoul = async (id: string): Promise<{ home: string; soul: string }> => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-roster-cli-'));
  const agents = path.join(home, '.stratus', 'agents');
  await mkdir(agents, { recursive: true });
  await writeFile(path.join(agents, 'remy.md'), '---\nname: Remy\nprovider: anthropic\n---\n\nYou are Remy.\n');
  const soul = path.join(home, 'main.md');
  await writeFile(soul, `---\nname: Main\nid: ${id}\nprovider: anthropic\n---\n\nYou are Main.\n`);
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'anthropic', soul }));
  return { home, soul };
};

const rosterOf = async (home: string) => {
  const warnings: string[] = [];
  const roster = await rosterSoulsWithConfigured(
    { homeDir: home, cwd: home, processEnv: {} },
    (line) => warnings.push(line),
  );
  return {
    ids: roster.entries.map((entry) => entry.soul.agent.id),
    paths: roster.entries.map((entry) => entry.path),
    complete: roster.complete,
    warnings,
  };
};

// The gateway drops a configured default soul whose id names another
// registered agent's state directory without being that id (`Remy` beside
// roster `remy`), and turns that name no agent then have no default. The CLI
// answers for the same roster, or `signin set`, `channel set`, `skills` and
// `plugins` describe an agent the daemon never serves.
test('rosterSoulsWithConfigured leaves off a configured soul whose id folds onto another', async () => {
  const ontoRoster = await homeWithConfiguredSoul('Remy');
  const roster = await rosterOf(ontoRoster.home);
  assert.deepEqual(roster.ids, ['remy']);
  assert.equal(roster.complete, true);
  // The roster soul keeps serving from its own file.
  assert.equal(roster.paths.at(-1), path.join(ontoRoster.home, '.stratus', 'agents', 'remy.md'));
  assert.ok(
    roster.warnings.some((line) => line.includes(ontoRoster.soul) && /declares the agent id Remy, which names the same state directory as remy/.test(line)),
    roster.warnings.join('\n'),
  );
});

test('rosterSoulsWithConfigured lists a configured soul first, and an exact id takes the roster file over', async () => {
  // No id is held back for an agent in code: a configured `Stratus` is an
  // agent like any other, listed first as the default.
  const stratus = await homeWithConfiguredSoul('Stratus');
  const listed = await rosterOf(stratus.home);
  assert.deepEqual(listed.ids, ['Stratus', 'remy']);
  assert.equal(listed.paths[0], stratus.soul);
  assert.deepEqual(listed.warnings, []);

  // Exactly `remy` is the configured soul replacing the roster file: the
  // daemon serves it, so it is not a collision.
  const same = await homeWithConfiguredSoul('remy');
  const replaced = await rosterOf(same.home);
  assert.deepEqual(replaced.ids, ['remy']);
  assert.equal(replaced.paths.at(-1), same.soul);
  assert.deepEqual(replaced.warnings, []);
});

test('stratus channel set refuses a configured soul the daemon ignores for folding onto another id, and says why', async () => {
  const { home } = await homeWithConfiguredSoul('Remy');
  const env = { homeDir: home, cwd: home, processEnv: {} };
  let stdout = '';
  let stderr = '';
  const streams = {
    stdout: { write(chunk: string) { stdout += chunk; return true; } },
    stderr: { write(chunk: string) { stderr += chunk; return true; } },
  };
  const code = await runCli({
    argv: ['channel', 'set', 'imessage', '--agent', 'Remy', 'apiKey'],
    streams,
    env: { ...env, stdin: 'synthetic-key\n' },
  });
  assert.equal(code, 1, stdout);
  assert.match(stderr, /No agent Remy is on the roster/);
  assert.match(stderr, /names the same state directory as remy/);
  const credentials = await readFile(path.join(home, '.stratus', 'credentials.json'), 'utf8').catch(() => '');
  assert.ok(!credentials.includes('synthetic-key'), 'nothing stored');
});
