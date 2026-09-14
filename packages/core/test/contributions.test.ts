import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ChannelRegistry,
  ContributionRegistry,
  InMemoryAgentMemoryStore,
  createRoutedMemoryStore,
  type AgentMemoryStore,
  type ChannelContribution,
} from '../src/index.ts';

const fakeAdapter = (name: string): ChannelContribution['adapter'] => ({
  name,
  async start() {},
  async stop() {},
});

test('a routed memory store asks which store serves an agent on every call, not once', async () => {
  const stores = new Map<string, AgentMemoryStore>();
  const routed = createRoutedMemoryStore((agentId) => {
    let store = stores.get(agentId);
    if (!store) {
      store = new InMemoryAgentMemoryStore();
      stores.set(agentId, store);
    }
    return store;
  });

  await routed.append('ava', 'ava remembers the staging box');
  await routed.append('juno', 'juno remembers the release branch');

  // Two agents, two stores: neither observes the other's entries, and the
  // routing happened per call rather than being fixed by whoever called first.
  assert.equal(stores.size, 2);
  assert.deepEqual((await routed.list('ava')).entries.map((entry) => entry.content), ['ava remembers the staging box']);
  assert.deepEqual((await routed.search('juno', 'release')).entries.length, 1);
  assert.deepEqual((await routed.search('ava', 'release')).entries.length, 0);
});

test('a routed memory store forwards reassertTrust only when the chosen store has it', async () => {
  const bare: AgentMemoryStore = {
    async append(agentId, content) {
      return { id: 'x', agentId, content, createdAt: new Date().toISOString() };
    },
    async list() {
      return { entries: [], truncated: false };
    },
    async search() {
      return { entries: [], truncated: false };
    },
    async forget() {
      return false;
    },
    async audit() {
      return [];
    },
  };
  const routed = createRoutedMemoryStore(() => bare);
  assert.equal(await routed.reassertTrust?.('ava', 'x', 'user'), false);
});

test('a channel registry claims (agent, kind) pairs, so one agent on two kinds is not a claim twice', () => {
  const registry = new ChannelRegistry();
  registry.register({ adapter: fakeAdapter('slack'), agents: ['ava', 'juno'] });
  registry.register({ adapter: fakeAdapter('discord'), agents: ['ava'] });

  assert.equal(registry.claimed('slack', 'ava'), true);
  assert.equal(registry.claimed('discord', 'ava'), true);
  assert.equal(registry.claimed('discord', 'juno'), false);
  assert.deepEqual(registry.list().map((entry) => entry.adapter.name), ['slack', 'discord']);
});

test('a contribution registry is a bare map: it refuses nothing, and the view is what refuses', () => {
  const registry = new ContributionRegistry<{ name: string }>();
  registry.register('fixture', { name: 'first' });
  registry.register('fixture', { name: 'second' });
  assert.deepEqual(registry.names(), ['fixture']);
  assert.equal(registry.get('fixture')?.name, 'second');
});

test('a channel registry lets the host claim pairs its own adapters carry, and a claim is a claim', () => {
  const registry = new ChannelRegistry();
  registry.claim('slack', ['ava', 'juno']);
  assert.equal(registry.claimed('slack', 'ava'), true);
  assert.equal(registry.claimed('slack', 'bea'), false);
  // Host claims are not contributions: nothing is listed for a host to start twice.
  assert.deepEqual(registry.list(), []);
});
