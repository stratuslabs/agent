import type { CredentialsFile } from './credentials.ts';
import { type StateEnvironment, readProcessEnv, readNonEmptyString } from './environment.ts';
import {
  type StratusProviderName,
  CREDENTIAL_PROVIDER_NAMES,
  type CredentialProviderName,
  DEFAULT_ANTHROPIC_BASE_URL,
  DEFAULT_OPENAI_BASE_URL,
  defaultApiKeyEnvName,
} from './provider-names.ts';

/**
 * Shown when live model listing is unavailable: a Claude subscription token
 * cannot call the models endpoint, and neither can an offline machine.
 */
export const KNOWN_CLAUDE_MODELS = [
  'claude-opus-5-5',
  'claude-fable-5-1',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-4-5',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
];

/**
 * The codex harness serves its own model lineup, and no endpoint Stratus
 * can call lists it — a ChatGPT sign-in lives inside codex's own auth
 * store, and even an API key's /models listing answers for the platform,
 * not the harness. So codex model discovery is this list, the same way a
 * Claude subscription falls back to the known Claude lineup.
 */
export const KNOWN_CODEX_MODELS = [
  'gpt-5.5',
  'gpt-5.6-sol',
  'gpt-5.6-luna',
  'gpt-5.6-terra',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.2',
];

// Model ids that cannot serve /chat/completions and must not become the
// default: embeddings, audio, images, moderation, and legacy completions.
const NON_CHAT_MODEL_PATTERN = /embed|whisper|tts|audio|dall-e|image|moderation|realtime|transcribe|davinci|babbage|curie|(^|[-_])ada([-_]|$)/i;

/**
 * What a live key check concluded. `unreachable` is deliberately distinct
 * from `rejected`: only an explicit auth failure condemns a key.
 */
export interface ProviderKeyVerdict {
  status: 'ok' | 'rejected' | 'unreachable';
  detail?: string;
}

/**
 * Live check that a key actually works, so the user finds out while they are
 * entering it instead of on their first run.
 */
export const verifyProviderKey = async (
  provider: CredentialProviderName,
  key: string,
  baseUrl: string | undefined,
  fetchImpl: typeof fetch | undefined,
): Promise<ProviderKeyVerdict> => {
  if (typeof fetchImpl !== 'function') {
    return { status: 'unreachable', detail: 'fetch is unavailable' };
  }

  // A codex API key is an OpenAI platform key under a different env name,
  // so it verifies against the platform's models endpoint like any other
  // OpenAI key. (A ChatGPT subscription sign-in never reaches this
  // function — it has no key to check; callers short-circuit it the same
  // way they do a Claude subscription token.)
  const root = (baseUrl ?? (provider === 'anthropic' ? DEFAULT_ANTHROPIC_BASE_URL : DEFAULT_OPENAI_BASE_URL)).replace(/\/+$/, '');
  const url = provider === 'anthropic' ? `${root}/v1/models` : `${root}/models`;
  const headers = provider === 'anthropic'
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : { authorization: `Bearer ${key}` };

  try {
    const response = await fetchImpl(url, { headers });
    if (response.ok) {
      return { status: 'ok' };
    }
    // Only an explicit auth failure condemns the key. Compatible endpoints
    // (local models, proxies) often lack GET /models entirely — a 404/405
    // there says nothing about the key, so it stays saveable.
    if (response.status === 401 || response.status === 403) {
      return { status: 'rejected', detail: `HTTP ${response.status}` };
    }
    return { status: 'unreachable', detail: `the endpoint did not support a key check (HTTP ${response.status})` };
  } catch (error) {
    return { status: 'unreachable', detail: error instanceof Error ? error.message : String(error) };
  }
};

/** One model a stored sign-in can actually reach. */
export interface CatalogModel {
  provider: CredentialProviderName;
  id: string;
}

/**
 * The current default selection, as far as model discovery cares. Passed
 * explicitly rather than re-resolved because the caller may be holding an
 * unsaved edit — setup's in-progress state, or a config body being validated
 * before it is written.
 */
export interface ModelCatalogSelection {
  /**
   * The default provider. Only it may use the generic `STRATUS_API_KEY` and
   * the configured `apiKeyEnv`; a secondary provider relies on its own
   * variable or stored sign-in, never the default provider's secret.
   */
  provider?: StratusProviderName;
  baseUrl?: string;
  apiKeyEnv?: string;
  credentials: CredentialsFile;
}

/**
 * Every model the current sign-ins can actually reach, fetched live where
 * possible. Subscription tokens cannot call the models endpoint, so those
 * fall back to the known Claude lineup.
 */
export const collectAvailableModels = async (
  selection: ModelCatalogSelection,
  env: StateEnvironment = {},
): Promise<CatalogModel[]> => {
  const processEnv = readProcessEnv(env);
  const fetchImpl = env.fetch ?? globalThis.fetch;
  const models: CatalogModel[] = [];

  for (const provider of CREDENTIAL_PROVIDER_NAMES) {
    // Discovery uses the credential a real run would use. STRATUS_API_KEY
    // and a configured apiKeyEnv authenticate the DEFAULT provider only —
    // a secondary provider relies on its own env var or stored sign-in,
    // never the default provider's secret.
    const envKey = (provider === selection.provider
      ? readNonEmptyString(processEnv.STRATUS_API_KEY)
        ?? (selection.apiKeyEnv ? readNonEmptyString(processEnv[selection.apiKeyEnv]) : undefined)
      : undefined)
      ?? readNonEmptyString(processEnv[defaultApiKeyEnvName(provider)]);
    const credential = envKey ? undefined : selection.credentials[provider];
    const apiKey = envKey ?? (credential?.type === 'api_key' ? credential.value : undefined);
    if (!apiKey && !credential) {
      continue;
    }

    if (provider === 'codex') {
      // Nothing to fetch: the harness lineup has no listable endpoint
      // (see KNOWN_CODEX_MODELS), whichever way the sign-in bills.
      models.push(...KNOWN_CODEX_MODELS.map((id) => ({ provider, id })));
      continue;
    }

    if (provider === 'anthropic') {
      if (!apiKey || typeof fetchImpl !== 'function') {
        // Subscription tokens cannot call the models endpoint.
        models.push(...KNOWN_CLAUDE_MODELS.map((id) => ({ provider, id })));
        continue;
      }
      // The same endpoint a real run uses: the stored key's bound URL is
      // authoritative, then a configured anthropic base URL (a proxy) —
      // never the official endpoint by accident.
      const anthropicRoot = ((credential?.type === 'api_key' ? credential.baseUrl : undefined)
        ?? (selection.provider === 'anthropic' ? selection.baseUrl : undefined)
        ?? DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, '');
      try {
        const response = await fetchImpl(`${anthropicRoot}/v1/models?limit=100`, {
          headers: { 'x-api-key': String(apiKey), 'anthropic-version': '2023-06-01' },
        });
        // An explicit auth failure is the one answer that condemns the key —
        // the same rule `verifyProviderKey` applies. Falling back here would
        // offer a menu of Claude models to a revoked or mistyped key, every
        // one of which fails the moment it is used. Any other unhappy status
        // says the listing endpoint is unavailable, not that the key is bad,
        // so the known lineup still stands in for it.
        if (response.status === 401 || response.status === 403) {
          continue;
        }
        const payload = await response.json() as { data?: Array<{ id?: string }> };
        const ids = (payload.data ?? []).map((entry) => entry.id).filter((id): id is string => typeof id === 'string');
        models.push(...(ids.length > 0 ? ids : KNOWN_CLAUDE_MODELS).map((id) => ({ provider, id })));
      } catch {
        models.push(...KNOWN_CLAUDE_MODELS.map((id) => ({ provider, id })));
      }
      continue;
    }

    if (!apiKey || typeof fetchImpl !== 'function') {
      continue;
    }
    try {
      // A stored key's bound endpoint is authoritative, exactly as at run
      // time; only env-supplied keys follow the default provider's URL.
      const root = ((credential?.type === 'api_key' ? credential.baseUrl : undefined)
        ?? (selection.provider === 'openai' ? selection.baseUrl : undefined)
        ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');
      const response = await fetchImpl(`${root}/models`, {
        headers: { authorization: `Bearer ${String(apiKey)}` },
      });
      // Same rule on this side: a rejected key offers nothing.
      if (response.status === 401 || response.status === 403) {
        continue;
      }
      const payload = await response.json() as { data?: Array<{ id?: string }> };
      const allIds = (payload.data ?? [])
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === 'string');
      // Runs always call /chat/completions, so embedding, audio, image,
      // moderation, and legacy completion models would save a default
      // that cannot execute. If filtering leaves nothing (an exotic local
      // service), show everything rather than an empty menu.
      const chatIds = allIds.filter((id) => !NON_CHAT_MODEL_PATTERN.test(id));
      const ids = (chatIds.length > 0 ? chatIds : allIds).sort((a, b) => {
        const rank = (id: string): number => (/^gpt/i.test(id) ? 0 : /^o\d/i.test(id) ? 1 : 2);
        return rank(a) - rank(b) || a.localeCompare(b);
      });
      models.push(...ids.map((id) => ({ provider, id })));
    } catch {
      // No reachable model list for this provider; skip it.
    }
  }

  return models;
};
