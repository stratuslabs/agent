import test from 'node:test';
import assert from 'node:assert/strict';

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
        return { ts: `bot-ts-${counter}`, channel: args.channel };
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
  resolutions: Array<{ requestId: string; answer: ApprovalAnswer; actor?: string }>;
  /** Request ids the gateway still considers pending. */
  pendingApprovals: Set<string>;
}

const createStubGateway = (
  reply: (input: { sessionId: string; userMessage: string }) => Promise<Session> | Session,
): StubGateway => {
  const bus = new EventBus();
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
        reason: 'decided',
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
  await new Promise((resolve) => setTimeout(resolve, 80));
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

const click = (actionId: string, requestId: string, user: string) => ({
  body: {
    team_id: 'T1',
    user: { id: user },
    channel: { id: 'C1' },
    message: { ts: 'bot-ts-1', thread_ts: '100.1' },
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
  assert.deepEqual(gateway.resolutions, [{ requestId: 'req-1', answer: 'deny' }]);
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
