/**
 * Two search backends written the way the ecosystem writes them: against
 * the published contract, over real HTTP, sharing no code with each other.
 *
 * They stand in for the Brave/Tavily/Exa side of the boundary that
 * `plugins.md` keeps outside this repository, and they exist because the
 * criterion step 13 is for — "two backends from different authors are
 * interchangeable" — cannot be proved by one. Everything about them differs
 * on purpose: one needs a key and one does not, their vendors' JSON uses
 * different field names, one filters natively and the other leaves the
 * filtering to the contract.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { requestThroughPolicy, type EgressPolicy } from '@stratusagent/egress';
import { defineSearchProvider, SEARCH_CREDENTIAL_NAME, type SearchProvider } from '../src/index.ts';

export interface FakeVendor {
  origin: string;
  /** Every request path this vendor was asked for, newest last. */
  requests: string[];
  /** The `X-Subscription-Token` header of each request, `''` when absent. */
  tokens: string[];
  close(): Promise<void>;
}

export interface VendorRow {
  title: string;
  url: string;
  /** Free-form: each vendor spells its own fields, which is the point. */
  [field: string]: unknown;
}

/**
 * One vendor's HTTP endpoint. `respond` receives the parsed query string so
 * a test can assert what a backend actually sent upstream.
 */
export const startVendor = async (
  respond: (params: URLSearchParams) => unknown,
  options: { status?: number; body?: string } = {},
): Promise<FakeVendor> => {
  const requests: string[] = [];
  const tokens: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url ?? '');
    tokens.push(String(request.headers['x-subscription-token'] ?? ''));
    const params = new URL(request.url ?? '/', 'http://vendor.invalid').searchParams;
    if (options.status !== undefined && options.status >= 400) {
      response.writeHead(options.status, { 'content-type': 'application/json' });
      response.end(options.body ?? '{"error":"nope"}');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(options.body ?? JSON.stringify(respond(params)));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    tokens,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

const readJson = async (
  url: string,
  policy: EgressPolicy,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<unknown> => {
  // Every request through the shared address policy, handed over per call.
  // A backend derives nothing here: a self-hosted instance on loopback is a
  // deliberate allowance the operator wrote, not something the backend gets
  // to decide for itself.
  const response = await requestThroughPolicy(url, {
    policy,
    headers,
    timeoutMs: 5000,
    ...(signal ? { signal } : {}),
  });
  if (response.status !== 200) {
    throw new Error(`The search provider answered ${response.status}.`);
  }
  return JSON.parse(response.body) as unknown;
};

/**
 * Vendor one: a metered API behind a key, with native filtering.
 *
 * Shaped after the Brave/Tavily family — a subscription token header,
 * `<strong>` decorations in its snippets, its own coarse freshness enum,
 * and dates under a name nobody else uses.
 */
export const createOrbitBackend = (origin: string): SearchProvider =>
  defineSearchProvider({
    name: 'orbit',
    async search(query, options, context) {
      // The single backend-neutral name. A soul lists `search.apiKey`
      // whichever vendor is installed, which is what makes a swap free.
      const key = await context.credentials.get(SEARCH_CREDENTIAL_NAME);
      const url = new URL('/v1/web/search', origin);
      // The query goes over as literal text. This vendor documents a
      // `literal` switch for exactly that, so operators in the string search
      // for themselves rather than being parsed.
      url.searchParams.set('q', query);
      url.searchParams.set('literal', '1');
      url.searchParams.set('count', String(options.count));
      if (options.site !== undefined) {
        url.searchParams.set('host', options.site);
      }
      if (options.freshness !== undefined) {
        url.searchParams.set('since', options.freshness.since);
      }
      const payload = await readJson(
        url.href,
        context.policy,
        { 'x-subscription-token': key, accept: 'application/json' },
        context.signal,
      ) as { web?: { results?: VendorRow[] } };
      return (payload.web?.results ?? []).map((row) => ({
        title: row.title,
        url: row.url,
        ...(typeof row.description === 'string' ? { snippet: row.description } : {}),
        ...(typeof row.page_age === 'string' ? { publishedAt: row.page_age } : {}),
      }));
    },
  });

/**
 * Vendor two: a self-hosted instance, no key and no vendor.
 *
 * The SearXNG case, and the proof the single credential name did not become
 * a single *requirement*: this backend never calls `get`, and is conforming
 * rather than broken. It also has no native site or freshness filter, so it
 * sends neither and lets the contract do the filtering — the other half of
 * "a backend without native support filters after the fact rather than
 * splicing `site:` into the query".
 */
export const createLumenBackend = (origin: string): SearchProvider =>
  defineSearchProvider({
    name: 'lumen',
    async search(query, options, context) {
      const url = new URL('/search', origin);
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'json');
      const payload = await readJson(
        url.href,
        context.policy,
        { accept: 'application/json' },
        context.signal,
      ) as { results?: VendorRow[] };
      return (payload.results ?? []).slice(0, options.count).map((row) => ({
        title: row.title,
        url: row.url,
        ...(typeof row.content === 'string' ? { snippet: row.content } : {}),
        ...(typeof row.publishedDate === 'string' ? { publishedAt: row.publishedDate } : {}),
      }));
    },
  });
