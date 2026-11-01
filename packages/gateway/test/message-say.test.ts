import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { JsonObject } from '@stratusagent/core';
import { createGateway, type GatewayChannelAdapter } from '../src/index.ts';

const openAiText = (text: string): Response =>
  new Response(
    JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const openAiToolCall = (name: string, args: object): Response =>
  new Response(
    JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(args) } }],
        },
      }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

type SayRequest = Parameters<NonNullable<GatewayChannelAdapter['say']>>[0];

/** A daemon whose model sends one mid-task message, then answers. */
const startSaying = async (channel: GatewayChannelAdapter) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-gw-say-'));
  const agentsDir = path.join(home, '.stratus', 'agents');
  await mkdir(agentsDir, { recursive: true });
  await writeFile(path.join(agentsDir, 'kai.md'), '---\nname: Kai\nprovider: openai\nmodel: model-a\n---\n\nYou are Kai.\n');
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    // Each turn: the message first, then the answer.
    return calls % 2 === 1 ? openAiToolCall('message_say', { text: 'Need your OK before I delete the branch.' }) : openAiText('done');
  }) as typeof fetch;
  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0, log: () => {}, warn: () => {}, channels: [channel] });
  await gateway.start();
  return gateway;
};

const sayResult = (session: { messages: Array<{ role: string; toolResult?: { ok: boolean; output: unknown; error?: string } }> }) =>
  session.messages.find((message) => message.role === 'tool')?.toolResult;

test('message.say reaches the channel that carries the conversation, for that session and agent (card 1009)', async () => {
  const said: SayRequest[] = [];
  const gateway = await startSaying({
    name: 'slack',
    start: async () => {},
    stop: async () => {},
    say: async (request) => {
      said.push(request);
    },
  });
  try {
    const session = await gateway.dispatch({
      sessionId: 'kai-1',
      agentId: 'kai',
      userMessage: 'clean up the branches',
      metadata: { channel: 'slack', slackChannel: 'C1', slackThread: '100.1' },
    });
    assert.deepEqual(said.map(({ sessionId, agentId, text }) => ({ sessionId, agentId, text })), [
      { sessionId: 'kai-1', agentId: 'kai', text: 'Need your OK before I delete the branch.' },
    ]);
    assert.deepEqual(sayResult(session)?.output as JsonObject, { sent: true });
  } finally {
    await gateway.stop();
  }
});

test('message.say tells the agent to use its reply when the conversation cannot take a mid-task message', async () => {
  const gateway = await startSaying({ name: 'slack', start: async () => {}, stop: async () => {} });
  try {
    // A channel without `say`.
    const inSlack = await gateway.dispatch({ sessionId: 'kai-1', agentId: 'kai', userMessage: 'go', metadata: { channel: 'slack', slackChannel: 'C1' } });
    assert.equal(sayResult(inSlack)?.ok, false);
    assert.match(sayResult(inSlack)?.error ?? '', /channel \(slack\) cannot take a mid-task message.*reply/);
    // No channel at all: a terminal run, a schedule nobody is watching.
    const bare = await gateway.dispatch({ sessionId: 'kai-2', agentId: 'kai', userMessage: 'go' });
    assert.equal(sayResult(bare)?.ok, false);
    assert.match(sayResult(bare)?.error ?? '', /not in a channel that can take a mid-task message.*reply/);
  } finally {
    await gateway.stop();
  }
});

test('a channel that cannot deliver the message says why, and the agent hears it', async () => {
  const gateway = await startSaying({
    name: 'slack',
    start: async () => {},
    stop: async () => {},
    say: async () => {
      throw new Error('This turn already sent 3 mid-task messages. Put the rest in your reply.');
    },
  });
  try {
    const session = await gateway.dispatch({ sessionId: 'kai-1', agentId: 'kai', userMessage: 'go', metadata: { channel: 'slack', slackChannel: 'C1' } });
    assert.equal(sayResult(session)?.ok, false);
    assert.match(sayResult(session)?.error ?? '', /already sent 3 mid-task messages/);
  } finally {
    await gateway.stop();
  }
});
