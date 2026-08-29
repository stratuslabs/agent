import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

import { describeSchedule, formatSoul, isValidAgentId, parseSoul, type ParsedSoul } from '@stratusagent/agents';
import type { JsonObject } from '@stratusagent/core';
import type { Gateway } from '@stratusagent/gateway';
import { redactAnthropicRawTurns } from '@stratusagent/provider-anthropic';
import {
  claimSoulFile,
  collectAvailableModels,
  CREDENTIAL_PROVIDER_NAMES,
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
  resolveRuntimeConfig,
  saveChannelCredentials,
  saveConfigFile,
  saveCredentials,
  validateConfigFile,
  servedRuntimes,
  verifyProviderKey,
  type AgentSummary,
  type CredentialProviderName,
  type RuntimeConfig,
  type StateEnvironment,
  type StratusConfigFile,
} from '@stratusagent/state';

import { requestScheme, type Principal } from './auth.ts';
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

/**
 * Every setting this endpoint will write, and what shape it has to be.
 *
 * `api` is here because GET returns it: leaving it out made the documented
 * whole-document round trip impossible for any daemon configured through an
 * `api` block — send it back and the write is rejected, drop it and the write
 * deletes the binding, because PUT replaces.
 *
 * The types are checked because `loadConfigFile` silently ignores values of
 * the wrong shape. Without this, `{ "provider": 42 }` is written, echoed in a
 * 200, and then read back as absent — the file, the response, and the running
 * daemon all disagreeing about what was just saved.
 */
const CONFIG_KEYS = {
  provider: 'string',
  model: 'string',
  baseUrl: 'string',
  apiKeyEnv: 'string',
  systemPrompt: 'string',
  soul: 'string',
  fallbackModel: 'string',
  fallbackProvider: 'string',
  fallbackBaseUrl: 'string',
  approvals: 'object',
  api: 'object',
} as const;

/**
 * Where the daemon's settings live, for this API's purposes.
 *
 * Resolved through the shared chain, then filtered to *trusted* locations —
 * which is exactly the set the operator chose: `--config`, `STRATUS_CONFIG`
 * (and its legacy spelling), or the global `~/.stratus/config.json`. An
 * auto-discovered project-local `stratus.config.json` is untrusted and skipped:
 * that file ships in a repository, and writing settings into somebody's
 * checkout because the daemon happened to start there would surprise
 * everyone — its `api` and `approvals` blocks are ignored anyway.
 *
 * Re-deriving the environment half of that precedence here is what the first
 * version did, and it meant this endpoint read and wrote a different file from
 * the one the daemon was actually running on whenever STRATUS_CONFIG was set:
 * every save appeared to succeed and changed nothing.
 */
const activeConfigPath = async (context: RouteContext): Promise<string> => {
  const location = await resolveConfigLocation(
    context.configPath ? { configPath: context.configPath } : {},
    context.env,
  ).catch(() => undefined);
  return location?.trusted ? location.path : globalConfigPath(context.env);
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
  if (runtime.provider === 'codex' && runtime.apiKey === undefined) {
    // No key resolved means the machine's own `codex login` sign-in
    // serves the run — the harness holds those tokens itself.
    return 'subscription';
  }
  return runtime.apiKeyEnvVar ? `environment (${runtime.apiKeyEnvVar})` : 'stored';
};

/**
 * How strongly a summary claims its id, by the gateway's own rules.
 *
 * `listAgentSummaries` describes *files*, and two files can name one id: a
 * configured default soul shadowing a roster file, or a roster file claiming
 * the reserved built-in id. A last-write-wins map would enrich a live agent
 * with the persona, soul path, resolved runtime, and flags of the file it is
 * *not* running, so the pair is settled the way `loadRoster` settles it:
 *
 * - The configured default soul replaces whatever shares its id, the pathless
 *   built-in source included — `defaultAgentId` re-registers over a source
 *   with no `soulPath`, which is exactly what the built-in is. A configured
 *   soul declaring `id: stratus` is therefore the agent being served, and
 *   ranking the built-in over it reported the served soul as built-in and
 *   uneditable, hiding its own persona and settings behind the stock ones.
 * - Nothing else may take the reserved id: an ordinary roster file claiming
 *   `stratus` is skipped at load with a warning.
 */
const idClaim = (summary: AgentSummary): number => {
  if (summary.default) {
    return 2;
  }
  return summary.id === DEFAULT_STRATUS_AGENT.id && summary.builtIn ? 1 : 0;
};

/** Summaries keyed by id, keeping the one the daemon is actually serving. */
const summariesById = (summaries: AgentSummary[]): Map<string, AgentSummary> => {
  const byId = new Map<string, AgentSummary>();
  for (const summary of summaries) {
    const existing = byId.get(summary.id);
    if (!existing || idClaim(summary) > idClaim(existing)) {
      byId.set(summary.id, summary);
    }
  }
  return byId;
};

/** The soul file backing an agent, or a 404 naming the id. */
const soulForAgent = async (
  context: RouteContext,
  agentId: string,
): Promise<{ soul: ParsedSoul; path: string }> => {
  const summaries = await listAgentSummaries(context.env, () => {}, context.configPath);
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

/**
 * Serializes every read-modify-write of the credentials file.
 *
 * A promise chain rather than a lock file: this guards one daemon's own
 * concurrent requests, which is the race the API introduces by being reachable
 * from several surfaces at once. Two daemons sharing a home directory is
 * already unsupported for the session store, and would need a different
 * mechanism than this one.
 */
let credentialWrites: Promise<unknown> = Promise.resolve();
const withCredentialLock = async <T>(work: () => Promise<T>): Promise<T> => {
  const next = credentialWrites.then(work, work);
  // Swallowed for the chain only: the caller still sees the rejection, but a
  // failed write must not poison every write after it.
  credentialWrites = next.catch(() => undefined);
  return next;
};

/**
 * An allowlist field, or a 400.
 *
 * Applied only when it happened to be an array, `{ "tools": "shell.run" }` —
 * an edit meant to *restrict* an unrestricted agent — returned 200 while
 * silently leaving every tool reachable. A permission edit that does not take
 * effect must never report success, and coercing arbitrary values with
 * `String` would write allowlist entries that match no tool at all.
 */
const allowlist = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ApiError(400, 'invalid_allowlist', `"${field}" must be an array of strings.`);
  }
  return value as string[];
};

const parseProviderParam = (value: string): CredentialProviderName => {
  if (value !== 'anthropic' && value !== 'openai' && value !== 'codex') {
    throw new ApiError(400, 'unknown_provider', `Credentials are stored for anthropic, openai, and codex, not ${value}.`);
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
      const path = `${API_PREFIX}/auth/session?ott=${encodeURIComponent(ott)}`;
      // Built from the address this caller reached the daemon on, not the one
      // it bound to. Every request URL is parsed against the bound origin, so
      // `context.url.origin` is `http://127.0.0.1:4123` even for a caller that
      // arrived over a LAN address or a TLS-terminating proxy — a link that
      // points somewhere their browser cannot go, on exactly the deployments
      // origin binding now allows. `Host` is what they connected to, and a
      // browser cannot forge it; `x-forwarded-proto` is the proxy's own word
      // for the scheme it terminated, and it is read for nothing else.
      const host = context.request.headers.host;
      const scheme = requestScheme(context.request.headers['x-forwarded-proto']);
      const origin = host ? `${scheme}://${host}` : context.url.origin;
      return {
        ott,
        // Absolute, so the caller opens exactly the origin this token is
        // bound to rather than reassembling one and missing the port.
        url: `${origin}${path}`,
        // The same link without an origin, for a client that would rather
        // join it to a base it already holds than trust this one.
        path,
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
      context.response.setHeader(
        'set-cookie',
        // Flagged when this exchange came through TLS, so a session minted on
        // a public hostname is never sent back over plain HTTP to it.
        context.sessionCookie(sessionId, requestScheme(context.request.headers['x-forwarded-proto']) === 'https'),
      );
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
      // The roster the daemon is serving, enriched by the files — the same
      // source `GET /agents` uses, and for the same reason: a soul added or
      // broken since the last reload would otherwise make health report
      // agents that dispatch refuses, or omit ones it is still serving.
      const summaries = await listAgentSummaries(context.env, () => {}, context.configPath);
      const byId = summariesById(summaries);
      // Counted in the database. Listing every session to add them up made
      // the cost of a health poll grow with everything the install had ever
      // stored — steadily slower at exactly the endpoint that exists to say
      // the daemon is fine.
      const byStatus = context.gateway.store.countByStatus();
      const storedSessions = Object.values(byStatus).reduce((sum, count) => sum + count, 0);

      // Every distinct runtime the daemon would serve, deduped. Deliberately
      // NOT probed: a monitoring view polls this, and a live call per poll
      // would spend the operator's rate limit to tell them what resolution
      // already knows.
      const runtimes = new Map<string, { provider: string; model?: string; credentials: string }>();
      // Resolved from the roster the gateway is serving, not from the agents
      // directory. A soul added without a successful reload is not dispatched
      // yet, and a loaded soul that was deleted or broken since still is —
      // either way a directory scan bills the wrong set. `servedSouls` hands
      // over the pins the gateway itself would apply.
      const roster = (await context.gateway.servedSouls()).map((entry) => entry.soul);
      for (const served of await servedRuntimes(context.env, context.configPath, roster)) {
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
        agents: context.gateway.agents().map((agent) => {
          const summary = byId.get(agent.id);
          return {
            id: agent.id,
            name: agent.name,
            default: summary?.default ?? false,
            builtIn: summary?.builtIn ?? agent.id === DEFAULT_STRATUS_AGENT.id,
            // Omitted rather than guessed when no file backs this agent.
            // The gateway keeps dispatching from a cached soul when its file
            // is deleted or momentarily unparseable, and that soul may pin a
            // provider — so claiming `demo` here would report the wrong
            // billing for turns that are really running, at exactly the
            // moment someone is looking to find out why.
            ...(summary?.runsOn ? { runsOn: summary.runsOn } : {}),
          };
        }),
        sessions: { total: storedSessions, byStatus },
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
      // The roster the daemon is *serving*, enriched with what the files
      // say — not the other way round.
      //
      // `listAgentSummaries` reads the agents directory, so a soul dropped on
      // disk since the last reload appears in it immediately. Listing from
      // there would advertise an agent that this same API then refuses to
      // dispatch to, because the gateway has never registered the id; a
      // duplicate or unparseable file produces the same mismatch. Anything
      // this endpoint lists can be talked to.
      const summaries = await listAgentSummaries(context.env, () => {}, context.configPath);
      const byId = summariesById(summaries);
      // Activity comes from the running daemon's session store, which the
      // shared builder has no access to: the CLI's listing is about identity
      // and configuration, this one is about a daemon that is serving.
      const activity = context.gateway.store.lastActivityByAgent();

      return {
        agents: context.gateway.agents().map((agent) => {
          const summary = byId.get(agent.id);
          const seen = activity[agent.id];
          return {
            // A registered agent whose file has since moved or broken still
            // lists, from the definition the daemon is actually running.
            id: agent.id,
            name: agent.name,
            default: summary?.default ?? false,
            builtIn: summary?.builtIn ?? agent.id === DEFAULT_STRATUS_AGENT.id,
            // Omitted rather than guessed when no file backs this agent.
            // The gateway keeps dispatching from a cached soul when its file
            // is deleted or momentarily unparseable, and that soul may pin a
            // provider — so claiming `demo` here would report the wrong
            // billing for turns that are really running, at exactly the
            // moment someone is looking to find out why.
            ...(summary?.runsOn ? { runsOn: summary.runsOn } : {}),
            memories: summary?.memories ?? 0,
            ...(summary?.soulPath ? { soulPath: summary.soulPath } : {}),
            ...(summary?.provider ? { provider: summary.provider } : {}),
            ...(summary?.model ? { model: summary.model } : {}),
            ...(summary?.persona ? { persona: summary.persona } : {}),
            ...(agent.avatar ? { avatar: agent.avatar } : summary?.avatar ? { avatar: summary.avatar } : {}),
            // A timestamp and a count, never a verdict. What counts as
            // "recently active" is a rendering decision, and a daemon that
            // baked a window in would need upgrading to change it.
            ...(seen ? { lastActiveAt: seen.lastActiveAt, activeSessions: seen.activeSessions } : { activeSessions: 0 }),
          };
        }),
      };
    },
  },
  {
    method: 'GET',
    pattern: `${API_PREFIX}/agents/:id`,
    async handler(context) {
      // One agent in full, which the roster listing deliberately is not: it
      // carries `persona`, a one-line snippet for a table row. An editor that
      // saved that snippet back would truncate the real instructions to their
      // first line — so anything editing an agent reads it here first.
      const agentId = context.params.id ?? '';
      const { soul, path: soulPath } = await soulForAgent(context, agentId);
      return {
        agent: soul.agent,
        // The raw markdown, so a client offering a source view edits the same
        // bytes `PUT /agents/:id` accepts back as `soul`.
        soul: await readFile(soulPath, 'utf8'),
        soulPath,
        ...(soul.provider ? { provider: soul.provider } : {}),
        ...(soul.model ? { model: soul.model } : {}),
      };
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
        context.configPath,
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
            ...(body.tools !== undefined ? { tools: allowlist(body.tools, 'tools') } : {}),
            ...(body.skills !== undefined ? { skills: allowlist(body.skills, 'skills') } : {}),
            ...(body.credentials !== undefined ? { credentials: allowlist(body.credentials, 'credentials') } : {}),
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

      // A raw edit writes the bytes it was given.
      //
      // `formatSoul` canonicalizes — frontmatter order, quoting, list layout,
      // trailing whitespace — so reserializing a source edit hands back a
      // file the author did not write, and silently discards an edit that was
      // only formatting. It has already been through `parseSoul` above, which
      // is the check that matters; there is nothing left for a round-trip to
      // prove about text that came in as text.
      //
      // A field edit still renders, and still round-trips before it lands:
      // `formatSoul` is the inverse of `parseSoul`, and the only honest way
      // to promise that is to perform it. A soul that survives the write but
      // not the next read is an agent that vanishes on restart.
      let rendered: string;
      if (raw !== undefined) {
        rendered = raw;
      } else {
        rendered = formatSoul(next);
        try {
          parseSoul(rendered, { seed: soulPath });
        } catch (error) {
          throw new ApiError(500, 'soul_round_trip_failed', `Refusing to write a soul that will not parse back: ${error instanceof Error ? error.message : String(error)}`);
        }
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
      const raw = context.url.searchParams.get('limit');
      if (raw !== null && !/^\d+$/.test(raw)) {
        throw new ApiError(400, 'invalid_limit', 'limit must be a non-negative whole number.');
      }
      return {
        sessions: context.gateway.store.list(agent, raw === null ? undefined : Number(raw)),
      };
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
      // Armed before the dispatch, so a failure that arrives while the runner
      // is still unwinding is seen rather than missed.
      const watch = context.watchTurn(sessionId, turnId);
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
          if (watch.reported()) {
            return;
          }
          // Stamped with the turn the caller was handed. The gateway cleared
          // its own record when the chained work unwound, so without this the
          // failure arrives unattributed and the client that queued this
          // message shows it as running indefinitely.
          await context.withTurn(sessionId, turnId, async () => {
            await context.gateway.bus
              .emit({ type: 'session.failed', sessionId, error: message })
              .catch(() => undefined);
          });
        })
        .finally(() => watch.release());

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

  // ---- schedules -----------------------------------------------------------
  {
    method: 'GET',
    pattern: `${API_PREFIX}/schedules`,
    async handler(context) {
      // The whole fleet's, not one agent's: this is the audit list — an
      // agent that scheduled something an operator cannot see is a bug —
      // and each row with a destination is also a standing permission to
      // speak, which is exactly what an operator reviews.
      return { schedules: context.gateway.schedules().map((record) => describeSchedule(record)) };
    },
  },
  {
    method: 'DELETE',
    pattern: `${API_PREFIX}/schedules/:id`,
    async handler(context) {
      const cancelled = context.gateway.cancelSchedule(context.params.id ?? '');
      if (!cancelled) {
        throw new ApiError(404, 'schedule_not_found', `No schedule with id ${context.params.id}.`);
      }
      // Cancelling also revoked the destination grant riding on the row —
      // the next send from a still-running firing is gated normally.
      return { cancelled: true };
    },
  },

  // ---- catalog -------------------------------------------------------------
  {
    method: 'GET',
    pattern: `${API_PREFIX}/catalog/models`,
    async handler(context) {
      // The daemon's own config, not whatever the working directory holds:
      // otherwise the catalog probes a different provider or base URL than
      // the one dispatches actually resolve to.
      const { config } = await discoverActiveConfig(context.env, () => {}, context.configPath);
      // And the *resolved* default rather than the config's copy of it. Which
      // provider is default decides who may use the generic `STRATUS_API_KEY`
      // and the configured `apiKeyEnv`, and a daemon started with
      // `STRATUS_PROVIDER=openai` over a provider-less config resolves openai
      // for every dispatch while a config-only reading calls it undefined —
      // so the catalog withheld the very credential the runtime was using and
      // listed no models for a provider that works. Asked of the resolver
      // rather than re-derived, and a resolution that fails (no credentials
      // yet, which is exactly when someone opens this page) falls back to the
      // config's own values.
      const runtime = await resolveRuntimeConfig(
        context.configPath ? { configPath: context.configPath } : {},
        context.env,
      ).catch(() => undefined);
      const resolved = runtime && runtime.provider !== 'demo' ? runtime : undefined;
      const provider = resolved?.provider ?? config.provider;
      // A config file's endpoint and key-selector were written for the
      // provider named in that file, so they only stand in when that is the
      // provider we resolved — the resolver's own `fileConfigApplies` rule,
      // and a file with no provider key is openai-specific for the same
      // reason it is there. Falling back unconditionally sent one provider's
      // key to another provider's endpoint: an openai config with a custom
      // `baseUrl`, overridden by `STRATUS_PROVIDER=anthropic`, resolves
      // anthropic with no base URL of its own, and the fallback handed the
      // Anthropic key to the OpenAI URL.
      const configApplies = provider !== undefined && (config.provider ?? 'openai') === provider;
      // The codex runtime carries no endpoint at all — the harness owns its
      // endpoints — so only the other providers have one to pass along.
      const baseUrl = (resolved && resolved.provider !== 'codex' ? resolved.baseUrl : undefined)
        ?? (configApplies ? config.baseUrl : undefined);
      const apiKeyEnv = resolved?.apiKeyEnvVar ?? (configApplies ? config.apiKeyEnv : undefined);
      const credentials = await loadCredentials(context.env);
      const models = await collectAvailableModels(
        {
          ...(provider !== undefined ? { provider } : {}),
          ...(baseUrl !== undefined ? { baseUrl } : {}),
          ...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
          credentials,
        },
        context.env,
      );
      return { models };
    },
  },
  {
    method: 'GET',
    pattern: `${API_PREFIX}/catalog/tools`,
    async handler(context) {
      // All three halves, because any alone misleads. The tool list says
      // what an agent can be granted and at what risk; the skill list says
      // which procedures a soul's `skills:` can name (descriptors only —
      // bodies stay behind skill.read, on the agent's own turn); the
      // plugin list says what this daemon was *asked* to load — including
      // a plugin that failed, which is invisible in the other two and is
      // exactly what someone looking at this screen needs to see.
      return {
        tools: context.gateway.tools(),
        skills: context.gateway.skills(),
        plugins: context.gateway.plugins(),
      };
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
        providers: CREDENTIAL_PROVIDER_NAMES.map((provider) => {
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
      const type = optionalString(body, 'type') ?? 'api_key';
      if (type !== 'api_key' && type !== 'oauth_token') {
        throw new ApiError(400, 'invalid_credential_type', 'type must be api_key or oauth_token.');
      }
      if (type === 'oauth_token') {
        // A subscription sign-in cannot call the models endpoint — the same
        // reason the model catalog falls back to the known lineups for one.
        // Checked as an api_key it comes back `rejected`, condemning a
        // credential that works perfectly well once saved, so this says what
        // is true instead: it cannot be checked from here.
        return {
          status: 'unreachable',
          detail: provider === 'codex'
            ? 'a ChatGPT (codex login) sign-in cannot be checked against a models endpoint; save it and run a turn'
            : 'a Claude subscription token cannot be checked against the models endpoint; save it and run a turn',
        };
      }
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
      if (type === 'oauth_token' && provider === 'openai') {
        // Runtime resolution turns an OAuth credential into an auth token
        // for Anthropic, and reads it as the ChatGPT sign-in marker for
        // codex. Stored for openai it is a sign-in that reports as present
        // and then fails every run with "missing API key".
        throw new ApiError(
          400,
          'unsupported_credential_type',
          'A subscription sign-in is an Anthropic or Codex credential; openai needs an api_key.',
        );
      }
      const value = requireString(body, 'value');
      const baseUrl = optionalString(body, 'baseUrl');
      if (baseUrl && provider === 'codex') {
        // The codex harness owns its endpoints, so a bound key could never
        // be honored there — and runtime resolution refuses to run rather
        // than send it anywhere else. Refusing the binding up front beats
        // storing a credential every later run rejects.
        throw new ApiError(
          400,
          'unsupported_credential_endpoint',
          'A codex key is not endpoint-bound: the codex harness owns its endpoints. Store it without a baseUrl.',
        );
      }

      // The whole read-modify-write under one lock. `saveCredentials` treats
      // what it is given as the complete provider set and drops anything
      // absent from it, so two clients storing different providers at once
      // would each write a snapshot taken before the other's — and the last
      // one would erase a sign-in that had just reported success. This API is
      // explicitly shared by several surfaces, so that race is reachable.
      await withCredentialLock(async () => {
        const credentials = await loadCredentials(context.env);
        credentials[provider] = {
          type,
          value,
          // Endpoint-bound: a key saved for one endpoint is never sent to
          // another, whatever a project-local config later selects.
          ...(baseUrl ? { baseUrl } : {}),
        };
        await saveCredentials(context.env, credentials);
      });
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
      if (!context.gateway.agents().some((agent) => agent.id === agentId)) {
        // The adapter skips a binding whose id is not on the roster, so a
        // typo stores real Slack secrets against an agent that never comes
        // online — reported connected here and silently absent there.
        throw new ApiError(404, 'agent_not_found', `No agent with id ${agentId}, so a Slack app bound to it would never come online.`);
      }

      // Channel tokens are gateway infrastructure secrets and live in their
      // own namespace: this is the only route that writes them, and the
      // provider-credential and config routes deliberately cannot. An agent
      // must not be able to read the tokens of the transport carrying it.
      // Same lock as the provider credentials: both halves live in one file,
      // and both are read-modify-write.
      await withCredentialLock(async () => {
        const channels = await loadChannelCredentials(context.env);
        await saveChannelCredentials(context.env, {
          ...channels,
          slack: { ...(channels.slack ?? {}), [agentId]: { appToken, botToken } },
        });
      });
      return { channel, agentId, stored: true };
    },
  },

  // ---- config --------------------------------------------------------------
  {
    method: 'GET',
    pattern: `${API_PREFIX}/config`,
    async handler(context) {
      const configPath = await activeConfigPath(context);
      let config: StratusConfigFile = {};
      try {
        config = await loadConfigFile(configPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new ApiError(500, 'config_unreadable', error instanceof Error ? error.message : String(error));
        }
      }
      return { path: configPath, config };
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
        // `plugins` is the one key this endpoint reads but does not write.
        // A plugin runs in the daemon's own process, so enabling one is not
        // a settings change; it is the security boundary the whole trust
        // model rests on, and it stays a deliberate edit to a file. Ignored
        // rather than rejected because `GET` hands the whole document back
        // and `PUT` takes the whole document — a 400 here would break the
        // round trip for everyone who has the block, and the value is
        // preserved below rather than dropped by the replace.
        if (key === 'plugins') {
          continue;
        }
        const expected = (CONFIG_KEYS as Record<string, string>)[key];
        if (!expected) {
          throw new ApiError(
            400,
            'unknown_config_key',
            `${key} is not a setting this API writes. Known keys: ${Object.keys(CONFIG_KEYS).join(', ')}.`,
          );
        }
        if (value === undefined || value === null) {
          continue;
        }
        const shaped = expected === 'object'
          ? typeof value === 'object' && !Array.isArray(value)
          : typeof value === expected;
        if (!shaped) {
          throw new ApiError(
            400,
            'invalid_config_value',
            `"${key}" must be ${expected === 'object' ? 'an object' : `a ${expected}`}; received ${Array.isArray(value) ? 'an array' : typeof value}.`,
          );
        }
        next[key] = value;
      }

      // Through the loader's own validator before anything is written. The
      // shape check above only knows `api` and `approvals` are objects; what
      // is *inside* them is a rule those blocks' parsers own, and an
      // `enabled` of `"false"` would otherwise be written, reported as saved,
      // and then make every later read of the file fail.
      const configPath = await activeConfigPath(context);
      // PUT replaces, so anything this endpoint does not write has to be
      // carried across explicitly or it is deleted by omission — and
      // deleting somebody's plugin list because they saved a model change
      // would silently take capability away from every agent.
      try {
        const current = await loadConfigFile(configPath);
        if (current.plugins) {
          next.plugins = current.plugins;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new ApiError(500, 'config_unreadable', error instanceof Error ? error.message : String(error));
        }
      }
      let validated: StratusConfigFile;
      try {
        validated = validateConfigFile(next, configPath);
      } catch (error) {
        throw new ApiError(400, 'invalid_config_value', error instanceof Error ? error.message : String(error));
      }

      await saveConfigFile(configPath, validated);
      // Settings feed provider resolution, which the gateway re-reads per
      // dispatch — but the default *soul* is roster identity, so a changed
      // one only reaches dispatches after a reload.
      await context.gateway.reloadRoster();
      return { path: configPath, config: validated };
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
