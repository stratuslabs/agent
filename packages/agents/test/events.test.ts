import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_EVENT_MAX_PER_HOUR,
  describeCadence,
  isWithinQuietHours,
  matchesEventFilter,
  nextFireAfter,
  parseEventFilter,
  parseQuietHours,
  type EventFilter,
  type InboundEvent,
} from '../src/index.ts';

// A Codex review result on one of Atlas's PRs, as the GitHub mapping produces
// it: the shape the spec's example trigger is written against.
const codexReview: InboundEvent = {
  attributes: {
    specversion: '1.0',
    id: '9b2c6a10-0000-4000-8000-000000000001',
    source: 'https://github.com/stratuslabs/agent',
    type: 'com.github.pull_request_review.submitted',
    subject: 'pull/470',
    actor: 'chatgpt-codex-connector[bot]',
    author: 'atlasatstratuslabs[bot]',
  },
  data: {
    action: 'submitted',
    review: { body: '<!-- codex-review-receipt:v1 -->\n\n### Codex Review', state: 'commented' },
    pull_request: { number: 470 },
  },
};

const codexTrigger = {
  all: [
    { exact: { actor: 'chatgpt-codex-connector[bot]', author: 'atlasatstratuslabs[bot]' } },
    { any: [
      { prefix: { type: 'com.github.pull_request_review.submitted', 'data.review.body': '<!-- codex-review-receipt:v1 -->' } },
      { prefix: { type: 'com.github.issue_comment.created', 'data.comment.body': '<!-- codex-review-receipt:v1 -->' } },
    ] },
  ],
};

test("the spec's Codex trigger matches a Codex review result on the agent's own PR", () => {
  const filter = parseEventFilter(codexTrigger);
  assert.equal(matchesEventFilter(filter, codexReview), true);
});

test("the Codex trigger ignores Codex's in-progress summary, another author's PR, and a person's review", () => {
  const filter = parseEventFilter(codexTrigger);
  const summary: InboundEvent = {
    attributes: { ...codexReview.attributes, type: 'com.github.issue_comment.created' },
    data: { comment: { body: '<!-- codex-pull-request-review-summary -->\nWorking…' } },
  };
  const blairsPr: InboundEvent = {
    attributes: { ...codexReview.attributes, author: 'blairatstratuslabs[bot]' },
    ...(codexReview.data !== undefined ? { data: codexReview.data } : {}),
  };
  const person: InboundEvent = {
    attributes: { ...codexReview.attributes, actor: 'dylan' },
    ...(codexReview.data !== undefined ? { data: codexReview.data } : {}),
  };
  assert.equal(matchesEventFilter(filter, summary), false);
  assert.equal(matchesEventFilter(filter, blairsPr), false);
  assert.equal(matchesEventFilter(filter, person), false);
});

test('exact, prefix and suffix compare case-sensitively, and every key in one expression must match', () => {
  assert.equal(matchesEventFilter(parseEventFilter({ exact: { subject: 'pull/470' } }), codexReview), true);
  assert.equal(matchesEventFilter(parseEventFilter({ exact: { subject: 'PULL/470' } }), codexReview), false);
  assert.equal(matchesEventFilter(parseEventFilter({ prefix: { type: 'com.github.' } }), codexReview), true);
  assert.equal(matchesEventFilter(parseEventFilter({ suffix: { type: '.submitted' } }), codexReview), true);
  assert.equal(matchesEventFilter(parseEventFilter({ suffix: { type: '.created' } }), codexReview), false);
  assert.equal(
    matchesEventFilter(parseEventFilter({ exact: { subject: 'pull/470', type: 'com.github.push' } }), codexReview),
    false,
  );
});

test('an attribute the event lacks never matches, so `not` of it does', () => {
  const noSubject: InboundEvent = { attributes: { specversion: '1.0', id: 'a', source: 's', type: 't' } };
  assert.equal(matchesEventFilter(parseEventFilter({ prefix: { subject: 'pull/' } }), noSubject), false);
  assert.equal(matchesEventFilter(parseEventFilter({ not: { prefix: { subject: 'pull/' } } }), noSubject), true);
});

test('a data. key walks object keys and matches only a string; numbers, arrays and missing paths do not match', () => {
  const event: InboundEvent = {
    attributes: { specversion: '1.0', id: 'a', source: 's', type: 't' },
    data: { review: { state: 'approved', count: 3, labels: ['x'] }, 'dotted.key': 'v' },
  };
  assert.equal(matchesEventFilter(parseEventFilter({ exact: { 'data.review.state': 'approved' } }), event), true);
  assert.equal(matchesEventFilter(parseEventFilter({ exact: { 'data.review.count': '3' } }), event), false);
  assert.equal(matchesEventFilter(parseEventFilter({ exact: { 'data.review.labels': 'x' } }), event), false);
  assert.equal(matchesEventFilter(parseEventFilter({ exact: { 'data.review.missing': 'x' } }), event), false);
  assert.equal(matchesEventFilter(parseEventFilter({ exact: { 'data.review': 'x' } }), event), false);
  // Inherited properties are not data: a path through the prototype must not match.
  assert.equal(matchesEventFilter(parseEventFilter({ exact: { 'data.review.constructor.name': 'Object' } }), event), false);
  const noData: InboundEvent = { attributes: { specversion: '1.0', id: 'a', source: 's', type: 't' } };
  assert.equal(matchesEventFilter(parseEventFilter({ exact: { 'data.review.state': 'approved' } }), noData), false);
});

test('all, any and not combine, and nest', () => {
  const yes = { exact: { subject: 'pull/470' } };
  const no = { exact: { subject: 'pull/1' } };
  assert.equal(matchesEventFilter(parseEventFilter({ all: [yes, yes] }), codexReview), true);
  assert.equal(matchesEventFilter(parseEventFilter({ all: [yes, no] }), codexReview), false);
  assert.equal(matchesEventFilter(parseEventFilter({ any: [no, yes] }), codexReview), true);
  assert.equal(matchesEventFilter(parseEventFilter({ any: [no, no] }), codexReview), false);
  assert.equal(matchesEventFilter(parseEventFilter({ not: no }), codexReview), true);
  assert.equal(matchesEventFilter(parseEventFilter({ not: { any: [no, { not: yes }] } }), codexReview), true);
});

test('parseEventFilter refuses anything outside the six dialects, with a message that names the problem', () => {
  const refusals: Array<[unknown, RegExp]> = [
    [undefined, /object/],
    ['type = x', /object/],
    [[{ exact: { type: 't' } }], /object/],
    [{}, /exactly one/],
    [{ exact: { type: 't' }, prefix: { type: 't' } }, /exactly one/],
    [{ regex: { type: '.*' } }, /"regex".*exact, prefix, suffix, all, any, not/],
    [{ sql: "type = 'x'" }, /"sql"/],
    [{ exact: {} }, /at least one/],
    [{ exact: { type: '' } }, /empty/],
    [{ exact: { '': 't' } }, /attribute name/],
    [{ exact: { type: 7 } }, /string/],
    [{ exact: { Type: 't' } }, /attribute name/],
    [{ exact: { 'data.': 't' } }, /attribute name/],
    [{ exact: { 'data..x': 't' } }, /attribute name/],
    [{ exact: 'type' }, /object/],
    [{ all: [] }, /at least one/],
    [{ any: {} }, /array/],
    [{ not: [] }, /one filter/],
    [{ all: [{ exact: { type: 't' } }, { nope: {} }] }, /"nope"/],
  ];
  for (const [raw, message] of refusals) {
    assert.throws(() => parseEventFilter(raw), message, `accepted: ${JSON.stringify(raw)}`);
  }
});

test('parseEventFilter bounds nesting and size, so an approval prompt stays readable', () => {
  let deep: unknown = { exact: { type: 't' } };
  for (let i = 0; i < 20; i += 1) {
    deep = { not: deep };
  }
  assert.throws(() => parseEventFilter(deep), /nested/);
  const wide = { any: Array.from({ length: 200 }, (_, i) => ({ exact: { subject: `pull/${i}` } })) };
  assert.throws(() => parseEventFilter(wide), /too large/);
});

test('parseEventFilter returns a canonical copy that shares nothing with its input', () => {
  const raw = { all: [{ exact: { type: 't' } }] };
  const filter = parseEventFilter(raw) as { all: EventFilter[] };
  raw.all[0]!.exact.type = 'changed';
  assert.deepEqual(filter, { all: [{ exact: { type: 't' } }] });
});

test('quiet hours: a window inside one day, and one across midnight, in the named time zone', () => {
  const day = parseQuietHours({ from: '09:00', to: '17:00', timeZone: 'UTC' });
  assert.equal(isWithinQuietHours(day, new Date('2026-10-27T08:59:00Z')), false);
  assert.equal(isWithinQuietHours(day, new Date('2026-10-27T09:00:00Z')), true);
  assert.equal(isWithinQuietHours(day, new Date('2026-10-27T16:59:59Z')), true);
  assert.equal(isWithinQuietHours(day, new Date('2026-10-27T17:00:00Z')), false);

  // 22:00-07:00 New York. On Oct 27, 2026 New York is UTC-4.
  const night = parseQuietHours({ from: '22:00', to: '07:00', timeZone: 'America/New_York' });
  assert.equal(isWithinQuietHours(night, new Date('2026-10-28T01:59:00Z')), false); // 21:59
  assert.equal(isWithinQuietHours(night, new Date('2026-10-28T02:00:00Z')), true); // 22:00
  assert.equal(isWithinQuietHours(night, new Date('2026-10-28T10:59:00Z')), true); // 06:59
  assert.equal(isWithinQuietHours(night, new Date('2026-10-28T11:00:00Z')), false); // 07:00
});

test('parseQuietHours refuses a bad time, an empty window and an unknown time zone', () => {
  const refusals: Array<[unknown, RegExp]> = [
    [undefined, /object/],
    [{ from: '22:00', to: '07:00' }, /timeZone/],
    [{ from: '24:00', to: '07:00', timeZone: 'UTC' }, /HH:MM/],
    [{ from: '7:00', to: '09:00', timeZone: 'UTC' }, /HH:MM/],
    [{ from: '22:00', to: '22:00', timeZone: 'UTC' }, /same/],
    [{ from: '22:00', to: '07:00', timeZone: 'Mars/Olympus' }, /time zone/],
  ];
  for (const [raw, message] of refusals) {
    assert.throws(() => parseQuietHours(raw), message, `accepted: ${JSON.stringify(raw)}`);
  }
});

test('an event cadence has no next slot, so the due scan never sees it, and describes itself by source', () => {
  const cadence = {
    kind: 'event' as const,
    source: 'github',
    filter: parseEventFilter({ exact: { type: 'com.github.pull_request_review.submitted' } }),
  };
  assert.equal(nextFireAfter(cadence, new Date()), undefined);
  assert.equal(describeCadence(cadence), 'on github events');
  assert.equal(DEFAULT_EVENT_MAX_PER_HOUR, 12);
});
