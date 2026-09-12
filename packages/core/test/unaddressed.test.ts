import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentRunner,
  EventBus,
  InMemorySessionStore,
  UNADDRESSED_TURN_NOTE,
  latestTurnReply,
  promptTextOf,
  type ModelProvider,
  type ProviderRequest,
  type ProviderResponse,
  type StratusEvent,
} from '../src/index.ts';

const AGENT = { id: 'ava', name: 'Ava' };

/**
 * Renders the turn the way a provider would — every user message through
 * `promptTextOf`, the newest marked — and answers with whatever the test
 * decided, so an empty reply can be a decision.
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

test('a turn dispatched unaddressed stores its message overheard, is told so, and may end in silence', async () => {
  const provider = decidingProvider((prompt) => (prompt.includes('Ava,') ? 'here' : ''));
  const bus = new EventBus();
  const events: StratusEvent[] = [];
  bus.subscribe((event) => {
    events.push(event);
  });
  const runner = new AgentRunner({ provider, bus, store: new InMemorySessionStore() });

  // A first turn nobody asked for: the opening message is overheard from
  // the first write, and the prompt ends on the note.
  const opened = await runner.run({ sessionId: 's', agent: AGENT, userMessage: 'Dylan: Bea, thoughts?', addressed: false });
  assert.equal(opened.messages[0]?.overheard, true);
  assert.equal(provider.prompts[0], `(overheard, not addressed to you)\n> Dylan: Bea, thoughts?\n\n${UNADDRESSED_TURN_NOTE}`);
  // It said nothing, and that is a completed turn with no reply — not a
  // failure, and not an answer either.
  assert.equal(opened.status, 'completed');
  assert.equal(latestTurnReply(opened), undefined);
  assert.equal(opened.messages.filter((message) => message.role === 'assistant').length, 0);
  assert.equal(events.some((event) => event.type === 'session.failed'), false);

  // A later unaddressed turn on the same session: marked the same way,
  // the note after it and not after the earlier overheard message.
  const again = await runner.resume({ sessionId: 's', userMessage: 'Bea: ship it', addressed: false });
  assert.equal(again.messages.at(-1)?.overheard, true);
  assert.equal(
    provider.prompts[1],
    [
      '(overheard, not addressed to you)\n> Dylan: Bea, thoughts?',
      `(overheard, not addressed to you)\n> Bea: ship it\n\n${UNADDRESSED_TURN_NOTE}`,
    ].join('\n'),
  );
  assert.equal(latestTurnReply(again), undefined);

  // Addressed — the default, and `true` spelled out — is what every turn
  // was before: bare, no mark, no note, and the history it follows is
  // still framed as what it was.
  const asked = await runner.resume({ sessionId: 's', userMessage: 'Dylan: Ava, and you?', addressed: true });
  assert.equal(asked.messages.at(-1)?.overheard, undefined);
  assert.ok(provider.prompts[2]?.endsWith('Dylan: Ava, and you?'));
  assert.equal(provider.prompts[2]?.includes(UNADDRESSED_TURN_NOTE), false);
  assert.equal(latestTurnReply(asked), 'here');
  const defaulted = await runner.resume({ sessionId: 's', userMessage: 'Dylan: Ava, once more' });
  assert.equal(defaulted.messages.at(-1)?.overheard, undefined);
});
