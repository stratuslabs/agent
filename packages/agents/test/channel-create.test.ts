import test from 'node:test';
import assert from 'node:assert/strict';

import type { Session } from '@stratusagent/core';
import {
  CHANNEL_CREATE_TOOL_NAME,
  createChannelCreateTool,
  GATEWAY_ONLY_TOOL_NAMES,
  type ConversationCreator,
} from '../src/index.ts';

const sessionFor = (agentId: string): Session => {
  const now = new Date().toISOString();
  return { id: 'sess-1', agent: { id: agentId, name: agentId }, status: 'running', messages: [], createdAt: now, updatedAt: now };
};

const recording = () => {
  const calls: Array<Parameters<ConversationCreator>[0]> = [];
  const tool = createChannelCreateTool(async (input) => {
    calls.push(input);
    return { conversation: 'C9', name: input.name, invited: input.invite ?? [], notInvited: [], notSet: [] };
  });
  return { calls, tool };
};

test('channel.create is gated, gateway-only, and asks for the channel kind and a name', () => {
  const { tool } = recording();
  assert.equal(tool.name, CHANNEL_CREATE_TOOL_NAME);
  assert.equal(tool.name, 'channel.create');
  assert.equal(tool.risk, 'gated');
  assert.deepEqual((tool.parameters as { required?: string[] }).required, ['channel', 'name']);
  assert.ok(GATEWAY_ONLY_TOOL_NAMES.includes(CHANNEL_CREATE_TOOL_NAME));
});

test('channel.create passes a trimmed request as the calling agent and returns what the channel did', async () => {
  const { calls, tool } = recording();
  const result = await tool.execute({
    channel: ' slack ',
    name: ' client-acme ',
    private: true,
    topic: ' Acme launch ',
    purpose: 'Where we talk with Acme',
    invite: [' U123 ', 'kai', 'U123'],
  }, sessionFor('blair'));
  assert.deepEqual(calls, [{
    agentId: 'blair',
    channel: 'slack',
    name: 'client-acme',
    private: true,
    topic: 'Acme launch',
    purpose: 'Where we talk with Acme',
    invite: ['U123', 'kai'],
  }]);
  assert.deepEqual(result, {
    created: true,
    channel: 'slack',
    conversation: 'C9',
    name: 'client-acme',
    invited: ['U123', 'kai'],
    notInvited: [],
    notSet: [],
  });
});

test('channel.create leaves out what was not given', async () => {
  const { calls, tool } = recording();
  await tool.execute({ channel: 'slack', name: 'ops', topic: '  ', invite: [] }, sessionFor('kai'));
  assert.deepEqual(calls, [{ agentId: 'kai', channel: 'slack', name: 'ops' }]);
});

test('channel.create refuses a malformed request before the channel is asked', async () => {
  const { calls, tool } = recording();
  const session = sessionFor('blair');
  const bad: Array<[Record<string, unknown>, RegExp]> = [
    [{ name: 'ops' }, /"channel"/],
    [{ channel: 'slack' }, /"name"/],
    [{ channel: 'slack', name: '   ' }, /"name"/],
    [{ channel: 'slack', name: 'ops', private: 'yes' }, /"private" must be true or false/],
    [{ channel: 'slack', name: 'ops', topic: 7 }, /"topic" must be a string/],
    [{ channel: 'slack', name: 'ops', purpose: false }, /"purpose" must be a string/],
    [{ channel: 'slack', name: 'ops', invite: 'U1' }, /"invite" must be a list/],
    [{ channel: 'slack', name: 'ops', invite: ['U1', ''] }, /"invite" must be a list/],
    [{ channel: 'slack', name: 'ops', invite: ['U1', 3] }, /"invite" must be a list/],
  ];
  for (const [input, message] of bad) {
    await assert.rejects(tool.execute(input as never, session), message, JSON.stringify(input));
  }
  assert.deepEqual(calls, []);
});

test('channel.create reports partial results the channel returns', async () => {
  const tool = createChannelCreateTool(async () => ({
    conversation: 'C9',
    name: 'ops',
    invited: ['U1'],
    notInvited: [{ who: 'U2', reason: 'not a user in this workspace' }],
    notSet: [{ field: 'topic', reason: 'too long' }],
  }));
  const result = await tool.execute({ channel: 'slack', name: 'ops', invite: ['U1', 'U2'] }, sessionFor('blair')) as { notInvited: unknown; notSet: unknown };
  assert.deepEqual(result.notInvited, [{ who: 'U2', reason: 'not a user in this workspace' }]);
  assert.deepEqual(result.notSet, [{ field: 'topic', reason: 'too long' }]);
});
