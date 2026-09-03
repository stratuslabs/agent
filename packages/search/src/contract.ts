/**
 * What a search backend implements, and what it is handed per call.
 *
 * Published from this repository, implemented outside it. Every backend
 * needs a vendor key and a commercial relationship, so the backends belong
 * to the ecosystem — but the *shape* has to be first-party or the ecosystem
 * is worth nothing: two independently written plugins are interchangeable
 * only if a soul allowlisting `web.search` gets the same tool, the same
 * options, and the same results whichever one is installed.
 */

import type { ScopedCredentials } from '@stratusagent/core';
import type { EgressPolicy } from '@stratusagent/egress';

/** The tool name, in the `web` namespace on purpose — see the README. */
export const WEB_SEARCH_TOOL_NAME = 'web.search';

/**
 * The one credential name every backend asks for, whatever vendor is
 * behind it.
 *
 * This is not tidiness. A soul's `credentials` list is enforced by the
 * `CredentialResolver`, so a Brave adapter asking for `BRAVE_API_KEY` and a
 * Tavily adapter asking for `TAVILY_API_KEY` would mean swapping backends
 * edits every soul in the fleet — even though the `web.search` allowlist
 * entry never moved. One name is what makes the swap free.
 *
 * A backend needing something that is not secret (a Google CSE engine id, a
 * SearXNG base URL) puts it in the plugin's config block, which is not
 * soul-scoped. A backend needing no credential at all never calls `get`,
 * and is conforming rather than broken.
 */
export const SEARCH_CREDENTIAL_NAME = 'search.apiKey';

/**
 * The options a backend may refuse by name.
 *
 * `count` is absent on purpose: it is a maximum, and this package truncates
 * to it after the fact, so every backend honors it whether or not its
 * vendor has a parameter for it.
 */
export type SearchOptionName = 'site' | 'freshness';

/**
 * An age, resolved once per call so every part of the request agrees on
 * what "now" was.
 *
 * All three forms are given because backends need different ones: some take
 * a coarse enum, some take a date range, and the filter this package
 * applies afterwards needs the instant.
 */
export interface SearchFreshness {
  /** The ISO 8601 duration as the caller wrote it, normalized to upper case (`P7D`). */
  duration: string;
  /** That duration in milliseconds. Always a fixed length — see `parseFreshnessDuration`. */
  ms: number;
  /** The oldest instant a result may carry, as a UTC ISO 8601 instant. */
  since: string;
}

/**
 * One call's options, already parsed, validated, and normalized. A backend
 * never sees the agent's raw input — that is the point of the shape.
 */
export interface SearchOptions {
  /**
   * A **maximum**. Returning fewer is normal; returning more is a contract
   * violation, and this package truncates rather than trusting.
   */
  count: number;
  /**
   * One normalized hostname — lower case, no trailing dot, IDN in its
   * A-label form. Matches that host and anything under it on label
   * boundaries: `example.com` matches `docs.example.com` and never
   * `notexample.com`.
   *
   * Not a query operator. A backend without native site filtering must not
   * splice `site:` into the query — the query is literal text — and can
   * leave the filtering to this package, which applies it either way.
   */
  site?: string;
  /**
   * Results older than this are excluded, **and so are results with no
   * known date**. A backend that cannot honor it declares `freshness` in
   * `unsupported` rather than ignoring it: an agent that asked for recent
   * results will say the answer is recent.
   */
  freshness?: SearchFreshness;
}

/**
 * What one search call is handed besides the query.
 *
 * The third parameter is what makes per-agent keys possible at all.
 * `CredentialResolver.resolve` takes an `AgentDefinition`, so a
 * `search(query, options)` seam would leave one shared adapter instance no
 * way to reach the calling agent's key except a factory outside the
 * contract or mutable global state.
 */
export interface SearchContext {
  /**
   * Already bound to the calling agent, and `get(name)` is the whole
   * surface. An adapter has no way to *name* another agent, so it has no
   * way to reach another agent's key — where handing it an
   * `AgentDefinition` and a resolver would make agent isolation something
   * every third-party backend author has to not get wrong.
   */
  credentials: ScopedCredentials;
  /**
   * The address policy every request this call makes must go through,
   * resolved for the calling agent. Backends do not derive it: pass it
   * straight to `requestThroughPolicy` from `@stratusagent/egress`. A
   * self-hosted backend on `http://localhost:8888` is a legitimate
   * configuration and a deliberate allowance, which is exactly the
   * decision this policy already carries.
   */
  policy: EgressPolicy;
  /**
   * The turn's. A cancelled turn must stop the HTTP request, not merely
   * stop waiting on it.
   */
  signal?: AbortSignal;
}

/**
 * One result, after the backend has reshaped whatever its vendor returned.
 *
 * A backend's raw payload never reaches the agent. This is the whole value
 * of specifying the step: a provider that reshapes its JSON must not
 * reshape what every soul and skill in the fleet was written against.
 */
export interface SearchResult {
  title: string;
  /** Absolute, `http`/`https` only. Validated against the address policy before an agent sees it. */
  url: string;
  /** Plain text. Markup is stripped by this package, so a backend may pass its vendor's decorated string through. */
  snippet?: string;
  /**
   * An ISO 8601 instant in UTC when the backend has one, and absent when it
   * does not — never a guess, never a locale-formatted date. Anything that
   * will not parse as an instant is treated as absent, which under
   * `freshness` means the result is dropped.
   */
  publishedAt?: string;
}

export interface SearchProvider {
  /**
   * What this backend is, for the daemon's log and the result envelope —
   * `brave`, `tavily`, `searxng`. Not a URL and not a secret: it is written
   * to a log an operator shares.
   */
  readonly name: string;
  /**
   * Options this backend cannot honor. A call using one is refused naming
   * it, before a request is made.
   *
   * Omitted means "all of them", which is the right default because it
   * fails towards the contract: a backend opts *out* deliberately rather
   * than being quietly excused for having forgotten. Refusing beats
   * approximating — a backend that silently ignored `freshness` would be
   * worse than one that failed, because the agent's next sentence states
   * the result is recent.
   */
  readonly unsupported?: readonly SearchOptionName[];
  search(query: string, options: SearchOptions, context: SearchContext): Promise<SearchResult[]>;
}

export interface SearchProviderDefinition {
  name: string;
  unsupported?: readonly SearchOptionName[];
  search(query: string, options: SearchOptions, context: SearchContext): Promise<SearchResult[]>;
}

/**
 * Canonicalize a backend definition. The conditional spread is not
 * decoration: `exactOptionalPropertyTypes` means an absent `unsupported`
 * and one explicitly set to `undefined` are different types, and only the
 * first one means "honors everything".
 */
export const defineSearchProvider = (definition: SearchProviderDefinition): SearchProvider => ({
  name: definition.name,
  ...(definition.unsupported !== undefined ? { unsupported: definition.unsupported } : {}),
  search: definition.search,
});
