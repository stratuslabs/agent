import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createLazySkill,
  formatSoul,
  isValidSkillId,
  parseSkillDocument,
  parseSoul,
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
  assert.ok(document.body.startsWith('# PDF tools'));
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

test('skill ids are kebab-case', () => {
  assert.equal(isValidSkillId('web-research'), true);
  assert.equal(isValidSkillId('code-review-2'), true);
  assert.equal(isValidSkillId('Code-Review'), false);
  assert.equal(isValidSkillId('-leading'), false);
  assert.equal(isValidSkillId('a/b'), false);
  assert.equal(isValidSkillId(''), false);
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
