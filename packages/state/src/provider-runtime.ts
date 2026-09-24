import {
  BUILTIN_PROVIDER_NAMES,
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
  createOpenAICompatibleProvider,
  createProviderResponseBuilder,
  defineProvider,
  hasHostedToolSideEffects,
  type HostedToolExecutor,
} from '@stratusagent/providers';
import { createAnthropicProvider, RAW_TURNS_METADATA_KEY } from '@stratusagent/provider-anthropic';
import { ContextOverflowError } from '@stratusagent/core';
import {
  createClaudeCodeProvider,
  SDK_SESSION_METADATA_KEY,
} from '@stratusagent/provider-claude-code';
import { createCodexProvider, CODEX_THREAD_METADATA_KEY } from '@stratusagent/provider-codex';
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
  RAW_TURNS_METADATA_KEY,
  SDK_SESSION_METADATA_KEY,
  CODEX_THREAD_METADATA_KEY,
];

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
  const response = await fallback.generate({
    ...request,
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
    if (config.authToken && !config.apiKey) {
      return createClaudeCodeProvider({
        authToken: config.authToken,
        model: config.model,
        ...(config.queryFn ? { queryFn: config.queryFn } : {}),
        ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
        // Kernel tools run through the host loop (approvals, events,
        // allowlists intact), so the subscription runtime is the same
        // agent as the API-key provider — memory.remember included.
        ...(executeTool ? { executeTool } : {}),
        // An explicit max-turns governs the Claude Code inner loop too;
        // this provider consumes all tool calls inside one generate, so
        // the outer runner never sees them.
        ...(maxTurns !== undefined ? { maxTurns } : {}),
      });
    }
    return createAnthropicProvider({
      model: config.model,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      ...(config.authToken ? { authToken: config.authToken } : {}),
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
      ...(config.promptCache !== undefined ? { promptCache: config.promptCache } : {}),
      ...(config.promptCacheTtl ? { promptCacheTtl: config.promptCacheTtl } : {}),
      ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
      ...(config.fetch ? { fetch: config.fetch } : {}),
    });
  }

  if (config.provider === 'codex') {
    // The third provider shape: a harness with its own inner loop. Kernel
    // tools run through the host chain (approvals, events, allowlists
    // intact) over the provider's loopback MCP endpoint, so this runtime
    // is the same agent as every other provider — with or without an API
    // key, which only decides billing.
    return createCodexProvider({
      model: config.model,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
      ...(config.codexRunTurn ? { runTurn: config.codexRunTurn } : {}),
      ...(executeTool ? { executeTool } : {}),
      // Codex has no native turn cap, so the provider enforces the same
      // limit as a hosted-tool budget — the inner loop consumes all tool
      // calls inside one generate, and the outer runner never sees them.
      ...(maxTurns !== undefined ? { maxTurns } : {}),
    });
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
