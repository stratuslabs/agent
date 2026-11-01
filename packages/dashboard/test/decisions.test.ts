import test from 'node:test';
import assert from 'node:assert/strict';

import { decisionNote, decisionTone, settledLines, shadowLineIndex } from '../ui/lib/decisions.js';

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

// Card 1053: a shadow decision lands off the call path, often after its
// line, and sometimes after its turn has ended.

const line = (callId: string, toolName: string, extra: Record<string, unknown> = {}) =>
  ({ text: `running ${toolName}…`, callId, toolName, decides: true, ...extra });
const shadow = { allowed: true, layer: 'review', reason: 'r', verdict: 'block' as const, reviewCode: 'not-asked-for', shadow: true };

test('a shadow decision joins the earliest line for its call and tool still without one', () => {
  const lines = [
    line('tool-call-1', 'shell.run', { shadow }),
    { text: 'shell.run finished', callId: 'tool-call-1', toolName: 'shell.run', decides: false },
    line('tool-call-1', 'web.fetch'),
    line('tool-call-1', 'shell.run'),
  ];
  // The id recurs per response: the web.fetch call is another call.
  assert.equal(shadowLineIndex(lines, 'tool-call-1', 'shell.run'), 3);
  assert.equal(shadowLineIndex(lines, 'tool-call-1', 'web.fetch'), 2);
  assert.equal(shadowLineIndex(lines, 'tool-call-2', 'shell.run'), -1);
});

const user = (content: string) => ({ role: 'user', content });
const tool = (callId: string, toolName: string) =>
  ({ role: 'tool', content: '{}', toolResult: { callId, toolName, ok: true, output: null } });

test("a finished turn's lines are matched to its stored results, and never to an earlier turn's", () => {
  const messages = [
    user('earlier'),
    { role: 'assistant', content: '' },
    tool('tool-call-1', 'shell.run'),
    { role: 'assistant', content: 'done' },
    user('now'),
    { role: 'assistant', content: '' },
    tool('tool-call-1', 'shell.run'),
    tool('tool-call-2', 'web.fetch'),
    { role: 'assistant', content: '' },
    tool('tool-call-1', 'shell.run'),
    { role: 'assistant', content: 'done' },
  ];
  const first = line('tool-call-1', 'shell.run');
  const second = line('tool-call-2', 'web.fetch');
  const third = line('tool-call-1', 'shell.run');
  const finished = { text: 'shell.run finished', callId: 'tool-call-1', toolName: 'shell.run', decides: false };
  const matched = settledLines(messages, [first, finished, second, third]);
  assert.deepEqual([...matched.entries()].sort(([a], [b]) => a - b), [[6, first], [7, second], [9, third]]);

  // A line whose result was never stored stops at the turn's own message:
  // the earlier turn's result with the same id is not this call's.
  const lost = line('tool-call-9', 'shell.run');
  const onlyLost = settledLines(messages.slice(0, 6), [first, lost]);
  assert.deepEqual([...onlyLost.entries()], []);

  // A result is matched by tool as well as id: a later call to another
  // tool under a reused id, with no stored result, takes nothing.
  const unsaved = line('tool-call-1', 'web.fetch');
  assert.deepEqual([...settledLines([user('now'), tool('tool-call-1', 'shell.run')], [first, unsaved]).entries()], [[1, first]]);

  // Before the reload lands, the transcript still ends with the message
  // that started the turn: nothing is matched yet.
  assert.deepEqual([...settledLines([...messages.slice(0, 4), user('now')], [first]).entries()], []);
});
