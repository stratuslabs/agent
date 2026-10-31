import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentRunner,
  EventBus,
  InMemorySessionStore,
  NO_REPLY_MARKER,
  REPLY_OPTIONAL_NOTE,
  UNADDRESSED_TURN_NOTE,
  isReplyOptionalTurn,
  isUnaddressedTurn,
  latestTurnReply,
  promptTextOf,
  type Message,
  type ModelProvider,
  type ProviderRequest,
  type ProviderResponse,
  type StratusEvent,
} from '../src/index.ts';

const AGENT = { id: 'ava', name: 'Ava' };

/**
 * Renders the turn the way a provider would — every user message through
 * `promptTextOf`, the newest marked — and answers with whatever the test
 * decided for that prompt.
 */
const decidingProvider = (reply: (prompt: string) => string): ModelProvider & { prompts: string[] } => {
  const provider = {
    name: 'deciding',
    prompts: [] as string[],
    async generate(request: ProviderRequest): Promise<ProviderResponse> {
      const users = request.session.messages.filter((message) => message.role === 'user');
      const newest = users.at(-1);
      const prompt = users.map((message) => promptTextOf(message, { latest: message === newest })).join('\n');
      provider.prompts.push(prompt);
      const text = reply(prompt);
      return { parts: text.length > 0 ? [{ type: 'text', text }] : [] };
    },
  };
  return provider;
};

const at = new Date().toISOString();
const user = (content: string, extra: Partial<Message> = {}): Message => ({ id: `u-${content}`, role: 'user', content, createdAt: at, ...extra });

test('the marker is the one word both notes tell the model to answer with when it says nothing', () => {
  assert.equal(NO_REPLY_MARKER, 'NO_REPLY');
  assert.ok(REPLY_OPTIONAL_NOTE.includes(`reply with exactly ${NO_REPLY_MARKER} and nothing else`));
  assert.ok(UNADDRESSED_TURN_NOTE.includes(`reply with exactly ${NO_REPLY_MARKER} and nothing else`));
});

test('a reply-optional message is said to the agent, and only the newest is followed by the note', () => {
  const message = user('Blair: shipped it', { replyOptional: true });
  assert.equal(promptTextOf(message, { latest: true }), `Blair: shipped it\n\n${REPLY_OPTIONAL_NOTE}`);
  // Rendered again on a later turn, it is history: bare, as said.
  assert.equal(promptTextOf(message), 'Blair: shipped it');
  assert.equal(promptTextOf(user('Dylan: Ava, why?'), { latest: true }), 'Dylan: Ava, why?');
});

test('a turn may stay quiet when its message is overheard or reply-optional, and only then', () => {
  assert.equal(isReplyOptionalTurn({ messages: [user('a', { replyOptional: true })] }), true);
  assert.equal(isReplyOptionalTurn({ messages: [user('a', { overheard: true })] }), true);
  assert.equal(isReplyOptionalTurn({ messages: [user('a')] }), false);
  // The turn's message decides, not an older one, and not a message
  // steered into the turn.
  assert.equal(isReplyOptionalTurn({ messages: [user('a', { replyOptional: true }), user('b')] }), false);
  assert.equal(isReplyOptionalTurn({ messages: [user('a', { replyOptional: true }), user('b', { steered: true })] }), true);
  // Reply-optional is not unaddressed: it was said to the agent.
  assert.equal(isUnaddressedTurn({ messages: [user('a', { replyOptional: true })] }), false);
});

test('a reply-optional turn stores its flag, is told it may stay quiet, and the marker ends it with nothing to post', async () => {
  // Answers when the turn's own message (the one the note follows) asks.
  const provider = decidingProvider((prompt) => (prompt.includes(`question for you\n\n${REPLY_OPTIONAL_NOTE}`) ? 'Here you go.' : `  ${NO_REPLY_MARKER}\n`));
  const bus = new EventBus();
  const events: StratusEvent[] = [];
  bus.subscribe((event) => {
    events.push(event);
  });
  const runner = new AgentRunner({ provider, bus, store: new InMemorySessionStore() });

  const opened = await runner.run({ sessionId: 's', agent: AGENT, userMessage: 'Blair: report, all green', replyOptional: true });
  const first = opened.messages[0];
  assert.equal(first?.replyOptional, true);
  assert.equal(first?.overheard, undefined);
  assert.equal(provider.prompts[0], `Blair: report, all green\n\n${REPLY_OPTIONAL_NOTE}`);
  // The marker is stored as the silence an overheard turn leaves: an
  // empty assistant message, so no reader takes it for something said.
  assert.equal(opened.status, 'completed');
  assert.equal(latestTurnReply(opened), undefined);
  assert.deepEqual(opened.messages.map((message) => [message.role, message.content]), [
    ['user', 'Blair: report, all green'],
    ['assistant', ''],
  ]);
  assert.equal(events.some((event) => event.type === 'session.failed'), false);
  // Nothing downstream of the provider ever sees the marker as text.
  assert.equal(JSON.stringify(events).includes(NO_REPLY_MARKER), false);

  // Resumed reply-optional: flagged the same way, and it may still answer.
  const asked = await runner.resume({ sessionId: 's', userMessage: 'Dylan: a question for you', replyOptional: true });
  assert.equal(asked.messages.findLast((message) => message.role === 'user')?.replyOptional, true);
  assert.equal(latestTurnReply(asked), 'Here you go.');

  // A resumed reply-optional turn that stays quiet.
  const quiet = await runner.resume({ sessionId: 's', userMessage: 'Dylan: thanks', replyOptional: true });
  assert.equal(latestTurnReply(quiet), undefined);
  assert.equal(quiet.messages.at(-1)?.content, '');
});

test('an overheard turn that answers with the marker is silent too', async () => {
  const provider = decidingProvider(() => NO_REPLY_MARKER);
  const runner = new AgentRunner({ provider, bus: new EventBus(), store: new InMemorySessionStore() });
  const session = await runner.run({ sessionId: 's', agent: AGENT, userMessage: 'Dylan: Bea, thoughts?', addressed: false });
  assert.equal(session.status, 'completed');
  assert.equal(latestTurnReply(session), undefined);
  assert.equal(session.messages.at(-1)?.content, '');
});

test('the marker is only silence on a turn that may be silent, and only as the whole answer', async () => {
  // An addressed turn was never told the marker: what it says is posted
  // as said, rather than swallowing the answer a direct question is owed.
  const addressed = decidingProvider(() => NO_REPLY_MARKER);
  const runner = new AgentRunner({ provider: addressed, bus: new EventBus(), store: new InMemorySessionStore() });
  const asked = await runner.run({ sessionId: 'a', agent: AGENT, userMessage: 'Dylan: Ava?' });
  assert.equal(latestTurnReply(asked), NO_REPLY_MARKER);

  // On a reply-optional turn, the marker inside a sentence is a sentence.
  const sentence = `I'd normally say ${NO_REPLY_MARKER}, but this needs you.`;
  const talking = decidingProvider(() => sentence);
  const other = new AgentRunner({ provider: talking, bus: new EventBus(), store: new InMemorySessionStore() });
  const spoken = await other.run({ sessionId: 'b', agent: AGENT, userMessage: 'Blair: blocked on you', replyOptional: true });
  assert.equal(latestTurnReply(spoken), sentence);
});

test('reply-optional is ignored on a turn nobody asked for: the overheard frame already says it may be silent', async () => {
  const provider = decidingProvider(() => '');
  const runner = new AgentRunner({ provider, bus: new EventBus(), store: new InMemorySessionStore() });
  const session = await runner.run({ sessionId: 's', agent: AGENT, userMessage: 'Dylan: Bea, go', addressed: false, replyOptional: true });
  assert.equal(session.messages[0]?.overheard, true);
  assert.equal(session.messages[0]?.replyOptional, undefined);
  assert.equal(provider.prompts[0], `(overheard, not addressed to you)\n> Dylan: Bea, go\n\n${UNADDRESSED_TURN_NOTE}`);
});
