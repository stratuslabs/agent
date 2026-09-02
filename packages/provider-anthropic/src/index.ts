import Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlock,
  ContentBlockParam,
  MessageParam,
  TextBlockParam,
  Tool as AnthropicTool,
} from '@anthropic-ai/sdk/resources/messages/messages';
import {
  renderSystemPromptParts,
  type JsonObject,
  type ModelProvider,
  type ProviderCallUsage,
  type ProviderRequest,
  type Session,
  type ToolCall,
  type ToolDescriptor,
} from '@stratusagent/core';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';
const DEFAULT_MAX_TOKENS = 4096;
// Session metadata key holding raw assistant turns, keyed by tool_use id.
export const RAW_TURNS_METADATA_KEY = 'anthropicRawTurns';

export interface AnthropicProviderConfig {
  /** Anthropic API key (pay per use). One of apiKey / authToken is required. */
  apiKey?: string;
  /**
   * OAuth bearer token instead of an API key — e.g. a Claude Code setup
   * token minted from a Claude Pro/Max subscription (`claude setup-token`).
   */
  authToken?: string;
  /** Defaults to claude-opus-5, Anthropic's most capable generally available model. */
  model?: string;
  name?: string;
  /** Response token cap per turn (Anthropic requires one). Default 4096. */
  maxTokens?: number;
  /** Extra system prompt, rendered before the agent's own persona. */
  systemPrompt?: string;
  baseUrl?: string;
  /**
   * Claude Opus 5 thinks adaptively by default. Pass 'disabled' to turn
   * thinking off (e.g. for older models or latency-sensitive runs).
   */
  thinking?: 'default' | 'disabled';
  /**
   * Mark the stable head of each request cacheable — the tool definitions and
   * the persona/skills system block, which are byte-identical across every
   * turn of an agent's life. Default true.
   *
   * Off is the honest setting for an agent that takes exactly one turn per
   * burst: a cache write costs 1.25x an uncached read, so a prefix that is
   * never read back is a pure surcharge. Every agent that holds a
   * conversation is cheaper with it on, because the second turn already pays
   * the write back.
   */
  promptCache?: boolean;
  /**
   * How long a cache entry lives. Default '5m'.
   *
   * A read refreshes the entry's timer for free, so an agent mid-conversation
   * keeps a 5-minute entry alive indefinitely and the hour's doubled write
   * price buys nothing. '1h' is for an agent whose *bursts* are 5-60 minutes
   * apart, which is a per-deployment fact this package cannot know.
   */
  promptCacheTtl?: '5m' | '1h';
  fetch?: typeof fetch;
}

interface ToolNameMapping {
  toWire: Map<string, string>;
  fromWire: Map<string, string>;
}

// The Anthropic API requires tool names matching ^[a-zA-Z0-9_-]{1,64}$, so
// registry names like "demo.echo" are sanitized for the wire and translated
// back when Claude calls them.
export const sanitizeAnthropicToolName = (name: string): string => {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return sanitized.length > 0 ? sanitized : 'tool';
};

const createToolNameMapping = (tools: ToolDescriptor[] | undefined): ToolNameMapping => {
  const toWire = new Map<string, string>();
  const fromWire = new Map<string, string>();

  for (const tool of tools ?? []) {
    if (toWire.has(tool.name)) {
      continue;
    }

    const base = sanitizeAnthropicToolName(tool.name);
    let wireName = base;
    for (let suffix = 2; fromWire.has(wireName); suffix += 1) {
      wireName = `${base.slice(0, 60)}_${suffix}`;
    }

    toWire.set(tool.name, wireName);
    fromWire.set(wireName, tool.name);
  }

  return { toWire, fromWire };
};

const toWireToolName = (name: string, mapping: ToolNameMapping): string =>
  mapping.toWire.get(name) ?? sanitizeAnthropicToolName(name);

/**
 * The request's tools in a fixed order, whatever order the registry handed
 * them over in.
 *
 * A cached prefix is a byte match and tools render at position 0, so any
 * reshuffle silently invalidates every entry — for the rest of the daemon's
 * life, and invisibly without usage counters. Registry order is *insertion*
 * order, which is not stable in practice: the MCP bridge unregisters and
 * re-registers a server's tools on every reconnect, moving them to the end.
 *
 * Sorted before the wire-name mapping is built, not after, because the
 * mapping's collision suffixes are assigned in iteration order too — two
 * tools that sanitize to the same wire name would otherwise swap which one
 * gets `_2`.
 *
 * A plain codepoint comparison rather than `localeCompare`: the point is a
 * byte-identical result on every machine, and locale-aware collation is not
 * that.
 */
const sortedToolDescriptors = (tools: ToolDescriptor[] | undefined): ToolDescriptor[] =>
  [...(tools ?? [])].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

const createAnthropicTools = (
  tools: ToolDescriptor[] | undefined,
  mapping: ToolNameMapping,
): AnthropicTool[] =>
  (tools ?? []).map((tool) => {
    const { type: _type, ...schema } = tool.parameters ?? ({ properties: {} } as JsonObject);
    return {
      name: toWireToolName(tool.name, mapping),
      ...(tool.description ? { description: tool.description } : {}),
      input_schema: { ...schema, type: 'object' as const },
    };
  });

/**
 * Where each part of what an agent is told goes in this request.
 *
 * The kernel renders the sections (one shared reading of persona, memory and
 * skills); this decides their placement, which is a wire-format question and
 * so belongs here rather than in the renderer.
 *
 * `system` is a single text block holding the stable sections joined exactly
 * as they have always been joined — one block, not one per section, so the
 * bytes the model sees do not change and the single breakpoint has somewhere
 * to sit. `memoryMessage`, when present, is the volatile section on its way
 * to the tail of `messages` instead.
 */
interface PromptPlacement {
  system: TextBlockParam[];
  /** The tool list, possibly carrying the breakpoint; see `buildPrompt`. */
  tools: AnthropicTool[];
  memoryMessage: string | undefined;
}

const buildPrompt = (
  request: ProviderRequest,
  systemPrompt: string | undefined,
  tools: AnthropicTool[],
  options: { cache: boolean; ttl: '5m' | '1h'; memoryAtTail: boolean },
): PromptPlacement => {
  const parts = renderSystemPromptParts(request, {
    ...(systemPrompt ? { preamble: systemPrompt } : {}),
  });
  const memory = options.memoryAtTail ? parts.find((part) => part.kind === 'memory') : undefined;
  const stable = memory ? parts.filter((part) => part.kind !== 'memory') : parts;
  const system: TextBlockParam[] = stable.length > 0
    ? [{ type: 'text', text: stable.map((part) => part.text).join('\n\n') }]
    : [];

  // The whole breakpoint policy, in one place, because it is one decision:
  // *where does the stable head end*. The wire order is tools -> system ->
  // messages, so a marker on the last system block covers the tool
  // definitions with it — one breakpoint, leaving three of the four the
  // request is allowed for whatever wants one later.
  //
  // An agent with tools but nothing to say — no preamble, no instructions,
  // no skills — has no system block to carry that marker, and its tool
  // schemas are often the largest stable thing in the request. So the
  // breakpoint falls back to the last tool. Never both: two markers on one
  // contiguous prefix spend a slot to cache the same bytes twice.
  //
  // Annotating a prefix below the model's cacheable minimum is a silent
  // no-op, not an error, so there is nothing to check for first.
  const head = system.at(-1) ?? tools.at(-1);
  if (options.cache && head) {
    head.cache_control = { type: 'ephemeral', ttl: options.ttl };
  }
  return { system, tools, memoryMessage: memory?.text };
};

/**
 * The 400 a model without mid-conversation system messages answers with.
 * Matched on the API's own wording because the SDK gives no code for it.
 */
const rejectsSystemMessages = (error: unknown): boolean =>
  error instanceof Anthropic.BadRequestError && /role .?system.? is not supported/i.test(error.message);

type RawTurns = Record<string, ContentBlock[]>;

/**
 * Return a copy of the session without Anthropic replay state. The raw
 * turns stored under RAW_TURNS_METADATA_KEY exist only so history replay
 * can hand Claude back its own thinking blocks verbatim — they contain
 * reasoning that is deliberately never surfaced as output, so any code
 * that exports, prints, or logs a session for people should pass it
 * through this first. Session stores must keep the field: replay needs it.
 */
export const redactAnthropicRawTurns = (session: Session): Session => {
  if (!session.metadata || !(RAW_TURNS_METADATA_KEY in session.metadata)) {
    return session;
  }
  const { [RAW_TURNS_METADATA_KEY]: _rawTurns, ...metadata } = session.metadata;
  const { metadata: _metadata, ...rest } = session;
  return Object.keys(metadata).length > 0 ? { ...rest, metadata } : rest;
};

// With thinking enabled, the thinking block that preceded a tool_use must be
// returned verbatim on the next request or the API rejects it. Those raw
// turns are session state, not provider state: they live in the session's
// metadata so they survive tool execution and approval waits, provider
// restarts, and resuming the session in another process — and they are
// garbage-collected with the session itself.
const rawTurnsFrom = (session: ProviderRequest['session']): RawTurns => {
  const metadata = (session.metadata ??= {});
  const existing = metadata[RAW_TURNS_METADATA_KEY];
  if (typeof existing === 'object' && existing !== null && !Array.isArray(existing)) {
    return existing as unknown as RawTurns;
  }
  const fresh: RawTurns = {};
  metadata[RAW_TURNS_METADATA_KEY] = fresh as unknown as JsonObject;
  return fresh;
};

const reconstructAssistantBlocks = (
  content: string,
  toolCalls: ToolCall[],
  mapping: ToolNameMapping,
): ContentBlockParam[] => {
  const blocks: ContentBlockParam[] = [];
  if (content.length > 0) {
    blocks.push({ type: 'text', text: content });
  }
  for (const call of toolCalls) {
    blocks.push({
      type: 'tool_use',
      id: call.id,
      name: toWireToolName(call.toolName, mapping),
      input: call.input,
    });
  }
  return blocks;
};

const createAnthropicMessages = (
  request: ProviderRequest,
  mapping: ToolNameMapping,
  rawTurns: RawTurns,
): MessageParam[] => {
  // Build (role, blocks) groups first, merging consecutive same-role turns:
  // the runner records text and each tool call as separate messages, but on
  // the wire they belong to one assistant turn followed by one user turn of
  // tool_result blocks.
  const groups: Array<{ role: 'user' | 'assistant'; blocks: ContentBlockParam[] }> = [];

  const push = (role: 'user' | 'assistant', blocks: ContentBlockParam[]): void => {
    if (blocks.length === 0) {
      return;
    }
    const previous = groups.at(-1);
    if (previous && previous.role === role) {
      previous.blocks.push(...blocks);
      return;
    }
    groups.push({ role, blocks });
  };

  // One raw response covers several runner messages (its text message plus
  // one message per tool call), so it must be replayed exactly once. Dedup
  // tracks the tool_use ids already emitted rather than array identity,
  // because a session revived from storage has a distinct array per key.
  const emittedCallIds = new Set<string>();
  const rawFor = (calls: ToolCall[] | undefined): ContentBlock[] | undefined =>
    calls?.map((call) => rawTurns[call.id]).find((blocks) => blocks !== undefined);
  const alreadyEmitted = (calls: ToolCall[] | undefined): boolean =>
    (calls ?? []).some((call) => emittedCallIds.has(call.id));

  const messages = request.session.messages;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.role === 'system') {
      continue;
    }

    if (message.role === 'tool') {
      const result = message.toolResult;
      if (!result) {
        continue;
      }
      push('user', [
        {
          type: 'tool_result',
          tool_use_id: result.callId,
          content: JSON.stringify(result.ok ? result.output : { error: result.error ?? 'Tool failed' }),
          ...(result.ok ? {} : { is_error: true }),
        },
      ]);
      continue;
    }

    if (message.role === 'assistant') {
      if (message.toolCalls && message.toolCalls.length > 0) {
        // Replay the API's own content blocks when we have them: with
        // thinking enabled, the thinking block that preceded a tool_use must
        // be returned verbatim or the API rejects the request. The raw turn
        // is atomic — it already contains the text and every tool_use block
        // of that response — so later runner messages it covers are skipped.
        const raw = rawFor(message.toolCalls);
        if (raw) {
          if (!alreadyEmitted(message.toolCalls)) {
            for (const block of raw) {
              if (block.type === 'tool_use') {
                emittedCallIds.add(block.id);
              }
            }
            push('assistant', raw as ContentBlockParam[]);
          }
          continue;
        }
        push('assistant', reconstructAssistantBlocks(message.content, message.toolCalls, mapping));
        continue;
      }

      if (message.content.length > 0) {
        // The runner records a response's text ahead of its tool calls. If
        // the next message replays that same response's raw turn, the text
        // is already inside it.
        const next = messages[index + 1];
        const nextRaw = next?.role === 'assistant' ? rawFor(next.toolCalls) : undefined;
        if (nextRaw && !alreadyEmitted(next?.role === 'assistant' ? next.toolCalls : undefined)) {
          continue;
        }
        push('assistant', [{ type: 'text', text: message.content }]);
      }
      continue;
    }

    push('user', [{ type: 'text', text: message.content }]);
  }

  return groups.map((group) => ({ role: group.role, content: group.blocks }));
};

const extractParts = (
  content: ContentBlock[],
  mapping: ToolNameMapping,
): { text: string; calls: ToolCall[] } => {
  let text = '';
  const calls: ToolCall[] = [];

  for (const block of content) {
    if (block.type === 'text') {
      text += block.text;
      continue;
    }
    if (block.type === 'tool_use') {
      const input = block.input;
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw new Error(`Claude returned non-object input for tool ${block.name}.`);
      }
      calls.push({
        id: block.id,
        toolName: mapping.fromWire.get(block.name) ?? block.name,
        input: input as JsonObject,
      });
    }
    // thinking / redacted_thinking blocks are replayed via the raw-turn
    // cache, never surfaced as parts.
  }

  return { text, calls };
};

/**
 * The counts a usage carrier may hold, each nullable. Structural rather than
 * the SDK's `Usage` because a stream cut short reports a partial snapshot
 * whose output count is deliberately withheld — see the streaming catch —
 * and `Usage` says `output_tokens` is always a number.
 */
type UsageCounts = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

/**
 * The turn's token usage, in the kernel's four buckets.
 *
 * No normalization is needed: the Messages API already reports the three
 * input buckets as disjoint counts ("total input tokens is the summation of
 * `input_tokens`, `cache_creation_input_tokens`, and
 * `cache_read_input_tokens`"), which is the shape `TokenUsage` took from it.
 *
 * A count the API omits — the cache fields are nullable, and are null on a
 * request that used no caching — stays absent rather than becoming a zero,
 * and a response carrying no counts at all reports nothing rather than a
 * record made only of attribution.
 */
const extractUsage = (
  response: { usage?: UsageCounts | null; model?: string },
  providerName: string,
  model: string,
): ProviderCallUsage | undefined => {
  const usage = response.usage;
  const count = (value: number | null | undefined): number | undefined =>
    typeof value === 'number' ? value : undefined;
  const inputTokens = count(usage?.input_tokens);
  const outputTokens = count(usage?.output_tokens);
  const cacheReadTokens = count(usage?.cache_read_input_tokens);
  const cacheWriteTokens = count(usage?.cache_creation_input_tokens);
  if ([inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens].every((value) => value === undefined)) {
    return undefined;
  }
  return {
    provider: providerName,
    // The model the API says served the request, which is the one to
    // attribute an alias ("claude-opus-latest") to.
    model: typeof response.model === 'string' && response.model.length > 0 ? response.model : model,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
  };
};

/**
 * Model provider backed by Anthropic's Claude API via the official SDK.
 * Supports multi-turn tool calling, renders the agent's persona and
 * long-term memory as the system prompt, and preserves Claude's thinking
 * blocks across tool-use turns.
 */
export const createAnthropicProvider = ({
  apiKey,
  authToken,
  model = DEFAULT_ANTHROPIC_MODEL,
  name = 'anthropic',
  maxTokens = DEFAULT_MAX_TOKENS,
  systemPrompt,
  baseUrl,
  thinking = 'default',
  promptCache = true,
  promptCacheTtl = '5m',
  fetch: fetchImpl,
}: AnthropicProviderConfig): ModelProvider => {
  if (!apiKey && !authToken) {
    throw new Error('The Anthropic provider needs an apiKey or an authToken.');
  }

  const client = new Anthropic({
    // Explicit nulls stop the SDK from falling back to ambient env vars.
    apiKey: apiKey ?? null,
    authToken: authToken ?? null,
    ...(baseUrl ? { baseURL: baseUrl } : {}),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });

  // Whether this model takes a mid-conversation system message. Assumed yes
  // and demoted on the first rejection, for the life of the provider
  // instance: the alternative is one wasted round trip per turn rather than
  // one per process. Never promoted back — a model does not grow the feature
  // mid-run, and retrying would reintroduce the cost this remembers away.
  let memoryAtTailSupported = true;

  return {
    name,
    async generate(request: ProviderRequest) {
      const rawTurns = rawTurnsFrom(request.session);
      const descriptors = sortedToolDescriptors(request.tools);
      const mapping = createToolNameMapping(descriptors);
      const tools = createAnthropicTools(descriptors, mapping);
      const messages = createAnthropicMessages(request, mapping, rawTurns);
      // A system message has to follow a user turn. The kernel loop only
      // calls a provider with a user message or tool results last, so this
      // holds — but it is the API's rule, not ours, and a caller building
      // its own history is not bound by our loop.
      const tailTakesSystem = messages.at(-1)?.role === 'user';

      const buildParams = (memoryAtTail: boolean) => {
        // A fresh copy of each tool per attempt: `buildPrompt` may annotate
        // the last one, and a retry that reused the same objects would carry
        // the previous attempt's marker.
        const prompt = buildPrompt(request, systemPrompt, tools.map((tool) => ({ ...tool })), {
          cache: promptCache,
          ttl: promptCacheTtl,
          memoryAtTail,
        });
        return {
          model,
          max_tokens: maxTokens,
          ...(prompt.system.length > 0 ? { system: prompt.system } : {}),
          ...(prompt.tools.length > 0 ? { tools: prompt.tools } : {}),
          // Claude Opus 5 thinks adaptively when `thinking` is omitted.
          ...(thinking === 'disabled' ? { thinking: { type: 'disabled' as const } } : {}),
          messages: prompt.memoryMessage === undefined
            ? messages
            : [...messages, { role: 'system' as const, content: prompt.memoryMessage }],
        };
      };

      // Memory rides at the tail so a remembered fact leaves the cached head
      // byte-identical. Everything else about the request is the same either
      // way, so the fallback below only has to rebuild this.
      let params = buildParams(memoryAtTailSupported && tailTakesSystem);
      // The turn's abort signal cancels the underlying HTTP request — the
      // kernel contract is that aborting stops the work, not just the wait.
      const requestOptions = request.signal ? { signal: request.signal } : undefined;

      const send = async (attempt: typeof params) => {
        if (request.onDelta) {
          // Streaming path: iterate the stream and AWAIT the sink per
          // fragment — the kernel contract's backpressure. A slow consumer
          // (a throttled Slack edit) pauses this consumer loop instead of
          // piling every remaining delta into an unbounded queue.
          const stream = client.messages.stream(attempt, requestOptions);
          try {
            const onDelta = request.onDelta;
            // Tool input streams as JSON fragments after the block's start
            // event. Forwarding them keeps consumers (and activity watchdogs)
            // fed while Claude spends time generating a large tool argument.
            const toolNamesByIndex = new Map<number, string>();
            for await (const event of stream) {
              if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                await onDelta({ type: 'text', text: event.delta.text });
              } else if (
                event.type === 'content_block_delta'
                && (event.delta.type === 'thinking_delta' || event.delta.type === 'signature_delta')
              ) {
                // Adaptive thinking can run longer than an idle timeout before
                // the first visible text; forward progress without content.
                await onDelta({ type: 'thinking' });
              } else if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
                const toolName = toolNamesByIndex.get(event.index);
                if (toolName !== undefined) {
                  await onDelta({ type: 'tool-call', toolName, inputFragment: event.delta.partial_json });
                }
              } else if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
                const toolName = mapping.fromWire.get(event.content_block.name) ?? event.content_block.name;
                toolNamesByIndex.set(event.index, toolName);
                await onDelta({ type: 'tool-call', toolName });
              }
            }
            return await stream.finalMessage();
          } catch (error) {
            // A stream that ends before `message_stop` — the turn's signal
            // fired (the gateway's idle watchdog, a cancelled turn) or the
            // connection dropped — was still a billed request, and a rejection
            // returns no response for its count to ride on. The SDK's running
            // snapshot holds what `message_start` announced: the input side in
            // full. Output tokens only arrive on `message_delta`, at the end,
            // so a snapshot with no stop reason has not seen them and reports
            // none rather than the placeholder `message_start` carries.
            // Reported on the way out, because a rejection is the one exit
            // nothing downstream can attribute.
            const partial = stream.currentMessage;
            if (partial) {
              const usage = extractUsage({
                usage: { ...partial.usage, output_tokens: partial.stop_reason ? partial.usage.output_tokens : null },
                model: partial.model,
              }, name, model);
              if (usage) {
                request.onUsage?.(usage);
              }
            }
            throw error;
          }
        }
        return client.messages.create(attempt, requestOptions);
      };

      let response;
      try {
        response = await send(params);
      } catch (error) {
        // The one recoverable rejection: this model has no mid-conversation
        // system message, so memory has to go back in the system block. Only
        // when we actually sent one — any other 400 is the caller's.
        //
        // No reset delta first: the API rejects the request before generating,
        // so nothing has streamed for a consumer to discard.
        if (params.messages.at(-1)?.role !== 'system' || !rejectsSystemMessages(error)) {
          throw error;
        }
        memoryAtTailSupported = false;
        params = buildParams(false);
        response = await send(params);
      }

      // Reported through the sink BEFORE anything that can reject the
      // response. The call completed and was billed, and both checks below
      // throw on outcomes that are still paid: a tool_use block whose input
      // is not an object, and a turn whose thinking consumed the output
      // budget without surfacing a part. Neither returns a response, so the
      // sink is the only carrier those tokens have.
      //
      // The count also stays on the response for a host calling generate
      // with no sink attached. The kernel reads one or the other, never
      // both, so this cannot double-count.
      const usage = extractUsage(response, name, model);
      if (usage) {
        request.onUsage?.(usage);
      }

      const { text, calls } = extractParts(response.content, mapping);

      for (const call of calls) {
        rawTurns[call.id] = response.content;
      }

      const parts = [
        ...(text.length > 0 ? [{ type: 'text' as const, text }] : []),
        ...calls.map((call) => ({ type: 'tool-call' as const, call })),
      ];

      if (parts.length === 0) {
        throw new Error('Claude returned an empty response.');
      }

      return usage ? { parts, usage } : { parts };
    },
  };
};
