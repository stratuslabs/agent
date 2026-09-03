/**
 * Every option pinned to a meaning.
 *
 * Naming the options is not specifying them: two adapters can both satisfy
 * `{ search(query, options) }` while accepting incompatible calls, which
 * defeats the one criterion this package exists for. So the parsing lives
 * here, once, in front of every backend — a call that means one thing on
 * Brave means the same thing on SearXNG because neither of them parsed it.
 */

import type { JsonObject } from '@stratusagent/core';

import type { SearchFreshness, SearchOptions } from './contract.ts';

export const SEARCH_COUNT_DEFAULT = 10;
export const SEARCH_COUNT_MAX = 50;

/**
 * A call this contract refuses. Exported because a backend throws it too:
 * an option it declared `unsupported` and a value its vendor rejects are
 * the same kind of answer to the agent.
 */
export class SearchOptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchOptionError';
  }
}

/**
 * Fixed-length designators only. `W` and `D` before the `T`, `H`, `M` and
 * `S` after it — and note that `M` is absent from the date portion on
 * purpose, which is what makes the rejection of `P1M` positional rather
 * than a ban on the letter.
 *
 * The lookahead after `T` is what rejects a bare `P1DT`: ISO 8601 requires
 * at least one component after the designator, and without it the optional
 * group matches nothing and the trailing `T` is silently ignored.
 */
const FIXED_DURATION = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/** A year or a month in the date portion — the two ambiguous ones. */
const CALENDAR_DURATION = /^P\d+[YM]/;

const UNITS = ['W', 'D', 'H', 'M', 'S'] as const;
const MS = { W: 604_800_000, D: 86_400_000, H: 3_600_000, M: 60_000, S: 1000 } as const;

/**
 * An ISO 8601 duration of fixed length, in milliseconds.
 *
 * **Fixed-length only, because `P1M` and `P1Y` are not one length.**
 * Calendar arithmetic is where two conforming adapters part company:
 * subtracting a month from 31 March, or a year from 29 February, has more
 * than one defensible answer, and an adapter that converts to 30 or 365
 * days instead disagrees with one that does not — at boundaries,
 * intermittently, which is the worst way for a difference to show up.
 * Rejecting the two ambiguous designators costs nothing a caller wants:
 * `P30D` and `P365D` say what someone asking for "a month" or "a year" of
 * search results actually means, and say it identically everywhere.
 *
 * `M` means two things and only one of them is rejected. ISO 8601 uses the
 * same letter for months in the date portion and minutes after the `T`, so
 * "reject `M`" would throw out `PT30M`, which is fixed-length and perfectly
 * well defined.
 */
export const parseFreshnessDuration = (raw: string): number => {
  const value = raw.trim().toUpperCase();
  const match = FIXED_DURATION.exec(value);
  const total = UNITS.reduce((sum, unit, index) => {
    const digits = match?.[index + 1];
    return digits === undefined ? sum : sum + Number(digits) * MS[unit];
  }, 0);

  if (!match || total === 0) {
    if (CALENDAR_DURATION.test(value)) {
      throw new SearchOptionError(
        `freshness ${JSON.stringify(raw)} is a calendar length, which is not one length: a month from 31 March and a year `
        + 'from 29 February each have more than one defensible answer. Write P30D or P365D instead. '
        + '(PT30M, meaning thirty minutes, is fine — the rejection is about the date portion.)',
      );
    }
    throw new SearchOptionError(
      `freshness must be a positive ISO 8601 duration of weeks, days, hours, minutes, or seconds — P7D, P4W, PT12H, PT30M. `
      + `Got ${JSON.stringify(raw)}.`,
    );
  }
  return total;
};

/**
 * One hostname, normalized so two adapters compare the same string.
 *
 * **Hostname with label-boundary matching, not "registrable domain".** A
 * registrable domain is the public-suffix-plus-one form, so
 * `docs.example.com` is not one — an adapter enforcing that term would
 * reject it or widen it up to `example.com`, silently broadening a search
 * another adapter would keep narrow. This needs no public-suffix list,
 * which is a dependency worth not acquiring. The two-label minimum is what
 * stops `site: com`.
 */
export const normalizeSearchSite = (raw: string): string => {
  const trimmed = raw.trim().replace(/\.$/, '');
  if (trimmed.length === 0) {
    throw new SearchOptionError('site must be a hostname like example.com; it was empty.');
  }
  if (/[\s/\\?#@:]/.test(trimmed)) {
    throw new SearchOptionError(
      `site must be a bare hostname — no scheme, no port, no path. Got ${JSON.stringify(raw)}; write example.com, not https://example.com/docs.`,
    );
  }
  let hostname: string;
  try {
    // The URL parser is what lower-cases and converts an IDN to its A-label
    // form, so `Bücher.de` and `bücher.de` and `xn--bcher-kva.de` are one
    // string by the time anything compares them.
    hostname = new URL(`https://${trimmed}`).hostname;
  } catch {
    throw new SearchOptionError(`site is not a hostname: ${JSON.stringify(raw)}.`);
  }
  const labels = hostname.split('.');
  if (labels.length < 2 || labels.some((label) => label.length === 0)) {
    throw new SearchOptionError(
      `site must name a host with at least two labels — example.com or docs.example.com, not ${JSON.stringify(raw)}.`,
    );
  }
  return hostname;
};

/**
 * Whether one result's host is inside a `site` filter.
 *
 * On label boundaries, which is the whole rule: `notexample.com` ends with
 * `example.com` as a string and is a different company.
 */
export const hostMatchesSite = (host: string, site: string): boolean => {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return normalized === site || normalized.endsWith(`.${site}`);
};

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== 'string') {
    throw new SearchOptionError(`${field} must be a string; got ${value === null ? 'null' : typeof value}.`);
  }
  return value;
};

export interface ParsedSearchCall {
  query: string;
  options: SearchOptions;
}

/**
 * One tool call's input, turned into the options a backend receives.
 *
 * The query is passed through as **literal text**. "Verbatim" was the wrong
 * word for it and the two halves could not both be true: most search APIs
 * parse their own operators out of the query field, so handing the string
 * over untouched is precisely what lets the upstream reinterpret `site:`,
 * `OR`, a minus sign, or a quote — while a backend that escapes them is no
 * longer passing anything verbatim. What is required is the *meaning*: the
 * query is literal, and each backend does whatever its provider needs to
 * make that true. An unbalanced quote is a search for a quote character,
 * not a syntax error.
 */
export const parseSearchCall = (input: JsonObject, now: Date): ParsedSearchCall => {
  const query = requireString(input.query, 'query').trim();
  if (query.length === 0) {
    throw new SearchOptionError('query is required and must not be empty.');
  }

  let count = SEARCH_COUNT_DEFAULT;
  if (input.count !== undefined) {
    if (typeof input.count !== 'number' || !Number.isInteger(input.count)) {
      throw new SearchOptionError(`count must be a whole number between 1 and ${SEARCH_COUNT_MAX}; got ${JSON.stringify(input.count)}.`);
    }
    if (input.count < 1 || input.count > SEARCH_COUNT_MAX) {
      throw new SearchOptionError(`count must be between 1 and ${SEARCH_COUNT_MAX}; got ${input.count}.`);
    }
    count = input.count;
  }

  const site = input.site === undefined ? undefined : normalizeSearchSite(requireString(input.site, 'site'));

  let freshness: SearchFreshness | undefined;
  if (input.freshness !== undefined) {
    const written = requireString(input.freshness, 'freshness');
    const ms = parseFreshnessDuration(written);
    // Measured back from the instant the request is made, in UTC, and
    // resolved once so the backend's native filter and the filter applied
    // afterwards cannot disagree about when "now" was.
    freshness = { duration: written.trim().toUpperCase(), ms, since: new Date(now.getTime() - ms).toISOString() };
  }

  return {
    query,
    options: {
      count,
      ...(site !== undefined ? { site } : {}),
      ...(freshness !== undefined ? { freshness } : {}),
    },
  };
};
