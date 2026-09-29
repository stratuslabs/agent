import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';

import {
  gatewayTokenPath,
  hashApiToken,
  stratusHomePath,
  type ApiTokenRecord,
  type StateEnvironment,
} from '@stratusagent/state';

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

/**
 * Whose authority a request carries, whichever way it arrived.
 *
 * `operator` is the gateway token file and every session minted from it:
 * the whole API. `member` is a token from `~/.stratus/api-tokens.json`, and
 * every session minted from one: the roster, conversations, events, and
 * approvals, but none of the routes that rewrite what the operator decided
 * the daemon trusts. Every token this daemon accepts is one its own home
 * issued, so each is bound to this daemon's tenant by construction — a
 * hosted deployment runs one home and one daemon per tenant.
 */
export type PrincipalRole =
  | { role: 'operator' }
  | {
      role: 'member';
      /** The token's id in the file, so a revoke can find every session it vouched for. */
      tokenId: string;
      /** Who holds it: what an approval this principal answers records. */
      tokenName: string;
    };

/** How a request proved it may be here, and with whose authority. */
export type Principal = (
  /**
   * A token, sent as a header. Carries no ambient authority: nothing
   * attaches it automatically, so a page on another origin cannot cause one
   * to be sent, and origin checks do not apply.
   */
  | { kind: 'bearer' }
  /**
   * A browser session cookie. Ambient — the browser attaches it to any
   * request to this host — so every state-changing use of one is origin-bound.
   */
  | { kind: 'cookie'; sessionId: string }
) & PrincipalRole;

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
  /** The operator token: `~/.stratus/gateway-token`. */
  token: string;
  /**
   * The member tokens accepted right now. Asked on every member
   * authentication, never cached, so a revoke takes effect on the next
   * request (see `authenticate`). Omitted, no member token authenticates.
   */
  memberTokens?: () => Promise<ApiTokenRecord[]>;
  /** Told when the member list could not be read, which refuses every member until it can. */
  warn?: (line: string) => void;
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
   * For a member session, the member token's fingerprint, which the
   * replacement checks against the file on every request.
   */
  vouchedBy: string;
  /**
   * Absent on a session handed over by a build that predates roles, and
   * read as `operator` — correctly, because such a build had one token to
   * mint sessions with and it was the operator's. `vouchedBy` still has to
   * match that token for the session to be adopted at all.
   */
  role?: 'operator' | 'member';
  /** Member sessions: the minting token's id. */
  tokenId?: string;
  /** Member sessions: the minting token's name. */
  tokenName?: string;
}

/**
 * Identifies a bearer token without being one: enough of a hash to tell two
 * tokens apart, never enough to recover either. What a handed session names
 * as the credential it was minted under.
 */
export const tokenFingerprint = (token: string): string =>
  createHash('sha256').update(token).digest('hex').slice(0, 16);

/**
 * Everything the API knows about who may talk to it: the operator token,
 * the member tokens, the browser sessions minted from either, and the
 * one-time tokens that bootstrap those sessions.
 *
 * Sessions live in memory on purpose, and are never written down: the API
 * must not grow a second durable secret store beside the credentials file.
 * An announced restart hands them from the stopping process to the one
 * replacing it (`exportSessions` / `adoptSessions`, over the supervisor's
 * IPC channel), so `stratus restart` does not log the dashboard out. A
 * crash or a plain stop still does, which is honest — the process that
 * vouched for the session is gone, and nothing on disk says otherwise.
 *
 * A session keeps the role of the token that minted it, so a member cannot
 * climb to operator by way of a browser.
 */
export const createAuthenticator = (options: AuthenticatorOptions) => {
  const now = options.now ?? Date.now;
  const warn = options.warn ?? (() => {});
  const vouchedBy = tokenFingerprint(options.token);
  interface Held {
    expiresAt: number;
    holder: PrincipalRole;
    /** The minting token's fingerprint: the operator's, or the member's. */
    vouchedBy: string;
  }
  const sessions = new Map<string, Held>();
  const oneTimeTokens = new Map<string, Held>();
  let lastWarning: string | undefined;

  /**
   * The member tokens as of this moment.
   *
   * Read afresh on every member authentication — never cached, and never
   * keyed on the file's mtime. A cache is what would let a revoked token
   * keep working, the one thing this must not do: mtime has one-second
   * granularity on some filesystems, so a revoke landing in the same tick
   * as the last read, at the same size, would look like no change at all.
   * The file is a few hundred bytes and only member requests pay for it;
   * the operator token is judged before this is ever called, so a broken
   * file cannot lock the operator out of repairing it.
   */
  const currentMembers = async (): Promise<ApiTokenRecord[]> => {
    if (!options.memberTokens) {
      return [];
    }
    try {
      const members = await options.memberTokens();
      lastWarning = undefined;
      return members;
    } catch (error) {
      // Fails closed: an unreadable list authenticates no member. Said once
      // per distinct failure rather than once per request.
      const line = `member tokens refused until this is fixed: ${error instanceof Error ? error.message : String(error)}`;
      if (line !== lastWarning) {
        lastWarning = line;
        warn(line);
      }
      return [];
    }
  };

  /**
   * Whether a member token still stands. By id — `tok_` plus 48 bits from
   * the CSPRNG, never reissued, so a token revoked and re-created under the
   * same name is a different id — and by fingerprint when the caller holds
   * one, which a session always does.
   */
  const memberStillHeld = async (tokenId: string, fingerprint: string | undefined): Promise<boolean> =>
    (await currentMembers()).some((record) =>
      record.id === tokenId && (fingerprint === undefined || record.hash.startsWith(fingerprint)));

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
     * Mint a one-time token for a browser handoff, carrying the minter's
     * role into the session it becomes. Bearer-authenticated callers only —
     * this is how the CLI, which can read the token file, lends its
     * authority to a browser, which cannot.
     */
    async mintOneTimeToken(minter: PrincipalRole): Promise<string> {
      sweep();
      let holder: PrincipalRole = { role: 'operator' };
      let fingerprint = vouchedBy;
      if (minter.role === 'member') {
        const record = (await currentMembers()).find((entry) => entry.id === minter.tokenId);
        if (!record) {
          throw new Error(`Member token ${minter.tokenId} was revoked, so it cannot lend a browser its authority.`);
        }
        // `tokenFingerprint` of the member token, which its stored hash
        // already begins with: the same fingerprint an operator session
        // carries of the gateway token.
        holder = { role: 'member', tokenId: record.id, tokenName: record.name };
        fingerprint = record.hash.slice(0, 16);
      }
      const ott = randomBytes(32).toString('base64url');
      oneTimeTokens.set(ott, { expiresAt: now() + OTT_TTL_MS, holder, vouchedBy: fingerprint });
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
      sessions.set(sessionId, { expiresAt: now() + SESSION_TTL_MS, holder: record.holder, vouchedBy: record.vouchedBy });
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

    /**
     * How a request identified itself, or undefined if it did not.
     *
     * Asynchronous because a member is judged against the token file as it
     * is now: a revoked token, and every session it minted, stops working
     * on the next request with no restart.
     */
    async authenticate(request: Pick<IncomingMessage, 'headers'>): Promise<Principal | undefined> {
      sweep();
      const bearer = readBearer(request.headers.authorization);
      if (bearer !== undefined) {
        // A malformed or wrong bearer token is a rejection, not a fallthrough
        // to the cookie: a client that presented a credential gets judged on
        // it, or a stale header would silently ride someone else's session.
        if (secretEquals(bearer, options.token)) {
          return { kind: 'bearer', role: 'operator' };
        }
        // Compared as hashes, which is all the file holds, and in constant
        // time like the operator token.
        const hashed = hashApiToken(bearer);
        const member = (await currentMembers()).find((record) => secretEquals(record.hash, hashed));
        return member ? { kind: 'bearer', role: 'member', tokenId: member.id, tokenName: member.name } : undefined;
      }
      const sessionId = parseCookies(request.headers.cookie).get(SESSION_COOKIE);
      const session = sessionId !== undefined ? sessions.get(sessionId) : undefined;
      if (sessionId === undefined || session === undefined) {
        return undefined;
      }
      if (session.holder.role === 'operator') {
        return { kind: 'cookie', sessionId, role: 'operator' };
      }
      if (!(await memberStillHeld(session.holder.tokenId, session.vouchedBy))) {
        // Revoked since it was minted: forgotten, not just refused.
        sessions.delete(sessionId);
        return undefined;
      }
      return { kind: 'cookie', sessionId, ...session.holder };
    },

    /**
     * Whether the credential behind a principal still stands — for a
     * connection that outlives the request that opened it, the event
     * stream above all. The operator token is fixed for the life of the
     * process; a member's is judged against the file as it is now.
     */
    async stillHeld(principal: Principal): Promise<boolean> {
      if (principal.kind === 'cookie') {
        // Expired sessions go first: a browser session is held for its
        // twelve hours and no longer, and a stream opened in hour eleven
        // must not carry it past them — the operator's included.
        sweep();
        const session = sessions.get(principal.sessionId);
        if (session === undefined) {
          return false;
        }
        return principal.role === 'operator' || memberStillHeld(principal.tokenId, session.vouchedBy);
      }
      if (principal.role === 'operator') {
        return true;
      }
      return memberStillHeld(principal.tokenId, undefined);
    },

    /** Test seam: how many sessions are live. */
    sessionCount(): number {
      sweep();
      return sessions.size;
    },

    /** Every live session, for the hand-off to a replacement process. Never for disk. */
    exportSessions(): DashboardSession[] {
      sweep();
      return [...sessions].map(([id, session]) => ({
        id,
        expiresAt: session.expiresAt,
        vouchedBy: session.vouchedBy,
        role: session.holder.role,
        ...(session.holder.role === 'member'
          ? { tokenId: session.holder.tokenId, tokenName: session.holder.tokenName }
          : {}),
      }));
    },

    /**
     * Sessions a predecessor handed over, each with the expiry it was
     * minted with — a hand-off extends nothing. One already expired is
     * dropped rather than kept for the next sweep to find, and an operator
     * session minted under another gateway token is dropped too (see
     * DashboardSession). A member session is taken on as a member and
     * judged against the token file on its first request, like any other.
     * A role this build does not know is dropped, never guessed upward.
     */
    adoptSessions(handed: DashboardSession[]): void {
      const at = now();
      for (const session of handed) {
        if (session.expiresAt <= at) {
          continue;
        }
        // No role is a predecessor that predates roles, whose one token was
        // the operator's: operator, under the same fingerprint rule.
        if (session.role === undefined || session.role === 'operator') {
          if (session.vouchedBy === vouchedBy) {
            sessions.set(session.id, { expiresAt: session.expiresAt, holder: { role: 'operator' }, vouchedBy });
          }
          continue;
        }
        if (session.role === 'member' && typeof session.tokenId === 'string' && typeof session.tokenName === 'string') {
          sessions.set(session.id, {
            expiresAt: session.expiresAt,
            holder: { role: 'member', tokenId: session.tokenId, tokenName: session.tokenName },
            vouchedBy: session.vouchedBy,
          });
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
