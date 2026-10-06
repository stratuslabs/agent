import test from 'node:test';
import assert from 'node:assert/strict';

import { turnFailureFor, turnFilesFor, turnReplyFor, workItemState, type Message } from '../src/index.ts';

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

const toolFile = (file: string): Message => ({
  id: `tool:${file}`,
  role: 'tool',
  content: '',
  createdAt: '2026-10-06T00:00:00.000Z',
  toolResult: { callId: `call:${file}`, toolName: 'shell.run', ok: true, output: { file } },
});

test('a keyed message\'s files are its own turn\'s, not the newest one\'s', () => {
  const messages = [
    user('first', 'k1'),
    toolFile('/tmp/one.png'),
    assistant('answer one'),
    user('second', 'k2'),
    toolFile('/tmp/two.png'),
    assistant('answer two'),
  ];
  assert.deepEqual(turnFilesFor({ messages }, 'k1'), ['/tmp/one.png']);
  assert.deepEqual(turnFilesFor({ messages }, 'k2'), ['/tmp/two.png']);
  assert.deepEqual(turnFilesFor({ messages }, 'k9'), []);
});

test('a keyed turn\'s failure is read only while it is the session\'s latest turn, overheard messages aside', () => {
  const failed = { status: 'failed' as const, lastError: 'the provider refused the request' };
  assert.equal(turnFailureFor({ ...failed, messages: [user('hello', 'k1')] }, 'k1'), 'the provider refused the request');
  // `observe` appends between turns, unkeyed and overheard, and starts none.
  const overheard: Message = { ...user('to someone else'), overheard: true };
  assert.equal(turnFailureFor({ ...failed, messages: [user('hello', 'k1'), overheard] }, 'k1'), 'the provider refused the request');
  // A later turn is the one the failure belongs to.
  assert.equal(turnFailureFor({ ...failed, messages: [user('hello', 'k1'), assistant('hi'), user('next', 'k2')] }, 'k1'), undefined);
  assert.equal(turnFailureFor({ ...failed, messages: [user('hello', 'k1'), assistant('hi'), user('unkeyed')] }, 'k1'), undefined);
  // A turn nobody asked for is overheard too, but keyed: it is a turn.
  const judged: Message = { ...user('judged', 'k2'), overheard: true };
  assert.equal(turnFailureFor({ ...failed, messages: [user('hello', 'k1'), assistant('hi'), judged] }, 'k1'), undefined);
  assert.equal(turnFailureFor({ status: 'completed', messages: [user('hello', 'k1')] }, 'k1'), undefined);
});
