import {
  DEFAULT_STRATUS_AGENT,
  listAgentSummaries,
  isSignedInRuntime,
  servedRuntimes,
  NoProviderConfiguredError,
  type RuntimeConfig,
} from '@stratusagent/state';

import { API_PREFIX } from '../http.ts';
import type { Route } from '../routes.ts';
import { summariesById } from './roster.ts';

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
  if (!isSignedInRuntime(runtime)) {
    // A contributed provider: its plugin's config and manifest-declared
    // credentials, which nothing here resolves.
    return 'plugin';
  }
  return runtime.apiKeyEnvVar ? `environment (${runtime.apiKeyEnvVar})` : 'stored';
};

export const healthRoutes: Route[] = [
  // ---- liveness -------------------------------------------------------------
  // For a platform's own check (a Fly machine check, a Kubernetes probe),
  // which cannot send the bearer token. Says only that the API answers:
  // no version, roster, counts, or state, so it needs no token to be safe.
  {
    method: 'GET',
    pattern: `${API_PREFIX}/livez`,
    selfAuthenticating: true,
    async handler() {
      return { ok: true };
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
      const runtimes = new Map<string, { provider: string; model?: string; credentials: string; problem?: string }>();
      // Resolved from the roster the gateway is serving, not from the agents
      // directory. A soul added without a successful reload is not dispatched
      // yet, and a loaded soul that was deleted or broken since still is —
      // either way a directory scan bills the wrong set. `servedSouls` hands
      // over the pins the gateway itself would apply.
      const roster = (await context.gateway.servedSouls()).map((entry) => entry.soul);
      // An agent with no provider at all is refused on every turn, so it is
      // listed as such rather than left out of the runtimes it isn't in.
      let noProvider: string | undefined;
      const servedList = await servedRuntimes(context.env, context.configPath, roster, (error) => {
        if (error instanceof NoProviderConfiguredError) {
          noProvider ??= error.message;
        }
      });
      if (noProvider !== undefined) {
        runtimes.set('none', { provider: 'none', credentials: 'none', problem: noProvider });
      }
      for (const served of servedList) {
        const model = served.runtime.provider === 'demo' ? undefined : served.runtime.model;
        const entry = {
          provider: served.runtime.provider,
          ...(model ? { model } : {}),
          credentials: credentialSource(served.runtime),
        };
        runtimes.set(`${entry.provider}:${model ?? ''}:${entry.credentials}`, entry);
      }

      const events = context.gateway.eventSummary();
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
        intake: context.gateway.intake(),
        held: context.gateway.held(),
        runtimes: [...runtimes.values()],
        ...(context.startup !== undefined ? { startup: context.startup() } : {}),
        // Only when a source is configured: a monitor sees refusals climb
        // here, and an install without events keeps the payload it had.
        ...(Object.keys(events.sources).length > 0 ? { events } : {}),
      };
    },
  },
];
