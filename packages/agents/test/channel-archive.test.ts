import test from 'node:test';
import assert from 'node:assert/strict';

import type { Session } from '@stratusagent/core';
import {
  CHANNEL_ARCHIVE_TOOL_NAME,
  createChannelArchiveTool,
  GATEWAY_ONLY_TOOL_NAMES,
  type ConversationArchiver,
} from '../src/index.ts';

const sessionFor = (agentId: string): Session => {
  const now = new Date().toISOString();
  return { id: 'sess-1', agent: { id: agentId, name: agentId }, status: 'running', messages: [], createdAt: now, updatedAt: now };
};

const archiving = (answer: Awaited<ReturnType<ConversationArchiver>> = { conversation: 'C0OPS', alreadyArchived: false }) => {
  const calls: Array<{ input: Parameters<ConversationArchiver>[0]; session: Session }> = [];
  const tool = createChannelArchiveTool(async (input, session) => {
    calls.push({ input, session });
    return answer;
  });
  return { calls, tool };
};

test('channel.archive is gated, gateway-only, asks for an id, and says it cannot be undone', () => {
  const { tool } = archiving();
  assert.equal(tool.name, CHANNEL_ARCHIVE_TOOL_NAME);
  assert.equal(tool.name, 'channel.archive');
  assert.equal(tool.risk, 'gated');
  assert.ok(GATEWAY_ONLY_TOOL_NAMES.includes(tool.name));
  assert.deepEqual((tool.parameters as { required?: string[] }).required, ['channel', 'conversation']);
  assert.match(tool.description ?? '', /your own app created/);
  assert.match(tool.description ?? '', /can.t undo/);
  assert.match(tool.description ?? '', /a person can unarchive/i);
});

test('channel.archive passes a trimmed request as the calling agent, with its session, and returns ids only', async () => {
  const { calls, tool } = archiving();
  const session = sessionFor('blair');
  const result = await tool.execute({ channel: ' slack ', conversation: ' C0OPS ' }, session);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.input, { agentId: 'blair', channel: 'slack', conversation: 'C0OPS' });
  assert.equal(calls[0]!.session, session);
  assert.deepEqual(result, { archived: true, channel: 'slack', conversation: 'C0OPS', alreadyArchived: false });
});

test('channel.archive says when the channel was already archived, and never repeats anything else the channel returns', async () => {
  const { tool } = archiving({ conversation: 'C0OPS', alreadyArchived: true, name: 'renamed-by-a-member' } as never);
  assert.deepEqual(await tool.execute({ channel: 'slack', conversation: 'C0OPS' }, sessionFor('blair')), {
    archived: true,
    channel: 'slack',
    conversation: 'C0OPS',
    alreadyArchived: true,
  });
});

test('channel.archive refuses a malformed request before the channel is asked', async () => {
  const { calls, tool } = archiving();
  const session = sessionFor('blair');
  const bad: Array<[Record<string, unknown>, RegExp]> = [
    [{ conversation: 'C1' }, /"channel"/],
    [{ channel: 'slack' }, /"conversation"/],
    [{ channel: 'slack', conversation: '  ' }, /"conversation"/],
    [{ channel: 'slack', conversation: 7 }, /"conversation"/],
  ];
  for (const [input, message] of bad) {
    await assert.rejects(tool.execute(input as never, session), message, JSON.stringify(input));
  }
  assert.deepEqual(calls, []);
});

test('channel.archive has a refusal hook only when the host gives one, and hands it the trimmed request and the session', async () => {
  assert.equal(archiving().tool.refusalFor, undefined);
  const seen: Array<{ input: { agentId: string; channel: string; conversation: string }; session: Session }> = [];
  const tool = createChannelArchiveTool(async () => ({ conversation: 'C1', alreadyArchived: false }), {
    refusalFor: async (input, session) => {
      seen.push({ input, session });
      return input.conversation === 'C1' ? 'not that one' : undefined;
    },
  });
  const session = sessionFor('blair');
  assert.equal(await tool.refusalFor!({ channel: ' slack ', conversation: ' C1 ' }, session), 'not that one');
  assert.equal(await tool.refusalFor!({ channel: 'slack', conversation: 'C2' }, session), undefined);
  assert.equal(await tool.refusalFor!({ channel: 'slack', conversation: '  ' }, session), undefined, 'a malformed call is left to execute');
  assert.deepEqual(seen.map(({ input }) => input), [
    { agentId: 'blair', channel: 'slack', conversation: 'C1' },
    { agentId: 'blair', channel: 'slack', conversation: 'C2' },
  ]);
  assert.equal(seen[0]!.session, session);
});
