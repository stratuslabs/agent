import test from 'node:test';
import assert from 'node:assert/strict';

import { TEXTS_MAX_MESSAGES, textingParts } from '../src/texts.ts';

test('a one-paragraph reply stays one message', () => {
  assert.deepEqual(textingParts('On it. Checking the three PRs now.'), ['On it. Checking the three PRs now.']);
});

test('a reply splits at its blank lines, in order', () => {
  assert.deepEqual(
    textingParts('Main is green again.\n\nThe flaky test was a timeout.\n\nI raised it to 10 s.'),
    ['Main is green again.', 'The flaky test was a timeout.', 'I raised it to 10 s.'],
  );
});

test('a single line break is part of the message, not a split', () => {
  assert.deepEqual(textingParts('First line\nsecond line'), ['First line\nsecond line']);
});

test('runs of blank lines and whitespace-only lines make no empty messages', () => {
  assert.deepEqual(textingParts('\n\nOne.\n \n\t\n\nTwo.  \n\n'), ['One.', 'Two.']);
});

test('a code block with blank lines inside it stays whole', () => {
  const code = '```ts\nconst a = 1;\n\nconst b = 2;\n```';
  assert.deepEqual(textingParts(`Here is the fix.\n\n${code}\n\nThat is all.`), ['Here is the fix.', code, 'That is all.']);
});

test('an unclosed code block keeps the rest of the reply with it', () => {
  assert.deepEqual(textingParts('The log follows.\n\n```\nline one\n\nline two'), ['The log follows.', '```\nline one\n\nline two']);
});

test('a list whose items are separated by blank lines stays one message', () => {
  assert.deepEqual(
    textingParts('Two things.\n\n- first\n\n- second\n\n1. third\n\nDone.'),
    ['Two things.', '- first\n\n- second\n\n1. third', 'Done.'],
  );
});

test('a line ending in a colon stays with what it introduces', () => {
  assert.deepEqual(
    textingParts('Here is what changed:\n\n- the cap\n- the docs\n\nShip it?'),
    ['Here is what changed:\n\n- the cap\n- the docs', 'Ship it?'],
  );
});

test('an emoji at the end of a paragraph is not an introduction', () => {
  assert.deepEqual(textingParts('Shipped :tada:\n\nNext up is 949.'), ['Shipped :tada:', 'Next up is 949.']);
});

test('a heading on its own stays with the paragraph under it', () => {
  assert.deepEqual(textingParts('## Result\n\nAll green.\n\nNext up is 949.'), ['## Result\n\nAll green.', 'Next up is 949.']);
});

test('an indented block stays with the one above it', () => {
  assert.deepEqual(
    textingParts('- step one\n\n    more about step one\n\nAfter.'),
    ['- step one\n\n    more about step one', 'After.'],
  );
});

test(`a long reply is at most ${TEXTS_MAX_MESSAGES} messages, the rest kept together in the last`, () => {
  const paragraphs = Array.from({ length: TEXTS_MAX_MESSAGES + 3 }, (_, index) => `Paragraph ${index + 1}.`);
  const parts = textingParts(paragraphs.join('\n\n'));
  assert.equal(parts.length, TEXTS_MAX_MESSAGES);
  assert.deepEqual(parts.slice(0, -1), paragraphs.slice(0, TEXTS_MAX_MESSAGES - 1));
  assert.equal(parts.at(-1), paragraphs.slice(TEXTS_MAX_MESSAGES - 1).join('\n\n'));
});

test('a reply with nothing in it is passed through unchanged', () => {
  assert.deepEqual(textingParts(''), ['']);
  assert.deepEqual(textingParts(' \n\n '), [' \n\n ']);
});
