import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { Message, Session } from '@stratusagent/core';
import { agentSessionDbIn } from '@stratusagent/state';

import { SESSION_TITLE_MAX, ShardedSessionStore, sessionTitle } from '../src/sessions.ts';

// Conversation titles: the rule, where they are kept, and the search over
// them that the dashboard's conversation drawer uses.

const newStateDir = (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'stratus-titles-'));

let counter = 0;
const message = (role: Message['role'], content: string, extra: Partial<Message> = {}): Message => ({
  id: `m${++counter}`,
  role,
  content,
  createdAt: new Date().toISOString(),
  ...extra,
});

const conversation = (id: string, agentId: string, messages: Message[]): Omit<Session, 'createdAt' | 'updatedAt'> => ({
  id,
  agent: { id: agentId, name: agentId },
  status: 'completed',
  messages,
});

test('a title is the first line of the first message said to the agent, tidied and cut to length', () => {
  assert.equal(sessionTitle({ messages: [] }), '');
  assert.equal(sessionTitle({ messages: [message('assistant', 'Hello there.')] }), '');
  assert.equal(
    sessionTitle({ messages: [message('user', '\n\n  Summarize   the open\titems  \nand post them.'), message('user', 'later')] }),
    'Summarize the open items',
  );
  // Overheard chatter in a channel is passed over while something was said to the agent.
  assert.equal(
    sessionTitle({ messages: [message('user', 'Dana: lunch?', { overheard: true }), message('user', 'Dylan: what is on the board today')] }),
    'Dylan: what is on the board today',
  );
  assert.equal(sessionTitle({ messages: [message('user', 'Dana: lunch?', { overheard: true })] }), 'Dana: lunch?');
  // Cut by code point, never through an emoji.
  const long = `${'a'.repeat(SESSION_TITLE_MAX - 2)}😀😀😀`;
  const title = sessionTitle({ messages: [message('user', long)] });
  assert.equal(Array.from(title).length, SESSION_TITLE_MAX);
  assert.ok(title.endsWith('😀…'), title);
});

test('the listing carries titles, kept current as a conversation is saved', async () => {
  const store = new ShardedSessionStore({ stateDir: await newStateDir() });
  try {
    const created = await store.create(conversation('web:ava:1', 'ava', []));
    assert.equal(store.listTitled('ava')[0]?.title, undefined, 'nothing said yet, no title');
    await store.save({ ...created, messages: [message('user', 'Plan the offsite agenda')] });
    await store.create(conversation('web:ben:1', 'ben', [message('user', 'Run the tests')]));
    assert.deepEqual(
      store.listTitled().map((row) => [row.id, row.title]).sort(),
      [['web:ava:1', 'Plan the offsite agenda'], ['web:ben:1', 'Run the tests']],
    );
    // The plain listing, which the event stream and the fleet reader use, is untouched.
    assert.equal(store.list('ava')[0]?.title, undefined);
  } finally {
    store.close();
  }
});

test('a conversation saved without a title (an older build, or before the column) gets one on the next read, once', async () => {
  const stateDir = await newStateDir();
  const store = new ShardedSessionStore({ stateDir });
  await store.create(conversation('web:ava:old', 'ava', [message('user', 'From before titles')]));
  store.close();
  // What an older build's save leaves: the row rewritten with no title.
  const db = new DatabaseSync(agentSessionDbIn(stateDir, 'ava'));
  db.exec('UPDATE sessions SET title = NULL');
  db.close();

  const reopened = new ShardedSessionStore({ stateDir });
  try {
    assert.equal(reopened.listTitled('ava')[0]?.title, 'From before titles');
  } finally {
    reopened.close();
  }
  const check = new DatabaseSync(agentSessionDbIn(stateDir, 'ava'));
  try {
    assert.deepEqual(check.prepare('SELECT title FROM sessions').all().map((row) => (row as { title: string }).title), ['From before titles'], 'written back');
  } finally {
    check.close();
  }
});

test('a title search matches case-insensitively, for one agent or all, newest first, and its wildcards are literal', async () => {
  const stateDir = await newStateDir();
  const store = new ShardedSessionStore({ stateDir });
  try {
    await store.create(conversation('web:ava:a', 'ava', [message('user', 'Deploy staging on Friday')]));
    await store.create(conversation('web:ava:b', 'ava', [message('user', 'Weekly report draft')]));
    await store.create(conversation('web:ben:a', 'ben', [message('user', 'Why did the deploy fail?')]));
    await store.create(conversation('web:ben:b', 'ben', [message('user', 'Discount: 100% off_today')]));
    // One with no title yet: the search fills it first.
    const db = new DatabaseSync(agentSessionDbIn(stateDir, 'ava'));
    db.exec("UPDATE sessions SET title = NULL WHERE id = 'web:ava:a'");
    db.close();

    assert.deepEqual(store.listTitled('ava', undefined, 'DEPLOY').map((row) => row.id), ['web:ava:a']);
    assert.deepEqual(store.listTitled(undefined, undefined, 'deploy').map((row) => row.id).sort(), ['web:ava:a', 'web:ben:a']);
    assert.deepEqual(store.listTitled(undefined, 1, 'deploy').length, 1, 'the limit applies after matching');
    // `%` and `_` are characters to find, not wildcards.
    assert.deepEqual(store.listTitled(undefined, undefined, '%').map((row) => row.id), ['web:ben:b']);
    assert.deepEqual(store.listTitled(undefined, undefined, 'off_t').map((row) => row.id), ['web:ben:b']);
    assert.deepEqual(store.listTitled(undefined, undefined, 'nothing like this'), []);
    // An agent with no conversations is not given a store to answer.
    assert.deepEqual(store.listTitled('cleo', undefined, 'deploy'), []);
    assert.equal(existsSync(agentSessionDbIn(stateDir, 'cleo')), false);
  } finally {
    store.close();
  }
});
