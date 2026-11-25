import test from 'node:test';
import assert from 'node:assert/strict';

import { alwaysOffer, ownersUnknown } from '../ui/lib/grants.js';

test('the approval card says what Always allow would grant, so no two lifetimes share one button', () => {
  // The defect standing grants exist to close: the same button meant "this session"
  // for one tool and "this agent, until revoked" for another, and an
  // operator could not tell which they had clicked. Slack says which; this
  // is the same sentence for the surface an operator uses when Slack is not
  // where they are.
  assert.equal(
    alwaysOffer('tool', 'Ava'),
    'Always allow lets Ava use this tool without asking, until you revoke it in Permissions.',
  );
  assert.match(alwaysOffer('session', 'Ava') ?? '', /rest of this session/);
  assert.match(alwaysOffer('scope', 'Ava') ?? '', /command's scope/);
  assert.match(alwaysOffer('origin', 'Ava') ?? '', /this site/);
  // A standing per-conversation grant (message.read/send) outlives the
  // session, so the card must say so rather than render a bare button.
  assert.equal(
    alwaysOffer('destination', 'Ava'),
    'Always allow lets Ava use this tool on this conversation without asking, until you revoke it in Permissions.',
  );

  // A request carrying no label — an older daemon across an upgrade — says
  // nothing rather than guessing at a lifetime it cannot know.
  assert.equal(alwaysOffer(undefined, 'Ava'), undefined);
});

test('a daemon that cannot list grant owners leaves the roster as the list, instead of an error', () => {
  // A daemon whose grant store can't enumerate owners says so with 501.
  assert.equal(ownersUnknown({ status: 501, code: 'grant_owners_unavailable' }), true);
  // An older daemon has no /grants route at all: the router's own 404.
  assert.equal(ownersUnknown({ status: 404, code: 'not_found' }), true);
  // Anything else is a real failure the page must show.
  assert.equal(ownersUnknown({ status: 404, code: 'agent_not_found' }), false);
  assert.equal(ownersUnknown({ status: 500, code: 'internal' }), false);
  assert.equal(ownersUnknown({ status: 0, code: 'network' }), false);
  assert.equal(ownersUnknown(new TypeError('Failed to fetch')), false);
});
