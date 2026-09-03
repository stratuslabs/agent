import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import path from 'node:path';

import type { Gateway, GatewayChannelAdapter } from '@stratusagent/gateway';
import { gatewayInfoPath, type StateEnvironment } from '@stratusagent/state';
import { WebSocketServer } from 'ws';

import {
  allowedOrigins,
  createAuthenticator,
  ensureGatewayToken,
  originAllowed,
  type Authenticator,
  type DashboardSession,
} from './auth.ts';
import { createEventStream, type EventFilter } from './events.ts';
import { API_PREFIX, ApiError, isStateChanging, sendError, sendJson } from './http.ts';
import { allowedMethodsFor, resolveRoute, type RouteContext } from './routes.ts';

export { API_PREFIX } from './http.ts';
export type { DashboardSession } from './auth.ts';
export type { EventEnvelope, EventFilter } from './events.ts';

/** Kept in step with package.json, the way the CLI keeps its own version. */
export const CONTROL_API_VERSION = '0.10.0';

/** The default port `stratusd` serves its API on. Loopback only. */
/** How long stop() lets an answer already being written finish before it closes the socket anyway. */
const IN_FLIGHT_RESPONSE_GRACE_MS = 2_000;

export const DEFAULT_CONTROL_API_PORT = 4123;
export const DEFAULT_CONTROL_API_HOST = '127.0.0.1';

/**
 * The web dashboard, when it is installed.
 *
 * The UI is a separate optional package because the two other consumers of
 * this API — the macOS app and a headless VM deployment — want the API and
 * not a web page. This package therefore serves `/api/v1` and nothing else
 * on its own; assets are something handed to it.
 */
export interface DashboardAssets {
  /** Serve this path, or report that there is no asset for it. */
  serve(pathname: string, response: ServerResponse): Promise<boolean>;
}

/**
 * Load the optional dashboard package, or undefined when it is absent.
 *
 * The same two-step the CLI uses for channels, for the same reason: only the
 * package failing to *resolve* means "not installed". A package that is
 * installed but broken throws ERR_MODULE_NOT_FOUND naming its own missing
 * dependency, and reading that as absence would silently serve no UI to
 * someone who installed one.
 */
const loadDashboardAssets = async (): Promise<DashboardAssets | undefined> => {
  try {
    import.meta.resolve('@stratusagent/dashboard');
  } catch {
    return undefined;
  }
  const { createDashboardAssets } = await import('@stratusagent/dashboard');
  return createDashboardAssets();
};

export interface ControlApiOptions {
  env?: StateEnvironment;
  /**
   * Interface to bind. Loopback is the posture: remote access is an
   * operator's tunnel decision, not a default this daemon makes for them.
   */
  host?: string;
  /** Port to bind. 0 picks a free one, which is what tests want. */
  port?: number;
  /** The config file the daemon was pinned to, if any. */
  configPath?: string;
  /**
   * The web UI. Left unset, the package is auto-loaded when installed —
   * installing it is the whole opt-in. Pass `false` to serve the API alone on
   * a headless deployment that has it present anyway.
   */
  ui?: DashboardAssets | false;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

export interface ControlApi extends GatewayChannelAdapter {
  /** Where it is listening, once started. */
  readonly url: string | undefined;
  /** The bearer token clients authenticate with, once started. */
  readonly token: string | undefined;
  /**
   * Take on a predecessor's dashboard sessions — at once if this API is
   * serving, at start otherwise. How an announced restart keeps a browser
   * signed in; see `createAuthenticator` for why nothing here reaches disk.
   */
  adoptSessions(sessions: DashboardSession[]): void;
  /**
   * The dashboard sessions that were live when stop() ran — what a daemon
   * stopping for a restart hands to the one replacing it. Empty until then.
   */
  sessionsAtStop(): DashboardSession[];
}

/**
 * A host and port as a URL authority.
 *
 * IPv6 literals have to be bracketed or the colons in the address run into
 * the port: `http://::1:4123` is not a URL, and an API that advertised it
 * would also fail every request, since that string is the base `new URL`
 * parses each incoming path against.
 */
export const authority = (host: string, port: number): string =>
  host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;

/** Refuse an upgrade without pretending it was ever a WebSocket. */
const refuseUpgrade = (socket: Duplex, status: number, reason: string): void => {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
};

/**
 * The HTTP + WebSocket face of a running gateway.
 *
 * Shaped as a channel adapter because that is exactly what it is: something
 * started after the roster loads and stopped before the store drains, which
 * turns inbound requests into dispatches. `stratus serve` runs it through the
 * same list it runs Slack through, so it needs no lifecycle of its own.
 */
export const createControlApi = (options: ControlApiOptions = {}): ControlApi => {
  const env = options.env ?? {};
  const log = options.log ?? (() => {});
  const warn = options.warn ?? (() => {});
  const host = options.host ?? DEFAULT_CONTROL_API_HOST;

  let server: Server | undefined;
  let wss: WebSocketServer | undefined;
  let auth: Authenticator | undefined;
  let stream: ReturnType<typeof createEventStream> | undefined;
  let url: string | undefined;
  let token: string | undefined;
  let origins = new Set<string>();
  // The address a browser reaches this daemon on is routinely not the one it
  // bound to — a wildcard bind, or a tunnel terminating TLS in front of a
  // loopback one — so the request's own Host answers for it. See
  // `originAllowed`, which is where that is safe rather than permissive.
  const sameOriginHost = (request: IncomingMessage): string | undefined => request.headers.host;
  let startedAt = Date.now();
  let ui: DashboardAssets | undefined;
  const inflightResponses = new Set<ServerResponse>();
  /** Set while stop() waits for the last in-flight answer to finish. */
  let responsesIdle: (() => void) | undefined;
  /** Sessions handed over before start() made an authenticator to hold them. */
  let pendingSessions: DashboardSession[] = [];
  /** What the last stop() found live, for the replacement. */
  let sessionsWhenStopped: DashboardSession[] = [];

  const handleApiRequest = async (
    gateway: Gateway,
    request: IncomingMessage,
    response: ServerResponse,
    requestUrl: URL,
  ): Promise<void> => {
    const method = request.method ?? 'GET';
    const resolved = resolveRoute(method, requestUrl.pathname);
    if (!resolved) {
      const allowed = allowedMethodsFor(requestUrl.pathname);
      if (allowed.length > 0) {
        response.setHeader('allow', allowed.join(', '));
        throw new ApiError(405, 'method_not_allowed', `${method} is not supported here. Try: ${allowed.join(', ')}.`);
      }
      throw new ApiError(404, 'not_found', `No route for ${method} ${requestUrl.pathname}.`);
    }

    const principal = auth?.authenticate(request);
    if (!resolved.route.selfAuthenticating) {
      if (!principal) {
        response.setHeader('www-authenticate', 'Bearer realm="stratus"');
        throw new ApiError(
          401,
          'unauthorized',
          'Send the token from ~/.stratus/gateway-token as an Authorization header, or open the dashboard with `stratus dashboard`.',
        );
      }
      if (resolved.route.bearerOnly && principal.kind !== 'bearer') {
        throw new ApiError(
          403,
          'bearer_required',
          'This endpoint needs the gateway token itself. A browser session cannot mint another session.',
        );
      }
      if (!originAllowed(principal, request.headers.origin, isStateChanging(method), origins, sameOriginHost(request))) {
        throw new ApiError(
          403,
          'origin_not_allowed',
          'A cookie-authenticated request must come from this gateway\'s own origin.',
        );
      }
    }

    const context: RouteContext = {
      gateway,
      env,
      configPath: options.configPath,
      principal,
      params: resolved.params,
      url: requestUrl,
      request,
      response,
      startedAt,
      mintOneTimeToken: () => {
        if (!auth) {
          throw new ApiError(503, 'not_ready', 'The control API is not serving yet.');
        }
        return auth.mintOneTimeToken();
      },
      redeemOneTimeToken: (ott) => auth?.redeemOneTimeToken(ott),
      sessionCookie: (sessionId, secure) => auth?.sessionCookie(sessionId, secure) ?? '',
      withTurn: (sessionId, turnId, work) => stream?.withTurn(sessionId, turnId, work) ?? work(),
      watchTurn: (sessionId, turnId) => stream?.watchTurn(sessionId, turnId)
        ?? { reported: () => false, release: () => {} },
      version: CONTROL_API_VERSION,
    };

    const payload = await resolved.route.handler(context);
    if (payload === null) {
      // The handler wrote its own response (a redirect).
      return;
    }
    sendJson(response, response.statusCode, payload);
  };

  const handleRequest = async (
    gateway: Gateway,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const requestUrl = new URL(request.url ?? '/', url ?? `http://${authority(host, 0)}`);

    if (requestUrl.pathname.startsWith('/api/')) {
      await handleApiRequest(gateway, request, response, requestUrl);
      return;
    }

    // Everything outside /api is the dashboard's, and it is authenticated
    // too: the shell carries no data, but serving it to an unauthenticated
    // caller only invites confusion about what this port is.
    if (!auth?.authenticate(request)) {
      response.statusCode = 401;
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.setHeader('cache-control', 'no-store');
      response.end(
        '<!doctype html><meta charset="utf-8"><title>Stratus</title>'
        + '<body style="font-family:system-ui;background:#05070f;color:#f3f7ff;padding:3rem">'
        + '<h1>Not signed in</h1><p>Run <code>stratus dashboard</code> to open an authenticated session.</p>',
      );
      return;
    }
    if (ui && (await ui.serve(requestUrl.pathname, response))) {
      return;
    }
    throw new ApiError(
      404,
      'no_dashboard',
      'This gateway serves the control API only. Install @stratusagent/dashboard for the web UI.',
    );
  };

  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const requestUrl = new URL(request.url ?? '/', url ?? `http://${authority(host, 0)}`);
    if (requestUrl.pathname !== `${API_PREFIX}/events`) {
      refuseUpgrade(socket, 404, 'Not Found');
      return;
    }
    const principal = auth?.authenticate(request);
    if (!principal) {
      refuseUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    // Treated as state-changing so a cookie upgrade with no Origin is
    // refused: WebSockets get no CORS protection at all, and every browser
    // sends an Origin on the handshake — so the only callers a missing one
    // can represent here are programmatic, and those use a bearer token.
    if (!originAllowed(principal, request.headers.origin, true, origins, sameOriginHost(request))) {
      refuseUpgrade(socket, 403, 'Forbidden');
      return;
    }

    const filter: EventFilter = {
      ...(requestUrl.searchParams.get('session') ? { sessionId: requestUrl.searchParams.get('session') as string } : {}),
      ...(requestUrl.searchParams.get('agent') ? { agentId: requestUrl.searchParams.get('agent') as string } : {}),
    };
    wss?.handleUpgrade(request, socket, head, (socket_) => {
      stream?.attach(socket_, filter);
    });
  };

  const writeGatewayInfo = async (): Promise<void> => {
    const infoPath = gatewayInfoPath(env);
    await mkdir(path.dirname(infoPath), { recursive: true, mode: 0o700 });
    await writeFile(
      infoPath,
      `${JSON.stringify({
        url,
        host,
        port: server ? (server.address() as { port: number }).port : undefined,
        pid: process.pid,
        version: CONTROL_API_VERSION,
        startedAt: new Date(startedAt).toISOString(),
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    // As with the token: writeFile's mode only applies on create, so an
    // existing file from a looser umask would keep its permissions.
    await chmod(infoPath, 0o600);
  };

  const removeGatewayInfo = async (): Promise<void> => {
    const infoPath = gatewayInfoPath(env);
    try {
      // Only ours. A second daemon that took the file over owns it now, and
      // deleting it would leave every client unable to find the live one.
      const existing = JSON.parse(await readFile(infoPath, 'utf8')) as { pid?: number };
      if (existing.pid !== process.pid) {
        return;
      }
    } catch {
      return;
    }
    await rm(infoPath, { force: true });
  };

  return {
    name: 'control-api',
    // A daemon whose API did not come up is one no `stratus` command and
    // no dashboard can reach, running on a home whose discovery file still
    // names whoever holds the port. The gateway would otherwise log the
    // bind failure and serve on without it — which is how a second
    // `stratus serve` on a home became a second daemon on its database.
    required: true,

    get url() {
      return url;
    },

    get token() {
      return token;
    },

    adoptSessions(sessions) {
      if (auth) {
        auth.adoptSessions(sessions);
      } else {
        pendingSessions.push(...sessions);
      }
    },

    sessionsAtStop() {
      return sessionsWhenStopped;
    },

    async start(gateway: Gateway) {
      startedAt = Date.now();
      ui = options.ui === false
        ? undefined
        : options.ui ?? await loadDashboardAssets();
      token = await ensureGatewayToken(env);
      auth = createAuthenticator({ token });
      auth.adoptSessions(pendingSessions);
      pendingSessions = [];
      stream = createEventStream(gateway);
      wss = new WebSocketServer({ noServer: true });

      server = createServer((request, response) => {
        // Tracked so stop() can let an answer already being written reach
        // its client before the sockets go — the 202 for the restart that
        // is stopping this server, above all.
        inflightResponses.add(response);
        const settled = (): void => {
          inflightResponses.delete(response);
          if (inflightResponses.size === 0) {
            responsesIdle?.();
          }
        };
        response.once('finish', settled);
        response.once('close', settled);
        void handleRequest(gateway, request, response).catch((error: unknown) => {
          if (!response.headersSent) {
            sendError(response, error);
            return;
          }
          warn(`control API failed after responding: ${error instanceof Error ? error.message : String(error)}`);
          response.end();
        });
      });
      server.on('upgrade', handleUpgrade);

      const listening = server;
      const asked = authority(host, options.port ?? DEFAULT_CONTROL_API_PORT);
      await new Promise<void>((resolve, reject) => {
        // The bind failing is the one start failure with a story worth
        // telling: another stratusd on this home, or another program on
        // the port. Node's own message names the address; this names what
        // to do about it.
        const onError = (error: Error): void => reject(new Error(
          `The control API could not listen on ${asked} (${error.message}). Another stratusd may be `
            + 'serving this address, or another program holds the port: pick a different one with `api.port` '
            + 'in the config or `stratus serve --api-port <port>`, or start with `--no-api`.',
        ));
        listening.once('error', onError);
        listening.listen(options.port ?? DEFAULT_CONTROL_API_PORT, host, () => {
          listening.off('error', onError);
          resolve();
        });
      });

      const address = listening.address();
      if (!address || typeof address === 'string') {
        throw new Error('The control API could not determine the address it bound.');
      }
      url = `http://${authority(host, address.port)}`;
      origins = allowedOrigins(host, address.port);
      await writeGatewayInfo();
      log(ui
        ? `control API on ${url} — dashboard served there; token in ~/.stratus/gateway-token`
        : `control API on ${url} — token in ~/.stratus/gateway-token`);
    },

    async stop() {
      stream?.close();
      stream = undefined;
      // Sockets first: an open WebSocket keeps `server.close()` waiting
      // forever, and a drain that never finishes is a daemon that will not
      // shut down.
      wss?.clients.forEach((socket) => socket.terminate());
      wss?.close();
      wss = undefined;
      const closing = server;
      server = undefined;
      if (closing) {
        // Answers in flight first, bounded: every handler here answers in
        // milliseconds, and one that did not must not hold the drain.
        // `closeAllConnections` below would otherwise cut a response the
        // handler has already committed to — a "socket hang up" for the
        // caller whose request was the last thing this daemon did.
        if (inflightResponses.size > 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, IN_FLIGHT_RESPONSE_GRACE_MS);
            responsesIdle = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          responsesIdle = undefined;
        }
        await new Promise<void>((resolve) => {
          closing.close(() => resolve());
          closing.closeAllConnections?.();
        });
      }
      await removeGatewayInfo().catch(() => undefined);
      ui = undefined;
      // Kept for the process that replaces this one, in memory only. A
      // second stop() has no authenticator and keeps the first one's answer.
      if (auth) {
        sessionsWhenStopped = auth.exportSessions();
      }
      auth = undefined;
      url = undefined;
      token = undefined;
    },
  };
};
