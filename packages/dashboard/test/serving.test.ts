import test from 'node:test';
import assert from 'node:assert/strict';

import { servingRow } from '../ui/lib/serving.js';

test('a served runtime reads as provider · model and its credentials', () => {
  assert.deepEqual(
    servingRow({ provider: 'anthropic', model: 'claude-opus-5-5', credentials: 'stored' }),
    { title: 'anthropic · claude-opus-5-5', detail: 'credentials: stored', problem: false },
  );
  assert.deepEqual(
    servingRow({ provider: 'demo', credentials: 'none' }),
    { title: 'demo', detail: 'credentials: none', problem: false },
  );
});

test('a runtime with a problem says what is wrong instead of "none · credentials: none"', () => {
  // The shape /health sends when no agent's run can resolve a provider.
  const problem = 'No provider is configured, so there is nothing to run on. Run `stratus setup` to sign in to one.';
  assert.deepEqual(
    servingRow({ provider: 'none', credentials: 'none', problem }),
    { title: 'No provider', detail: problem, problem: true },
  );
});

test('an empty problem string is not treated as a problem', () => {
  assert.equal(servingRow({ provider: 'openai', credentials: 'env', problem: '' }).problem, false);
});
