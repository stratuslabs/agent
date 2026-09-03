import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SkillRegistry } from '@stratusagent/core';

import {
  discoverSkillsInDirectory,
  installSkillsFromDirectory,
  loadOperatorSkills,
  skillsDirPath,
  validateSkillDirectory,
} from '../src/index.ts';

// The pre-spec shape, no name: what is already installed under
// ~/.stratus/skills keeps loading, so the loader tests write it.
const skillFile = (description: string, body = 'The procedure.'): string =>
  `---\ndescription: ${description}\n---\n\n${body}\n`;

// The spec's shape — name equal to the directory — which is what install
// requires of a source.
const specSkill = (id: string, description: string, body = 'The procedure.'): string =>
  `---\nname: ${id}\ndescription: ${description}\n---\n\n${body}\n`;

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

test('install discovers a skills repo laid out like the ecosystem publishes them', async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), 'stratus-skillsrc-'));
  // Subdirectories at the root, each a skill with a bundled README — the
  // shape of a typical skills.sh repository.
  for (const id of ['hn-search', 'design-tokens']) {
    await mkdir(path.join(source, id), { recursive: true });
    await writeFile(path.join(source, id, 'SKILL.md'), specSkill(id, `Use for ${id}.`, `# ${id}`));
    await writeFile(path.join(source, id, 'README.md'), 'for humans');
  }
  // A container directory too, and clutter that must not become a skill.
  await mkdir(path.join(source, 'skills', 'extra'), { recursive: true });
  await writeFile(path.join(source, 'skills', 'extra', 'SKILL.md'), specSkill('extra', 'Use for extra things.'));
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
    await writeFile(path.join(source, id, 'SKILL.md'), specSkill(id, `Use for ${id}, v1.`));
  }

  const homeDir = await freshHome();
  const env = { homeDir };
  const first = await installSkillsFromDirectory(env, source, { only: ['one'] });
  assert.deepEqual(first.installed.map((skill) => skill.id), ['one']);
  assert.ok(first.skipped.length === 0);

  const missing = await installSkillsFromDirectory(env, source, { only: ['three'] });
  assert.deepEqual(missing.installed, []);
  assert.match(missing.skipped[0]?.reason ?? '', /does not offer/);

  await writeFile(path.join(source, 'one', 'SKILL.md'), specSkill('one', 'Use for one, v2.'));
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
  await writeFile(path.join(source, 'linky', 'SKILL.md'), specSkill('linky', 'Use for links.'));
  await writeFile(path.join(source, 'linky', 'ref.txt'), 'referenced');
  await symlink('ref.txt', path.join(source, 'linky', 'link.txt'));
  // A link reaching out of its skill would keep reaching out of
  // ~/.stratus/skills once installed — where SKILL.md -> ../../credentials.json
  // is a skill body that reads the operator's secrets.
  await writeFile(path.join(source, 'secret.txt'), 'SECRET');
  await mkdir(path.join(source, 'evil'), { recursive: true });
  await writeFile(path.join(source, 'evil', 'SKILL.md'), specSkill('evil', 'Use for evil.'));
  await symlink(path.join('..', 'secret.txt'), path.join(source, 'evil', 'notes.txt'));

  // An absolute link is refused even when it currently resolves inside
  // the skill: preserved verbatim, it is pinned to this checkout's path —
  // dangling the moment a cloned source is cleaned up.
  await mkdir(path.join(source, 'absin'), { recursive: true });
  await writeFile(path.join(source, 'absin', 'SKILL.md'), specSkill('absin', 'Use for absin.'));
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
  await writeFile(path.join(source, 'toolful', 'SKILL.md'), specSkill('toolful', 'Use for toolful things.'));
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
  await writeFile(path.join(source, 'evil', 'SKILL.md'), specSkill('evil', 'Use for evil.'));
  await symlink(path.join('..', '..', 'credentials.json'), path.join(source, 'evil', 'notes'));
  // An absolute dangling target is somebody's machine by construction.
  await mkdir(path.join(source, 'abs'), { recursive: true });
  await writeFile(path.join(source, 'abs', 'SKILL.md'), specSkill('abs', 'Use for abs.'));
  await symlink('/etc/does-not-exist-here', path.join(source, 'abs', 'notes'));
  // A dangling link that stays inside its skill is a broken decoration,
  // not a reason to refuse the skill.
  await mkdir(path.join(source, 'benign'), { recursive: true });
  await writeFile(path.join(source, 'benign', 'SKILL.md'), specSkill('benign', 'Use for benign.'));
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
  await writeFile(path.join(source, 'one', 'SKILL.md'), specSkill('one', 'Use for one, v1.'));

  const homeDir = await freshHome();
  const env = { homeDir };
  await installSkillsFromDirectory(env, source);

  // v2 is hostile: refused before the installed v1 is touched.
  await writeFile(path.join(source, 'one', 'SKILL.md'), specSkill('one', 'Use for one, v2.'));
  await writeFile(path.join(source, 'outside.txt'), 'x');
  await symlink(path.join('..', 'outside.txt'), path.join(source, 'one', 'esc.txt'));
  const result = await installSkillsFromDirectory(env, source, { force: true });
  assert.deepEqual(result.installed, []);
  assert.match(result.skipped[0]?.reason ?? '', /symlink reaching outside/);

  const registry = new SkillRegistry();
  const loaded = await loadOperatorSkills(env, registry, () => {});
  assert.equal(loaded[0]?.description, 'Use for one, v1.');
});

test('a repository whose root is the skill installs under its frontmatter name; a nameless one is refused and told the name to add', async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), 'stratus-skillroot-XYZ'));
  await writeFile(
    path.join(source, 'SKILL.md'),
    '---\nname: pr-review\ndescription: Use when reviewing pull requests.\n---\n\nBody.\n',
  );

  const homeDir = await freshHome();
  // The frontmatter name wins at the root even over a valid rootId — the
  // checkout location is circumstance; the name is the skill's own, and
  // the spec's directory check does not apply to a checkout.
  const named = await installSkillsFromDirectory({ homeDir }, source, { rootId: 'my-skills' });
  assert.deepEqual(named.installed.map((skill) => skill.id), ['pr-review']);

  // The spec requires a name, so a nameless root skill is refused — and
  // the refusal suggests the rootId (for a cloned source, the
  // repository's name), never the temp directory git landed in.
  const nameless = await mkdtemp(path.join(os.tmpdir(), 'stratus-skillroot-XYZ'));
  await writeFile(
    path.join(nameless, 'SKILL.md'),
    '---\ndescription: Use when reviewing pull requests.\n---\n\nBody.\n',
  );
  const refused = await installSkillsFromDirectory({ homeDir }, nameless, { rootId: 'my-skills' });
  assert.deepEqual(refused.installed, []);
  assert.equal(refused.skipped.length, 1);
  assert.match(refused.skipped[0]?.reason ?? '', /no "name"/);
  assert.match(refused.skipped[0]?.reason ?? '', /add: name: my-skills/);
  assert.ok(!(refused.skipped[0]?.reason ?? '').includes('XYZ'), 'suggested the temp directory');
});

test('a skill that does not conform to the spec is refused at install, naming every problem', async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), 'stratus-skillspec-'));
  // No name: the directory would supply one, and the spec still requires
  // it written down — the refusal says exactly what to add.
  await mkdir(path.join(source, 'nameless'), { recursive: true });
  await writeFile(path.join(source, 'nameless', 'SKILL.md'), skillFile('Use for nameless things.'));
  // A name that is not its directory's.
  await mkdir(path.join(source, 'pdf'), { recursive: true });
  await writeFile(path.join(source, 'pdf', 'SKILL.md'), specSkill('pdf-processing', 'Use for PDFs.'));
  // A name that is not an id at all, and a description past the ceiling.
  await mkdir(path.join(source, 'Code Review'), { recursive: true });
  await writeFile(
    path.join(source, 'Code Review', 'SKILL.md'),
    `---\nname: Code Review\ndescription: ${'x'.repeat(1025)}\n---\n\nBody.\n`,
  );
  // And one that conforms, so refusing is per skill.
  await mkdir(path.join(source, 'fine'), { recursive: true });
  await writeFile(path.join(source, 'fine', 'SKILL.md'), specSkill('fine', 'Use for fine things.'));

  const homeDir = await freshHome();
  const result = await installSkillsFromDirectory({ homeDir }, source);

  assert.deepEqual(result.installed.map((skill) => skill.id), ['fine']);
  assert.deepEqual(result.warnings, []);
  const reasons = new Map(result.skipped.map((skip) => [skip.id, skip.reason]));
  assert.match(reasons.get('nameless') ?? '', /no "name".*add: name: nameless/);
  assert.match(reasons.get('pdf') ?? '', /"pdf-processing" does not match the directory name "pdf"/);
  const both = reasons.get('Code Review') ?? '';
  assert.match(both, /"Code Review" is not a skill id/);
  assert.match(both, /description is 1025 characters, past the spec's ceiling of 1024/);
  // Nothing landed for the refused ones.
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual((await readdir(skillsDirPath({ homeDir }))).sort(), ['fine']);
});

test('what installs with a caveat says so: foreign keys, the legacy key form, a bundled scripts/', async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), 'stratus-skillwarn-'));
  // A skill published for another host: its fields, and its scripts.
  await mkdir(path.join(source, 'pdf', 'scripts', 'lib'), { recursive: true });
  await writeFile(
    path.join(source, 'pdf', 'SKILL.md'),
    '---\nname: pdf\ndescription: Use for PDFs.\nargument-hint: "[file]"\ndisable-model-invocation: true\nallowed-tools: Bash(python:*)\nlicense: MIT\n---\n\nRun scripts/extract.py.\n',
  );
  await writeFile(path.join(source, 'pdf', 'scripts', 'extract.py'), 'print(1)');
  await writeFile(path.join(source, 'pdf', 'scripts', 'lib', 'util.py'), 'x = 1');
  // A skill written for Stratus before the spec: top-level requires.
  await mkdir(path.join(source, 'review'), { recursive: true });
  await writeFile(
    path.join(source, 'review', 'SKILL.md'),
    '---\nname: review\ndescription: Use when reviewing.\nrequires:\n  - fs.*\n---\n\nBody.\n',
  );

  const homeDir = await freshHome();
  const result = await installSkillsFromDirectory({ homeDir }, source);

  assert.deepEqual(result.installed.map((skill) => skill.id), ['pdf', 'review']);
  assert.deepEqual(result.skipped, []);
  const pdfWarnings = result.warnings.filter((warning) => warning.id === 'pdf').map((warning) => warning.message);
  assert.equal(pdfWarnings.length, 2, pdfWarnings.join('\n'));
  // The spec's own keys (license, allowed-tools) are not foreign; the
  // other host's are, named in file order.
  assert.match(pdfWarnings[0] ?? '', /keys outside the Agent Skills spec: "argument-hint", "disable-model-invocation"/);
  assert.match(pdfWarnings[1] ?? '', /bundles scripts\/ \(2 files\)/);
  assert.match(pdfWarnings[1] ?? '', /shell\.run gate/);
  const reviewWarnings = result.warnings.filter((warning) => warning.id === 'review').map((warning) => warning.message);
  assert.equal(reviewWarnings.length, 1);
  assert.match(reviewWarnings[0] ?? '', /top-level "requires".*metadata\.requires/);
  // The legacy form still reads: the advisory requirement survives the install.
  assert.deepEqual(result.installed[1]?.requires, ['fs.*']);
  // And the scripts travelled — inert files, but the skill's own.
  await readFile(path.join(skillsDirPath({ homeDir }), 'pdf', 'scripts', 'extract.py'), 'utf8');
});

test('the spec form of the Stratus extensions reads: metadata.requires and metadata.version', async () => {
  const homeDir = await freshHome();
  const env = { homeDir };
  const dir = path.join(skillsDirPath(env), 'browse');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'SKILL.md'),
    '---\nname: browse\ndescription: Use when browsing.\nmetadata:\n  version: "2.0.0"\n  requires: browser.* fs.read\n---\n\nBody.\n',
  );
  const registry = new SkillRegistry();
  const loaded = await loadOperatorSkills(env, registry, () => assert.fail('nothing to warn about'));
  assert.deepEqual(loaded[0]?.requires, ['browser.*', 'fs.read']);
  assert.deepEqual(registry.resolve('browse')?.requires, ['browser.*', 'fs.read']);

  // Validation of the installed copy is clean: this is the form that ports.
  const validation = await validateSkillDirectory(dir, { directoryName: 'browse' });
  assert.deepEqual(validation.errors, []);
  assert.deepEqual(validation.warnings, []);
  assert.equal(validation.document?.version, '2.0.0');
});

test('validateSkillDirectory and discovery agree: a directory without SKILL.md is an error, not a skill', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stratus-skillempty-'));
  const validation = await validateSkillDirectory(dir);
  assert.equal(validation.document, undefined);
  assert.match(validation.errors[0] ?? '', /no SKILL\.md/);
  const discovered = await discoverSkillsInDirectory(dir);
  assert.deepEqual(discovered, { candidates: [], skipped: [] });
});
