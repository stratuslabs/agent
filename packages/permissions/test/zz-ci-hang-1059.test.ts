// Throwaway for card 1059: shows the CI test job stops at its timeout when a
// test fails before closing a server it opened. Reverted before merge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

test('card 1059 throwaway: fails before closing its server', async () => {
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  assert.equal('left open', 'closed');
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
