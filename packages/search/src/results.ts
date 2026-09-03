/**
 * What an agent actually receives, whichever backend answered.
 *
 * Normalized results are part of the contract, not an implementation
 * detail, so the enforcement is here rather than trusted to each adapter.
 * That is deliberately belt and braces: a backend passes `count`, `site`,
 * and `freshness` upstream because a provider filtering natively ranks
 * better than a filter applied afterwards — and this package applies them
 * again because "two backends answer the same call the same way" cannot
 * rest on every ecosystem author having got it right.
 */

import { assertRequestAllowed, type EgressPolicy } from '@stratusagent/egress';

import type { SearchOptions, SearchResult } from './contract.ts';
import { hostMatchesSite } from './options.ts';

/**
 * A snippet as plain text.
 *
 * Vendors decorate their snippets with markup — Brave wraps matched terms
 * in `<strong>` unless told not to — and a model reading `<strong>` learns
 * nothing except that there was markup. Tags out, whitespace collapsed to
 * one line.
 *
 * The pattern requires a letter or a slash after the `<`, which is what
 * keeps `5 < 10 and 20 > 15` intact: a blanket `<[^>]*>` reads everything
 * between a less-than and the next greater-than as a tag and deletes the
 * sentence between them. Snippets are prose about arbitrary subjects, so
 * that case is not hypothetical.
 *
 * Entity *decoding* is deliberately not done here: a snippet arrives as a
 * string a backend parsed out of its vendor's JSON, so whatever encoding
 * that payload used is the backend's to undo, and this package guessing at
 * it would corrupt a snippet that legitimately contains an ampersand
 * followed by a word.
 */
export const plainSnippet = (value: string): string =>
  value.replace(/<\/?[a-zA-Z][^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * An instant, or nothing.
 *
 * `publishedAt` is an ISO 8601 instant in UTC when the backend supplies one
 * and absent when it does not — never a guess, never a locale-formatted
 * date. Anything that will not parse is treated as absent rather than
 * corrected, and under `freshness` that means the result is dropped: a
 * backend handing back `03/04/2026` has not said whether that is March or
 * April, and neither reading is worth asserting to an agent that is about
 * to call the answer recent.
 */
export const normalizePublishedAt = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const parsed = new Date(value);
  const time = parsed.getTime();
  return Number.isFinite(time) ? parsed.toISOString() : undefined;
};

/**
 * A result's URL, or nothing when an agent must not be handed it.
 *
 * The same address policy `web.fetch` uses, applied before the URL reaches
 * a model that is about to fetch it: a ranker that returned an intranet
 * host, a `javascript:` URL, or the metadata endpoint has returned one bad
 * row, not a reason to fail a search — so the row is dropped and the rest
 * of the page stands.
 */
const permittedUrl = (raw: string, policy: EgressPolicy): string | undefined => {
  try {
    return assertRequestAllowed(raw, policy).href;
  } catch {
    return undefined;
  }
};

/**
 * Hold a backend's answer to the contract: absolute permitted URLs, plain
 * snippets, real instants, the `site` and `freshness` filters, and `count`
 * as a maximum.
 *
 * An undated result does not survive a `freshness` filter. Backends omit
 * dates for some hits routinely, so leaving this to each of them lets two
 * conforming adapters return different sets for identical calls — the
 * interchangeability criterion failing on the most ordinary input there is.
 * Exclusion is the right side to land on: the agent asked for recent
 * results and will say the answer is recent, and "we could not determine a
 * date" is not evidence that it is. The cost is real — a good undated page
 * is dropped — which is why the exclusion applies *only* when `freshness`
 * is set, and a call that does not ask about time sees every result.
 */
export const normalizeSearchResults = (
  raw: readonly SearchResult[],
  options: SearchOptions,
  policy: EgressPolicy = {},
): SearchResult[] => {
  const kept: SearchResult[] = [];
  // Compared as instants rather than as strings: ISO text sorts
  // chronologically only for four-digit years, and a filter that is right
  // "almost always" is the kind of difference between two backends this
  // package exists to remove.
  const since = options.freshness === undefined ? undefined : Date.parse(options.freshness.since);
  for (const entry of raw) {
    if (kept.length >= options.count) {
      break;
    }
    if (typeof entry?.title !== 'string' || typeof entry.url !== 'string') {
      continue;
    }
    const url = permittedUrl(entry.url, policy);
    if (url === undefined) {
      continue;
    }
    if (options.site !== undefined && !hostMatchesSite(new URL(url).hostname, options.site)) {
      continue;
    }
    const publishedAt = normalizePublishedAt(typeof entry.publishedAt === 'string' ? entry.publishedAt : undefined);
    if (since !== undefined && (publishedAt === undefined || Date.parse(publishedAt) < since)) {
      continue;
    }
    const snippet = typeof entry.snippet === 'string' ? plainSnippet(entry.snippet) : '';
    kept.push({
      title: entry.title.trim(),
      url,
      ...(snippet.length > 0 ? { snippet } : {}),
      ...(publishedAt !== undefined ? { publishedAt } : {}),
    });
  }
  return kept;
};
