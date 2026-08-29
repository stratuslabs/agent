import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentRunner,
  InMemoryAgentMemoryStore,
  MEMORY_ENTRY_MAX_BYTES,
  MEMORY_INJECTION_LIMIT,
  ToolRegistry,
  renderSystemPrompt,
  type ModelProvider,
  type ProviderRequest,
  type Session,
} from '@stratusagent/core';
import {
  createAgentTeam,
  createForgetTool,
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

  const empty = await recall.execute({ query: 'anything at all' }, sessionFor('ava')) as { results: unknown[]; truncated: boolean };
  assert.deepEqual(empty, { results: [], truncated: false });

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

test('turn injection is a bounded recent slice, and a forgotten entry never reaches the prompt', async () => {
  // A ticking clock: appends in one loop share a real millisecond, and the
  // point here is recency selection, not the tie-break.
  let tick = 0;
  const memory = new InMemoryAgentMemoryStore({ now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, (tick += 1))) });
  const agent = defineAgent({ name: 'Juno Mercer', tools: ['memory.*'] });
  for (let i = 0; i < MEMORY_INJECTION_LIMIT + 5; i += 1) {
    await memory.append(agent.id, `numbered fact ${i}`);
  }
  const dropped = await memory.append(agent.id, 'the regrettable fact about pineapples');

  const prompts: string[] = [];
  const injected: string[][] = [];
  const provider: ModelProvider = {
    name: 'prompt-capture',
    async generate(request: ProviderRequest) {
      prompts.push(renderSystemPrompt(request) ?? '');
      injected.push((request.memory ?? []).map((entry) => entry.content));
      return { parts: [{ type: 'text', text: 'ok' }] };
    },
  };
  const tools = new ToolRegistry();
  tools.register(createRememberTool(memory));
  tools.register(createRecallTool(memory));
  tools.register(createForgetTool(memory));
  const runner = new AgentRunner({ provider, tools, memory, agents: createAgentTeam([agent]) });

  await runner.run({ sessionId: 's-before', agent, userMessage: 'hi' });
  assert.equal(injected[0]?.length, MEMORY_INJECTION_LIMIT, 'the prompt carries the bounded slice, not the store');
  assert.match(prompts[0] ?? '', /pineapples/, 'the newest entry is in the slice');
  assert.ok(!injected[0]?.includes('numbered fact 0'), 'the oldest entries arrive via recall instead');

  await memory.forget(agent.id, dropped.id);
  await runner.run({ sessionId: 's-after', agent, userMessage: 'hi again' });
  // Asserted against the injected prompt itself, not recall alone — the
  // prompt path is the half a search-only forget would have missed.
  assert.doesNotMatch(prompts[1] ?? '', /pineapples/);
  assert.equal(injected[1]?.length, MEMORY_INJECTION_LIMIT, 'the slice refills from live entries');
});
