import test from 'node:test';
import assert from 'node:assert/strict';

import { redactSecrets } from '../src/index.ts';

test('redactSecrets replaces every occurrence of each secret', () => {
  assert.equal(
    redactSecrets('key sk-abcdef123456 then sk-abcdef123456 and tok-0987654321', ['sk-abcdef123456', 'tok-0987654321']),
    'key [redacted] then [redacted] and [redacted]',
  );
});

test('redactSecrets replaces a secret that contains another one whole', () => {
  assert.equal(redactSecrets('Bearer abcdefgh-ijkl', ['abcdefgh', 'abcdefgh-ijkl']), 'Bearer [redacted]');
});

test('redactSecrets skips missing and short values, which are not credentials', () => {
  assert.equal(redactSecrets('status 401 for user abc', [undefined, '', '401', 'abc']), 'status 401 for user abc');
});
