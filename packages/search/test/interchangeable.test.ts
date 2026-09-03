import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EnvCredentialResolver,
  ToolRegistry,
  type AgentDefinition,
  type JsonObject,
  type Session,
  type Tool,
} from '@stratusagent/core';

import { createWebSearchTool, SEARCH_CREDENTIAL_NAME, type SearchProvider } from '../src/index.ts';
import { createLumenBackend, createOrbitBackend, startVendor, type VendorRow } from './backends.ts';

/**
 * The whole point of the step, as a test: one option suite, two backends
 * written by different hands, answers that mean the same thing.
 *
 * Everything below runs twice — once against a metered backend behind a key
 * that filters natively, once against a key-free self-hosted one that
 * filters not at all — and asserts the *same* answer. A version of this
 * step that shipped one backend and never ran the second would not have met
 * its own criterion.
 */

const NOW = new Date('2026-09-03T12:00:00.000Z');

const sessionFor = (agent: AgentDefinition): Session => ({
  id: `session-${agent.id}`,
  agent,
  status: 'running',
  messages: [],
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
});

const ava: AgentDefinition = { id: 'ava', name: 'Ava', credentials: [SEARCH_CREDENTIAL_NAME] };

/** One page of vendor rows, spelled the way each vendor spells them. */
const ROWS = [
  {
    title: 'Kettles, reviewed',
    url: 'https://docs.example.com/kettles',
    description: 'The <strong>kettle</strong>   guide.',
    content: 'The <strong>kettle</strong>   guide.',
    page_age: '2026-09-01T09:00:00Z',
    publishedDate: '2026-09-01T09:00:00Z',
  },
  {
    title: 'A lookalike',
    url: 'https://notexample.com/kettles',
    description: 'Not the same company.',
    content: 'Not the same company.',
    page_age: '2026-09-02T09:00:00Z',
    publishedDate: '2026-09-02T09:00:00Z',
  },
  {
    title: 'An old page',
    url: 'https://example.com/2019',
    description: 'Seven years ago.',
    content: 'Seven years ago.',
    page_age: '2019-01-01T00:00:00Z',
    publishedDate: '2019-01-01T00:00:00Z',
  },
  {
    title: 'An undated page',
    url: 'https://example.com/undated',
    description: 'No date anywhere.',
    content: 'No date anywhere.',
  },
  {
    title: 'A fresh page',
    url: 'https://example.com/fresh',
    description: 'Yesterday.',
    content: 'Yesterday.',
    page_age: '2026-09-02T18:00:00Z',
    publishedDate: '2026-09-02T18:00:00Z',
  },
] satisfies VendorRow[];

/**
 * The two backends, each behind its own vendor endpoint, as the same tool.
 *
 * `allowedHosts` is what lets either reach loopback at all — see the
 * refusal test at the bottom, which is the same configuration minus that
 * one line.
 */
const backends = async (
  t: { after(fn: () => Promise<void> | void): void },
  rows: readonly VendorRow[] = ROWS,
): Promise<Array<{ name: string; tool: Tool; requests: string[]; tokens: string[] }>> => {
  const orbit = await startVendor(() => ({ web: { results: rows } }));
  const lumen = await startVendor(() => ({ results: rows }));
  t.after(() => orbit.close());
  t.after(() => lumen.close());

  const resolver = new EnvCredentialResolver({ [SEARCH_CREDENTIAL_NAME]: 'orbit-key' });
  const config: JsonObject = { allowedHosts: ['127.0.0.1'] };
  const build = (provider: SearchProvider): Tool =>
    createWebSearchTool({ provider, config, credentials: resolver, now: () => NOW });

  return [
    { name: 'orbit', tool: build(createOrbitBackend(orbit.origin)), requests: orbit.requests, tokens: orbit.tokens },
    { name: 'lumen', tool: build(createLumenBackend(lumen.origin)), requests: lumen.requests, tokens: lumen.tokens },
  ];
};

const run = async (tool: Tool, input: JsonObject): Promise<JsonObject> =>
  await tool.execute(input, sessionFor(ava)) as JsonObject;

const titles = (envelope: JsonObject): string[] =>
  (envelope.results as Array<{ title: string }>).map((entry) => entry.title);

test('count is a maximum on both backends, and both truncate to it', async (t) => {
  for (const backend of await backends(t)) {
    const envelope = await run(backend.tool, { query: 'kettles', count: 2 });
    assert.equal((envelope.results as unknown[]).length, 2, `${backend.name} returned more than count`);
  }
});

test('site matches on label boundaries, excluding the lookalike parent domain, on both backends', async (t) => {
  for (const backend of await backends(t)) {
    const envelope = await run(backend.tool, { query: 'kettles', site: 'example.com' });
    // `docs.example.com` is inside it; `notexample.com` ends with the same
    // characters and is a different company.
    assert.ok(titles(envelope).includes('Kettles, reviewed'), `${backend.name} dropped a subdomain match`);
    assert.ok(!titles(envelope).includes('A lookalike'), `${backend.name} kept notexample.com`);
  }
});

test('freshness excludes an older result AND an undated one, identically on both backends', async (t) => {
  for (const backend of await backends(t)) {
    const envelope = await run(backend.tool, { query: 'kettles', freshness: 'P7D' });
    assert.deepEqual(
      titles(envelope).sort(),
      ['A fresh page', 'A lookalike', 'Kettles, reviewed'],
      `${backend.name} disagreed about what a week of freshness means`,
    );
    // The undated page is the case every backend produces without being
    // asked, and dropping it is the contract: the agent will say the answer
    // is recent, and "we could not determine a date" is not evidence it is.
    assert.ok(!titles(envelope).includes('An undated page'), `${backend.name} kept an undated result`);
    assert.ok(!titles(envelope).includes('An old page'), `${backend.name} kept a 2019 page`);
  }
});

test('a call that does not ask about time sees the undated result', async (t) => {
  for (const backend of await backends(t)) {
    const envelope = await run(backend.tool, { query: 'kettles' });
    assert.ok(titles(envelope).includes('An undated page'), `${backend.name} dropped an undated result unasked`);
  }
});

test('publishedAt parses as the same UTC instant from both backends, and markup is stripped from snippets', async (t) => {
  const seen: Array<{ publishedAt?: string; snippet?: string }> = [];
  for (const backend of await backends(t)) {
    const envelope = await run(backend.tool, { query: 'kettles', site: 'docs.example.com' });
    const [first] = envelope.results as Array<{ publishedAt?: string; snippet?: string }>;
    assert.ok(first);
    seen.push(first);
  }
  const [orbit, lumen] = seen;
  assert.equal(orbit?.publishedAt, '2026-09-01T09:00:00.000Z');
  assert.equal(orbit?.publishedAt, lumen?.publishedAt, 'two backends dated the same page differently');
  // The vendor sent `<strong>` and runs of spaces; an agent gets prose.
  assert.equal(orbit?.snippet, 'The kettle guide.');
  assert.equal(orbit?.snippet, lumen?.snippet, 'two backends shaped the same snippet differently');
});

test('P1M and P1Y are refused by both backends with the same error, while PT30M is accepted by both', async (t) => {
  const messages: string[] = [];
  for (const backend of await backends(t)) {
    for (const freshness of ['P1M', 'P1Y']) {
      const error = await run(backend.tool, { query: 'kettles', freshness }).then(
        () => undefined,
        (reason: Error) => reason,
      );
      assert.ok(error, `${backend.name} accepted ${freshness}`);
      assert.match(error.message, /calendar length/);
      messages.push(error.message);
    }
    // Positional, not a ban on the letter: `M` after the `T` is minutes,
    // which is a fixed length and perfectly well defined.
    await assert.doesNotReject(() => run(backend.tool, { query: 'kettles', freshness: 'PT30M' }));
  }
  assert.equal(new Set(messages).size, 2, 'the two rejections should read identically whichever backend answered');
});

test('an operator-bearing query searches for its literal text on both backends', async (t) => {
  const operatorQueries = ['site:example.com', 'a OR b', '-foo', 'an "unbalanced quote'];
  for (const backend of await backends(t)) {
    for (const query of operatorQueries) {
      await assert.doesNotReject(
        () => run(backend.tool, { query }),
        `${backend.name} treated ${query} as syntax`,
      );
      const sent = backend.requests.at(-1) ?? '';
      // Whatever escaping a vendor needs, the characters the agent typed
      // are what went upstream — `site:` is not spliced in, and an
      // unbalanced quote is a search for a quote character.
      assert.equal(
        new URL(sent, 'http://vendor.invalid').searchParams.get('q'),
        query,
        `${backend.name} rewrote the query`,
      );
    }
  }
});

test('a backend needing no credential works unchanged, with no placeholder key invented', async (t) => {
  const lumen = await startVendor(() => ({ results: ROWS }));
  t.after(() => lumen.close());

  // No resolver at all, and a soul that allowlists nothing: the SearXNG
  // case. An adapter that never calls `get` is conforming, not broken.
  const tool = createWebSearchTool({
    provider: createLumenBackend(lumen.origin),
    config: { allowedHosts: ['127.0.0.1'] },
    now: () => NOW,
  });
  const bare: AgentDefinition = { id: 'juno', name: 'Juno' };
  const envelope = await tool.execute({ query: 'kettles' }, sessionFor(bare)) as JsonObject;
  assert.equal((envelope.results as unknown[]).length, ROWS.length);
  assert.equal(lumen.tokens.at(-1), '', 'a key-free backend sent a token');
});

test('two agents searching the one installed backend use their own credentials, resolved per call', async (t) => {
  const orbit = await startVendor(() => ({ web: { results: ROWS } }));
  t.after(() => orbit.close());

  // One shared adapter instance and one shared tool — the arrangement a
  // daemon actually has. Whose key is sent can only come from the session.
  const tool = createWebSearchTool({
    provider: createOrbitBackend(orbit.origin),
    config: { allowedHosts: ['127.0.0.1'] },
    credentials: {
      async resolve(agent, name) {
        assert.equal(name, SEARCH_CREDENTIAL_NAME);
        return `${agent.id}-key`;
      },
    },
    now: () => NOW,
  });

  await tool.execute({ query: 'kettles' }, sessionFor(ava));
  await tool.execute({ query: 'kettles' }, sessionFor({ id: 'juno', name: 'Juno', credentials: [SEARCH_CREDENTIAL_NAME] }));
  assert.deepEqual(orbit.tokens, ['ava-key', 'juno-key']);
});

test('a provider endpoint on a loopback address is refused unless the operator allowed it', async (t) => {
  const lumen = await startVendor(() => ({ results: ROWS }));
  t.after(() => lumen.close());

  // The identical configuration minus `allowedHosts` — so the refusal is
  // the address policy's doing rather than a port nothing was listening on.
  const tool = createWebSearchTool({ provider: createLumenBackend(lumen.origin), now: () => NOW });
  await assert.rejects(
    () => tool.execute({ query: 'kettles' }, sessionFor(ava)),
    /is loopback|not a public address/,
  );
});

test('a provider returning malformed JSON, a 429, or a 500 fails the call rather than the turn', async (t) => {
  const answers = [
    { body: 'not json at all' },
    { status: 429 },
    { status: 500 },
  ] as const;
  for (const answer of answers) {
    const vendor = await startVendor(() => ({}), answer);
    t.after(() => vendor.close());
    const tool = createWebSearchTool({
      provider: createLumenBackend(vendor.origin),
      config: { allowedHosts: ['127.0.0.1'] },
      now: () => NOW,
    });
    // Rejected, which the executor turns into a failed ToolResult — the
    // turn goes on and the agent is told what happened.
    await assert.rejects(() => tool.execute({ query: 'kettles' }, sessionFor(ava)));
  }
});

test('one registry, one name: swapping the backend changes nothing a soul can see', async (t) => {
  const shapes: string[] = [];
  for (const backend of await backends(t)) {
    const tools = new ToolRegistry();
    tools.register(backend.tool);
    const descriptor = tools.describe().find((entry) => entry.name === 'web.search');
    assert.ok(descriptor, `${backend.name} did not register web.search`);
    shapes.push(JSON.stringify(descriptor));

    const envelope = await run(backend.tool, { query: 'kettles', count: 1 });
    // The envelope's own shape, not just the rows: a skill written against
    // one backend reads the same keys from the other.
    assert.deepEqual(Object.keys(envelope).sort(), ['provider', 'query', 'results', 'untrusted', 'untrustedNote']);
  }
  assert.equal(new Set(shapes).size, 1, 'the tool a model sees differs between backends');
});
