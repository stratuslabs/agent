import {
  collectAvailableModels,
  discoverActiveConfig,
  isSignedInRuntime,
  loadCredentials,
  resolveRuntimeConfig,
} from '@stratusagent/state';

import { API_PREFIX } from '../http.ts';
import type { Route } from '../routes.ts';

export const catalogRoutes: Route[] = [
  // ---- catalog -------------------------------------------------------------
  {
    method: 'GET',
    pattern: `${API_PREFIX}/catalog/models`,
    async handler(context) {
      // The daemon's own config, not whatever the working directory holds:
      // otherwise the catalog probes a different provider or base URL than
      // the one dispatches actually resolve to.
      const { config, location } = await discoverActiveConfig(context.env, () => {}, context.configPath);
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
      // ...and only from a config the operator chose. `resolveRuntimeConfig`
      // refuses to send a key to an endpoint an auto-discovered
      // `stratus.config.json` named, and that refusal arrives here as a
      // rejection — caught two lines up, which is precisely what makes this
      // fallback run. Reinstating the file's `baseUrl` and `apiKeyEnv` from
      // the raw config would hand a catalog probe the secret the resolution
      // just declined to send, on nothing more than a dashboard page load.
      // Without them the probe goes to the provider's own endpoint with the
      // provider's own variable, which is what a machine with no project
      // config does anyway.
      const configChosen = location?.trusted !== false;
      // The codex runtime carries no endpoint at all — the harness owns its
      // endpoints — so only the other providers have one to pass along.
      const signedIn = resolved && isSignedInRuntime(resolved) ? resolved : undefined;
      const baseUrl = (signedIn && signedIn.provider !== 'codex' ? signedIn.baseUrl : undefined)
        ?? (configApplies && configChosen ? config.baseUrl : undefined);
      const apiKeyEnv = signedIn?.apiKeyEnvVar ?? (configApplies && configChosen ? config.apiKeyEnv : undefined);
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
        // And the fourth: which names a soul's `provider:` can select on
        // this daemon, built-ins and plugin-registered alike — a picker
        // that listed a literal would never offer the second kind.
        providers: context.gateway.providers(),
      };
    },
  },
];
