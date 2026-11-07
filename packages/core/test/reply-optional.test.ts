import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentRunner,
  EventBus,
  InMemorySessionStore,
  NO_REPLY_MARKER,
  REPLY_OPTIONAL_NOTE,
  SILENT_REACTIONS,
  UNADDRESSED_TURN_NOTE,
  isNoReplyAnswer,
  isReplyOptionalTurn,
  isUnaddressedTurn,
  latestTurnReaction,
  latestTurnReply,
  noReplyAnswerOf,
  promptTextOf,
  turnReactionFor,
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

test('the reply-optional note opens on answering, and says a question or request from anyone gets one', () => {
  // A wording that opened on "This may not need an answer" had models skip
  // questions, a teammate agent's most of all (live check, card 601).
  assert.match(REPLY_OPTIONAL_NOTE, /^This message was said to you\. Answer it as you normally would/);
  assert.ok(REPLY_OPTIONAL_NOTE.includes('a question or a request always gets an answer, whether a person or an agent sent it'));
  assert.ok(REPLY_OPTIONAL_NOTE.indexOf('answer') < REPLY_OPTIONAL_NOTE.indexOf(NO_REPLY_MARKER));
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

const said = (text: string): Pick<ProviderResponse, 'parts'> => ({ parts: [{ type: 'text', text }] });

test('a silent answer may name one reaction from the fixed set, and anything else stays plain silence', () => {
  assert.deepEqual([...SILENT_REACTIONS], ['thumbsup', 'laughing', 'heart', 'tada']);
  assert.deepEqual(noReplyAnswerOf(said(NO_REPLY_MARKER)), {});
  assert.deepEqual(noReplyAnswerOf(said('NO_REPLY thumbsup')), { reaction: 'thumbsup' });
  assert.deepEqual(noReplyAnswerOf(said('  NO_REPLY :tada:\n')), { reaction: 'tada' });
  assert.deepEqual(noReplyAnswerOf(said('NO_REPLY Heart')), { reaction: 'heart' });
  // Slack's own name for the thumbs up.
  assert.deepEqual(noReplyAnswerOf(said('NO_REPLY +1')), { reaction: 'thumbsup' });
  assert.deepEqual(noReplyAnswerOf(said('NO_REPLY :laughing:')), { reaction: 'laughing' });
  // Out of the set on purpose: a silent turn must not promise work that
  // never follows. Still silence: the word is never posted as text.
  assert.deepEqual(noReplyAnswerOf(said('NO_REPLY eyes')), {});
  assert.deepEqual(noReplyAnswerOf(said('NO_REPLY :thinking_face:')), {});
  // A sentence is a sentence, and the marker is the marker as written.
  assert.equal(noReplyAnswerOf(said('NO_REPLY thanks for the update')), undefined);
  assert.equal(noReplyAnswerOf(said('NO_REPLY, thumbsup')), undefined);
  assert.equal(noReplyAnswerOf(said('no_reply thumbsup')), undefined);
  assert.equal(noReplyAnswerOf(said('NO_REPLYthumbsup')), undefined);
  assert.equal(noReplyAnswerOf({ parts: [] }), undefined);
  assert.equal(
    noReplyAnswerOf({ parts: [{ type: 'text', text: 'NO_REPLY tada' }, { type: 'tool-call', call: { id: 'c', toolName: 'fs.read', input: {} } }] }),
    undefined,
  );
  // The older test reads the same rule.
  assert.equal(isNoReplyAnswer(said('NO_REPLY tada')), true);
  assert.equal(isNoReplyAnswer(said('NO_REPLY thanks for the update')), false);
});

test('the reply-optional note offers the reactions after the marker, and still opens on answering', () => {
  assert.match(REPLY_OPTIONAL_NOTE, /^This message was said to you\. Answer it as you normally would/);
  assert.ok(REPLY_OPTIONAL_NOTE.includes('thumbsup, laughing, heart or tada'));
  assert.ok(REPLY_OPTIONAL_NOTE.includes(`as in ${NO_REPLY_MARKER} thumbsup`));
  // Only the reply-optional note: a turn nobody asked for gets no reaction.
  assert.equal(UNADDRESSED_TURN_NOTE.includes('thumbsup'), false);
});

test('a reply-optional turn that answers the marker with a reaction stores it on its silence, durably', async () => {
  const provider = decidingProvider((prompt) => (prompt.includes(`question for you\n\n${REPLY_OPTIONAL_NOTE}`) ? 'Here you go.' : 'NO_REPLY tada'));
  const bus = new EventBus();
  const events: StratusEvent[] = [];
  bus.subscribe((event) => {
    events.push(event);
  });
  const store = new InMemorySessionStore();
  const runner = new AgentRunner({ provider, bus, store });

  const shipped = await runner.run({ sessionId: 's', agent: AGENT, userMessage: 'Blair: shipped it', replyOptional: true, idempotencyKey: 'k1' });
  assert.equal(shipped.status, 'completed');
  assert.equal(latestTurnReply(shipped), undefined);
  assert.equal(latestTurnReaction(shipped), 'tada');
  assert.deepEqual(shipped.messages.at(-1), { ...shipped.messages.at(-1), role: 'assistant', content: '', reaction: 'tada' });
  assert.equal((await store.get('s'))?.messages.at(-1)?.reaction, 'tada');
  assert.equal(JSON.stringify(events).includes(NO_REPLY_MARKER), false);

  // A later turn that answers has no reaction, and the keyed turn keeps its own.
  const asked = await runner.resume({ sessionId: 's', userMessage: 'Dylan: a question for you', replyOptional: true, idempotencyKey: 'k2' });
  assert.equal(latestTurnReply(asked), 'Here you go.');
  assert.equal(latestTurnReaction(asked), undefined);
  assert.equal(turnReactionFor(asked, 'k1'), 'tada');
  assert.equal(turnReactionFor(asked, 'k2'), undefined);
  assert.equal(turnReactionFor(asked, 'nope'), undefined);
});

test('a reaction outside the set, or on a turn nobody asked for, is plain silence with nothing stored', async () => {
  const unknown = new AgentRunner({ provider: decidingProvider(() => 'NO_REPLY eyes'), bus: new EventBus(), store: new InMemorySessionStore() });
  const looked = await unknown.run({ sessionId: 'a', agent: AGENT, userMessage: 'Blair: fyi', replyOptional: true });
  assert.equal(looked.status, 'completed');
  assert.equal(latestTurnReply(looked), undefined);
  assert.equal(latestTurnReaction(looked), undefined);
  assert.equal('reaction' in (looked.messages.at(-1) ?? {}), false);

  // Card 1078 covers messages said to the agent; overheard chatter gets none.
  const overheard = new AgentRunner({ provider: decidingProvider(() => 'NO_REPLY thumbsup'), bus: new EventBus(), store: new InMemorySessionStore() });
  const heard = await overheard.run({ sessionId: 'b', agent: AGENT, userMessage: 'Dylan: Bea, nice', addressed: false });
  assert.equal(latestTurnReply(heard), undefined);
  assert.equal(latestTurnReaction(heard), undefined);

  // An addressed turn was never offered one: what it says is posted as said.
  const addressed = new AgentRunner({ provider: decidingProvider(() => 'NO_REPLY thumbsup'), bus: new EventBus(), store: new InMemorySessionStore() });
  const asked = await addressed.run({ sessionId: 'c', agent: AGENT, userMessage: 'Dylan: Ava?' });
  assert.equal(latestTurnReply(asked), 'NO_REPLY thumbsup');
  assert.equal(latestTurnReaction(asked), undefined);
});
