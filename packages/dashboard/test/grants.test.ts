import test from 'node:test';
import assert from 'node:assert/strict';

import { alwaysOffer } from '../ui/lib/grants.js';

test('the approval card says what Always allow would grant, so no two lifetimes share one button', () => {
  // The defect step 28 exists to close: the same button meant "this session"
  // for one tool and "this agent, until revoked" for another, and an
  // operator could not tell which they had clicked. Slack says which; this
  // is the same sentence for the surface an operator uses when Slack is not
  // where they are.
  assert.equal(
    alwaysOffer('tool', 'Ava'),
    'Always allow grants this tool to Ava until an operator revokes it.',
  );
  assert.match(alwaysOffer('session', 'Ava') ?? '', /rest of this session/);
  assert.match(alwaysOffer('scope', 'Ava') ?? '', /command's scope/);
  assert.match(alwaysOffer('origin', 'Ava') ?? '', /this site/);

  // A request carrying no label — an older daemon across an upgrade — says
  // nothing rather than guessing at a lifetime it cannot know.
  assert.equal(alwaysOffer(undefined, 'Ava'), undefined);
});
