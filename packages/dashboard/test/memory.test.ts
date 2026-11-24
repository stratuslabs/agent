import test from 'node:test';
import assert from 'node:assert/strict';

import { memoryMarks, memoryMatches } from '../ui/lib/memory.js';

test('the memory filter wants every word, from the text, the topics or the kind, in any case', () => {
  const entry = { content: 'Dylan prefers short replies.', about: ['Dylan', 'communication'], kind: 'preference' };
  assert.equal(memoryMatches(entry, ''), true);
  assert.equal(memoryMatches(entry, '   '), true);
  assert.equal(memoryMatches(entry, 'SHORT'), true);
  assert.equal(memoryMatches(entry, 'communication'), true, 'a topic matches');
  assert.equal(memoryMatches(entry, 'preference dylan'), true, 'words from different places');
  assert.equal(memoryMatches(entry, 'short deploy'), false, 'every word, not any');
});

test('a fact is marked pinned, out of its window, and by a source that may not be the operator', () => {
  assert.deepEqual(memoryMarks({ content: 'x', trust: 'user', validity: 'current' }), []);
  assert.deepEqual(memoryMarks({ content: 'x', trust: 'agent', validity: 'current' }), []);
  assert.deepEqual(
    memoryMarks({ content: 'x', pinned: true, validity: 'expired', trust: 'external' }).map((mark) => mark.label),
    ['Pinned', 'Expired', 'From outside content'],
  );
  assert.deepEqual(memoryMarks({ content: 'x', validity: 'not-yet-valid', trust: 'unknown' }).map((mark) => mark.label), ['Not true yet', 'Unknown source']);
});
