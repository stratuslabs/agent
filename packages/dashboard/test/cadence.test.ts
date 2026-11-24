import test from 'node:test';
import assert from 'node:assert/strict';

import { cadenceKind, humanCadence } from '../ui/lib/cadence.js';

test('an interval reads as words', () => {
  assert.equal(humanCadence('every 30m'), 'Every 30 minutes');
  assert.equal(humanCadence('every 1m'), 'Every minute');
  assert.equal(humanCadence('every 1h'), 'Every hour');
  assert.equal(humanCadence('every 2h'), 'Every 2 hours');
  assert.equal(humanCadence('every 1d'), 'Every day');
  assert.equal(humanCadence('every 90s'), 'Every 90 seconds');
});

test('the common cron shapes read as words, in the daemon’s own time', () => {
  assert.equal(humanCadence('cron 0 9 * * *'), 'Every day at 9:00 AM');
  assert.equal(humanCadence('cron 30 14 * * *'), 'Every day at 2:30 PM');
  assert.equal(humanCadence('cron 0 0 * * *'), 'Every day at 12:00 AM');
  assert.equal(humanCadence('cron 0 9 * * 1-5'), 'Every weekday at 9:00 AM');
  assert.equal(humanCadence('cron 0 9 * * 1'), 'Every Monday at 9:00 AM');
  assert.equal(humanCadence('cron */15 * * * *'), 'Every 15 minutes');
  assert.equal(humanCadence('cron 5 * * * *'), 'Every hour at :05');
});

test('anything else is shown as the cron line itself, not guessed at', () => {
  assert.equal(humanCadence('cron 0 9 1 * *'), 'Cron 0 9 1 * *');
  assert.equal(humanCadence('cron 0 9,17 * * *'), 'Cron 0 9,17 * * *');
});

test('a one-time run and an event trigger read plainly', () => {
  assert.match(humanCadence('once at 2026-12-02T15:00:00.000Z'), /^Once on .+ at .+/);
  assert.equal(humanCadence('on github events'), 'On github events');
  assert.equal(humanCadence('unknown'), 'unknown');
});

test('a cadence says which kind of schedule it is', () => {
  assert.equal(cadenceKind('every 30m'), 'recurring');
  assert.equal(cadenceKind('cron 0 9 * * *'), 'recurring');
  assert.equal(cadenceKind('once at 2026-12-02T15:00:00.000Z'), 'once');
  assert.equal(cadenceKind('on github events'), 'event');
});
