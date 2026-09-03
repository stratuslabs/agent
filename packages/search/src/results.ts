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
 * **A formatting tag is removed, not replaced with a space.** Vendors
 * highlight the matched *substring*, so `un<strong>expected</strong>`
 * arrives routinely — and a space there produces `un expected`, a word the
 * page does not contain. The same space detaches punctuation, turning
 * `<strong>kettle</strong>.` into `kettle .`. The handful of tags that do
 * separate words become a space, because removing those would glue two
 * sentences together instead; everything else is inline decoration around
 * text that was already adjacent.
 *
 * Entity *decoding* is deliberately not done here: a snippet arrives as a
 * string a backend parsed out of its vendor's JSON, so whatever encoding
 * that payload used is the backend's to undo, and this package guessing at
 * it would corrupt a snippet that legitimately contains an ampersand
 * followed by a word.
 */
const SNIPPET_SEPARATOR = /^(?:br|p|div|li|tr|td|th|h[1-6]|blockquote|section|article)$/i;

export const plainSnippet = (value: string): string =>
  value
    .replace(
      /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g,
      (_tag, name: string) => (SNIPPET_SEPARATOR.test(name) ? ' ' : ''),
    )
    .replace(/\s+/g, ' ')
    .trim();

/**
 * A date-time this contract will accept: a calendar date, optionally with a
 * time that carries an explicit zone.
 *
 * The zone is mandatory once there is a time, because a zone-less
 * `2026-09-01T10:00:00` is *local* time to whatever machine parses it — the
 * same string becomes two different instants on two daemons, which is the
 * disagreement this package exists to remove.
 */
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2}))?$/;

/**
 * An instant, or nothing.
 *
 * `publishedAt` is an ISO 8601 instant in UTC when the backend supplies one
 * and absent when it does not — never a guess, never a locale-formatted
 * date. Under `freshness` that means the result is dropped, which is why
 * this has to be strict rather than merely tolerant: **`new Date(value)` is
 * not a validator.** It reads `03/04/2026` as 4 March without ever saying
 * whether the backend meant March or April, and it silently *corrects*
 * `2026-02-30` into 2 March — so a lenient parse does not fail to date a
 * result, it invents a date, and then a freshness filter keeps or drops the
 * result on the strength of it. The shape is checked first, and the
 * calendar date is round-tripped so a day that does not exist is refused
 * instead of rolled forward.
 *
 * A date with no time is accepted and read as UTC midnight, which is what
 * ISO 8601 and JavaScript both say it is. Plenty of backends only have a
 * day, and refusing them would silently empty every `freshness` search
 * against such a backend; reading it as midnight errs towards calling a
 * page slightly older than it is, which is the safe direction here.
 */
export const normalizePublishedAt = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  const match = ISO_DATE_TIME.exec(trimmed);
  if (!match) {
    return undefined;
  }
  const [, year = '', month = '', day = '', hour = '0', minute = '0', second = '0', zone = 'Z'] = match;
  // Round-tripped rather than trusted: `Date.UTC(2026, 1, 30)` answers
  // 2 March quite happily, and a date the backend did not give is worse
  // than no date at all.
  const probe = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    probe.getUTCFullYear() !== Number(year)
    || probe.getUTCMonth() !== Number(month) - 1
    || probe.getUTCDate() !== Number(day)
    || Number(hour) > 23
    || Number(minute) > 59
    || Number(second) > 60
  ) {
    return undefined;
  }
  // `+0200` and `+02:00` are the same offset in ISO 8601, and only the
  // second is in JavaScript's own grammar. Spelling it the way the parser
  // requires is not a guess about what the backend meant.
  const parsed = new Date(trimmed.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
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
