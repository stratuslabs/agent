import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SkillRegistry } from '@stratusagent/core';

import { loadOperatorSkills, skillsDirPath } from '../src/index.ts';

const skillFile = (description: string, body = 'The procedure.'): string =>
  `---\ndescription: ${description}\n---\n\n${body}\n`;

const freshHome = async (): Promise<string> =>
  mkdtemp(path.join(os.tmpdir(), 'stratus-skills-'));

test('skills load from ~/.stratus/skills, one directory per skill, id from the directory name', async () => {
  const homeDir = await freshHome();
  const env = { homeDir };
  const dir = skillsDirPath(env);
  await mkdir(path.join(dir, 'code-review'), { recursive: true });
  await writeFile(path.join(dir, 'code-review', 'SKILL.md'), skillFile('Use when reviewing a diff.', '# Review\n\nSteps.'));
  await mkdir(path.join(dir, 'web-research'), { recursive: true });
  await writeFile(path.join(dir, 'web-research', 'SKILL.md'), skillFile('Use when researching on the web.'));

  const registry = new SkillRegistry();
  const warnings: string[] = [];
  const loaded = await loadOperatorSkills(env, registry, (line) => warnings.push(line));

  assert.deepEqual(warnings, []);
  assert.deepEqual(loaded.map((skill) => skill.id), ['code-review', 'web-research']);
  assert.equal(registry.resolve('code-review')?.description, 'Use when reviewing a diff.');
  assert.match(await registry.read('code-review'), /# Review/);
});

test('a missing skills directory is no skills, not an error', async () => {
  const registry = new SkillRegistry();
  const loaded = await loadOperatorSkills({ homeDir: await freshHome() }, registry, () => {
    assert.fail('nothing to warn about');
  });
  assert.deepEqual(loaded, []);
  assert.deepEqual(registry.list(), []);
});

test('one broken skill is a warning, and the rest still load', async () => {
  const homeDir = await freshHome();
  const env = { homeDir };
  const dir = skillsDirPath(env);
  await mkdir(path.join(dir, 'good'), { recursive: true });
  await writeFile(path.join(dir, 'good', 'SKILL.md'), skillFile('Use when things go well.'));
  // No description — the identity routing runs on.
  await mkdir(path.join(dir, 'vague'), { recursive: true });
  await writeFile(path.join(dir, 'vague', 'SKILL.md'), '---\nname: Vague\n---\n\nBody.');
  // A directory with no SKILL.md at all.
  await mkdir(path.join(dir, 'empty'), { recursive: true });
  // An id that is not an id.
  await mkdir(path.join(dir, 'Bad Name'), { recursive: true });
  await writeFile(path.join(dir, 'Bad Name', 'SKILL.md'), skillFile('Never loads.'));
  // A stray file in the directory is not a skill and not a warning.
  await writeFile(path.join(dir, 'README.md'), 'about this directory');

  const registry = new SkillRegistry();
  const warnings: string[] = [];
  const loaded = await loadOperatorSkills(env, registry, (line) => warnings.push(line));

  assert.deepEqual(loaded.map((skill) => skill.id), ['good']);
  assert.equal(warnings.length, 3);
  assert.ok(warnings.some((line) => line.includes('not a skill id')));
  assert.ok(warnings.some((line) => line.includes('no "description"')));
});
