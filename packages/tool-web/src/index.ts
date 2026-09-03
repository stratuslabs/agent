import type { JsonObject, Plugin, Session, Tool } from '@stratusagent/core';
import {
  assertRequestAllowed,
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
  const policy: EgressPolicy = {
    ...(resolved.allowPrivateAddresses === true ? { allowPrivateAddresses: true } : {}),
    ...(Array.isArray(resolved.allowedHosts)
      ? { allowedHosts: resolved.allowedHosts.filter((entry): entry is string => typeof entry === 'string') }
      : {}),
  };
  return {
    policy,
    maxBytes: asNumber(resolved.maxBytes, DEFAULT_MAX_BYTES),
    timeoutMs: asNumber(resolved.timeoutMs, DEFAULT_TIMEOUT_MS),
    maxRedirects: asNumber(resolved.maxRedirects, DEFAULT_MAX_REDIRECTS),
    userAgent: typeof resolved.userAgent === 'string' ? resolved.userAgent : DEFAULT_USER_AGENT,
  };
};

const isRedirect = (status: number): boolean => status >= 300 && status < 400;

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
  } = {},
): Promise<{ url: string; status: number; contentType: string; body: string; truncated: boolean; hops: string[] }> => {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const hops: string[] = [];
  let current = assertRequestAllowed(rawUrl, options.policy ?? {}).href;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    hops.push(current);
    const response = await requestThroughPolicy(current, {
      ...(options.policy ? { policy: options.policy } : {}),
      headers: { 'user-agent': options.userAgent ?? DEFAULT_USER_AGENT, accept: 'text/html,text/plain;q=0.9,*/*;q=0.5' },
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    const location = response.headers.location;
    if (isRedirect(response.status) && typeof location === 'string' && location.length > 0) {
      // Resolved against the current URL, then checked from scratch — a
      // relative redirect is still a new destination.
      const next = new URL(location, current).href;
      current = assertRequestAllowed(next, options.policy ?? {}).href;
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
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      maxBytes: { type: 'number' },
      raw: { type: 'boolean', description: 'Return the body as received, without text extraction.' },
    },
    required: ['url'],
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
      ...(context?.signal ? { signal: context.signal } : {}),
    });

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
