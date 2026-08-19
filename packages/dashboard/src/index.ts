import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

/**
 * Where the built UI lives, relative to this module.
 *
 * `ui/` is a sibling of `dist/`, and both ship in the package. The assets are
 * hand-written ES modules with no build step, so what is published is exactly
 * what a contributor edits — there is no bundle to go stale against the source.
 */
const UI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

export interface DashboardAssetOptions {
  /** Override the asset directory. Tests use it; nothing else should. */
  root?: string;
}

/**
 * Static assets for the control API to serve at `/`.
 *
 * Deliberately not a server: the API already owns a socket, an auth model, and
 * an origin check, and a second server would need its own copy of all three.
 * This is the smallest thing that can answer "is there a file for this path".
 */
export const createDashboardAssets = (options: DashboardAssetOptions = {}) => {
  const root = options.root ?? UI_ROOT;

  return {
    async serve(pathname: string, response: ServerResponse): Promise<boolean> {
      // A single-page app: every unknown path is a route the client renders,
      // so the shell answers for all of them. Real assets are matched first.
      const requested = pathname === '/' ? '/index.html' : pathname;

      let decoded: string;
      try {
        decoded = decodeURIComponent(requested);
      } catch {
        return false;
      }

      // Resolved and then checked, not sanitised. Stripping `..` by hand is a
      // game of encodings nobody wins; asking whether the resolved path is
      // still inside the asset directory is a question with one answer.
      const candidate = path.resolve(root, `.${path.posix.normalize(decoded)}`);
      const inside = candidate === root || candidate.startsWith(`${root}${path.sep}`);
      const target = inside && path.extname(candidate) !== ''
        ? candidate
        : path.join(root, 'index.html');

      let stats;
      try {
        stats = await stat(target);
      } catch {
        return false;
      }
      if (!stats.isFile()) {
        return false;
      }

      response.statusCode = 200;
      response.setHeader('content-type', CONTENT_TYPES[path.extname(target)] ?? 'application/octet-stream');
      response.setHeader('content-length', stats.size);
      // The shell and its modules are versioned with the daemon, and a
      // dashboard that keeps showing last release's UI after an upgrade is a
      // bug report nobody can reproduce. Loopback makes revalidation free.
      response.setHeader('cache-control', 'no-cache');
      // A page that only ever talks to its own origin, with no inline script
      // and nothing embeddable: say so, so a mistake later has to be
      // deliberate rather than accidental.
      response.setHeader('content-security-policy', [
        "default-src 'self'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; '));
      response.setHeader('x-content-type-options', 'nosniff');

      await pipeline(createReadStream(target), response);
      return true;
    },
  };
};

export type DashboardAssets = ReturnType<typeof createDashboardAssets>;
