import { DEFAULT_ANTHROPIC_MODEL } from '@stratusagent/provider-anthropic';
import { DEFAULT_CODEX_MODEL } from '@stratusagent/provider-codex';
import { loadConfigFile } from './config-file.ts';
import { type ResolvedConfigLocation, resolveConfigLocation } from './config-location.ts';
import type {
  StratusConfigFile,
  FallbackRuntime,
  IgnoredUntrustedConfig,
  RuntimeConfig,
  RuntimeSelection,
} from './config.ts';
import { loadCredentials } from './credentials.ts';
import { type StateEnvironment, readProcessEnv, readNonEmptyString } from './environment.ts';
import {
  type StratusProviderName,
  isRegisteredProviderName,
  type CredentialProviderName,
  DEFAULT_ANTHROPIC_BASE_URL,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_MODEL,
  parseProviderName,
  defaultApiKeyEnvName,
} from './provider-names.ts';
import { resolveSoulPath, loadSoulFile } from './souls.ts';

/**
 * The environment variable that supplies this provider's API key, before
 * the two generic ones are considered. A config file's `apiKeyEnv` was
 * written for the provider named in that file, so it only counts when the
 * file still describes the provider being resolved.
 *
 * **An untrusted config does not get to name it.** Choosing which variable
 * is read is choosing which of the machine's secrets this process picks up,
 * and an auto-discovered `stratus.config.json` ships in any repository
 * somebody clones — `apiKeyEnv: "AWS_SECRET_ACCESS_KEY"` in a cloned repo
 * is not a provider setting, it is a request to go and fetch something
 * else. `STRATUS_API_KEY_ENV` still names one, because the environment is
 * the operator's own.
 *
 * Exported because diagnostics have to name the variable that actually
 * won: re-deriving this rule elsewhere drifts, and a warning that blames
 * the wrong variable leaves the real override — and its billing — in place.
 */
export const apiKeyEnvNameFor = (
  provider: CredentialProviderName,
  fileConfig: StratusConfigFile,
  fileConfigApplies: boolean,
  env: StateEnvironment = {},
  configTrusted?: boolean,
): string => {
  const processEnv = readProcessEnv(env);
  const fromFile = fileConfigApplies && configTrusted !== false ? fileConfig.apiKeyEnv : undefined;
  return String(
    readNonEmptyString(processEnv.STRATUS_API_KEY_ENV)
      ?? fromFile
      ?? defaultApiKeyEnvName(provider),
  );
};

/**
 * The environment key a run would use, and the variable it came from.
 * Order matches the resolver: the generic variables outrank the
 * provider-specific one.
 */
export const resolveEnvApiKey = (
  apiKeyEnvName: string,
  env: StateEnvironment = {},
): { name: string; value: string } | undefined => {
  const processEnv = readProcessEnv(env);
  for (const name of ['STRATUS_API_KEY', apiKeyEnvName]) {
    const value = readNonEmptyString(processEnv[name]);
    if (typeof value === 'string') {
      return { name, value };
    }
  }
  return undefined;
};

/**
 * What an untrusted config asked for and did not get: `soul` and
 * `systemPrompt`, minus a key the selection or the environment outranked,
 * which is beaten rather than refused. One rule with three readers —
 * {@link resolveRuntimeConfig} records it on every run, `stratus doctor`
 * applies it when no run could resolve, and `stratus serve` says it at
 * startup from {@link discoverIgnoredUntrustedConfig}, because the served
 * runtime that fails to resolve (a real provider with no usable credential)
 * is exactly the one whose record the daemon never sees.
 */
export const ignoredUntrustedConfigKeys = (
  selection: Pick<RuntimeSelection, 'soul'>,
  fileConfig: StratusConfigFile,
  location: Pick<ResolvedConfigLocation, 'path' | 'trusted'> | undefined,
  env: StateEnvironment = {},
): IgnoredUntrustedConfig | undefined => {
  if (location === undefined || location.trusted) {
    return undefined;
  }
  const processEnv = readProcessEnv(env);
  const keys: IgnoredUntrustedConfig['keys'] = [];
  if (selection.soul === undefined && readNonEmptyString(processEnv.STRATUS_SOUL) === undefined && fileConfig.soul) {
    keys.push('soul');
  }
  if (readNonEmptyString(processEnv.STRATUS_SYSTEM_PROMPT) === undefined && fileConfig.systemPrompt) {
    keys.push('systemPrompt');
  }
  return keys.length > 0 ? { path: location.path, keys } : undefined;
};

/**
 * {@link ignoredUntrustedConfigKeys} for the config a run started here
 * would discover, without resolving a run: a file that cannot be read is
 * answered as nothing ignored, because its own error is the run's to report.
 */
export const discoverIgnoredUntrustedConfig = async (
  selection: Pick<RuntimeSelection, 'configPath'>,
  env: StateEnvironment = {},
): Promise<IgnoredUntrustedConfig | undefined> => {
  const location = await resolveConfigLocation(selection, env).catch(() => undefined);
  if (location === undefined || location.trusted) {
    return undefined;
  }
  const fileConfig = await loadConfigFile(location.path).catch(() => undefined);
  return fileConfig === undefined ? undefined : ignoredUntrustedConfigKeys({}, fileConfig, location, env);
};

export const resolveRuntimeConfig = async (
  selection: RuntimeSelection,
  env: StateEnvironment = {},
): Promise<RuntimeConfig> => {
  const processEnv = readProcessEnv(env);
  const configLocation = selection.presetConfig !== undefined ? undefined : await resolveConfigLocation(selection, env);
  const fileConfig = selection.presetConfig?.config ?? (configLocation ? await loadConfigFile(configLocation.path) : {});
  // Trust (and the path shown in messages) follows the snapshot when one
  // is preset, the discovered location otherwise.
  const configTrusted = selection.presetConfig !== undefined ? selection.presetConfig.trusted : configLocation?.trusted;
  const configPathShown = selection.presetConfig !== undefined ? selection.presetConfig.path : configLocation?.path;
  const soulPath = selection.presetSoul !== undefined ? undefined : resolveSoulPath(selection, env, fileConfig, configTrusted);
  const soul = selection.presetSoul ?? (soulPath ? await loadSoulFile(soulPath) : undefined);

  // Explicit flags and env vars outrank the soul's own provider/model hints,
  // which outrank the config file's defaults.
  // The soul's pin in resolved form, so a soul saying `ollama` compares
  // equal to the `plugin:ollama` every other input has been read into.
  const soulProvider = readNonEmptyString(soul?.provider, (value) => parseProviderName(value, 'soul file'));
  const provider = selection.provider
    ?? readNonEmptyString(processEnv.STRATUS_PROVIDER, (value) => parseProviderName(value, 'STRATUS_PROVIDER'))
    ?? soulProvider
    ?? fileConfig.provider
    ?? 'demo';

  // What the untrusted file asked for and did not get, for the CLI to say
  // once the run is up — a persona that silently failed to apply reads as
  // the agent ignoring its instructions rather than as a trust decision.
  // Computed before the demo return: a persona shipped in a clone is
  // exactly what the demo run in that clone would otherwise pick up.
  const ignoredFromUntrustedConfig = ignoredUntrustedConfigKeys(
    selection,
    fileConfig,
    configPathShown !== undefined && configTrusted !== undefined ? { path: configPathShown, trusted: configTrusted } : undefined,
    env,
  );

  if (provider === 'demo') {
    return {
      provider: 'demo',
      ...(soul ? { soul } : {}),
      ...(soulPath ? { soulPath } : {}),
      ...(ignoredFromUntrustedConfig ? { ignoredFromUntrustedConfig } : {}),
    };
  }

  // A config file's model/baseUrl/apiKeyEnv were written for the provider
  // named in that file. When a flag, env var, or soul selects a different
  // provider, those values would point at the wrong API (e.g. an OpenAI
  // base URL handed to the Anthropic SDK), so they are ignored. A file with
  // no provider key predates the anthropic option, so its settings are
  // treated as openai-specific.
  const fileConfigApplies = (fileConfig.provider ?? 'openai') === provider;

  // A soul's model was chosen for the soul's own provider. If a flag or env
  // var overrides that provider, the model hint would target the wrong API
  // (e.g. a Claude model sent to OpenAI), so it only applies when the soul
  // names no provider or names the selected one.
  const soulModelApplies = soulProvider === undefined || soulProvider === provider;

  // The same rule as the soul: a preamble that sits above the persona in
  // every prompt is not something a cloned repo gets to write.
  const systemPrompt = readNonEmptyString(processEnv.STRATUS_SYSTEM_PROMPT)
    ?? (configTrusted === false ? undefined : fileConfig.systemPrompt);

  const credentials = await loadCredentials(env);

  /**
   * A configured fallback model kicks in when the default model errors
   * mid-run. It needs its own working sign-in; without one the fallback is
   * quietly skipped rather than failing the run it exists to rescue.
   *
   * One resolver for both primaries. Behind a built-in primary the
   * fallback may reuse that primary's sign-in and endpoint when the two
   * share a provider — `primary` carries what it may inherit. Behind a
   * contributed primary there is nothing to inherit (its plugin holds its
   * own sign-in), so `primary` is absent and the fallback resolves on its
   * own credentials alone; a built-in fallback behind a contributed
   * primary was dropped entirely before this took a parameter.
   */
  const resolveFallback = (
    fallbackProvider: StratusProviderName,
    primary: {
      provider: StratusProviderName;
      envApiKey: string | undefined;
      envApiKeyEntry: { name: string } | undefined;
      apiKey: string | undefined;
      authToken: string | undefined;
      codexSubscription: boolean;
      boundBaseUrl: string | undefined;
      baseUrl: string | undefined;
    } | undefined,
  ): FallbackRuntime | undefined => {
    if (!fileConfig.fallbackModel || fallbackProvider === 'demo') {
      return undefined;
    }
    if (isRegisteredProviderName(fallbackProvider)) {
      // A contributed fallback needs no sign-in resolved here: its plugin
      // brings its own. Selected by name, and looked up when the provider
      // is built, like a contributed primary.
      return { provider: fallbackProvider, model: fileConfig.fallbackModel };
    }
    const sameAsPrimary = primary !== undefined && fallbackProvider === primary.provider;
    // Same precedence as the primary sign-in: environment keys outrank
    // the stored credential. And the same endpoint rule: an untrusted
    // project config's custom fallback URL receives no key at all — not
    // the fallback's own stored one, not the primary's stored key when
    // both share a provider, and (see below) not an environment key
    // either.
    const fallbackUntrustedUrl = fallbackProvider === 'openai'
      && configTrusted === false
      && fileConfig.fallbackBaseUrl !== undefined
      && fileConfig.fallbackBaseUrl.replace(/\/+$/, '') !== DEFAULT_OPENAI_BASE_URL;
    const fallbackEnvKey = readNonEmptyString(processEnv[defaultApiKeyEnvName(fallbackProvider)]);
    // The primary's rule again, on the URL a fallback actually consumes.
    // Withholding only the stored key here left the same door open one
    // step further in: a project config that leaves `baseUrl` alone and
    // names `fallbackBaseUrl` looks innocent — the primary is the
    // provider's own endpoint — and collects the environment key the
    // first time a turn fails over to it.
    const fallbackEnvKeyName = fallbackEnvKey !== undefined
      ? defaultApiKeyEnvName(fallbackProvider)
      : (sameAsPrimary ? primary.envApiKeyEntry?.name : undefined);
    if (fallbackUntrustedUrl && fallbackEnvKeyName !== undefined) {
      throw new Error(
        `The project config at ${configPathShown} sets a custom fallback base URL (${String(fileConfig.fallbackBaseUrl)}), and ${fallbackEnvKeyName} is not sent to an endpoint an auto-discovered config chose. Run with --config ${configPathShown} to trust that file, or move the fallback base URL into ~/.stratus/config.json.`,
      );
    }
    const fallbackCandidate = fallbackEnvKey || fallbackUntrustedUrl ? undefined : credentials[fallbackProvider];
    // A codex fallback consumes no endpoint URL, so a stored key bound to
    // one cannot be honored there — and must not silently follow the
    // harness to a different endpoint. The fallback is quietly skipped,
    // the same treatment as any other sign-in it cannot use.
    const fallbackCredential = fallbackProvider === 'codex'
      && fallbackCandidate?.type === 'api_key'
      && fallbackCandidate.baseUrl !== undefined
      ? undefined
      : fallbackCandidate;
    const primaryReusable = sameAsPrimary
      && (primary.envApiKey !== undefined || !fallbackUntrustedUrl);
    const fallbackApiKey = (primaryReusable ? primary.apiKey : undefined)
      ?? fallbackEnvKey
      ?? (fallbackCredential?.type === 'api_key' ? fallbackCredential.value : undefined);
    const fallbackAuthToken = !sameAsPrimary && fallbackProvider === 'anthropic' && fallbackCredential?.type === 'oauth_token'
      ? fallbackCredential.value
      : (primaryReusable ? primary.authToken : undefined);
    // A codex fallback works keyless only when the subscription marker
    // says this machine has a `codex login` sign-in — its own stored
    // marker, or the primary's when both are codex.
    const fallbackCodexSubscription = fallbackProvider === 'codex' && !fallbackApiKey
      && (fallbackCredential?.type === 'oauth_token' || (primaryReusable && primary.codexSubscription));

    if (!fallbackApiKey && !fallbackAuthToken && !fallbackCodexSubscription) {
      return undefined;
    }
    // When the fallback key comes out of the credential store (its own
    // entry, or the primary's reused stored key), its bound endpoint is
    // authoritative — config URLs cannot redirect it.
    const fallbackBoundUrl = fallbackCredential?.type === 'api_key'
      ? fallbackCredential.baseUrl
      : (primaryReusable && !primary.envApiKey ? primary.boundBaseUrl : undefined);
    // An anthropic fallback on the same provider keeps the primary's
    // configured endpoint — retrying the same credential against the
    // official endpoint instead of the configured service would leak
    // it and likely fail.
    const fallbackAnthropicBaseUrl = fallbackProvider === 'anthropic'
      ? (sameAsPrimary && primary.baseUrl ? String(primary.baseUrl) : undefined)
        ?? (fallbackCredential?.type === 'api_key' ? fallbackCredential.baseUrl : undefined)
      : undefined;
    return {
      provider: fallbackProvider,
      model: fileConfig.fallbackModel,
      // One operator setting for the daemon, so it applies to whichever
      // Anthropic model ends up serving the turn. Inert on the other two
      // providers, which do not build their own requests.
      ...(fileConfig.promptCache !== undefined ? { promptCache: fileConfig.promptCache } : {}),
      ...(fileConfig.promptCacheTtl ? { promptCacheTtl: fileConfig.promptCacheTtl } : {}),
      // And the output cap, by the same rule as the line above it: one
      // operator setting for the daemon, applying to whichever Anthropic
      // model ends up serving the turn. It matters most here — the setting
      // exists for a model whose ceiling is under the default, and a
      // fallback left on the default fails every request from the moment
      // it takes over.
      ...(fileConfig.maxTokens !== undefined ? { maxTokens: fileConfig.maxTokens } : {}),
      // The one daemon-wide `vision` setting reaches an OpenAI-compatible
      // fallback too; the other providers never ask.
      ...(fallbackProvider === 'openai' && fileConfig.vision !== undefined ? { vision: fileConfig.vision } : {}),
      ...(fallbackProvider === 'openai'
        ? {
            baseUrl: fallbackBoundUrl
              ?? fileConfig.fallbackBaseUrl
              ?? (sameAsPrimary ? String(primary.baseUrl) : undefined)
              ?? DEFAULT_OPENAI_BASE_URL,
          }
        : (fallbackAnthropicBaseUrl ? { baseUrl: fallbackAnthropicBaseUrl } : {})),
      ...(fallbackApiKey ? { apiKey: String(fallbackApiKey) } : {}),
      ...(fallbackAuthToken ? { authToken: fallbackAuthToken } : {}),
      ...(fallbackCodexSubscription ? { codexSubscription: true as const } : {}),
      // Here rather than with the primary's transport above, because
      // the fallback does not exist yet at that point. A subscription
      // fallback behind an OpenAI primary has no transport to inherit,
      // so without this it reaches the real Agent SDK the moment the
      // primary fails.
      ...(env.queryFn && fallbackProvider === 'anthropic' ? { queryFn: env.queryFn } : {}),
      ...(env.codexRunTurn && fallbackProvider === 'codex' ? { codexRunTurn: env.codexRunTurn } : {}),
    };
  };

  if (isRegisteredProviderName(provider)) {
    // A contributed provider: nothing here selects a key or an endpoint
    // for it — its plugin owns both — so what resolution decides is the
    // model, the preamble, the soul, and a fallback, which resolves on its
    // own sign-in whether it names a built-in or another plugin.
    const registeredModel = selection.model
      ?? readNonEmptyString(processEnv.STRATUS_MODEL)
      ?? (soulModelApplies ? readNonEmptyString(soul?.model) : undefined)
      ?? (fileConfigApplies ? fileConfig.model : undefined);
    const registered: RuntimeConfig = {
      provider,
      ...(registeredModel ? { model: String(registeredModel) } : {}),
      ...(systemPrompt ? { systemPrompt: String(systemPrompt) } : {}),
      ...(env.fetch ? { fetch: env.fetch } : {}),
      ...(soul ? { soul } : {}),
      ...(soulPath ? { soulPath } : {}),
      ...(ignoredFromUntrustedConfig ? { ignoredFromUntrustedConfig } : {}),
    };
    // The same implicit-fallback rule as below: a fallback with no
    // provider of its own was written for the config's provider.
    const fallbackProvider = fileConfig.fallbackProvider ?? (fileConfigApplies ? provider : undefined);
    const fallback = fallbackProvider !== undefined ? resolveFallback(fallbackProvider, undefined) : undefined;
    if (fallback) {
      registered.fallback = fallback;
    }
    return registered;
  }

  const model = selection.model
    ?? readNonEmptyString(processEnv.STRATUS_MODEL)
    ?? (soulModelApplies ? readNonEmptyString(soul?.model) : undefined)
    ?? (fileConfigApplies ? fileConfig.model : undefined)
    ?? (provider === 'anthropic'
      ? DEFAULT_ANTHROPIC_MODEL
      : provider === 'codex'
        ? DEFAULT_CODEX_MODEL
        : DEFAULT_OPENAI_MODEL);

  const apiKeyEnvName = apiKeyEnvNameFor(provider as CredentialProviderName, fileConfig, fileConfigApplies, env, configTrusted);
  // Read off the answer rather than re-deriving the rule that produced it:
  // an untrusted config named a variable and something else won. There is
  // no warning channel here (`resolveRuntimeConfig` takes no logger), so
  // the one place this can be said is the error someone gets when no key
  // resolves — which is exactly the case where the substitution is why
  // they are stuck.
  const ignoredApiKeyEnv = configTrusted === false
    && fileConfigApplies
    && typeof fileConfig.apiKeyEnv === 'string'
    && fileConfig.apiKeyEnv !== apiKeyEnvName
    ? fileConfig.apiKeyEnv
    : undefined;

  // A custom endpoint chosen by an auto-discovered project config is not a
  // place the stored sign-in ever gets sent — a cloned repository could
  // point it anywhere. Flags and env vars are the user's own choice, and
  // the provider's default endpoint is harmless.
  const defaultEndpointFor = (target: string): string =>
    target === 'anthropic' ? DEFAULT_ANTHROPIC_BASE_URL : DEFAULT_OPENAI_BASE_URL;
  const untrustedCustomBaseUrl = configTrusted === false
    // The codex harness owns its endpoints entirely — no configured URL is
    // ever consumed for it, so there is nothing a project config could
    // redirect a credential to.
    && provider !== 'codex'
    && selection.baseUrl === undefined
    && readNonEmptyString(processEnv.STRATUS_BASE_URL) === undefined
    && fileConfigApplies
    && fileConfig.baseUrl !== undefined
    && fileConfig.baseUrl.replace(/\/+$/, '') !== defaultEndpointFor(String(provider));

  // Env vars outrank the stored sign-in from `stratus setup`.
  const envApiKeyEntry = resolveEnvApiKey(apiKeyEnvName, env);
  const envApiKey = envApiKeyEntry?.value;
  const candidateCredential = credentials[provider as CredentialProviderName];
  // A bound credential ignores config URLs entirely, so an untrusted
  // project URL cannot redirect it — only unbound stored keys are blocked.
  const credentialIsBound = candidateCredential?.type === 'api_key' && candidateCredential.baseUrl !== undefined;
  const storedCredential = envApiKey || (untrustedCustomBaseUrl && !credentialIsBound)
    ? undefined
    : candidateCredential;

  const apiKey = envApiKey
    ?? (storedCredential?.type === 'api_key' ? storedCredential.value : undefined);
  const authToken = provider === 'anthropic' && storedCredential?.type === 'oauth_token'
    ? storedCredential.value
    : undefined;
  // A stored codex oauth_token is a subscription marker, not a secret: it
  // records that this machine's own `codex login` sign-in serves the run,
  // and its value is never read or sent anywhere (see StoredCredential).
  const codexSubscription = provider === 'codex' && storedCredential?.type === 'oauth_token';

  // A stored key bound to an endpoint is used ONLY with that endpoint — a
  // config file can never redirect it, not even to the official default
  // URL (a project config could otherwise reroute a local-service key to
  // the official API). An explicit flag or env URL that disagrees refuses
  // the stored key instead of leaking it. This applies to both providers.
  const boundBaseUrl = !envApiKey && storedCredential?.type === 'api_key'
    ? storedCredential.baseUrl
    : undefined;
  const explicitBaseUrl = selection.baseUrl
    ?? readNonEmptyString(processEnv.STRATUS_BASE_URL);

  // The codex harness owns its endpoints, so no configured URL is ever
  // consumed for a codex run — which means a named endpoint cannot be
  // honored, and silently dropping it would send the key somewhere other
  // than where the person who named the endpoint said it may go. Fail
  // closed instead: a codex run with any base URL in play — a bound
  // stored key, a flag or env URL, or the config file's — is refused.
  if (provider === 'codex') {
    const namedBaseUrl = boundBaseUrl
      ?? explicitBaseUrl
      ?? (fileConfigApplies ? fileConfig.baseUrl : undefined);
    if (namedBaseUrl !== undefined) {
      throw new Error(
        `provider=codex does not use a custom base URL — the codex harness owns its endpoints, so a key meant for ${String(namedBaseUrl)} would not be sent there. Remove the base URL (or store the codex key without one) to run on codex.`,
      );
    }
  }
  if (boundBaseUrl && explicitBaseUrl
    && String(explicitBaseUrl).replace(/\/+$/, '') !== boundBaseUrl.replace(/\/+$/, '')) {
    throw new Error(
      `Your saved ${provider} sign-in is bound to ${boundBaseUrl} and is not sent to ${explicitBaseUrl}. Set ${apiKeyEnvName} or STRATUS_API_KEY to use that endpoint.`,
    );
  }
  // The other half of the rule the stored sign-in has always followed: an
  // endpoint an auto-discovered project config chose is not a place this
  // process sends a secret. The stored key was already withheld there;
  // an environment key was not, so a cloned repository shipping a
  // `stratus.config.json` with its own `baseUrl` collected whatever key
  // the operator had exported, in their own shell, for their own work.
  //
  // Refused rather than quietly redirected to the default endpoint: a
  // project that legitimately points at a local model is a real setup, and
  // silently talking to the official API instead would be a surprising bill
  // and a leaked prompt. The two ways to say "I meant this file" are both
  // named, and both are the operator's own act rather than the repository's.
  if (untrustedCustomBaseUrl && envApiKeyEntry) {
    throw new Error(
      `The project config at ${configPathShown} sets a custom base URL (${String(fileConfig.baseUrl)}), and ${envApiKeyEntry.name} is not sent to an endpoint an auto-discovered config chose. Run with --config ${configPathShown} to trust that file, or move the base URL into ~/.stratus/config.json.`,
    );
  }

  const baseUrl = boundBaseUrl
    ?? explicitBaseUrl
    ?? (fileConfigApplies ? fileConfig.baseUrl : undefined)
    // The Anthropic SDK knows its own endpoint, and the codex harness owns
    // its endpoints entirely; only openai needs a default.
    ?? (provider === 'anthropic' || provider === 'codex' ? undefined : DEFAULT_OPENAI_BASE_URL);

  if (!apiKey && !authToken && !codexSubscription) {
    if (untrustedCustomBaseUrl && credentials[provider as CredentialProviderName]) {
      throw new Error(
        `The project config at ${configPathShown} sets a custom base URL (${fileConfig.baseUrl}), so your saved sign-in is not sent to it. Run with --config ${configPathShown} to trust that file, or move the base URL into ~/.stratus/config.json.`,
      );
    }
    if (provider === 'codex') {
      throw new Error(
        `Missing sign-in for provider=codex. Run \`stratus setup\` to record a ChatGPT (\`codex login\`) sign-in or store an API key, or set STRATUS_API_KEY or ${apiKeyEnvName}.`,
      );
    }
    throw new Error(
      `Missing API key for provider=${provider}. Run \`stratus setup\` to sign in, or set STRATUS_API_KEY or ${apiKeyEnvName}.`
      + (ignoredApiKeyEnv !== undefined
        ? ` (The project config at ${configPathShown} asks for ${ignoredApiKeyEnv}, which an auto-discovered config does not get to choose — it decides which of this machine's secrets the process reads. Run with --config ${configPathShown} to trust that file.)`
        : ''),
    );
  }

  const resolved: RuntimeConfig = provider === 'anthropic'
    ? {
        provider: 'anthropic',
        model: String(model),
        ...(baseUrl ? { baseUrl: String(baseUrl) } : {}),
        ...(apiKey ? { apiKey: String(apiKey) } : {}),
        ...(authToken ? { authToken } : {}),
        // Caching settings ride only on this variant: it is the one adapter
        // where Stratus builds the request. The harness providers assemble
        // their own prompts inside their SDKs, and the OpenAI-compatible
        // dialect is a different mechanism behind too many vendors to answer
        // with one switch.
        ...(fileConfig.promptCache !== undefined ? { promptCache: fileConfig.promptCache } : {}),
        ...(fileConfig.promptCacheTtl ? { promptCacheTtl: fileConfig.promptCacheTtl } : {}),
        // Only this variant asks, for the same reason `vision` is only on
        // the OpenAI one: the harnesses choose their own output cap, and
        // the OpenAI-compatible adapter sends none at all.
        ...(fileConfig.maxTokens !== undefined ? { maxTokens: fileConfig.maxTokens } : {}),
        ...(envApiKeyEntry ? { apiKeyEnvVar: envApiKeyEntry.name } : {}),
      }
    : provider === 'codex'
      ? {
          provider: 'codex',
          model: String(model),
          // No apiKey means the machine's own `codex login` sign-in serves
          // the run; the harness reads its own auth store.
          ...(apiKey ? { apiKey: String(apiKey) } : {}),
          ...(envApiKeyEntry ? { apiKeyEnvVar: envApiKeyEntry.name } : {}),
        }
      : {
          provider: 'openai',
          model: String(model),
          baseUrl: String(baseUrl),
          apiKey: String(apiKey),
          // Only this variant asks: the Anthropic models all take images,
          // and the harnesses render a text prompt whatever the model.
          ...(fileConfig.vision !== undefined ? { vision: fileConfig.vision } : {}),
          ...(envApiKeyEntry ? { apiKeyEnvVar: envApiKeyEntry.name } : {}),
        };

  if (systemPrompt) {
    resolved.systemPrompt = String(systemPrompt);
  }

  if (ignoredFromUntrustedConfig) {
    resolved.ignoredFromUntrustedConfig = ignoredFromUntrustedConfig;
  }

  if (env.fetch) {
    resolved.fetch = env.fetch;
  }

  if (env.queryFn && resolved.provider === 'anthropic') {
    resolved.queryFn = env.queryFn;
  }

  if (env.codexRunTurn && resolved.provider === 'codex') {
    resolved.codexRunTurn = env.codexRunTurn;
  }

  if (soul) {
    resolved.soul = soul;
  }
  if (soulPath) {
    resolved.soulPath = soulPath;
  }

  // An implicit fallback (no fallbackProvider key) was written for the
  // config's own provider — when a flag, env var, or soul overrides that
  // provider, the fallback model would target the wrong API, so it is
  // ignored. An explicit fallbackProvider stays valid regardless.
  if (fileConfig.fallbackModel && (fileConfig.fallbackProvider !== undefined || fileConfigApplies)) {
    const fallback = resolveFallback(fileConfig.fallbackProvider ?? (provider as StratusProviderName), {
      provider: provider as StratusProviderName,
      envApiKey: envApiKey !== undefined ? String(envApiKey) : undefined,
      envApiKeyEntry,
      apiKey: apiKey !== undefined ? String(apiKey) : undefined,
      authToken,
      codexSubscription,
      boundBaseUrl,
      baseUrl: baseUrl !== undefined ? String(baseUrl) : undefined,
    });
    if (fallback) {
      resolved.fallback = fallback;
    }
  }

  return resolved;
};
