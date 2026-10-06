import test from 'node:test';
import assert from 'node:assert/strict';

import { turnReplyFor, workItemState, type Message } from '../src/index.ts';

const user = (content: string, idempotencyKey?: string): Message => ({
  id: `user:${content}`,
  role: 'user',
  content,
  createdAt: '2026-10-06T00:00:00.000Z',
  ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
});

const assistant = (content: string): Message => ({
  id: `assistant:${content}`,
  role: 'assistant',
  content,
  createdAt: '2026-10-06T00:00:00.000Z',
});

test('a work item is unfinished only while its message is the one the in-flight turn is on', () => {
  const keyed = [user('hello', 'k1')];
  assert.equal(workItemState({ status: 'running', messages: keyed }, 'k1'), 'unfinished');
  assert.equal(workItemState({ status: 'pending_approval', messages: keyed }, 'k1'), 'unfinished');

  // The save that moves the status off running is the turn's last.
  assert.equal(workItemState({ status: 'completed', messages: [...keyed, assistant('hi')] }, 'k1'), 'finished');
  assert.equal(workItemState({ status: 'failed', messages: keyed }, 'k1'), 'finished');

  // A later turn running does not make an earlier item unfinished.
  assert.equal(
    workItemState({ status: 'running', messages: [...keyed, assistant('hi'), user('next', 'k2')] }, 'k1'),
    'finished',
  );
  assert.equal(
    workItemState({ status: 'running', messages: [...keyed, assistant('hi'), user('unkeyed')] }, 'k1'),
    'finished',
  );

  // A key nothing carries has not been seen.
  assert.equal(workItemState({ status: 'completed', messages: keyed }, 'k9'), undefined);
});

test('a keyed message\'s reply is its own turn\'s, not the newest one', () => {
  const messages = [user('first', 'k1'), assistant('answer one'), user('second', 'k2'), assistant('answer two')];
  assert.equal(turnReplyFor({ messages }, 'k1'), 'answer one');
  assert.equal(turnReplyFor({ messages }, 'k2'), 'answer two');
  assert.equal(turnReplyFor({ messages }, 'k9'), undefined);
  // A turn that said nothing has no reply, rather than borrowing the next.
  assert.equal(turnReplyFor({ messages: [user('first', 'k1'), assistant(''), user('second', 'k2'), assistant('later')] }, 'k1'), undefined);
});
