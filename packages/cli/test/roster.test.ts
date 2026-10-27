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

const rosterOf = async (home: string, includeBuiltIn: boolean) => {
  const warnings: string[] = [];
  const roster = await rosterSoulsWithConfigured(
    { homeDir: home, cwd: home, processEnv: {} },
    (line) => warnings.push(line),
    { includeBuiltIn },
  );
  return {
    ids: roster.entries.map((entry) => entry.soul.agent.id),
    paths: roster.entries.map((entry) => entry.path),
    complete: roster.complete,
    warnings,
  };
};

// The gateway drops a configured default soul whose id names another
// registered agent's state directory without being that id (`Stratus`
// beside the built-in, `Remy` beside roster `remy`) and routes to the
// built-in. The CLI answers for the same roster, or `signin set`, `channel
// set`, `skills` and `plugins` describe an agent the daemon never serves.
for (const includeBuiltIn of [false, true]) {
  test(`rosterSoulsWithConfigured leaves off a configured soul whose id folds onto another (includeBuiltIn: ${includeBuiltIn})`, async () => {
    const ontoBuiltIn = await homeWithConfiguredSoul('Stratus');
    const builtIn = await rosterOf(ontoBuiltIn.home, includeBuiltIn);
    assert.deepEqual(builtIn.ids, includeBuiltIn ? ['stratus', 'remy'] : ['remy']);
    assert.equal(builtIn.complete, true);
    assert.ok(
      builtIn.warnings.some((line) => line.includes(ontoBuiltIn.soul) && /declares the agent id Stratus, which names the same state directory as stratus/.test(line)),
      builtIn.warnings.join('\n'),
    );

    const ontoRoster = await homeWithConfiguredSoul('Remy');
    const roster = await rosterOf(ontoRoster.home, includeBuiltIn);
    assert.deepEqual(roster.ids, includeBuiltIn ? ['stratus', 'remy'] : ['remy']);
    // The roster soul keeps serving from its own file.
    assert.equal(roster.paths.at(-1), path.join(ontoRoster.home, '.stratus', 'agents', 'remy.md'));
    assert.ok(
      roster.warnings.some((line) => /declares the agent id Remy, which names the same state directory as remy/.test(line)),
      roster.warnings.join('\n'),
    );
  });

  test(`rosterSoulsWithConfigured still takes an exact id over (includeBuiltIn: ${includeBuiltIn})`, async () => {
    // Exactly `stratus` is the configured soul taking the reserved id over,
    // and exactly `remy` is the configured soul replacing the roster file:
    // the daemon serves both, so neither is a collision.
    const reserved = await homeWithConfiguredSoul('stratus');
    const taken = await rosterOf(reserved.home, includeBuiltIn);
    assert.deepEqual(taken.ids, includeBuiltIn ? ['stratus', 'remy'] : ['remy', 'stratus']);
    assert.ok(taken.paths.includes(reserved.soul));
    assert.deepEqual(taken.warnings, []);

    const same = await homeWithConfiguredSoul('remy');
    const replaced = await rosterOf(same.home, includeBuiltIn);
    assert.deepEqual(replaced.ids, includeBuiltIn ? ['stratus', 'remy'] : ['remy']);
    assert.equal(replaced.paths.at(-1), same.soul);
    assert.deepEqual(replaced.warnings, []);
  });
}

test('stratus channel set refuses a configured soul the daemon ignores for folding onto another id, and says why', async () => {
  const { home } = await homeWithConfiguredSoul('Stratus');
  const env = { homeDir: home, cwd: home, processEnv: {} };
  let stdout = '';
  let stderr = '';
  const streams = {
    stdout: { write(chunk: string) { stdout += chunk; return true; } },
    stderr: { write(chunk: string) { stderr += chunk; return true; } },
  };
  const code = await runCli({
    argv: ['channel', 'set', 'imessage', '--agent', 'Stratus', 'apiKey'],
    streams,
    env: { ...env, stdin: 'synthetic-key\n' },
  });
  assert.equal(code, 1, stdout);
  assert.match(stderr, /No agent Stratus is on the roster/);
  assert.match(stderr, /names the same state directory as stratus/);
  const credentials = await readFile(path.join(home, '.stratus', 'credentials.json'), 'utf8').catch(() => '');
  assert.ok(!credentials.includes('synthetic-key'), 'nothing stored');
});
