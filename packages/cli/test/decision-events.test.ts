import test from 'node:test';
import assert from 'node:assert/strict';

import type { StratusEvent } from '@stratusagent/core';

import { eventDetail, formatEvent } from '../src/events.ts';

const decided = (extra: Partial<Extract<StratusEvent, { type: 'permission.decided' }>> = {}): StratusEvent => ({
  type: 'permission.decided',
  sessionId: 'sess-1',
  agentId: 'ava',
  callId: 'c1',
  toolName: 'shell.run',
  risk: 'gated',
  allowed: false,
  layer: 'scope',
  reason: 'shell.run was called outside every approved scope (curl) and nobody is available to approve it',
  ...extra,
});

test('the structured log keeps one decision line per call with fixed fields, and not the reason', () => {
  // Fixed fields are what a script counts (allowed, layer, verdict, code);
  // the reason is prose a policy wrote, and the refusal warning already
  // carries it for the calls that matter.
  assert.deepEqual(eventDetail(decided()), { tool: 'shell.run', callId: 'c1', risk: 'gated', allowed: false, layer: 'scope' });
  assert.deepEqual(
    eventDetail(decided({ allowed: false, layer: 'review', verdict: 'block', reviewCode: 'not-asked-for', shadow: true })),
    { tool: 'shell.run', callId: 'c1', risk: 'gated', allowed: false, layer: 'review', verdict: 'block', code: 'not-asked-for', shadow: true },
  );
});

test('the event line names the tool, the outcome and the check', () => {
  assert.equal(formatEvent(decided()), '• permission.decided shell.run refused (scope)');
  assert.equal(formatEvent(decided({ allowed: true, layer: 'grant' })), '• permission.decided shell.run allowed (grant)');
  // A shadow decision reports what it would have done, a refusal included,
  // while the call ran: the line never says it was refused.
  assert.equal(
    formatEvent(decided({ allowed: false, layer: 'review', verdict: 'block', reviewCode: 'not-asked-for', shadow: true })),
    '• permission.decided shell.run would be refused (review, block: not-asked-for)',
  );
  assert.equal(
    formatEvent(decided({ allowed: true, layer: 'risk', shadow: true })),
    '• permission.decided shell.run would be allowed (risk)',
  );
});
