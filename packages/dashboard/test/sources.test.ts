import test from 'node:test';
import assert from 'node:assert/strict';

import { conversationTitle, drawerSessions, firstLine, searchableTitle, sourceOf } from '../ui/lib/sources.js';

test('a conversation started on the web reads as Web', () => {
  assert.deepEqual(sourceOf('web:ava:7c0d2b1e-8f6a-4c1a-9a51-3f2a6c9d0e11'), { kind: 'web', icon: 'globe', label: 'Web' });
});

test('a Slack session reads as Slack, and a direct message as a DM', () => {
  assert.deepEqual(sourceOf('slack:ava:T0EXAMPLE:C0EXAMPLE1:1793046557.547839'), { kind: 'slack', icon: 'hash', label: 'Slack' });
  assert.deepEqual(sourceOf('slack:ava:T0EXAMPLE:D0EXAMPLE1'), { kind: 'slack', icon: 'message-circle', label: 'Slack · DM' });
});

test('work handed over by another agent reads as delegated, whatever channel it began in', () => {
  assert.equal(sourceOf('slack:ben:T0EXAMPLE:C0EXAMPLE1:1793046557.547839:delegate:ava:1').kind, 'delegated');
  assert.equal(sourceOf('web:ava:7c0d2b1e:delegate:ben:1:t_01').kind, 'delegated');
});

test('an agent whose id is "delegate" still has ordinary conversations', () => {
  assert.equal(sourceOf('web:delegate:7c0d2b1e-8f6a-4c1a-9a51-3f2a6c9d0e11').kind, 'web');
  assert.equal(sourceOf('slack:delegate:T0EXAMPLE:D0EXAMPLE1').kind, 'slack');
});

test("a schedule's run names the schedule when its prompt is known", () => {
  const prompt = 'Summarize last week’s open items\nPost them to #team.';
  const schedules = [{ id: 'sch1', prompt }];
  const source = sourceOf('schedule:sch1:2026-11-23T14:00:00.000Z', { schedules });
  assert.equal(source.kind, 'schedule');
  assert.equal(source.label, 'Schedule');
  assert.equal(source.prompt, prompt);
  assert.equal(sourceOf('schedule:gone:slot').prompt, undefined);
});

test("an event trigger's run is an Event, named by its trigger's source when the trigger is known", () => {
  // The gateway runs a trigger's firings in the reserved schedule namespace,
  // keyed by the event: schedule:<trigger id>:event-<hash>.
  const schedules = [{ id: 't1', cadence: 'on github events', prompt: 'Run the API tests on the new pull request.' }];
  assert.deepEqual(sourceOf('schedule:t1:event-3f2a', { schedules }), { kind: 'event', icon: 'zap', label: 'Event · github', prompt: schedules[0]?.prompt });
  assert.deepEqual(sourceOf('schedule:gone:event-3f2a'), { kind: 'event', icon: 'zap', label: 'Event' });
});

test('anything else is shown for what it is, never as Web', () => {
  assert.equal(sourceOf('cli:ava:abc').kind, 'other');
  assert.equal(sourceOf('cli:ava:abc').label, 'cli');
});

test('a title is the session title when the daemon sends one', () => {
  assert.equal(conversationTitle({ id: 'web:ava:1', title: 'Summarize the open items' }), 'Summarize the open items');
});

test("without one, a schedule's run is titled by its prompt and the rest by where they came from", () => {
  const schedules = [{ id: 'sch1', prompt: 'Summarize last week’s open items\nPost them to #team.' }];
  assert.equal(conversationTitle({ id: 'schedule:sch1:slot' }, { schedules }), 'Summarize last week’s open items');
  assert.equal(conversationTitle({ id: 'web:ava:1' }), 'Web conversation');
  assert.equal(conversationTitle({ id: 'slack:ava:T:D01' }), 'Slack DM');
  assert.equal(conversationTitle({ id: 'slack:ava:T:C01:1.2' }), 'Slack conversation');
  assert.equal(conversationTitle({ id: 'schedule:t1:event-3f2a' }, { schedules: [{ id: 't1', cadence: 'on github events', prompt: 'Run the API tests.\nThen report.' }] }), 'Run the API tests.');
  assert.equal(conversationTitle({ id: 'schedule:gone:event-3f2a' }), 'Event run');
  assert.equal(conversationTitle({ id: 'schedule:gone:slot' }), 'Scheduled run');
});

test('a first line is trimmed and cut with an ellipsis', () => {
  assert.equal(firstLine('  hello\nworld'), 'hello');
  assert.equal(firstLine('x'.repeat(100), 10), `${'x'.repeat(9)}…`);
  assert.equal(firstLine(''), '');
});

test('the drawer shows the daemon search for the query it answered, and filters on whole titles until then', () => {
  const long = `${'Planning the quarterly offsite and its budget, venues, travel and agenda'} with the Lisbon team`;
  const listed = [
    { id: 'web:ava:1', title: long, updatedAt: '2026-11-24T10:00:00.000Z' },
    { id: 'web:ava:2', title: 'Fix the flaky gateway test', updatedAt: '2026-11-24T09:00:00.000Z' },
  ];
  const titleOf = (session: { id: string; title?: string }) => session.title ?? '';
  // Past the 80 characters a row shows: still found, by the whole title.
  assert.ok(long.length > 80);
  assert.deepEqual(drawerSessions({ sessions: listed, found: undefined, query: 'lisbon', titleOf }).map((s) => s.id), ['web:ava:1']);
  // The daemon's answer for this query is shown as it came, not filtered again.
  const older = { id: 'web:ava:9', title: long, updatedAt: '2026-10-01T00:00:00.000Z' };
  assert.deepEqual(
    drawerSessions({ sessions: listed, found: { query: 'Lisbon', sessions: [older] }, query: 'Lisbon', titleOf }).map((s) => s.id),
    ['web:ava:9'],
  );
  // Once the box says something else, an earlier answer no longer applies:
  // the listed conversations are filtered for the new text meanwhile.
  assert.deepEqual(
    drawerSessions({ sessions: listed, found: { query: 'Lisbon', sessions: [older] }, query: 'flaky', titleOf }).map((s) => s.id),
    ['web:ava:2'],
  );
  // An empty box is everything listed.
  assert.equal(drawerSessions({ sessions: listed, found: { query: 'Lisbon', sessions: [older] }, query: '  ', titleOf }).length, 2);
});

test('a conversation is matched on its whole title, not the cut one a row shows', () => {
  const long = `${'x'.repeat(90)} needle`;
  assert.equal(searchableTitle({ id: 'web:ava:1', title: long }), long);
  assert.equal(searchableTitle({ id: 'web:ava:1' }), 'Web conversation');
});
