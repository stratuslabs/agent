import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRegistry } from '../src/index.ts';

test('the registry refuses the delegate wildcard as an agent id', () => {
  const registry = new AgentRegistry();
  // `delegates: ['*']` means any agent on the roster, so an agent whose id
  // is `*` could only ever be granted by opening the whole roster. The
  // soul loader refuses the id; a definition built in code reaches the
  // roster through register alone, so the refusal has to live here.
  assert.throws(
    () => registry.register({ id: '*', name: 'Star' }),
    /Invalid agent id: "\*"\. \* is the delegates wildcard .* give this agent another id\./,
  );
  assert.equal(registry.get('*'), undefined);
  assert.deepEqual(registry.register({ id: 'star', name: 'Star' }), { id: 'star', name: 'Star' });
});
