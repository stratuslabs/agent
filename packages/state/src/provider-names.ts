import { BUILTIN_PROVIDER_NAMES, type BuiltinProviderName } from '@stratusagent/core';

/**
 * The prefix every consumer carries a plugin-registered provider under.
 * A soul writes `provider: ollama`; resolution carries it as
 * `plugin:ollama`, and the prefix is what keeps the resolved config a
 * discriminated union — a bare `string` beside the built-in literals
 * would stop `config.provider === 'anthropic'` narrowing anywhere.
 */
export const REGISTERED_PROVIDER_PREFIX = 'plugin:';

/**
 * A provider a plugin registered through `PluginContext.providers`, in its
 * resolved form. Selectable wherever a built-in is — a soul's `provider:`,
 * the config file, `--provider`, `fallbackProvider` — by its bare name or
 * this prefixed one; both parse to this.
 */
export type RegisteredProviderName = `${typeof REGISTERED_PROVIDER_PREFIX}${string}`;

/** Any provider a run can select: a built-in, or a name a plugin registered. */
export type StratusProviderName = BuiltinProviderName | RegisteredProviderName;

export const isBuiltinProviderName = (value: string): value is BuiltinProviderName =>
  (BUILTIN_PROVIDER_NAMES as readonly string[]).includes(value);

export const isRegisteredProviderName = (value: string): value is RegisteredProviderName =>
  value.startsWith(REGISTERED_PROVIDER_PREFIX);

/** The bare name a plugin registered under: `plugin:ollama` → `ollama`. */
export const registeredProviderNameOf = (name: RegisteredProviderName): string =>
  name.slice(REGISTERED_PROVIDER_PREFIX.length);

// The shape a contributed name takes — a plugin manifest's rule, read the
// same way here so `provider: Ollama` is refused at parse rather than
// carried to a lookup that can never match.
export const REGISTERED_PROVIDER_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Every provider a sign-in can be stored for, as data. Exported so the
 * surfaces that enumerate providers (setup's summary, doctor, the control
 * API's credentials listing, model discovery) sweep one list instead of
 * each hand-writing the pair this used to be — those copies are exactly
 * how an implemented provider stays unreachable from a surface.
 */
export const CREDENTIAL_PROVIDER_NAMES = ['anthropic', 'openai', 'codex'] as const;

export type CredentialProviderName = (typeof CREDENTIAL_PROVIDER_NAMES)[number];

export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

export const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini';

/**
 * Read a provider selection into its resolved form. A built-in name is
 * itself; a name a plugin could register — bare (`ollama`) or already
 * prefixed (`plugin:ollama`) — becomes `plugin:ollama`. Whether a plugin
 * has actually registered it is a question for the host that loaded the
 * plugins, asked when the provider is built; a config file is parsed by
 * processes that load none.
 */
export const parseProviderName = (value: string, label: string): StratusProviderName => {
  if (isBuiltinProviderName(value)) {
    return value;
  }
  const bare = isRegisteredProviderName(value) ? registeredProviderNameOf(value) : value;
  if (REGISTERED_PROVIDER_NAME_PATTERN.test(bare)) {
    return `${REGISTERED_PROVIDER_PREFIX}${bare}`;
  }

  throw new Error(
    `Unsupported provider in ${label}: ${value}. Use demo, anthropic, openai, codex, or the name a plugin registers (lowercase, hyphens).`,
  );
};

// ---------------------------------------------------------------------------
// Provider catalogs and key verification
// ---------------------------------------------------------------------------

/**
 * The provider-specific variable a key is read from when nothing else names
 * one. `apiKeyEnvNameFor` is the full rule — config file and generic
 * overrides included; this is only the last term of it, which callers
 * enumerating providers (a catalog sweep, a sign-in status line) need on its
 * own for a provider that is *not* the configured default.
 */
export const defaultApiKeyEnvName = (provider: CredentialProviderName): string => {
  switch (provider) {
    case 'openai':
      return 'OPENAI_API_KEY';
    // The variable the codex binary itself honors — an OpenAI platform key
    // under a different name, because for codex it is exec-mode auth, not
    // the general OPENAI_API_KEY (which codex no longer reads at runtime).
    case 'codex':
      return 'CODEX_API_KEY';
    default:
      return 'ANTHROPIC_API_KEY';
  }
};
