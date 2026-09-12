import Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlock,
  ContentBlockParam,
  Message,
  MessageParam,
  TextBlockParam,
  Tool as AnthropicTool,
} from '@anthropic-ai/sdk/resources/messages/messages';
import {
  isUnaddressedTurn,
  droppedImageNote,
  imagesWithinReplayBudget,
  omitImage,
  renderSystemPromptParts,
  type ImageAttachment,
  type ImageReplayBudget,
  type JsonObject,
  type ModelProvider,
  type ProviderCallUsage,
  type ProviderRequest,
  type Session,
  type ToolCall,
  type ToolDescriptor,
  promptTextOf,
} from '@stratusagent/core';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';
const DEFAULT_MAX_TOKENS = 4096;
// Session metadata key holding raw assistant turns, keyed by tool_use id.
export const RAW_TURNS_METADATA_KEY = 'anthropicRawTurns';

/**
 * The Messages API refuses a request body over 32 MiB. The image budget in
 * core is a share of that, not the whole of it: the transcript, tool
 * results, and tool schemas travel in the same body, and a session that
 * has accumulated a few MiB of those alongside a full image window would
 * be refused — without naming an image, so nothing would give way and the
 * same request would fail on every later turn. Stopping short of the
 * limit leaves room for what the measurement below cannot see: headers
 * and the SDK's own framing.
 */
export const DEFAULT_REQUEST_BODY_MAX_BYTES = 30 * 1024 * 1024;

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
   * How much of the transcript's images one request may replay, newest
   * first — decoded bytes and a count; older images past either are sent
   * as a note. Each defaults to core's constant for the Messages API's
   * limit. Lower one for a proxy with a smaller limit.
   */
  imageReplayBudget?: ImageReplayBudget;
  /**
   * The most bytes one request body may serialize to before the oldest
   * replayed images give way to the rest of it. Defaults to
   * `DEFAULT_REQUEST_BODY_MAX_BYTES`. Lower it for a proxy with a smaller
   * limit.
   */
  requestBodyMaxBytes?: number;
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

/**
 * The image block a 400 names, when it names one. The API spells the
 * offending block's address into the message —
 * `messages.3.content.0.image.source.base64.data: Could not process image`
 * — which is the one thing that lets a provider drop exactly that image
 * and try again, rather than fail a turn that will fail the same way on
 * every replay after it.
 */
const rejectedImageAddress = (error: unknown): { message: number; block: number } | undefined => {
  if (!(error instanceof Anthropic.BadRequestError)) {
    return undefined;
  }
  const match = /messages\.(\d+)\.content\.(\d+)\.image\b/.exec(error.message);
  return match ? { message: Number(match[1]), block: Number(match[2]) } : undefined;
};

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

/**
 * A user turn's blocks: its images first, then the text. An image outside
 * the replay budget becomes a note saying so. The API refuses an empty
 * text block, and a message that is only an image has no text — so the
 * text block is added only when there is text, and a message with neither
 * still sends one so the turn is never an empty content array.
 */
const userBlocks = (
  content: string,
  images: readonly ImageAttachment[] | undefined,
  replayed: ReadonlySet<ImageAttachment>,
  imageOf: WeakMap<ContentBlockParam, ImageAttachment>,
): ContentBlockParam[] => {
  const blocks: ContentBlockParam[] = (images ?? []).map((image) => {
    if (!replayed.has(image)) {
      return { type: 'text', text: droppedImageNote(image) };
    }
    const block: ContentBlockParam = { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } };
    imageOf.set(block, image);
    return block;
  });
  if (content.length > 0 || blocks.length === 0) {
    blocks.push({ type: 'text', text: content });
  }
  return blocks;
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
  imageReplayBudget: ImageReplayBudget | undefined,
): {
  messages: MessageParam[];
  imageOf: WeakMap<ContentBlockParam, ImageAttachment>;
  /** Every image block sent, oldest first, with where it sits so it can give way. */
  imageBlocks: Array<{ holder: ContentBlockParam[]; index: number; image: ImageAttachment }>;
} => {
  const replayed = imagesWithinReplayBudget(request.session.messages, imageReplayBudget);
  // Which session image each image block came from, so a rejection that
  // names a block can be answered on the session.
  const imageOf = new WeakMap<ContentBlockParam, ImageAttachment>();
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
  // The newest user message is the one the turn ends on; an unaddressed
  // turn's note follows it and no other — see `PromptTextOptions`.
  const latest = messages.findLast((message) => message.role === 'user');
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

    // Framed by the kernel's one rule for it: an overheard message is
    // rendered as something said to somebody else, on this path as on the
    // harness ones. Consecutive user turns merge above, so a message
    // overheard between turns and the one that followed it reach the API
    // as one user turn of two blocks. Its images, if any, ride ahead of it.
    push('user', userBlocks(promptTextOf(message, { latest: message === latest }), message.images, replayed, imageOf));
  }

  const imageBlocks: Array<{ holder: ContentBlockParam[]; index: number; image: ImageAttachment }> = [];
  for (const group of groups) {
    group.blocks.forEach((block, index) => {
      const image = imageOf.get(block);
      if (image !== undefined) {
        imageBlocks.push({ holder: group.blocks, index, image });
      }
    });
  }
  // The content arrays are the groups' own, so a block swapped in a holder
  // is swapped in the request.
  return { messages: groups.map((group) => ({ role: group.role, content: group.blocks })), imageOf, imageBlocks };
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
  imageReplayBudget,
  requestBodyMaxBytes = DEFAULT_REQUEST_BODY_MAX_BYTES,
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
      const { messages, imageOf, imageBlocks } = createAnthropicMessages(request, mapping, rawTurns, imageReplayBudget);
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
      // The image window is a share of the request, not the request: what
      // is left of the body has to fit alongside it. Measured on the
      // serialized params, oldest image giving way first, until it does.
      // The session is left alone — these images are still within what a
      // session keeps, and the next turn measures again for itself.
      for (const { holder, index, image } of imageBlocks) {
        if (Buffer.byteLength(JSON.stringify(params)) <= requestBodyMaxBytes) {
          break;
        }
        // Only a swap that shrinks the body: the note can outweigh a tiny
        // image, and swapping then would move the wrong way and could leave
        // the last swap landing above the cap. What is still over after
        // every image that helps has given way is the transcript's own
        // size, which no image can answer for.
        const note: ContentBlockParam = { type: 'text', text: droppedImageNote(image) };
        if (Buffer.byteLength(JSON.stringify(note)) >= Buffer.byteLength(JSON.stringify(holder[index]))) {
          continue;
        }
        holder[index] = note;
      }
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
          // The running message as the SDK accumulates it, taken from its
          // own event hook rather than read back after a failure: a body
          // that ends cleanly before `message_stop` (a proxy closing a
          // truncated response as though it were whole) looks to the SDK
          // like a finished request, and it retires the snapshot before
          // `finalMessage()` rejects for want of a message.
          let latest: Message | undefined;
          stream.on('streamEvent', (_event, snapshot) => {
            latest = snapshot;
          });
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
            // fired (the gateway's idle watchdog, a cancelled turn), the
            // connection dropped, or the body simply stopped — was still a
            // billed request, and a rejection returns no response for its
            // count to ride on. The snapshot holds what `message_start`
            // announced: the input side in full. Output tokens only arrive
            // on `message_delta`, at the end, so a snapshot with no stop
            // reason has not seen them and reports none rather than the
            // placeholder `message_start` carries. Reported on the way out,
            // because a rejection is the one exit nothing downstream can
            // attribute.
            if (latest) {
              const usage = extractUsage({
                usage: { ...latest.usage, output_tokens: latest.stop_reason ? latest.usage.output_tokens : null },
                model: latest.model,
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
      // Each pass through this loop removes one thing the API refused, so
      // it ends: the system message once, and each image at most once.
      for (;;) {
        try {
          response = await send(params);
          break;
        } catch (error) {
          // No reset delta on either recovery: the API rejects the request
          // before generating, so nothing has streamed for a consumer to
          // discard.
          //
          // One recoverable rejection: this model has no mid-conversation
          // system message, so memory has to go back in the system block.
          // Only when we actually sent one — any other 400 is the caller's.
          if (params.messages.at(-1)?.role === 'system' && rejectsSystemMessages(error)) {
            memoryAtTailSupported = false;
            params = buildParams(false);
            continue;
          }
          // The other: an image the API could not process. The channel
          // checked its header and trailer, but that is not a decode. The
          // image is emptied on the session itself — it is stored already,
          // and left alone it would fail every later turn the same way —
          // and the turn goes on with a note in its place.
          const address = rejectedImageAddress(error);
          const content = address === undefined ? undefined : params.messages[address.message]?.content;
          const block = Array.isArray(content) ? content[address!.block] : undefined;
          const image = block === undefined ? undefined : imageOf.get(block as ContentBlockParam);
          if (image === undefined || block === undefined) {
            throw error;
          }
          omitImage(image);
          (content as ContentBlockParam[])[address!.block] = { type: 'text', text: droppedImageNote(image) };
          continue;
        }
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

      // Nothing said is the answer a turn nobody asked for may give — see
      // `RunInput.addressed` in core. On a turn somebody asked for it is
      // still an endpoint that returned nothing, and an error.
      if (parts.length === 0 && !isUnaddressedTurn(request.session)) {
        throw new Error('Claude returned an empty response.');
      }

      return usage ? { parts, usage } : { parts };
    },
  };
};
