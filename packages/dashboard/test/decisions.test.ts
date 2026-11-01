import test from 'node:test';
import assert from 'node:assert/strict';

import { decisionNote, decisionTone } from '../ui/lib/decisions.js';

const base = { allowed: true, layer: 'grant', reason: 'shell.run ran under a standing grant' };

test('a decision beside a call says what was decided and which check decided it', () => {
  assert.equal(decisionNote(base), 'allowed · grant');
  assert.equal(decisionNote({ ...base, allowed: false, layer: 'scope' }), 'refused · scope');
});

test("a reviewer's decision leads with its verdict and ends with its code", () => {
  assert.equal(
    decisionNote({ ...base, allowed: false, layer: 'review', verdict: 'block', reviewCode: 'not-asked-for' }),
    'block · review · not-asked-for',
  );
});

test('a shadow decision says what it would have done, since the call ran either way', () => {
  assert.equal(
    decisionNote({ ...base, layer: 'review', verdict: 'block', reviewCode: 'follows-outside-content', shadow: true }),
    'would have blocked · review · follows-outside-content',
  );
  assert.equal(decisionNote({ ...base, layer: 'review', verdict: 'ask', shadow: true }), 'would have asked · review');
  assert.equal(decisionNote({ ...base, layer: 'review', verdict: 'allow', shadow: true }), 'would have allowed · review');
});

test('the tone marks refusals and shadow decisions that would have stopped the call', () => {
  assert.equal(decisionTone(base), 'ok');
  assert.equal(decisionTone({ ...base, allowed: false }), 'bad');
  assert.equal(decisionTone({ ...base, verdict: 'ask', shadow: true }), 'warn');
  assert.equal(decisionTone({ ...base, verdict: 'allow', shadow: true }), 'ok');
});

test('a shadow decision is never shown as a refusal: the policy reports it refused, but the call ran', () => {
  // The review posture reports a shadow block with allowed false (it is what
  // would have happened); nothing was refused, so it reads as a warning.
  const shadowBlock = { ...base, allowed: false, layer: 'review', verdict: 'block' as const, reviewCode: 'not-asked-for', shadow: true };
  assert.equal(decisionTone(shadowBlock), 'warn');
  assert.equal(decisionNote(shadowBlock), 'would have blocked · review · not-asked-for');
  // A shadow decision with no verdict (a rule step, "not reviewed") still says it was shadow.
  assert.equal(decisionNote({ ...base, layer: 'risk', shadow: true }), 'shadow: allowed · risk');
  assert.equal(decisionTone({ ...base, allowed: false, layer: 'review', shadow: true }), 'warn');
});
