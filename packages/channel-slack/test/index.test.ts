import test from 'node:test';
import assert from 'node:assert/strict';

import { EventBus, type Session, type StratusEvent } from '@stratusagent/core';
import type { GatewayLike } from '@stratusagent/channels';
import {
  createSlackChannelAdapter,
  type SlackSocketEventArgs,
  type SlackSocketLike,
  type SlackWebLike,
} from '../src/index.ts';

interface FakeSocket extends SlackSocketLike {
  deliver(eventName: string, args: Omit<SlackSocketEventArgs, 'ack'>): Promise<void>;
  started: boolean;
  disconnected: boolean;
  acks: number;
}

const createFakeSocket = (): FakeSocket => {
  const listeners = new Map<string, Array<(args: SlackSocketEventArgs) => void>>();
  const socket: FakeSocket = {
    started: false,
    disconnected: false,
    acks: 0,
    on(eventName, listener) {
      const existing = listeners.get(eventName) ?? [];
      existing.push(listener);
      listeners.set(eventName, existing);
    },
    async start() {
      socket.started = true;
    },
    async disconnect() {
      socket.disconnected = true;
    },
    async deliver(eventName, args) {
      const handlers = listeners.get(eventName) ?? [];
      for (const handler of handlers) {
        handler({ ...args, ack: async () => { socket.acks += 1; } });
      }
      // Handlers run async work after acking; let it settle.
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  };
  return socket;
};

interface FakeWeb extends SlackWebLike {
  posts: Array<{ channel: string; text: string; thread_ts?: string }>;
  updates: Array<{ channel: string; ts: string; text: string }>;
  uploads: Array<{ channel_id: string; file: string }>;
}

const createFakeWeb = (botUserId: string, teamId: string): FakeWeb => {
  let counter = 0;
  const web: FakeWeb = {
    posts: [],
    updates: [],
    uploads: [],
    auth: {
      async test() {
        return { user_id: botUserId, team_id: teamId };
      },
    },
    chat: {
      async postMessage(args) {
        web.posts.push(args);
        counter += 1;
        return { ts: `bot-ts-${counter}`, channel: args.channel };
      },
      async update(args) {
        web.updates.push(args);
        return {};
      },
    },
    files: {
      async uploadV2(args) {
        web.uploads.push({ channel_id: args.channel_id, file: args.file });
        return {};
      },
    },
    users: {
      async info({ user }) {
        return { user: { profile: { display_name: user === 'U-DYLAN' ? 'Dylan' : `name-${user}` } } };
      },
    },
  };
  return web;
};

const sessionWithReply = (id: string, reply: string): Session => {
  const now = new Date().toISOString();
  return {
    id,
    agent: { id: 'ava', name: 'Ava' },
    status: 'completed',
    messages: [{ id: 'm1', role: 'assistant', content: reply, createdAt: now }],
    createdAt: now,
    updatedAt: now,
  };
};

interface StubGateway extends GatewayLike {
  dispatches: Array<{ sessionId: string; agentId?: string; userMessage: string }>;
}

const createStubGateway = (
  reply: (input: { sessionId: string; userMessage: string }) => Promise<Session> | Session,
): StubGateway => {
  const bus = new EventBus();
  const gateway: StubGateway = {
    bus,
    dispatches: [],
    agents: () => [
      { id: 'ava', name: 'Ava' },
      { id: 'bea', name: 'Bea' },
    ],
    async dispatch(input) {
      gateway.dispatches.push({
        sessionId: input.sessionId,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        userMessage: input.userMessage,
      });
      return reply({ sessionId: input.sessionId, userMessage: input.userMessage });
    },
  };
  return gateway;
};

const mention = (text: string, overrides: Partial<import('../src/index.ts').SlackInboundEvent> = {}) => ({
  body: { team_id: 'T1', event_id: `evt-${text}-${overrides.ts ?? '100.1'}` },
  event: {
    type: 'app_mention',
    user: 'U-DYLAN',
    text,
    ts: '100.1',
    channel: 'C1',
    ...overrides,
  },
});

test('a channel mention dispatches with a thread-rooted session key and streams the reply', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'hello from Ava'));

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });

  await adapter.start(gateway);
  assert.equal(socket.started, true);

  await socket.deliver('app_mention', mention('<@B-AVA> hello there'));

  // Top-level mention: its own ts roots the conversation thread.
  assert.deepEqual(gateway.dispatches, [
    { sessionId: 'slack:ava:T1:C1:100.1', agentId: 'ava', userMessage: 'Dylan: hello there' },
  ]);
  assert.equal(socket.acks, 1);
  // Placeholder posted into the thread, then edited to the final reply.
  assert.equal(web.posts[0]?.thread_ts, '100.1');
  assert.equal(web.updates.at(-1)?.text, 'hello from Ava');

  await adapter.stop();
  assert.equal(socket.disconnected, true);
});

test('a threaded mention resumes the thread conversation; DMs key on the channel alone', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'ok'));

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);

  await socket.deliver('app_mention', mention('<@B-AVA> in thread', { ts: '200.2', thread_ts: '150.0' }));
  await socket.deliver('message', {
    body: { team_id: 'T1', event_id: 'evt-dm-1' },
    event: { type: 'message', channel_type: 'im', user: 'U-DYLAN', text: 'hi in dm', ts: '300.3', channel: 'D9' },
  });
  await adapter.stop();

  assert.deepEqual(gateway.dispatches.map((d) => d.sessionId), [
    'slack:ava:T1:C1:150.0', // thread_ts wins for threaded replies
    'slack:ava:T1:D9', // DMs: one conversation per peer, no thread
  ]);
  // DM replies are not threaded, and the author prefix is dropped in DMs.
  assert.equal(gateway.dispatches[1]?.userMessage, 'hi in dm');
  assert.equal(web.posts.at(-1)?.thread_ts, undefined);
});

test('redelivered events are deduped and bot/self messages are ignored', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'once'));

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);

  const payload = mention('<@B-AVA> do it once');
  await socket.deliver('app_mention', payload);
  await socket.deliver('app_mention', payload); // Socket Mode redelivery
  await socket.deliver('app_mention', {
    body: { team_id: 'T1', event_id: 'evt-bot' },
    event: { type: 'app_mention', user: 'U-OTHERBOT', bot_id: 'B123', text: 'beep', ts: '400.4', channel: 'C1' },
  });
  await adapter.stop();

  assert.equal(gateway.dispatches.length, 1);
  // Redeliveries are still acked so Slack stops resending.
  assert.equal(socket.acks, 3);
});

test('streaming deltas edit the placeholder before the final reply lands', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const bus = new EventBus();

  const gateway: GatewayLike = {
    bus,
    agents: () => [{ id: 'ava', name: 'Ava' }],
    async dispatch(input) {
      await bus.emit({ type: 'provider.delta', sessionId: input.sessionId, delta: { type: 'text', text: 'Working' } });
      await bus.emit({ type: 'tool.called', sessionId: input.sessionId, call: { id: 'c1', toolName: 'demo.echo', input: {} } });
      await new Promise((resolve) => setTimeout(resolve, 30));
      return sessionWithReply(input.sessionId, 'Done. All set.');
    },
  };

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);
  await socket.deliver('app_mention', mention('<@B-AVA> stream please'));
  await adapter.stop();

  const texts = web.updates.map((update) => update.text);
  // Streaming edits carried partial text (and the tool status line) before
  // the finalize replaced everything with the authoritative reply.
  assert.ok(texts.some((text) => text.includes('Working')), `expected a streaming edit, got ${JSON.stringify(texts)}`);
  assert.ok(texts.some((text) => text.includes('⚙ demo.echo…')), 'expected a tool status line');
  assert.equal(texts.at(-1), 'Done. All set.');
});

test('two agents in one thread hold separate sessions with their own identities', async () => {
  const socketAva = createFakeSocket();
  const socketBea = createFakeSocket();
  const webAva = createFakeWeb('B-AVA', 'T1');
  const webBea = createFakeWeb('B-BEA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'hi'));

  const adapter = createSlackChannelAdapter({
    agents: [
      { agentId: 'ava', appToken: 'xapp-a', botToken: 'xoxb-a' },
      { agentId: 'bea', appToken: 'xapp-b', botToken: 'xoxb-b' },
    ],
    editIntervalMs: 0,
    createSocketClient: (appToken) => (appToken === 'xapp-a' ? socketAva : socketBea),
    createWebClient: (botToken) => (botToken === 'xoxb-a' ? webAva : webBea),
  });
  await adapter.start(gateway);

  await socketAva.deliver('app_mention', {
    body: { team_id: 'T1', event_id: 'evt-a' },
    event: { type: 'app_mention', user: 'U-DYLAN', text: '<@B-AVA> hi ava', ts: '500.1', thread_ts: '500.0', channel: 'C1' },
  });
  await socketBea.deliver('app_mention', {
    body: { team_id: 'T1', event_id: 'evt-b' },
    event: { type: 'app_mention', user: 'U-DYLAN', text: '<@B-BEA> hi bea', ts: '500.2', thread_ts: '500.0', channel: 'C1' },
  });
  await adapter.stop();

  assert.deepEqual(gateway.dispatches.map((d) => [d.agentId, d.sessionId]), [
    ['ava', 'slack:ava:T1:C1:500.0'],
    ['bea', 'slack:bea:T1:C1:500.0'],
  ]);
});

test('a failed turn edits the placeholder into an error note instead of going silent', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const gateway = createStubGateway(() => {
    throw new Error('provider exploded');
  });

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);
  await socket.deliver('app_mention', mention('<@B-AVA> break'));
  await adapter.stop();

  assert.match(web.updates.at(-1)?.text ?? '', /Something went wrong: provider exploded/);
});

test('replies longer than one Slack message split across thread messages', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const longReply = `${'first part\n'.repeat(300)}${'x'.repeat(2000)}`;
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, longReply));

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);
  await socket.deliver('app_mention', mention('<@B-AVA> write a lot'));
  await adapter.stop();

  // First chunk replaces the placeholder; the rest posts into the thread.
  const followUps = web.posts.slice(1);
  assert.ok(followUps.length >= 1, 'expected follow-up messages for the long reply');
  const reassembled = [web.updates.at(-1)?.text ?? '', ...followUps.map((post) => post.text)].join('\n');
  assert.equal(reassembled.replaceAll('\n', ''), longReply.replaceAll('\n', ''));
  for (const post of followUps) {
    assert.equal(post.thread_ts, '100.1');
  }
});

test('unknown roster agents are skipped with a warning and the rest connect', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const warnings: string[] = [];
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'hi'));

  const adapter = createSlackChannelAdapter({
    agents: [
      { agentId: 'ghost', appToken: 'xapp-g', botToken: 'xoxb-g' },
      { agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' },
    ],
    warn: (line) => warnings.push(line),
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);
  await adapter.stop();

  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /ghost/);
  assert.equal(socket.started, true);
});
