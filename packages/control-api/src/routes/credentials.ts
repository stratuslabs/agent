import type { ChannelReloadOutcome } from '@stratusagent/gateway';
import {
  CREDENTIAL_PROVIDER_NAMES,
  listChannelKinds,
  loadChannelCredentials,
  loadChannelTransportSecrets,
  loadCredentials,
  saveChannelTransportSecrets,
  saveCredentials,
  verifyProviderKey,
  withCredentialsFileLock,
  addNamedCredential,
  loadNamedCredentials,
  CHANNEL_KIND_PATTERN,
  CREDENTIAL_NAME_PATTERN,
  NamedCredentialExistsError,
  type CredentialProviderName,
  type StateEnvironment,
} from '@stratusagent/state';

import { API_PREFIX, ApiError, optionalString, readJsonObject, requireString } from '../http.ts';
import type { Route } from '../routes.ts';

/**
 * The `secrets` object of a non-Slack channel binding: every value a
 * non-empty string, at least one of them, and nothing else — the host
 * stores what the plugin's README says to store, by name.
 */
const readSecretMap = (body: Record<string, unknown>): Record<string, string> => {
  const raw = body.secrets;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiError(400, 'invalid_body', '"secrets" must be an object of secret name to value.');
  }
  const secrets: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new ApiError(400, 'invalid_body', `secrets.${name} must be a non-empty string.`);
    }
    secrets[name] = value;
  }
  if (Object.keys(secrets).length === 0) {
    throw new ApiError(400, 'invalid_body', '"secrets" names no secret; a channel binding with nothing in it would never come online.');
  }
  return secrets;
};

/**
 * Which agents have transport secrets stored, per channel kind — the ids,
 * never a value. Slack through its typed reader (the shape the adapter
 * reads); every other kind generically, from the same namespace.
 */
const listChannelBindings = async (env: StateEnvironment): Promise<Record<string, string[]>> => {
  const channels = await loadChannelCredentials(env);
  const bindings: Record<string, string[]> = { slack: Object.keys(channels.slack ?? {}) };
  for (const kind of await listChannelKinds(env)) {
    if (kind !== 'slack') {
      bindings[kind] = Object.keys(await loadChannelTransportSecrets(env, kind));
    }
  }
  return bindings;
};

const listNamedCredentialNames = async (
  env: StateEnvironment,
): Promise<{ shared: string[]; agents: Record<string, string[]> }> => {
  const named = await loadNamedCredentials(env);
  const agents: Record<string, string[]> = {};
  for (const [agentId, entries] of Object.entries(named.agents)) {
    agents[agentId] = Object.keys(entries).sort();
  }
  return { shared: Object.keys(named.shared).sort(), agents };
};

const parseProviderParam = (value: string): CredentialProviderName => {
  if (value !== 'anthropic' && value !== 'openai' && value !== 'codex') {
    throw new ApiError(400, 'unknown_provider', `Credentials are stored for anthropic, openai, and codex, not ${value}.`);
  }
  return value;
};

export const credentialRoutes: Route[] = [
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
        // Every kind with tokens stored, Slack's and any plugin channel's:
        // agent ids only, never a value.
        channels: await listChannelBindings(context.env),
        // Names only, the same answer `stratus credentials` gives: which are
        // the fleet's, and which agents have their own.
        named: await listNamedCredentialNames(context.env),
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
      await withCredentialsFileLock(async () => {
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
      if (!CHANNEL_KIND_PATTERN.test(channel)) {
        throw new ApiError(400, 'unknown_channel', `${JSON.stringify(channel)} is not a channel kind. Use slack, or the kind a channel plugin declares (lowercase, hyphens).`);
      }
      const body = await readJsonObject(context.request);
      const agentId = requireString(body, 'agentId');
      if (!context.gateway.agents().some((agent) => agent.id === agentId)) {
        // The adapter skips a binding whose id is not on the roster, so a
        // typo stores real secrets against an agent that never comes
        // online — reported connected here and silently absent there.
        throw new ApiError(404, 'agent_not_found', `No agent with id ${agentId}, so a ${channel} app bound to it would never come online.`);
      }
      // Slack keeps its named pair, so the dashboard's form and the
      // adapter's reader agree on the shape. Any other kind takes the
      // secrets its plugin documents, as one object of strings — the host
      // stores them and hands them over by kind, and does not know what
      // they mean.
      const secrets: Record<string, string> = channel === 'slack'
        ? { appToken: requireString(body, 'appToken'), botToken: requireString(body, 'botToken') }
        : readSecretMap(body);

      // Channel tokens are gateway infrastructure secrets and live in their
      // own namespace: this is the only route that writes them, and the
      // provider-credential and config routes deliberately cannot. An agent
      // must not be able to read the tokens of the transport carrying it.
      // Same lock as the provider credentials: both halves live in one file,
      // and both are read-modify-write.
      await withCredentialsFileLock(async () => {
        await saveChannelTransportSecrets(context.env, channel, agentId, secrets);
      });
      // A channel that reloads picks the secrets up now (card 894); any
      // other reads them at the next start, and `reloaded: false` says so,
      // with the reason when it tried and failed. Stored either way, so a
      // roster that will not load is reported beside the save rather than
      // as its failure.
      // `reason` is a sentence, for a client to show as it is.
      const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);
      // Every adapter of this kind, since two can carry disjoint agents of
      // one kind: the secret is live only if each of them reloaded.
      let outcomes: ChannelReloadOutcome[];
      try {
        outcomes = (await context.gateway.reloadRosterAndChannels()).channels.filter((entry) => entry.name === channel);
      } catch (error) {
        return {
          channel,
          agentId,
          stored: true,
          reloaded: false,
          reason: `${sentence(`The roster did not reload: ${error instanceof Error ? error.message : String(error)}`)} Fix that, then save again or restart stratusd.`,
        };
      }
      if (outcomes.length === 0) {
        return { channel, agentId, stored: true, reloaded: false };
      }
      const outcome = outcomes.find((entry) => entry.outcome !== 'reloaded');
      if (outcome !== undefined) {
        const reason = outcome.outcome === 'failed'
          ? `${sentence(`The ${channel} channel could not reload: ${outcome.reason ?? 'no reason given'}`)} Restart stratusd to apply it.`
          : `The ${channel} channel was still reloading when this answered; the daemon log says when it's done.`;
        return { channel, agentId, stored: true, reloaded: false, reason };
      }
      return { channel, agentId, stored: true, reloaded: true };
    },
  },

  {
    method: 'POST',
    pattern: `${API_PREFIX}/credentials/named`,
    async handler(context) {
      const body = await readJsonObject(context.request);
      const name = requireString(body, 'name');
      const value = requireString(body, 'value');
      const agentId = optionalString(body, 'agentId');
      if (!CREDENTIAL_NAME_PATTERN.test(name)) {
        throw new ApiError(
          400,
          'invalid_credential_name',
          `${JSON.stringify(name)} is not a credential name. Use letters, digits, dots, dashes, or underscores, starting with a letter.`,
        );
      }
      if (agentId !== undefined && !context.gateway.agents().some((agent) => agent.id === agentId)) {
        // Stored against an id nothing runs as, the key would report stored
        // here and never resolve for anyone.
        throw new ApiError(404, 'agent_not_found', `No agent with id ${agentId}, so a credential stored for it would never be used.`);
      }
      // Add-only: this API is reachable from away from the machine, and
      // replacing a shared key moves every agent using it onto another
      // account. Replacing and removing stay with `stratus credential`.
      try {
        await addNamedCredential(context.env, { name, value, ...(agentId !== undefined ? { agentId } : {}) });
      } catch (error) {
        if (error instanceof NamedCredentialExistsError) {
          throw new ApiError(409, 'credential_exists', error.message);
        }
        throw error;
      }
      return { name, ...(agentId !== undefined ? { agentId } : {}), stored: true };
    },
  },
];
