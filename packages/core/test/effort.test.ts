import test from 'node:test';
import assert from 'node:assert/strict';

import { describeEffort, effortLevelsFor, isEffortLevel, resolveEffort } from '../src/index.ts';

test('isEffortLevel accepts the five levels and nothing else', () => {
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(isEffortLevel(level), true, level);
  }
  for (const value of ['High', 'extra', '', ' high', 3, undefined, null]) {
    assert.equal(isEffortLevel(value), false, String(value));
  }
});

test('a model that takes the level is sent it as asked', () => {
  assert.deepEqual(resolveEffort('claude-opus-5-5', 'high'), { requested: 'high', effort: 'high', status: 'applied' });
  assert.deepEqual(resolveEffort('claude-opus-5-5', 'xhigh'), { requested: 'xhigh', effort: 'xhigh', status: 'applied' });
  assert.deepEqual(resolveEffort('claude-opus-4-6', 'max'), { requested: 'max', effort: 'max', status: 'applied' });
});

test('Opus 4.6 has no xhigh, so xhigh is lowered to high and reported as lowered', () => {
  const resolution = resolveEffort('claude-opus-4-6', 'xhigh');
  assert.deepEqual(resolution, { requested: 'xhigh', effort: 'high', status: 'lowered' });
  assert.equal(describeEffort('claude-opus-4-6', resolution), 'high (asked xhigh; claude-opus-4-6 has no xhigh)');
});

test('a model known to take no effort is sent none, and says so', () => {
  const resolution = resolveEffort('claude-haiku-4-5', 'high');
  assert.deepEqual(resolution, { requested: 'high', status: 'unsupported' });
  assert.equal(resolution.effort, undefined);
  assert.match(describeEffort('claude-haiku-4-5', resolution), /^not sent \(asked high;/);
});

test('an unknown model is sent the level as written and reported as unverified, never applied', () => {
  const resolution = resolveEffort('my-proxy-model', 'xhigh');
  assert.deepEqual(resolution, { requested: 'xhigh', effort: 'xhigh', status: 'unverified' });
  assert.match(describeEffort('my-proxy-model', resolution), /not a model Stratus knows/);
});

test('the capability table does not mistake a newer 4.x model for an old one', () => {
  assert.deepEqual(effortLevelsFor('claude-opus-4'), []);
  assert.deepEqual(effortLevelsFor('claude-sonnet-4-20250514'), []);
  assert.equal(effortLevelsFor('claude-opus-4-9'), undefined);
  assert.equal(effortLevelsFor('claude-sonnet-4-7'), undefined);
  assert.deepEqual(effortLevelsFor('claude-opus-4-5-20251101'), ['low', 'medium', 'high']);
  assert.equal(effortLevelsFor('claude-fable-5-1')?.includes('xhigh'), true);
});

test('provider-prefixed and versioned model ids resolve like the bare id', () => {
  for (const model of ['anthropic.claude-opus-4-6', 'us.anthropic.claude-opus-4-6-v1:0', 'claude-opus-4-6@20260101', 'Claude-Opus-4-6']) {
    assert.deepEqual(resolveEffort(model, 'xhigh'), { requested: 'xhigh', effort: 'high', status: 'lowered' }, model);
  }
  assert.deepEqual(effortLevelsFor('anthropic.claude-sonnet-4-20250514-v1:0'), []);
  assert.deepEqual(effortLevelsFor('claude-opus-5-5@20260901'), effortLevelsFor('claude-opus-5-5'));
});
