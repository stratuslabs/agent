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

test('redactSecrets skips missing and empty values', () => {
  assert.equal(redactSecrets('status 401 for user abc', [undefined, '']), 'status 401 for user abc');
});

test('redactSecrets redacts a short configured secret wherever it stands alone', () => {
  assert.equal(
    redactSecrets('invalid key k (Bearer k, "k"); key=sk-test.', ['k', 'sk-test']),
    'invalid key [redacted] (Bearer [redacted], "[redacted]"); key=[redacted].',
  );
});

test('redactSecrets leaves a short secret inside a longer word, so the failure stays readable', () => {
  assert.equal(redactSecrets('unknown key for model', ['k', 'or']), 'unknown key for model');
});

test('redactSecrets matches a short secret literally, not as a pattern', () => {
  assert.equal(redactSecrets('got a.b and axb', ['a.b']), 'got [redacted] and axb');
});
