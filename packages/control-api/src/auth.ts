import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  await mkdir(path.dirname(tokenPath), { recursive: true, mode: 0o700 });

  const settle = async (value: string): Promise<string> => {
    await chmod(tokenPath, 0o600);
    // The home directory holds credentials and sessions too; an install that
    // predates this tightening must not leave the new token world-readable
    // through a traversable parent.
    await chmod(stratusHomePath(env), 0o700).catch(() => undefined);
    return value;
  };

  const existing = await readFile(tokenPath, 'utf8').then((raw) => raw.trim()).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    return undefined;
  });
  if (existing !== undefined) {
    if (existing.length === 0) {
      // A token file that holds nothing is corrupt, and this refuses it
      // rather than racing to repair it.
      //
      // Repair is what cannot be made safe: two daemons both see the empty
      // file, both replace it, one wins the disk, and the loser goes on
      // authenticating against a secret no client can read — the exact
      // lockout the exclusive claim below exists to prevent. Node exposes no
      // conditional replace (no `flock`, no `renameat2`), so there is no
      // unlink-and-retry that cannot delete the valid token another daemon
      // wrote a microsecond earlier. A loud refusal naming the file is one
      // command to fix and cannot lock anybody out.
      //
      // Nothing here produces this state any more: the claim below publishes
      // a fully-written file in a single atomic step, so a process killed
      // mid-write leaves a stray staging file rather than an empty token.
      throw new Error(
        `${tokenPath} is empty, which is not a usable gateway token. Delete it and start the daemon again.`,
      );
    }
    return settle(existing);
  }

  // 32 bytes of CSPRNG output. base64url so it survives a URL, a header, and
  // a shell argument without escaping.
  const token = randomBytes(32).toString('base64url');
  // Written to a private staging file first, then published with `link`,
  // which fails if the destination exists.
  //
  // Two things at once. `link` is the exclusive claim — of two daemons
  // starting together on a fresh home exactly one wins, and the loser reads
  // the winner's token instead of authenticating against a value no client
  // can read. And it publishes a file that is already complete, where
  // `writeFile` with `wx` creates an empty file and then fills it: a crash
  // in that window is what left the corrupt file refused above.
  const staging = `${tokenPath}.${randomBytes(8).toString('hex')}`;
  try {
    await writeFile(staging, `${token}\n`, { flag: 'wx', mode: 0o600 });
    try {
      await link(staging, tokenPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      const winner = (await readFile(tokenPath, 'utf8')).trim();
      if (winner.length === 0) {
        throw new Error(
          `${tokenPath} is empty, which is not a usable gateway token. Delete it and start the daemon again.`,
        );
      }
      return settle(winner);
    }
  } finally {
    await rm(staging, { force: true });
  }
  return settle(token);
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

/** A browser session, as handed from one daemon process to the next. */
export interface DashboardSession {
  id: string;
  /** Epoch milliseconds; a handed session keeps the expiry it was minted with. */
  expiresAt: number;
  /**
   * `tokenFingerprint` of the bearer token whose holder minted it. A
   * replacement adopts a session only under the same token: rotating
   * `~/.stratus/gateway-token` must sign every browser out, and a restart
   * across the rotation must not carry the old token's sessions past it.
   */
  vouchedBy: string;
}

/**
 * Identifies a bearer token without being one: enough of a hash to tell two
 * tokens apart, never enough to recover either. What a handed session names
 * as the credential it was minted under.
 */
export const tokenFingerprint = (token: string): string =>
  createHash('sha256').update(token).digest('hex').slice(0, 16);

/**
 * Everything the API knows about who may talk to it: the bearer token, the
 * browser sessions minted from it, and the one-time tokens that bootstrap
 * those sessions.
 *
 * Sessions live in memory on purpose, and are never written down: the API
 * must not grow a second durable secret store beside the credentials file.
 * An announced restart hands them from the stopping process to the one
 * replacing it (`exportSessions` / `adoptSessions`, over the supervisor's
 * IPC channel), so `stratus restart` does not log the dashboard out. A
 * crash or a plain stop still does, which is honest — the process that
 * vouched for the session is gone, and nothing on disk says otherwise.
 */
export const createAuthenticator = (options: AuthenticatorOptions) => {
  const now = options.now ?? Date.now;
  const vouchedBy = tokenFingerprint(options.token);
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

    /**
     * The cookie to set, `Secure` exactly when the exchange arrived over TLS.
     *
     * Not unconditional: the gateway serves plain HTTP on loopback, and a
     * `Secure` cookie would never be sent back there — the flag would read as
     * hardening while silently breaking every request. Not unconditionally
     * absent either, which is what this was: cookies are scoped by host, not
     * by scheme or port, so a session minted through a TLS-terminating tunnel
     * and left flagless rides any later plain-HTTP request to that same public
     * hostname — the redirect-to-HTTPS request above all — in cleartext.
     *
     * So it follows the exchange. `secure` comes from the proxy's own
     * `x-forwarded-proto`, which is safe to read here because this exchange is
     * a top-level browser navigation: a page cannot attach that header to one.
     */
    sessionCookie(sessionId: string, secure = false): string {
      return `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? '; Secure' : ''}`;
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

    /** Every live session, for the hand-off to a replacement process. Never for disk. */
    exportSessions(): DashboardSession[] {
      sweep();
      return [...sessions].map(([id, session]) => ({ id, expiresAt: session.expiresAt, vouchedBy }));
    },

    /**
     * Sessions a predecessor handed over, each with the expiry it was
     * minted with — a hand-off extends nothing. One already expired is
     * dropped rather than kept for the next sweep to find, and one minted
     * under another bearer token is dropped too (see DashboardSession).
     */
    adoptSessions(handed: DashboardSession[]): void {
      const at = now();
      for (const session of handed) {
        if (session.expiresAt > at && session.vouchedBy === vouchedBy) {
          sessions.set(session.id, { expiresAt: session.expiresAt });
        }
      }
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
 * `sameOriginHost` is the request's own `Host` header, and an origin that
 * matches it is accepted under either scheme. That is a true same-origin
 * check rather than a loosening: a browser sets `Host` from the address it
 * connected to, never from the page making the request, and cannot be made
 * to send a different one — `Host` is a forbidden header name for `fetch`,
 * `XMLHttpRequest`, forms, and WebSockets alike. A page on another port or
 * another host still fails, which is the case `SameSite` cannot cover and
 * the whole reason this check exists.
 *
 * It is needed because the fixed set can only name the address the daemon
 * bound to, and that is routinely not the address a browser reaches it on:
 *
 * - a wildcard bind (`0.0.0.0`, `::`) is reached over a LAN or Tailscale
 *   address the daemon cannot know when it binds;
 * - a tunnel or reverse proxy — the documented way to reach a loopback
 *   daemon remotely — terminates TLS in front of it, so the browser's origin
 *   is `https://gateway.example` while this server speaks plain HTTP.
 *
 * In both, the page loads and then every write and every WebSocket upgrade
 * is refused, which reads as a broken dashboard rather than as a policy.
 * Accepting `https://` costs nothing: an attacker would have to serve TLS on
 * this very host and port, which means already being this server.
 */
/**
 * The scheme a request arrived on, as far as this daemon can tell.
 *
 * The socket is always plain HTTP, so this is the proxy's word for what it
 * terminated in front of us — read for the cookie's `Secure` flag and the
 * sign-in link's origin, and nothing that grants access.
 */
export const requestScheme = (forwardedProto: string | string[] | undefined): 'http' | 'https' => {
  const first = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)?.split(',')[0]?.trim();
  return first?.toLowerCase() === 'https' ? 'https' : 'http';
};

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
  if (sameOriginHost === undefined || sameOriginHost.length === 0) {
    return false;
  }
  // Host names are case-insensitive; browsers send both headers lowercased,
  // but nothing guarantees it of the `Host` an operator's proxy rewrote.
  const host = sameOriginHost.toLowerCase();
  const candidate = origin.toLowerCase();
  return candidate === `http://${host}` || candidate === `https://${host}`;
};
