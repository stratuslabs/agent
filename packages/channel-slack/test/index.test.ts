import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { EventBus, type ApprovalAnswer, type ImageAttachment, type JsonObject, type Session, type StratusEvent } from '@stratusagent/core';
import type { GatewayLike } from '@stratusagent/channels';
import {
  createSlackChannelAdapter,
  createSlackFileFetcher,
  type SlackBlock,
  type SlackSocketEventArgs,
  type SlackSocketLike,
  type SlackWebLike,
} from '../src/index.ts';

interface FakeSocket extends SlackSocketLike {
  /**
   * `ack` overrides the acknowledgement this delivery hands the adapter —
   * the real client resolves one from a WebSocket send callback, so two can
   * come back in either order.
   */
  deliver(eventName: string, args: Omit<SlackSocketEventArgs, 'ack'>, ack?: () => Promise<void>): Promise<void>;
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
    async deliver(eventName, args, ack) {
      const handlers = listeners.get(eventName) ?? [];
      for (const handler of handlers) {
        handler({ ...args, ack: ack ?? (async () => { socket.acks += 1; }) });
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
        const known: Record<string, string> = { 'U-DYLAN': 'Dylan', 'B-AVA': 'Ava', 'B-BEA': 'Bea' };
        return { user: { profile: { display_name: known[user] ?? `name-${user}` } } };
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
  dispatches: Array<{ sessionId: string; agentId?: string; userMessage: string; images?: ImageAttachment[]; addressed?: boolean }>;
  /** What each agent heard without answering, in the order the gateway was asked. */
  observes: Array<{ sessionId: string; agentId?: string; message: string; metadata?: JsonObject }>;
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
    observes: [],
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
        ...(input.images !== undefined ? { images: input.images } : {}),
        ...(input.addressed !== undefined ? { addressed: input.addressed } : {}),
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
    async observe(input) {
      // As the gateway does, on the session's chain: a session exists if a
      // dispatch was placed for it ahead of this — the invitation still in
      // flight — or the durable record knows it. "Not in that one" is an
      // answer, not a refusal.
      const invited = gateway.dispatches.some((dispatch) => dispatch.sessionId === input.sessionId)
        || (await gateway.sessionRouting?.(input.sessionId)) !== undefined;
      if (!invited) {
        return undefined;
      }
      gateway.observes.push({
        sessionId: input.sessionId,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        message: input.message,
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      });
      await bus.emit({ type: 'session.observed', sessionId: input.sessionId, agentId: input.agentId ?? 'ava' });
      return sessionWithReply(input.sessionId, '');
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

test('a reply written in Markdown reaches Slack in the markup Slack renders', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  // What a model actually writes. Slack's mrkdwn spells every one of these
  // differently, and sent as-is they reach the reader as literal asterisks,
  // hashes and brackets — which is what the thread in #agents looked like.
  const reply = [
    '## Four things',
    '',
    '1. **Name mismatch.** The persona says *memory.remember*.',
    '2. ~~Dropped~~ — see [the guide](https://example.com/docs).',
    '3. ***Both at once***, and `**code**` is left alone.',
    '',
    '```js',
    'const bold = "**not bold**"; // # not a heading',
    '```',
  ].join('\n');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, reply));

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);
  await socket.deliver('app_mention', mention('<@B-AVA> format something'));
  await adapter.stop();

  assert.equal(web.updates.at(-1)?.text, [
    '*Four things*',
    '',
    '1. *Name mismatch.* The persona says _memory.remember_.',
    '2. ~Dropped~ — see <https://example.com/docs|the guide>.',
    '3. *_Both at once_*, and `**code**` is left alone.',
    '',
    '```js',
    'const bold = "**not bold**"; // # not a heading',
    '```',
  ].join('\n'));
});

test('a heading is found on the reply\'s own lines, not inside each fragment inline code leaves behind', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  // Inline code cuts a line into fragments, and a fragment is not a line.
  // Matched per fragment, `^` lies in both directions at once.
  const reply = [
    '`status` # not a heading',
    '## Run `npm test` now',
    '## **Run** `npm test` now',
    '## Match `*.ts` files',
    '# Inspect `first',
    'second`',
    '# Inspect ```third',
    'fourth```',
    '## Run `npm test`',
    '# show `value #',
    'next`',
    '# show `other ',
    'lines`',
    '```sh',
    '# a real comment',
    '```',
  ].join('\n');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, reply));

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);
  await socket.deliver('app_mention', mention('<@B-AVA> mind the line'));
  await adapter.stop();

  assert.equal(web.updates.at(-1)?.text, [
    // The tail of this line is not a line, so its hash is text.
    '`status` # not a heading',
    // And this whole line is one heading, code and all.
    '*Run `npm test` now*',
    // But a heading that already carries emphasis keeps the emphasis it
    // has: Slack has one bold delimiter and no way to nest it, so wrapping
    // this again would print `**Run* …*` instead of rendering anything.
    '*Run* `npm test` now',
    // An asterisk inside a span is not emphasis Slack could pair with, so
    // this heading is bolded like any other.
    '*Match `*.ts` files*',
    // Not wrapped, because of the backtick this side found no partner for.
    // Slack parses the message itself and may pair it with the one below,
    // and the closing `*` would then sit inside what Slack reads as code,
    // where it is ignored — leaving the opening one with nothing to close.
    'Inspect `first',
    'second`',
    // Nor over a fence opened on the line, which runs past its end — the
    // closing `*` would be written inside the code, where Slack ignores it.
    'Inspect ```third',
    'fourth```',
    // But a span that closes on the line is no obstacle: the marker goes
    // just past it, in prose, so this heading is bolded.
    '*Run `npm test`*',
    // And nothing on this line is stripped at all. Closing hashes are the
    // heading's own syntax only while they are the heading's: this line
    // ends inside a span, where the same hash is somebody's snippet.
    '# show `value #',
    'next`',
    // The same for a no-break space, which the pattern's `[ \t]` does not
    // know about but `trim` takes anyway — the gap between those two sets
    // is exactly where a character goes missing.
    '# show `other ',
    'lines`',
    // While a hash whose line begins inside a fence is somebody's comment.
    '```sh',
    '# a real comment',
    '```',
  ].join('\n'));
});

test('emphasis is converted around the inline code inside it, not cut in half by it', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  // A fragment is not a run. Inline code cuts a bold run in two, and each
  // half was rewritten on its own, so neither marker ever met its partner:
  // every one of these reached Slack as the literal Markdown it was
  // written in — the same defect headings had, one rule over.
  const reply = [
    '**the `fs.read` tool** is the one to use',
    '*`memory.remember` writes it down*',
    '~~`shell.run` was the old name~~',
    'see [the `--api-port` flag](https://example.com/docs)',
    '**two `spans` in one `bold` run**',
    '## A heading with `code` in it',
    // The link rule writes its captures back in the other order, so a
    // snippet held out of the rewrite has to come back to the half of the
    // link it was written in — by name, not by the place it stood in.
    '[read `docs/cli.md`](https://example.com/a`b`c)',
    // And a snippet held out of the rewrite may not hide the whitespace
    // inside it: a destination that holds a space is not a destination, and
    // a label may not cross a line. Both were converted and rearranged into
    // a link Slack cannot render while a mask had no shape of its own.
    '[label](https://example.com/`a b`)',
    '[two `words` in `one label`](https://example.com/ok)',
    // A space inside a snippet is not, on its own, the end of a bold run.
    '**bold `a b` more**',
    // And the reason the halves may not simply be joined: what is inside a
    // span is the snippet, whatever it is spelled like.
    'the snippet keeps its own `**asterisks**`',
  ].join('\n');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, reply));

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);
  await socket.deliver('app_mention', mention('<@B-AVA> name some tools'));
  await adapter.stop();

  assert.equal(web.updates.at(-1)?.text, [
    '*the `fs.read` tool* is the one to use',
    '_`memory.remember` writes it down_',
    '~`shell.run` was the old name~',
    'see <https://example.com/docs|the `--api-port` flag>',
    '*two `spans` in one `bold` run*',
    '*A heading with `code` in it*',
    '<https://example.com/a`b`c|read `docs/cli.md`>',
    '[label](https://example.com/`a b`)',
    '<https://example.com/ok|two `words` in `one label`>',
    '*bold `a b` more*',
    'the snippet keeps its own `**asterisks**`',
  ].join('\n'));
});

test('a reply keeps every character it was written with, whatever the markers around it', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  // Each line is a place a rewrite could quietly change what the agent
  // said. A reply that reads oddly is survivable; one that says something
  // else is not.
  const reply = [
    '# C#',
    '# glob *.ts',
    'a ``span with a ` inside`` stays whole',
    'a span may close a line later: `first',
    '**second**` — and its contents are still its own',
    'one ` with no partner anywhere is a character, then **bold**',
    '````',
    '```',
    '**inner fence**',
    '```',
    '````',
  ].join('\n');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, reply));

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);
  await socket.deliver('app_mention', mention('<@B-AVA> mind the edges'));
  await adapter.stop();

  assert.equal(web.updates.at(-1)?.text, [
    // A closing hash run is only closing syntax when it is spaced off the
    // text; `C#` is the name of a language.
    '*C#*',
    // Not bolded, because Slack cannot nest its one bold delimiter and the
    // asterisk here is the text. Unbolded reads fine; `*glob *.ts*` would
    // render as stray asterisks, and deleting one to make room would say
    // something the agent did not.
    'glob *.ts',
    // A longer delimiter is what carries a shorter one, for a span and a
    // fence alike — the run that closes it has to be exactly as long.
    'a ``span with a ` inside`` stays whole',
    // Slack pairs these across the newline, so what is between them is what
    // it renders as code. Converting the `**second**` would rewrite the
    // contents of somebody's snippet — a worse outcome than the prose in
    // there going unconverted, which is only cosmetic.
    'a span may close a line later: `first',
    '**second**` — and its contents are still its own',
    // With no partner anywhere, though, it is just a character.
    'one ` with no partner anywhere is a character, then *bold*',
    '````',
    '```',
    '**inner fence**',
    '```',
    '````',
  ].join('\n'));
});

test('a streamed placeholder is converted too, and a half-written marker stays literal', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const bus = new EventBus();

  const gateway: GatewayLike = {
    bus,
    resolveApproval: () => false,
    agents: () => [{ id: 'ava', name: 'Ava' }],
    async dispatch(input) {
      // Mid-stream, the closing marker has not arrived yet. Nothing may be
      // rewritten on the guess that it will: an edit is what the reader is
      // looking at, not a draft nobody sees.
      await bus.emit({ type: 'provider.delta', sessionId: input.sessionId, delta: { type: 'text', text: '**Almost' } });
      await new Promise((resolve) => setTimeout(resolve, 30));
      await bus.emit({ type: 'provider.delta', sessionId: input.sessionId, delta: { type: 'text', text: ' there**' } });
      await new Promise((resolve) => setTimeout(resolve, 30));
      return sessionWithReply(input.sessionId, '**Done**');
    },
  };

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);
  await socket.deliver('app_mention', mention('<@B-AVA> stream markdown'));
  await adapter.stop();

  const texts = web.updates.map((update) => update.text);
  assert.ok(texts.includes('**Almost'), `expected the unclosed marker to stand, got ${JSON.stringify(texts)}`);
  assert.ok(texts.includes('*Almost there*'), `expected the closed pair to convert, got ${JSON.stringify(texts)}`);
  assert.equal(texts.at(-1), '*Done*');
});

test('a heading is not bolded over a fence the stream has only opened', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const bus = new EventBus();

  const gateway: GatewayLike = {
    bus,
    resolveApproval: () => false,
    agents: () => [{ id: 'ava', name: 'Ava' }],
    async dispatch(input) {
      // The edit a reader is looking at while a block is still arriving. The
      // fence has no end yet, so everything after it is code as far as Slack
      // is concerned — a closing `*` written there is ignored, and the one
      // before the fence would be left with nothing to close it.
      await bus.emit({ type: 'provider.delta', sessionId: input.sessionId, delta: { type: 'text', text: '# Inspect ```first' } });
      await new Promise((resolve) => setTimeout(resolve, 30));
      await bus.emit({ type: 'provider.delta', sessionId: input.sessionId, delta: { type: 'text', text: '\nsecond```\n## After' } });
      await new Promise((resolve) => setTimeout(resolve, 30));
      return sessionWithReply(input.sessionId, '# Inspect ```first\nsecond```\n## After');
    },
  };

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);
  await socket.deliver('app_mention', mention('<@B-AVA> stream a fence'));
  await adapter.stop();

  const texts = web.updates.map((update) => update.text);
  assert.ok(
    texts.includes('Inspect ```first'),
    `expected the half-arrived fence to leave its heading alone, got ${JSON.stringify(texts)}`,
  );
  assert.ok(
    !texts.some((text) => text.includes('*Inspect')),
    `no edit may bold a heading over an unclosed fence, got ${JSON.stringify(texts)}`,
  );
  // Closed, the fence is still no place for the marker — but the heading
  // below it, which owns its whole line, is bolded.
  assert.equal(texts.at(-1), 'Inspect ```first\nsecond```\n*After*');
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

/**
 * A plain channel message, the shape `message.channels` delivers — the
 * event an app only receives once it has been granted the channel history
 * scopes, and the one an untagged thread reply arrives as.
 */
const channelMessage = (input: { text: string; ts: string; thread?: string; user?: string }) => ({
  body: { team_id: 'T1', event_id: `evt-msg-${input.ts}` },
  event: {
    type: 'message',
    channel_type: 'channel',
    user: input.user ?? 'U-DYLAN',
    text: input.text,
    ts: input.ts,
    channel: 'C1',
    ...(input.thread ? { thread_ts: input.thread } : {}),
  },
});

/** `sessionRouting` over a map of session id → when that agent last spoke there. */
const routingOver = (spoke: Map<string, string>) => async (sessionId: string) => {
  const lastSpokeAt = spoke.get(sessionId);
  return lastSpokeAt === undefined
    ? undefined
    : { agentId: sessionId.split(':')[1] ?? '', metadata: {}, lastSpokeAt };
};

test('an untagged reply in a thread reaches the agent already in it, and nothing else does', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'still here'));
  gateway.sessionRouting = routingOver(new Map([['slack:ava:T1:C1:500.0', '2026-01-01T00:00:00.000Z']]));

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);

  // The thread is the address: no mention in it anywhere.
  await socket.deliver('message', channelMessage({ text: 'and the second one?', ts: '500.9', thread: '500.0' }));
  // The room is not a conversation. A channel message outside any thread
  // is not a follow-up to anything, however much the app can now see.
  await socket.deliver('message', channelMessage({ text: 'morning all', ts: '600.1' }));
  // Nor is a thread this agent was never invited into.
  await socket.deliver('message', channelMessage({ text: 'ping?', ts: '700.1', thread: '700.0' }));
  await adapter.stop();

  assert.deepEqual(gateway.dispatches, [
    { sessionId: 'slack:ava:T1:C1:500.0', agentId: 'ava', userMessage: 'Dylan: and the second one?' },
  ]);
  assert.equal(web.posts[0]?.thread_ts, '500.0');
});

test('a follow-up Slack marks with a subtype is still a follow-up, unless it is bookkeeping', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'looking'));
  gateway.sessionRouting = routingOver(new Map([['slack:ava:T1:C1:520.0', '2026-01-01T00:00:00.000Z']]));

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);

  // Asking with the log attached is how the question gets asked.
  const shared = channelMessage({ text: "here's the log", ts: '520.1', thread: '520.0' });
  await socket.deliver('message', { ...shared, event: { ...shared.event, subtype: 'file_share' } });
  // `/me` is a person typing, marked only by how Slack renders it.
  const emote = channelMessage({ text: 'is still reading it', ts: '520.2', thread: '520.0' });
  await socket.deliver('message', { ...emote, event: { ...emote.event, subtype: 'me_message' } });
  // Slack narrating the channel is not somebody speaking in it.
  const edited = channelMessage({ text: 'never mind', ts: '520.3', thread: '520.0' });
  await socket.deliver('message', { ...edited, event: { ...edited.event, subtype: 'message_changed' } });
  await adapter.stop();

  assert.deepEqual(gateway.dispatches.map((dispatch) => dispatch.userMessage), [
    "Dylan: here's the log",
    'Dylan: is still reading it',
  ]);
});

test('a mention delivered as both an app_mention and a channel message runs one turn', async () => {
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

  // Slack tells a subscriber of both about one message twice, under two
  // event ids — the message itself is what may only be answered once.
  await socket.deliver('app_mention', {
    body: { team_id: 'T1', event_id: 'evt-mention' },
    event: { type: 'app_mention', user: 'U-DYLAN', text: '<@B-AVA> do it', ts: '800.1', channel: 'C1' },
  });
  await socket.deliver('message', channelMessage({ text: '<@B-AVA> do it', ts: '800.1' }));
  await adapter.stop();

  assert.deepEqual(gateway.dispatches.map((dispatch) => dispatch.sessionId), ['slack:ava:T1:C1:800.1']);
});

test('in a shared thread an untagged reply goes to whoever spoke last, and a mention hands the thread over', async () => {
  const socketAva = createFakeSocket();
  const socketBea = createFakeSocket();
  const webAva = createFakeWeb('B-AVA', 'T1');
  const webBea = createFakeWeb('B-BEA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'ok'));
  const spoke = new Map([
    ['slack:ava:T1:C1:900.0', '2026-01-01T00:00:01.000Z'],
    ['slack:bea:T1:C1:900.0', '2026-01-01T00:00:00.000Z'],
  ]);
  gateway.sessionRouting = routingOver(spoke);

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

  // Both apps are in the channel, so both are told about every message.
  const followUp = channelMessage({ text: 'say more', ts: '900.1', thread: '900.0' });
  await socketAva.deliver('message', followUp);
  await socketBea.deliver('message', followUp);

  // Naming Bea hands her the question — and Ava, who had it, is not also
  // being asked.
  const handover = channelMessage({ text: '<@B-BEA> what do you think?', ts: '900.2', thread: '900.0' });
  await socketAva.deliver('message', handover);
  await socketBea.deliver('app_mention', {
    body: { team_id: 'T1', event_id: 'evt-handover' },
    event: { type: 'app_mention', user: 'U-DYLAN', text: '<@B-BEA> what do you think?', ts: '900.2', thread_ts: '900.0', channel: 'C1' },
  });

  // …so the next untagged reply is hers — and note `spoke` is untouched,
  // so the sessions still say Ava spoke last. A handover is in force from
  // the moment Slack delivers it, not from whenever the turn it starts
  // gets as far as writing a session.
  const afterHandover = channelMessage({ text: 'go on', ts: '900.3', thread: '900.0' });
  await socketAva.deliver('message', afterHandover);
  await socketBea.deliver('message', afterHandover);
  await adapter.stop();

  assert.deepEqual(gateway.dispatches.map((dispatch) => [dispatch.agentId, dispatch.userMessage]), [
    ['ava', 'Dylan: say more'],
    ['bea', 'Dylan: what do you think?'],
    ['bea', 'Dylan: go on'],
  ]);
});

test('an agent in a shared thread hears what is said to the other one, and posts nothing for it', async () => {
  const socketAva = createFakeSocket();
  const socketBea = createFakeSocket();
  const webAva = createFakeWeb('B-AVA', 'T1');
  const webBea = createFakeWeb('B-BEA', 'T1');
  // Both apps are in the channel, which a reply asks Slack before it is heard.
  webAva.knownConversations.set('C1', { is_member: true });
  webBea.knownConversations.set('C1', { is_member: true });
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'ok'));
  // Both in the thread; Ava spoke last.
  gateway.sessionRouting = routingOver(new Map([
    ['slack:ava:T1:C1:900.0', '2026-01-01T00:00:01.000Z'],
    ['slack:bea:T1:C1:900.0', '2026-01-01T00:00:00.000Z'],
  ]));

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

  // Each message reaches both apps' sockets at once, as it does from
  // Slack — neither app is a whole turn behind the other.
  //
  // Cold: the sessions say Ava spoke last, so the untagged reply is hers —
  // and Bea, in the thread but not asked, hears it, and then hears what
  // Ava answered.
  const followUp = channelMessage({ text: 'say more', ts: '900.1', thread: '900.0' });
  await Promise.all([socketAva.deliver('message', followUp), socketBea.deliver('message', followUp)]);

  // Naming Bea hands her the question. Ava had it, and now hears it asked
  // of her colleague instead — once, though Slack tells her app about a
  // mention of another app through `message.channels` only, and tells
  // Bea's about it twice.
  const handover = channelMessage({ text: '<@B-BEA> what do you think?', ts: '900.2', thread: '900.0' });
  await Promise.all([
    socketAva.deliver('message', handover),
    // A redelivery — the same message, again — is heard once, exactly as
    // it would be answered once.
    socketAva.deliver('message', handover),
    socketBea.deliver('message', handover),
    socketBea.deliver('app_mention', {
      body: { team_id: 'T1', event_id: 'evt-handover' },
      event: { type: 'app_mention', user: 'U-DYLAN', text: '<@B-BEA> what do you think?', ts: '900.2', thread_ts: '900.0', channel: 'C1' },
    }),
  ]);

  // Warm: the handover is in force, so the next untagged reply is Bea's to
  // answer and Ava's to hear.
  const afterHandover = channelMessage({ text: 'go on', ts: '900.3', thread: '900.0' });
  await Promise.all([socketAva.deliver('message', afterHandover), socketBea.deliver('message', afterHandover)]);
  await adapter.stop();

  assert.deepEqual(gateway.dispatches.map((dispatch) => [dispatch.agentId, dispatch.userMessage]), [
    ['ava', 'Dylan: say more'],
    ['bea', 'Dylan: what do you think?'],
    ['bea', 'Dylan: go on'],
  ]);
  // Every message somebody else answered reached the agent that did not,
  // into its own session for the thread, with the speaker named the way a
  // turn's message names them — and so did the answer, named the same
  // way, after the question it answered. Both halves of the exchange, or
  // the agent that followed along knows what its colleague was asked and
  // not what it said.
  assert.deepEqual(
    gateway.observes.map((observed) => [observed.agentId, observed.sessionId, observed.message]),
    [
      ['bea', 'slack:bea:T1:C1:900.0', 'Dylan: say more'],
      ['bea', 'slack:bea:T1:C1:900.0', 'Ava: ok'],
      ['ava', 'slack:ava:T1:C1:900.0', 'Dylan: <@B-BEA> what do you think?'],
      ['ava', 'slack:ava:T1:C1:900.0', 'Bea: ok'],
      ['ava', 'slack:ava:T1:C1:900.0', 'Dylan: go on'],
      ['ava', 'slack:ava:T1:C1:900.0', 'Bea: ok'],
    ],
  );
  // Hearing is silent: a placeholder is a promise of a reply, and there
  // is none coming. Every post either app made was for a turn it answered.
  assert.equal(webAva.posts.length, 1);
  assert.equal(webBea.posts.length, 2);
});

test('a message said moments after an agent was invited is heard, not dropped', async () => {
  const socketAva = createFakeSocket();
  const socketBea = createFakeSocket();
  const webAva = createFakeWeb('B-AVA', 'T1');
  const webBea = createFakeWeb('B-BEA', 'T1');
  // Both apps are in the channel, which a reply asks Slack before it is heard.
  webAva.knownConversations.set('C1', { is_member: true });
  webBea.knownConversations.set('C1', { is_member: true });
  // Every dispatch waits on a gate, so the invitation's session is still
  // being created when the next message arrives — the durable record
  // knows nothing of this thread yet.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gateway = createStubGateway(async ({ sessionId }) => {
    await gate;
    return sessionWithReply(sessionId, 'ok');
  });
  gateway.sessionRouting = routingOver(new Map());

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

  // Ava is mentioned; her first turn is queued and has not written a
  // session. Before it can, the same person turns to Bea in that thread.
  const invitation = socketAva.deliver('app_mention', mention('<@B-AVA> hello', { ts: '300.0' }));
  const toBea = channelMessage({ text: '<@B-BEA> and you?', ts: '300.1', thread: '300.0' });
  const heardByAva = socketAva.deliver('message', toBea);
  const answeredByBea = socketBea.deliver('message', toBea);
  release();
  await Promise.all([invitation, heardByAva, answeredByBea]);
  await adapter.stop();

  // A membership check from the adapter would have found no session and
  // dropped this. The gateway, asked on the session's chain behind the
  // invitation, finds the session that dispatch created.
  // And Bea, who was named, answers it — hearing and answering are the
  // two sides of one message. Each then hears what the other replied: the
  // sessions both turns created are there by the time the gateway is
  // asked, on their chains.
  assert.deepEqual(
    gateway.observes.map((observed) => [observed.agentId, observed.message]),
    [
      ['ava', 'Dylan: <@B-BEA> and you?'],
      ['bea', 'Ava: ok'],
      ['ava', 'Bea: ok'],
    ],
  );
  assert.deepEqual(gateway.dispatches.map((dispatch) => dispatch.agentId), ['ava', 'bea']);
});

test('an agent hears only threads it is in, and only where the host can take it', async () => {
  const socketAva = createFakeSocket();
  const socketBea = createFakeSocket();
  const webAva = createFakeWeb('B-AVA', 'T1');
  const webBea = createFakeWeb('B-BEA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'ok'));
  // Only Bea has a session under this thread: Ava was never invited.
  gateway.sessionRouting = routingOver(new Map([['slack:bea:T1:C1:700.0', '2026-01-01T00:00:00.000Z']]));

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

  // A thread Ava's app is told about, like every thread in the channel,
  // and has no part in: nothing to hear into.
  const toBea = channelMessage({ text: '<@B-BEA> thoughts?', ts: '700.1', thread: '700.0' });
  await socketAva.deliver('message', toBea);
  await socketBea.deliver('message', toBea);

  // A host without `observe` leaves the agent hearing what it answers, as
  // every agent did before — no error, and the answering is untouched.
  delete gateway.observe;
  const again = channelMessage({ text: '<@B-BEA> and?', ts: '700.2', thread: '700.0' });
  await socketAva.deliver('message', again);
  await socketBea.deliver('message', again);
  await adapter.stop();

  assert.deepEqual(gateway.dispatches.map((dispatch) => [dispatch.agentId, dispatch.userMessage]), [
    ['bea', 'Dylan: thoughts?'],
    ['bea', 'Dylan: and?'],
  ]);
  assert.deepEqual(gateway.observes, []);
  assert.equal(webAva.posts.length, 0);
});

test('what an agent replied is heard by the thread\'s other agents, under its own label, and nothing else it posts is', async () => {
  const socketAva = createFakeSocket();
  const socketBea = createFakeSocket();
  const webAva = createFakeWeb('B-AVA', 'T1');
  const webBea = createFakeWeb('B-BEA', 'T1');
  // Both apps are in the channel, which a reply asks Slack before it is heard.
  webAva.knownConversations.set('C1', { is_member: true });
  webBea.knownConversations.set('C1', { is_member: true });
  const labelled = (id: string, reply: string, sessionTrust: string): Session => ({
    ...sessionWithReply(id, reply),
    metadata: { sessionTrust },
  });
  const gateway = createStubGateway(({ sessionId, userMessage }) => {
    if (userMessage.includes('nothing')) {
      return sessionWithReply(sessionId, '');
    }
    if (userMessage.includes('break')) {
      throw new Error('provider exploded');
    }
    // Ava's session is clean; Bea's has seen a stranger's text.
    return sessionId.startsWith('slack:ava:')
      ? labelled(sessionId, 'on it', 'user')
      : labelled(sessionId, 'on it', 'unknown');
  });
  // Both in the thread; Ava spoke last.
  gateway.sessionRouting = routingOver(new Map([
    ['slack:ava:T1:C1:920.0', '2026-01-01T00:00:01.000Z'],
    ['slack:bea:T1:C1:920.0', '2026-01-01T00:00:00.000Z'],
  ]));

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

  const both = (message: ReturnType<typeof channelMessage>) =>
    Promise.all([socketAva.deliver('message', message), socketBea.deliver('message', message)]);
  // Ava answers; Bea hears the question and the answer.
  await both(channelMessage({ text: 'say more', ts: '920.1', thread: '920.0' }));
  // Bea is named and answers; Ava hears both halves.
  await both(channelMessage({ text: '<@B-BEA> your view?', ts: '920.2', thread: '920.0' }));
  // A turn of Bea's that says nothing posts `(no reply)`, which is not a
  // reply and is not heard.
  await both(channelMessage({ text: 'say nothing', ts: '920.3', thread: '920.0' }));
  // A failed turn posts an error note, which is the failure's and not
  // Bea's.
  await both(channelMessage({ text: 'break', ts: '920.4', thread: '920.0' }));
  // A DM has nobody else in it.
  await socketAva.deliver('app_mention', mention('<@B-AVA> privately', { ts: '920.5', channel: 'D1', channel_type: 'im' }));
  await adapter.stop();

  assert.deepEqual(
    gateway.observes.map((observed) => [
      observed.agentId,
      observed.message,
      observed.metadata?.senderTrust,
      observed.metadata?.slackUser,
    ]),
    [
      ['bea', 'Dylan: say more', 'unknown', 'U-DYLAN'],
      // An agent's word is at most `agent`, not `user`: it is not a person.
      ['bea', 'Ava: on it', 'agent', 'B-AVA'],
      ['ava', 'Dylan: <@B-BEA> your view?', 'unknown', 'U-DYLAN'],
      // And carries what its session has been exposed to: a restatement of
      // a stranger's text is still the stranger's.
      ['ava', 'Bea: on it', 'unknown', 'B-BEA'],
      ['ava', 'Dylan: say nothing', 'unknown', 'U-DYLAN'],
      ['ava', 'Dylan: break', 'unknown', 'U-DYLAN'],
    ],
  );
  // Hearing a reply is not a message: every post either app made was for
  // a turn it answered.
  assert.equal(webAva.posts.length, 2);
  assert.equal(webBea.posts.length, 3);
});

test('a message typed while a reply is still streaming is heard before the reply, and one typed after it, after', async () => {
  const socketAva = createFakeSocket();
  const socketBea = createFakeSocket();
  const webAva = createFakeWeb('B-AVA', 'T1');
  const webBea = createFakeWeb('B-BEA', 'T1');
  // Both apps are in the channel, which a reply asks Slack before it is heard.
  webAva.knownConversations.set('C1', { is_member: true });
  webBea.knownConversations.set('C1', { is_member: true });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gateway = createStubGateway(async ({ sessionId, userMessage }) => {
    await gate;
    return sessionWithReply(sessionId, `re ${userMessage}`);
  });
  gateway.sessionRouting = routingOver(new Map([
    ['slack:ava:T1:C1:930.0', '2026-01-01T00:00:01.000Z'],
    ['slack:bea:T1:C1:930.0', '2026-01-01T00:00:00.000Z'],
  ]));

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

  const both = (message: ReturnType<typeof channelMessage>) =>
    Promise.all([socketAva.deliver('message', message), socketBea.deliver('message', message)]);
  // Ava's turn is running when the second message is typed: Bea's place
  // for that message is claimed while the reply is still nothing.
  const first = both(channelMessage({ text: 'say more', ts: '930.1', thread: '930.0' }));
  const during = both(channelMessage({ text: 'and also', ts: '930.2', thread: '930.0' }));
  release();
  await Promise.all([first, during]);
  // Typed after the replies were final.
  await both(channelMessage({ text: 'thanks', ts: '930.3', thread: '930.0' }));
  await adapter.stop();

  assert.deepEqual(
    gateway.observes.map((observed) => observed.message),
    [
      'Dylan: say more',
      'Dylan: and also',
      'Ava: re Dylan: say more',
      'Ava: re Dylan: and also',
      'Dylan: thanks',
      'Ava: re Dylan: thanks',
    ],
  );
});

test('the reply of a turn finished after a restart is heard by the thread\'s other agents too', async () => {
  const socketAva = createFakeSocket();
  const socketBea = createFakeSocket();
  const webAva = createFakeWeb('B-AVA', 'T1');
  const webBea = createFakeWeb('B-BEA', 'T1');
  // Both apps are in the channel, which a reply asks Slack before it is heard.
  webAva.knownConversations.set('C1', { is_member: true });
  webBea.knownConversations.set('C1', { is_member: true });
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'unused'));
  // Ava's turn was parked on a human when the daemon died and finished
  // after the restart, with no renderer in this process. Bea is in the
  // thread.
  gateway.sessionRouting = async (sessionId) => {
    if (sessionId === 'slack:ava:T1:C1:100.1') {
      return {
        agentId: 'ava',
        metadata: { channel: 'slack', team: 'T1', slackChannel: 'C1', slackThread: '100.1', sessionTrust: 'user' },
        reply: 'the recovered reply',
      };
    }
    if (sessionId === 'slack:bea:T1:C1:100.1') {
      return { agentId: 'bea', metadata: {} };
    }
    return undefined;
  };
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
  await gateway.bus.emit({ type: 'session.completed', sessionId: 'slack:ava:T1:C1:100.1' });
  await adapter.stop();

  assert.deepEqual(webAva.posts.map((post) => [post.text, post.thread_ts]), [['the recovered reply', '100.1']]);
  assert.deepEqual(
    gateway.observes.map((observed) => [observed.agentId, observed.sessionId, observed.message, observed.metadata?.senderTrust]),
    [['bea', 'slack:bea:T1:C1:100.1', 'Ava: the recovered reply', 'agent']],
  );
  assert.equal(webBea.posts.length, 0);
});

test('an agent taken out of the channel stops hearing its colleague there, and so does one Slack cannot vouch for', async () => {
  const socketAva = createFakeSocket();
  const socketBea = createFakeSocket();
  const webAva = createFakeWeb('B-AVA', 'T1');
  const webBea = createFakeWeb('B-BEA', 'T1');
  const warnings: string[] = [];
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'ok'));
  // Both in the thread — Bea's session is from before her app was removed
  // from this private channel. Slack no longer delivers the channel to
  // her socket; a reply forwarded by this process would still reach her.
  gateway.sessionRouting = routingOver(new Map([
    ['slack:ava:T1:C1:940.0', '2026-01-01T00:00:01.000Z'],
    ['slack:bea:T1:C1:940.0', '2026-01-01T00:00:00.000Z'],
    ['slack:ava:T1:C2:940.0', '2026-01-01T00:00:01.000Z'],
    ['slack:bea:T1:C2:940.0', '2026-01-01T00:00:00.000Z'],
  ]));
  webAva.knownConversations.set('C1', { is_member: true });
  webBea.knownConversations.set('C1', { is_member: false });
  // C2: Ava is in it; Bea's app cannot even see it (`channel_not_found`).
  webAva.knownConversations.set('C2', { is_member: true });

  const adapter = createSlackChannelAdapter({
    agents: [
      { agentId: 'ava', appToken: 'xapp-a', botToken: 'xoxb-a' },
      { agentId: 'bea', appToken: 'xapp-b', botToken: 'xoxb-b' },
    ],
    editIntervalMs: 0,
    createSocketClient: (appToken) => (appToken === 'xapp-a' ? socketAva : socketBea),
    createWebClient: (botToken) => (botToken === 'xoxb-a' ? webAva : webBea),
    warn: (line) => {
      warnings.push(line);
    },
  });
  await adapter.start(gateway);

  // Only Ava's socket gets these: Bea's app is out of the room.
  await socketAva.deliver('message', channelMessage({ text: 'say more', ts: '940.1', thread: '940.0' }));
  await socketAva.deliver('message', { ...channelMessage({ text: 'over here', ts: '940.2', thread: '940.0' }), event: { ...channelMessage({ text: 'over here', ts: '940.2', thread: '940.0' }).event, channel: 'C2' } });
  await adapter.stop();

  assert.deepEqual(gateway.dispatches.map((dispatch) => dispatch.agentId), ['ava', 'ava']);
  // Membership, not a session, is the boundary: nothing reached Bea.
  assert.deepEqual(gateway.observes, []);
  // A lookup Slack refuses fails closed, and says so.
  assert.equal(warnings.filter((line) => /could not tell whether bea is still in C2/.test(line)).length, 1, warnings.join('\n'));
});

test('a reply held behind a hearer\'s long turn does not hold the hearer\'s next message', async () => {
  const socketAva = createFakeSocket();
  const socketBea = createFakeSocket();
  const webAva = createFakeWeb('B-AVA', 'T1');
  const webBea = createFakeWeb('B-BEA', 'T1');
  webAva.knownConversations.set('C1', { is_member: true });
  webBea.knownConversations.set('C1', { is_member: true });
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'ok'));
  gateway.sessionRouting = routingOver(new Map([
    ['slack:ava:T1:C1:950.0', '2026-01-01T00:00:01.000Z'],
    ['slack:bea:T1:C1:950.0', '2026-01-01T00:00:00.000Z'],
  ]));
  // Bea's session has a turn running for as long as this test says: the
  // gateway's chain holds the reply's observe behind it.
  let release!: () => void;
  const beaBusy = new Promise<void>((resolve) => {
    release = resolve;
  });
  let heldReply!: () => void;
  const replyHeld = new Promise<void>((resolve) => {
    heldReply = resolve;
  });
  const stubObserve = gateway.observe!;
  gateway.observe = async (input) => {
    if (input.message.startsWith('Ava:')) {
      heldReply();
      await beaBusy;
    }
    return stubObserve.call(gateway, input);
  };

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

  // Ava answers; her reply's observe into Bea's session is now waiting
  // behind Bea's turn.
  const first = channelMessage({ text: 'say more', ts: '950.1', thread: '950.0' });
  const answered = Promise.all([socketAva.deliver('message', first), socketBea.deliver('message', first)]);
  await replyHeld;
  // Somebody turns to Bea. Her message's place in her intake chain is
  // behind the reply's link — which must have let go the moment the
  // observe was placed, or this dispatch waits out Bea's whole turn.
  const toBea = channelMessage({ text: '<@B-BEA> and you?', ts: '950.2', thread: '950.0' });
  const asked = Promise.all([socketAva.deliver('message', toBea), socketBea.deliver('message', toBea)]);
  // A macrotask later, not a wall clock: everything between the reply's
  // link and Bea's dispatch is promise-resolved, so by the time an
  // immediate scheduled now runs, that dispatch has either happened or is
  // held behind the observe — which here holds until released.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(gateway.dispatches.map((dispatch) => [dispatch.agentId, dispatch.userMessage]), [
    ['ava', 'Dylan: say more'],
    ['bea', 'Dylan: and you?'],
  ]);
  release();
  await Promise.all([answered, asked]);
  await adapter.stop();
});

test('a reply Slack refused to publish is heard by nobody', async () => {
  const socketAva = createFakeSocket();
  const socketBea = createFakeSocket();
  const webAva = createFakeWeb('B-AVA', 'T1');
  const webBea = createFakeWeb('B-BEA', 'T1');
  webAva.knownConversations.set('C1', { is_member: true });
  webBea.knownConversations.set('C1', { is_member: true });
  const gateway = createStubGateway(({ sessionId, userMessage }) => sessionWithReply(sessionId, `re ${userMessage}`));
  gateway.sessionRouting = async (sessionId) => {
    if (sessionId === 'slack:ava:T1:C1:100.1' || sessionId === 'slack:bea:T1:C1:960.0' || sessionId === 'slack:ava:T1:C1:960.0') {
      return {
        agentId: sessionId.split(':')[1] ?? '',
        metadata: { channel: 'slack', team: 'T1', slackChannel: 'C1', slackThread: '100.1' },
        lastSpokeAt: sessionId.startsWith('slack:ava:') ? '2026-01-01T00:00:01.000Z' : '2026-01-01T00:00:00.000Z',
        reply: 'the recovered reply',
      };
    }
    return undefined;
  };
  // Every edit and every post of Ava's is refused, so nothing she says
  // reaches the thread.
  let refusing = true;
  const update = webAva.chat.update;
  const post = webAva.chat.postMessage;
  webAva.chat.update = async (args) => {
    if (refusing) {
      throw new Error('ratelimited');
    }
    return update.call(webAva.chat, args);
  };
  webAva.chat.postMessage = async (args) => {
    if (refusing && args.text !== '…') {
      throw new Error('ratelimited');
    }
    return post.call(webAva.chat, args);
  };

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

  const both = (message: ReturnType<typeof channelMessage>) =>
    Promise.all([socketAva.deliver('message', message), socketBea.deliver('message', message)]);
  // A turn of Ava's whose final edit is refused, and a recovered reply of
  // hers whose every post is refused: neither was said in the thread, so
  // Bea does not hear either.
  await both(channelMessage({ text: 'say more', ts: '960.1', thread: '960.0' }));
  await gateway.bus.emit({ type: 'session.completed', sessionId: 'slack:ava:T1:C1:100.1' });
  // Slack recovers; the next reply lands, and is heard.
  refusing = false;
  await both(channelMessage({ text: 'again', ts: '960.2', thread: '960.0' }));
  // A reply too long for one message whose overflow Slack refuses: the
  // thread saw its first part only, and a hearer has no way to know which
  // part — so it is heard as not said at all, not as the whole.
  const longReply = `${'first part\n'.repeat(300)}${'x'.repeat(2000)}`;
  const answers = gateway.dispatch;
  gateway.dispatch = async (input) => {
    if (input.userMessage.includes('a lot')) {
      gateway.dispatches.push({ sessionId: input.sessionId, agentId: input.agentId ?? '', userMessage: input.userMessage });
      await gateway.bus.emit({ type: 'session.updated', sessionId: input.sessionId, status: 'running' });
      return sessionWithReply(input.sessionId, longReply);
    }
    return answers.call(gateway, input);
  };
  webAva.chat.postMessage = async (args) => {
    if (args.text !== '…') {
      throw new Error('ratelimited');
    }
    return post.call(webAva.chat, args);
  };
  await both(channelMessage({ text: 'write a lot', ts: '960.3', thread: '960.0' }));
  await adapter.stop();

  assert.deepEqual(gateway.dispatches.map((dispatch) => [dispatch.agentId, dispatch.userMessage]), [
    ['ava', 'Dylan: say more'],
    ['ava', 'Dylan: again'],
    ['ava', 'Dylan: write a lot'],
  ]);
  assert.ok(webAva.updates.some((update) => update.text.startsWith('first part')), 'the first part was edited in');
  assert.deepEqual(
    gateway.observes.map((observed) => [observed.agentId, observed.message]),
    [
      ['bea', 'Dylan: say more'],
      ['bea', 'Dylan: again'],
      ['bea', 'Ava: re Dylan: again'],
      ['bea', 'Dylan: write a lot'],
    ],
  );
});

test('an agent that listens to mentions answers only when named, and hears the rest', async () => {
  const socketAva = createFakeSocket();
  const socketBea = createFakeSocket();
  const webAva = createFakeWeb('B-AVA', 'T1');
  const webBea = createFakeWeb('B-BEA', 'T1');
  webAva.knownConversations.set('C1', { is_member: true });
  webBea.knownConversations.set('C1', { is_member: true });
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'ok'));
  gateway.agents = () => [
    { id: 'ava', name: 'Ava', listens: 'mentions' },
    { id: 'bea', name: 'Bea' },
  ];
  // Both in the thread; Ava spoke last.
  gateway.sessionRouting = routingOver(new Map([
    ['slack:ava:T1:C1:970.0', '2026-01-01T00:00:01.000Z'],
    ['slack:bea:T1:C1:970.0', '2026-01-01T00:00:00.000Z'],
  ]));
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

  const both = (message: ReturnType<typeof channelMessage>) =>
    Promise.all([socketAva.deliver('message', message), socketBea.deliver('message', message)]);
  // The voice that answered last is Ava's, so the untagged reply is hers
  // by the thread rule — and she does not take untagged replies. Bea
  // stands down for her all the same: nobody answers, both hear.
  await both(channelMessage({ text: 'say more', ts: '970.1', thread: '970.0' }));
  // Named, she answers, as she always did.
  await both(channelMessage({ text: '<@B-AVA> please', ts: '970.2', thread: '970.0' }));
  await adapter.stop();

  assert.deepEqual(gateway.dispatches.map((dispatch) => [dispatch.agentId, dispatch.userMessage]), [['ava', 'Dylan: please']]);
  assert.deepEqual(
    gateway.observes.map((observed) => [observed.agentId, observed.message]).sort(),
    [
      ['ava', 'Dylan: say more'],
      ['bea', 'Ava: ok'],
      ['bea', 'Dylan: <@B-AVA> please'],
      ['bea', 'Dylan: say more'],
    ],
  );
});

test('an agent that judges takes a turn nobody asked for while attentive, hears for free past that, and a mention re-arms it', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  web.knownConversations.set('C1', { is_member: true });
  // The session as the gateway would report it: when Ava last spoke in the
  // thread, and how many messages she has heard since.
  const attention: { lastSpokeAt?: string; heard: number } = { heard: 0 };
  const spokeAt = (ts: string): string => new Date(Number(ts) * 1000).toISOString();
  const gateway = createStubGateway(({ sessionId, userMessage }) => {
    if (userMessage.includes('help')) {
      return sessionWithReply(sessionId, 'Here is help');
    }
    return sessionWithReply(sessionId, userMessage.endsWith('Dylan: hi') ? 'hi there' : '');
  });
  gateway.agents = () => [{ id: 'ava', name: 'Ava', listens: 'judge' }];
  gateway.sessionRouting = async (sessionId) => (sessionId === 'slack:ava:T1:C1:980.0'
    ? {
      agentId: 'ava',
      metadata: {},
      heardSinceSpoke: attention.heard,
      ...(attention.lastSpokeAt !== undefined ? { lastSpokeAt: attention.lastSpokeAt } : {}),
    }
    : undefined);
  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);

  // In the thread but never spoke in it: not attentive. Heard, no turn.
  await socket.deliver('message', channelMessage({ text: 'kicking off', ts: '980.1', thread: '980.0' }));
  attention.heard += 1;
  // A mention runs a turn somebody asked for — placeholder and all — and
  // her answer re-arms attention.
  await socket.deliver('message', channelMessage({ text: '<@B-AVA> hi', ts: '980.2', thread: '980.0' }));
  attention.lastSpokeAt = spokeAt('980.2');
  attention.heard = 0;
  // Attentive: a turn nobody asked for. It says nothing, and nothing is
  // posted — no placeholder, no `(no reply)`.
  await socket.deliver('message', channelMessage({ text: 'and then', ts: '980.3', thread: '980.0' }));
  attention.heard += 1;
  // Attentive, and this time it has something to add: posted, with no
  // placeholder having been shown while it decided.
  await socket.deliver('message', channelMessage({ text: 'help me', ts: '980.4', thread: '980.0' }));
  attention.lastSpokeAt = spokeAt('980.4');
  attention.heard = 0;
  // Eight messages heard since she spoke: attention has run out. Heard, no
  // turn — and the provider is never called.
  attention.heard = 8;
  await socket.deliver('message', channelMessage({ text: 'still there?', ts: '980.5', thread: '980.0' }));
  // Fifteen minutes since she spoke, whatever the count: the same.
  attention.heard = 0;
  await socket.deliver('message', channelMessage({ text: 'much later', ts: '2000.0', thread: '980.0' }));
  // Attentive again, and the message carries a screenshot: a turn nobody
  // asked for takes no images — the kernel refuses them — so it is named
  // the way an overheard message's attachment is.
  attention.lastSpokeAt = spokeAt('2000.0');
  const withShot = channelMessage({ text: 'what about this', ts: '2000.1', thread: '980.0' });
  await socket.deliver('message', {
    ...withShot,
    event: { ...withShot.event, files: [{ id: 'F1', name: 'shot.png', mimetype: 'image/png', url_private_download: 'https://files.example/shot.png' }] },
  });
  await adapter.stop();

  // Cost, stated: one call per mention plus one per message judged inside
  // the window — four here, of seven messages.
  assert.deepEqual(gateway.dispatches.map((dispatch) => [dispatch.userMessage, dispatch.addressed, dispatch.images]), [
    ['Dylan: hi', undefined, undefined],
    ['Dylan: and then', false, undefined],
    ['Dylan: help me', false, undefined],
    ['Dylan: what about this\n[Attached: shot.png. Attachment contents cannot be read here — say so rather than guessing at them.]', false, undefined],
  ]);
  assert.deepEqual(gateway.observes.map((observed) => observed.message), [
    'Dylan: kicking off',
    'Dylan: still there?',
    'Dylan: much later',
  ]);
  // The thread saw exactly two things from Ava: the answer she was asked
  // for, in its placeholder, and the one she chose to give, as a message
  // of its own — and no `…` or `(no reply)` for the turn that said nothing.
  assert.deepEqual(web.posts.map((post) => post.text), ['…', 'Here is help']);
  assert.deepEqual(web.updates.map((update) => update.text), ['hi there']);
});

test('a turn nobody asked for opens its placeholder on its first text, never on a tool line, and a failed one says nothing', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const warnings: string[] = [];
  // A macrotask, so the streaming edit scheduled by an event gets to run
  // before the turn ends — the same wait the streaming tests use.
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  const gateway = createStubGateway(async ({ sessionId, userMessage }) => {
    if (userMessage.includes('tool only')) {
      await gateway.bus.emit({ type: 'tool.called', sessionId, call: { id: 'c1', toolName: 'demo.echo', input: {} } });
      await tick();
      await gateway.bus.emit({ type: 'tool.completed', sessionId, result: { callId: 'c1', toolName: 'demo.echo', ok: true, output: null } });
      await tick();
      return sessionWithReply(sessionId, '');
    }
    if (userMessage.includes('streams')) {
      await gateway.bus.emit({ type: 'provider.delta', sessionId, delta: { type: 'text', text: 'Thinking' } });
      await tick();
      return sessionWithReply(sessionId, 'Done');
    }
    throw new Error('provider exploded');
  });
  gateway.agents = () => [{ id: 'ava', name: 'Ava', listens: 'judge' }];
  gateway.sessionRouting = async () => ({
    agentId: 'ava',
    metadata: {},
    lastSpokeAt: new Date(990 * 1000).toISOString(),
    heardSinceSpoke: 0,
  });
  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
    warn: (line) => {
      warnings.push(line);
    },
  });
  await adapter.start(gateway);

  await socket.deliver('message', channelMessage({ text: 'tool only', ts: '990.1', thread: '990.0' }));
  assert.equal(web.posts.length, 0, 'a tool line alone is not a reason to post');
  await socket.deliver('message', channelMessage({ text: 'it streams', ts: '990.2', thread: '990.0' }));
  await socket.deliver('message', channelMessage({ text: 'it breaks', ts: '990.3', thread: '990.0' }));
  await adapter.stop();

  assert.deepEqual(gateway.dispatches.map((dispatch) => dispatch.addressed), [false, false, false]);
  // The streaming turn earned its placeholder with its first text, then
  // filled it; the failed one posted no error note, and said why not.
  assert.deepEqual(web.posts.map((post) => post.text), ['…']);
  assert.deepEqual(web.updates.map((update) => update.text), ['Thinking', 'Done']);
  assert.equal(warnings.filter((line) => /a turn nobody asked for failed before saying anything: provider exploded/.test(line)).length, 1, warnings.join('\n'));
});

test('text streamed to a turn nobody asked for before it begins does not open its placeholder', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, ''));
  gateway.agents = () => [{ id: 'ava', name: 'Ava', listens: 'judge' }];
  gateway.sessionRouting = async () => ({
    agentId: 'ava',
    metadata: {},
    lastSpokeAt: new Date(995 * 1000).toISOString(),
    heardSinceSpoke: 0,
  });
  // The turn is queued behind something — a recovery — and has not begun:
  // the session has not reported `running` for it.
  const stubDispatch = gateway.dispatch;
  gateway.dispatch = async (input) => {
    await gate;
    return stubDispatch.call(gateway, input);
  };
  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);

  const delivered = socket.deliver('message', channelMessage({ text: 'hm', ts: '995.1', thread: '995.0' }));
  // The recovery ahead of it streams; its text reaches the head renderer,
  // which is this turn's, waiting.
  await gateway.bus.emit({ type: 'provider.delta', sessionId: 'slack:ava:T1:C1:995.0', delta: { type: 'text', text: 'the recovery talking' } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  release();
  await delivered;
  await adapter.stop();

  // Nothing of it was posted under this turn's name, and the turn — which
  // then said nothing — posted nothing of its own.
  assert.equal(web.posts.length, 0);
  assert.equal(web.updates.length, 0);
});

test('a burst of messages typed inside one turn is judged only up to the window', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  // Every turn waits: the session never absorbs a judged message before
  // the next one arrives, so the store's count stays at zero throughout.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gateway = createStubGateway(async ({ sessionId }) => {
    await gate;
    return sessionWithReply(sessionId, '');
  });
  gateway.agents = () => [{ id: 'ava', name: 'Ava', listens: 'judge' }];
  gateway.sessionRouting = async () => ({
    agentId: 'ava',
    metadata: {},
    lastSpokeAt: new Date(1000 * 1000).toISOString(),
    heardSinceSpoke: 0,
  });
  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);

  const deliveries: Promise<void>[] = [];
  for (let index = 1; index <= 12; index += 1) {
    deliveries.push(socket.deliver('message', channelMessage({ text: `burst ${index}`, ts: `1000.${index}`, thread: '1000.0' })));
  }
  await Promise.all(deliveries);
  release();
  await adapter.stop();

  // Eight judged — the window — and the rest heard for free, whatever the
  // store had counted by then.
  assert.equal(gateway.dispatches.length, 8);
  assert.deepEqual(gateway.observes.map((observed) => observed.message), [
    'Dylan: burst 9',
    'Dylan: burst 10',
    'Dylan: burst 11',
    'Dylan: burst 12',
  ]);
});

test('a turn nobody asked for that ends while its placeholder is still opening fills that placeholder', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  let releaseTurn!: () => void;
  const turnGate = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  let releasePost!: () => void;
  web.postGate = new Promise<void>((resolve) => {
    releasePost = resolve;
  });
  // Slack is slow to take the placeholder. The moment the post is entered,
  // the turn finishes — and only after the finalize has begun does Slack
  // answer.
  web.onPostEnter = () => {
    releaseTurn();
    setImmediate(() => releasePost());
  };
  const gateway = createStubGateway(async ({ sessionId }) => {
    await gateway.bus.emit({ type: 'provider.delta', sessionId, delta: { type: 'text', text: 'Thinking' } });
    await turnGate;
    return sessionWithReply(sessionId, 'Done');
  });
  gateway.agents = () => [{ id: 'ava', name: 'Ava', listens: 'judge' }];
  gateway.sessionRouting = async () => ({
    agentId: 'ava',
    metadata: {},
    lastSpokeAt: new Date(1010 * 1000).toISOString(),
    heardSinceSpoke: 0,
  });
  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);
  await socket.deliver('message', channelMessage({ text: 'slow slack', ts: '1010.1', thread: '1010.0' }));
  await adapter.stop();

  // One placeholder, edited to the reply — not a placeholder left saying
  // "Thinking" with the reply posted beside it.
  assert.deepEqual(web.posts.map((post) => post.text), ['…']);
  assert.equal(web.updates.at(-1)?.text, 'Done');
});

test('a turn nobody asked for that fails while its placeholder is still opening reports the failure there', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  let releaseTurn!: () => void;
  const turnGate = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  let releasePost!: () => void;
  web.postGate = new Promise<void>((resolve) => {
    releasePost = resolve;
  });
  web.onPostEnter = () => {
    releaseTurn();
    setImmediate(() => releasePost());
  };
  const gateway = createStubGateway(async ({ sessionId }) => {
    await gateway.bus.emit({ type: 'provider.delta', sessionId, delta: { type: 'text', text: 'Thinking' } });
    await turnGate;
    throw new Error('provider exploded');
  });
  gateway.agents = () => [{ id: 'ava', name: 'Ava', listens: 'judge' }];
  gateway.sessionRouting = async () => ({
    agentId: 'ava',
    metadata: {},
    lastSpokeAt: new Date(1015 * 1000).toISOString(),
    heardSinceSpoke: 0,
  });
  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);
  await socket.deliver('message', channelMessage({ text: 'slow slack', ts: '1015.1', thread: '1015.0' }));
  await adapter.stop();

  // The placeholder it had started to open carries the failure, not
  // `(no reply)` — it said something, and then broke.
  assert.deepEqual(web.posts.map((post) => post.text), ['…']);
  assert.match(web.updates.at(-1)?.text ?? '', /Something went wrong: provider exploded/);
});

test('an attachment with nothing said does not spend a judging slot', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, ''));
  gateway.agents = () => [{ id: 'ava', name: 'Ava', listens: 'judge' }];
  gateway.sessionRouting = async () => ({
    agentId: 'ava',
    metadata: {},
    lastSpokeAt: new Date(1020 * 1000).toISOString(),
    heardSinceSpoke: 0,
  });
  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);
  // Eight files dropped in with nothing said: no turn for any of them, and
  // no slot held either.
  for (let index = 1; index <= 8; index += 1) {
    const dropped = channelMessage({ text: '', ts: `1020.${index}`, thread: '1020.0' });
    await socket.deliver('message', {
      ...dropped,
      event: { ...dropped.event, files: [{ id: `F${index}`, name: `log-${index}.txt`, mimetype: 'text/plain' }] },
    });
  }
  await socket.deliver('message', channelMessage({ text: 'so what do we do', ts: '1020.9', thread: '1020.0' }));
  await adapter.stop();

  assert.deepEqual(gateway.dispatches.map((dispatch) => [dispatch.userMessage, dispatch.addressed]), [['Dylan: so what do we do', false]]);
});

test('a follow-up typed while the opening mention is still starting is answered, not dropped', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'both, then'));
  // Nothing durable exists yet: the mention's session is written when its
  // turn starts, which is a placeholder post away.
  gateway.sessionRouting = async () => undefined;
  let release = (): void => {};
  web.postGate = new Promise<void>((resolve) => {
    release = () => resolve();
  });

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);

  await socket.deliver('app_mention', {
    body: { team_id: 'T1', event_id: 'evt-open' },
    event: { type: 'app_mention', user: 'U-DYLAN', text: '<@B-AVA> take a look', ts: '930.0', channel: 'C1' },
  });
  // The placeholder is still in flight — the second thought lands inside
  // the window where nothing has been persisted about the first.
  await socket.deliver('message', channelMessage({ text: 'and the other one too', ts: '930.1', thread: '930.0' }));
  release();
  await adapter.stop();

  assert.deepEqual(gateway.dispatches.map((dispatch) => dispatch.userMessage), [
    'Dylan: take a look',
    'Dylan: and the other one too',
  ]);
});

test('a follow-up whose ack comes back first still lands behind the mention that opened the thread', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'in order'));
  // Nothing durable to fall back on: receipt order is the only thing that
  // can decide either message.
  gateway.sessionRouting = async () => undefined;

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);

  // The mention's ack is still in flight when the follow-up's has already
  // come back — what the real client's send callbacks allow.
  let releaseAck = (): void => {};
  const heldAck = new Promise<void>((resolve) => {
    releaseAck = () => resolve();
  });
  await socket.deliver(
    'app_mention',
    {
      body: { team_id: 'T1', event_id: 'evt-slow-ack' },
      event: { type: 'app_mention', user: 'U-DYLAN', text: '<@B-AVA> start here', ts: '940.0', channel: 'C1' },
    },
    async () => heldAck,
  );
  await socket.deliver('message', channelMessage({ text: 'and this', ts: '940.1', thread: '940.0' }));
  releaseAck();
  await adapter.stop();

  // Both ran, and the conversation is in the order it was said — not the
  // order two acknowledgements happened to come back in.
  assert.deepEqual(gateway.dispatches.map((dispatch) => dispatch.userMessage), [
    'Dylan: start here',
    'Dylan: and this',
  ]);
});

test('a message with attachments tells the turn what arrived and that it cannot be read', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'noted'));

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);

  await socket.deliver('app_mention', {
    body: { team_id: 'T1', event_id: 'evt-files' },
    event: {
      type: 'app_mention',
      user: 'U-DYLAN',
      text: "<@B-AVA> here's the log",
      ts: '950.0',
      channel: 'C1',
      subtype: 'file_share',
      files: [{ name: 'server.log' }, { title: 'crash dump' }],
    },
  });
  // A file dropped in with nothing said is not a question; nothing answers it.
  await socket.deliver('app_mention', {
    body: { team_id: 'T1', event_id: 'evt-files-bare' },
    event: {
      type: 'app_mention',
      user: 'U-DYLAN',
      text: '<@B-AVA>',
      ts: '950.1',
      channel: 'C1',
      subtype: 'file_share',
      files: [{ name: 'screenshot.png' }],
    },
  });
  await adapter.stop();

  // The turn is told the names and told it cannot open them, so it can say
  // the true thing instead of answering as though it had read the log.
  assert.deepEqual(gateway.dispatches.map((dispatch) => dispatch.userMessage), [
    "Dylan: here's the log\n[Attached: server.log, crash dump. Attachment contents cannot be read here — say so rather than guessing at them.]",
  ]);
});

test('the agent losing a thread records the handover too, so a lagging socket cannot answer past it', async () => {
  const socketAva = createFakeSocket();
  const socketBea = createFakeSocket();
  const webAva = createFakeWeb('B-AVA', 'T1');
  const webBea = createFakeWeb('B-BEA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'ok'));
  // The sessions say Ava holds the thread, and nothing here updates them.
  gateway.sessionRouting = routingOver(new Map([['slack:ava:T1:C1:920.0', '2026-01-01T00:00:00.000Z']]));

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

  // Each agent is its own socket, and Bea's is behind: Ava's connection sees
  // both the message naming Bea and the reply after it before Bea's
  // connection has seen anything at all.
  await socketAva.deliver('message', channelMessage({ text: '<@B-BEA> your turn', ts: '920.1', thread: '920.0' }));
  await socketAva.deliver('message', channelMessage({ text: 'go on then', ts: '920.2', thread: '920.0' }));

  // Ava was holding this thread and answers neither: she saw the handover.
  // Length, not `deepEqual([])` — that narrows the array to `never[]` for
  // the assertions further down.
  assert.equal(gateway.dispatches.length, 0);

  // Bea's socket catches up and takes both, in the order they were said.
  await socketBea.deliver('message', channelMessage({ text: '<@B-BEA> your turn', ts: '920.1', thread: '920.0' }));
  await socketBea.deliver('message', channelMessage({ text: 'go on then', ts: '920.2', thread: '920.0' }));
  await adapter.stop();

  assert.deepEqual(gateway.dispatches.map((dispatch) => [dispatch.agentId, dispatch.userMessage]), [
    ['bea', 'Dylan: your turn'],
    ['bea', 'Dylan: go on then'],
  ]);
});

test('a mention of an agent whose app never came up is still not the other agent\'s to answer', async () => {
  const socketAva = createFakeSocket();
  const socketBea = createFakeSocket();
  socketBea.start = async () => {
    throw new Error('invalid_auth');
  };
  const webAva = createFakeWeb('B-AVA', 'T1');
  const webBea = createFakeWeb('B-BEA', 'T1');
  const warnings: string[] = [];
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'ok'));
  gateway.sessionRouting = routingOver(new Map([['slack:ava:T1:C1:960.0', '2026-01-01T00:00:00.000Z']]));

  const adapter = createSlackChannelAdapter({
    agents: [
      { agentId: 'ava', appToken: 'xapp-a', botToken: 'xoxb-a' },
      { agentId: 'bea', appToken: 'xapp-b', botToken: 'xoxb-b' },
    ],
    editIntervalMs: 0,
    createSocketClient: (appToken) => (appToken === 'xapp-a' ? socketAva : socketBea),
    createWebClient: (botToken) => (botToken === 'xoxb-a' ? webAva : webBea),
    warn: (line) => warnings.push(line),
  });
  await adapter.start(gateway);
  assert.equal(socketAva.started, true);
  assert.equal(warnings.some((line) => line.includes('bea')), true);

  // Ava holds the thread, and Bea's app is not serving — but Bea was named,
  // and a question handed to Bea does not fall back to Ava.
  await socketAva.deliver('message', channelMessage({ text: '<@B-BEA> can you take this?', ts: '960.1', thread: '960.0' }));
  await socketAva.deliver('message', channelMessage({ text: 'still there?', ts: '960.2', thread: '960.0' }));
  await adapter.stop();

  assert.deepEqual(gateway.dispatches, []);
});

test('a lagging socket reaching an older mention does not drag the thread back to it', async () => {
  const socketAva = createFakeSocket();
  const socketBea = createFakeSocket();
  const webAva = createFakeWeb('B-AVA', 'T1');
  const webBea = createFakeWeb('B-BEA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'ok'));
  gateway.sessionRouting = async () => undefined;

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

  // Ava's socket runs the conversation forward: she is asked, then Bea is.
  await socketAva.deliver('message', channelMessage({ text: '<@B-AVA> look at this', ts: '970.1', thread: '970.0' }));
  await socketAva.deliver('message', channelMessage({ text: '<@B-BEA> your turn', ts: '970.2', thread: '970.0' }));

  // Bea's socket is behind and only now reaches the FIRST of those. It must
  // not undo a handover that has already happened.
  await socketBea.deliver('message', channelMessage({ text: '<@B-AVA> look at this', ts: '970.1', thread: '970.0' }));

  // The untagged reply lands on Ava's socket while Bea's is still catching
  // up — the window where a dragged-back record would have Ava answer a
  // question that was handed to Bea.
  const followUp = channelMessage({ text: 'and?', ts: '970.3', thread: '970.0' });
  await socketAva.deliver('message', followUp);

  // Bea's socket catches up and takes what was always hers.
  await socketBea.deliver('message', channelMessage({ text: '<@B-BEA> your turn', ts: '970.2', thread: '970.0' }));
  await socketBea.deliver('message', followUp);
  await adapter.stop();

  assert.deepEqual(gateway.dispatches.map((dispatch) => [dispatch.agentId, dispatch.userMessage]), [
    ['ava', 'Dylan: look at this'],
    ['bea', 'Dylan: your turn'],
    ['bea', 'Dylan: and?'],
  ]);
});

test('a mention resolves within its own workspace, where a bot id is unique', async () => {
  const socketAva = createFakeSocket();
  const socketBea = createFakeSocket();
  // The same bot user id in two different workspaces — ids are unique
  // within one, never across.
  const webAva = createFakeWeb('B-SAME', 'T1');
  const webBea = createFakeWeb('B-SAME', 'T2');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'ok'));
  gateway.sessionRouting = async () => undefined;

  const adapter = createSlackChannelAdapter({
    // Bea first, so an unscoped search would answer with her.
    agents: [
      { agentId: 'bea', appToken: 'xapp-b', botToken: 'xoxb-b' },
      { agentId: 'ava', appToken: 'xapp-a', botToken: 'xoxb-a' },
    ],
    editIntervalMs: 0,
    createSocketClient: (appToken) => (appToken === 'xapp-a' ? socketAva : socketBea),
    createWebClient: (botToken) => (botToken === 'xoxb-a' ? webAva : webBea),
  });
  await adapter.start(gateway);

  // A mention in T1 is Ava's; Bea's identical id in T2 is a different bot.
  await socketAva.deliver('message', channelMessage({ text: '<@B-SAME> hello', ts: '980.1', thread: '980.0' }));
  await socketAva.deliver('message', channelMessage({ text: 'and the other thing', ts: '980.2', thread: '980.0' }));
  await adapter.stop();

  // Ava holds her own thread, so her follow-up reaches her rather than
  // being refused on behalf of an agent in another workspace.
  assert.deepEqual(gateway.dispatches.map((dispatch) => [dispatch.agentId, dispatch.userMessage]), [
    ['ava', 'Dylan: hello'],
    ['ava', 'Dylan: and the other thing'],
  ]);
});

/**
 * Two agents in one cold thread, with session reads that return a different
 * answer each time — what a stream of concurrent saves looks like to
 * lookups running side by side. `reads` is consumed in call order.
 */
const coldRaceAdapter = (reads: string[]) => {
  const socketAva = createFakeSocket();
  const socketBea = createFakeSocket();
  const webAva = createFakeWeb('B-AVA', 'T1');
  const webBea = createFakeWeb('B-BEA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'ok'));
  let releaseLookups = (): void => {};
  const lookups = new Promise<void>((resolve) => {
    releaseLookups = () => resolve();
  });
  let call = 0;
  gateway.sessionRouting = async (sessionId: string) => {
    const lastSpokeAt = reads[call] ?? reads.at(-1) ?? '';
    call += 1;
    // Held so both agents reach the cold path before either has recorded a
    // holder — the window a shared verdict exists for.
    await lookups;
    return { agentId: sessionId.split(':')[1] ?? '', metadata: {}, lastSpokeAt };
  };
  const adapter = createSlackChannelAdapter({
    agents: [
      { agentId: 'ava', appToken: 'xapp-a', botToken: 'xoxb-a' },
      { agentId: 'bea', appToken: 'xapp-b', botToken: 'xoxb-b' },
    ],
    editIntervalMs: 0,
    createSocketClient: (appToken) => (appToken === 'xapp-a' ? socketAva : socketBea),
    createWebClient: (botToken) => (botToken === 'xoxb-a' ? webAva : webBea),
  });
  return { adapter, gateway, socketAva, socketBea, release: () => releaseLookups() };
};

test('two agents that would each read themselves as the last speaker still answer once', async () => {
  // Resolved side by side, each agent's reads name ITSELF the last speaker:
  // Ava reads ava newer than bea, Bea reads bea newer than ava. Two
  // resolutions would both say yes, and one message would get two answers.
  const race = coldRaceAdapter([
    '2026-01-01T00:00:05.000Z', // Ava's read of ava
    '2026-01-01T00:00:01.000Z', // Bea's read of ava
    '2026-01-01T00:00:02.000Z', // Ava's read of bea
    '2026-01-01T00:00:04.000Z', // Bea's read of bea
  ]);
  await race.adapter.start(race.gateway);

  const followUp = channelMessage({ text: 'well?', ts: '990.1', thread: '990.0' });
  await race.socketAva.deliver('message', followUp);
  await race.socketBea.deliver('message', followUp);
  race.release();
  await race.adapter.stop();

  assert.equal(race.gateway.dispatches.length, 1);
});

test('two agents that would each read the other as the last speaker still answer once', async () => {
  // The mirror image: each agent's reads name the OTHER the last speaker,
  // so two resolutions would both stand down and nobody would answer —
  // which is the silence this branch exists to remove.
  const race = coldRaceAdapter([
    '2026-01-01T00:00:01.000Z', // Ava's read of ava
    '2026-01-01T00:00:05.000Z', // Bea's read of ava
    '2026-01-01T00:00:04.000Z', // Ava's read of bea
    '2026-01-01T00:00:02.000Z', // Bea's read of bea
  ]);
  await race.adapter.start(race.gateway);

  const followUp = channelMessage({ text: 'anyone?', ts: '991.1', thread: '991.0' });
  await race.socketAva.deliver('message', followUp);
  await race.socketBea.deliver('message', followUp);
  race.release();
  await race.adapter.stop();

  assert.equal(race.gateway.dispatches.length, 1);
});

test('an agent that has never spoken in a thread does not silence the one that has', async () => {
  const socketAva = createFakeSocket();
  const socketBea = createFakeSocket();
  const webAva = createFakeWeb('B-AVA', 'T1');
  const webBea = createFakeWeb('B-BEA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'ok'));
  // Both are in the thread. Bea was mentioned and is still on her first
  // turn — or it produced no text — so her session carries no reply time.
  gateway.sessionRouting = async (sessionId: string) => {
    const agentId = sessionId.split(':')[1] ?? '';
    if (agentId === 'ava') {
      return { agentId, metadata: {}, lastSpokeAt: '2026-01-01T00:00:01.000Z' };
    }
    return { agentId, metadata: {} };
  };

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

  const followUp = channelMessage({ text: 'so?', ts: '992.1', thread: '992.0' });
  await socketAva.deliver('message', followUp);
  await socketBea.deliver('message', followUp);
  await adapter.stop();

  // Ava is the only agent who has spoken here, so the reply is hers.
  assert.deepEqual(gateway.dispatches.map((dispatch) => [dispatch.agentId, dispatch.userMessage]), [
    ['ava', 'Dylan: so?'],
  ]);
});

test('a message naming an offline agent and a live one leaves the thread with the live one', async () => {
  const socketAva = createFakeSocket();
  const socketBea = createFakeSocket();
  socketAva.start = async () => {
    throw new Error('invalid_auth');
  };
  const webAva = createFakeWeb('B-AVA', 'T1');
  const webBea = createFakeWeb('B-BEA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'ok'));
  gateway.sessionRouting = async () => undefined;

  const adapter = createSlackChannelAdapter({
    // Ava is first in the roster and her app never comes up.
    agents: [
      { agentId: 'ava', appToken: 'xapp-a', botToken: 'xoxb-a' },
      { agentId: 'bea', appToken: 'xapp-b', botToken: 'xoxb-b' },
    ],
    editIntervalMs: 0,
    createSocketClient: (appToken) => (appToken === 'xapp-a' ? socketAva : socketBea),
    createWebClient: (botToken) => (botToken === 'xoxb-a' ? webAva : webBea),
    warn: () => {},
  });
  await adapter.start(gateway);

  // Both are asked; only Bea can answer, and she does.
  await socketBea.deliver('message', channelMessage({ text: '<@B-AVA> <@B-BEA> thoughts?', ts: '993.1', thread: '993.0' }));
  // So the thread is hers — the follow-up must not be stranded on the agent
  // that was named first and cannot hear it.
  await socketBea.deliver('message', channelMessage({ text: 'and the other half?', ts: '993.2', thread: '993.0' }));
  await adapter.stop();

  // Both turns are Bea's, and the second is the untagged one.
  assert.deepEqual(gateway.dispatches.map((dispatch) => dispatch.agentId), ['bea', 'bea']);
  assert.equal(gateway.dispatches[1]?.userMessage, 'Dylan: and the other half?');
});

test('a reply that reaches a lagging socket after a handover is still answered by whoever it was for', async () => {
  const socketAva = createFakeSocket();
  const socketBea = createFakeSocket();
  const webAva = createFakeWeb('B-AVA', 'T1');
  const webBea = createFakeWeb('B-BEA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'ok'));
  gateway.sessionRouting = async () => undefined;

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

  // Ava is asked, so the thread is hers.
  const opening = channelMessage({ text: '<@B-AVA> take this one', ts: '994.1', thread: '994.0' });
  await socketAva.deliver('message', opening);
  await socketBea.deliver('message', opening);

  // An untagged reply, plainly Ava's — but Bea's socket sees it first and
  // rightly ignores it.
  const forAva = channelMessage({ text: 'and the rest?', ts: '994.2', thread: '994.0' });
  await socketBea.deliver('message', forAva);

  // Bea's socket then runs ahead and takes a mention that moves the thread.
  const handover = channelMessage({ text: '<@B-BEA> over to you', ts: '994.3', thread: '994.0' });
  await socketBea.deliver('message', handover);

  // Only now does Ava's socket catch up on the reply that was hers. The
  // thread has moved on since, but that message had not.
  await socketAva.deliver('message', forAva);
  await socketAva.deliver('message', handover);
  await adapter.stop();

  assert.deepEqual(gateway.dispatches.map((dispatch) => [dispatch.agentId, dispatch.userMessage]), [
    ['ava', 'Dylan: take this one'],
    ['bea', 'Dylan: over to you'],
    ['ava', 'Dylan: and the rest?'],
  ]);
});

test('a cold verdict still resolving is not evicted by the messages behind it', async () => {
  const socketAva = createFakeSocket();
  const socketBea = createFakeSocket();
  const webAva = createFakeWeb('B-AVA', 'T1');
  const webBea = createFakeWeb('B-BEA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'ok'));
  let releaseFirst = (): void => {};
  const first = new Promise<void>((resolve) => {
    releaseFirst = () => resolve();
  });
  // The contested thread's reads are held; every other thread answers at
  // once, so its verdicts pile up behind the one still in flight.
  // Read in call order. The first resolution names Ava; a second,
  // independent one would name Bea — so two answers means the memo was lost.
  const reads = [
    '2026-01-01T00:00:05.000Z', // ava, as the first resolution reads it
    '2026-01-01T00:00:01.000Z', // bea, likewise
    '2026-01-01T00:00:01.000Z', // ava, as a second resolution would
    '2026-01-01T00:00:05.000Z', // bea, likewise
  ];
  let call = 0;
  gateway.sessionRouting = async (sessionId: string) => {
    const agentId = sessionId.split(':')[1] ?? '';
    if (sessionId.endsWith(':995.0')) {
      const lastSpokeAt = reads[call] ?? reads.at(-1) ?? '';
      call += 1;
      await first;
      return { agentId, metadata: {}, lastSpokeAt };
    }
    return undefined;
  };

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

  // Ava opens the contested resolution and stalls inside it.
  const contested = channelMessage({ text: 'well?', ts: '995.1', thread: '995.0' });
  await socketAva.deliver('message', contested);

  // Enough later messages, each its own thread and its own verdict, to run
  // the bounded cache past its capacity while that one is still pending.
  const filler: Array<Promise<void>> = [];
  for (let index = 0; index < 300; index += 1) {
    filler.push(socketAva.deliver('message', channelMessage({
      text: 'unrelated',
      ts: `996.${index}`,
      thread: `9${index}.0`,
    })));
  }
  await Promise.all(filler);

  // Bea's socket only now reaches the contested message. It must find the
  // verdict Ava started, not begin a second one.
  await socketBea.deliver('message', contested);
  releaseFirst();
  await adapter.stop();

  assert.equal(gateway.dispatches.length, 1);
});

test('a contested thread the gateway cannot order stays silent rather than answering twice', async () => {
  const socketAva = createFakeSocket();
  const socketBea = createFakeSocket();
  const webAva = createFakeWeb('B-AVA', 'T1');
  const webBea = createFakeWeb('B-BEA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'ok'));
  // A host whose routing carries no `updatedAt`: both agents are in the
  // thread, and neither can be shown to have spoken last.
  const engaged = new Set(['slack:ava:T1:C1:910.0', 'slack:bea:T1:C1:910.0']);
  gateway.sessionRouting = async (sessionId: string) =>
    engaged.has(sessionId) ? { agentId: sessionId.split(':')[1] ?? '', metadata: {} } : undefined;

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

  const followUp = channelMessage({ text: 'thoughts?', ts: '910.1', thread: '910.0' });
  await socketAva.deliver('message', followUp);
  await socketBea.deliver('message', followUp);
  await adapter.stop();

  assert.deepEqual(gateway.dispatches, []);
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

test('an approval retracted while stop() is draining still reaches the thread', async () => {
  // The drain took a snapshot of the in-flight set once, and the bus
  // subscription is torn down only after it — so a turn still finishing
  // could hand `track` work nobody was left to wait for. The work at risk
  // is exactly what the drain exists to deliver: a shutdown denies every
  // parked call, and the retraction of one is what takes the live buttons
  // off a message the daemon is about to stop listening to.
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const sessionId = 'slack:ava:T1:C1:100.1';

  let finishTurn!: (session: Session) => void;
  const turnHeld = new Promise<Session>((resolve) => {
    finishTurn = resolve;
  });
  let sawReply!: () => void;
  const replyUpdated = new Promise<void>((resolve) => {
    sawReply = resolve;
  });
  let releaseRetraction!: () => void;
  const retractionHeld = new Promise<void>((resolve) => {
    releaseRetraction = resolve;
  });
  const update = web.chat.update.bind(web.chat);
  web.chat.update = async (args) => {
    if (args.text === 'done') {
      // The last thing the drain's snapshot is waiting on.
      sawReply();
      return update(args);
    }
    await retractionHeld;
    return update(args);
  };

  const gateway = createStubGateway(() => turnHeld);
  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1', approvers: ['U-DYLAN'] }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);
  // A turn in flight, so its handler is in the snapshot the drain takes.
  await socket.deliver('app_mention', mention('<@B-AVA> do the thing'));
  gateway.pendingApprovals.add('req-1');
  await gateway.bus.emit(approvalRequest({ sessionId }));

  const stopped = adapter.stop();
  let stopReturned = false;
  void stopped.then(() => {
    stopReturned = true;
  });
  // Past the socket disconnect, so the snapshot has been taken.
  await new Promise((resolve) => setImmediate(resolve));
  // What a shutdown does to a parked call, arriving after that snapshot.
  await gateway.bus.emit({
    type: 'tool.approval-resolved',
    sessionId,
    requestId: 'req-1',
    answer: 'deny',
    reason: 'cancelled',
  });
  finishTurn(sessionWithReply(sessionId, 'done'));
  await replyUpdated;
  // Everything left in the snapshot's path is microtask work, so this
  // settles it: whatever the drain still holds, it holds deliberately.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(stopReturned, false, 'stop() waited for the retraction it had not yet seen');
  releaseRetraction();
  await stopped;
  assert.match(
    web.updates.find((entry) => entry.text !== 'done')?.text ?? '',
    /Cancelled|Denied|Resolved/,
    `the buttons came off before the adapter went away: ${web.updates.map((entry) => entry.text).join(' | ')}`,
  );
});

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
  assert.match(update?.text ?? '', /Allowed and remembered — for this session at least by <@U-DYLAN>/);
  // The floor, not the ceiling: a scoped grant normally survives a restart
  // and does not when the whitelist cannot be written, which this message
  // is sent too early to know.
  assert.doesNotMatch(update?.text ?? '', /past a restart/);

  await adapter.stop();
});

test('a request that says what always grants is rendered and resolved in those words', async () => {
  const { socket, web, gateway, adapter } = approvalAdapter([
    { agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1', approvers: ['U-DYLAN'] },
  ]);
  await adapter.start(gateway);

  // A gated tool with no scope: "always" is a standing grant to the agent,
  // and the prompt says so before anyone clicks — a grant that outlives the
  // session is a larger thing to hand out than one that does not.
  gateway.pendingApprovals.add('req-1');
  await gateway.bus.emit(approvalRequest({
    call: { id: 'call-1', toolName: 'web.fetch', input: { url: 'https://example.com' } },
    always: 'tool',
  }));
  const posted = web.posts.at(-1);
  assert.match(JSON.stringify(posted?.blocks), /Always allow\* grants this tool to Ava until an operator revokes it/);
  assert.deepEqual(buttonIds(posted?.blocks), ['stratus_approve_once', 'stratus_approve_always', 'stratus_deny']);

  await socket.deliver('interactive', click('stratus_approve_always', 'req-1', 'U-DYLAN'));
  const update = web.updates.at(-1);
  assert.equal(buttonIds(update?.blocks).length, 0);
  // The record names the grant that was made and how to take it back —
  // no hedging, because the request said which lifetime this was.
  assert.match(update?.text ?? '', /Allowed, and granted to Ava until revoked \(stratus grants ava\) by <@U-DYLAN>/);

  // A send outside a schedule is the one shape still scoped to the session,
  // and both the offer and the outcome say that instead.
  gateway.pendingApprovals.add('req-2');
  await gateway.bus.emit(approvalRequest({
    requestId: 'req-2',
    call: { id: 'call-2', toolName: 'message.send', input: { destination: 'slack:C1', text: 'hi' } },
    always: 'session',
  }));
  assert.match(JSON.stringify(web.posts.at(-1)?.blocks), /stops this tool asking again for the rest of this session/);
  await socket.deliver('interactive', click('stratus_approve_always', 'req-2', 'U-DYLAN'));
  assert.match(web.updates.at(-1)?.text ?? '', /Allowed for the rest of this session by <@U-DYLAN>/);

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

test('a one-shot request is not offered an Always allow button', async () => {
  const { web, gateway, adapter } = approvalAdapter([
    { agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1', approvers: ['U-DYLAN'] },
  ]);
  await adapter.start(gateway);

  gateway.pendingApprovals.add('req-1');
  await gateway.bus.emit(approvalRequest({
    call: { id: 'c1', toolName: 'mcp.vendor.wipe', input: {} },
    risk: 'dangerous',
    oneShot: true,
  }));

  // The engine remembers nothing here, so the button would do exactly what
  // Allow once does under a label promising a standing grant nobody gets.
  const posted = web.posts.at(-1);
  assert.deepEqual(buttonIds(posted?.blocks), ['stratus_approve_once', 'stratus_deny']);
  assert.ok(
    (posted?.blocks ?? []).some((block) => block.type === 'context'),
    'the prompt does not say why the choice is missing',
  );

  // An ordinary gated call still gets all three.
  gateway.pendingApprovals.add('req-2');
  await gateway.bus.emit(approvalRequest({ requestId: 'req-2' }));
  assert.deepEqual(
    buttonIds(web.posts.at(-1)?.blocks),
    ['stratus_approve_once', 'stratus_approve_always', 'stratus_deny'],
  );

  await adapter.stop();
});

test('an always answered on a dangerous call is recorded as the one-shot it is', async () => {
  const { socket, web, gateway, adapter } = approvalAdapter([
    { agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1', approvers: ['U-DYLAN'] },
  ]);
  await adapter.start(gateway);

  gateway.pendingApprovals.add('req-1');
  await gateway.bus.emit(approvalRequest({
    call: { id: 'c1', toolName: 'mcp.vendor.wipe', input: {} },
    risk: 'dangerous',
    oneShot: true,
  }));
  await socket.deliver('interactive', click('stratus_approve_always', 'req-1', 'U-DYLAN'));

  // The tier means a human every time, so the engine runs the call and
  // remembers nothing. The general line hedges between two lifetimes this
  // adapter cannot tell apart; this one it can, from the risk on the
  // request, and a record claiming a grant that does not exist is the kind
  // of audit line somebody acts on.
  const settled = web.updates.at(-1)?.text ?? '';
  assert.match(settled, /Allowed once — a dangerous tool is never remembered/);
  assert.doesNotMatch(settled, /remembered — for this session/);

  await adapter.stop();
});

test('an originless browser action resolved as always is recorded as one-shot too', async () => {
  const { socket, web, gateway, adapter } = approvalAdapter([
    { agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1', approvers: ['U-DYLAN'] },
  ]);
  await adapter.start(gateway);

  // This channel offers no **Always allow** for a one-shot request, but
  // `POST /approvals` still takes all three answers — so another client,
  // or an older one, can submit `always` for it. The record has to describe
  // what the engine did, not what was clicked.
  gateway.pendingApprovals.add('req-1');
  await gateway.bus.emit(approvalRequest({
    call: { id: 'c1', toolName: 'browser.act', input: { action: 'click', selector: '#submit' } },
    oneShot: true,
  }));
  await socket.deliver('interactive', click('stratus_approve_always', 'req-1', 'U-DYLAN'));

  const settled = web.updates.at(-1)?.text ?? '';
  assert.match(settled, /Allowed once — nothing about this call could be remembered/);
  assert.doesNotMatch(settled, /remembered — for this session/);
  // Not "no page": this line is shared with a shell command the parser
  // cannot reduce to a scope, where browser wording would be nonsense.
  assert.doesNotMatch(settled, /page/);

  await adapter.stop();
});

test('the approval prompt names the site a browser action would act on', async () => {
  const { web, gateway, adapter } = approvalAdapter([
    { agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1', approvers: ['U-DYLAN'] },
  ]);
  await adapter.start(gateway);

  gateway.pendingApprovals.add('req-1');
  await gateway.bus.emit(approvalRequest({
    call: { id: 'c1', toolName: 'browser.act', input: { action: 'click', selector: '#submit' } },
    origin: 'https://app.example.com',
  }));

  // `#submit` is equally "load more results" and "confirm purchase", so the
  // arguments alone say nothing about what is being approved — and **Always
  // allow** widens exactly the site the prompt would otherwise omit.
  const posted = web.posts.at(-1);
  assert.ok(
    sectionTexts(posted?.blocks).some((text) => text.includes('https://app.example.com')),
    `expected the origin in the blocks, got ${JSON.stringify(sectionTexts(posted?.blocks))}`,
  );
  assert.match(posted?.text ?? '', /on https:\/\/app\.example\.com/);

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
  assert.match(settled?.text ?? '', /Allowed and remembered — .*? by <@U-DYLAN>/);
  const updatesAfterDecision = web.updates.length;

  // The same button, clicked again — the message now carries the outcome.
  await socket.deliver('interactive', click('stratus_approve_always', 'req-1', 'U-DYLAN', { settled: true }));

  assert.equal(web.updates.length, updatesAfterDecision, 'the settled message is left exactly as it was');
  assert.match(web.updates.at(-1)?.text ?? '', /Allowed and remembered — .*? by <@U-DYLAN>/);
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

test('a recovered turn claims the queued placeholder before its routing is read', async () => {
  // Reading the routing of a turn nobody rendered is a store round trip,
  // and the message queued behind it can finish inside that window. The
  // placeholder has to be claimed when the outcome arrives, not when the
  // lookup comes back, or the recovery's reply is posted below the newer
  // turn's answer.
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

  let answerRouting!: () => void;
  const routingHeld = new Promise<void>((resolve) => {
    answerRouting = resolve;
  });
  const gateway = createStubGateway(({ sessionId }) => {
    const session = sessionWithReply(sessionId, 'the message\'s own reply');
    const messages = session.messages;
    // The adapter reads the reply out of the session immediately before it
    // finalizes the renderer, so this getter is the moment the queued turn
    // starts finishing. Answering the routing on the next macrotask lets
    // every microtask that finalize can make progress on run first: with
    // no claim it finalizes outright, and with one it stops at the claim.
    return {
      ...session,
      get messages() {
        setImmediate(answerRouting);
        return messages;
      },
    };
  });
  const stubDispatch = gateway.dispatch;
  gateway.dispatch = async (input) => {
    const stubActiveTurn = gateway.activeTurnId!;
    gateway.activeTurnId = () => 'recovered-turn';
    await gateway.bus.emit({ type: 'session.completed', sessionId: input.sessionId });
    gateway.activeTurnId = stubActiveTurn;
    return stubDispatch.call(gateway, input);
  };
  gateway.sessionRouting = async () => {
    await routingHeld;
    return {
      agentId: 'ava',
      metadata: { channel: 'slack', team: 'T1', slackChannel: 'C1', slackThread: '100.1' },
      reply: 'the recovered reply',
    };
  };
  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);
  await socket.deliver('app_mention', mention('<@B-AVA> and another thing'));
  await adapter.stop();

  // The recovery still got the placeholder that was posted first, and the
  // message's own reply went into the one opened below it.
  assert.ok(
    order.includes('update:bot-ts-1:the recovered reply'),
    `the recovery took the queued placeholder: ${order.join(', ')}`,
  );
  assert.equal(web.updates.find((entry) => entry.text === 'the message\'s own reply')?.ts, 'bot-ts-2');
});

test('a queued turn\'s own file waits for the handover it is behind', async () => {
  // The queued turn starts the moment the recovery's outcome lands, and can
  // produce a file of its own while the recovery is still reading its
  // routing. An upload is a message of its own, so one sent then would sit
  // above the recovery's attachment and read as the newer turn answering
  // first.
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-slack-upload-order-'));
  const recovered = path.join(root, 'recovered.png');
  const queued = path.join(root, 'queued.png');
  await writeFile(recovered, 'recovered bytes');
  await writeFile(queued, 'queued bytes');
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const order: string[] = [];

  let answerRouting!: () => void;
  const routingHeld = new Promise<void>((resolve) => {
    answerRouting = resolve;
  });
  const upload = web.files.uploadV2.bind(web.files);
  web.files.uploadV2 = async (args) => {
    order.push(`upload:${args.filename}`);
    // Whichever comes first: the queued turn's upload getting through (the
    // regression) or the finalize below. Either way the routing answers
    // and the test finishes rather than hanging.
    answerRouting();
    return upload(args);
  };

  const gateway: StubGateway = createStubGateway(async ({ sessionId }) => {
    // The queued turn's own tool result, produced while the recovery's
    // routing lookup is still out.
    await gateway.bus.emit({
      type: 'tool.completed',
      sessionId,
      result: { callId: 'c2', toolName: 'browser.screenshot', ok: true, output: { file: queued } },
    });
    const session = sessionWithReply(sessionId, 'the message\'s own reply');
    const messages = session.messages;
    // Read immediately before the renderer is finalized: the moment the
    // queued turn has nothing left to do but its own reply.
    return {
      ...session,
      get messages() {
        setImmediate(answerRouting);
        return messages;
      },
    };
  });
  const stubDispatch = gateway.dispatch;
  gateway.dispatch = async (input) => {
    const stubActiveTurn = gateway.activeTurnId!;
    gateway.activeTurnId = () => 'recovered-turn';
    await gateway.bus.emit({
      type: 'tool.completed',
      sessionId: input.sessionId,
      result: { callId: 'c1', toolName: 'browser.screenshot', ok: true, output: { file: recovered } },
    });
    await gateway.bus.emit({ type: 'session.completed', sessionId: input.sessionId });
    gateway.activeTurnId = stubActiveTurn;
    return stubDispatch.call(gateway, input);
  };
  gateway.sessionRouting = async () => {
    await routingHeld;
    return {
      agentId: 'ava',
      metadata: { channel: 'slack', team: 'T1', slackChannel: 'C1', slackThread: '100.1' },
      reply: 'the recovered reply',
    };
  };
  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);
  await socket.deliver('app_mention', mention('<@B-AVA> and another thing'));
  await adapter.stop();

  assert.deepEqual(order, ['upload:recovered.png', 'upload:queued.png']);
});

test('a turn with no renderer that outruns the attachment cap says so', async () => {
  // Nothing drains the queue of an unrendered turn's files until its
  // outcome arrives, so the queue is bounded — but attachments that never
  // reach the thread with nothing in the log is the hardest kind of loss
  // to work out afterwards.
  const root = await mkdtemp(path.join(os.tmpdir(), 'stratus-slack-file-cap-'));
  const shots: string[] = [];
  for (let index = 0; index < 21; index += 1) {
    const shot = path.join(root, `shot-${index}.png`);
    await writeFile(shot, `bytes ${index}`);
    shots.push(shot);
  }
  const warnings: string[] = [];
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'ok'));
  gateway.sessionRouting = async () => ({
    agentId: 'ava',
    metadata: { channel: 'slack', team: 'T1', slackChannel: 'C1', slackThread: '100.1' },
  });
  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
    warn: (line) => warnings.push(line),
  });
  await adapter.start(gateway);
  const sessionId = 'slack:ava:T1:C1:100.1';
  await gateway.bus.emit({
    type: 'tool.completed',
    sessionId,
    result: { callId: 'c1', toolName: 'browser.screenshot', ok: true, output: { files: shots } },
  });
  await gateway.bus.emit({ type: 'session.completed', sessionId });
  await adapter.stop();

  assert.equal(
    warnings.filter((line) => /21 files/.test(line) && /last 20/.test(line)).length,
    1,
    `the dropped attachment was reported: ${warnings.join(' | ')}`,
  );
  // The cap still holds: what is kept is the last twenty, in order.
  assert.deepEqual(web.uploads.map((entry) => entry.filename), shots.slice(1).map((shot) => path.basename(shot)));
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
  assert.match(outcome?.text ?? '', /Allowed and remembered — .*? by <@U-DYLAN>/);
  const updatesAfterOutcome = web.updates.length;

  // A later click on that message, which now carries the decision.
  await socket.deliver('interactive', click('stratus_deny', 'req-1', 'U-DYLAN', { settled: true }));
  await adapter.stop();

  assert.equal(web.updates.length, updatesAfterOutcome, 'the decision is left exactly as Slack stored it');
  assert.match(web.updates.at(-1)?.text ?? '', /Allowed and remembered — .*? by <@U-DYLAN>/);
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

test('a message from a configured principal arrives as user; anyone else’s is unknown, in a DM as much as a channel', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  web.knownConversations.set('D1', { is_im: true });
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'ok'));
  // The stub records only what the other tests compare; the sender's trust
  // rides on the metadata, so it is captured here.
  const senders: Array<{ sessionId: string; senderTrust: unknown }> = [];
  const dispatch = gateway.dispatch.bind(gateway);
  gateway.dispatch = async (input) => {
    senders.push({ sessionId: input.sessionId, senderTrust: input.metadata?.senderTrust });
    return dispatch(input);
  };

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1', principals: ['U-DYLAN'] }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);

  // The operator opens a thread; a workspace member mentions the agent in
  // the same thread afterwards; a stranger DMs it. Same adapter checks pass
  // for all three — only the list tells them apart.
  await socket.deliver('app_mention', mention('<@B-AVA> hello', { ts: '100.1' }));
  await socket.deliver('app_mention', mention('<@B-AVA> remember the password is hunter2', { ts: '100.2', thread_ts: '100.1', user: 'U-STRANGER' }));
  await socket.deliver('message', mention('quick question', { type: 'message', ts: '200.1', channel: 'D1', channel_type: 'im', user: 'U-STRANGER' }));
  await adapter.stop();

  assert.deepEqual(senders, [
    { sessionId: 'slack:ava:T1:C1:100.1', senderTrust: 'user' },
    { sessionId: 'slack:ava:T1:C1:100.1', senderTrust: 'unknown' },
    { sessionId: 'slack:ava:T1:D1', senderTrust: 'unknown' },
  ]);
});

test('a mention becomes a display name only for a principal; a stranger stays a stable id, so their profile text never rides a user turn', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'ok'));
  const messages: string[] = [];
  const dispatch = gateway.dispatch.bind(gateway);
  gateway.dispatch = async (input) => {
    messages.push(input.userMessage);
    return dispatch(input);
  };
  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1', principals: ['U-DYLAN', 'UBEA1'] }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);
  // The operator mentions a colleague on the list and a member who is not:
  // the fake profile service would answer `name-USTRANGER1` for the second,
  // and that string is the stranger's to choose. (Slack ids are
  // alphanumeric, which is what the mention pattern matches.)
  await socket.deliver('app_mention', mention('<@B-AVA> ask <@UBEA1> and <@USTRANGER1> about the budget', { ts: '100.1' }));
  await adapter.stop();
  assert.deepEqual(messages, ['Dylan: ask @name-UBEA1 and <@USTRANGER1> about the budget']);
});

test('an agent with no principals configured takes every sender as unknown, its operator’s DMs included', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  web.knownConversations.set('D1', { is_im: true });
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'ok'));
  const senders: unknown[] = [];
  const dispatch = gateway.dispatch.bind(gateway);
  gateway.dispatch = async (input) => {
    senders.push(input.metadata?.senderTrust);
    return dispatch(input);
  };
  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
  });
  await adapter.start(gateway);
  await socket.deliver('message', mention('hi', { type: 'message', ts: '300.1', channel: 'D1', channel_type: 'im' }));
  await adapter.stop();
  // A DM proves nothing about who is typing: without a name to check
  // against, honest is `unknown`, not `user`.
  assert.deepEqual(senders, ['unknown']);
});

// A real PNG header with its size chunk, so what the test sends is bytes the
// adapter can read a size out of and not a string that happens to be
// called an image.
const PNG_IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
const pngHeader = (width: number, height: number): Buffer => {
  const bytes = Buffer.alloc(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return Buffer.concat([bytes, PNG_IEND]);
};
const PNG_BYTES = pngHeader(1, 1);
/** A PNG of `length` bytes that still opens and closes like one. */
const pngOfLength = (length: number): Buffer => Buffer.concat([
  PNG_BYTES.subarray(0, 24),
  Buffer.alloc(length - PNG_BYTES.length, 1),
  PNG_IEND,
]);

test('an attached image is downloaded and travels with the dispatch; other files stay a note', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'I see it'));
  const fetched: Array<{ url: string; token: string }> = [];

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
    fetchFile: async (url, token) => {
      fetched.push({ url, token });
      return { status: 200, contentType: 'image/png', body: PNG_BYTES };
    },
  });
  await adapter.start(gateway);

  await socket.deliver('app_mention', {
    body: { team_id: 'T1', event_id: 'evt-image' },
    event: {
      type: 'app_mention',
      user: 'U-DYLAN',
      text: "<@B-AVA> what's wrong here?",
      ts: '960.0',
      channel: 'C1',
      subtype: 'file_share',
      files: [
        { id: 'F1', name: 'error.png', mimetype: 'image/png', size: PNG_BYTES.length, url_private_download: 'https://files.slack.com/F1/download' },
        { id: 'F2', name: 'server.log', mimetype: 'text/plain', size: 10, url_private_download: 'https://files.slack.com/F2/download' },
      ],
    },
  });
  await adapter.stop();

  // The download carries the bot token — it is the transport's secret,
  // used by the transport — and only the image was fetched.
  assert.deepEqual(fetched, [{ url: 'https://files.slack.com/F1/download', token: 'xoxb-1' }]);
  assert.deepEqual(gateway.dispatches, [{
    sessionId: 'slack:ava:T1:C1:960.0',
    agentId: 'ava',
    // The image is not in the note: the model is shown it. The log still is.
    userMessage: "Dylan: what's wrong here?\n[Attached: server.log. Attachment contents cannot be read here — say so rather than guessing at them.]",
    images: [{ mediaType: 'image/png', data: PNG_BYTES.toString('base64'), name: 'error.png' }],
  }]);
});

test('an image dropped in with nothing said is still a question', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'a screenshot'));

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
    fetchFile: async () => ({ status: 200, contentType: 'image/png', body: PNG_BYTES }),
  });
  await adapter.start(gateway);

  await socket.deliver('app_mention', {
    body: { team_id: 'T1', event_id: 'evt-image-bare' },
    event: {
      type: 'app_mention',
      user: 'U-DYLAN',
      text: '<@B-AVA>',
      ts: '961.0',
      channel: 'C1',
      subtype: 'file_share',
      files: [{ id: 'F3', title: 'shot', mimetype: 'image/png', url_private: 'https://files.slack.com/F3' }],
    },
  });
  await adapter.stop();

  assert.equal(gateway.dispatches.length, 1);
  // The speaker is still named, so a bare image in a channel is not anonymous.
  assert.equal(gateway.dispatches[0]!.userMessage, 'Dylan:');
  assert.deepEqual(gateway.dispatches[0]!.images, [
    { mediaType: 'image/png', data: PNG_BYTES.toString('base64'), name: 'shot' },
  ]);
});

test('an image the token may not read falls back to the note and names the scope', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'noted'));
  const warnings: string[] = [];

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    warn: (line) => warnings.push(line),
    createSocketClient: () => socket,
    createWebClient: () => web,
    // What Slack actually does without files:read: a 200 and a sign-in page.
    fetchFile: async () => ({ status: 200, contentType: 'text/html; charset=utf-8', body: Buffer.from('<html>sign in</html>') }),
  });
  await adapter.start(gateway);

  await socket.deliver('app_mention', {
    body: { team_id: 'T1', event_id: 'evt-image-noscope' },
    event: {
      type: 'app_mention',
      user: 'U-DYLAN',
      text: '<@B-AVA> see attached',
      ts: '962.0',
      channel: 'C1',
      subtype: 'file_share',
      files: [{ id: 'F4', name: 'error.png', mimetype: 'image/png', size: 100, url_private_download: 'https://files.slack.com/F4/download' }],
    },
  });
  await adapter.stop();

  assert.deepEqual(gateway.dispatches.map((dispatch) => [dispatch.userMessage, dispatch.images]), [[
    'Dylan: see attached\n[Attached: error.png. Attachment contents cannot be read here — say so rather than guessing at them.]',
    undefined,
  ]]);
  assert.equal(warnings.filter((line) => /error\.png/.test(line) && /files:read/.test(line)).length, 1);
});

test('an image over the model limit is never downloaded, while a smaller one beside it still is', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'noted'));
  const fetched: string[] = [];

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    createSocketClient: () => socket,
    createWebClient: () => web,
    fetchFile: async (url) => {
      fetched.push(url);
      return { status: 200, contentType: 'image/png', body: PNG_BYTES };
    },
  });
  await adapter.start(gateway);

  await socket.deliver('app_mention', {
    body: { team_id: 'T1', event_id: 'evt-image-huge' },
    event: {
      type: 'app_mention',
      user: 'U-DYLAN',
      text: '<@B-AVA> full-res and a crop',
      ts: '963.0',
      channel: 'C1',
      subtype: 'file_share',
      files: [
        { id: 'F5', name: 'poster.png', mimetype: 'image/png', size: 6 * 1024 * 1024, url_private_download: 'https://files.slack.com/F5/download' },
        { id: 'F6', name: 'crop.png', mimetype: 'image/png', size: PNG_BYTES.length, url_private_download: 'https://files.slack.com/F6/download' },
      ],
    },
  });
  await adapter.stop();

  // Slack's own size is trusted before any bytes move: the poster was never
  // requested, and the crop went through as usual.
  assert.deepEqual(fetched, ['https://files.slack.com/F6/download']);
  assert.deepEqual(gateway.dispatches.map((dispatch) => [dispatch.userMessage, dispatch.images?.map((image) => image.name)]), [[
    'Dylan: full-res and a crop\n[Attached: poster.png. Attachment contents cannot be read here — say so rather than guessing at them.]',
    ['crop.png'],
  ]]);
});

test('a download that stalls is abandoned at the deadline and the turn goes on without it', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'noted'));
  const warnings: string[] = [];

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    warn: (line) => warnings.push(line),
    createSocketClient: () => socket,
    createWebClient: () => web,
    fileDownloadTimeoutMs: 20,
    // A fetcher that never answers on its own: it ends only when the
    // adapter's deadline tells it to. Given no deadline at all — the
    // regression — it answers at once with an image, and the assertions
    // below fail rather than the test hanging.
    fetchFile: (_url, _token, signal) => new Promise((resolve, reject) => {
      if (!(signal instanceof AbortSignal)) {
        resolve({ status: 200, contentType: 'image/png', body: PNG_BYTES });
        return;
      }
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  await adapter.start(gateway);

  await socket.deliver('app_mention', {
    body: { team_id: 'T1', event_id: 'evt-image-stall' },
    event: {
      type: 'app_mention',
      user: 'U-DYLAN',
      text: '<@B-AVA> slow one',
      ts: '964.0',
      channel: 'C1',
      subtype: 'file_share',
      files: [{ id: 'F7', name: 'slow.png', mimetype: 'image/png', size: 100, url_private_download: 'https://files.slack.com/F7/download' }],
    },
  });
  await adapter.stop();

  assert.deepEqual(gateway.dispatches.map((dispatch) => [dispatch.userMessage, dispatch.images]), [[
    'Dylan: slow one\n[Attached: slow.png. Attachment contents cannot be read here — say so rather than guessing at them.]',
    undefined,
  ]]);
  assert.equal(warnings.filter((line) => /slow\.png/.test(line) && /longer than 20ms/.test(line)).length, 1);
});

test('one message\'s downloads share a single deadline, so ten stalls cost one wait', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'noted'));
  const warnings: string[] = [];
  const signals: AbortSignal[] = [];

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    warn: (line) => warnings.push(line),
    createSocketClient: () => socket,
    createWebClient: () => web,
    fileDownloadTimeoutMs: 20,
    // Every download stalls until its signal fires.
    fetchFile: (_url, _token, signal) => new Promise((_resolve, reject) => {
      signals.push(signal);
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  await adapter.start(gateway);

  await socket.deliver('app_mention', {
    body: { team_id: 'T1', event_id: 'evt-image-batch' },
    event: {
      type: 'app_mention',
      user: 'U-DYLAN',
      text: '<@B-AVA> three slow ones',
      ts: '968.0',
      channel: 'C1',
      subtype: 'file_share',
      files: [1, 2, 3].map((n) => ({ id: `S${n}`, name: `slow${n}.png`, mimetype: 'image/png', size: 100, url_private_download: `https://files.slack.com/S${n}/download` })),
    },
  });
  await adapter.stop();

  // One download waited out the deadline — the last-listed file, since
  // files are decided from the end — and the rest were never started,
  // because the deadline they would have shared had passed.
  assert.equal(signals.length, 1);
  assert.equal(
    gateway.dispatches[0]?.userMessage,
    'Dylan: three slow ones\n[Attached: slow1.png, slow2.png, slow3.png. Attachment contents cannot be read here — say so rather than guessing at them.]',
  );
  assert.equal(warnings.filter((line) => /slow3\.png/.test(line) && /longer than 20ms/.test(line)).length, 1);
  assert.equal(warnings.filter((line) => /slow[12]\.png/.test(line) && /already taken longer/.test(line)).length, 2);
});

test('images that fit one by one are still held to the message\'s total budget', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'noted'));
  const warnings: string[] = [];
  const fetched: string[] = [];
  // Each just under the per-image cap; five together are over what one
  // request can carry, and past the per-message budget after four.
  const nearCap = 5 * 1024 * 1024 - 1;

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    warn: (line) => warnings.push(line),
    createSocketClient: () => socket,
    createWebClient: () => web,
    fetchFile: async (url) => {
      fetched.push(url);
      return { status: 200, contentType: 'image/png', body: pngOfLength(nearCap) };
    },
  });
  await adapter.start(gateway);

  await socket.deliver('app_mention', {
    body: { team_id: 'T1', event_id: 'evt-image-budget' },
    event: {
      type: 'app_mention',
      user: 'U-DYLAN',
      text: '<@B-AVA> all of them',
      ts: '965.0',
      channel: 'C1',
      subtype: 'file_share',
      files: [1, 2, 3, 4, 5].map((n) => ({
        id: `F${n}`, name: `shot${n}.png`, mimetype: 'image/png', size: nearCap, url_private_download: `https://files.slack.com/F${n}/download`,
      })),
    },
  });
  await adapter.stop();

  // Decided from the last file back, as the replay window is spent: the
  // first was never even requested, because Slack's size said it would not
  // fit after the four listed after it. Delivered in the message's order.
  assert.deepEqual(fetched, [5, 4, 3, 2].map((n) => `https://files.slack.com/F${n}/download`));
  assert.deepEqual(gateway.dispatches[0]?.images?.map((image) => image.name), ['shot2.png', 'shot3.png', 'shot4.png', 'shot5.png']);
  assert.equal(
    gateway.dispatches[0]?.userMessage,
    'Dylan: all of them\n[Attached: shot1.png. Attachment contents cannot be read here — say so rather than guessing at them.]',
  );
  assert.equal(warnings.filter((line) => /shot1\.png/.test(line) && /message of its own/.test(line)).length, 1);
});

test('the default fetcher stops reading a body the moment it passes what the caller will take', async () => {
  let pulls = 0;
  let cancelled = false;
  // A body that never ends: each pull is another 1 KiB, forever.
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const fetchImpl = (async () => new Response(endless, { status: 200, headers: { 'content-type': 'image/png' } })) as unknown as typeof fetch;

  const download = await createSlackFileFetcher(fetchImpl)('https://files.slack.com/F9/download', 'xoxb-1', AbortSignal.timeout(5000), 4096);

  assert.equal(download.truncated, true);
  assert.equal(download.body.length, 0);
  assert.equal(cancelled, true);
  // Four chunks fit and the fifth did not; the stream reads one chunk
  // ahead on its own, so the exact count is its business, not ours — what
  // matters is that an endless body was let go of almost at once.
  assert.ok(pulls >= 5 && pulls <= 8, `expected the read to stop after a handful of pulls, saw ${pulls}`);

  // A body that fits comes back whole, and a declared length that does not
  // is refused before a byte is read.
  const small = await createSlackFileFetcher((async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as unknown as typeof fetch)('u', 't', AbortSignal.timeout(5000), 4096);
  assert.deepEqual([...small.body], [1, 2, 3]);
  assert.equal(small.truncated, undefined);
  let readDeclared = 0;
  const declared = new ReadableStream<Uint8Array>({ pull(controller) { readDeclared += 1; controller.enqueue(new Uint8Array(8)); } });
  const refused = await createSlackFileFetcher((async () => new Response(declared, { status: 200, headers: { 'content-length': '5000' } })) as unknown as typeof fetch)('u', 't', AbortSignal.timeout(5000), 4096);
  assert.equal(refused.truncated, true);
  assert.equal(refused.body.length, 0);
  // The stream primes one chunk for itself when it is built; the fetcher
  // asked it for nothing.
  assert.ok(readDeclared <= 1, `expected no reads beyond the stream's own priming, saw ${readDeclared}`);
});

test('an image whose download is cut off at the cap falls back to the note', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'noted'));
  const warnings: string[] = [];
  const caps: number[] = [];

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    warn: (line) => warnings.push(line),
    createSocketClient: () => socket,
    createWebClient: () => web,
    // Slack said nothing about the size, and the response was bigger than
    // the fetcher was allowed to take.
    fetchFile: async (_url, _token, _signal, maxBytes) => {
      caps.push(maxBytes);
      return { status: 200, contentType: 'image/png', body: Buffer.alloc(0), truncated: true };
    },
  });
  await adapter.start(gateway);

  await socket.deliver('app_mention', {
    body: { team_id: 'T1', event_id: 'evt-image-cut' },
    event: {
      type: 'app_mention',
      user: 'U-DYLAN',
      text: '<@B-AVA> unsized',
      ts: '966.0',
      channel: 'C1',
      subtype: 'file_share',
      files: [{ id: 'F8', name: 'unsized.png', mimetype: 'image/png', url_private_download: 'https://files.slack.com/F8/download' }],
    },
  });
  await adapter.stop();

  // The first image of a message may weigh the per-image cap.
  assert.deepEqual(caps, [5 * 1024 * 1024]);
  assert.deepEqual(gateway.dispatches.map((dispatch) => [dispatch.userMessage, dispatch.images]), [[
    'Dylan: unsized\n[Attached: unsized.png. Attachment contents cannot be read here — say so rather than guessing at them.]',
    undefined,
  ]]);
  assert.equal(warnings.filter((line) => /unsized\.png/.test(line) && /abandoned/.test(line)).length, 1);
});

test('an image the model API would refuse for its size in pixels is never stored', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'noted'));
  const warnings: string[] = [];

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    warn: (line) => warnings.push(line),
    createSocketClient: () => socket,
    createWebClient: () => web,
    fetchFile: async (url) => ({
      status: 200,
      contentType: 'image/png',
      // A flat 9000-pixel-wide PNG is tiny on disk and refused by the API;
      // the "jpeg" is a PNG under another name.
      body: url.includes('F10') ? pngHeader(9000, 100) : PNG_BYTES,
    }),
  });
  await adapter.start(gateway);

  await socket.deliver('app_mention', {
    body: { team_id: 'T1', event_id: 'evt-image-dims' },
    event: {
      type: 'app_mention',
      user: 'U-DYLAN',
      text: '<@B-AVA> the big one and a fake',
      ts: '967.0',
      channel: 'C1',
      subtype: 'file_share',
      files: [
        { id: 'F10', name: 'wide.png', mimetype: 'image/png', size: 36, url_private_download: 'https://files.slack.com/F10/download' },
        { id: 'F11', name: 'fake.jpg', mimetype: 'image/jpeg', size: 36, url_private_download: 'https://files.slack.com/F11/download' },
      ],
    },
  });
  await adapter.stop();

  assert.deepEqual(gateway.dispatches.map((dispatch) => [dispatch.userMessage, dispatch.images]), [[
    'Dylan: the big one and a fake\n[Attached: wide.png, fake.jpg. Attachment contents cannot be read here — say so rather than guessing at them.]',
    undefined,
  ]]);
  assert.equal(warnings.filter((line) => /wide\.png/.test(line) && /9000×100/.test(line)).length, 1);
  assert.equal(warnings.filter((line) => /fake\.jpg/.test(line) && /not a complete image\/jpeg/.test(line)).length, 1);
});

test('an image left out for the message\'s budget closes the window to everything listed before it', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'noted'));
  const warnings: string[] = [];
  const fetched: string[] = [];
  const mib = 1024 * 1024;
  // Listed oldest first: a small one, a middling one, then four large ones.
  // The four newest take 18 MiB; the middling one would pass 20 and is left
  // out; the small one would fit what is left, and is left out anyway.
  const sizes = [1 * mib, 4 * mib, 4.5 * mib, 4.5 * mib, 4.5 * mib, 4.5 * mib];

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    warn: (line) => warnings.push(line),
    createSocketClient: () => socket,
    createWebClient: () => web,
    fetchFile: async (url) => {
      fetched.push(url);
      const n = Number(/F(\d)/.exec(url)![1]);
      return { status: 200, contentType: 'image/png', body: pngOfLength(sizes[n - 1]!) };
    },
  });
  await adapter.start(gateway);

  await socket.deliver('app_mention', {
    body: { team_id: 'T1', event_id: 'evt-image-window' },
    event: {
      type: 'app_mention',
      user: 'U-DYLAN',
      text: '<@B-AVA> six of them',
      ts: '969.0',
      channel: 'C1',
      subtype: 'file_share',
      files: sizes.map((size, index) => ({
        id: `F${index + 1}`, name: `shot${index + 1}.png`, mimetype: 'image/png', size, url_private_download: `https://files.slack.com/F${index + 1}/download`,
      })),
    },
  });
  await adapter.stop();

  assert.deepEqual(fetched, [6, 5, 4, 3].map((n) => `https://files.slack.com/F${n}/download`));
  assert.deepEqual(gateway.dispatches[0]?.images?.map((image) => image.name), ['shot3.png', 'shot4.png', 'shot5.png', 'shot6.png']);
  assert.equal(
    gateway.dispatches[0]?.userMessage,
    'Dylan: six of them\n[Attached: shot1.png, shot2.png. Attachment contents cannot be read here — say so rather than guessing at them.]',
  );
  assert.equal(warnings.filter((line) => /shot2\.png/.test(line) && /message of its own/.test(line)).length, 1);
  assert.equal(warnings.filter((line) => /shot1\.png/.test(line) && /listed after it/.test(line)).length, 1);
});

test('a download cut off at what was left of the budget closes the window too', async () => {
  const socket = createFakeSocket();
  const web = createFakeWeb('B-AVA', 'T1');
  const gateway = createStubGateway(({ sessionId }) => sessionWithReply(sessionId, 'noted'));
  const warnings: string[] = [];
  const fetched: Array<{ url: string; maxBytes: number }> = [];
  const mib = 1024 * 1024;
  // Oldest first: a small sized one, an unsized one that turns out to be
  // 4 MiB, then four large ones. After the four newest take 18 MiB the
  // unsized one is cut off at the 2 MiB left — and that closes the window
  // to the small one, which would otherwise have fit.
  const files = [
    { id: 'F1', name: 'shot1.png', mimetype: 'image/png', size: 1 * mib, url_private_download: 'https://files.slack.com/F1/download' },
    { id: 'F2', name: 'shot2.png', mimetype: 'image/png', url_private_download: 'https://files.slack.com/F2/download' },
    ...[3, 4, 5, 6].map((n) => ({ id: `F${n}`, name: `shot${n}.png`, mimetype: 'image/png', size: 4.5 * mib, url_private_download: `https://files.slack.com/F${n}/download` })),
  ];

  const adapter = createSlackChannelAdapter({
    agents: [{ agentId: 'ava', appToken: 'xapp-1', botToken: 'xoxb-1' }],
    editIntervalMs: 0,
    warn: (line) => warnings.push(line),
    createSocketClient: () => socket,
    createWebClient: () => web,
    fetchFile: async (url, _token, _signal, maxBytes) => {
      fetched.push({ url, maxBytes });
      if (url.includes('F2')) {
        return { status: 200, contentType: 'image/png', body: Buffer.alloc(0), truncated: true };
      }
      return { status: 200, contentType: 'image/png', body: pngOfLength(4.5 * mib) };
    },
  });
  await adapter.start(gateway);

  await socket.deliver('app_mention', {
    body: { team_id: 'T1', event_id: 'evt-image-cut-window' },
    event: { type: 'app_mention', user: 'U-DYLAN', text: '<@B-AVA> six again', ts: '970.0', channel: 'C1', subtype: 'file_share', files },
  });
  await adapter.stop();

  assert.deepEqual(fetched.map((call) => call.url), [6, 5, 4, 3, 2].map((n) => `https://files.slack.com/F${n}/download`));
  // The unsized one was offered only what was left, and that is what cut it off.
  assert.equal(fetched.at(-1)?.maxBytes, 2 * mib);
  assert.deepEqual(gateway.dispatches[0]?.images?.map((image) => image.name), ['shot3.png', 'shot4.png', 'shot5.png', 'shot6.png']);
  assert.equal(
    gateway.dispatches[0]?.userMessage,
    'Dylan: six again\n[Attached: shot1.png, shot2.png. Attachment contents cannot be read here — say so rather than guessing at them.]',
  );
  assert.equal(warnings.filter((line) => /shot2\.png/.test(line) && /abandoned/.test(line)).length, 1);
  assert.equal(warnings.filter((line) => /shot1\.png/.test(line) && /listed after it/.test(line)).length, 1);
});
