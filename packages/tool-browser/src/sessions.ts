import {
  chromiumProxyOptions,
  createEgressProxy,
  policyKeyFor,
  type EgressPolicy,
  type EgressProxy,
} from '@stratusagent/egress';

import type { BrowserContextLike, BrowserDriver, BrowserLike, PageLike } from './driver.ts';

export interface SessionPoolOptions {
  driver: BrowserDriver;
  headless?: boolean;
  executablePath?: string;
  channel?: string;
  /** Close a context that has done nothing for this long. */
  idleMs?: number;
  /** How many contexts may exist at once. The oldest goes when a new one would exceed it. */
  maxContexts?: number;
  /** Called when a page is dropped, so a caller can log it. */
  onEvicted?: (event: { sessionId: string; reason: 'idle' | 'capacity' | 'shutdown' | 'policy' }) => void;
  /** Reported rather than thrown: a sweep runs on a timer with nobody waiting on it. */
  onError?: (error: unknown) => void;
}

interface BrowserEntry {
  key: string;
  browser: BrowserLike;
  proxy: EgressProxy;
  sessions: Set<string>;
}

interface PooledContext {
  sessionId: string;
  context: BrowserContextLike;
  page: PageLike;
  lastUsedAt: number;
  browserKey: string;
}

const DEFAULT_IDLE_MS = 5 * 60_000;
const DEFAULT_MAX_CONTEXTS = 4;
const MAX_SWEEP_INTERVAL_MS = 60_000;

/**
 * Browsers, contexts, and the proxies that own their connections.
 *
 * Three rules, and each of them is a boundary rather than an optimization:
 *
 * - **A browser per policy.** A proxy is chosen when Chromium launches, so
 *   a single shared browser can only ever enforce one address policy — and
 *   an agent whose config *narrows* it (`allowedHosts: []` over a permissive
 *   default) would silently get the permissive one. Contexts cannot fix
 *   that: request interception runs inside the browser and does not resolve
 *   names, so it cannot narrow a hostname destination without re-opening
 *   the DNS-rebinding race the proxy exists to close.
 * - **A context per conversation**, so two conversations never share a
 *   cookie jar or a login.
 * - **Nothing left running.** A context that has gone quiet is closed, and
 *   a browser whose last conversation went with it is closed too.
 *
 * The sweep takes the time as an argument *and* runs on a timer. A pool that
 * only read the clock itself could only be tested by sleeping; one that only
 * offered the method would leave `idleMs` as a setting nothing honoured.
 */
export class BrowserSessionPool {
  private readonly options: SessionPoolOptions;

  private readonly contexts = new Map<string, PooledContext>();

  private readonly browsers = new Map<string, BrowserEntry>();

  private readonly launching = new Map<string, Promise<BrowserEntry>>();

  private sweepTimer: NodeJS.Timeout | undefined;

  private closed = false;

  constructor(options: SessionPoolOptions) {
    this.options = options;
  }

  private async browserFor(policy: EgressPolicy): Promise<BrowserEntry> {
    const key = policyKeyFor(policy);
    const existing = this.browsers.get(key);
    if (existing) {
      return existing;
    }
    // Single-flight per policy: two calls arriving together must not launch
    // two browsers, and the second would leak because only one is kept.
    const pending = this.launching.get(key);
    if (pending) {
      return pending;
    }

    const launch = (async (): Promise<BrowserEntry> => {
      const proxy = await createEgressProxy(policy);
      try {
        const browser = await this.options.driver.launch({
          headless: this.options.headless ?? true,
          proxy: chromiumProxyOptions(proxy),
          ...(this.options.executablePath ? { executablePath: this.options.executablePath } : {}),
          ...(this.options.channel ? { channel: this.options.channel } : {}),
        });
        const entry: BrowserEntry = { key, browser, proxy, sessions: new Set() };
        this.browsers.set(key, entry);
        this.armSweep();
        return entry;
      } catch (error) {
        await proxy.close();
        throw error;
      } finally {
        this.launching.delete(key);
      }
    })();
    this.launching.set(key, launch);
    return launch;
  }

  /**
   * The page this session works in, created on first use — under the
   * policy resolved for *this* agent, not for whoever asked first.
   */
  async pageFor(sessionId: string, now: number, policy: EgressPolicy = {}): Promise<PageLike> {
    const key = policyKeyFor(policy);
    const existing = this.contexts.get(sessionId);
    if (existing) {
      if (existing.browserKey === key) {
        existing.lastUsedAt = now;
        return existing.page;
      }
      // The agent's policy changed under a live conversation (an edited
      // config, a soul now resolving different settings). The open context
      // belongs to a browser enforcing the old one, so it goes.
      await this.drop(existing, 'policy');
    }

    const entry = await this.browserFor(policy);
    const maxContexts = this.options.maxContexts ?? DEFAULT_MAX_CONTEXTS;
    while (this.contexts.size >= maxContexts) {
      const oldest = [...this.contexts.values()].sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
      if (!oldest) {
        break;
      }
      await this.drop(oldest, 'capacity');
    }

    const context = await entry.browser.newContext();
    const page = await context.newPage();
    this.contexts.set(sessionId, { sessionId, context, page, lastUsedAt: now, browserKey: key });
    entry.sessions.add(sessionId);
    return page;
  }

  /**
   * What the proxy refused for this session's browser.
   *
   * Scoped to the browser rather than to the process: an agent under a
   * different policy has a different browser and never sees these. Two
   * agents that share a policy share a browser and can see each other's
   * refused *addresses* — which is the same set their identical policy
   * already told them about.
   */
  refusalsFor(sessionId: string): string[] {
    const context = this.contexts.get(sessionId);
    if (!context) {
      return [];
    }
    return this.browsers.get(context.browserKey)?.proxy.refusals ?? [];
  }

  private async drop(entry: PooledContext, reason: 'idle' | 'capacity' | 'shutdown' | 'policy'): Promise<void> {
    this.contexts.delete(entry.sessionId);
    try {
      await entry.context.close();
    } catch {
      // A context that is already gone is the outcome we wanted.
    }
    const browser = this.browsers.get(entry.browserKey);
    browser?.sessions.delete(entry.sessionId);
    if (browser && browser.sessions.size === 0) {
      // The browser goes with its last conversation: a Chromium sitting
      // idle overnight is the leak this pack is most likely to cause.
      await this.closeBrowser(browser);
    }
    this.options.onEvicted?.({ sessionId: entry.sessionId, reason });
  }

  /** Close whatever has been idle longer than the timeout. Returns what went. */
  async sweepIdle(now: number): Promise<string[]> {
    const idleMs = this.options.idleMs ?? DEFAULT_IDLE_MS;
    const expired = [...this.contexts.values()].filter((entry) => now - entry.lastUsedAt >= idleMs);
    for (const entry of expired) {
      await this.drop(entry, 'idle');
    }
    return expired.map((entry) => entry.sessionId);
  }

  /**
   * The timer behind `idleMs`. Unref'd, so a pending sweep never holds a
   * one-shot `stratus run` open, and disarmed as soon as the last browser
   * goes so an idle daemon carries no timer at all.
   */
  private armSweep(): void {
    if (this.sweepTimer || this.closed) {
      return;
    }
    const idleMs = this.options.idleMs ?? DEFAULT_IDLE_MS;
    const interval = Math.max(1_000, Math.min(idleMs, MAX_SWEEP_INTERVAL_MS));
    this.sweepTimer = setInterval(() => {
      void this.sweepIdle(Date.now()).catch((error) => this.options.onError?.(error));
    }, interval);
    this.sweepTimer.unref?.();
  }

  private disarmSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  private async closeBrowser(entry: BrowserEntry): Promise<void> {
    this.browsers.delete(entry.key);
    try {
      await entry.browser.close();
    } catch {
      // Same as a context: already gone is fine.
    }
    await entry.proxy.close();
    if (this.browsers.size === 0) {
      this.disarmSweep();
    }
  }

  /** Everything, for shutdown. */
  async close(): Promise<void> {
    this.closed = true;
    this.disarmSweep();
    for (const entry of [...this.contexts.values()]) {
      await this.drop(entry, 'shutdown');
    }
    // Anything still open had no contexts to take it down — a browser that
    // launched for a call that then failed, for instance.
    for (const entry of [...this.browsers.values()]) {
      await this.closeBrowser(entry);
    }
  }

  /** How many conversations currently hold a page. */
  get size(): number {
    return this.contexts.size;
  }

  /** How many browsers are running — one per distinct address policy. */
  get browserCount(): number {
    return this.browsers.size;
  }
}
