import test from 'node:test';
import assert from 'node:assert/strict';

import { EventBus, type Session } from '@stratusagent/core';
import {
  channelSessionKey,
  type ChannelAdapter,
  type GatewayLike,
  type InboundMessage,
} from '../src/index.ts';

test('channel session keys are stable, agent-scoped, and thread-aware', () => {
  const threaded = channelSessionKey({
    channel: 'slack',
    agentId: 'ava',
    team: 'T1',
    conversation: 'C1',
    thread: '1712.34',
  });
  assert.equal(threaded, 'slack:ava:T1:C1:1712.34');
  // Same parts → same key: this is what makes conversations resumable.
  assert.equal(
    threaded,
    channelSessionKey({ channel: 'slack', agentId: 'ava', team: 'T1', conversation: 'C1', thread: '1712.34' }),
  );

  // Another agent in the same thread gets a different session.
  const otherAgent = channelSessionKey({
    channel: 'slack',
    agentId: 'bea',
    team: 'T1',
    conversation: 'C1',
    thread: '1712.34',
  });
  assert.notEqual(threaded, otherAgent);

  // DMs key on the conversation alone: one ongoing conversation per peer.
  const dm = channelSessionKey({ channel: 'slack', agentId: 'ava', team: 'T1', conversation: 'D9' });
  assert.equal(dm, 'slack:ava:T1:D9');
});

test('the contract runs end to end against a fake adapter and a stub gateway', async () => {
  const dispatched: Array<{ sessionId: string; agentId?: string; userMessage: string }> = [];
  const bus = new EventBus();

  const gateway: GatewayLike = {
    bus,
    agents: () => [{ id: 'ava', name: 'Ava' }],
    async dispatch(input) {
      dispatched.push({ sessionId: input.sessionId, ...(input.agentId ? { agentId: input.agentId } : {}), userMessage: input.userMessage });
      const now = new Date().toISOString();
      const session: Session = {
        id: input.sessionId,
        agent: { id: input.agentId ?? 'ava', name: 'Ava' },
        status: 'completed',
        messages: [
          { id: 'm1', role: 'assistant', content: `echo: ${input.userMessage}`, createdAt: now },
        ],
        createdAt: now,
        updatedAt: now,
      };
      await bus.emit({ type: 'session.completed', sessionId: session.id });
      return session;
    },
  };

  const completions: string[] = [];
  const adapter: ChannelAdapter = {
    name: 'fake',
    async start(gw) {
      gw.bus.subscribe((event) => {
        if (event.type === 'session.completed') {
          completions.push(event.sessionId);
        }
      });
      const inbound: InboundMessage = {
        channel: 'fake',
        team: 'T1',
        conversation: 'C1',
        thread: '42.1',
        author: { id: 'U1' },
        text: 'hello there',
        mentionsAgent: true,
        eventId: 'evt-1',
      };
      await gw.dispatch({
        sessionId: channelSessionKey({
          channel: inbound.channel,
          agentId: 'ava',
          team: inbound.team,
          conversation: inbound.conversation,
          ...(inbound.thread ? { thread: inbound.thread } : {}),
        }),
        agentId: 'ava',
        userMessage: inbound.text,
      });
    },
    async stop() {},
  };

  await adapter.start(gateway);
  await adapter.stop();

  assert.deepEqual(dispatched, [
    { sessionId: 'fake:ava:T1:C1:42.1', agentId: 'ava', userMessage: 'hello there' },
  ]);
  assert.deepEqual(completions, ['fake:ava:T1:C1:42.1']);
});
