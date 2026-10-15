import test from 'node:test';
import assert from 'node:assert/strict';

import { redactedError, redactSecrets } from '../src/index.ts';

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

test('redactedError keeps an error that has nothing to redact, read-only or not', () => {
  const abort = new DOMException('This operation was aborted', 'AbortError');
  assert.equal(redactedError(abort, ['sk-abcdef123456']), abort);
  const plain = new Error('fine');
  assert.equal(redactedError(plain, ['sk-abcdef123456']), plain);
});

test('redactedError redacts in place, and replaces an error it cannot write', () => {
  const writable = new Error('bad sk-abcdef123456');
  assert.equal(redactedError(writable, ['sk-abcdef123456']), writable);
  assert.equal(writable.message, 'bad [redacted]');

  const readOnly = new DOMException('bad sk-abcdef123456', 'AbortError');
  const replaced = redactedError(readOnly, ['sk-abcdef123456']) as Error;
  assert.notEqual(replaced, readOnly);
  assert.equal(replaced.message, 'bad [redacted]');
  assert.equal(replaced.name, 'AbortError');
});
