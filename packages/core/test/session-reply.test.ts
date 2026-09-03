import test from 'node:test';
import assert from 'node:assert/strict';

import { latestTurnReply, type Message } from '../src/index.ts';

const message = (role: Message['role'], content: string): Message => ({
  id: `${role}:${content.length}`,
  role,
  content,
  createdAt: '2026-09-03T00:00:00.000Z',
});

test('the latest turn\'s reply is its last assistant text, and an earlier turn\'s answer is never replayed for a turn that produced none', () => {
  assert.equal(latestTurnReply({ messages: [] }), undefined);
  assert.equal(latestTurnReply({ messages: [message('user', 'hello'), message('assistant', 'hi there')] }), 'hi there');

  // A tool round-trip inside the turn does not hide the reply.
  assert.equal(
    latestTurnReply({ messages: [message('user', 'hello'), message('assistant', ''), message('tool', '{}'), message('assistant', 'done')] }),
    'done',
  );

  // Whitespace is not a reply, and the previous turn's answer is not this one's.
  assert.equal(
    latestTurnReply({ messages: [message('user', 'first'), message('assistant', 'answered'), message('user', 'second'), message('assistant', ' \n')] }),
    undefined,
  );
  assert.equal(latestTurnReply({ messages: [message('user', 'first'), message('assistant', 'answered'), message('user', 'second')] }), undefined);
});
