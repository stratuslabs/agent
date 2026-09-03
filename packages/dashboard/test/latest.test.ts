import test from 'node:test';
import assert from 'node:assert/strict';

import { createLatest } from '../ui/lib/latest.js';

test('a refresh that started earlier but lands later is discarded, so the newer answer stands', () => {
  // The order the dashboard lost an approval in: an early refresh sent
  // before the call was parked, a later one sent after, the early one
  // landing last.
  const latest = createLatest();
  const early = latest.begin();
  const late = latest.begin();
  assert.equal(latest.isCurrent(late), true, 'the newest refresh writes');
  assert.equal(latest.isCurrent(early), false, 'the older one, landing afterwards, does not');
  // Until a newer one is issued, the newest stays current however long its
  // fetch takes.
  assert.equal(latest.isCurrent(late), true);
});
