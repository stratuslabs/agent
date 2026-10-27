import {
  BUILTIN_PROVIDER_NAMES,
  describeEffort,
  resolveEffort,
  type AgentModelContext,
  type ContributionRegistry,
  type ProviderContribution,
  type JsonValue,
  type ModelProvider,
  type ProviderCallUsage,
  type ProviderRequest,
  type ProviderResponse,
  type Session,
} from '@stratusagent/core';
import { defineLocalCommandTool } from '@stratusagent/executor-local';
import {
  CODEX_THREAD_METADATA_KEY,
  createOpenAICompatibleProvider,
  createProviderResponseBuilder,
  defineProvider,
  hasHostedToolSideEffects,
  SDK_SESSION_AUTH_METADATA_KEY,
  SDK_SESSION_METADATA_KEY,
  type HostedToolExecutor,
} from '@stratusagent/providers';
import { ContextOverflowError, HostRefusalError } from '@stratusagent/core';
// Types only, erased at build: the provider packages are loaded with
// `import()` when an agent first runs on one (see `loadProviderPackage`),
// so a host never loads one its agents do not use, and the CLI installs
// with none of them.
import type { ClaudeCodeQueryFn } from '@stratusagent/provider-claude-code';
import type { CodexRunTurn } from '@stratusagent/provider-codex';
import type { RuntimeConfig } from './config.ts';
import { registeredProviderNameOf } from './provider-names.ts';

export const createDemoTool = () =>
  defineLocalCommandTool({
    name: 'demo.echo',
    description: 'Return a tiny transformed summary for CLI demos through a real local process.',
    // It does spawn a process, but a fixed one: `node -e` over a script this
    // tool builds, with the model's text placed as a JSON string literal and
    // no shell involved. Nothing the model says becomes a command.
    risk: 'safe',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to echo back through the local process.' },
      },
      required: ['text'],
    },
    async createCommand(input) {
      const text = typeof input.text === 'string' ? input.text : '';
      const normalized = text.trim() || 'empty input';
      const script = `const text = ${JSON.stringify(normalized)}; console.log(JSON.stringify({ received: text, uppercase: text.toUpperCase(), length: text.length }));`;

      return {
        command: process.execPath,
        args: ['-e', script],
      };
    },
    parseResult(result) {
      return JSON.parse(result.stdout) as JsonValue;
    },
  });

export const createDemoProvider = (): ModelProvider =>
  defineProvider({
    name: 'demo',
    async generate({ session }) {
      const builder = createProviderResponseBuilder();
      const lastMessage = session.messages.at(-1);

      if (lastMessage?.role === 'tool') {
        const result = lastMessage.toolResult;
        if (result?.ok) {
          builder.addText(`The demo.echo tool finished with: ${JSON.stringify(result.output)}`);
        } else {
          builder.addText(`The demo.echo tool did not run (${result?.error ?? 'unknown error'}), so this run ends here.`);
        }
        return builder.done();
      }

      const prompt = [...session.messages].reverse().find((message) => message.role === 'user')?.content?.trim() ?? '';
      const wantsTool = /\b(tool|echo|uppercase|inspect)\b/i.test(prompt);

      builder.addText(`Demo provider ready. Prompt received: ${prompt || '(empty)'}`);

      if (wantsTool) {
        builder.addToolCall({
          id: `${session.id}:call:demo-echo`,
          toolName: 'demo.echo',
          input: { text: prompt },
        });
      } else {
        builder.addText('No tool call was needed, so this run stays text-only. Mention “tool” or “echo” to trigger the demo tool.');
      }

      return builder.done();
    },
  });

/**
 * Session metadata flag marking a conversation as switched to its fallback
 * model. Lives on the session (persisted by the runner's saves) so the
 * documented session-sticky behavior survives daemon restarts and runner
 * rebuilds — a conversation never silently returns to the primary provider.
 */
export const FALLBACK_ACTIVE_METADATA_KEY = 'fallbackActive';

/**
 * Where the Anthropic provider keeps the raw assistant turns it replays
 * (its `RAW_TURNS_METADATA_KEY`). Restated here so state can list and
 * redact it without importing the adapter; a state test holds the two equal.
 */
export const ANTHROPIC_RAW_TURNS_METADATA_KEY = 'anthropicRawTurns';

/**
 * Session metadata that holds model output deliberately never shown to
 * people: the raw turns, thinking blocks included, that a provider hands
 * back verbatim on the next request. Stores keep them, because replay
 * needs them; anything that exports, prints or serves a session for people
 * passes it through `redactProviderReplayState` first.
 */
const REPLAY_CONTENT_METADATA_KEYS: readonly string[] = [ANTHROPIC_RAW_TURNS_METADATA_KEY];

/**
 * A copy of the session without provider replay content (see
 * `REPLAY_CONTENT_METADATA_KEYS`), or the session itself when it has none.
 * Metadata left empty is dropped. The provider-neutral form of the
 * Anthropic adapter's `redactAnthropicRawTurns`, so the CLI and the
 * control API need no adapter to hide it.
 */
export const redactProviderReplayState = (session: Session): Session => {
  const metadata = session.metadata;
  if (!metadata || !REPLAY_CONTENT_METADATA_KEYS.some((key) => key in metadata)) {
    return session;
  }
  const kept = Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !REPLAY_CONTENT_METADATA_KEYS.includes(key)),
  );
  const { metadata: _metadata, ...rest } = session;
  return Object.keys(kept).length > 0 ? { ...rest, metadata: kept } : rest;
};

/**
 * The session metadata keys that describe a provider's view of *this
 * transcript* — the Anthropic raw-turn replay cache, the Claude Code SDK
 * session id, the Codex thread id, and the sticky fallback switch. They
 * belong to the messages they were written beside and must not follow a
 * conversation onto a fresh transcript: a harness handed its old session id
 * would resume the old thread, and the rollover that was meant to leave a
 * pre-upgrade prefix behind would carry it forward verbatim. Owned here
 * because this is the one package that already knows all four providers.
 */
export const PROVIDER_STATE_METADATA_KEYS: readonly string[] = [
  FALLBACK_ACTIVE_METADATA_KEY,
  ANTHROPIC_RAW_TURNS_METADATA_KEY,
  SDK_SESSION_METADATA_KEY,
  SDK_SESSION_AUTH_METADATA_KEY,
  CODEX_THREAD_METADATA_KEY,
];

/**
 * What serves a run, for the prompt: the configured provider and model,
 * the fallback behind them, and whether this conversation has already
 * switched (its `FALLBACK_ACTIVE_METADATA_KEY`). One reading of a resolved
 * config for every host, so the daemon and `stratus run` describe a
 * runtime the same way. A switch that happens mid-turn is marked by the
 * fallback wrapper itself, on the request it hands the fallback.
 */
export const describeServingModel = (config: RuntimeConfig, onFallback: boolean): AgentModelContext => ({
  provider: config.provider,
  ...(config.provider !== 'demo' && config.model !== undefined ? { model: config.model } : {}),
  ...(config.provider !== 'demo' && config.fallback !== undefined
    ? { fallback: { provider: config.fallback.provider, model: config.fallback.model } }
    : {}),
  ...(onFallback ? { onFallback: true } : {}),
});

// Wraps the fallback runtime as a provider: the primary model serves every
// turn until it throws, then that session switches to the fallback for
// good. Stickiness is per session, never per provider instance — a pooled
// provider serves many sessions (the gateway), and one session's transient
// failure must not silently reroute every other conversation. The switch
// is recorded in session metadata so it is as durable as the session; the
// in-memory set only covers the window before the next save.
export const createFallbackWrappedProvider = (
  primary: ModelProvider,
  fallback: ModelProvider,
  onFallback: (error: unknown) => void,
  persistSession?: (session: Session) => Promise<void>,
): ModelProvider => {
  const fallbackSessions = new Set<string>();

  return {
    name: primary.name,
    async generate(request) {
      const switched = request.session.metadata?.[FALLBACK_ACTIVE_METADATA_KEY] === true
        || fallbackSessions.has(request.session.id);
      if (!switched) {
        try {
          return await primary.generate(request);
        } catch (error) {
          // A turn that already executed tools must not be replayed on
          // another provider — the side effects (a remembered fact, a
          // command) would happen twice.
          if (hasHostedToolSideEffects(error)) {
            throw error;
          }
          // A cancelled turn is not a provider failure: the abort error
          // must surface as-is, and the session must not be routed to the
          // fallback model for every later conversation turn.
          if (request.signal?.aborted) {
            throw error;
          }
          // Nor is a transcript that outgrew the window. It is the one
          // rejection the runner can act on — it trims and retries the
          // SAME provider — and swallowing it here would spend a
          // conversation's permanent switch to the fallback model on a
          // request that never needed another model, only a shorter one.
          // The fallback would then take the same too-long transcript and,
          // where it has a smaller window, fail on it too.
          if (error instanceof ContextOverflowError) {
            throw error;
          }
          // Nor is a refusal the host made on purpose (a spent budget). The
          // limit is the agent's, not the primary model's, so the fallback
          // answering would spend exactly what it exists to stop and make
          // the stop invisible besides.
          if (error instanceof HostRefusalError) {
            throw error;
          }
          fallbackSessions.add(request.session.id);
          (request.session.metadata ??= {})[FALLBACK_ACTIVE_METADATA_KEY] = true;
          onFallback(error);
          // The switch is durable BEFORE the fallback attempt begins: a
          // daemon killed while the fallback is in flight must not retry
          // the primary on restart — stickiness is the contract.
          // Best-effort: if the save itself fails, the in-memory
          // stickiness still covers this process's lifetime.
          if (persistSession) {
            try {
              await persistSession(request.session);
            } catch {
              // Served anyway; the next runner save retries persistence.
            }
          }
          // A reset always precedes the fallback attempt when a sink is
          // attached: it discards whatever partial primary output the
          // consumer buffered, and it is the one in-band signal that this
          // turn switched providers — watchers (the gateway's idle
          // watchdog) rely on it even when the primary died before its
          // first delta.
          if (request.onDelta) {
            await request.onDelta({ type: 'reset', reason: 'fallback' });
          }
        }
      }
      return attributeUsage(fallback, request);
    },
  };
};

/**
 * Run the fallback, with its own name filled in on any usage that arrives
 * without one and its response usage forwarded through the sink.
 *
 * Two separate corrections, both forced by this wrapper answering to the
 * *primary's* name for the life of the session:
 *
 * **The name.** The kernel attributes an unnamed count to the provider it
 * asked, and the provider it asked is this wrapper. So a fallback adapter
 * that does not name itself would have its tokens filed under the model that
 * failed, in the one case the whole attribution requirement exists for.
 * Every adapter in this repository names itself and never reaches the `??`;
 * a third-party one that does not still gets the truth.
 *
 * **The channel.** Sink reporting is exclusive for a whole `generate`, and
 * both providers share this one. A primary that reported a failed attempt
 * through the sink before throwing has therefore already switched the kernel
 * off the response field — so a single-call fallback answering with `usage`
 * on its response would be silently dropped, recording the attempt that
 * failed and not the turn that succeeded. Forwarding closes that, and cannot
 * double-count: it happens only when the fallback did not use the sink
 * itself, which is the same rule the kernel applies one level up.
 */
const attributeUsage = async (
  fallback: ModelProvider,
  request: ProviderRequest,
): Promise<ProviderResponse> => {
  const onUsage = request.onUsage;
  const attribute = (usage: ProviderCallUsage): ProviderCallUsage => ({
    ...usage,
    provider: usage.provider ?? fallback.name,
  });

  let fallbackReported = false;
  const runtime = request.runtime;
  const response = await fallback.generate({
    ...request,
    // The host said what it had configured when the turn began, before
    // this wrapper switched: the fallback answering must not be told the
    // default is.
    ...(runtime?.model !== undefined ? { runtime: { ...runtime, model: { ...runtime.model, onFallback: true } } } : {}),
    ...(onUsage
      ? {
          onUsage: (usage) => {
            fallbackReported = true;
            onUsage(attribute(usage));
          },
        }
      : {}),
  });

  if (!response.usage) {
    return response;
  }
  if (onUsage && !fallbackReported) {
    onUsage(attribute(response.usage));
  }
  return { ...response, usage: attribute(response.usage) };
};

/**
 * What a host loaded from its plugins' `providers` handles — the registry
 * `loadPlugins` committed into, or any lookup shaped like it. Consulted
 * only for a `plugin:` name; a built-in never goes through it.
 */
export type RegisteredProviders = Pick<ContributionRegistry<ProviderContribution>, 'get' | 'names'>;

/**
 * Whether a resolved runtime is served by a harness that runs its own tool
 * loop and keeps its own conversation — the codex harness, and the Claude
 * subscription path through the Agent SDK — rather than by the kernel's
 * loop over a stateless API. The one rule for both the provider that gets
 * built and anything that has to know what the turn is talking to: the
 * gateway will not continue a crashed turn on one, because the prompt may
 * already have run tools inside it that the transcript never saw.
 */
export const runsOnHarness = (
  config: { provider: string; apiKey?: string | undefined; authToken?: string | undefined },
): boolean =>
  config.provider === 'codex' || (config.provider === 'anthropic' && Boolean(config.authToken) && !config.apiKey);

/**
 * What a run's effort setting does, for the daemon log: the agent's soul
 * asked for a level, and this says what each model serving it is sent,
 * on which runtime. `undefined` when the soul sets no effort — those
 * agents send none and stay on each model's default.
 *
 * Read from the resolved config, the same fields provider construction
 * reads, so the line cannot describe a request the providers do not make.
 */
export const describeRuntimeEffort = (config: RuntimeConfig): string | undefined => {
  const requested = config.soul?.effort;
  if (requested === undefined || config.provider === 'demo') {
    return undefined;
  }
  const agent = config.soul?.agent.id ?? 'default agent';
  const source = config.soulPath ? `soul ${config.soulPath}` : 'soul';
  const primary = config.provider === 'anthropic'
    ? `${agent}: effort ${describeEffort(config.model, resolveEffort(config.model, requested))} on ${config.model} via ${runsOnHarness(config) ? 'Claude Code harness' : 'Messages API'}, from ${source}`
    : `${agent}: effort not sent (asked ${requested} in ${source}; the ${config.provider} provider takes no effort setting)`;
  const fallback = config.fallback;
  if (!fallback) {
    return primary;
  }
  const fallbackEffort = fallback.provider === 'anthropic' && fallback.effort
    ? describeEffort(fallback.model, resolveEffort(fallback.model, fallback.effort))
    : `not sent (the ${fallback.provider} provider takes no effort setting)`;
  return `${primary}; fallback ${fallback.model}: ${fallbackEffort}`;
};

/**
 * The built-in providers whose adapter is a package of its own, by the
 * package that carries each: the Anthropic Messages API, and the two that
 * wrap a harness with its own agent loop (each brings a native binary).
 * None ships with the CLI, so a fresh install carries no provider; setup
 * installs the one picked. Each is loaded on first use rather than
 * imported: a host never loads one its agents do not use, and a host where
 * one is not installed fails the turn that needs it, with the fix, rather
 * than failing to start.
 */
export type ProviderPackage = 'anthropic' | 'claude-code' | 'codex';

const PROVIDER_PACKAGES: Record<ProviderPackage, { specifier: string; label: string }> = {
  anthropic: {
    specifier: '@stratusagent/provider-anthropic',
    label: 'the Anthropic API',
  },
  'claude-code': {
    specifier: '@stratusagent/provider-claude-code',
    label: 'the Claude subscription runtime',
  },
  codex: {
    specifier: '@stratusagent/provider-codex',
    label: 'the Codex runtime',
  },
};

/** The package that carries each provider, for whoever has to install one. */
export const PROVIDER_PACKAGE_NAMES: Readonly<Record<ProviderPackage, string>> = {
  anthropic: PROVIDER_PACKAGES.anthropic.specifier,
  'claude-code': PROVIDER_PACKAGES['claude-code'].specifier,
  codex: PROVIDER_PACKAGES.codex.specifier,
};

/**
 * The provider packages a resolved runtime loads on its turns: its own and
 * its fallback's, by the same rule `createRuntimeProvider` builds them
 * with. None ships with the CLI, so this is what setup installs,
 * `stratus update` keeps installed, and doctor checks for.
 */
export const providerPackagesUsedBy = (config: RuntimeConfig): ProviderPackage[] => {
  const of = (runtime: { provider: string; apiKey?: string | undefined; authToken?: string | undefined }): ProviderPackage | undefined => {
    if (runtime.provider === 'codex') return 'codex';
    if (runtime.provider !== 'anthropic') return undefined;
    return runsOnHarness(runtime) ? 'claude-code' : 'anthropic';
  };
  const used = new Set<ProviderPackage>();
  for (const runtime of [config, ...('fallback' in config && config.fallback ? [config.fallback] : [])]) {
    const pkg = of(runtime);
    if (pkg) used.add(pkg);
  }
  return [...used];
};

/**
 * The error a turn fails with when its provider package is missing, or
 * `undefined` when `error` is anything else. Matched on the package Node
 * names as missing, not just the code: a package that is installed but
 * fails to load one of its own dependencies (whose importer path also
 * contains the specifier) is a different fault with a different fix.
 */
export const providerPackageNotInstalledError = (pkg: ProviderPackage, error: unknown): Error | undefined => {
  const { specifier, label } = PROVIDER_PACKAGES[pkg];
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  const message = error instanceof Error ? error.message : '';
  if (code !== 'ERR_MODULE_NOT_FOUND' || !message.startsWith(`Cannot find package '${specifier}'`)) return undefined;
  return new Error(
    `This agent runs on ${label}, and ${specifier} is not installed. `
    + `Install it with \`npm install -g ${specifier}\` (or choose the provider again in \`stratus setup\`), then send the message again.`,
  );
};

type ProviderModules = {
  anthropic: typeof import('@stratusagent/provider-anthropic');
  'claude-code': typeof import('@stratusagent/provider-claude-code');
  codex: typeof import('@stratusagent/provider-codex');
};

type ProviderOptions<P extends ProviderPackage> = P extends 'anthropic'
  ? Parameters<ProviderModules['anthropic']['createAnthropicProvider']>[0]
  : P extends 'claude-code'
    ? Parameters<ProviderModules['claude-code']['createClaudeCodeProvider']>[0]
    : Parameters<ProviderModules['codex']['createCodexProvider']>[0];

const loadProviderPackage = async <P extends ProviderPackage>(pkg: P): Promise<ProviderModules[P]> => {
  try {
    return await import(PROVIDER_PACKAGES[pkg].specifier) as ProviderModules[P];
  } catch (error) {
    throw providerPackageNotInstalledError(pkg, error) ?? error;
  }
};

/**
 * A provider whose adapter is built on its first request. `createRuntimeProvider`
 * stays synchronous for its callers, and the provider module is loaded only
 * when a turn actually reaches it. A failed build is not cached, so a turn
 * after the package is installed loads it without a restart.
 */
const createDeferredProvider = (name: string, build: () => Promise<ModelProvider>): ModelProvider => {
  let built: Promise<ModelProvider> | undefined;
  return {
    name,
    async generate(request) {
      built ??= build().catch((error: unknown) => {
        built = undefined;
        throw error;
      });
      return (await built).generate(request);
    },
  };
};

export const createRuntimeProvider = (
  config: RuntimeConfig,
  onFallback?: (error: unknown) => void,
  executeTool?: HostedToolExecutor,
  maxTurns?: number,
  persistSession?: (session: Session) => Promise<void>,
  registered?: RegisteredProviders,
): ModelProvider => {
  if (config.provider === 'demo') {
    return createDemoProvider();
  }

  if (config.fallback) {
    const { fallback, ...primaryConfig } = config;
    const primary = createRuntimeProvider(primaryConfig, undefined, executeTool, maxTurns, undefined, registered);
    const fallbackProvider = createRuntimeProvider({
      ...fallback,
      ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
      // Both transports travel, not just the HTTP one. A fallback that
      // inherits `fetch` but not `queryFn` reaches the real Agent SDK the
      // moment the primary fails — launching Claude Code out of a test, or
      // out from under an embedder that supplied its own transport for a
      // reason. The two are one seam and have to be carried together.
      ...(config.fetch ? { fetch: config.fetch } : {}),
      // Inherited from an Anthropic primary, but a fallback naming its own
      // wins — it is the only way a cross-provider pair can say it.
      ...(config.provider === 'anthropic' && config.queryFn ? { queryFn: config.queryFn } : {}),
      ...(fallback.queryFn ? { queryFn: fallback.queryFn } : {}),
      // The codex transport travels the same way, for the same reason.
      ...(config.provider === 'codex' && config.codexRunTurn ? { codexRunTurn: config.codexRunTurn } : {}),
      ...(fallback.codexRunTurn ? { codexRunTurn: fallback.codexRunTurn } : {}),
    } as RuntimeConfig, undefined, executeTool, maxTurns, undefined, registered);
    return createFallbackWrappedProvider(primary, fallbackProvider, onFallback ?? (() => {}), persistSession);
  }

  if (config.provider === 'anthropic') {
    // Subscription setup tokens are only honored inside the Claude Code
    // harness, so they route through the Agent SDK runtime; API keys use
    // the raw Messages API.
    // `authToken` again only to narrow it: the rule already requires one.
    if (runsOnHarness(config) && config.authToken) {
      // The options are read from `config` now, and only the package load
      // waits for the first turn, so a config changed after this call cannot
      // reach a provider built from it.
      const options: ProviderOptions<'claude-code'> = {
        authToken: config.authToken,
        ...(config.agentSignIn !== undefined ? { authOwner: config.agentSignIn } : {}),
        model: config.model,
        ...(config.effort ? { effort: config.effort } : {}),
        // The transport is carried as a structural slice through config
        // (`ClaudeCodeTransport`) so `state` names no harness type; this is
        // the one reader.
        ...(config.queryFn ? { queryFn: config.queryFn as ClaudeCodeQueryFn } : {}),
        ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
        // Kernel tools run through the host loop (approvals, events,
        // allowlists intact), so the subscription runtime is the same
        // agent as the API-key provider — memory.remember included.
        ...(executeTool ? { executeTool } : {}),
        // An explicit max-turns governs the Claude Code inner loop too;
        // this provider consumes all tool calls inside one generate, so
        // the outer runner never sees them.
        ...(maxTurns !== undefined ? { maxTurns } : {}),
      };
      return createDeferredProvider('claude-code', async () => (await loadProviderPackage('claude-code')).createClaudeCodeProvider(options));
    }
    const options: ProviderOptions<'anthropic'> = {
      model: config.model,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      ...(config.authToken ? { authToken: config.authToken } : {}),
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
      ...(config.promptCache !== undefined ? { promptCache: config.promptCache } : {}),
      ...(config.promptCacheTtl ? { promptCacheTtl: config.promptCacheTtl } : {}),
      ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
      ...(config.effort ? { effort: config.effort } : {}),
      ...(config.fetch ? { fetch: config.fetch } : {}),
    };
    return createDeferredProvider('anthropic', async () => (await loadProviderPackage('anthropic')).createAnthropicProvider(options));
  }

  if (config.provider === 'codex') {
    // The third provider shape: a harness with its own inner loop. Kernel
    // tools run through the host chain (approvals, events, allowlists
    // intact) over the provider's loopback MCP endpoint, so this runtime
    // is the same agent as every other provider — with or without an API
    // key, which only decides billing.
    const options: ProviderOptions<'codex'> = {
      model: config.model,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
      ...(config.codexRunTurn ? { runTurn: config.codexRunTurn as CodexRunTurn } : {}),
      ...(executeTool ? { executeTool } : {}),
      // Codex has no native turn cap, so the provider enforces the same
      // limit as a hosted-tool budget — the inner loop consumes all tool
      // calls inside one generate, and the outer runner never sees them.
      ...(maxTurns !== undefined ? { maxTurns } : {}),
    };
    return createDeferredProvider('codex', async () => (await loadProviderPackage('codex')).createCodexProvider(options));
  }

  if (config.provider === 'openai') {
    return createOpenAICompatibleProvider({
      name: 'openai',
      model: config.model,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
      ...(config.vision !== undefined ? { vision: config.vision } : {}),
      ...(config.fetch ? { fetch: config.fetch } : {}),
    });
  }

  {
    // The fourth shape, and the one this function does not build: a
    // plugin's. Looked up by the bare name at build time, because the
    // config was parsed by a process that may have loaded no plugins, and
    // the message says what is registered so a typo reads as one.
    const name = registeredProviderNameOf(config.provider);
    const contribution = registered?.get(name);
    if (!contribution) {
      const known = registered?.names() ?? [];
      throw new Error(
        `No provider named ${name} is registered`
        + (known.length > 0 ? ` (plugins registered: ${known.join(', ')})` : ' (no loaded plugin registers one)')
        + `. Built in: ${BUILTIN_PROVIDER_NAMES.join(', ')}. Enable the plugin that contributes ${name} in the plugins block of a trusted config, or select another provider.`,
      );
    }
    return contribution.create({
      ...(config.model ? { model: config.model } : {}),
      ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
    });
  }
};
