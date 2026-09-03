import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createLazySkill,
  formatSoul,
  isLoadableSkillId,
  isValidSkillId,
  parseSkillDocument,
  parseSoul,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_ID_MAX_LENGTH,
  validateSkillDocument,
} from '../src/index.ts';

// The shape of the existing skill repositories (stratuslabs/skill-code-review,
// stratuslabs/skill-web-research): frontmatter in the soul dialect, then a
// long markdown procedure. The body loads verbatim — "unmodified except for
// frontmatter" is the acceptance criterion this fixture stands in for.
const CODE_REVIEW_SKILL = `---
name: Code Review
description: Use when reviewing a diff or a pull request for correctness, style, and risk.
version: 1.2.0
requires:
  - fs.*
---

# Code review

Review in this order, and never skip a step because the diff looks small.

## 1. Understand the change

Read the description first, then the diff. State what the change claims to
do in one sentence before judging how it does it.

## 2. Correctness

- Trace every changed code path with a hostile input in mind.
- Check error handling on the paths the diff touches.

## 3. Answer format

Lead with the verdict, then findings ordered by severity, each with a
file:line reference and a suggested fix.
`;

test('a realistic SKILL.md parses: identity from frontmatter, procedure untouched', () => {
  const document = parseSkillDocument(CODE_REVIEW_SKILL);
  assert.equal(document.name, 'Code Review');
  assert.equal(document.description, 'Use when reviewing a diff or a pull request for correctness, style, and risk.');
  assert.equal(document.version, '1.2.0');
  assert.deepEqual(document.requires, ['fs.*']);
  assert.ok(document.body.startsWith('# Code review'));
  assert.ok(document.body.includes('hostile input in mind'));
  // The body is the file minus the frontmatter, not a rewrite of it.
  assert.equal(document.body, CODE_REVIEW_SKILL.split('---\n')[2]!.trim());
});

test('a skill without a description is refused — routing runs on it', () => {
  assert.throws(
    () => parseSkillDocument('---\nname: Vague\n---\n\nSome procedure.'),
    /no "description"/,
  );
  assert.throws(() => parseSkillDocument('No frontmatter at all.'), /no frontmatter/);
  // A block-scalar description with no body reads as absent, never as an
  // empty string that satisfies the requirement.
  assert.throws(
    () => parseSkillDocument('---\nname: x\ndescription: >-\n---\n\nBody.'),
    /no "description"/,
  );
});

test('ecosystem frontmatter parses: unknown keys and their blocks skip, block scalars fold', () => {
  // The shape skills published to skills.sh and similar registries wear:
  // fields other hosts own, nested metadata, a folded description.
  const document = parseSkillDocument(`---
name: pdf-tools
description: >-
  Use when working with PDF files —
  merging, splitting, or extracting text.
license: MIT
allowed-tools:
  - Read
  - Bash
metadata:
  internal: false
  author: someone
version: 2.0.1
---

# PDF tools

The procedure.
`);
  assert.equal(document.name, 'pdf-tools');
  assert.equal(
    document.description,
    'Use when working with PDF files — merging, splitting, or extracting text.',
  );
  assert.equal(document.version, '2.0.1');
  // Another host's tool names are not our `requires` vocabulary — ignored,
  // not mapped into false advisory warnings.
  assert.equal(document.requires, undefined);
  assert.equal(document.license, 'MIT');
  assert.deepEqual(document.metadata, { internal: 'false', author: 'someone' });
  // The spec's keys are not unknown; the legacy top-level version is
  // reported, so validation can name the form that ports.
  assert.deepEqual(document.unknownKeys, ['version']);
  assert.ok(document.body.startsWith('# PDF tools'));
});

test('the Stratus extensions read from metadata, the spec\'s home for host fields', () => {
  const document = parseSkillDocument(`---
name: browse
description: Use when browsing a site.
compatibility: Needs a browser plugin.
metadata:
  version: "2.0.0"
  requires: browser.* fs.read
  # a comment inside the map is skipped
  author: someone
---

Body.
`);
  assert.equal(document.version, '2.0.0');
  assert.deepEqual(document.requires, ['browser.*', 'fs.read']);
  assert.equal(document.compatibility, 'Needs a browser plugin.');
  assert.deepEqual(document.metadata, { version: '2.0.0', requires: 'browser.* fs.read', author: 'someone' });
  assert.deepEqual(document.unknownKeys, []);

  // Top-level keys keep reading — what is installed keeps working — and
  // metadata wins when both are written.
  const both = parseSkillDocument(
    '---\nname: x\ndescription: d\nversion: 1.0.0\nrequires: [fs.*]\nmetadata:\n  version: "2.0.0"\n---\n\nBody.',
  );
  assert.equal(both.version, '2.0.0');
  assert.deepEqual(both.requires, ['fs.*']);
  assert.deepEqual(both.unknownKeys, ['version', 'requires']);

  // An empty flow map is fine; a nested block under metadata is not a
  // string value and is refused rather than half-read.
  assert.deepEqual(parseSkillDocument('---\ndescription: d\nmetadata: {}\n---\n\nBody.').metadata, {});
  assert.throws(
    () => parseSkillDocument('---\ndescription: d\nmetadata:\n  nested:\n    deep: 1\n---\n\nBody.'),
    /metadata entries must be "key: value" strings/,
  );
  assert.throws(
    () => parseSkillDocument('---\ndescription: d\nmetadata: {a: b}\n---\n\nBody.'),
    /must be a block of indented/,
  );
});

test('unknown keys are reported in file order, and the spec\'s own keys never are', () => {
  const document = parseSkillDocument(`---
name: pdf
description: Use for PDFs.
argument-hint: "[file]"
license: MIT
allowed-tools: Bash(python:*) Read
disable-model-invocation: true
hooks:
  PreToolUse:
    - matcher: Bash
---

Body.
`);
  assert.deepEqual(document.unknownKeys, ['argument-hint', 'disable-model-invocation', 'hooks']);
});

test('validateSkillDocument enforces what the spec constrains, and warns about the rest', () => {
  const parse = (frontmatter: string) => parseSkillDocument(`---\n${frontmatter}\n---\n\nBody.`);

  // A conforming skill is clean.
  assert.deepEqual(
    validateSkillDocument(parse('name: code-review\ndescription: Use when reviewing.'), { directoryName: 'code-review' }),
    { errors: [], warnings: [] },
  );

  // name: required, an id, the directory's.
  const nameless = validateSkillDocument(parse('description: d'), { directoryName: 'code-review' });
  assert.match(nameless.errors[0] ?? '', /no "name".*add: name: code-review/);
  const suggested = validateSkillDocument(parse('description: d'), { suggestedName: 'my-repo' });
  assert.match(suggested.errors[0] ?? '', /add: name: my-repo/);
  assert.match(
    validateSkillDocument(parse('name: Code Review\ndescription: d')).errors[0] ?? '',
    /"Code Review" is not a skill id/,
  );
  assert.match(
    validateSkillDocument(parse('name: pdf-processing\ndescription: d'), { directoryName: 'pdf' }).errors[0] ?? '',
    /does not match the directory name "pdf"/,
  );
  // No directory to match against: a root skill's name stands alone.
  assert.deepEqual(validateSkillDocument(parse('name: pdf-processing\ndescription: d')).errors, []);

  // The ceilings.
  const long = validateSkillDocument(parse(`name: x\ndescription: ${'d'.repeat(SKILL_DESCRIPTION_MAX_LENGTH + 1)}`));
  assert.match(long.errors[0] ?? '', /description is 1025 characters, past the spec's ceiling of 1024/);
  assert.deepEqual(
    validateSkillDocument(parse(`name: x\ndescription: ${'d'.repeat(SKILL_DESCRIPTION_MAX_LENGTH)}`)).errors,
    [],
  );
  const compat = validateSkillDocument(parse(`name: x\ndescription: d\ncompatibility: ${'c'.repeat(501)}`));
  assert.match(compat.errors[0] ?? '', /compatibility is 501 characters, past the spec's ceiling of 500/);

  // Warnings: the legacy Stratus keys name the metadata form; other
  // hosts' keys are named and called ignored. Neither refuses.
  const legacy = validateSkillDocument(parse('name: x\ndescription: d\nversion: 1.0.0\nrequires:\n  - fs.*'));
  assert.deepEqual(legacy.errors, []);
  assert.equal(legacy.warnings.length, 2);
  assert.match(legacy.warnings[0] ?? '', /top-level "version".*metadata\.version/);
  assert.match(legacy.warnings[1] ?? '', /top-level "requires".*metadata\.requires.*"browser\.\* fs\.read"/);
  const foreign = validateSkillDocument(parse('name: x\ndescription: d\nargument-hint: f\nmodel: opus'));
  assert.deepEqual(foreign.errors, []);
  assert.equal(foreign.warnings.length, 1);
  assert.match(foreign.warnings[0] ?? '', /keys outside the Agent Skills spec: "argument-hint", "model"\. Another host's; ignored here/);
});

test('a plain description wrapping onto indented lines folds; a literal block keeps its breaks', () => {
  const wrapped = parseSkillDocument(
    '---\ndescription: Use when the task\n  spans two lines.\n---\n\nBody.',
  );
  assert.equal(wrapped.description, 'Use when the task spans two lines.');

  const literal = parseSkillDocument(
    '---\ndescription: |\n  line one\n  line two\n---\n\nBody.',
  );
  assert.equal(literal.description, 'line one\nline two');
});

test('a literal block keeps its blank and #-prefixed lines — they are content, not comments', () => {
  const document = parseSkillDocument(
    '---\ndescription: |\n  first\n\n  # heading\n  last\n---\n\nBody.',
  );
  assert.equal(document.description, 'first\n\n# heading\nlast');

  // In a folded block a blank line is a paragraph break, not the end of
  // the value — and the line after it still belongs to the description.
  const folded = parseSkillDocument(
    '---\ndescription: >-\n  first part\n\n  second part\n---\n\nBody.',
  );
  assert.equal(folded.description, 'first part\nsecond part');
});

test('block-scalar headers with indicators or trailing comments are recognized', () => {
  const commented = parseSkillDocument(
    '---\ndescription: >- # routing text\n  Use when the task\n  spans lines.\n---\n\nBody.',
  );
  assert.equal(commented.description, 'Use when the task spans lines.');

  const indented = parseSkillDocument(
    '---\ndescription: |2-\n  line one\n  line two\n---\n\nBody.',
  );
  assert.equal(indented.description, 'line one\nline two');

  const chompFirst = parseSkillDocument(
    '---\ndescription: >-2\n  folded text\n---\n\nBody.',
  );
  assert.equal(chompFirst.description, 'folded text');
});

test('souls stay strict: an unknown soul key is still refused', () => {
  assert.throws(
    () => parseSoul('---\nname: Ava\nunknown-key: nope\n---\n\nPersona.'),
    /Unknown soul frontmatter key/,
  );
});

test('skill ids follow the spec\'s name rule: hyphen-separated lowercase runs, at most 64 characters', () => {
  assert.equal(isValidSkillId('web-research'), true);
  assert.equal(isValidSkillId('code-review-2'), true);
  assert.equal(isValidSkillId('a'), true);
  assert.equal(isValidSkillId('a'.repeat(SKILL_ID_MAX_LENGTH)), true);
  assert.equal(isValidSkillId('Code-Review'), false);
  assert.equal(isValidSkillId('-leading'), false);
  assert.equal(isValidSkillId('trailing-'), false);
  assert.equal(isValidSkillId('double--hyphen'), false);
  assert.equal(isValidSkillId('a'.repeat(SKILL_ID_MAX_LENGTH + 1)), false);
  assert.equal(isValidSkillId('a/b'), false);
  assert.equal(isValidSkillId(''), false);

  // What is already on the machine is judged by the rule it was written
  // under, so an upgrade never drops a directory that loaded yesterday.
  assert.equal(isLoadableSkillId('double--hyphen'), true);
  assert.equal(isLoadableSkillId('trailing-'), true);
  assert.equal(isLoadableSkillId('a'.repeat(SKILL_ID_MAX_LENGTH + 1)), true);
  assert.equal(isLoadableSkillId('Code-Review'), false);
  assert.equal(isLoadableSkillId('-leading'), false);
  assert.equal(isLoadableSkillId(''), false);
});

test('metadata keys are any string: quoted, or bare up to the colon', () => {
  const document = parseSkillDocument(
    '---\ndescription: d\nmetadata:\n  "vendor/key": one\n  \'123\': two\n  dotted.key: three\n  "quoted: colon": four\n---\n\nBody.',
  );
  assert.deepEqual(document.metadata, {
    'vendor/key': 'one',
    '123': 'two',
    'dotted.key': 'three',
    'quoted: colon': 'four',
  });
});

test('the ceilings count characters, not UTF-16 units — an emoji is one', () => {
  const parse = (frontmatter: string) => parseSkillDocument(`---\n${frontmatter}\n---\n\nBody.`);
  // 600 emoji: 1200 UTF-16 units, 600 characters — under the ceiling, as
  // the reference validator (Python len()) would count it.
  const emoji = validateSkillDocument(parse(`name: x\ndescription: ${'😀'.repeat(600)}`));
  assert.deepEqual(emoji.errors, []);
  const over = validateSkillDocument(parse(`name: x\ndescription: ${'😀'.repeat(1025)}`));
  assert.match(over.errors[0] ?? '', /description is 1025 characters/);
  const compat = validateSkillDocument(parse(`name: x\ndescription: d\ncompatibility: ${'😀'.repeat(500)}`));
  assert.deepEqual(compat.errors, []);
});

test('a lazy skill reads on demand and re-parses, so an edited body is picked up', async () => {
  let source = CODE_REVIEW_SKILL;
  let reads = 0;
  const skill = createLazySkill({
    id: 'code-review',
    document: parseSkillDocument(source),
    read: async () => {
      reads += 1;
      return source;
    },
  });

  assert.equal(skill.name, 'Code Review');
  assert.equal(reads, 0, 'identity must not cost a read');
  assert.ok((await skill.load()).startsWith('# Code review'));

  source = source.replace('# Code review', '# Code review, revised');
  assert.ok((await skill.load()).startsWith('# Code review, revised'));
});

test('skills: in soul frontmatter is an allowlist like tools:, and omitted means none', () => {
  const soul = parseSoul(`---
name: Ava
skills:
  - code-review
  - stratus-plugin-github:*
---

You review code.
`);
  assert.deepEqual(soul.agent.skills, ['code-review', 'stratus-plugin-github:*']);

  const bare = parseSoul('Just prose.', { seed: 'x' });
  assert.equal(bare.agent.skills, undefined);
});

test('formatSoul round-trips the skills list', () => {
  const soul = parseSoul(`---
name: Ava
tools:
  - fs.*
skills:
  - code-review
---

Persona.
`);
  const reparsed = parseSoul(formatSoul(soul));
  assert.deepEqual(reparsed.agent.skills, ['code-review']);
  assert.deepEqual(reparsed.agent.tools, ['fs.*']);
});
