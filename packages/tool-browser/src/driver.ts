import type { OptionalModuleHost } from '@stratusagent/plugins';
import { loadOptionalModule } from '@stratusagent/plugins';

/**
 * The browser, as this pack uses it.
 *
 * A seam rather than a direct Playwright import, for two reasons. The pack
 * must load in a daemon where no browser is installed — every other tool
 * still works, and `browser.*` fails with something an operator can act on
 * — and the lifecycle logic (contexts per session, idle teardown, the
 * concurrency cap) is testable against a stub, where a real Chromium in CI
 * would test the same code and a 300 MB download.
 *
 * Playwright's own objects satisfy these shapes structurally.
 */
export interface PageLike {
  goto(url: string, options?: { timeout?: number; waitUntil?: string }): Promise<{ status(): number } | null>;
  url(): string;
  title(): Promise<string>;
  content(): Promise<string>;
  evaluate(script: string): Promise<unknown>;
  screenshot(options: { path?: string; fullPage?: boolean }): Promise<Buffer>;
  click(selector: string, options?: { timeout?: number }): Promise<void>;
  fill(selector: string, value: string, options?: { timeout?: number }): Promise<void>;
  route(pattern: string, handler: (route: RouteLike) => void | Promise<void>): Promise<void>;
  close(): Promise<void>;
}

export interface RouteLike {
  request(): { url(): string; resourceType?: () => string };
  abort(reason?: string): Promise<void>;
  continue(): Promise<void>;
}

export interface BrowserContextLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

export interface BrowserLike {
  newContext(options?: {
    viewport?: { width: number; height: number };
    /** A proxy for this context alone, overriding the one the browser was launched with. */
    proxy?: { server: string; bypass: string };
  }): Promise<BrowserContextLike>;
  close(): Promise<void>;
}

export interface LaunchOptions {
  headless: boolean;
  proxy: { server: string; bypass: string };
  executablePath?: string;
  channel?: string;
}

export interface BrowserDriver {
  launch(options: LaunchOptions): Promise<BrowserLike>;
}

/**
 * Playwright, loaded only when a browser tool is actually called.
 *
 * `playwright-core` is a few megabytes and downloads no browser, which is
 * the whole reason it is the dependency: installing this plugin costs an
 * operator nothing they did not ask for, and the browser is whatever they
 * already have — an installed Chrome or Edge by `channel`, an
 * `executablePath` they name, or a Chromium they installed with
 * `npx playwright install chromium`.
 */
export const createPlaywrightDriver = (host: OptionalModuleHost): BrowserDriver => ({
  async launch(options) {
    const playwright = await loadOptionalModule<{
      chromium: { launch(options: Record<string, unknown>): Promise<BrowserLike> };
    }>('playwright-core', host);
    if (!playwright) {
      throw new Error(
        'browser.* needs playwright-core, which is not installed. '
        + 'Install it alongside @stratusagent/tool-browser (npm install playwright-core).',
      );
    }

    try {
      return await playwright.chromium.launch({
        headless: options.headless,
        proxy: options.proxy,
        ...(options.executablePath ? { executablePath: options.executablePath } : {}),
        ...(options.channel ? { channel: options.channel } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The overwhelmingly common failure, and one an operator can fix in a
      // line — worth saying rather than passing Playwright's paragraph on.
      throw new Error(
        `Could not start a browser: ${message}\n`
        + 'Install one with `npx playwright install chromium`, or point the plugin at a browser you have '
        + '(`"channel": "chrome"` or `"executablePath": "/path/to/chrome"`).',
      );
    }
  },
});
