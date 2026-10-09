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
  /**
   * The tool the grant was made for. Present on every grant written since
   * `web.fetch` became origin-scoped, because a site approved for a GET is
   * not a site approved for clicks: without it, Always allow on a fetch of
   * `https://app.example.com` let `browser.act` press buttons there with
   * nobody asked. Absent on a grant from before then, when only the
   * browser named an origin, and such a grant still covers every
   * origin-scoped tool, as it always did.
   */
  tool?: string;
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

/**
 * Whether an action on `origin` by `tool` falls inside one scope. A caller
 * that names no tool is matched only by a scope that names none either.
 */
export const matchesOriginScope = (origin: string, scope: OriginScope, tool?: string): boolean =>
  scope.origin === origin && (scope.tool === undefined || scope.tool === tool);

/** The first scope covering this origin for this tool, if any covers it. */
export const findMatchingOriginScope = (
  origin: string,
  scopes: readonly OriginScope[],
  tool?: string,
): OriginScope | undefined => scopes.find((scope) => matchesOriginScope(origin, scope, tool));

/** One line an operator can read in a log or a grant listing. */
export const describeOriginScope = (scope: OriginScope): string =>
  scope.tool === undefined ? scope.origin : `${scope.origin} (${scope.tool})`;

/** Whether two scopes permit the same thing, so a whitelist does not grow duplicates. */
export const sameOriginScope = (left: OriginScope, right: OriginScope): boolean =>
  left.origin === right.origin && left.tool === right.tool;

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
  const source = raw as Record<string, unknown>;
  if (typeof source.origin !== 'string') {
    return undefined;
  }
  // A `tool` that is present but not a non-empty string is a hand edit gone
  // wrong; dropping the whole grant beats widening it to every tool.
  if (source.tool !== undefined && (typeof source.tool !== 'string' || source.tool.length === 0)) {
    return undefined;
  }
  const scope = originScopeFor(source.origin);
  return scope && typeof source.tool === 'string' ? { ...scope, tool: source.tool } : scope;
};

/**
 * A trusted domain as an operator writes it: `openai.com`, which covers
 * `openai.com` and every subdomain of it (`developers.openai.com`), and
 * nothing that merely ends in the same letters (`evilopenai.com`). Leading
 * `*.` or `.` is accepted and means the same. Anything with a scheme, a
 * path, a port, or a character a hostname can't have is refused, so a typo
 * never widens into something nobody wrote.
 */
export const normalizeTrustedDomain = (raw: string): string | undefined => {
  const domain = raw.trim().toLowerCase().replace(/^\*\./, '').replace(/^\./, '');
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/.test(domain) ? domain : undefined;
};

/**
 * The trusted domain an origin is under, or undefined. https on its default
 * port only: a trusted name reached over plain http, or on some other port,
 * is not the site the operator meant.
 */
export const trustedDomainOf = (origin: string, domains: readonly string[]): string | undefined => {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.port !== '') {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  return domains
    .map(normalizeTrustedDomain)
    .find((domain): domain is string => domain !== undefined && (host === domain || host.endsWith(`.${domain}`)));
};
