import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';

import { gatewayTokenPath, stratusHomePath, type StateEnvironment } from '@stratusagent/state';

/** How long a browser session lasts before it has to be re-opened. */
const SESSION_TTL_MS = 12 * 60 * 60_000;
/**
 * How long a one-time URL token stays usable. Short because it travels in a
 * URL — through a browser launcher, into history, possibly into a log — and
 * its only job is to survive the trip from `stratus dashboard` to the first
 * request the browser makes.
 */
const OTT_TTL_MS = 60_000;

export const SESSION_COOKIE = 'stratus_session';

/** How a request proved it may be here. */
export type Principal =
  /**
   * A token from the file, sent as a header. Carries no ambient authority:
   * nothing attaches it automatically, so a page on another origin cannot
   * cause one to be sent, and origin checks do not apply.
   */
  | { kind: 'bearer' }
  /**
   * A browser session cookie. Ambient — the browser attaches it to any
   * request to this host — so every state-changing use of one is origin-bound.
   */
  | { kind: 'cookie'; sessionId: string };

/**
 * Read the gateway's bearer token, generating one the first time.
 *
 * 0600 twice over: `writeFile`'s mode only applies when it creates the file,
 * so an upgrade over a token written under a looser umask would stay
 * readable by every other local user. The explicit chmod covers that.
 */
export const ensureGatewayToken = async (env: StateEnvironment): Promise<string> => {
  const tokenPath = gatewayTokenPath(env);
  try {
    const existing = (await readFile(tokenPath, 'utf8')).trim();
    if (existing.length > 0) {
      await chmod(tokenPath, 0o600);
      return existing;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  // 32 bytes of CSPRNG output. base64url so it survives a URL, a header, and
  // a shell argument without escaping.
  const token = randomBytes(32).toString('base64url');
  await mkdir(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
  try {
    // Exclusive create, so of two daemons starting together on a fresh home
    // exactly one wins. Without it both observe ENOENT, both generate a
    // token, and the loser goes on authenticating against a value no client
    // can read — its API reachable by nobody, with nothing saying so.
    await writeFile(tokenPath, `${token}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
    const winner = (await readFile(tokenPath, 'utf8')).trim();
    await chmod(tokenPath, 0o600);
    if (winner.length > 0) {
      return winner;
    }
    // The file exists but holds nothing — a process interrupted between
    // creating it and writing to it. Returning that would start an API whose
    // secret no bearer header can satisfy, while every client reads the same
    // empty string: authenticated by nobody, across restarts, with nothing
    // saying why. A plain write replaces it, since there is no valid token to
    // race against.
    await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
    await chmod(tokenPath, 0o600);
  }
  await chmod(tokenPath, 0o600);
  // The home directory holds credentials and sessions too; an install that
  // predates this tightening must not leave the new token world-readable
  // through a traversable parent.
  await chmod(stratusHomePath(env), 0o700).catch(() => undefined);
  return token;
};

/**
 * Length-independent secret comparison.
 *
 * `timingSafeEqual` throws on a length mismatch, which is itself an oracle if
 * the caller branches on it — so both sides are hashed to a fixed width
 * first. Comparing raw strings with `===` would leak the shared prefix
 * length, which is exactly how a token is guessed a byte at a time.
 */
const secretEquals = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    // Still a constant-time comparison, against a value that cannot match:
    // returning early on length alone would answer "how long is the token".
    return timingSafeEqual(left, left) && false;
  }
  return timingSafeEqual(left, right);
};

const parseCookies = (header: string | undefined): Map<string, string> => {
  const cookies = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) {
      continue;
    }
    cookies.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return cookies;
};

const readBearer = (header: string | undefined): string | undefined => {
  if (!header) {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim();
};

export interface AuthenticatorOptions {
  token: string;
  /** Now, injectable so expiry is testable without waiting for it. */
  now?: () => number;
}

/**
 * Everything the API knows about who may talk to it: the bearer token, the
 * browser sessions minted from it, and the one-time tokens that bootstrap
 * those sessions.
 *
 * Sessions live in memory on purpose. A daemon restart logs the browser out,
 * which is honest — the process that vouched for it is gone — and it keeps
 * the API from growing a second durable secret store beside the credentials
 * file.
 */
export const createAuthenticator = (options: AuthenticatorOptions) => {
  const now = options.now ?? Date.now;
  const sessions = new Map<string, { expiresAt: number }>();
  const oneTimeTokens = new Map<string, { expiresAt: number }>();

  const sweep = (): void => {
    const at = now();
    for (const [id, session] of sessions) {
      if (session.expiresAt <= at) {
        sessions.delete(id);
      }
    }
    for (const [id, ott] of oneTimeTokens) {
      if (ott.expiresAt <= at) {
        oneTimeTokens.delete(id);
      }
    }
  };

  return {
    /**
     * Mint a one-time token for a browser handoff. Bearer-authenticated
     * callers only — this is how the CLI, which can read the token file,
     * lends its authority to a browser, which cannot.
     */
    mintOneTimeToken(): string {
      sweep();
      const ott = randomBytes(32).toString('base64url');
      oneTimeTokens.set(ott, { expiresAt: now() + OTT_TTL_MS });
      return ott;
    },

    /**
     * Spend a one-time token for a session id, or refuse.
     *
     * Deleted before it is judged: that ordering is what makes a second use
     * fail on absence rather than on a comparison, so a token replayed from a
     * browser history or a shoulder-surfed URL is spent whether or not the
     * first use succeeded.
     */
    redeemOneTimeToken(ott: string | undefined): string | undefined {
      sweep();
      if (!ott) {
        return undefined;
      }
      const record = oneTimeTokens.get(ott);
      oneTimeTokens.delete(ott);
      if (!record || record.expiresAt <= now()) {
        return undefined;
      }
      const sessionId = randomBytes(32).toString('base64url');
      sessions.set(sessionId, { expiresAt: now() + SESSION_TTL_MS });
      return sessionId;
    },

    sessionCookie(sessionId: string): string {
      // No `Secure`: the gateway serves plain HTTP on loopback, and a Secure
      // cookie would simply never be sent back — the flag would read as
      // hardening while silently breaking every request. Remote access is a
      // tunnel's job, and a tunnel terminates TLS in front of this.
      return `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
    },

    /** How a request identified itself, or undefined if it did not. */
    authenticate(request: Pick<IncomingMessage, 'headers'>): Principal | undefined {
      sweep();
      const bearer = readBearer(request.headers.authorization);
      if (bearer !== undefined) {
        // A malformed or wrong bearer token is a rejection, not a fallthrough
        // to the cookie: a client that presented a credential gets judged on
        // it, or a stale header would silently ride someone else's session.
        return secretEquals(bearer, options.token) ? { kind: 'bearer' } : undefined;
      }
      const sessionId = parseCookies(request.headers.cookie).get(SESSION_COOKIE);
      if (sessionId && sessions.has(sessionId)) {
        return { kind: 'cookie', sessionId };
      }
      return undefined;
    },

    /** Test seam: how many sessions are live. */
    sessionCount(): number {
      sweep();
      return sessions.size;
    },
  };
};

export type Authenticator = ReturnType<typeof createAuthenticator>;

/**
 * The origins a cookie-authenticated request may come from.
 *
 * `SameSite` matching ignores ports, so a page served from another port on
 * the same host counts as the same site and its requests carry this cookie
 * automatically; WebSockets get no CORS protection at all. Exact-origin
 * checking is what closes both, and it has to include the port.
 *
 * Loopback aliases are included because a person who types `localhost` is
 * reaching the same server on the same port — the address is a synonym, not
 * another origin. It reintroduces nothing: the port still has to match, so a
 * hostile page on another port of localhost is still rejected.
 */
export const isWildcardHost = (host: string): boolean => host === '0.0.0.0' || host === '::';

export const allowedOrigins = (host: string, port: number): Set<string> => {
  // Bracketed for IPv6, or the address's own colons run into the port and the
  // set contains a string no browser will ever send.
  const authority = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
  const origins = new Set([`http://${authority}`]);
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '::' || host === '0.0.0.0') {
    origins.add(`http://127.0.0.1:${port}`);
    origins.add(`http://localhost:${port}`);
    origins.add(`http://[::1]:${port}`);
  }
  return origins;
};

/**
 * Whether this request may act, given how it authenticated.
 *
 * Bearer requests are exempt: nothing attaches that header on a browser's
 * behalf, so a cross-origin page cannot cause one to be sent and an origin
 * check would only reject legitimate programmatic clients (which often send
 * no `Origin` at all).
 *
 * A cookie request with **no** `Origin` header is allowed only for reads.
 * Same-origin `GET`s from an address bar genuinely omit it, while every
 * cross-origin form post and WebSocket handshake sends one — so requiring it
 * on writes costs nothing real and closes the case where a client that omits
 * it would otherwise be trusted to change state.
 *
 * `sameOriginHost` is the request's own `Host` header, passed only for a
 * wildcard bind. `0.0.0.0` and `::` are not addresses a browser ever reaches
 * the daemon on, so the fixed set cannot name the LAN or Tailscale address
 * the operator opened the wildcard *for*: every write and every WebSocket
 * upgrade from it would be refused while the page itself loaded fine.
 * Matching the request's own `Host` is a true same-origin check and forges
 * nothing — a browser sets `Host` from the address it connected to, never
 * from the page making the request, so a page on another port or another
 * host still fails it, exactly as before.
 */
export const originAllowed = (
  principal: Principal,
  origin: string | undefined,
  stateChanging: boolean,
  origins: Set<string>,
  sameOriginHost?: string,
): boolean => {
  if (principal.kind === 'bearer') {
    return true;
  }
  if (origin === undefined) {
    return !stateChanging;
  }
  if (origins.has(origin)) {
    return true;
  }
  // Host names are case-insensitive; browsers send both headers lowercased,
  // but nothing guarantees it of the `Host` an operator's proxy rewrote.
  return sameOriginHost !== undefined
    && sameOriginHost.length > 0
    && origin.toLowerCase() === `http://${sameOriginHost.toLowerCase()}`;
};
