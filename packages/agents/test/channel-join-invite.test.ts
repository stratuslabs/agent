import test from 'node:test';
import assert from 'node:assert/strict';

import type { Session } from '@stratusagent/core';
import {
  CHANNEL_INVITE_TOOL_NAME,
  CHANNEL_JOIN_TOOL_NAME,
  createChannelInviteTool,
  createChannelJoinTool,
  GATEWAY_ONLY_TOOL_NAMES,
  type ConversationInviter,
  type ConversationJoiner,
} from '../src/index.ts';

const sessionFor = (agentId: string): Session => {
  const now = new Date().toISOString();
  return { id: 'sess-1', agent: { id: agentId, name: agentId }, status: 'running', messages: [], createdAt: now, updatedAt: now };
};

const joining = () => {
  const calls: Array<Parameters<ConversationJoiner>[0]> = [];
  const tool = createChannelJoinTool(async (input) => {
    calls.push(input);
    return { conversation: input.conversation, alreadyMember: false };
  });
  return { calls, tool };
};

const inviting = () => {
  const calls: Array<Parameters<ConversationInviter>[0]> = [];
  const tool = createChannelInviteTool(async (input) => {
    calls.push(input);
    return { invited: [...input.invite], notInvited: [] };
  });
  return { calls, tool };
};

test('channel.join and channel.invite are gated, gateway-only, and ask for ids', () => {
  const join = joining().tool;
  const invite = inviting().tool;
  assert.equal(join.name, CHANNEL_JOIN_TOOL_NAME);
  assert.equal(join.name, 'channel.join');
  assert.equal(invite.name, CHANNEL_INVITE_TOOL_NAME);
  assert.equal(invite.name, 'channel.invite');
  for (const tool of [join, invite]) {
    assert.equal(tool.risk, 'gated', tool.name);
    assert.ok(GATEWAY_ONLY_TOOL_NAMES.includes(tool.name), tool.name);
  }
  assert.deepEqual((join.parameters as { required?: string[] }).required, ['channel', 'conversation']);
  const inviteSchema = invite.parameters as { required?: string[]; properties: { invite: { minItems?: number } } };
  assert.deepEqual(inviteSchema.required, ['channel', 'conversation', 'invite']);
  assert.equal(inviteSchema.properties.invite.minItems, 1);
});

test('channel.join passes a trimmed request as the calling agent and returns ids only', async () => {
  const { calls, tool } = joining();
  const result = await tool.execute({ channel: ' slack ', conversation: ' C0OPS ' }, sessionFor('blair'));
  assert.deepEqual(calls, [{ agentId: 'blair', channel: 'slack', conversation: 'C0OPS' }]);
  assert.deepEqual(result, { joined: true, channel: 'slack', conversation: 'C0OPS', alreadyMember: false });

  const again = createChannelJoinTool(async () => ({ conversation: 'C0OPS', alreadyMember: true }));
  assert.deepEqual(await again.execute({ channel: 'slack', conversation: 'C0OPS' }, sessionFor('blair')), {
    joined: true,
    channel: 'slack',
    conversation: 'C0OPS',
    alreadyMember: true,
  });
});

test('channel.invite passes a trimmed, de-duplicated list as the calling agent', async () => {
  const { calls, tool } = inviting();
  const result = await tool.execute({ channel: 'slack', conversation: ' C0OPS ', invite: [' U123 ', 'kai', 'U123'] }, sessionFor('blair'));
  assert.deepEqual(calls, [{ agentId: 'blair', channel: 'slack', conversation: 'C0OPS', invite: ['U123', 'kai'] }]);
  assert.deepEqual(result, { channel: 'slack', conversation: 'C0OPS', invited: ['U123', 'kai'], notInvited: [] });
});

test('channel.invite reports who the channel did not invite', async () => {
  const tool = createChannelInviteTool(async () => ({
    invited: ['U1'],
    notInvited: [{ who: 'U2', reason: 'Slack did not invite them (cant_invite).' }],
  }));
  const result = await tool.execute({ channel: 'slack', conversation: 'C0OPS', invite: ['U1', 'U2'] }, sessionFor('blair'));
  assert.deepEqual(result, {
    channel: 'slack',
    conversation: 'C0OPS',
    invited: ['U1'],
    notInvited: [{ who: 'U2', reason: 'Slack did not invite them (cant_invite).' }],
  });
});

test('channel.join and channel.invite refuse a malformed request before the channel is asked', async () => {
  const join = joining();
  const invite = inviting();
  const session = sessionFor('blair');
  const badJoin: Array<[Record<string, unknown>, RegExp]> = [
    [{ conversation: 'C1' }, /"channel"/],
    [{ channel: 'slack' }, /"conversation"/],
    [{ channel: 'slack', conversation: '  ' }, /"conversation"/],
    [{ channel: 'slack', conversation: 7 }, /"conversation"/],
  ];
  for (const [input, message] of badJoin) {
    await assert.rejects(join.tool.execute(input as never, session), message, JSON.stringify(input));
  }
  const badInvite: Array<[Record<string, unknown>, RegExp]> = [
    [{ conversation: 'C1', invite: ['U1'] }, /"channel"/],
    [{ channel: 'slack', invite: ['U1'] }, /"conversation"/],
    [{ channel: 'slack', conversation: 'C1' }, /"invite" must list at least one/],
    [{ channel: 'slack', conversation: 'C1', invite: [] }, /"invite" must list at least one/],
    [{ channel: 'slack', conversation: 'C1', invite: ['  '] }, /"invite" must be a list of non-empty ids/],
    [{ channel: 'slack', conversation: 'C1', invite: 'U1' }, /"invite" must be a list/],
    [{ channel: 'slack', conversation: 'C1', invite: ['U1', 3] }, /"invite" must be a list/],
  ];
  for (const [input, message] of badInvite) {
    await assert.rejects(invite.tool.execute(input as never, session), message, JSON.stringify(input));
  }
  assert.deepEqual(join.calls, []);
  assert.deepEqual(invite.calls, []);
});
