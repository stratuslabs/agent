import {
  chromiumProxyOptions,
  createEgressProxy,
  type EgressPolicy,
  type EgressProxy,
} from '@stratusagent/egress';

import type { BrowserContextLike, BrowserDriver, BrowserLike, PageLike } from './driver.ts';

export interface SessionPoolOptions {
  driver: BrowserDriver;
  policy: EgressPolicy;
  headless?: boolean;
  executablePath?: string;
  channel?: string;
  /** Close a context that has done nothing for this long. */
  idleMs?: number;
  /** How many contexts may exist at once. The oldest goes when a new one would exceed it. */
  maxContexts?: number;
  /** Called when a page is dropped, so a caller can log it. */
  onEvicted?: (event: { sessionId: string; reason: 'idle' | 'capacity' | 'shutdown' }) => void;
}

interface PooledContext {
  sessionId: string;
  context: BrowserContextLike;
  page: PageLike;
  lastUsedAt: number;
}

const DEFAULT_IDLE_MS = 5 * 60_000;
const DEFAULT_MAX_CONTEXTS = 4;

/**
 * One browser, a context per conversation, and nothing left running.
 *
 * The lifecycle is the operationally risky part of this pack, and all of it
 * lives here rather than in the tools: a browser is expensive to start and
 * ruinous to leak, so there is one per plugin, started on first use; each
 * session gets its own context, so two conversations never share cookies or
 * a login; and a context that has gone quiet is closed rather than kept
 * warm on the chance somebody comes back.
 *
 * Idle sweeping takes the time as an argument. A pool that read the clock
 * itself could only be tested by sleeping, and a test that sleeps is a race
 * against the machine it runs on.
 */
export class BrowserSessionPool {
  private readonly options: SessionPoolOptions;

  private readonly contexts = new Map<string, PooledContext>();

  private browser: BrowserLike | undefined;

  private proxy: EgressProxy | undefined;

  private launching: Promise<BrowserLike> | undefined;

  constructor(options: SessionPoolOptions) {
    this.options = options;
  }

  /** Requests the egress proxy refused, for surfacing to the agent. */
  get refusals(): string[] {
    return this.proxy?.refusals ?? [];
  }

  private async browserFor(): Promise<BrowserLike> {
    if (this.browser) {
      return this.browser;
    }
    // Single-flight: two tool calls arriving together must not launch two
    // browsers, and the second one would leak because only one can be kept.
    this.launching ??= (async () => {
      const proxy = await createEgressProxy(this.options.policy);
      this.proxy = proxy;
      try {
        const browser = await this.options.driver.launch({
          headless: this.options.headless ?? true,
          proxy: chromiumProxyOptions(proxy),
          ...(this.options.executablePath ? { executablePath: this.options.executablePath } : {}),
          ...(this.options.channel ? { channel: this.options.channel } : {}),
        });
        this.browser = browser;
        return browser;
      } catch (error) {
        await proxy.close();
        this.proxy = undefined;
        this.launching = undefined;
        throw error;
      }
    })();
    return this.launching;
  }

  /** The page this session works in, created on first use. */
  async pageFor(sessionId: string, now: number): Promise<PageLike> {
    const existing = this.contexts.get(sessionId);
    if (existing) {
      existing.lastUsedAt = now;
      return existing.page;
    }

    const browser = await this.browserFor();
    const maxContexts = this.options.maxContexts ?? DEFAULT_MAX_CONTEXTS;
    while (this.contexts.size >= maxContexts) {
      const oldest = [...this.contexts.values()].sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
      if (!oldest) {
        break;
      }
      await this.drop(oldest, 'capacity');
    }

    const context = await browser.newContext();
    const page = await context.newPage();
    this.contexts.set(sessionId, { sessionId, context, page, lastUsedAt: now });
    return page;
  }

  private async drop(entry: PooledContext, reason: 'idle' | 'capacity' | 'shutdown'): Promise<void> {
    this.contexts.delete(entry.sessionId);
    try {
      await entry.context.close();
    } catch {
      // A context that is already gone is the outcome we wanted.
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
    // The browser itself goes when the last conversation does: a Chromium
    // sitting idle overnight is the leak this pack is most likely to cause.
    if (this.contexts.size === 0) {
      await this.closeBrowser();
    }
    return expired.map((entry) => entry.sessionId);
  }

  private async closeBrowser(): Promise<void> {
    const browser = this.browser;
    this.browser = undefined;
    this.launching = undefined;
    if (browser) {
      try {
        await browser.close();
      } catch {
        // Same as above: already gone is fine.
      }
    }
    const proxy = this.proxy;
    this.proxy = undefined;
    await proxy?.close();
  }

  /** Everything, for shutdown. */
  async close(): Promise<void> {
    for (const entry of [...this.contexts.values()]) {
      await this.drop(entry, 'shutdown');
    }
    await this.closeBrowser();
  }

  /** How many conversations currently hold a page. */
  get size(): number {
    return this.contexts.size;
  }
}
