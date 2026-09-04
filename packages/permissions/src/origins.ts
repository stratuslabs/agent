/**
 * The origin-scope engine: which *sites* a browser action may be taken on
 * unattended.
 *
 * `ToolRisk` classifies a tool, and that was too coarse for `browser.act`
 * in the same way it is too coarse for a shell — but not for the same
 * reason, and the difference is why this is a second engine rather than a
 * second use of the first. A command string *is* a description of its
 * effect, so `analyzeCommand` can tell `git status` from `rm -rf`. A CSS
 * selector is not: `click("#submit")` is equally "load more results" and
 * "confirm purchase", and a scope written over selectors would mean
 * nothing at all.
 *
 * What is left that an operator can read is *where* the click lands. So a
 * scope here is one origin — `https://app.example.com`, exactly, scheme
 * and host and port — taken from the page the conversation is already on
 * rather than from anything the call said about itself.
 *
 * **This narrows the blast radius; it does not eliminate it.** Acting on
 * `app.example.com` still covers "delete the record" alongside "load more".
 * The claim is only that the radius is now nameable, which is what a
 * single `dangerous` tier gave up on — and the docs say it in those words
 * rather than implying a click became safe.
 *
 * There is deliberately no built-in safe list here, which is the other
 * asymmetry with the command engine. `SAFE_COMMAND_SCOPES` can exist
 * because `git status` is read-only wherever it runs; no origin has that
 * property, since whether clicking on a site is harmless is a fact about
 * the operator's account on it rather than about the site. A first-party
 * list would be this project guessing at somebody's permissions, so every
 * origin an agent may act on unattended was granted by a person — at a
 * prompt, in Slack, or by hand in that agent's whitelist file.
 */

import { originOf } from '@stratusagent/core';

/** One narrow permission to act on a site: an origin, and nothing else. */
export interface OriginScope {
  /**
   * `https://app.example.com`, or `https://app.example.com:8443` when the
   * port is not the scheme's default — the form `originOf` produces, which
   * is the only form this engine ever compares.
   */
  origin: string;
}

/**
 * The scope a page URL grants, or nothing when the URL has no origin this
 * engine will name (`about:blank`, a `file:` path, an unparseable string).
 *
 * Nothing falls back to a looser grant: a page whose origin cannot be
 * named is a page no scope covers, so the call asks a human and an
 * "always" answered on it is remembered for that call only.
 */
export const originScopeFor = (rawUrl: string): OriginScope | undefined => {
  const origin = originOf(rawUrl);
  return origin === undefined ? undefined : { origin };
};

/** Whether an action on `origin` falls inside one scope. */
export const matchesOriginScope = (origin: string, scope: OriginScope): boolean =>
  scope.origin === origin;

/** The first scope covering this origin, if any covers it. */
export const findMatchingOriginScope = (
  origin: string,
  scopes: readonly OriginScope[],
): OriginScope | undefined => scopes.find((scope) => matchesOriginScope(origin, scope));

/** One line an operator can read in a log or a grant listing. */
export const describeOriginScope = (scope: OriginScope): string => scope.origin;

/** Whether two scopes permit the same thing, so a whitelist does not grow duplicates. */
export const sameOriginScope = (left: OriginScope, right: OriginScope): boolean =>
  left.origin === right.origin;

/**
 * Read one scope out of a whitelist file, or refuse it.
 *
 * Re-normalized through `originScopeFor` rather than trusted as written,
 * because this file is hand-editable and a grant is only as good as the
 * comparison it will lose or win. `https://APP.example.com/reports` in the
 * file becomes `https://app.example.com` or it is dropped — a trailing
 * path that silently never matched would read as a grant and behave as
 * none, and a second spelling of an approved host is a second grant nobody
 * wrote.
 */
export const parseOriginScope = (raw: unknown): OriginScope | undefined => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const origin = (raw as Record<string, unknown>).origin;
  return typeof origin === 'string' ? originScopeFor(origin) : undefined;
};
