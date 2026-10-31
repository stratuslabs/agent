import test from 'node:test';
import assert from 'node:assert/strict';

import type { JsonObject, Session } from '@stratusagent/core';
import { createMessageSayTool, createMessageSendTool, GATEWAY_ONLY_TOOL_NAMES, MESSAGE_SAY_MAX_LENGTH, MESSAGE_SAY_TOOL_NAME } from '../src/index.ts';

const sessionFor = (agentId: string, sessionId = 'sess-1'): Session => {
  const now = new Date().toISOString();
  return {
    id: sessionId,
    agent: { id: agentId, name: agentId },
    status: 'running',
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
};

test('message.say is a safe tool that takes only text and reaches only the conversation the turn is in (card 1009)', async () => {
  const said: Array<{ sessionId: string; agentId: string; text: string }> = [];
  const tool = createMessageSayTool(async ({ session, text }) => {
    said.push({ sessionId: session.id, agentId: session.agent.id, text });
  });

  assert.equal(tool.name, MESSAGE_SAY_TOOL_NAME);
  assert.equal(tool.name, 'message.say');
  assert.equal(tool.risk, 'safe');
  // Nothing to name a destination with: where it goes is the session's.
  assert.deepEqual(Object.keys((tool.parameters as { properties: JsonObject }).properties), ['text']);
  assert.equal(tool.destinationFor, undefined);
  // Only the daemon has a conversation to say it in; a local run names it
  // as a daemon tool rather than an unknown one.
  assert.ok(GATEWAY_ONLY_TOOL_NAMES.includes(MESSAGE_SAY_TOOL_NAME));

  const result = await tool.execute({ text: '  Need your OK before I delete the old branch.  ' }, sessionFor('ava', 's-9')) as JsonObject;
  assert.deepEqual(said, [{ sessionId: 's-9', agentId: 'ava', text: 'Need your OK before I delete the old branch.' }]);
  assert.deepEqual(result, { sent: true });
});

test('message.say refuses empty text and anything longer than one short line, and sends nothing', async () => {
  const said: string[] = [];
  const tool = createMessageSayTool(async ({ text }) => {
    said.push(text);
  });
  await assert.rejects(() => tool.execute({ text: '   ' }, sessionFor('ava')), /non-empty "text"/);
  await assert.rejects(() => tool.execute({}, sessionFor('ava')), /non-empty "text"/);
  await assert.rejects(
    () => tool.execute({ text: 'x'.repeat(MESSAGE_SAY_MAX_LENGTH + 1) }, sessionFor('ava')),
    /at most 500 characters.*reply/,
  );
  await tool.execute({ text: 'x'.repeat(MESSAGE_SAY_MAX_LENGTH) }, sessionFor('ava'));
  assert.equal(said.length, 1);
});

test('message.say passes on why a conversation cannot take the message', async () => {
  const tool = createMessageSayTool(async () => {
    throw new Error('This conversation\'s channel (cli) cannot take a mid-task message. Say it in your reply.');
  });
  await assert.rejects(() => tool.execute({ text: 'hi' }, sessionFor('ava')), /cannot take a mid-task message/);
});

test('message.send sends an agent that wants to message the person it is replying to over to message.say (card 1009 live check)', () => {
  // On a live Slack check, a model asked to "send me a mid-task message"
  // reached for message.send by its name, made up a thread id, and posted
  // at the channel's top level. Its description now says where that goes.
  const description = createMessageSendTool(async () => ({})).description ?? '';
  assert.match(description, /conversation you are replying in/);
  assert.match(description, /message\.say/);
});

test('message.say tells the agent its words between tool calls are not shown, and covers a person who asked to hear mid-task (card 1009 live check)', () => {
  // On a live Slack check, a model asked for a mid-task message wrote it as
  // text between two tool calls, which Slack holds, and never called a
  // tool: nothing reached the person. The description now carries the fact
  // the choice depends on.
  const description = createMessageSayTool(async () => {}).description ?? '';
  assert.match(description, /between tool calls are not shown/);
  assert.match(description, /asked to hear from you mid-task/);
  assert.match(description, /Never use it to narrate your steps/);
});
