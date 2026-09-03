import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { JsonObject, JsonValue, Plugin, Session, Tool } from '@stratusagent/core';
import { assertRequestAllowed, type EgressPolicy } from '@stratusagent/egress';
import { resolvePluginAgentConfig, type OptionalModuleHost } from '@stratusagent/plugins';

import { createPlaywrightDriver, type BrowserDriver, type PageLike, type RouteLike } from './driver.ts';
import { BrowserSessionPool } from './sessions.ts';

export {
  createPlaywrightDriver,
  type BrowserContextLike,
  type BrowserDriver,
  type BrowserLike,
  type LaunchOptions,
  type PageLike,
  type RouteLike,
} from './driver.ts';
export { BrowserSessionPool, type SessionPoolOptions } from './sessions.ts';

const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TEXT_BYTES = 100_000;

export interface BrowserPluginConfig extends JsonObject {
  allowPrivateAddresses?: boolean;
  allowedHosts?: string[];
  headless?: boolean;
  executablePath?: string;
  channel?: string;
  idleMs?: number;
  maxContexts?: number;
  maxTextBytes?: number;
  navigationTimeoutMs?: number;
  /** Supplied by the host: `~/.stratus/workspaces`, one directory per agent. */
  workspaceRoot?: string;
}

const asNumber = (value: JsonValue | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

/** The address policy a block describes, per-agent or top-level. */
const policyFrom = (resolved: JsonObject): EgressPolicy => ({
  ...(resolved.allowPrivateAddresses === true ? { allowPrivateAddresses: true } : {}),
  ...(Array.isArray(resolved.allowedHosts)
    ? { allowedHosts: resolved.allowedHosts.filter((entry): entry is string => typeof entry === 'string') }
    : {}),
});

const settingsFor = (config: JsonObject, session: Session) => {
  const resolved = resolvePluginAgentConfig(config, session.agent.id);
  const policy = policyFrom(resolved);
  return {
    policy,
    maxTextBytes: asNumber(resolved.maxTextBytes, DEFAULT_MAX_TEXT_BYTES),
    navigationTimeoutMs: asNumber(resolved.navigationTimeoutMs, DEFAULT_NAVIGATION_TIMEOUT_MS),
    workspaceRoot: typeof resolved.workspaceRoot === 'string' ? resolved.workspaceRoot : undefined,
  };
};

/**
 * Text as a reader would see it, extracted in the page.
 *
 * The DOM is right there, so there is nothing to guess at: the furniture is
 * removed from a clone and what is left is `innerText`, which already
 * respects what is visible. This is the one place a browser genuinely beats
 * `web.fetch`, whose extractor has to infer all of it from markup.
 */
const READABLE_TEXT_SCRIPT = `(() => {
  const doc = document.cloneNode(true);
  for (const element of doc.querySelectorAll('script, style, noscript, svg, nav, header, footer, aside, form')) {
    element.remove();
  }
  const main = doc.querySelector('article, main') ?? doc.body;
  return main ? main.innerText : '';
})()`;

/**
 * The request-level half of the address policy, inside the browser.
 *
 * The proxy the browser is launched through owns every connection it makes,
 * which is what defeats rebinding — but a `file:` or `data:` URL never
 * reaches a proxy, and Chromium runs as the daemon user. So schemes are
 * refused here, on every request the page makes: the navigation itself,
 * each redirect, and every subresource.
 */
const guardRequests = async (
  page: PageLike,
  policy: EgressPolicy,
  record: (entry: string) => void,
): Promise<void> => {
  await page.route('**/*', async (route: RouteLike) => {
    const url = route.request().url();
    try {
      assertRequestAllowed(url, policy);
      await route.continue();
    } catch (error) {
      record(`${url} — ${error instanceof Error ? error.message : String(error)}`);
      await route.abort('blockedbyclient');
    }
  });
};

interface BrowserRuntime {
  pool: BrowserSessionPool;
  /**
   * What each conversation's own page was refused, keyed by session.
   *
   * Per session because these are URLs the *page* asked for, and a
   * `file:` path or a query string from one agent's browsing is not
   * another agent's to read — the contexts are isolated, and a report
   * assembled from a process-wide list would hand back what that
   * isolation exists to prevent.
   */
  blocked: Map<string, string[]>;
  pageFor(session: Session): Promise<PageLike>;
}

/**
 * What was refused while this session's page was loading, from both halves
 * of the policy: the scheme guard inside the browser, and the proxy that
 * owns the connections. Reported to the agent because a page that renders
 * empty because its requests were blocked is otherwise a mystery it retries.
 *
 * Each refusal is reported once — this drains what it reports — so a
 * result names what happened since the last one, not everything that ever
 * did. Called once per result, for the same reason.
 */
const refusalsFor = (runtime: BrowserRuntime, session: Session): string[] => {
  const inBrowser = runtime.blocked.get(session.id) ?? [];
  runtime.blocked.delete(session.id);
  return [...inBrowser, ...runtime.pool.refusalsFor(session.id)].slice(-10);
};

const truncate = (value: string, maxBytes: number): { text: string; truncated: boolean } =>
  Buffer.byteLength(value, 'utf8') <= maxBytes
    ? { text: value, truncated: false }
    : { text: `${value.slice(0, maxBytes)}\n… truncated at ${maxBytes} bytes`, truncated: true };

const navigate = async (
  page: PageLike,
  rawUrl: string,
  policy: EgressPolicy,
  timeoutMs: number,
): Promise<number | undefined> => {
  // Before navigation, not after: a `file:///…/credentials.json` must never
  // be handed to the browser at all, because by the time an interception
  // handler sees it the read has a chance to have happened.
  const url = assertRequestAllowed(rawUrl, policy);
  const response = await page.goto(url.href, { timeout: timeoutMs, waitUntil: 'load' });
  return response?.status();
};

const screenshotPathFor = async (
  workspaceRoot: string | undefined,
  session: Session,
  now: number,
): Promise<string> => {
  if (!workspaceRoot) {
    throw new Error(
      'browser.screenshot has nowhere to write. Set workspaceRoot for @stratusagent/tool-browser, '
      + 'or run through a daemon that supplies it.',
    );
  }
  // One directory per agent, under the workspace root the host resolved:
  // an agent's output is that agent's, and a shared scratch directory is
  // two agents reading each other's screenshots.
  const directory = path.join(workspaceRoot, session.agent.id, 'screenshots');
  await mkdir(directory, { recursive: true });
  return path.join(directory, `${new Date(now).toISOString().replace(/[:.]/g, '-')}.png`);
};

const createTools = (config: JsonObject, runtime: BrowserRuntime): Tool[] => {
  const goto: Tool = {
    name: 'browser.goto',
    description: 'Open a URL in this conversation’s browser page.',
    risk: 'gated',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
    async execute(input, session) {
      const settings = settingsFor(config, session);
      const page = await runtime.pageFor(session);
      const status = await navigate(page, String(input.url ?? ''), settings.policy, settings.navigationTimeoutMs);
      const blockedRequests = refusalsFor(runtime, session);
      return {
        url: page.url(),
        ...(status === undefined ? {} : { status }),
        title: await page.title(),
        ...(blockedRequests.length > 0 ? { blockedRequests } : {}),
      };
    },
  };

  const read: Tool = {
    name: 'browser.read',
    description: 'Read the current page as text, optionally navigating first.',
    risk: 'gated',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' }, maxBytes: { type: 'number' } },
    },
    async execute(input, session) {
      const settings = settingsFor(config, session);
      const page = await runtime.pageFor(session);
      if (typeof input.url === 'string' && input.url.length > 0) {
        await navigate(page, input.url, settings.policy, settings.navigationTimeoutMs);
      }
      const extracted = await page.evaluate(READABLE_TEXT_SCRIPT);
      const { text, truncated } = truncate(
        typeof extracted === 'string' ? extracted : '',
        asNumber(input.maxBytes, settings.maxTextBytes),
      );
      const blockedRequests = refusalsFor(runtime, session);
      return {
        url: page.url(),
        title: await page.title(),
        text,
        truncated,
        ...(blockedRequests.length > 0 ? { blockedRequests } : {}),
      };
    },
  };

  const screenshot: Tool = {
    name: 'browser.screenshot',
    description: 'Save a screenshot of the current page and return its path.',
    risk: 'gated',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' }, fullPage: { type: 'boolean' } },
    },
    async execute(input, session) {
      const settings = settingsFor(config, session);
      const page = await runtime.pageFor(session);
      if (typeof input.url === 'string' && input.url.length > 0) {
        await navigate(page, input.url, settings.policy, settings.navigationTimeoutMs);
      }
      const target = await screenshotPathFor(settings.workspaceRoot, session, Date.now());
      await page.screenshot({ path: target, fullPage: input.fullPage === true });
      // `file`, because that is the key a channel already acts on: an ok
      // result carrying `file` (or `files`) is delivered as an attachment,
      // which is how "screenshot example.com and show me" ends with a
      // picture in Slack rather than a path nobody can open. One key rather
      // than a `path` alias beside it — two words for one thing is how a
      // convention stops being one.
      const blockedRequests = refusalsFor(runtime, session);
      return {
        file: target,
        url: page.url(),
        title: await page.title(),
        ...(blockedRequests.length > 0 ? { blockedRequests } : {}),
      };
    },
  };

  const act: Tool = {
    name: 'browser.act',
    description: 'Click or type on the current page.',
    // Dangerous, and the only one here that is: navigating and reading can
    // be undone by navigating somewhere else, while a click submits, buys,
    // and deletes. No selector makes that reversible.
    risk: 'dangerous',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['click', 'type'] },
        selector: { type: 'string' },
        value: { type: 'string' },
      },
      required: ['action', 'selector'],
    },
    async execute(input, session) {
      const settings = settingsFor(config, session);
      const page = await runtime.pageFor(session);
      const selector = String(input.selector ?? '');
      if (!selector) {
        throw new Error('selector is required.');
      }
      if (input.action === 'type') {
        await page.fill(selector, String(input.value ?? ''), { timeout: settings.navigationTimeoutMs });
      } else if (input.action === 'click') {
        await page.click(selector, { timeout: settings.navigationTimeoutMs });
      } else {
        throw new Error(`Unsupported action: ${String(input.action)}. Use click or type.`);
      }
      const blockedRequests = refusalsFor(runtime, session);
      return {
        action: input.action,
        selector,
        url: page.url(),
        title: await page.title(),
        ...(blockedRequests.length > 0 ? { blockedRequests } : {}),
      };
    },
  };

  return [goto, read, screenshot, act];
};

export interface BrowserPluginOptions {
  /** Overrides the Playwright driver. Tests use it; nothing else should. */
  driver?: BrowserDriver;
  /** How this host resolves and imports optional packages. */
  moduleHost?: OptionalModuleHost;
}

/**
 * The `browser` toolset.
 *
 * One browser per plugin, a context per conversation, and an idle sweep
 * that closes both — see `BrowserSessionPool`. Every request the browser
 * makes goes through a proxy this plugin owns, which resolves and validates
 * each address itself, because Chromium resolves names for itself no matter
 * what an interception handler decided.
 */
export const createBrowserPlugin = (
  config: JsonObject = {},
  options: BrowserPluginOptions = {},
): Plugin & { dispose(): Promise<void>; sweepIdle(now: number): Promise<string[]> } => {
  const blocked = new Map<string, string[]>();
  const resolved = config;
  const pool = new BrowserSessionPool({
    driver: options.driver ?? createPlaywrightDriver(
      options.moduleHost ?? {
        resolve: (specifier) => import.meta.resolve(specifier),
        import: (specifier) => import(specifier),
      },
    ),
    ...(resolved.headless === false ? { headless: false } : {}),
    ...(typeof resolved.executablePath === 'string' ? { executablePath: resolved.executablePath } : {}),
    ...(typeof resolved.channel === 'string' ? { channel: resolved.channel } : {}),
    ...(typeof resolved.idleMs === 'number' ? { idleMs: resolved.idleMs } : {}),
    ...(typeof resolved.maxContexts === 'number' ? { maxContexts: resolved.maxContexts } : {}),
    onEvicted: ({ sessionId }) => {
      // The page that recorded them is gone, so its refusals go with it.
      blocked.delete(sessionId);
    },
  });

  const runtime: BrowserRuntime = {
    pool,
    blocked,
    async pageFor(session) {
      const settings = settingsFor(config, session);
      // The agent's own policy decides which browser serves it: a proxy is
      // chosen when Chromium launches, so an agent whose config narrows the
      // address policy needs a browser launched under that policy rather
      // than a context inside somebody else's.
      const page = await pool.pageFor(session.id, Date.now(), settings.policy);
      // Routed once per page. A page created for this session gets the
      // scheme guard before anything is asked of it.
      if (!(page as PageLike & { __stratusGuarded?: boolean }).__stratusGuarded) {
        await guardRequests(page, settings.policy, (entry) => {
          blocked.set(session.id, [...(blocked.get(session.id) ?? []), entry].slice(-20));
        });
        (page as PageLike & { __stratusGuarded?: boolean }).__stratusGuarded = true;
      }
      return page;
    },
  };

  return {
    name: '@stratusagent/tool-browser',
    setup(context) {
      for (const tool of createTools(config, runtime)) {
        context.tools.register(tool);
      }
    },
    /**
     * The kernel's teardown hook, which is what a host actually calls.
     * Named anything else, a browser and a listening proxy survive both
     * `stratus run` and a daemon shutdown — the second of which is the
     * whole reason `Plugin.dispose` exists.
     */
    dispose: () => pool.close(),
    /**
     * The sweep, for a caller that wants it at a chosen instant. The pool
     * also runs it on its own timer; this is what makes the behaviour
     * testable without a test that sleeps.
     */
    sweepIdle: (now: number) => pool.sweepIdle(now),
  };
};

/** The loader's ABI. See `docs/architecture/plugins.md`. */
export const createPlugin = (config: JsonObject = {}): Plugin => createBrowserPlugin(config);
