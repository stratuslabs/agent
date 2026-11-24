import test from 'node:test';
import assert from 'node:assert/strict';

import { conversationTitle, firstLine, sourceOf } from '../ui/lib/sources.js';

test('a conversation started on the web reads as Web', () => {
  assert.deepEqual(sourceOf('web:ava:7c0d2b1e-8f6a-4c1a-9a51-3f2a6c9d0e11'), { kind: 'web', icon: 'globe', label: 'Web' });
});

test('a Slack session reads as Slack, and a direct message as a DM', () => {
  assert.deepEqual(sourceOf('slack:ava:T0EXAMPLE:C0EXAMPLE1:1793046557.547839'), { kind: 'slack', icon: 'hash', label: 'Slack' });
  assert.deepEqual(sourceOf('slack:ava:T0EXAMPLE:D0EXAMPLE1'), { kind: 'slack', icon: 'message-circle', label: 'Slack · DM' });
});

test('work handed over by another agent reads as delegated, whatever channel it began in', () => {
  assert.equal(sourceOf('slack:ben:T0EXAMPLE:C0EXAMPLE1:1793046557.547839:delegate:ava:1').kind, 'delegated');
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

test("an event trigger's run names its source", () => {
  assert.deepEqual(sourceOf('event:t1:github:evt-42'), { kind: 'event', icon: 'zap', label: 'Event · github' });
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
  assert.equal(conversationTitle({ id: 'event:t:github:e' }), 'github event');
  assert.equal(conversationTitle({ id: 'schedule:gone:slot' }), 'Scheduled run');
});

test('a first line is trimmed and cut with an ellipsis', () => {
  assert.equal(firstLine('  hello\nworld'), 'hello');
  assert.equal(firstLine('x'.repeat(100), 10), `${'x'.repeat(9)}…`);
  assert.equal(firstLine(''), '');
});
