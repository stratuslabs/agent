import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePublicUrl, withoutTrailingSlashes } from '../src/index.ts';

// The regex every base URL comparison and join used before. Kept here as the
// reference the loop must agree with, on inputs short enough to be quick.
const byRegex = (value: string): string => value.replace(/\/+$/, '');

test('withoutTrailingSlashes removes exactly what the old trailing-slash regex removed', () => {
  const cases = [
    '', '/', '///', 'a', 'a/', 'a//', '/a', '//a//', 'a/b', 'a/b/', 'a//b//',
    'https://api.openai.com/v1', 'https://api.openai.com/v1/', 'https://api.anthropic.com///',
    'http://127.0.0.1:4317/', ' / ', 'a/ ', 'a\\', 'a\\/',
  ];
  for (const value of cases) {
    assert.equal(withoutTrailingSlashes(value), byRegex(value), JSON.stringify(value));
  }
});

// The regex restarted at every slash of a run that was not at the end:
// 40,000 slashes and then an `x` took 2.4 s on a Mac (CodeQL flagged it as
// js/polynomial-redos). The ceiling is 1 s, because a tighter one flaked on
// a loaded CI runner before (AGT-300).
test('withoutTrailingSlashes stays fast on a long run of slashes that is not at the end', () => {
  const value = `${'/'.repeat(40_000)}x`;
  const started = performance.now();
  assert.equal(withoutTrailingSlashes(value), value);
  assert.equal(withoutTrailingSlashes(`${value}${'/'.repeat(40_000)}`), value);
  assert.ok(performance.now() - started < 1_000, `took ${Math.round(performance.now() - started)} ms`);
});

test('normalizePublicUrl stays fast on a path with a long run of slashes inside it', () => {
  const value = `https://mac-mini.example.test/${'/'.repeat(40_000)}x`;
  const started = performance.now();
  assert.equal(normalizePublicUrl(`${value}/`), value);
  assert.ok(performance.now() - started < 1_000, `took ${Math.round(performance.now() - started)} ms`);
});
