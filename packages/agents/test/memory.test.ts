import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentRunner,
  InMemoryAgentMemoryStore,
  MEMORY_ENTRY_MAX_BYTES,
  MEMORY_PINNED_MAX_BYTES,
  MEMORY_RECENCY_INJECTION_LIMIT,
  memoryInjectionEntries,
  ToolRegistry,
  renderSystemPrompt,
  type ModelProvider,
  type ProviderRequest,
  type Session,
} from '@stratusagent/core';
import {
  createAgentTeam,
  createForgetTool,
  createPinTool,
  createRecallTool,
  createRememberTool,
  defineAgent,
} from '../src/index.ts';

const sessionFor = (agentId: string): Session =>
  ({ id: 'session-1', agent: { id: agentId, name: 'Test' }, messages: [], status: 'running' }) as unknown as Session;

test('memory.recall searches the calling agent’s store; nothing learned yet is a result, not an error', async () => {
  const store = new InMemoryAgentMemoryStore();
  const recall = createRecallTool(store);
  assert.equal(recall.risk, 'safe');

  const empty = await recall.execute({ query: 'anything at all' }, sessionFor('ava')) as { results: unknown[]; truncated: boolean; strategy: string };
  // The ordering the store served comes back even on an empty result: a
  // caller cannot tell a store that ranked by relevance from one that fell
  // back to recency unless every result says which it was.
  assert.deepEqual(empty, { results: [], truncated: false, strategy: 'recency' });

  await store.append('ava', 'the deploy runs from the blue runner');
  await store.append('scout', 'the deploy runs from the red runner');
  const found = await recall.execute({ query: 'deploy runner' }, sessionFor('ava')) as { results: { id: string; content: string }[] };
  assert.equal(found.results.length, 1);
  assert.match(found.results[0]?.content ?? '', /blue/);
});

test('memory.forget retires the agent’s own entry and refuses ids that are not its to forget', async () => {
  const store = new InMemoryAgentMemoryStore();
  const forget = createForgetTool(store);
  assert.equal(forget.risk, 'safe');

  const mine = await store.append('ava', 'a fact to drop');
  const theirs = await store.append('scout', 'a fact to keep');

  await assert.rejects(() => forget.execute({ id: theirs.id }, sessionFor('ava')), /nothing was forgotten/);
  const result = await forget.execute({ id: mine.id }, sessionFor('ava'));
  assert.deepEqual(result, { forgotten: true, id: mine.id });
  // Tombstoned, not deleted: the audit read still has it.
  assert.ok((await store.audit('ava')).find((entry) => entry.id === mine.id)?.forgottenAt);
});

test('memory.remember refuses an over-cap fact and stores nothing', async () => {
  const store = new InMemoryAgentMemoryStore();
  const remember = createRememberTool(store);
  // Headless mode runs only `safe` calls, and an unattended agent that
  // cannot record what it learned does not learn: this assertion fails
  // loudly if anyone reclassifies the memory tools.
  assert.equal(remember.risk, 'safe');
  await assert.rejects(
    () => remember.execute({ fact: 'x'.repeat(MEMORY_ENTRY_MAX_BYTES + 1) }, sessionFor('ava')),
    /capped at \d+ UTF-8 bytes/,
  );
  assert.deepEqual((await store.list('ava')).entries, []);
});

test('the recency tail is bounded, and a forgotten entry never reaches the prompt', async () => {
  // A ticking clock: appends in one loop share a real millisecond, and the
  // point here is recency selection, not the tie-break.
  let tick = 0;
  const memory = new InMemoryAgentMemoryStore({ now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, (tick += 1))) });
  const agent = defineAgent({ name: 'Juno Mercer', tools: ['memory.*'] });
  for (let i = 0; i < MEMORY_RECENCY_INJECTION_LIMIT + 5; i += 1) {
    await memory.append(agent.id, `numbered fact ${i}`);
  }
  const dropped = await memory.append(agent.id, 'the regrettable fact about pineapples');

  const prompts: string[] = [];
  const injected: string[][] = [];
  const provider: ModelProvider = {
    name: 'prompt-capture',
    async generate(request: ProviderRequest) {
      prompts.push(renderSystemPrompt(request) ?? '');
      injected.push(memoryInjectionEntries(request.memory).map((entry) => entry.content));
      return { parts: [{ type: 'text', text: 'ok' }] };
    },
  };
  const tools = new ToolRegistry();
  tools.register(createRememberTool(memory));
  tools.register(createRecallTool(memory));
  tools.register(createForgetTool(memory));
  const runner = new AgentRunner({ provider, tools, memory, agents: createAgentTeam([agent]) });

  await runner.run({ sessionId: 's-before', agent, userMessage: 'hi' });
  assert.equal(injected[0]?.length, MEMORY_RECENCY_INJECTION_LIMIT, 'the prompt carries the bounded slice, not the store');
  assert.match(prompts[0] ?? '', /pineapples/, 'the newest entry is in the slice');
  assert.ok(!injected[0]?.includes('numbered fact 0'), 'the oldest entries arrive via recall instead');

  await memory.forget(agent.id, dropped.id);
  await runner.run({ sessionId: 's-after', agent, userMessage: 'hi again' });
  // Asserted against the injected prompt itself, not recall alone — the
  // prompt path is the half a search-only forget would have missed.
  assert.doesNotMatch(prompts[1] ?? '', /pineapples/);
  assert.equal(injected[1]?.length, MEMORY_RECENCY_INJECTION_LIMIT, 'the slice refills from live entries');
});

test('memory.remember carries the wider shape, and refuses a supersession that is not the agent’s to make', async () => {
  const at = new Date('2026-06-01T00:00:00.000Z');
  const store = new InMemoryAgentMemoryStore({ now: () => at });
  const remember = createRememberTool(store);

  const written = await remember.execute({
    fact: 'The deploy pipeline runs on Postgres.',
    kind: 'semantic',
    about: ['deploy pipeline', 'Hermes'],
    validFrom: '2026-06-01T00:00:00Z',
  }, sessionFor('ava')) as { id: string };
  const stored = (await store.list('ava')).entries[0]!;
  assert.equal(stored.kind, 'semantic');
  assert.deepEqual(stored.about, ['deploy pipeline', 'Hermes']);
  assert.equal(stored.validFrom, '2026-06-01T00:00:00.000Z');

  // A bound the model wrote as prose is refused rather than dropped: an
  // unbounded fact that was meant to expire is the worse outcome.
  await assert.rejects(
    () => remember.execute({ fact: 'x', validUntil: 'next Tuesday' }, sessionFor('ava')),
    /must be an ISO-8601 instant/,
  );
  await assert.rejects(() => remember.execute({ fact: 'x', kind: 'trivia' }, sessionFor('ava')), /"kind" must be one of/);
  // A window that closes before it opens describes nothing: the entry
  // would be not-yet-valid, then expired, and never reach a prompt —
  // stored, findable, and silently inert.
  await assert.rejects(
    () => remember.execute({
      fact: 'x',
      validFrom: '2026-09-01T00:00:00Z',
      validUntil: '2026-08-01T00:00:00Z',
    }, sessionFor('ava')),
    /must be after validFrom/,
  );
  await assert.rejects(
    () => remember.execute({
      fact: 'x',
      validFrom: '2026-09-01T00:00:00Z',
      validUntil: '2026-09-01T00:00:00Z',
    }, sessionFor('ava')),
    /must be after validFrom/,
  );
  await assert.rejects(() => remember.execute({ fact: 'x', about: 'deploy' }, sessionFor('ava')), /array of entity names/);

  // Superseding the agent's own entry works and is reported; another
  // agent's is refused, and the victim's entry stays live.
  const victim = await store.append('juno', 'Juno keeps the rota');
  const revision = await remember.execute({
    fact: 'The deploy pipeline runs on CockroachDB.',
    supersedes: written.id,
  }, sessionFor('ava')) as { supersedes?: string };
  assert.equal(revision.supersedes, written.id);
  assert.deepEqual((await store.list('ava')).entries.map((entry) => entry.content), ['The deploy pipeline runs on CockroachDB.']);
  await assert.rejects(
    () => remember.execute({ fact: 'not mine', supersedes: victim.id }, sessionFor('ava')),
    /belongs to this agent/,
  );
  assert.deepEqual((await store.list('juno')).entries.map((entry) => entry.id), [victim.id]);
});

test('a memory.recall hit that is out of window comes back marked as such', async () => {
  const at = new Date('2026-06-01T00:00:00.000Z');
  const store = new InMemoryAgentMemoryStore({ now: () => at });
  await store.append('ava', 'Ada works at Northwind', { about: ['Ada'], validUntil: '2026-02-01T00:00:00.000Z' });
  await store.append('ava', 'Ada works at Contoso', { about: ['Ada'], validFrom: '2026-09-01T00:00:00.000Z' });
  await store.append('ava', 'Ada lives in Leeds', { about: ['Ada'] });

  const recall = createRecallTool(store, { now: () => at });
  const found = await recall.execute({ query: 'Ada' }, sessionFor('ava')) as {
    results: { content: string; validity: string }[];
    strategy: string;
  };
  // Keeping an out-of-window entry findable is right; returning it
  // *unmarked* is not — an expired fact that reads exactly like a current
  // one is the confusion the two fields exist to prevent.
  assert.deepEqual(
    Object.fromEntries(found.results.map((result) => [result.content, result.validity])),
    {
      'Ada works at Northwind': 'expired',
      'Ada works at Contoso': 'not-yet-valid',
      'Ada lives in Leeds': 'current',
    },
  );
  assert.equal(found.strategy, 'recency');
  // The alias case: the query matches only the `about` key.
  const aliased = await recall.execute({ query: 'Ada' }, sessionFor('ava')) as { results: unknown[] };
  assert.equal(aliased.results.length, 3);
});

test('memory.pin is safe, records rather than rewrites, and reports a refusal instead of throwing', async () => {
  const at = new Date('2026-06-01T00:00:00.000Z');
  const store = new InMemoryAgentMemoryStore({ now: () => at });
  const pin = createPinTool(store);
  assert.equal(pin.risk, 'safe');

  const held = await store.append('ava', 'a'.repeat(MEMORY_PINNED_MAX_BYTES - 100));
  const extra = await store.append('ava', 'b'.repeat(200));
  assert.deepEqual(await pin.execute({ id: held.id }, sessionFor('ava')), {
    pinned: true,
    id: held.id,
    bytes: MEMORY_PINNED_MAX_BYTES - 100,
  });

  // The cap is a full budget, not a failure: the agent's next move is to
  // unpin something, and a thrown error would read as a broken tool.
  const refused = await pin.execute({ id: extra.id }, sessionFor('ava')) as { pinned: boolean; reason: string };
  assert.equal(refused.pinned, false);
  assert.match(refused.reason, /capped at/);
  assert.deepEqual((await store.pinned!('ava')).map((entry) => entry.id), [held.id]);

  assert.deepEqual(await pin.execute({ id: held.id, unpin: true }, sessionFor('ava')), { pinned: false, id: held.id });
  await assert.rejects(() => pin.execute({ id: held.id, unpin: true }, sessionFor('ava')), /nothing was unpinned/);

  // And an agent cannot pin what is not its own.
  const victim = await store.append('juno', 'Juno keeps the rota');
  await assert.rejects(() => pin.execute({ id: victim.id }, sessionFor('ava')), /belongs to this agent/);
  assert.deepEqual(await store.pinned!('juno'), []);
});
