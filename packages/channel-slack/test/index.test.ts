import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { EventBus, type ApprovalAnswer, type Session, type StratusEvent } from '@stratusagent/core';
import type { GatewayLike } from '@stratusagent/channels';
import {
  createSlackChannelAdapter,
  type SlackBlock,
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
  posts: Array<{ channel: string; text: string; thread_ts?: string; blocks?: SlackBlock[] }>;
  updates: Array<{ channel: string; ts: string; text: string; blocks?: SlackBlock[] }>;
  ephemerals: Array<{ channel: string; user: string; text: string }>;
  uploads: Array<{ channel_id: string; filename?: string; contents: string; wasBuffer: boolean }>;
  userInfoDelayMs?: (callIndex: number) => number;
  /** Called as chat.postMessage is entered, before it awaits `postGate`. */
  onPostEnter?: () => void;
  /** Held by chat.postMessage, so a test can act while a post is in flight. */
  postGate?: Promise<void>;
  /** What conversations.info answers for; anything else rejects channel_not_found. */
  knownConversations: Map<string, { is_member?: boolean; is_im?: boolean }>;
}

const createFakeWeb = (botUserId: string, teamId: string): FakeWeb => {
  let counter = 0;
  let userInfoCalls = 0;
  const web: FakeWeb = {
    posts: [],
    updates: [],
    ephemerals: [],
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
        const ts = `bot-ts-${counter}`;
        web.onPostEnter?.();
        if (web.postGate) {
          await web.postGate;
        }
        return { ts, channel: args.channel };
      },
      async update(args) {
        web.updates.push(args);
        return {};
      },
      async postEphemeral(args) {
        web.ephemerals.push(args);
        return {};
      },
    },
    files: {
      async uploadV2(args) {
        // The real SDK takes file contents; a path string would fail there.
        web.uploads.push({
          channel_id: args.channel_id,
          ...(args.filename ? { filename: args.filename } : {}),
          contents: Buffer.isBuffer(args.file) ? args.file.toString('utf8') : String(args.file),
          wasBuffer: Buffer.isBuffer(args.file),
        });
        return {};
      },
    },
    knownConversations: new Map(),
    conversations: {
      async info({ channel }) {
        const known = web.knownConversations.get(channel);
        if (!known) {
          throw new Error('channel_not_found');
        }
        return { channel: { id: channel, ...known } };
      },
    },
    users: {
      async info({ user }) {
        userInfoCalls += 1;
        const delay = web.userInfoDelayMs?.(userInfoCalls) ?? 0;
        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
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
  resolutions: Array<{ requestId: string; answer: ApprovalAnswer; actor?: string; reason?: string }>;
  /** Request ids the gateway still considers pending. */
  pendingApprovals: Set<string>;
}

const createStubGateway = (
  reply: (input: { sessionId: string; userMessage: string }) => Promise<Session> | Session,
): StubGateway => {
  const bus = new EventBus();
  const activeTurns = new Map<string, string>();
  const gateway: StubGateway = {
    bus,
    dispatches: [],
    resolutions: [],
    pendingApprovals: new Set<string>(),
    agents: () => [
      { id: 'ava', name: 'Ava' },
      { id: 'bea', name: 'Bea' },
    ],
    resolveApproval(input) {
      gateway.resolutions.push(input);
      if (!gateway.pendingApprovals.delete(input.requestId)) {
        return false;
      }
      void bus.emit({
        type: 'tool.approval-resolved',
        sessionId: 'sess-1',
        requestId: input.requestId,
        answer: input.answer,
        reason: input.reason ?? 'decided',
        ...(input.actor ? { actor: input.actor } : {}),
      });
      return true;
    },
    async dispatch(input) {
      gateway.dispatches.push({
        sessionId: input.sessionId,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        userMessage: input.userMessage,
      });
      // As the gateway does: the caller's turn id is the session's active
      // turn for as long as the turn runs, and the session reports
      // `running` as the turn begins.
      if (input.turnId !== undefined) {
        activeTurns.set(input.sessionId, input.turnId);
      }
      try {
        await bus.emit({ type: 'session.updated', sessionId: input.sessionId, status: 'running' });
        return await reply({ sessionId: input.sessionId, userMessage: input.userMessage });
      } finally {
        activeTurns.delete(input.sessionId);
      }
    },
    activeTurnId: (sessionId) => activeTurns.get(sessionId),
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
    // Not what these fakes exercise; refusing keeps GatewayLike satisfied
    // without pretending there is a request to resolve.
    resolveApproval: () => false,
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

test('queued turns in one thread keep their own renderers', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const bus = new EventBus();

  let turn = 0;
  const gateway: GatewayLike = {
    bus,
    // Not what these fakes exercise; refusing keeps GatewayLike satisfied
    // without pretending there is a request to resolve.
    resolveApproval: () => false,
    agents: () => [{ id: 'ava', name: 'Ava' }],
    async dispatch(input) {
      turn += 1;
      const thisTurn = turn;
      // Deltas emitted mid-turn must land on THIS turn's renderer even
      // though a second message already queued its own.
      await new Promise((resolve) => setTimeout(resolve, 30));
      await bus.emit({ type: 'provider.delta', sessionId: input.sessionId, delta: { type: 'text', text: `turn-${thisTurn}-delta` } });
      await new Promise((resolve) => setTimeout(resolve, 10));
      return sessionWithReply(input.sessionId, `turn-${thisTurn}-final`);
    },
  };

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);

  // Two messages into the SAME thread before the first turn finishes.
  const one = socket.deliver('app_mention', {
    body: { team_id: 'T1', event_id: 'evt-q1' },
    event: { type: 'app_mention', user: 'U-DYLAN', text: '<@B-AVA> first', ts: '700.1', thread_ts: '700.0', channel: 'C1' },
  });
  const two = socket.deliver('app_mention', {
    body: { team_id: 'T1', event_id: 'evt-q2' },
    event: { type: 'app_mention', user: 'U-DYLAN', text: '<@B-AVA> second', ts: '700.2', thread_ts: '700.0', channel: 'C1' },
  });
  await Promise.all([one, two]);
  await adapter.stop();

  // Placeholder 1 got turn 1's delta and final; placeholder 2 got turn 2's.
  const byTs = new Map<string, string[]>();
  for (const update of web.updates) {
    byTs.set(update.ts, [...(byTs.get(update.ts) ?? []), update.text]);
  }
  const [firstTs, secondTs] = web.posts.map((_post, index) => `bot-ts-${index + 1}`);
  assert.ok((byTs.get(firstTs!) ?? []).some((text) => text.includes('turn-1-delta')), 'turn 1 deltas must edit the first placeholder');
  assert.equal((byTs.get(firstTs!) ?? []).at(-1), 'turn-1-final');
  assert.ok(!(byTs.get(secondTs!) ?? []).some((text) => text.includes('turn-1')), 'turn 1 output must never touch the second placeholder');
  assert.equal((byTs.get(secondTs!) ?? []).at(-1), 'turn-2-final');
});

test('file-bearing tool results upload their contents into the conversation', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'slack-upload-'));
  const shotPath = path.join(dir, 'shot.png');
  const extraPath = path.join(dir, 'extra.pdf');
  await writeFile(shotPath, 'png-bytes');
  await writeFile(extraPath, 'pdf-bytes');

  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const bus = new EventBus();

  const gateway: GatewayLike = {
    bus,
    // Not what these fakes exercise; refusing keeps GatewayLike satisfied
    // without pretending there is a request to resolve.
    resolveApproval: () => false,
    agents: () => [{ id: 'ava', name: 'Ava' }],
    async dispatch(input) {
      await bus.emit({
        type: 'tool.completed',
        sessionId: input.sessionId,
        result: {
          callId: 'c1',
          toolName: 'browser.screenshot',
          ok: true,
          output: { file: shotPath, files: [extraPath] },
        },
      });
      return sessionWithReply(input.sessionId, 'here you go');
    },
  };

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);
  await socket.deliver('app_mention', mention('<@B-AVA> screenshot please'));
  await adapter.stop();

  // Uploads carry the file DATA (the real SDK rejects path strings).
  assert.deepEqual(web.uploads, [
    { channel_id: 'C1', filename: 'shot.png', contents: 'png-bytes', wasBuffer: true },
    { channel_id: 'C1', filename: 'extra.pdf', contents: 'pdf-bytes', wasBuffer: true },
  ]);
  assert.equal(web.updates.at(-1)?.text, 'here you go');
});

test('a reset delta discards partial streamed text before the retry streams', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const bus = new EventBus();

  const gateway: GatewayLike = {
    bus,
    // Not what these fakes exercise; refusing keeps GatewayLike satisfied
    // without pretending there is a request to resolve.
    resolveApproval: () => false,
    agents: () => [{ id: 'ava', name: 'Ava' }],
    async dispatch(input) {
      await bus.emit({ type: 'provider.delta', sessionId: input.sessionId, delta: { type: 'text', text: 'doomed partial' } });
      await bus.emit({ type: 'provider.delta', sessionId: input.sessionId, delta: { type: 'reset' } });
      await bus.emit({ type: 'provider.delta', sessionId: input.sessionId, delta: { type: 'text', text: 'clean retry' } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      return sessionWithReply(input.sessionId, 'clean retry, finished');
    },
  };

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);
  await socket.deliver('app_mention', mention('<@B-AVA> retry please'));
  await adapter.stop();

  const finalEdit = web.updates.at(-1)?.text ?? '';
  assert.equal(finalEdit, 'clean retry, finished');
  // No edit after the reset may carry the abandoned attempt's text.
  const resetIndex = web.updates.findIndex((update) => !update.text.includes('doomed'));
  for (const update of web.updates.slice(Math.max(resetIndex, 0))) {
    assert.ok(!update.text.includes('doomed partial') || web.updates.indexOf(update) < resetIndex + 1, `late edit leaked partial text: ${update.text}`);
  }
});

test('inbound order per session survives slow user lookups', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  // The first message's user lookup is slow; without per-session intake
  // ordering, the second message would reach the gateway first and the
  // durable conversation would run in reverse.
  web.userInfoDelayMs = (call) => (call === 1 ? 40 : 0);
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'ok'));

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);

  const one = socket.deliver('app_mention', {
    body: { team_id: 'T1', event_id: 'evt-o1' },
    event: { type: 'app_mention', user: 'U-DYLAN', text: '<@B-AVA> first', ts: '800.1', thread_ts: '800.0', channel: 'C1' },
  });
  const two = socket.deliver('app_mention', {
    body: { team_id: 'T1', event_id: 'evt-o2' },
    event: { type: 'app_mention', user: 'U-DYLAN', text: '<@B-AVA> second', ts: '800.2', thread_ts: '800.0', channel: 'C1' },
  });
  await Promise.all([one, two]);
  // stop() drains what the adapter still owes Slack, so it is the gate —
  // a sleep in front of it was guessing at the same thing, and losing that
  // guess on a loaded runner would fail an assertion about ordering.
  await adapter.stop();

  assert.deepEqual(gateway.dispatches.map((d) => d.userMessage), ['Dylan: first', 'Dylan: second']);
});

test('the tool status line clears as soon as the tool completes', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const bus = new EventBus();

  const gateway: GatewayLike = {
    bus,
    // Not what these fakes exercise; refusing keeps GatewayLike satisfied
    // without pretending there is a request to resolve.
    resolveApproval: () => false,
    agents: () => [{ id: 'ava', name: 'Ava' }],
    async dispatch(input) {
      await bus.emit({ type: 'tool.called', sessionId: input.sessionId, call: { id: 'c1', toolName: 'demo.echo', input: {} } });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await bus.emit({ type: 'tool.completed', sessionId: input.sessionId, result: { callId: 'c1', toolName: 'demo.echo', ok: true, output: {} } });
      // A slow, non-streaming follow-up provider turn: the message must
      // not claim the tool is still running all this time.
      await new Promise((resolve) => setTimeout(resolve, 40));
      return sessionWithReply(input.sessionId, 'done');
    },
  };

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);
  await socket.deliver('app_mention', mention('<@B-AVA> run the tool'));
  await new Promise((resolve) => setTimeout(resolve, 60));
  await adapter.stop();

  const texts = web.updates.map((update) => update.text);
  const toolIndex = texts.findIndex((text) => text.includes('⚙'));
  assert.ok(toolIndex >= 0, 'expected a tool status edit');
  const afterTool = texts.slice(toolIndex + 1, -1);
  assert.ok(afterTool.length > 0, 'expected an edit between tool completion and finalize');
  for (const text of afterTool) {
    assert.ok(!text.includes('⚙'), `status line must clear promptly, saw: ${text}`);
  }
  assert.equal(texts.at(-1), 'done');
});

test('streamed text from consecutive provider turns stays separated', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const bus = new EventBus();

  const gateway: GatewayLike = {
    bus,
    // Not what these fakes exercise; refusing keeps GatewayLike satisfied
    // without pretending there is a request to resolve.
    resolveApproval: () => false,
    agents: () => [{ id: 'ava', name: 'Ava' }],
    async dispatch(input) {
      await bus.emit({ type: 'provider.delta', sessionId: input.sessionId, delta: { type: 'text', text: "I'll check." } });
      await bus.emit({ type: 'provider.response', sessionId: input.sessionId, parts: [] });
      await bus.emit({ type: 'provider.delta', sessionId: input.sessionId, delta: { type: 'text', text: 'The result is 4.' } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      return sessionWithReply(input.sessionId, "I'll check.\n\nThe result is 4.");
    },
  };

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);
  await socket.deliver('app_mention', mention('<@B-AVA> what is 2+2'));
  await adapter.stop();

  // The streaming edit keeps the turns visually separate — never
  // "I'll check.The result is 4." fused into one sentence.
  assert.ok(
    web.updates.some((update) => update.text.includes("I'll check.\n\nThe result is 4.")),
    `expected separated turns in streaming edits, got ${JSON.stringify(web.updates.map((u) => u.text))}`,
  );
  assert.ok(web.updates.every((update) => !update.text.includes("check.The")));
});

test('long replies never split an emoji across the message boundary', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  // No newlines, and a surrogate pair straddling the 4000-unit boundary.
  const reply = `${'a'.repeat(3999)}😀${'b'.repeat(200)}`;
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, reply));

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);
  await socket.deliver('app_mention', mention('<@B-AVA> emoji wall'));
  await adapter.stop();

  const chunks = [web.updates.at(-1)?.text ?? '', ...web.posts.slice(1).map((post) => post.text)];
  assert.equal(chunks.join(''), reply, 'chunks must reassemble exactly');
  for (const chunk of chunks) {
    // A lone surrogate half would appear if the cut landed inside 😀.
    assert.ok(chunk.isWellFormed(), `chunk split a surrogate pair: …${chunk.slice(-5)}`);
  }
});

test('a turn that produced no text finalizes as (no reply), never an older answer', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const now = new Date().toISOString();
  // A resumed conversation: the previous turn answered, this turn's
  // provider returned nothing visible.
  const gateway = createStubGateway(({ sessionId }) => ({
    id: sessionId,
    agent: { id: 'ava', name: 'Ava' },
    status: 'completed' as const,
    messages: [
      { id: 'u1', role: 'user' as const, content: 'earlier question', createdAt: now },
      { id: 'a1', role: 'assistant' as const, content: 'the older answer', createdAt: now },
      { id: 'u2', role: 'user' as const, content: 'new question', createdAt: now },
    ],
    createdAt: now,
    updatedAt: now,
  }));

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);
  await socket.deliver('app_mention', mention('<@B-AVA> new question'));
  await adapter.stop();

  assert.equal(web.updates.at(-1)?.text, '(no reply)');
});

// ---- remote approval ------------------------------------------------------

const approvalRequest = (
  overrides: Partial<Extract<StratusEvent, { type: 'tool.approval-requested' }>> = {},
): Extract<StratusEvent, { type: 'tool.approval-requested' }> => ({
  type: 'tool.approval-requested',
  sessionId: 'slack:ava:T1:C1:100.1',
  agentId: 'ava',
  requestId: 'req-1',
  call: { id: 'call-1', toolName: 'shell.run', input: { command: 'ls' } },
  risk: 'gated',
  metadata: { channel: 'slack', team: 'T1', slackChannel: 'C1', slackThread: '100.1' },
  expiresAt: '2026-08-18T00:15:00.000Z',
  ...overrides,
});

/**
 * A click, carrying the message it came from the way Slack does.
 *
 * `blocks` is not decoration: a block_actions payload includes the message
 * as Slack holds it when it processes the interaction, and that is how the
 * adapter tells a prompt still offering a decision from one already
 * rewritten with an outcome. `settled: true` is the second kind — what a
 * message looks like after any ending has been written onto it.
 */
const click = (
  actionId: string,
  requestId: string,
  user: string,
  options: { settled?: boolean } = {},
) => ({
  body: {
    team_id: 'T1',
    user: { id: user },
    channel: { id: 'C1' },
    message: {
      ts: 'bot-ts-1',
      thread_ts: '100.1',
      blocks: options.settled
        ? [{ type: 'section', text: { type: 'mrkdwn', text: 'already decided' } }]
        : [
            { type: 'section', text: { type: 'mrkdwn', text: 'Ava wants to run shell.run (gated).' } },
            {
              type: 'actions',
              elements: [
                { type: 'button', action_id: 'stratus_approve_once', value: requestId },
                { type: 'button', action_id: 'stratus_approve_always', value: requestId },
                { type: 'button', action_id: 'stratus_deny', value: requestId },
              ],
            },
          ],
    },
    actions: [{ action_id: actionId, value: requestId }],
  },
});

const approvalAdapter = (agents: Array<Record<string, unknown>>) => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'ok'));
  const adapter = createSlackChannelAdapter({
    agents: agents as never,
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  return { socket, web, gateway, adapter };
};

const buttonIds = (blocks: SlackBlock[] | undefined): string[] => {
  const actions = (blocks ?? []).find((block) => block.type === 'actions') as
    | { elements?: Array<{ action_id?: string }> }
    | undefined;
  return (actions?.elements ?? []).map((element) => element.action_id ?? '');
};

test('a parked call is asked in the thread it came from, with three buttons', async () => {
  const { socket, web, gateway, adapter } = approvalAdapter([
    { agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1', approvers: ['U-DYLAN'] },
  ]);
  await adapter.start(gateway);

  gateway.pendingApprovals.add('req-1');
  await gateway.bus.emit(approvalRequest());

  const posted = web.posts.at(-1);
  assert.equal(posted?.channel, 'C1');
  // Asked in the conversation the turn belongs to, not at the top of the
  // channel: the person waiting on the answer is already reading here.
  assert.equal(posted?.thread_ts, '100.1');
  // Fallback text matters as much as the blocks — notifications and older
  // clients show only this, and an approval nobody can read is no approval.
  assert.match(posted?.text ?? '', /Ava wants to run shell\.run \(gated\)/);
  assert.deepEqual(buttonIds(posted?.blocks), [
    'stratus_approve_once',
    'stratus_approve_always',
    'stratus_deny',
  ]);

  await socket.deliver('interactive', click('stratus_approve_always', 'req-1', 'U-DYLAN'));
  assert.deepEqual(gateway.resolutions, [{ requestId: 'req-1', answer: 'always', actor: 'U-DYLAN' }]);
  assert.equal(socket.acks, 1, 'Slack retries an unacked interaction');

  // Resolved: the buttons come off, so the message cannot keep offering a
  // decision with nowhere to land.
  const update = web.updates.at(-1);
  assert.equal(buttonIds(update?.blocks).length, 0);
  assert.match(update?.text ?? '', /Allowed for the rest of this session by <@U-DYLAN>/);

  await adapter.stop();
});

test('a click from outside the approver set is refused and the request stays pending', async () => {
  const { socket, web, gateway, adapter } = approvalAdapter([
    { agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1', approvers: ['U-DYLAN'] },
  ]);
  await adapter.start(gateway);

  gateway.pendingApprovals.add('req-1');
  await gateway.bus.emit(approvalRequest());

  await socket.deliver('interactive', click('stratus_approve_always', 'req-1', 'U-STRANGER'));

  // Posting into a channel must never make everyone in it an approver —
  // especially for "Always allow", which widens the session's scope.
  assert.deepEqual(gateway.resolutions, [], 'a non-approver never reaches the gateway');
  assert.equal(gateway.pendingApprovals.has('req-1'), true, 'the request is still pending');
  assert.deepEqual(
    web.ephemerals.map((entry) => ({ user: entry.user, channel: entry.channel })),
    [{ user: 'U-STRANGER', channel: 'C1' }],
  );
  assert.match(web.ephemerals[0]?.text ?? '', /not an approver for Ava/);
  // Still offering the decision to the people who may actually make it.
  assert.equal(web.updates.length, 0);

  // And an approver clicking afterwards still works.
  await socket.deliver('interactive', click('stratus_deny', 'req-1', 'U-DYLAN'));
  assert.deepEqual(gateway.resolutions, [{ requestId: 'req-1', answer: 'deny', actor: 'U-DYLAN' }]);

  await adapter.stop();
});

test('a request with no approver configured is denied on arrival, not left to expire', async () => {
  const { web, gateway, adapter } = approvalAdapter([
    { agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' },
  ]);
  await adapter.start(gateway);

  gateway.pendingApprovals.add('req-1');
  await gateway.bus.emit(approvalRequest());

  // Waiting out the timeout would tell the agent nothing it cannot be told
  // now, while holding the turn — and the thread — open for the whole window.
  // `undeliverable`, not `decided`: nobody was asked, and filing this
  // beside the denials somebody actually made would make the audit record
  // lie about which is which.
  assert.deepEqual(
    gateway.resolutions,
    [{ requestId: 'req-1', answer: 'deny', reason: 'undeliverable' }],
  );
  assert.equal(web.posts.length, 0, 'nothing is asked when nobody can answer');

  await adapter.stop();
});

test('a turn outside Slack asks in the configured approval channel', async () => {
  const { web, gateway, adapter } = approvalAdapter([
    { agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1', approvers: ['U-DYLAN'], approvalChannel: 'C-OPS' },
  ]);
  await adapter.start(gateway);

  gateway.pendingApprovals.add('req-2');
  // A scheduled or delegated turn has no Slack conversation of its own.
  await gateway.bus.emit(approvalRequest({ requestId: 'req-2', sessionId: 'cron:ava:nightly', metadata: {} }));

  assert.equal(web.posts.at(-1)?.channel, 'C-OPS');
  assert.equal(web.posts.at(-1)?.thread_ts, undefined);

  await adapter.stop();
});

test('a click on a request this daemon never rendered is answered, not dropped', async () => {
  const { socket, web, gateway, adapter } = approvalAdapter([
    { agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1', approvers: ['U-DYLAN'] },
  ]);
  await adapter.start(gateway);

  // Buttons outlive the daemon that posted them: a restart leaves real
  // messages in Slack whose requests are gone.
  await socket.deliver('interactive', click('stratus_approve_once', 'req-from-a-past-life', 'U-DYLAN'));

  assert.deepEqual(gateway.resolutions, []);
  assert.match(web.ephemerals.at(-1)?.text ?? '', /no longer pending/);

  await adapter.stop();
});

test('an expired request retracts its own buttons', async () => {
  const { web, gateway, adapter } = approvalAdapter([
    { agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1', approvers: ['U-DYLAN'] },
  ]);
  await adapter.start(gateway);

  gateway.pendingApprovals.add('req-1');
  await gateway.bus.emit(approvalRequest());
  assert.equal(web.posts.length, 1);

  // The timeout and a cancelled turn settle through the same event a click
  // does, so there is exactly one path that takes the buttons down.
  await gateway.bus.emit({
    type: 'tool.approval-resolved',
    sessionId: 'slack:ava:T1:C1:100.1',
    requestId: 'req-1',
    answer: 'deny',
    reason: 'timeout',
  });

  const update = web.updates.at(-1);
  assert.equal(buttonIds(update?.blocks).length, 0);
  assert.match(update?.text ?? '', /Expired without an answer/);
  assert.doesNotMatch(update?.text ?? '', /by <@/);

  await adapter.stop();
});

test('a request that settles mid-post still has its buttons retracted', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'ok'));

  // Hold the announcing post open, so the request can expire while the
  // message that offers the buttons is still being created. Without the
  // hand-off this leaves live-looking buttons in Slack forever: the
  // retraction runs before there is anything to retract.
  let releasePost: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    releasePost = resolve;
  });
  const realPost = web.chat.postMessage;
  web.chat.postMessage = async (args) => {
    await held;
    return realPost.call(web.chat, args);
  };

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1', approvers: ['U-DYLAN'] }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);

  gateway.pendingApprovals.add('req-1');
  const rendering = gateway.bus.emit(approvalRequest());
  await gateway.bus.emit({
    type: 'tool.approval-resolved',
    sessionId: 'slack:ava:T1:C1:100.1',
    requestId: 'req-1',
    answer: 'deny',
    reason: 'timeout',
  });
  assert.equal(web.updates.length, 0, 'nothing to retract yet — the post is still in flight');

  releasePost?.();
  await rendering;
  // The adapter's work is tracked, so the drain in stop() is the gate: the
  // retraction has landed by the time stop() returns, with no sleeping.
  await adapter.stop();

  assert.equal(buttonIds(web.updates.at(-1)?.blocks).length, 0);
  assert.match(web.updates.at(-1)?.text ?? '', /Expired without an answer/);
});

const sectionTexts = (blocks: SlackBlock[] | undefined): string[] =>
  (blocks ?? [])
    .filter((block) => block.type === 'section')
    .map((block) => String((block.text as { text?: string } | undefined)?.text ?? ''));

test('the approval prompt shows what is actually being approved', async () => {
  const { web, gateway, adapter } = approvalAdapter([
    { agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1', approvers: ['U-DYLAN'] },
  ]);
  await adapter.start(gateway);

  gateway.pendingApprovals.add('req-1');
  await gateway.bus.emit(approvalRequest({
    call: { id: 'c1', toolName: 'shell.run', input: { command: 'rm -rf /srv/data' } },
  }));

  // Without the arguments, `ls` and this produce an identical message —
  // the approver would be authorizing something they cannot see.
  const posted = web.posts.at(-1);
  assert.ok(
    sectionTexts(posted?.blocks).some((text) => text.includes('rm -rf /srv/data')),
    `expected the command in the blocks, got ${JSON.stringify(sectionTexts(posted?.blocks))}`,
  );
  // The notification preview is all some approvers see before deciding
  // whether to open the thread.
  assert.match(posted?.text ?? '', /rm -rf \/srv\/data/);

  await adapter.stop();
});

test('a tool argument cannot ping the workspace through the approval prompt', async () => {
  const { web, gateway, adapter } = approvalAdapter([
    { agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1', approvers: ['U-DYLAN'] },
  ]);
  await adapter.start(gateway);

  gateway.pendingApprovals.add('req-1');
  await gateway.bus.emit(approvalRequest({
    call: { id: 'c1', toolName: 'shell.run', input: { command: 'echo <!channel> <@U-DYLAN>' } },
  }));

  // Tool input is model-written text. Unescaped it would broadcast to the
  // channel and mention people — through the very message asking whether
  // the agent should be trusted.
  const posted = web.posts.at(-1);
  const rendered = [...sectionTexts(posted?.blocks), posted?.text ?? ''].join('\n');
  assert.equal(rendered.includes('<!channel>'), false, 'a broadcast survived into the prompt');
  assert.equal(rendered.includes('<@U-DYLAN>'), false, 'a mention survived into the prompt');
  assert.ok(rendered.includes('&lt;!channel&gt;'), 'the text is still readable, just inert');

  await adapter.stop();
});

test('over-long arguments are truncated and say so', async () => {
  const { web, gateway, adapter } = approvalAdapter([
    { agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1', approvers: ['U-DYLAN'] },
  ]);
  await adapter.start(gateway);

  gateway.pendingApprovals.add('req-1');
  await gateway.bus.emit(approvalRequest({
    call: { id: 'c1', toolName: 'shell.run', input: { command: 'x'.repeat(5000) } },
  }));

  const posted = web.posts.at(-1);
  // Slack rejects an over-long section outright, so an untruncated prompt
  // would not be a long message — it would be no message at all.
  for (const text of sectionTexts(posted?.blocks)) {
    assert.ok(text.length < 3000, `a section ran to ${text.length} characters`);
  }
  // A decision made on a partial view should at least know it is partial.
  const contexts = (posted?.blocks ?? []).filter((block) => block.type === 'context');
  assert.equal(contexts.length, 1, 'the truncation notice is missing');

  await adapter.stop();
});

test('an agent this adapter carries but cannot reach is denied, not abandoned', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'ok'));
  const warnings: string[] = [];
  // The app is configured but its auth fails, so no connection is made.
  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1', approvers: ['U-DYLAN'] }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => ({
      ...web,
      auth: { async test() { throw new Error('invalid_auth'); } },
    }),
    warn: (line) => warnings.push(line),
  });
  await adapter.start(gateway);

  gateway.pendingApprovals.add('req-1');
  await gateway.bus.emit(approvalRequest());

  // This adapter was supposed to carry Ava's approvals and cannot, so it
  // says so rather than letting every gated call wait out the timeout.
  assert.deepEqual(
    gateway.resolutions,
    [{ requestId: 'req-1', answer: 'deny', reason: 'undeliverable' }],
  );
  assert.ok(warnings.some((line) => line.includes('no live connection')), JSON.stringify(warnings));

  await adapter.stop();
});

test('an agent this adapter was never given is left for whoever does carry it', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'ok'));
  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1', approvers: ['U-DYLAN'] }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);

  gateway.pendingApprovals.add('req-bea');
  await gateway.bus.emit(approvalRequest({ requestId: 'req-bea', agentId: 'bea' }));

  // Approval requests are a broadcast. Denying an agent this adapter was
  // never configured for would let Slack refuse a question another channel
  // was about to ask.
  assert.deepEqual(gateway.resolutions, []);
  assert.equal(gateway.pendingApprovals.has('req-bea'), true);
  assert.equal(web.posts.length, 0);

  await adapter.stop();
});

test('a hosted tool separates the assistant turns around it', async () => {
  // The kernel loop marks the boundary with provider.response. A provider
  // that hosts its own loop never emits one mid-turn — the SDK consumes
  // the tool call internally — so tool.called is the only thing standing
  // between the text before the tool and the text after it.
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const bus = new EventBus();

  const gateway: GatewayLike = {
    bus,
    resolveApproval: () => false,
    agents: () => [{ id: 'ava', name: 'Ava' }],
    async dispatch(input) {
      const call = { id: 'c1', toolName: 'demo.echo', input: {} };
      await bus.emit({ type: 'provider.delta', sessionId: input.sessionId, delta: { type: 'text', text: "I'll check." } });
      // No provider.response here: that is the whole difference.
      await bus.emit({ type: 'tool.called', sessionId: input.sessionId, call });
      await bus.emit({
        type: 'tool.completed',
        sessionId: input.sessionId,
        result: { callId: call.id, toolName: call.toolName, ok: true, output: {} },
      });
      await bus.emit({ type: 'provider.delta', sessionId: input.sessionId, delta: { type: 'text', text: 'The result is 4.' } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      return sessionWithReply(input.sessionId, "I'll check.\n\nThe result is 4.");
    },
  };

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);
  await socket.deliver('app_mention', mention('<@B-AVA> what is 2+2'));
  await adapter.stop();

  assert.ok(
    web.updates.every((update) => !update.text.includes('check.The')),
    `turns fused in a streaming edit: ${JSON.stringify(web.updates.map((u) => u.text))}`,
  );
});

test('a denied hosted tool still separates the turns around it', async () => {
  // A denied call never emits tool.called, so the boundary that branch
  // sets is never reached — and the SDK keeps going, streaming the
  // model's reaction to the refusal straight onto the text before it.
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const bus = new EventBus();

  const gateway: GatewayLike = {
    bus,
    resolveApproval: () => false,
    agents: () => [{ id: 'ava', name: 'Ava' }],
    async dispatch(input) {
      await bus.emit({ type: 'provider.delta', sessionId: input.sessionId, delta: { type: 'text', text: "I'll check." } });
      await bus.emit({
        type: 'tool.denied',
        sessionId: input.sessionId,
        call: { id: 'c1', toolName: 'shell.run', input: {} },
      });
      await bus.emit({ type: 'provider.delta', sessionId: input.sessionId, delta: { type: 'text', text: 'The result is 4.' } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      return sessionWithReply(input.sessionId, "I'll check.\n\nThe result is 4.");
    },
  };

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);
  await socket.deliver('app_mention', mention('<@B-AVA> what is 2+2'));
  await adapter.stop();

  assert.ok(
    web.updates.every((update) => !update.text.includes('check.The')),
    `turns fused after a denial: ${JSON.stringify(web.updates.map((u) => u.text))}`,
  );
  // And the refused tool stops claiming to be running.
  assert.ok(
    web.updates.every((update) => !update.text.includes('shell.run…')) || !(web.updates.at(-1)?.text ?? '').includes('shell.run…'),
    `a denied tool kept its running status: ${JSON.stringify(web.updates.at(-1)?.text)}`,
  );
});

test('a click on a prompt left by a dead daemon retires it, using the click\'s own coordinates', async () => {
  // The index of posted requests is in-memory and keyed by request id, so
  // a restarted daemon starts empty and cannot find what its predecessor
  // posted. Telling the clicker is not enough on its own: the message
  // keeps its buttons, and the next person to read it is offered a
  // decision nothing is waiting for.
  const { socket, web, gateway, adapter } = approvalAdapter([
    { agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1', approvers: ['U-DYLAN'] },
  ]);
  await adapter.start(gateway);

  // No approvalRequest emitted: this adapter has never heard of req-ghost,
  // exactly as a fresh process has never heard of anything.
  await socket.deliver('interactive', click('stratus_approve_once', 'req-ghost', 'U-DYLAN'));

  assert.match(web.ephemerals.at(-1)?.text ?? '', /no longer pending/);
  const update = web.updates.at(-1);
  assert.equal(update?.channel, 'C1');
  assert.equal(update?.ts, 'bot-ts-1', 'the click carries the only handle on a message this process never posted');
  assert.equal(buttonIds(update?.blocks).length, 0, 'the retired prompt offers no decision');
  assert.match(update?.text ?? '', /no longer running/);

  await adapter.stop();
});

test('a click on a message that already carries its outcome does not overwrite it', async () => {
  // A click can still arrive for a request that is already decided — from
  // a stale render, or from a message whose outcome this process never
  // wrote. Treating either as an orphan would replace a real decision with
  // "no longer pending", losing the record of who decided what, which is
  // the whole point of rewriting the message. The message itself says
  // which it is: an ending has been written onto it, so it no longer
  // offers a decision.
  const { socket, web, gateway, adapter } = approvalAdapter([
    { agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1', approvers: ['U-DYLAN'] },
  ]);
  await adapter.start(gateway);

  gateway.pendingApprovals.add('req-1');
  await gateway.bus.emit(approvalRequest());
  await socket.deliver('interactive', click('stratus_approve_always', 'req-1', 'U-DYLAN'));

  const settled = web.updates.at(-1);
  assert.match(settled?.text ?? '', /Allowed for the rest of this session by <@U-DYLAN>/);
  const updatesAfterDecision = web.updates.length;

  // The same button, clicked again — the message now carries the outcome.
  await socket.deliver('interactive', click('stratus_approve_always', 'req-1', 'U-DYLAN', { settled: true }));

  assert.equal(web.updates.length, updatesAfterDecision, 'the settled message is left exactly as it was');
  assert.match(web.updates.at(-1)?.text ?? '', /Allowed for the rest of this session by <@U-DYLAN>/);
  assert.match(web.ephemerals.at(-1)?.text ?? '', /no longer pending/);

  await adapter.stop();
});

test('a turn that failed with nobody rendering it is reported in its own thread', async () => {
  // The intake path reports through the renderer it opened, so a turn this
  // process started is always answered. One it did not start — failed by
  // the startup sweep after a daemon died mid-turn — has no renderer, and
  // silence in the thread reads as an agent that simply never replied.
  const { web, gateway, adapter } = approvalAdapter([
    { agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' },
  ]);
  gateway.sessionRouting = async (sessionId: string) =>
    sessionId === 'slack:ava:T1:C1:100.1'
      ? {
          agentId: 'ava',
          metadata: { channel: 'slack', team: 'T1', slackChannel: 'C1', slackThread: '100.1' },
        }
      : undefined;
  await adapter.start(gateway);

  await gateway.bus.emit({
    type: 'session.failed',
    sessionId: 'slack:ava:T1:C1:100.1',
    error: 'stratusd stopped while this turn was still running; it was not resumed.',
  });
  // stop() drains what the adapter owes Slack, so this gates on the work
  // rather than on a sleep.
  await adapter.stop();

  const posted = web.posts.at(-1);
  assert.equal(posted?.channel, 'C1');
  assert.equal(posted?.thread_ts, '100.1', 'the report belongs in the thread the turn came from');
  assert.match(posted?.text ?? '', /not resumed/);
});

test('a turn that finished with nobody rendering it has its reply posted in its own thread', async () => {
  // The recovery case: parked on a human when the daemon died, re-asked
  // after the restart, approved, and finished by a process that never
  // opened a placeholder for it. The failure half of this has always been
  // reported; the reply half went nowhere.
  const { web, gateway, adapter } = approvalAdapter([
    { agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' },
  ]);
  gateway.sessionRouting = async (sessionId: string) =>
    sessionId === 'slack:ava:T1:C1:100.1'
      ? {
          agentId: 'ava',
          metadata: { channel: 'slack', team: 'T1', slackChannel: 'C1', slackThread: '100.1' },
          reply: 'Done — the deploy finished cleanly.',
        }
      : undefined;
  await adapter.start(gateway);

  await gateway.bus.emit({ type: 'session.completed', sessionId: 'slack:ava:T1:C1:100.1' });
  await adapter.stop();

  const posted = web.posts.at(-1);
  assert.equal(posted?.channel, 'C1');
  assert.equal(posted?.thread_ts, '100.1', 'the reply belongs in the thread the turn came from');
  assert.equal(posted?.text, 'Done — the deploy finished cleanly.');
});

test('a completion the running turn is already rendering is not posted a second time', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'the one reply'));
  let routingReads = 0;
  gateway.sessionRouting = async () => {
    routingReads += 1;
    return { agentId: 'ava', metadata: { channel: 'slack', team: 'T1', slackChannel: 'C1' }, reply: 'the one reply' };
  };
  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);
  await socket.deliver('app_mention', mention('<@B-AVA> do the thing'));
  await adapter.stop();

  assert.equal(routingReads, 0, 'a rendered turn is the renderer\'s to finish');
  const replies = [
    ...web.posts.filter((entry) => /the one reply/.test(entry.text)),
    ...web.updates.filter((entry) => /the one reply/.test(entry.text)),
  ];
  assert.equal(replies.length, 1, 'exactly one copy of the reply');
});

test('a recovered turn that finishes ahead of a queued message has its reply posted, and the message its own', async () => {
  // The daemon restarts with a turn parked on a human in this thread; the
  // recovery is re-asked and waits. A new message in the thread arrives
  // meanwhile: its renderer is queued, its turn waits behind the recovery
  // on the session chain. The recovery is then approved and finishes —
  // with a renderer in the queue that has nothing to do with it.
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'the message\'s own reply'));
  const stubDispatch = gateway.dispatch;
  gateway.dispatch = async (input) => {
    // The recovery finishes while this dispatch waits behind it — before
    // the stub reports the queued turn `running` and answers it.
    await gateway.bus.emit({ type: 'session.completed', sessionId: input.sessionId });
    return stubDispatch.call(gateway, input);
  };
  gateway.sessionRouting = async () => ({
    agentId: 'ava',
    metadata: { channel: 'slack', team: 'T1', slackChannel: 'C1', slackThread: '100.1' },
    reply: 'the recovered reply',
  });
  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);
  await socket.deliver('app_mention', mention('<@B-AVA> and another thing'));
  await adapter.stop();

  const texts = [...web.posts, ...web.updates].map((entry) => entry.text);
  assert.equal(texts.filter((text) => text === 'the recovered reply').length, 1, 'the recovery\'s reply was posted once');
  assert.equal(texts.filter((text) => /the message's own reply/.test(text)).length, 1, 'the message got its own reply once');

  // And in order: the placeholder the message posted first was handed to
  // the recovery's reply (an edit keeps its place), and the message's own
  // reply went into a fresh placeholder posted below it.
  const placeholders = web.posts.filter((entry) => entry.text === '…');
  assert.equal(placeholders.length, 2, 'the message opened a second placeholder below the recovered reply');
  assert.equal(web.updates.find((entry) => entry.text === 'the recovered reply')?.ts, 'bot-ts-1');
  assert.equal(web.updates.find((entry) => /the message's own reply/.test(entry.text))?.ts, 'bot-ts-2');
});

test('a recovered reply whose placeholder edit Slack refuses is posted as a message of its own, and the message keeps its placeholder', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const update = web.chat.update.bind(web.chat);
  web.chat.update = async (args) => {
    if (args.text === 'the recovered reply') {
      throw new Error('message_not_found');
    }
    return update(args);
  };
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'the message\'s own reply'));
  const stubDispatch = gateway.dispatch;
  gateway.dispatch = async (input) => {
    await gateway.bus.emit({ type: 'session.completed', sessionId: input.sessionId });
    return stubDispatch.call(gateway, input);
  };
  gateway.sessionRouting = async () => ({
    agentId: 'ava',
    metadata: { channel: 'slack', team: 'T1', slackChannel: 'C1', slackThread: '100.1' },
    reply: 'the recovered reply',
  });
  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);
  await socket.deliver('app_mention', mention('<@B-AVA> and another thing'));
  await adapter.stop();

  assert.equal(web.posts.filter((entry) => entry.text === 'the recovered reply').length, 1, 'the recovered reply was posted instead');
  assert.equal(web.posts.filter((entry) => entry.text === '…').length, 1, 'the placeholder was not handed over, so none was reopened');
  assert.equal(web.updates.find((entry) => /the message's own reply/.test(entry.text))?.ts, 'bot-ts-1');
});

test('what the recovery streamed into the queued placeholder does not follow it into the fresh one', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  // The queued turn's own streaming edit, once it lands in the fresh
  // placeholder — the gate, with a way to lose.
  let streamed!: (text: string) => void;
  const streamedEdit = new Promise<string>((resolve) => { streamed = resolve; });
  const update = web.chat.update.bind(web.chat);
  web.chat.update = async (args) => {
    if (args.ts === 'bot-ts-2') {
      streamed(args.text);
    }
    return update(args);
  };
  const gateway = createStubGateway(async ({ sessionId }) => {
    await gateway.bus.emit({ type: 'provider.delta', sessionId, delta: { type: 'text', text: 'own partial' } });
    const seen = await Promise.race([
      streamedEdit,
      new Promise<string>((resolve) => setTimeout(() => resolve('no streamed edit reached the fresh placeholder'), 2_000)),
    ]);
    assert.equal(seen, 'own partial', 'the fresh placeholder shows only this turn\'s stream');
    return sessionWithReply(sessionId, 'the message\'s own reply');
  });
  const stubDispatch = gateway.dispatch;
  gateway.dispatch = async (input) => {
    // The recovery streams into the placeholder at the head of the queue
    // — the queued message's — and then finishes.
    await gateway.bus.emit({ type: 'provider.delta', sessionId: input.sessionId, delta: { type: 'text', text: 'recovered partial' } });
    await gateway.bus.emit({ type: 'session.completed', sessionId: input.sessionId });
    return stubDispatch.call(gateway, input);
  };
  gateway.sessionRouting = async () => ({
    agentId: 'ava',
    metadata: { channel: 'slack', team: 'T1', slackChannel: 'C1', slackThread: '100.1' },
    reply: 'the recovered reply',
  });
  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);
  await socket.deliver('app_mention', mention('<@B-AVA> and another thing'));
  await adapter.stop();

  assert.ok(!web.updates.some((entry) => entry.ts === 'bot-ts-2' && /recovered partial/.test(entry.text)), 'the recovery\'s stream never reached the fresh placeholder');
  assert.equal(web.updates.find((entry) => entry.ts === 'bot-ts-2' && /the message's own reply/.test(entry.text))?.text, 'the message\'s own reply');
});

test('a handover whose fresh placeholder Slack refuses leaves the recovered reply standing, and the message posts its own', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const post = web.chat.postMessage.bind(web.chat);
  let placeholders = 0;
  web.chat.postMessage = async (args) => {
    if (args.text === '…' && ++placeholders === 2) {
      throw new Error('ratelimited');
    }
    return post(args);
  };
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'the message\'s own reply'));
  const stubDispatch = gateway.dispatch;
  gateway.dispatch = async (input) => {
    await gateway.bus.emit({ type: 'session.completed', sessionId: input.sessionId });
    return stubDispatch.call(gateway, input);
  };
  gateway.sessionRouting = async () => ({
    agentId: 'ava',
    metadata: { channel: 'slack', team: 'T1', slackChannel: 'C1', slackThread: '100.1' },
    reply: 'the recovered reply',
  });
  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);
  await socket.deliver('app_mention', mention('<@B-AVA> and another thing'));
  await adapter.stop();

  const first = web.updates.filter((entry) => entry.ts === 'bot-ts-1').map((entry) => entry.text);
  assert.deepEqual(first, ['the recovered reply'], 'nothing wrote over the reply the placeholder was handed to');
  assert.equal(web.posts.filter((entry) => entry.text === 'the message\'s own reply').length, 1, 'the message posted its reply as a message of its own');
});

test('a turn another surface dispatched to the thread\'s session is not taken for the queued message\'s, and its reply is posted', async () => {
  // The dashboard (or the control API) dispatches to this Slack thread's
  // session; a Slack message arrives while that turn is in its preflight,
  // so the message's renderer is queued before the foreign turn reports
  // `running`. The foreign turn is not the renderer's, however it looks
  // from the order of events, and its outcome belongs in the thread.
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'the message\'s own reply'));
  const stubDispatch = gateway.dispatch;
  const stubActiveTurn = gateway.activeTurnId!;
  let foreign: string | undefined;
  gateway.activeTurnId = (sessionId) => foreign ?? stubActiveTurn(sessionId);
  gateway.dispatch = async (input) => {
    // The foreign turn runs first on the session chain, under an id of its
    // own, and finishes before the queued message's turn starts.
    foreign = 'dashboard-turn';
    await gateway.bus.emit({ type: 'session.updated', sessionId: input.sessionId, status: 'running' });
    await gateway.bus.emit({ type: 'session.completed', sessionId: input.sessionId });
    foreign = undefined;
    return stubDispatch.call(gateway, input);
  };
  gateway.sessionRouting = async () => ({
    agentId: 'ava',
    metadata: { channel: 'slack', team: 'T1', slackChannel: 'C1', slackThread: '100.1' },
    reply: 'the dashboard turn\'s reply',
  });
  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);
  await socket.deliver('app_mention', mention('<@B-AVA> and another thing'));
  await adapter.stop();

  const texts = [...web.posts, ...web.updates].map((entry) => entry.text);
  assert.equal(texts.filter((text) => text === 'the dashboard turn\'s reply').length, 1, 'the foreign turn\'s reply reached the thread once');
  assert.equal(texts.filter((text) => /the message's own reply/.test(text)).length, 1, 'and the message got its own reply once');
});

test('two turns finishing ahead of a queued message each get their own place in the thread, in order', async () => {
  // Two control-API turns on the thread's session finish back to back
  // while a Slack message waits behind them: the first takes the queued
  // placeholder, the second the one reopened after it, and the message's
  // own reply lands in a third below both.
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'the message\'s own reply'));
  const stubDispatch = gateway.dispatch;
  gateway.dispatch = async (input) => {
    await gateway.bus.emit({ type: 'session.completed', sessionId: input.sessionId });
    await gateway.bus.emit({ type: 'session.completed', sessionId: input.sessionId });
    return stubDispatch.call(gateway, input);
  };
  let outcomes = 0;
  gateway.sessionRouting = async () => ({
    agentId: 'ava',
    metadata: { channel: 'slack', team: 'T1', slackChannel: 'C1', slackThread: '100.1' },
    reply: `outcome ${++outcomes}`,
  });
  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);
  await socket.deliver('app_mention', mention('<@B-AVA> and another thing'));
  await adapter.stop();

  const textsOn = (ts: string): string[] => web.updates.filter((entry) => entry.ts === ts).map((entry) => entry.text);
  assert.equal(web.posts.filter((entry) => entry.text === '…').length, 3, 'a placeholder for each turn, in order');
  assert.deepEqual(textsOn('bot-ts-1'), ['outcome 1']);
  assert.deepEqual(textsOn('bot-ts-2'), ['outcome 2']);
  assert.deepEqual(textsOn('bot-ts-3'), ['the message\'s own reply']);
});

test('a file a recovered turn produced follows its reply into the thread', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-slack-recovered-file-'));
  const shot = path.join(root, 'page.png');
  await writeFile(shot, 'png bytes');
  const { web, gateway, adapter } = approvalAdapter([
    { agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' },
  ]);
  gateway.sessionRouting = async () => ({
    agentId: 'ava',
    metadata: { channel: 'slack', team: 'T1', slackChannel: 'C1', slackThread: '100.1' },
    reply: 'Here is the screenshot.',
  });
  await adapter.start(gateway);

  // The recovered turn's screenshot: a tool result nobody was rendering.
  await gateway.bus.emit({
    type: 'tool.completed',
    sessionId: 'slack:ava:T1:C1:100.1',
    result: { callId: 'c1', toolName: 'browser.screenshot', ok: true, output: { file: shot } },
  });
  await gateway.bus.emit({ type: 'session.completed', sessionId: 'slack:ava:T1:C1:100.1' });
  await adapter.stop();

  assert.equal(web.posts.at(-1)?.text, 'Here is the screenshot.');
  assert.deepEqual(web.uploads.map((entry) => [entry.filename, entry.contents]), [['page.png', 'png bytes']]);
});

test('a handover arriving while a streamed edit is in flight and another is queued behind it still completes', async () => {
  // The recovery streams into the queued placeholder; one edit is out to
  // Slack and a second waits behind it when the recovery finishes. The
  // handover has to let those edits through without waiting on an edit
  // that is waiting on it.
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  let releaseFirstEdit!: () => void;
  const firstEditHeld = new Promise<void>((resolve) => { releaseFirstEdit = resolve; });
  let firstEditStarted!: () => void;
  const firstEditInFlight = new Promise<void>((resolve) => { firstEditStarted = resolve; });
  const update = web.chat.update.bind(web.chat);
  let edits = 0;
  web.chat.update = async (args) => {
    if (++edits === 1) {
      firstEditStarted();
      await firstEditHeld;
    }
    return update(args);
  };
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'the message\'s own reply'));
  const stubDispatch = gateway.dispatch;
  gateway.dispatch = async (input) => {
    await gateway.bus.emit({ type: 'provider.delta', sessionId: input.sessionId, delta: { type: 'text', text: 'recovered ' } });
    await firstEditInFlight;
    await gateway.bus.emit({ type: 'provider.delta', sessionId: input.sessionId, delta: { type: 'text', text: 'partial' } });
    // Let the second edit's timer fire and queue behind the held one.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    await gateway.bus.emit({ type: 'session.completed', sessionId: input.sessionId });
    releaseFirstEdit();
    return stubDispatch.call(gateway, input);
  };
  gateway.sessionRouting = async () => ({
    agentId: 'ava',
    metadata: { channel: 'slack', team: 'T1', slackChannel: 'C1', slackThread: '100.1' },
    reply: 'the recovered reply',
  });
  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);
  await socket.deliver('app_mention', mention('<@B-AVA> and another thing'));

  // The gate, with a way to lose: a deadlocked handover never lets stop()
  // drain, and 3s is far above anything this exchange does.
  const stopped = await Promise.race([
    adapter.stop().then(() => 'stopped'),
    new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 3_000)),
  ]);
  assert.equal(stopped, 'stopped');
  assert.equal(web.updates.find((entry) => entry.text === 'the recovered reply')?.ts, 'bot-ts-1');
  assert.equal(web.updates.find((entry) => /the message's own reply/.test(entry.text))?.ts, 'bot-ts-2');
});

test('each unrendered turn\'s files go with its own reply, even when two finish back to back', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-slack-two-files-'));
  const first = path.join(root, 'first.png');
  const second = path.join(root, 'second.png');
  await writeFile(first, 'first bytes');
  await writeFile(second, 'second bytes');
  const { web, gateway, adapter } = approvalAdapter([
    { agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' },
  ]);
  const calls: string[] = [];
  const post = web.chat.postMessage.bind(web.chat);
  web.chat.postMessage = async (args) => {
    calls.push(`post:${args.text}`);
    return post(args);
  };
  const upload = web.files.uploadV2.bind(web.files);
  let secondUploaded!: () => void;
  const secondFileSent = new Promise<void>((resolve) => { secondUploaded = resolve; });
  web.files.uploadV2 = async (args) => {
    calls.push(`upload:${args.filename}`);
    if (args.filename === 'second.png') {
      secondUploaded();
    }
    return upload(args);
  };
  // The first outcome's routing read is held until the second turn has
  // finished, so the second turn's file arrives while the first report is
  // still waiting on it.
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let outcomes = 0;
  gateway.sessionRouting = async () => {
    const outcome = ++outcomes;
    if (outcome === 1) {
      await firstHeld;
    }
    return {
      agentId: 'ava',
      metadata: { channel: 'slack', team: 'T1', slackChannel: 'C1', slackThread: '100.1' },
      reply: `reply ${outcome}`,
    };
  };
  await adapter.start(gateway);
  const sessionId = 'slack:ava:T1:C1:100.1';
  await gateway.bus.emit({ type: 'tool.completed', sessionId, result: { callId: 'c1', toolName: 'browser.screenshot', ok: true, output: { file: first } } });
  await gateway.bus.emit({ type: 'session.completed', sessionId });
  await gateway.bus.emit({ type: 'tool.completed', sessionId, result: { callId: 'c2', toolName: 'browser.screenshot', ok: true, output: { file: second } } });
  await gateway.bus.emit({ type: 'session.completed', sessionId });
  // The gate, with a way to lose: the second turn finishes its own report
  // while the first is held, or the bucket was drained by the first and
  // this never happens (which the upload list below then shows).
  await Promise.race([secondFileSent, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
  releaseFirst();
  await adapter.stop();

  // With each turn's files taken at its own outcome, the second turn
  // posts and uploads while the first is still held; without it the first
  // report drains the whole bucket and the second uploads nothing, so both
  // uploads land after the first reply.
  assert.deepEqual(calls.filter((call) => call.startsWith('upload:')), ['upload:second.png', 'upload:first.png']);
  assert.ok(
    calls.indexOf('upload:second.png') < calls.indexOf('post:reply 1'),
    `the second turn's file went with its own reply, not the first's: ${calls.join(', ')}`,
  );
});

test('a recovered turn\'s file lands above the reply of the message queued behind it', async () => {
  // A recovery finishes with a screenshot and nothing to say while a newer
  // Slack message waits behind it. An upload is a new message, so the file
  // would sit under the newer turn's answer unless the recovery takes the
  // placeholder that is already in the thread.
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-slack-order-file-'));
  const shot = path.join(root, 'recovered.png');
  await writeFile(shot, 'png bytes');
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const order: string[] = [];
  const post = web.chat.postMessage.bind(web.chat);
  web.chat.postMessage = async (args) => {
    order.push(`post:${args.text}`);
    return post(args);
  };
  const update = web.chat.update.bind(web.chat);
  web.chat.update = async (args) => {
    order.push(`update:${args.ts}:${args.text}`);
    return update(args);
  };
  const upload = web.files.uploadV2.bind(web.files);
  web.files.uploadV2 = async (args) => {
    order.push(`upload:${args.filename}`);
    return upload(args);
  };

  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'the message\'s own reply'));
  const stubDispatch = gateway.dispatch;
  gateway.dispatch = async (input) => {
    // The recovery is the running turn while this dispatch waits behind it.
    const stubActiveTurn = gateway.activeTurnId!;
    gateway.activeTurnId = () => 'recovered-turn';
    await gateway.bus.emit({
      type: 'tool.completed',
      sessionId: input.sessionId,
      result: { callId: 'c1', toolName: 'browser.screenshot', ok: true, output: { file: shot } },
    });
    await gateway.bus.emit({ type: 'session.completed', sessionId: input.sessionId });
    gateway.activeTurnId = stubActiveTurn;
    return stubDispatch.call(gateway, input);
  };
  gateway.sessionRouting = async () => ({
    agentId: 'ava',
    metadata: { channel: 'slack', team: 'T1', slackChannel: 'C1', slackThread: '100.1' },
  });
  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);
  await socket.deliver('app_mention', mention('<@B-AVA> and another thing'));
  await adapter.stop();

  // The recovery took the queued placeholder (an edit keeps its place), its
  // file follows, and the message's own reply lands in a placeholder opened
  // below both.
  assert.equal(order.indexOf('update:bot-ts-1:(no reply)') >= 0, true, order.join(', '));
  assert.ok(
    order.indexOf('upload:recovered.png') < order.indexOf("update:bot-ts-2:the message's own reply"),
    `the recovered file came before the newer turn's reply: ${order.join(', ')}`,
  );
  assert.equal(web.uploads.length, 1);
});

test('a recovered turn that produced a file and no text still has the file posted', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-slack-file-only-'));
  const shot = path.join(root, 'only.png');
  await writeFile(shot, 'only bytes');
  const { web, gateway, adapter } = approvalAdapter([
    { agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' },
  ]);
  gateway.sessionRouting = async () => ({
    agentId: 'ava',
    metadata: { channel: 'slack', team: 'T1', slackChannel: 'C1', slackThread: '100.1' },
  });
  await adapter.start(gateway);
  const sessionId = 'slack:ava:T1:C1:100.1';
  await gateway.bus.emit({ type: 'tool.completed', sessionId, result: { callId: 'c1', toolName: 'browser.screenshot', ok: true, output: { file: shot } } });
  await gateway.bus.emit({ type: 'session.completed', sessionId });
  await adapter.stop();

  assert.deepEqual(web.uploads.map((entry) => [entry.filename, entry.contents]), [['only.png', 'only bytes']]);
  assert.equal(web.posts.length, 0, 'nothing to say, so nothing said');
});

test('a recovered reply too long for one message is posted in full even when one of its parts is refused', async () => {
  const { web, gateway, adapter } = approvalAdapter([
    { agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' },
  ]);
  const reply = `${'a'.repeat(3_000)}\n${'b'.repeat(3_000)}\n${'c'.repeat(3_000)}`;
  gateway.sessionRouting = async () => ({
    agentId: 'ava',
    metadata: { channel: 'slack', team: 'T1', slackChannel: 'C1', slackThread: '100.1' },
    reply,
  });
  // Slack refuses the second part only.
  const post = web.chat.postMessage.bind(web.chat);
  let parts = 0;
  web.chat.postMessage = async (args) => {
    parts += 1;
    if (parts === 2) {
      throw new Error('ratelimited');
    }
    return post(args);
  };
  await adapter.start(gateway);
  await gateway.bus.emit({ type: 'session.completed', sessionId: 'slack:ava:T1:C1:100.1' });
  await adapter.stop();

  const posted = web.posts.map((entry) => entry.text);
  assert.deepEqual(posted, ['a'.repeat(3_000), 'c'.repeat(3_000)], 'the parts after the refused one were still posted');
});

test('a failure the running turn is already rendering is not reported twice', async () => {
  // The renderer opened at intake reports this one. Posting again would
  // put the same failure in the thread a second time, from the far side of
  // the same event.
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const gateway = createStubGateway(async ({ sessionId }) => {
    await gateway.bus.emit({ type: 'session.failed', sessionId, error: 'provider said no' });
    throw new Error('provider said no');
  });
  let routingReads = 0;
  gateway.sessionRouting = async () => {
    routingReads += 1;
    return { agentId: 'ava', metadata: { channel: 'slack', team: 'T1', slackChannel: 'C1' } };
  };

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);
  await socket.deliver('app_mention', mention('<@B-AVA> do the thing'));
  await adapter.stop();

  assert.equal(routingReads, 0, 'a rendered turn is the renderer\'s to report');
  const failures = [
    ...web.posts.filter((entry) => /provider said no/.test(entry.text)),
    ...web.updates.filter((entry) => /provider said no/.test(entry.text)),
  ];
  assert.equal(failures.length, 1, 'exactly one report of the failure');
});

test('a store that cannot answer does not take the daemon down with it', async () => {
  // The report is detached: the subscriber hands it to track() and returns
  // to the event loop, so nothing is awaiting it when it rejects. Under
  // Node's default that ends the process — the daemon dying because it
  // could not explain why a turn died.
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'ok'));
  gateway.sessionRouting = async () => {
    throw new Error('sqlite is having a day');
  };
  const warnings: string[] = [];
  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
    warn: (line) => warnings.push(line),
  });
  await adapter.start(gateway);

  await gateway.bus.emit({
    type: 'session.failed',
    sessionId: 'slack:ava:T1:C1:100.1',
    error: 'whatever went wrong',
  });
  // Drains the detached work, so the rejection has landed by the time the
  // assertions run rather than after the test is over.
  await adapter.stop();

  assert.equal(web.posts.length, 0, 'nothing to post when the routing is unknown');
  assert.ok(
    warnings.some((line) => /could not read the routing/.test(line)),
    `the failure is reported as a warning, not a crash: ${JSON.stringify(warnings)}`,
  );
});

test('a click that beats the post is not treated as an orphan', async () => {
  // Slack can show a message before postMessage resolves here, so a fast
  // click lands while the request is mid-post: absent from the index of
  // posts, but very much alive. Retiring it there would take the buttons
  // off a live question, and the record written when the post lands does
  // not put them back — the turn would wait out its whole approval window
  // with no way to answer.
  const { socket, web, gateway, adapter } = approvalAdapter([
    { agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1', approvers: ['U-DYLAN'] },
  ]);
  await adapter.start(gateway);

  let reachedPost = (): void => {};
  const posting = new Promise<void>((resolve) => { reachedPost = resolve; });
  let releasePost = (): void => {};
  web.onPostEnter = () => reachedPost();
  web.postGate = new Promise<void>((resolve) => { releasePost = resolve; });

  gateway.pendingApprovals.add('req-1');
  void gateway.bus.emit(approvalRequest());
  // Gated on the post being entered, not on a delay: the window opens when
  // postMessage is reached and closes when it returns.
  await posting;

  await socket.deliver('interactive', click('stratus_approve_once', 'req-1', 'U-DYLAN'));
  releasePost();
  // Asserted after the drain, not straight after deliver(): the retirement
  // this checks does NOT happen is an awaited API call, so checking before
  // the adapter has finished would pass whether or not the guard works.
  // deliver() waits a fixed 20ms for handlers to settle, which is a guess;
  // stop() drains them, which is not.
  await adapter.stop();

  assert.equal(web.updates.length, 0, 'a live request keeps its buttons');
  // Still answerable, which is the thing that was at stake.
  assert.equal(gateway.pendingApprovals.has('req-1'), true);
  const buttons = buttonIds(web.posts.at(-1)?.blocks);
  assert.deepEqual(buttons, ['stratus_approve_once', 'stratus_approve_always', 'stratus_deny']);
});

test('a resolution Slack refused leaves the prompt repairable by the next click', async () => {
  // Slack rejected the update, so the outcome never reached the message and
  // it still shows live buttons. There is nothing on it to protect, and a
  // later click has to be able to clean it up.
  const { socket, web, gateway, adapter } = approvalAdapter([
    { agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1', approvers: ['U-DYLAN'] },
  ]);
  await adapter.start(gateway);

  gateway.pendingApprovals.add('req-1');
  await gateway.bus.emit(approvalRequest());

  const realUpdate = web.chat.update;
  let refuse = true;
  web.chat.update = async (args) => {
    if (refuse) {
      refuse = false;
      throw new Error('slack said no');
    }
    return realUpdate(args);
  };

  // Decided, but the message never got rewritten.
  await socket.deliver('interactive', click('stratus_deny', 'req-1', 'U-DYLAN'));
  // Length rather than deepEqual against []: under assert/strict that is an
  // assertion signature, and it would narrow `web.updates` to never[] for
  // the rest of the test — where the repair below is read back.
  assert.equal(web.updates.length, 0, 'the outcome never reached the message');

  // A later click on those still-live buttons must be able to clean it up.
  await socket.deliver('interactive', click('stratus_deny', 'req-1', 'U-DYLAN'));
  await adapter.stop();

  const repaired = web.updates.at(-1);
  assert.match(repaired?.text ?? '', /no longer running/);
  assert.equal(buttonIds(repaired?.blocks).length, 0);
});

test('an update Slack applied but never confirmed does not lose its outcome', async () => {
  // The ambiguous half of a failed update: Slack commits the edit and the
  // response is lost, so the promise rejects over a message that now
  // carries the real decision. Deciding from the error would have to guess
  // which half this was; deciding from the message does not have to,
  // because the message is the thing at stake.
  const { socket, web, gateway, adapter } = approvalAdapter([
    { agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1', approvers: ['U-DYLAN'] },
  ]);
  await adapter.start(gateway);

  gateway.pendingApprovals.add('req-1');
  await gateway.bus.emit(approvalRequest());

  const realUpdate = web.chat.update;
  let swallowResponse = true;
  web.chat.update = async (args) => {
    await realUpdate(args);
    if (swallowResponse) {
      swallowResponse = false;
      throw new Error('connection reset after Slack committed the edit');
    }
    return {};
  };

  await socket.deliver('interactive', click('stratus_approve_always', 'req-1', 'U-DYLAN'));
  const outcome = web.updates.at(-1);
  assert.match(outcome?.text ?? '', /Allowed for the rest of this session by <@U-DYLAN>/);
  const updatesAfterOutcome = web.updates.length;

  // A later click on that message, which now carries the decision.
  await socket.deliver('interactive', click('stratus_deny', 'req-1', 'U-DYLAN', { settled: true }));
  await adapter.stop();

  assert.equal(web.updates.length, updatesAfterOutcome, 'the decision is left exactly as Slack stored it');
  assert.match(web.updates.at(-1)?.text ?? '', /Allowed for the rest of this session by <@U-DYLAN>/);
});

// ---- addressable outbound (step 10) -----------------------------------------

const startedAdapterWith = async (web: FakeWeb): Promise<import('@stratusagent/channels').ChannelAdapter> => {
  const socket = createFakeSocket();
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'unused'));
  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
    log: () => {},
    warn: () => {},
  });
  await adapter.start(gateway);
  return adapter;
};

test('resolveOutbound posts to a channel the app is a member of, splitting oversized text', async () => {
  const web = createFakeWeb('B-AVA', 'T1');
  web.knownConversations.set('C-ENG', { is_member: true });
  const adapter = await startedAdapterWith(web);

  const connection = await adapter.resolveOutbound!({ agentId: 'ava', to: 'C-ENG' });
  const ref = await connection.post('morning report: all green');
  assert.equal(web.posts.length, 1);
  assert.equal(web.posts[0]?.channel, 'C-ENG');
  assert.equal(web.posts[0]?.text, 'morning report: all green');
  assert.equal(ref.channel, 'C-ENG');
  assert.ok(ref.ts.length > 0);

  // A report longer than one Slack message arrives whole, in order.
  const long = ['a'.repeat(3000), 'b'.repeat(3000)].join('\n');
  await connection.post(long);
  assert.equal(web.posts.length, 3);
  assert.ok((web.posts[1]?.text.length ?? 0) <= 4000);
  assert.match(web.posts[2]?.text ?? '', /b/);

  await adapter.stop();
});

test('resolveOutbound refuses a channel the app is not a member of, naming the fix', async () => {
  const web = createFakeWeb('B-AVA', 'T1');
  web.knownConversations.set('C-PRIVATE', { is_member: false });
  const adapter = await startedAdapterWith(web);

  await assert.rejects(
    () => adapter.resolveOutbound!({ agentId: 'ava', to: 'C-PRIVATE' }),
    /not a member of C-PRIVATE — invite it/,
  );
  assert.equal(web.posts.length, 0, 'nothing is posted on a refusal');
  await adapter.stop();
});

test('resolveOutbound refuses a conversation the app cannot see', async () => {
  const web = createFakeWeb('B-AVA', 'T1');
  const adapter = await startedAdapterWith(web);

  await assert.rejects(
    () => adapter.resolveOutbound!({ agentId: 'ava', to: 'C-NOWHERE' }),
    /cannot see C-NOWHERE/,
  );
  await adapter.stop();
});

test('resolveOutbound treats a DM conversation as addressable without membership', async () => {
  const web = createFakeWeb('B-AVA', 'T1');
  web.knownConversations.set('D-DYLAN', { is_im: true });
  const adapter = await startedAdapterWith(web);

  const connection = await adapter.resolveOutbound!({ agentId: 'ava', to: 'D-DYLAN' });
  await connection.post('scheduled reminder');
  assert.equal(web.posts[0]?.channel, 'D-DYLAN');
  await adapter.stop();
});

test('resolveOutbound refuses an agent with no Slack app of its own', async () => {
  const web = createFakeWeb('B-AVA', 'T1');
  web.knownConversations.set('C-ENG', { is_member: true });
  const adapter = await startedAdapterWith(web);

  await assert.rejects(
    () => adapter.resolveOutbound!({ agentId: 'bea', to: 'C-ENG' }),
    /bea has no Slack app/,
  );
  await adapter.stop();
});
