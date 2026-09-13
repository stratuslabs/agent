import type {
  CredentialResolver,
  JsonObject,
  ModelProvider,
  Plugin,
  ProviderRequest,
  ProviderResponse,
} from '@stratusagent/core';
import { createOpenAICompatibleProvider } from '@stratusagent/providers';

/**
 * The name a soul selects this provider by. Not `openai`: that name is the
 * built-in adapter with its stored sign-in and endpoint binding, and a
 * plugin may not shadow a built-in — the host refuses the manifest.
 */
export const OPENAI_COMPATIBLE_PROVIDER_NAME = 'openai-compatible';

/** The credential this plugin resolves, per calling agent — declared in the manifest. */
export const OPENAI_API_KEY_CREDENTIAL = 'openai.apiKey';

export interface OpenAiProviderPluginOptions {
  /** Test injection: the transport the adapter sends on. */
  fetch?: typeof fetch;
}

const readString = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);

const readHeaders = (value: unknown): Record<string, string> => {
  const headers: Record<string, string> = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return headers;
  }
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      headers[name] = entry;
    }
  }
  return headers;
};

/**
 * The OpenAI-compatible adapter, reached through the provider seam.
 *
 * The adapter is `@stratusagent/providers`' `createOpenAICompatibleProvider`
 * unchanged; what this package adds is the two things a plugin provider
 * gets that a built-in does not. Its settings — the endpoint, a default
 * model, extra headers — come from its own config block. And its key comes
 * through the manifest-bound credential resolver, **per calling agent**:
 * `openai.apiKey` is a named credential the soul allowlists, resolved on
 * every request from the agent the request is for, so two agents on one
 * installed plugin can bill to two accounts, and a rotated key needs no
 * restart. The adapter takes a fixed key, so one is built per (selection,
 * key) and kept — never one per turn.
 *
 * Nothing here reads `process.env`, and the built-in `openai` selection —
 * the stored sign-in, the endpoint binding, `STRATUS_API_KEY` — is
 * untouched: this is the same adapter arriving the way a third party's
 * would, which is the point of building it.
 */
export const createOpenAiProviderPlugin = (
  config: JsonObject = {},
  options: OpenAiProviderPluginOptions = {},
): Plugin => {
  const baseUrl = readString(config.baseUrl);
  const configuredModel = readString(config.model);
  const headers = readHeaders(config.headers);
  const vision = typeof config.vision === 'boolean' ? config.vision : undefined;
  const requestTimeoutMs = typeof config.requestTimeoutMs === 'number' ? config.requestTimeoutMs : undefined;

  return {
    name: 'provider-openai',
    setup(context) {
      if (!context.providers) {
        throw new Error(
          `This host hands plugins no provider handle, so @stratusagent/provider-openai cannot register ${OPENAI_COMPATIBLE_PROVIDER_NAME}.`,
        );
      }
      const credentials: CredentialResolver | undefined = context.credentials;

      context.providers.register({
        name: OPENAI_COMPATIBLE_PROVIDER_NAME,
        // The chat-completions adapter answers in one response; nothing
        // reaches `onDelta`, so a host must not arm a stall watchdog over it.
        streams: false,
        create(selection) {
          const model = selection.model ?? configuredModel;
          if (model === undefined) {
            throw new Error(
              `No model for provider ${OPENAI_COMPATIBLE_PROVIDER_NAME}: set model: in the soul, or model in plugins["@stratusagent/provider-openai"].`,
            );
          }
          // One adapter per key this selection has been asked to use. A
          // fleet of agents on one account shares one; an agent on its own
          // account gets its own; a rotated key gets a fresh one.
          const adapters = new Map<string, ModelProvider>();
          const adapterFor = (apiKey: string): ModelProvider => {
            let adapter = adapters.get(apiKey);
            if (!adapter) {
              adapter = createOpenAICompatibleProvider({
                model,
                apiKey,
                name: OPENAI_COMPATIBLE_PROVIDER_NAME,
                headers,
                ...(baseUrl !== undefined ? { baseUrl } : {}),
                ...(selection.systemPrompt !== undefined ? { systemPrompt: selection.systemPrompt } : {}),
                ...(vision !== undefined ? { vision } : {}),
                ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
                ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
              });
              adapters.set(apiKey, adapter);
            }
            return adapter;
          };

          return {
            name: OPENAI_COMPATIBLE_PROVIDER_NAME,
            async generate(request: ProviderRequest): Promise<ProviderResponse> {
              if (!credentials) {
                throw new Error(
                  `This host hands plugins no credential resolver, so ${OPENAI_COMPATIBLE_PROVIDER_NAME} cannot reach ${OPENAI_API_KEY_CREDENTIAL} for agent ${request.session.agent.id}.`,
                );
              }
              // The calling agent's key, every request — its own entry,
              // then the fleet's shared one — and refused, naming the
              // remedy, rather than read from the environment.
              const apiKey = await credentials.resolve(request.session.agent, OPENAI_API_KEY_CREDENTIAL);
              if (apiKey === undefined) {
                throw new Error(
                  `No ${OPENAI_API_KEY_CREDENTIAL} credential resolves for agent ${request.session.agent.id}. `
                  + `Store one with \`stratus credential set ${OPENAI_API_KEY_CREDENTIAL}\` (or per agent with --agent), and list it in the soul's credentials:.`,
                );
              }
              return adapterFor(apiKey).generate(request);
            },
          };
        },
      });
    },
  };
};

/** The loader's entry point. See docs/architecture/plugins.md. */
export const createPlugin = (config: JsonObject): Plugin => createOpenAiProviderPlugin(config);
