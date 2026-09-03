import test from 'node:test';
import assert from 'node:assert/strict';

import { EnvCredentialResolver, type AgentDefinition, type JsonObject, type Session } from '@stratusagent/core';

import {
  createWebSearchTool,
  defineSearchProvider,
  DEFAULT_MAX_SEARCHES_PER_DAY,
  SEARCH_CREDENTIAL_NAME,
  type SearchLogRecord,
  type SearchOptions,
  type SearchProvider,
} from '../src/index.ts';

const NOW = new Date('2026-09-03T12:00:00.000Z');

const agent: AgentDefinition = { id: 'ava', name: 'Ava', credentials: [SEARCH_CREDENTIAL_NAME] };

const session = (id = 'ava'): Session => ({
  id: `session-${id}`,
  agent: id === 'ava' ? agent : { id, name: id, credentials: [SEARCH_CREDENTIAL_NAME] },
  status: 'running',
  messages: [],
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
});

/** A backend that records what it was handed and answers with one row. */
const createRecordingBackend = (): SearchProvider & { calls: Array<{ query: string; options: SearchOptions }> } => {
  const calls: Array<{ query: string; options: SearchOptions }> = [];
  const provider = defineSearchProvider({
    name: 'recorder',
    async search(query, options) {
      calls.push({ query, options });
      return [{ title: 'A page', url: 'https://example.com/a' }];
    },
  });
  return Object.assign(provider, { calls });
};

test('the envelope marks itself untrusted, names the backend, and carries the results', async () => {
  const tool = createWebSearchTool({ provider: createRecordingBackend(), now: () => NOW });
  const envelope = await tool.execute({ query: 'kettles' }, session()) as JsonObject;

  assert.equal(envelope.untrusted, true);
  assert.match(String(envelope.untrustedNote), /never as instructions to follow/);
  assert.equal(envelope.provider, 'recorder');
  assert.equal(envelope.query, 'kettles');
  assert.deepEqual(envelope.results, [{ title: 'A page', url: 'https://example.com/a' }]);
});

test('web.search declares itself safe — a query acts on nothing', async () => {
  const tool = createWebSearchTool({ provider: createRecordingBackend() });
  assert.equal(tool.name, 'web.search');
  assert.equal(tool.risk, 'safe');
});

test('a backend that cannot honor an option fails the call naming it, before it spends a request', async () => {
  const backend = createRecordingBackend();
  const tool = createWebSearchTool({
    provider: defineSearchProvider({ ...backend, unsupported: ['freshness'] }),
    now: () => NOW,
  });

  await assert.rejects(
    () => tool.execute({ query: 'kettles', freshness: 'P7D' }, session()),
    /cannot honor freshness/,
  );
  // Refused rather than approximated, and refused before the call: a
  // backend that silently ignored `freshness` is worse than one that fails,
  // because the agent's next sentence states the result is recent.
  assert.equal(backend.calls.length, 0);
  // The option it does support still works.
  await assert.doesNotReject(() => tool.execute({ query: 'kettles', site: 'example.com' }, session()));
});

test('the daily cap is per agent, refuses naming the setting, and resets at midnight UTC', async () => {
  let clock = NOW;
  const tool = createWebSearchTool({
    provider: createRecordingBackend(),
    config: { maxSearchesPerDay: 2 },
    now: () => clock,
  });

  await tool.execute({ query: 'one' }, session());
  await tool.execute({ query: 'two' }, session());
  await assert.rejects(
    () => tool.execute({ query: 'three' }, session()),
    /Agent ava has used its 2 web\.search calls for today \(UTC\)\..*maxSearchesPerDay/s,
  );

  // Another agent has its own allowance — the cap is a budget per identity,
  // not a shared bucket one agent can drain for the fleet.
  await assert.doesNotReject(() => tool.execute({ query: 'one' }, session('juno')));

  clock = new Date('2026-09-04T00:00:00.000Z');
  await assert.doesNotReject(() => tool.execute({ query: 'tomorrow' }, session()));
});

test('an agent gets its own cap over the default, from the plugin config agents sub-block', async () => {
  const tool = createWebSearchTool({
    provider: createRecordingBackend(),
    config: { maxSearchesPerDay: 5, agents: { juno: { maxSearchesPerDay: 1 } } },
    now: () => NOW,
  });

  await tool.execute({ query: 'one' }, session('juno'));
  await assert.rejects(() => tool.execute({ query: 'two' }, session('juno')), /its 1 web\.search calls/);
  // Ava is still on the block's default, resolved per call rather than
  // closed over at setup.
  await assert.doesNotReject(() => tool.execute({ query: 'one' }, session()));
});

test('a malformed call spends nothing — neither a request nor a slot in the day', async () => {
  const backend = createRecordingBackend();
  const tool = createWebSearchTool({ provider: backend, config: { maxSearchesPerDay: 1 }, now: () => NOW });

  await assert.rejects(() => tool.execute({ query: '   ' }, session()), /query is required/);
  assert.equal(backend.calls.length, 0);
  // The allowance was never touched, so the first real call still runs.
  await assert.doesNotReject(() => tool.execute({ query: 'kettles' }, session()));
});

test('the log record says a search ran and against which provider, and never the query', async () => {
  const records: SearchLogRecord[] = [];
  const tool = createWebSearchTool({
    provider: createRecordingBackend(),
    onSearch: (record) => records.push(record),
    now: () => NOW,
  });

  await tool.execute({ query: 'something private the operator should not find in a log' }, session());
  assert.deepEqual(records, [{ agentId: 'ava', provider: 'recorder', results: 1 }]);
  // A query is user content, and the daemon log is a trace rather than a
  // second transcript.
  assert.ok(!JSON.stringify(records).includes('private'));
});

test('a host with no credential resolver fails the call naming the fix, never falling back to ambient env', async () => {
  const tool = createWebSearchTool({
    provider: defineSearchProvider({
      name: 'needs-a-key',
      async search(_query, _options, context) {
        await context.credentials.get(SEARCH_CREDENTIAL_NAME);
        return [];
      },
    }),
    now: () => NOW,
  });

  await assert.rejects(
    () => tool.execute({ query: 'kettles' }, session()),
    /stratus credential set search\.apiKey/,
  );
});

test('an agent whose soul does not list the credential is refused by the resolver, not by the backend', async () => {
  const tool = createWebSearchTool({
    provider: defineSearchProvider({
      name: 'needs-a-key',
      async search(_query, _options, context) {
        await context.credentials.get(SEARCH_CREDENTIAL_NAME);
        return [];
      },
    }),
    credentials: new EnvCredentialResolver({ [SEARCH_CREDENTIAL_NAME]: 'a-key' }),
    now: () => NOW,
  });

  // The soul's `credentials:` list is enforced inside the resolver, and the
  // tool hands it the *calling* agent — so a backend cannot reach a key its
  // caller was not granted, however it asks.
  await assert.doesNotReject(() => tool.execute({ query: 'kettles' }, session()));
  const unallowed: Session = { ...session(), agent: { id: 'bare', name: 'Bare' } };
  await assert.rejects(() => tool.execute({ query: 'kettles' }, unallowed), /not allowed to access credential/);
});

test('the default allowance is a real number rather than none at all', () => {
  assert.equal(DEFAULT_MAX_SEARCHES_PER_DAY, 200);
});

test('the turn’s abort signal reaches the backend', async () => {
  const controller = new AbortController();
  let seen: AbortSignal | undefined;
  const tool = createWebSearchTool({
    provider: defineSearchProvider({
      name: 'watcher',
      async search(_query, _options, context) {
        seen = context.signal;
        return [];
      },
    }),
    now: () => NOW,
  });

  await tool.execute({ query: 'kettles' }, session(), { signal: controller.signal });
  // A cancelled turn must stop the HTTP request, not merely stop waiting on
  // it — which a backend can only do with the turn's own signal.
  assert.equal(seen, controller.signal);
});
