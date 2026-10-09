import { originOf, type JsonObject, type Plugin, type Session, type Tool } from '@stratusagent/core';
import {
  assertRequestAllowed,
  egressPolicyFrom,
  requestThroughPolicy,
  type EgressPolicy,
} from '@stratusagent/egress';
import { resolvePluginAgentConfig } from '@stratusagent/plugins';

import { extractTitle, htmlToText } from './readability.ts';

export { decodeEntities, extractTitle, htmlToText } from './readability.ts';

const DEFAULT_MAX_BYTES = 400_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_USER_AGENT = 'StratusAgent/0.5 (+https://github.com/stratuslabs/agent)';

export interface WebPluginConfig extends JsonObject {
  /** Reach addresses that are not globally routable. See the README. */
  allowPrivateAddresses?: boolean;
  /** Hosts exempt from the address check, by name or literal address. */
  allowedHosts?: string[];
  /** The only hosts reachable at all, when set. See the README. */
  onlyHosts?: string[];
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  userAgent?: string;
}

const asNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

/**
 * A per-call `maxBytes` may narrow the operator's cap, never raise it. A
 * cap the model can lift is not one: a fetch of a 300 MB body asked for
 * `maxBytes: 50000000`, got 50 MB of it, and took the daemon from 278 MB to
 * 1.1 GB resident on the way.
 */
const narrowed = (requested: unknown, cap: number): number => Math.min(asNumber(requested, cap), cap);

const settingsFor = (config: JsonObject, session: Session) => {
  // Per call, from the session: an agent allowed to reach an internal host
  // is a decision about that agent, and closing over it at setup would
  // give the exemption to everyone.
  const resolved = resolvePluginAgentConfig(config, session.agent.id);
  const policy: EgressPolicy = egressPolicyFrom(resolved);
  return {
    policy,
    maxBytes: asNumber(resolved.maxBytes, DEFAULT_MAX_BYTES),
    timeoutMs: asNumber(resolved.timeoutMs, DEFAULT_TIMEOUT_MS),
    maxRedirects: asNumber(resolved.maxRedirects, DEFAULT_MAX_REDIRECTS),
    userAgent: typeof resolved.userAgent === 'string' ? resolved.userAgent : DEFAULT_USER_AGENT,
  };
};

const isRedirect = (status: number): boolean => status >= 300 && status < 400;

/**
 * Whether a hop stays on the site a call was judged on: the same origin, or
 * the same host moved from `http:` to `https:` on default ports. The upgrade
 * is allowed because it is what nearly every `http://` URL answers with, and
 * it reaches the same host over a strictly safer channel. Nothing else is:
 * `example.com` to `www.example.com` is another origin, and so is a
 * downgrade, because a grant names an origin and means exactly that one.
 */
const staysOnSite = (judged: string, next: string): boolean => {
  if (originOf(judged) === originOf(next)) {
    return true;
  }
  const from = new URL(judged);
  const to = new URL(next);
  return from.protocol === 'http:' && to.protocol === 'https:'
    && from.hostname === to.hostname && from.port === '' && to.port === '';
};

const contentTypeOf = (headers: Record<string, unknown>): string =>
  String(headers['content-type'] ?? '').toLowerCase();

/**
 * Fetch a URL, following redirects **one validated hop at a time**.
 *
 * The loop is here rather than in the HTTP client for one reason: every hop
 * is a new request to a new host, and a client that followed redirects for
 * us would resolve and connect to hosts nothing checked. An approved public
 * URL that answers `302 Location: http://169.254.169.254/` is exactly the
 * attack, and it is defeated by the second hop facing the policy the same
 * way the first one did.
 */
export const fetchThroughPolicy = async (
  rawUrl: string,
  options: {
    policy?: EgressPolicy;
    maxBytes?: number;
    timeoutMs?: number;
    maxRedirects?: number;
    userAgent?: string;
    signal?: AbortSignal;
    /**
     * Stop at a redirect to another site instead of following it, and
     * report where it pointed as `leftSite`. `web.fetch` sets this: it is
     * judged by the origin of the URL it was given, so following a
     * redirect elsewhere would carry a call approved for one site to
     * another (an open redirect on a granted site would reach anywhere).
     */
    stayOnSite?: boolean;
  } = {},
): Promise<{
  url: string;
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
  hops: string[];
  leftSite?: string;
}> => {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const hops: string[] = [];
  let current = assertRequestAllowed(rawUrl, options.policy ?? {}).href;
  // One budget for the whole exchange, not one per hop. Each hop is its own
  // request with its own timer, and a fresh timer per hop let a chain of
  // slow redirects multiply the configured timeout by the redirect limit:
  // four hops at three seconds each answered after twelve seconds under a
  // five-second timeout, which is not what "give up on the whole exchange"
  // promises.
  const deadline = options.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs;
  const timedOut = (): Error =>
    new Error(`Timed out after ${options.timeoutMs}ms across ${hops.length - 1} redirect(s) starting at ${rawUrl}`);

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    hops.push(current);
    const remainingMs = deadline === undefined ? undefined : deadline - Date.now();
    if (remainingMs !== undefined && remainingMs <= 0) {
      throw timedOut();
    }
    let response;
    try {
      response = await requestThroughPolicy(current, {
        ...(options.policy ? { policy: options.policy } : {}),
        headers: { 'user-agent': options.userAgent ?? DEFAULT_USER_AGENT, accept: 'text/html,text/plain;q=0.9,*/*;q=0.5' },
        ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
        ...(remainingMs === undefined ? {} : { timeoutMs: remainingMs }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      // A hop that ran out the shared budget reports the budget, not the
      // sliver of it that this hop was left.
      if (deadline !== undefined && hops.length > 1 && Date.now() >= deadline) {
        throw timedOut();
      }
      throw error;
    }

    const location = response.headers.location;
    if (isRedirect(response.status) && typeof location === 'string' && location.length > 0) {
      // Resolved against the current URL, then checked from scratch — a
      // relative redirect is still a new destination.
      // The address policy first: a hop it refuses is refused with its own
      // reason, whether or not the hop also leaves the site.
      const next = assertRequestAllowed(new URL(location, current).href, options.policy ?? {}).href;
      if (options.stayOnSite === true && !staysOnSite(hops[0] ?? current, next)) {
        return {
          url: current,
          status: response.status,
          contentType: contentTypeOf(response.headers as Record<string, unknown>),
          body: '',
          truncated: false,
          hops,
          leftSite: next,
        };
      }
      current = next;
      continue;
    }

    return {
      url: current,
      status: response.status,
      contentType: contentTypeOf(response.headers as Record<string, unknown>),
      body: response.body,
      truncated: response.truncated,
      hops,
    };
  }

  throw new Error(`Too many redirects (${maxRedirects}) starting at ${rawUrl}`);
};

const createFetchTool = (config: JsonObject): Tool => ({
  name: 'web.fetch',
  description: 'Retrieve a URL and return its readable text. No browser, no JavaScript.',
  // Gated: it reaches a service outside Stratus, on an address an agent
  // chose. The address policy decides *where*; approval decides *whether*.
  risk: 'gated',
  // Every result is a document somebody else wrote — the body, and the
  // page-supplied title with it. Declared once rather than marked per call
  // because there is no call for which it is not true.
  outputTrust: 'external',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      maxBytes: { type: 'number' },
      raw: { type: 'boolean', description: 'Return the body as received, without text extraction.' },
    },
    required: ['url'],
  },
  /**
   * Judged by the site it is pointed at, so "always allow" can mean one
   * site rather than every URL. Read from the input, which for this tool is
   * the action itself rather than a claim about it: `execute` requests
   * exactly this origin and stops at any redirect that leaves it
   * (`stayOnSite`). See `Tool.originFor`.
   */
  originFor(_session, input) {
    return typeof input.url === 'string' ? originOf(input.url) : undefined;
  },
  async execute(input, session, context) {
    const url = typeof input.url === 'string' ? input.url : '';
    if (!url) {
      throw new Error('url is required.');
    }
    const settings = settingsFor(config, session);
    const response = await fetchThroughPolicy(url, {
      policy: settings.policy,
      maxBytes: narrowed(input.maxBytes, settings.maxBytes),
      timeoutMs: settings.timeoutMs,
      maxRedirects: settings.maxRedirects,
      userAgent: settings.userAgent,
      stayOnSite: true,
      ...(context?.signal ? { signal: context.signal } : {}),
    });

    if (response.leftSite !== undefined) {
      // Not an error: the request worked, and the agent decides whether
      // the other site is worth a call of its own, which is judged (and
      // asked about, when it needs to be) like any other.
      return {
        url: response.url,
        status: response.status,
        redirectedTo: response.leftSite,
        ...(response.hops.length > 1 ? { redirects: response.hops } : {}),
        text: `Redirected to ${response.leftSite}, a different site from the one this call was approved for, `
          + 'so it was not followed. Call web.fetch on that URL to fetch it.',
        truncated: false,
      };
    }

    const html = response.contentType.includes('html');
    const text = input.raw === true || !html ? response.body : htmlToText(response.body);
    const title = html ? extractTitle(response.body) : undefined;

    return {
      url: response.url,
      status: response.status,
      contentType: response.contentType,
      ...(title ? { title } : {}),
      // Named `redirects` rather than left implicit: an agent that followed
      // a link somewhere else should be able to say where it ended up.
      ...(response.hops.length > 1 ? { redirects: response.hops } : {}),
      text,
      truncated: response.truncated,
    };
  },
});

/**
 * The `web` toolset: one tool, deliberately.
 *
 * This is the capability an agent reaches for twenty times for every once
 * it needs a browser, and paying Chromium's startup and memory for it is
 * the wrong trade. Search is not here and is not coming: every backend
 * needs a vendor key and a commercial relationship, so `web.search` belongs
 * to the ecosystem.
 */
export const createWebPlugin = (config: JsonObject = {}): Plugin => ({
  name: '@stratusagent/tool-web',
  setup(context) {
    context.tools.register(createFetchTool(config));
  },
});

/** The loader's ABI. See `docs/architecture/plugins.md`. */
export const createPlugin = createWebPlugin;
