import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SkillRegistry } from '@stratusagent/core';

import { installSkillsFromDirectory, loadOperatorSkills, skillsDirPath } from '../src/index.ts';

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

  // Strict is the reload's contract: the first skill that would not load
  // refuses the whole set, named by path, and nothing warns — half a
  // catalog is worse than a stale one.
  const strict = new SkillRegistry();
  const strictWarnings: string[] = [];
  await assert.rejects(
    loadOperatorSkills(env, strict, (line) => strictWarnings.push(line), { strict: true }),
    (error: Error) => error.message.startsWith('Cannot load ') && error.message.includes(path.join(dir, 'Bad Name', 'SKILL.md')),
  );
  assert.deepEqual(strictWarnings, []);
});

test('install discovers a skills repo laid out like the ecosystem publishes them', async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), 'stratus-skillsrc-'));
  // Subdirectories at the root, each a skill with a bundled README — the
  // shape of a typical skills.sh repository.
  for (const id of ['hn-search', 'design-tokens']) {
    await mkdir(path.join(source, id), { recursive: true });
    await writeFile(path.join(source, id, 'SKILL.md'), skillFile(`Use for ${id}.`, `# ${id}`));
    await writeFile(path.join(source, id, 'README.md'), 'for humans');
  }
  // A container directory too, and clutter that must not become a skill.
  await mkdir(path.join(source, 'skills', 'extra'), { recursive: true });
  await writeFile(path.join(source, 'skills', 'extra', 'SKILL.md'), skillFile('Use for extra things.'));
  await mkdir(path.join(source, '.git', 'objects'), { recursive: true });
  await writeFile(path.join(source, '.git', 'config'), 'not a skill');
  await mkdir(path.join(source, 'node_modules', 'dep'), { recursive: true });
  await writeFile(path.join(source, 'node_modules', 'dep', 'SKILL.md'), skillFile('Never this.'));
  // One broken skill: reported, and the rest still install.
  await mkdir(path.join(source, 'vague'), { recursive: true });
  await writeFile(path.join(source, 'vague', 'SKILL.md'), '---\nname: Vague\n---\n\nBody.');

  const homeDir = await freshHome();
  const env = { homeDir };
  const result = await installSkillsFromDirectory(env, source);

  assert.deepEqual(result.installed.map((skill) => skill.id).sort(), ['design-tokens', 'extra', 'hn-search']);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0]?.reason ?? '', /no "description"/);

  // Whole directories travel — the bundled README came along — and the
  // installed skills load through the normal loader.
  await readFile(path.join(skillsDirPath(env), 'hn-search', 'README.md'), 'utf8');
  const registry = new SkillRegistry();
  const loaded = await loadOperatorSkills(env, registry, () => {});
  assert.deepEqual(loaded.map((skill) => skill.id).sort(), ['design-tokens', 'extra', 'hn-search']);
});

test('install refuses an id already installed unless forced, and only: filters', async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), 'stratus-skillsrc-'));
  for (const id of ['one', 'two']) {
    await mkdir(path.join(source, id), { recursive: true });
    await writeFile(path.join(source, id, 'SKILL.md'), skillFile(`Use for ${id}, v1.`));
  }

  const homeDir = await freshHome();
  const env = { homeDir };
  const first = await installSkillsFromDirectory(env, source, { only: ['one'] });
  assert.deepEqual(first.installed.map((skill) => skill.id), ['one']);
  assert.ok(first.skipped.length === 0);

  const missing = await installSkillsFromDirectory(env, source, { only: ['three'] });
  assert.deepEqual(missing.installed, []);
  assert.match(missing.skipped[0]?.reason ?? '', /does not offer/);

  await writeFile(path.join(source, 'one', 'SKILL.md'), skillFile('Use for one, v2.'));
  const collided = await installSkillsFromDirectory(env, source);
  assert.deepEqual(collided.installed.map((skill) => skill.id), ['two']);
  // Present is not a failure: the id is reported as already installed —
  // with the INSTALLED copy's identity, not the source's — so an
  // enablement step following the install can still act on it.
  assert.deepEqual(collided.skipped, []);
  assert.equal(collided.alreadyInstalled[0]?.id, 'one');
  assert.equal(collided.alreadyInstalled[0]?.description, 'Use for one, v1.');

  const forced = await installSkillsFromDirectory(env, source, { only: ['one'], force: true });
  assert.equal(forced.installed[0]?.description, 'Use for one, v2.');
});

test('symlinks: relative links inside a skill survive; a link escaping the skill refuses it', async () => {
  const { symlink } = await import('node:fs/promises');
  const source = await mkdtemp(path.join(os.tmpdir(), 'stratus-skilllink-'));
  await mkdir(path.join(source, 'linky'), { recursive: true });
  await writeFile(path.join(source, 'linky', 'SKILL.md'), skillFile('Use for links.'));
  await writeFile(path.join(source, 'linky', 'ref.txt'), 'referenced');
  await symlink('ref.txt', path.join(source, 'linky', 'link.txt'));
  // A link reaching out of its skill would keep reaching out of
  // ~/.stratus/skills once installed — where SKILL.md -> ../../credentials.json
  // is a skill body that reads the operator's secrets.
  await writeFile(path.join(source, 'secret.txt'), 'SECRET');
  await mkdir(path.join(source, 'evil'), { recursive: true });
  await writeFile(path.join(source, 'evil', 'SKILL.md'), skillFile('Use for evil.'));
  await symlink(path.join('..', 'secret.txt'), path.join(source, 'evil', 'notes.txt'));

  // An absolute link is refused even when it currently resolves inside
  // the skill: preserved verbatim, it is pinned to this checkout's path —
  // dangling the moment a cloned source is cleaned up.
  await mkdir(path.join(source, 'absin'), { recursive: true });
  await writeFile(path.join(source, 'absin', 'SKILL.md'), skillFile('Use for absin.'));
  await writeFile(path.join(source, 'absin', 'ref.txt'), 'referenced');
  await symlink(path.join(source, 'absin', 'ref.txt'), path.join(source, 'absin', 'link.txt'));

  const homeDir = await freshHome();
  const env = { homeDir };
  const result = await installSkillsFromDirectory(env, source);

  assert.deepEqual(result.installed.map((skill) => skill.id), ['linky']);
  assert.deepEqual(result.skipped.map((skip) => skip.id).sort(), ['absin', 'evil']);
  assert.match(result.skipped[0]?.reason ?? '', /symlink reaching outside/);
  // The contained link stayed relative — it must not point back into a
  // source directory that a cloned install deletes on return.
  const { readlink } = await import('node:fs/promises');
  assert.equal(await readlink(path.join(skillsDirPath(env), 'linky', 'link.txt')), 'ref.txt');
  // And nothing landed for the refused skill, staging included.
  const remaining = await import('node:fs/promises').then(({ readdir }) => readdir(skillsDirPath(env)));
  assert.deepEqual(remaining.sort(), ['linky']);
});

test('a root skill keeps its bundle: a SKILL.md inside examples/ is not a second install', async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), 'stratus-skillbundle-XYZ'));
  await writeFile(
    path.join(source, 'SKILL.md'),
    '---\nname: pr-review\ndescription: Use when reviewing pull requests.\n---\n\nBody.\n',
  );
  await mkdir(path.join(source, 'examples', 'demo'), { recursive: true });
  await writeFile(path.join(source, 'examples', 'demo', 'SKILL.md'), skillFile('A bundled example, not a skill.'));

  const homeDir = await freshHome();
  const result = await installSkillsFromDirectory({ homeDir }, source);
  assert.deepEqual(result.installed.map((skill) => skill.id), ['pr-review']);
  assert.deepEqual(result.skipped, []);
  // The example travels inside the root skill's own directory.
  await readFile(path.join(skillsDirPath({ homeDir }), 'pr-review', 'examples', 'demo', 'SKILL.md'), 'utf8');
});

test('symlinks under node_modules and .git do not refuse a skill — the copy drops them anyway', async () => {
  const { symlink } = await import('node:fs/promises');
  const source = await mkdtemp(path.join(os.tmpdir(), 'stratus-skillnm-'));
  await mkdir(path.join(source, 'toolful', 'node_modules', '.bin'), { recursive: true });
  await writeFile(path.join(source, 'toolful', 'SKILL.md'), skillFile('Use for toolful things.'));
  await writeFile(path.join(source, 'elsewhere.js'), 'x');
  // The out-of-tree link a package manager plants — never installed,
  // because the copy filter drops node_modules whole.
  await symlink(path.join('..', '..', '..', '..', 'elsewhere.js'), path.join(source, 'toolful', 'node_modules', '.bin', 'tool'));

  const homeDir = await freshHome();
  const result = await installSkillsFromDirectory({ homeDir }, source);
  assert.deepEqual(result.installed.map((skill) => skill.id), ['toolful']);
  const installedEntries = await import('node:fs/promises').then(({ readdir }) =>
    readdir(path.join(skillsDirPath({ homeDir }), 'toolful')));
  assert.deepEqual(installedEntries.sort(), ['SKILL.md']);
});

test('a dangling symlink is judged by where it will point once installed', async () => {
  const { symlink } = await import('node:fs/promises');
  const source = await mkdtemp(path.join(os.tmpdir(), 'stratus-skilldangle-'));
  // Dangles in the clone — ../../credentials.json does not exist here —
  // but preserved verbatim it resolves to the operator's secrets from
  // ~/.stratus/skills/<id>/. The realpath check alone waves it through.
  await mkdir(path.join(source, 'evil'), { recursive: true });
  await writeFile(path.join(source, 'evil', 'SKILL.md'), skillFile('Use for evil.'));
  await symlink(path.join('..', '..', 'credentials.json'), path.join(source, 'evil', 'notes'));
  // An absolute dangling target is somebody's machine by construction.
  await mkdir(path.join(source, 'abs'), { recursive: true });
  await writeFile(path.join(source, 'abs', 'SKILL.md'), skillFile('Use for abs.'));
  await symlink('/etc/does-not-exist-here', path.join(source, 'abs', 'notes'));
  // A dangling link that stays inside its skill is a broken decoration,
  // not a reason to refuse the skill.
  await mkdir(path.join(source, 'benign'), { recursive: true });
  await writeFile(path.join(source, 'benign', 'SKILL.md'), skillFile('Use for benign.'));
  await symlink('missing.txt', path.join(source, 'benign', 'ref'));

  const homeDir = await freshHome();
  const result = await installSkillsFromDirectory({ homeDir }, source);

  assert.deepEqual(result.installed.map((skill) => skill.id), ['benign']);
  assert.deepEqual(result.skipped.map((skip) => skip.id).sort(), ['abs', 'evil']);
  for (const skip of result.skipped) {
    assert.match(skip.reason, /symlink reaching outside/);
  }
});

test('a refused forced replacement leaves the working version in place', async () => {
  const { symlink } = await import('node:fs/promises');
  const source = await mkdtemp(path.join(os.tmpdir(), 'stratus-skillforce-'));
  await mkdir(path.join(source, 'one'), { recursive: true });
  await writeFile(path.join(source, 'one', 'SKILL.md'), skillFile('Use for one, v1.'));

  const homeDir = await freshHome();
  const env = { homeDir };
  await installSkillsFromDirectory(env, source);

  // v2 is hostile: refused before the installed v1 is touched.
  await writeFile(path.join(source, 'one', 'SKILL.md'), skillFile('Use for one, v2.'));
  await writeFile(path.join(source, 'outside.txt'), 'x');
  await symlink(path.join('..', 'outside.txt'), path.join(source, 'one', 'esc.txt'));
  const result = await installSkillsFromDirectory(env, source, { force: true });
  assert.deepEqual(result.installed, []);
  assert.match(result.skipped[0]?.reason ?? '', /symlink reaching outside/);

  const registry = new SkillRegistry();
  const loaded = await loadOperatorSkills(env, registry, () => {});
  assert.equal(loaded[0]?.description, 'Use for one, v1.');
});

test('a repository whose root is the skill installs under its frontmatter name, or the rootId for a nameless one', async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), 'stratus-skillroot-XYZ'));
  await writeFile(
    path.join(source, 'SKILL.md'),
    '---\nname: pr-review\ndescription: Use when reviewing pull requests.\n---\n\nBody.\n',
  );

  const homeDir = await freshHome();
  // The frontmatter name wins at the root even over a valid rootId — the
  // checkout location is circumstance; the name is the skill's own.
  const named = await installSkillsFromDirectory({ homeDir }, source, { rootId: 'my-skills' });
  assert.deepEqual(named.installed.map((skill) => skill.id), ['pr-review']);

  // A nameless root skill takes the rootId — for a cloned source that is
  // the repository's name, never the temp directory git landed in.
  const nameless = await mkdtemp(path.join(os.tmpdir(), 'stratus-skillroot-XYZ'));
  await writeFile(
    path.join(nameless, 'SKILL.md'),
    '---\ndescription: Use when reviewing pull requests.\n---\n\nBody.\n',
  );
  const viaRootId = await installSkillsFromDirectory({ homeDir }, nameless, { rootId: 'my-skills' });
  assert.deepEqual(viaRootId.installed.map((skill) => skill.id), ['my-skills']);
});
