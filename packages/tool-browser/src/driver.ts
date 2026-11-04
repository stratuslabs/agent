import { execFile } from 'node:child_process';

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
  /**
   * Playwright's `disconnected`: Chromium is gone, crashed, killed or
   * closed. Optional so a stub need not have it; a browser without it is
   * still bounded by the pool's open timeout.
   */
  on?(event: 'disconnected', listener: () => void): unknown;
}

export interface LaunchOptions {
  headless: boolean;
  proxy: { server: string; bypass: string };
  /**
   * Chromium's own sandbox, which keeps a compromised renderer away from
   * the daemon's files and credentials. On unless this is `false`:
   * Playwright's default is off (`--no-sandbox`), so leaving it out is
   * not neutral.
   */
  chromiumSandbox?: boolean;
  executablePath?: string;
  channel?: string;
}

export interface BrowserDriver {
  launch(options: LaunchOptions): Promise<BrowserLike>;
}

const OPT_OUT = 'set `"chromiumSandbox": false` in the @stratusagent/tool-browser plugin config, which runs '
  + "pages without Chromium's own sandbox";

/**
 * Whether this process may start a macOS sandbox, or why not.
 *
 * Chromium's sandbox on macOS is a Seatbelt profile, and macOS refuses to
 * apply one inside a process that already runs under one: a daemon started
 * through `sandbox-exec` gets a Chromium that launches, loses its GPU and
 * network helpers to "sandbox initialization failed", and exits, while the
 * first `newPage` never settles. Nothing reaches the launch call to catch.
 * So the same question is put to the OS first, with an allow-everything
 * profile, and a refusal becomes an error that names the fix. Asked once
 * per process: whether this process is sandboxed does not change.
 */
let macSandboxAnswer: Promise<string | undefined> | undefined;
export const macSandboxRefusal = (): Promise<string | undefined> => {
  macSandboxAnswer ??= new Promise((resolve) => {
    execFile('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { timeout: 5_000 }, (error, _stdout, stderr) => {
      // Only the refusal counts. No sandbox-exec, a timeout or anything
      // else unexpected says nothing about the sandbox, so the launch goes
      // ahead and reports whatever Chromium does.
      const said = String(stderr).trim();
      resolve(error && /Operation not permitted/.test(said) ? said : undefined);
    });
  });
  return macSandboxAnswer;
};

export interface PlaywrightDriverOptions {
  /**
   * Asked before a sandboxed launch: a reason this host cannot start
   * Chromium's sandbox, or undefined when it can. Defaults to the macOS
   * check above, and to nothing elsewhere, where Chromium fails the launch
   * itself. Tests replace it.
   */
  sandboxRefusal?: () => Promise<string | undefined>;
  /**
   * Whether the daemon runs as root, asked only after Chromium has failed
   * to start its sandbox. Chromium refuses to sandbox as root, and
   * Playwright reports that with the same words as a host that refuses
   * user namespaces, so this is how the two get different advice.
   * Defaults to the process's own uid. Tests replace it.
   */
  runsAsRoot?: () => boolean;
}

const processRunsAsRoot = (): boolean => process.getuid?.() === 0;

/**
 * Playwright's own words for Chromium's "No usable sandbox!", and that line
 * itself in case a version stops rewriting it.
 */
const sandboxFailed = (message: string): boolean =>
  message.includes('Chromium sandboxing failed') || message.includes('No usable sandbox');

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
export const createPlaywrightDriver = (
  host: OptionalModuleHost,
  driverOptions: PlaywrightDriverOptions = {},
): BrowserDriver => ({
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

    const chromiumSandbox = options.chromiumSandbox !== false;
    if (chromiumSandbox) {
      const refusal = await (driverOptions.sandboxRefusal
        ?? (process.platform === 'darwin' ? macSandboxRefusal : async () => undefined))();
      if (refusal) {
        throw new Error(
          "Could not start a browser: Chromium's sandbox can't start here. This process already runs inside a "
          + `macOS sandbox, and macOS won't start one inside another (${refusal}).\n`
          + `Run the daemon outside that sandbox, or ${OPT_OUT}.`,
        );
      }
    }

    try {
      return await playwright.chromium.launch({
        headless: options.headless,
        proxy: options.proxy,
        chromiumSandbox,
        ...(options.executablePath ? { executablePath: options.executablePath } : {}),
        ...(options.channel ? { channel: options.channel } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (chromiumSandbox && sandboxFailed(message) && (driverOptions.runsAsRoot ?? processRunsAsRoot)()) {
        throw new Error(
          `Could not start a browser: ${message}\n`
          + "This daemon runs as root, and Chromium won't start its sandbox as root. "
          + `Run the daemon as a non-root user, or ${OPT_OUT}.`,
        );
      }
      if (chromiumSandbox && sandboxFailed(message)) {
        throw new Error(
          `Could not start a browser: ${message}\n`
          + "Chromium's sandbox needs unprivileged user namespaces, and this host refuses them. The usual reasons "
          + "are a container under Docker's default seccomp profile and Ubuntu 24.04's AppArmor restriction. "
          + `Allow them for the daemon, or ${OPT_OUT}.`,
        );
      }
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
