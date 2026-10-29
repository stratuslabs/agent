import test from 'node:test';
import assert from 'node:assert/strict';

import { gatewayEventOptions } from '../src/commands/serve.ts';

// Card 590 phase 2: a daemon whose only event sources are plugins' still
// holds their events to the operator's `events.maxBodyBytes`.

test('the events block reaches the gateway when it sets a body limit, even with no webhook source', () => {
  assert.deepEqual(gatewayEventOptions({ maxBodyBytes: 4_096 }), { maxBodyBytes: 4_096 });
  assert.deepEqual(
    gatewayEventOptions({ sources: { github: { verify: 'github', secrets: ['events.github'] } }, maxBodyBytes: 4_096 }),
    { sources: { github: { verify: 'github', secrets: ['events.github'] } }, maxBodyBytes: 4_096 },
  );
  assert.deepEqual(gatewayEventOptions({ sources: { github: { verify: 'github', secrets: ['events.github'] } } }), { sources: { github: { verify: 'github', secrets: ['events.github'] } } });
  assert.equal(gatewayEventOptions({}), undefined);
  assert.equal(gatewayEventOptions({ sources: {}, listen: { port: 4124 } }), undefined);
});
