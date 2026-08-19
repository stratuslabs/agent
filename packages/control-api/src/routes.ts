import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

import { formatSoul, isValidAgentId, parseSoul, type ParsedSoul } from '@stratusagent/agents';
import type { JsonObject } from '@stratusagent/core';
import type { Gateway } from '@stratusagent/gateway';
import { redactAnthropicRawTurns } from '@stratusagent/provider-anthropic';
import {
  claimSoulFile,
  collectAvailableModels,
  DEFAULT_STRATUS_AGENT,
  discoverActiveConfig,
  globalConfigPath,
  listAgentSummaries,
  loadChannelCredentials,
  loadConfigFile,
  loadCredentials,
  loadSoulFile,
  parseProviderName,
  resolveConfigLocation,
  saveChannelCredentials,
  saveConfigFile,
  saveCredentials,
  servedRuntimes,
  verifyProviderKey,
  type CredentialProviderName,
  type RuntimeConfig,
  type StateEnvironment,
  type StratusConfigFile,
} from '@stratusagent/state';

import type { Principal } from './auth.ts';
import {
  API_PREFIX,
  ApiError,
  matchPath,
  optionalString,
  readJsonObject,
  requireString,
} from './http.ts';

export interface RouteContext {
  gateway: Gateway;
  env: StateEnvironment;
  configPath: string | undefined;
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
  /** Mint a one-time browser token. Bearer callers only. */
  mintOneTimeToken: () => string;
  /** Spend one, yielding a session id. */
  redeemOneTimeToken: (ott: string | undefined) => string | undefined;
  sessionCookie: (sessionId: string) => string;
  version: string;
}

/**
 * A handler returns the JSON body to send, or `null` when it has already
 * written the response itself (a redirect).
 */
type Handler = (context: RouteContext) => Promise<unknown>;

interface Route {
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
   * Exactly one route can be this: the one-time-token exchange, which exists
   * because a browser has neither of the other two credentials yet. The token
   * in its query string is single-use and short-lived, and the handler judges
   * it. Requiring a session to get a session would make the dashboard
   * unreachable.
   */
  selfAuthenticating?: boolean;
}

// ---- helpers ---------------------------------------------------------------

const CONFIG_KEYS = [
  'provider',
  'model',
  'baseUrl',
  'apiKeyEnv',
  'systemPrompt',
  'soul',
  'fallbackModel',
  'fallbackProvider',
  'fallbackBaseUrl',
  'approvals',
] as const;

/**
 * Where the daemon's settings live, for this API's purposes: the file it was
 * pinned to with `--config`, or the global `~/.stratus/config.json`.
 *
 * Deliberately NOT the full discovery chain. That chain prefers an
 * auto-discovered project-local `stratus.config.json`, which is a file that
 * ships in a repository — writing settings into somebody's checked-out repo
 * because the daemon happened to start there would surprise everyone, and the
 * `api` and `approvals` blocks in such a file are ignored anyway. So this
 * endpoint edits a config the operator actually chose.
 */
const activeConfigPath = async (context: RouteContext): Promise<string> => {
  if (!context.configPath) {
    return globalConfigPath(context.env);
  }
  const location = await resolveConfigLocation({ configPath: context.configPath }, context.env);
  return location?.path ?? globalConfigPath(context.env);
};

/** Validate a provider name, reporting a bad one as the client's error. */
const validateProvider = (value: string, field: string): void => {
  try {
    parseProviderName(value, field);
  } catch (error) {
    // The shared parser throws a plain Error, which would surface as a 500 —
    // a value the caller typed is not a server fault.
    throw new ApiError(400, 'invalid_provider', error instanceof Error ? error.message : String(error));
  }
};

/**
 * How a resolved runtime got its credentials, without ever naming the
 * secret. Enough for an operator to see why a run is billing where it is.
 */
const credentialSource = (runtime: RuntimeConfig): string => {
  if (runtime.provider === 'demo') {
    return 'none';
  }
  if (runtime.provider === 'anthropic' && runtime.authToken) {
    return 'subscription';
  }
  return runtime.apiKeyEnvVar ? `environment (${runtime.apiKeyEnvVar})` : 'stored';
};

/** The soul file backing an agent, or a 404 naming the id. */
const soulForAgent = async (
  context: RouteContext,
  agentId: string,
): Promise<{ soul: ParsedSoul; path: string }> => {
  const summaries = await listAgentSummaries(context.env);
  const summary = summaries.find((entry) => entry.id === agentId);
  if (!summary) {
    throw new ApiError(404, 'agent_not_found', `No agent with id ${agentId}.`);
  }
  if (!summary.soulPath) {
    throw new ApiError(
      409,
      'agent_not_editable',
      `${agentId} is the built-in agent and has no soul file to edit. Create your own agent instead.`,
    );
  }
  return { soul: await loadSoulFile(summary.soulPath), path: summary.soulPath };
};

const parseProviderParam = (value: string): CredentialProviderName => {
  if (value !== 'anthropic' && value !== 'openai') {
    throw new ApiError(400, 'unknown_provider', `Credentials are stored for anthropic and openai, not ${value}.`);
  }
  return value;
};

// ---- routes ----------------------------------------------------------------

export const routes: Route[] = [
  // ---- auth ----------------------------------------------------------------
  {
    method: 'POST',
    pattern: `${API_PREFIX}/auth/ott`,
    bearerOnly: true,
    async handler(context) {
      const ott = context.mintOneTimeToken();
      return {
        ott,
        // Absolute, so the caller opens exactly the origin this token is
        // bound to rather than reassembling one and missing the port.
        url: `${context.url.origin}${API_PREFIX}/auth/session?ott=${encodeURIComponent(ott)}`,
      };
    },
  },
  {
    method: 'GET',
    pattern: `${API_PREFIX}/auth/session`,
    selfAuthenticating: true,
    async handler(context) {
      const sessionId = context.redeemOneTimeToken(context.url.searchParams.get('ott') ?? undefined);
      if (!sessionId) {
        throw new ApiError(
          401,
          'invalid_one_time_token',
          'That link has already been used or has expired. Run `stratus dashboard` again for a fresh one.',
        );
      }
      context.response.statusCode = 302;
      context.response.setHeader('set-cookie', context.sessionCookie(sessionId));
      context.response.setHeader('location', '/');
      context.response.setHeader('cache-control', 'no-store');
      context.response.end();
      return null;
    },
  },

  // ---- health --------------------------------------------------------------
  {
    method: 'GET',
    pattern: `${API_PREFIX}/health`,
    async handler(context) {
      const summaries = await listAgentSummaries(context.env);
      const sessions = context.gateway.store.list();
      const byStatus: Record<string, number> = {};
      for (const session of sessions) {
        byStatus[session.status] = (byStatus[session.status] ?? 0) + 1;
      }

      // Every distinct runtime the daemon would serve, deduped. Deliberately
      // NOT probed: a monitoring view polls this, and a live call per poll
      // would spend the operator's rate limit to tell them what resolution
      // already knows.
      const runtimes = new Map<string, { provider: string; model?: string; credentials: string }>();
      for (const served of await servedRuntimes(context.env, context.configPath)) {
        const model = served.runtime.provider === 'demo' ? undefined : served.runtime.model;
        const entry = {
          provider: served.runtime.provider,
          ...(model ? { model } : {}),
          credentials: credentialSource(served.runtime),
        };
        runtimes.set(`${entry.provider}:${model ?? ''}:${entry.credentials}`, entry);
      }

      return {
        ok: true,
        version: context.version,
        startedAt: new Date(context.startedAt).toISOString(),
        uptimeMs: Date.now() - context.startedAt,
        agents: summaries.map((summary) => ({
          id: summary.id,
          name: summary.name,
          default: summary.default,
          builtIn: summary.builtIn,
          runsOn: summary.runsOn,
        })),
        sessions: { total: sessions.length, byStatus },
        approvals: { pending: context.gateway.pendingApprovals().length },
        runtimes: [...runtimes.values()],
      };
    },
  },

  // ---- roster --------------------------------------------------------------
  {
    method: 'GET',
    pattern: `${API_PREFIX}/agents`,
    async handler(context) {
      return { agents: await listAgentSummaries(context.env) };
    },
  },
  {
    method: 'POST',
    pattern: `${API_PREFIX}/agents`,
    async handler(context) {
      const body = await readJsonObject(context.request);
      const instructions = requireString(body, 'instructions');
      const name = optionalString(body, 'name');
      const provider = optionalString(body, 'provider');
      const model = optionalString(body, 'model');
      if (provider !== undefined) {
        // Validated through the shared parser, so the API cannot write a soul
        // the resolver would later refuse.
        validateProvider(provider, 'provider');
      }

      const notes: string[] = [];
      const claimed = await claimSoulFile(
        context.env,
        { ...(name ? { name } : {}), instructions },
        (agent) => formatSoul({
          agent,
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {}),
        }),
        (message) => notes.push(message),
      );

      // The new soul is dispatchable immediately: 07 creates an agent and
      // expects to talk to it without restarting the daemon.
      await context.gateway.reloadRoster();
      context.response.statusCode = 201;
      return {
        agent: claimed.agent,
        soulPath: claimed.soulPath,
        ...(notes.length > 0 ? { notes } : {}),
      };
    },
  },
  {
    method: 'PUT',
    pattern: `${API_PREFIX}/agents/:id`,
    async handler(context) {
      const agentId = context.params.id ?? '';
      const body = await readJsonObject(context.request);
      const { soul: current, path: soulPath } = await soulForAgent(context, agentId);

      const raw = optionalString(body, 'soul');
      let next: ParsedSoul;
      if (raw !== undefined) {
        // A raw edit still round-trips through the parser: the app offers a
        // markdown view, and a soul the daemon cannot read must be refused
        // here rather than discovered on the next dispatch.
        try {
          next = parseSoul(raw, { seed: soulPath });
        } catch (error) {
          throw new ApiError(400, 'invalid_soul', `That soul does not parse: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        const provider = optionalString(body, 'provider');
        const model = optionalString(body, 'model');
        if (provider !== undefined && provider.length > 0) {
          validateProvider(provider, 'provider');
        }
        next = {
          agent: {
            ...current.agent,
            ...(optionalString(body, 'name') !== undefined ? { name: optionalString(body, 'name') as string } : {}),
            ...(optionalString(body, 'instructions') !== undefined
              ? { instructions: optionalString(body, 'instructions') as string }
              : {}),
            ...(Array.isArray(body.tools) ? { tools: body.tools.map(String) } : {}),
            ...(Array.isArray(body.credentials) ? { credentials: body.credentials.map(String) } : {}),
          },
          // An empty string clears a pin; an absent key leaves it alone.
          ...(provider === undefined ? (current.provider ? { provider: current.provider } : {}) : (provider ? { provider } : {})),
          ...(model === undefined ? (current.model ? { model: current.model } : {}) : (model ? { model } : {})),
        };
      }

      if (next.agent.id !== agentId) {
        // An id is the key for sessions, memory, and credentials. Letting an
        // edit change it would not rename an agent — it would hand this
        // agent's history to a different identity.
        throw new ApiError(
          409,
          'agent_id_immutable',
          `That soul declares id ${next.agent.id}, not ${agentId}. Ids key sessions, memory, and credentials, so they cannot be edited in place.`,
        );
      }
      if (!isValidAgentId(next.agent.id)) {
        throw new ApiError(400, 'invalid_agent_id', `${next.agent.id} is not a usable agent id.`);
      }

      const rendered = formatSoul(next);
      // Re-parsed before it is written: `formatSoul` is the inverse of
      // `parseSoul`, and the only honest way to promise a round-trip is to
      // perform it. A soul that survives the write but not the next read is
      // an agent that vanishes from the roster on restart.
      try {
        parseSoul(rendered, { seed: soulPath });
      } catch (error) {
        throw new ApiError(500, 'soul_round_trip_failed', `Refusing to write a soul that will not parse back: ${error instanceof Error ? error.message : String(error)}`);
      }

      await writeFile(soulPath, rendered);
      await context.gateway.reloadRoster();
      return { agent: next.agent, soulPath };
    },
  },
  {
    method: 'POST',
    pattern: `${API_PREFIX}/roster/reload`,
    async handler(context) {
      const agents = await context.gateway.reloadRoster();
      return { agents: agents.map((agent) => ({ id: agent.id, name: agent.name })) };
    },
  },

  // ---- sessions ------------------------------------------------------------
  {
    method: 'GET',
    pattern: `${API_PREFIX}/sessions`,
    async handler(context) {
      const agent = context.url.searchParams.get('agent') ?? undefined;
      return { sessions: context.gateway.store.list(agent) };
    },
  },
  {
    method: 'GET',
    pattern: `${API_PREFIX}/sessions/:id`,
    async handler(context) {
      const session = await context.gateway.store.get(context.params.id ?? '');
      if (!session) {
        throw new ApiError(404, 'session_not_found', `No session with id ${context.params.id}.`);
      }
      // Provider replay state is an implementation detail of resumption, and
      // it carries raw model turns. It never leaves the daemon.
      return { session: redactAnthropicRawTurns(session) };
    },
  },
  {
    method: 'POST',
    pattern: `${API_PREFIX}/sessions/:id/messages`,
    async handler(context) {
      const sessionId = context.params.id ?? '';
      const body = await readJsonObject(context.request);
      const message = requireString(body, 'message');
      const agentId = optionalString(body, 'agentId');

      const existing = await context.gateway.store.get(sessionId);
      if (!existing && agentId === undefined) {
        throw new ApiError(
          400,
          'agent_required',
          'A new session needs an explicit agentId: there is no stored agent to recover one from.',
        );
      }
      if (agentId !== undefined && !context.gateway.agents().some((agent) => agent.id === agentId)) {
        // Caught here so a typo answers 404 rather than being accepted and
        // then failing where only the event stream can see it.
        throw new ApiError(404, 'agent_not_found', `No agent with id ${agentId}.`);
      }
      if (existing && agentId !== undefined && existing.agent.id !== agentId) {
        // The gateway refuses this too. Checked here so the caller gets a
        // 409 that names both identities instead of a 500 from a rejected
        // dispatch nobody is awaiting.
        throw new ApiError(
          409,
          'session_agent_mismatch',
          `Session ${sessionId} belongs to agent ${existing.agent.id}, not ${agentId} — sessions never cross agent identities.`,
        );
      }

      const turnId = randomUUID();
      // Deliberately not awaited: a turn runs for as long as a model takes,
      // and the caller watches it on the event stream. The turn id returned
      // here is what lets them recognise it there.
      void context.gateway
        .dispatch({
          sessionId,
          ...(agentId ? { agentId } : {}),
          userMessage: message,
          turnId,
          ...(typeof body.metadata === 'object' && body.metadata !== null && !Array.isArray(body.metadata)
            ? { metadata: body.metadata as JsonObject }
            : {}),
        })
        .catch(async (error: unknown) => {
          // A turn the runner actually ran reports its own failure. One that
          // never got that far — the gateway stopping, a soul that no longer
          // resolves, credentials that stopped resolving between the
          // preflight above and the chain reaching this turn — rejects here,
          // and nothing else would ever tell the caller. Without this they
          // hold a turn id that produces silence forever.
          const message = error instanceof Error ? error.message : String(error);
          const session = await context.gateway.store.get(sessionId).catch(() => undefined);
          if (session?.status === 'failed') {
            return;
          }
          await context.gateway.bus
            .emit({ type: 'session.failed', sessionId, error: message })
            .catch(() => undefined);
        });

      context.response.statusCode = 202;
      return { sessionId, turnId };
    },
  },

  // ---- approvals -----------------------------------------------------------
  {
    method: 'GET',
    pattern: `${API_PREFIX}/approvals`,
    async handler(context) {
      return { approvals: context.gateway.pendingApprovals() };
    },
  },
  {
    method: 'POST',
    pattern: `${API_PREFIX}/approvals`,
    async handler(context) {
      const body = await readJsonObject(context.request);
      const requestId = requireString(body, 'requestId');
      const answer = requireString(body, 'answer');
      if (answer !== 'once' && answer !== 'always' && answer !== 'deny') {
        throw new ApiError(400, 'invalid_answer', 'answer must be one of: once, always, deny.');
      }
      const actor = optionalString(body, 'actor');
      const settled = context.gateway.resolveApproval({
        requestId,
        answer,
        ...(actor ? { actor } : {}),
      });
      if (!settled) {
        // The normal outcome of a button clicked a minute too late. Never a
        // "try again": the request is gone because it was already decided,
        // expired, or belonged to a cancelled turn.
        throw new ApiError(
          409,
          'approval_not_pending',
          'That request is no longer pending — it was already decided, it expired, or its turn was cancelled.',
        );
      }
      return { ok: true };
    },
  },

  // ---- catalog -------------------------------------------------------------
  {
    method: 'GET',
    pattern: `${API_PREFIX}/catalog/models`,
    async handler(context) {
      const { config } = await discoverActiveConfig(context.env, () => {});
      const credentials = await loadCredentials(context.env);
      const models = await collectAvailableModels(
        {
          ...(config.provider !== undefined ? { provider: config.provider } : {}),
          ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
          ...(config.apiKeyEnv !== undefined ? { apiKeyEnv: config.apiKeyEnv } : {}),
          credentials,
        },
        context.env,
      );
      return { models };
    },
  },

  // ---- credentials ---------------------------------------------------------
  {
    method: 'GET',
    pattern: `${API_PREFIX}/credentials`,
    async handler(context) {
      const credentials = await loadCredentials(context.env);
      const channels = await loadChannelCredentials(context.env);
      // Presence, type, and bound endpoint — never a value. Nothing that
      // reads this file hands a secret back out over the network.
      return {
        providers: (['anthropic', 'openai'] as const).map((provider) => {
          const stored = credentials[provider];
          return {
            provider,
            stored: stored !== undefined,
            ...(stored ? { type: stored.type } : {}),
            ...(stored?.baseUrl ? { baseUrl: stored.baseUrl } : {}),
          };
        }),
        channels: {
          slack: Object.keys(channels.slack ?? {}),
        },
      };
    },
  },
  {
    method: 'POST',
    pattern: `${API_PREFIX}/credentials/verify`,
    async handler(context) {
      const body = await readJsonObject(context.request);
      const provider = parseProviderParam(requireString(body, 'provider'));
      const key = requireString(body, 'key');
      const baseUrl = optionalString(body, 'baseUrl');
      return verifyProviderKey(provider, key, baseUrl, context.env.fetch ?? globalThis.fetch);
    },
  },
  {
    method: 'PUT',
    pattern: `${API_PREFIX}/credentials/:provider`,
    async handler(context) {
      const provider = parseProviderParam(context.params.provider ?? '');
      const body = await readJsonObject(context.request);
      const type = requireString(body, 'type');
      if (type !== 'api_key' && type !== 'oauth_token') {
        throw new ApiError(400, 'invalid_credential_type', 'type must be api_key or oauth_token.');
      }
      const value = requireString(body, 'value');
      const baseUrl = optionalString(body, 'baseUrl');

      const credentials = await loadCredentials(context.env);
      credentials[provider] = {
        type,
        value,
        // Endpoint-bound: a key saved for one endpoint is never sent to
        // another, whatever a project-local config later selects.
        ...(baseUrl ? { baseUrl } : {}),
      };
      await saveCredentials(context.env, credentials);
      return { provider, stored: true, type, ...(baseUrl ? { baseUrl } : {}) };
    },
  },
  {
    method: 'PUT',
    pattern: `${API_PREFIX}/credentials/channels/:channel`,
    async handler(context) {
      const channel = context.params.channel ?? '';
      if (channel !== 'slack') {
        throw new ApiError(400, 'unknown_channel', `No channel named ${channel}. Today that is: slack.`);
      }
      const body = await readJsonObject(context.request);
      const agentId = requireString(body, 'agentId');
      const appToken = requireString(body, 'appToken');
      const botToken = requireString(body, 'botToken');

      // Channel tokens are gateway infrastructure secrets and live in their
      // own namespace: this is the only route that writes them, and the
      // provider-credential and config routes deliberately cannot. An agent
      // must not be able to read the tokens of the transport carrying it.
      const channels = await loadChannelCredentials(context.env);
      await saveChannelCredentials(context.env, {
        ...channels,
        slack: { ...(channels.slack ?? {}), [agentId]: { appToken, botToken } },
      });
      return { channel, agentId, stored: true };
    },
  },

  // ---- config --------------------------------------------------------------
  {
    method: 'GET',
    pattern: `${API_PREFIX}/config`,
    async handler(context) {
      const path = await activeConfigPath(context);
      let config: StratusConfigFile = {};
      try {
        config = await loadConfigFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new ApiError(500, 'config_unreadable', error instanceof Error ? error.message : String(error));
        }
      }
      return { path, config };
    },
  },
  {
    method: 'PUT',
    pattern: `${API_PREFIX}/config`,
    async handler(context) {
      const body = await readJsonObject(context.request);
      const incoming = body.config;
      if (typeof incoming !== 'object' || incoming === null || Array.isArray(incoming)) {
        throw new ApiError(400, 'invalid_body', '"config" must be a JSON object.');
      }

      // Whitelisted, not merged wholesale. An unknown key would be silently
      // preserved and silently ignored by every reader — and this endpoint
      // must not become a way to write into a namespace it does not own.
      const next: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(incoming)) {
        if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
          throw new ApiError(400, 'unknown_config_key', `${key} is not a setting this API writes. Known keys: ${CONFIG_KEYS.join(', ')}.`);
        }
        if (value !== undefined && value !== null) {
          next[key] = value;
        }
      }
      if (typeof next.provider === 'string') {
        validateProvider(next.provider, 'provider');
      }
      if (typeof next.fallbackProvider === 'string') {
        validateProvider(next.fallbackProvider, 'fallbackProvider');
      }

      const path = await activeConfigPath(context);
      await saveConfigFile(path, next as StratusConfigFile);
      // Settings feed provider resolution, which the gateway re-reads per
      // dispatch — but the default *soul* is roster identity, so a changed
      // one only reaches dispatches after a reload.
      await context.gateway.reloadRoster();
      return { path, config: next };
    },
  },
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
