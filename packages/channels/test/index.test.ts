import test from 'node:test';
import assert from 'node:assert/strict';

import { EventBus, type Session } from '@stratusagent/core';
import {
  admitsSender,
  channelSessionKey,
  isPrincipal,
  senderTrustFor,
  type ChannelAdapter,
  type GatewayLike,
  type InboundMessage,
  type OutboundConnection,
  type SenderPolicy,
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
    // Not what this contract test exercises, but part of GatewayLike — the
    // stub had gone stale against the interface without anything noticing,
    // which is the whole reason tests are typechecked now.
    resolveApproval: () => false,
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

test('a text-message channel resolves a connection that can only post', async () => {
  // A channel with no editable messages and no file upload: `post` is the
  // whole contract, and the type admits it. Before `edit` and `upload` were
  // optional this literal failed typecheck, which is the test.
  const posted: string[] = [];
  const connection: OutboundConnection = {
    async post(text) {
      posted.push(text);
      return { channel: '+15550100', ts: String(posted.length) };
    },
  };
  const adapter: ChannelAdapter = {
    name: 'sms',
    async start() {},
    async stop() {},
    resolveOutbound: async () => connection,
  };

  const resolved = await adapter.resolveOutbound!({ agentId: 'ava', to: '+15550100' });
  assert.deepEqual(await resolved.post('hello'), { channel: '+15550100', ts: '1' });
  assert.equal(resolved.edit, undefined);
  assert.equal(resolved.upload, undefined);
  assert.deepEqual(posted, ['hello']);
});

test('admission refuses unlisted senders only under admit: principals', () => {
  const listed: SenderPolicy = { principals: ['U1'], admit: 'principals' };
  assert.equal(admitsSender(listed, 'U1'), true);
  assert.equal(admitsSender(listed, 'U2'), false);

  // `anyone` and an absent `admit` both let everyone in; the list is then
  // only provenance.
  assert.equal(admitsSender({ principals: ['U1'], admit: 'anyone' }, 'U2'), true);
  assert.equal(admitsSender({ principals: ['U1'] }, 'U2'), true);

  // `principals` with nobody listed refuses everyone — an empty door is shut,
  // not open.
  assert.equal(admitsSender({ admit: 'principals' }, 'U1'), false);
  assert.equal(admitsSender({ principals: [], admit: 'principals' }, 'U1'), false);

  // No policy at all is nobody's to refuse.
  assert.equal(admitsSender(undefined, 'U1'), true);
});

test('sender trust is user for a principal and unknown for everyone else', () => {
  const policy: SenderPolicy = { principals: ['+15550100', 'ava@example.com'] };
  assert.equal(senderTrustFor(policy, '+15550100'), 'user');
  assert.equal(senderTrustFor(policy, 'ava@example.com'), 'user');
  assert.equal(senderTrustFor(policy, '+15550199'), 'unknown');
  // Admitting someone does not make them a principal.
  assert.equal(senderTrustFor({ admit: 'anyone' }, 'U1'), 'unknown');
  assert.equal(senderTrustFor(undefined, 'U1'), 'unknown');
  assert.equal(isPrincipal({ principals: [] }, 'U1'), false);
});
