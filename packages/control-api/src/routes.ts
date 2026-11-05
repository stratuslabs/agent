import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentGrantStore } from '@stratusagent/permissions';
import type { Gateway } from '@stratusagent/gateway';
import { DEFAULT_STRATUS_AGENT, type StateEnvironment } from '@stratusagent/state';

import type { Principal } from './auth.ts';
import type { CredentialLinkStore } from './credential-links.ts';
import { matchPath } from './http.ts';

import { authRoutes } from './routes/auth.ts';
import { healthRoutes } from './routes/health.ts';
import { rosterRoutes } from './routes/roster.ts';
import { sessionRoutes } from './routes/sessions.ts';
import { grantRoutes } from './routes/grants.ts';
import { memoryPassRoutes } from './routes/memory-passes.ts';
import { approvalRoutes } from './routes/approvals.ts';
import { scheduleRoutes } from './routes/schedules.ts';
import { eventRoutes } from './routes/events.ts';
import { catalogRoutes } from './routes/catalog.ts';
import { credentialRoutes } from './routes/credentials.ts';
import { configRoutes } from './routes/config.ts';

/**
 * What the daemon met while starting, for `stratus doctor`: a config read at
 * start is the one the daemon runs on until it restarts, so the file as it is
 * now can be healthy while the process is not. The warnings are the daemon's
 * own startup log lines, never conversation content.
 */
export interface DaemonStartup {
  /** Each `warn` line from the start, in order. */
  warnings: string[];
  /** Every config file the start consulted, in precedence order, and a digest of each then (null: absent), so a later edit, a new file or a removed one can be told apart. */
  configs?: Array<{ path: string; sha256: string | null }>;
}

export interface RouteContext {
  gateway: Gateway;
  env: StateEnvironment;
  configPath: string | undefined;
  /** The daemon's grant store, when it was started with one. See `ControlApiOptions.grants`. */
  grants: AgentGrantStore | undefined;
  /** See `ControlApiOptions.configCommands`. */
  configCommands: ((agentId: string) => string[]) | undefined;
  /**
   * How the caller authenticated, or undefined on the one route that
   * authenticates itself (see `selfAuthenticating` below).
   */
  principal: Principal | undefined;
  params: Record<string, string>;
  url: URL;
  request: IncomingMessage;
  response: ServerResponse;
  /** When the daemon's API bound, for uptime. */
  startedAt: number;
  /** What the host met while starting. See `ControlApiOptions.startup`. */
  startup: (() => DaemonStartup) | undefined;
  /** Mint a one-time browser token. Bearer callers only. */
  mintOneTimeToken: () => string;
  /** Spend one, yielding a session id. */
  redeemOneTimeToken: (ott: string | undefined) => string | undefined;
  sessionCookie: (sessionId: string, secure?: boolean) => string;
  /**
   * Emit within a turn's identity, for events the gateway can no longer
   * attribute itself. See `createEventStream`.
   */
  withTurn: (sessionId: string, turnId: string, work: () => Promise<void>) => Promise<void>;
  /**
   * Watch a turn for a terminal event of its own. See `createEventStream`:
   * this is how a rejected dispatch tells a failure the runner reported from
   * one that never reached the runner.
   */
  watchTurn: (sessionId: string, turnId: string) => { reported: () => boolean; release: () => void };
  /** The tokens behind credential links. See `createCredentialLinkStore`. */
  credentialLinks: CredentialLinkStore;
  version: string;
}

/**
 * A handler returns the JSON body to send, or `null` when it has already
 * written the response itself (a redirect).
 */
type Handler = (context: RouteContext) => Promise<unknown>;

export interface Route {
  method: string;
  pattern: string;
  handler: Handler;
  /**
   * Bearer-only. The one-time-token mint is the bootstrap for cookie
   * sessions, so a cookie must not be able to mint another: that would turn
   * a stolen session into a permanent, re-shareable credential.
   */
  bearerOnly?: boolean;
  /**
   * Carries its own credential, so the bearer/cookie gate does not apply.
   *
   * Two routes are this, each judging a single-use, short-lived token in
   * its own address. The one-time-token exchange exists because a browser
   * has neither of the other two credentials yet: requiring a session to
   * get a session would make the dashboard unreachable. A credential link
   * exists for a person who may have neither, and its token can do exactly
   * one thing: answer the one credential request it was minted for, add-only.
   */
  selfAuthenticating?: boolean;
}

// One module per resource, spread in the order of the single list they came
// from: resolveRoute takes the first match, and allowedMethodsFor reports
// methods in this order.
export const routes: Route[] = [
  ...authRoutes,
  ...healthRoutes,
  ...rosterRoutes,
  ...sessionRoutes,
  ...grantRoutes,
  ...memoryPassRoutes,
  ...approvalRoutes,
  ...scheduleRoutes,
  ...eventRoutes,
  ...catalogRoutes,
  ...credentialRoutes,
  ...configRoutes,
];

/** Find the route for a request, or undefined. */
export const resolveRoute = (
  method: string,
  pathname: string,
): { route: Route; params: Record<string, string> } | undefined => {
  for (const route of routes) {
    if (route.method !== method) {
      continue;
    }
    const matched = matchPath(route.pattern, pathname);
    if (matched) {
      return { route, params: matched.params };
    }
  }
  return undefined;
};

/**
 * Whether any route exists at this path under another method, so a wrong verb
 * answers 405 rather than 404 — the difference between "you typed the path
 * wrong" and "you used the wrong verb".
 */
export const allowedMethodsFor = (pathname: string): string[] =>
  routes.filter((route) => matchPath(route.pattern, pathname)).map((route) => route.method);

export const BUILT_IN_AGENT_ID = DEFAULT_STRATUS_AGENT.id;
