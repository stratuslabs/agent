import {
  isUnaddressedTurn,
  droppedImageNote,
  imagesWithinReplayBudget,
  omitImage,
  renderSystemPromptSections,
  uncachedInputTokens,
  type ExecutionContext,
  type ImageAttachment,
  type ImageReplayBudget,
  type JsonObject,
  type Message,
  type ModelProvider,
  type ProviderCallUsage,
  type ProviderPart,
  type ProviderRequest,
  type ProviderResponse,
  type Session,
  type ToolCall,
  type ToolDescriptor,
  type ToolResult,
  promptTextOf,
} from '@stratusagent/core';

export interface ProviderResponseBuilder {
  addText(text: string): ProviderResponseBuilder;
  addToolCall(call: ToolCall): ProviderResponseBuilder;
  addPart(part: ProviderPart): ProviderResponseBuilder;
  done(): ProviderResponse;
}

export type ProviderResponseInput =
  | string
  | ProviderPart
  | ProviderResponse
  | Iterable<string | ProviderPart>;

export type ProviderResolver = (request: ProviderRequest) => Promise<ProviderResponse>;

export interface ProviderAdapterDefinition {
  name: string;
  generate(request: ProviderRequest): Promise<ProviderResponse>;
}

export interface ProviderRegistry {
  register(provider: ModelProvider): ModelProvider;
  registerMany(providers: Iterable<ModelProvider>): ProviderRegistry;
  get(name: string): ModelProvider | undefined;
  require(name: string): ModelProvider;
  has(name: string): boolean;
  list(): ModelProvider[];
  names(): string[];
}

export type StaticProviderResponseFactory =
  | ProviderResponseInput
  | ((request: ProviderRequest) => ProviderResponseInput | Promise<ProviderResponseInput>);

export interface StaticProviderDefinition {
  name: string;
  response: StaticProviderResponseFactory;
}

export type ScriptedProviderStep =
  | ProviderResponseInput
  | ((context: { request: ProviderRequest; callCount: number; stepIndex: number }) =>
      | ProviderResponseInput
      | Promise<ProviderResponseInput>);

export interface ScriptedProviderDefinition {
  name: string;
  steps: readonly ScriptedProviderStep[];
  repeatLast?: boolean;
}

export interface OpenAICompatibleProviderConfig {
  model: string;
  apiKey: string;
  baseUrl?: string;
  name?: string;
  systemPrompt?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  /**
   * Upper bound on one HTTP request, caller signal or not — an endpoint
   * that accepts a request and never completes it must not wedge the turn
   * (and its caller's shutdown) forever. 0 disables. Default 5 minutes.
   */
  requestTimeoutMs?: number;
  /**
   * Whether the model takes images. Default true. A text-only model — the
   * usual case for a local runtime — rejects a request with an `image_url`
   * part in it, and because the image is stored with the message before the
   * provider is called, every later turn of that session would replay the
   * same part and fail the same way. Off, an image reaches the model as a
   * note naming it instead, the same one a text-only harness gets.
   */
  vision?: boolean;
  /**
   * How much of the transcript's images one request may replay, newest
   * first — decoded bytes and a count; older images past either are sent
   * as a note. Each defaults to core's constant. Lower one for an endpoint
   * with a smaller limit.
   */
  imageReplayBudget?: ImageReplayBudget;
}

interface OpenAICompatibleToolCall {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

/**
 * A user turn's content on the chat-completions wire: a string when it is
 * only text, and the parts form — text plus `image_url` parts carrying
 * data URLs — when the message has images. The string form is kept for
 * the common case because some compatible servers accept only that.
 */
type OpenAICompatibleUserContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;

interface OpenAICompatibleMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: OpenAICompatibleUserContent | null;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface OpenAICompatibleToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: JsonObject;
  };
}

interface OpenAICompatibleResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }> | null;
      tool_calls?: OpenAICompatibleToolCall[];
    };
    /** Why the model stopped — `stop`, `length`, `content_filter`, `tool_calls` — where the endpoint says. */
    finish_reason?: string | null;
  }>;
  /**
   * Optional on purpose: `usage` is not in the subset every
   * OpenAI-compatible endpoint implements, and a local server that omits it
   * must report nothing rather than a zero.
   */
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** Cached prompt tokens, a SUBSET of `prompt_tokens`. */
    prompt_tokens_details?: { cached_tokens?: number };
  };
  /** The model that actually served the request; endpoints may rename it. */
  model?: string;
  error?: {
    message?: string;
  };
  rawText?: string;
}

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;

export const textPart = (text: string): ProviderPart => ({ type: 'text', text });

export const toolCallPart = (call: ToolCall): ProviderPart => ({
  type: 'tool-call',
  call: {
    id: call.id,
    toolName: call.toolName,
    input: { ...call.input },
  },
});

export const providerResponse = (...parts: ProviderPart[]): ProviderResponse => ({
  parts: normalizeProviderParts(parts),
});

export const normalizeProviderParts = (parts: Iterable<ProviderPart>): ProviderPart[] => {
  const normalized: ProviderPart[] = [];

  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text.length === 0) {
        continue;
      }

      const previous = normalized.at(-1);
      if (previous?.type === 'text') {
        previous.text += part.text;
        continue;
      }

      normalized.push(textPart(part.text));
      continue;
    }

    normalized.push(toolCallPart(part.call));
  }

  return normalized;
};

export const normalizeProviderResponse = (input: ProviderResponseInput): ProviderResponse => {
  if (typeof input === 'string') {
    return providerResponse(textPart(input));
  }

  if (isProviderPart(input)) {
    return providerResponse(input);
  }

  if (isProviderResponse(input)) {
    // Parts are re-normalized; `usage` rides through untouched. Dropping it
    // would leave a scripted or static provider unable to report a count at
    // all, which is exactly what the usage tests need one to do.
    const normalized = providerResponse(...input.parts);
    return input.usage ? { ...normalized, usage: input.usage } : normalized;
  }

  const parts: ProviderPart[] = [];
  for (const value of input) {
    parts.push(typeof value === 'string' ? textPart(value) : value);
  }

  return providerResponse(...parts);
};

export const createProviderResponseBuilder = (
  initialParts: Iterable<ProviderPart> = [],
): ProviderResponseBuilder => {
  const parts = normalizeProviderParts(initialParts);

  return {
    addText(text) {
      if (text.length === 0) {
        return this;
      }

      const previous = parts.at(-1);
      if (previous?.type === 'text') {
        previous.text += text;
      } else {
        parts.push(textPart(text));
      }
      return this;
    },
    addToolCall(call) {
      parts.push(toolCallPart(call));
      return this;
    },
    addPart(part) {
      if (part.type === 'text') {
        return this.addText(part.text);
      }
      return this.addToolCall(part.call);
    },
    done() {
      return providerResponse(...parts);
    },
  };
};

export const defineProvider = ({ name, generate }: ProviderAdapterDefinition): ModelProvider => ({
  name,
  generate,
});

export const createProviderRegistry = (
  providers: Iterable<ModelProvider> = [],
): ProviderRegistry => {
  const entries = new Map<string, ModelProvider>();

  const registry: ProviderRegistry = {
    register(provider) {
      entries.set(provider.name, provider);
      return provider;
    },
    registerMany(nextProviders) {
      for (const provider of nextProviders) {
        registry.register(provider);
      }
      return registry;
    },
    get(name) {
      return entries.get(name);
    },
    require(name) {
      const provider = entries.get(name);
      if (!provider) {
        throw new Error(`Provider not found: ${name}`);
      }
      return provider;
    },
    has(name) {
      return entries.has(name);
    },
    list() {
      return [...entries.values()];
    },
    names() {
      return [...entries.keys()];
    },
  };

  return registry.registerMany(providers);
};

export const defineStaticProvider = ({ name, response }: StaticProviderDefinition): ModelProvider =>
  defineProvider({
    name,
    async generate(request) {
      const resolved =
        typeof response === 'function' ? await response(request) : response;
      return normalizeProviderResponse(resolved);
    },
  });

export const defineScriptedProvider = ({
  name,
  steps,
  repeatLast = true,
}: ScriptedProviderDefinition): ModelProvider => {
  if (steps.length === 0) {
    throw new Error(`Scripted provider requires at least one step: ${name}`);
  }

  let callCount = 0;

  return defineProvider({
    name,
    async generate(request) {
      const stepIndex = callCount < steps.length ? callCount : steps.length - 1;
      const step = steps[stepIndex];

      if (!step) {
        throw new Error(`Scripted provider step not found: ${name}#${stepIndex}`);
      }

      if (callCount >= steps.length && !repeatLast) {
        throw new Error(`Scripted provider exhausted: ${name}`);
      }

      callCount += 1;

      const resolved =
        typeof step === 'function'
          ? await step({ request, callCount, stepIndex })
          : step;

      return normalizeProviderResponse(resolved);
    },
  });
};

export const createOpenAICompatibleProvider = ({
  model,
  apiKey,
  baseUrl = DEFAULT_OPENAI_BASE_URL,
  name = 'openai',
  systemPrompt,
  headers = {},
  fetch: fetchImpl = globalThis.fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  vision = true,
  imageReplayBudget,
}: OpenAICompatibleProviderConfig): ModelProvider => {
  if (typeof fetchImpl !== 'function') {
    throw new Error('Global fetch is unavailable for the OpenAI-compatible provider.');
  }

  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');

  return defineProvider({
    name,
    async generate(request) {
      const toolNames = createOpenAICompatibleToolNameMapping(request.tools);
      const tools = createOpenAICompatibleTools(request.tools, toolNames);

      // The turn's signal cancels the request; the timeout bounds it even
      // when no signal exists, so a hung endpoint cannot pin the turn (and
      // a draining daemon) open forever.
      const timeout = requestTimeoutMs > 0 ? AbortSignal.timeout(requestTimeoutMs) : undefined;
      const signal = timeout && request.signal
        ? AbortSignal.any([request.signal, timeout])
        : timeout ?? request.signal;

      let payload;
      let response: Response;
      // Sent at most twice: once as built, and once more with no images at
      // all if the endpoint refused them. The retry is built as though the
      // model had no vision rather than from what is left: omitting the
      // refused images frees replay budget, and a rebuild that could see
      // it would spend it on older images — sending a picture to an
      // endpoint that just said it takes none.
      let imagesRetried = false;
      for (;;) {
        const { messages, sent } = createOpenAICompatibleMessages(request, systemPrompt, toolNames, vision && !imagesRetried, imageReplayBudget);
        try {
          response = await fetchImpl(`${normalizedBaseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${apiKey}`,
              ...headers,
            },
            body: JSON.stringify({
              model,
              messages,
              ...(tools.length > 0 ? { tools } : {}),
            }),
            ...(signal ? { signal } : {}),
          });
          payload = await parseOpenAICompatibleResponse(response);
        } catch (error) {
          // A timed-out request is a provider failure (fallback-eligible),
          // never mistaken for the caller's own cancellation.
          if (timeout?.aborted && !request.signal?.aborted) {
            throw new Error(`Provider request timed out after ${requestTimeoutMs}ms: ${name}`);
          }
          throw error;
        }

        if (response.ok) {
          break;
        }
        const message = payload.error?.message ?? payload.rawText ?? `Provider request failed with status ${response.status}`;
        // A 400 that blames an image, from a request that carried some. This
        // wire format has no one error shape across its vendors, so the
        // whole batch is let go of rather than one block: the images are
        // emptied on the session itself, since stored as they are they would
        // fail every later turn the same way, and the turn goes on with a
        // note in each one's place.
        if (response.status === 400 && sent.length > 0 && !imagesRetried && /image/i.test(message)) {
          for (const image of sent) {
            omitImage(image);
          }
          imagesRetried = true;
          continue;
        }
        throw new Error(message);
      }

      // Reported through the sink BEFORE the empty-response check below.
      // A 200 with `usage` and nothing usable in it — tool arguments that
      // will not parse, content-filtered output — is a paid call that ends
      // in a throw, and a throw returns no response for the count to ride
      // on. The count also stays on the response for a host calling
      // generate with no sink attached; the kernel reads one or the other,
      // never both.
      const usage = extractOpenAICompatibleUsage(payload, name, model);
      if (usage) {
        request.onUsage?.(usage);
      }

      const builder = createProviderResponseBuilder();

      const text = extractOpenAICompatibleText(payload);
      if (text.length > 0) {
        builder.addText(text);
      }

      const toolCalls = extractOpenAICompatibleToolCalls(payload, toolNames);
      for (const call of toolCalls) {
        builder.addToolCall(call);
      }

      const result = builder.done();
      if (result.parts.length === 0) {
        // Nothing said is the answer a turn nobody asked for may give — see
        // `RunInput.addressed` in core — but only when the model actually
        // stopped: a response cut off by length, a content filter, or a
        // tool call with no usable name is a failure reduced to no parts,
        // and recording it as a decision would hide it. An endpoint that
        // reports no finish reason at all is taken at its word.
        const choice = payload.choices?.[0];
        const finishReason = choice?.finish_reason ?? undefined;
        // A choice with a message has to exist: a 200 with an empty body,
        // `{}`, or no choices is no completion at all, and a missing
        // finish reason is tolerated only on one that is.
        const stoppedNormally = choice?.message !== undefined && (finishReason === undefined || finishReason === 'stop');
        if (!isUnaddressedTurn(request.session) || !stoppedNormally) {
          throw new Error(
            finishReason !== undefined && finishReason !== 'stop'
              ? `Provider returned an empty response (finish_reason: ${finishReason}).`
              : 'Provider returned an empty response.',
          );
        }
      }

      return usage ? { ...result, usage } : result;
    },
  });
};

/**
 * The response's token counts in the kernel's four buckets, or undefined
 * when the endpoint reported none.
 *
 * `prompt_tokens` counts cached tokens too, while `TokenUsage.inputTokens`
 * is the full-rate bucket alone — so the cached count comes out of it,
 * through the kernel's own `uncachedInputTokens` rather than a subtraction
 * spelled out again here. There is no cache-write bucket on this wire
 * format: these endpoints cache implicitly and bill nothing for the write,
 * so `cacheWriteTokens` stays absent rather than becoming a zero.
 */
const extractOpenAICompatibleUsage = (
  payload: OpenAICompatibleResponse,
  providerName: string,
  model: string,
): ProviderCallUsage | undefined => {
  const usage = payload.usage;
  const promptTokens = typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : undefined;
  const completionTokens = typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : undefined;
  const cachedTokens = typeof usage?.prompt_tokens_details?.cached_tokens === 'number'
    ? usage.prompt_tokens_details.cached_tokens
    : undefined;
  if (promptTokens === undefined && completionTokens === undefined && cachedTokens === undefined) {
    return undefined;
  }
  return {
    provider: providerName,
    model: typeof payload.model === 'string' && payload.model.length > 0 ? payload.model : model,
    ...(promptTokens !== undefined ? { inputTokens: uncachedInputTokens(promptTokens, cachedTokens) } : {}),
    ...(completionTokens !== undefined ? { outputTokens: completionTokens } : {}),
    ...(cachedTokens !== undefined ? { cacheReadTokens: cachedTokens } : {}),
  };
};

interface OpenAICompatibleToolNameMapping {
  toWire: Map<string, string>;
  fromWire: Map<string, string>;
}

// OpenAI only accepts function names matching ^[a-zA-Z0-9_-]{1,64}$, so
// registry names like "demo.echo" must be sanitized for the wire and
// translated back when the model calls them.
export const sanitizeOpenAICompatibleToolName = (name: string): string => {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return sanitized.length > 0 ? sanitized : 'tool';
};

const createOpenAICompatibleToolNameMapping = (
  tools: ToolDescriptor[] | undefined,
): OpenAICompatibleToolNameMapping => {
  const toWire = new Map<string, string>();
  const fromWire = new Map<string, string>();

  for (const tool of tools ?? []) {
    if (toWire.has(tool.name)) {
      continue;
    }

    const base = sanitizeOpenAICompatibleToolName(tool.name);
    let wireName = base;
    for (let suffix = 2; fromWire.has(wireName); suffix += 1) {
      wireName = `${base.slice(0, 60)}_${suffix}`;
    }

    toWire.set(tool.name, wireName);
    fromWire.set(wireName, tool.name);
  }

  return { toWire, fromWire };
};

const toWireToolName = (name: string, mapping: OpenAICompatibleToolNameMapping): string =>
  mapping.toWire.get(name) ?? sanitizeOpenAICompatibleToolName(name);

const createOpenAICompatibleTools = (
  tools: ToolDescriptor[] | undefined,
  toolNames: OpenAICompatibleToolNameMapping,
): OpenAICompatibleToolDefinition[] =>
  (tools ?? []).map((tool) => ({
    type: 'function',
    function: {
      name: toWireToolName(tool.name, toolNames),
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    },
  }));

const extractOpenAICompatibleToolCalls = (
  payload: OpenAICompatibleResponse,
  toolNames: OpenAICompatibleToolNameMapping,
): ToolCall[] => {
  const toolCalls = payload.choices?.[0]?.message?.tool_calls ?? [];
  const calls: ToolCall[] = [];

  for (const [index, toolCall] of toolCalls.entries()) {
    const wireName = toolCall.function?.name;
    if (!wireName) {
      continue;
    }

    const name = toolNames.fromWire.get(wireName) ?? wireName;
    const rawArguments = toolCall.function?.arguments ?? '{}';
    let input: JsonObject;
    try {
      const parsed: unknown = rawArguments.trim().length === 0 ? {} : JSON.parse(rawArguments);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('arguments must be a JSON object');
      }
      input = parsed as JsonObject;
    } catch (error) {
      throw new Error(
        `Provider returned invalid arguments for tool ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    calls.push({
      id: toolCall.id ?? `tool-call-${index + 1}`,
      toolName: name,
      input,
    });
  }

  return calls;
};

const parseOpenAICompatibleResponse = async (response: Response): Promise<OpenAICompatibleResponse> => {
  const rawText = await response.text();
  if (rawText.length === 0) {
    return {};
  }

  try {
    return JSON.parse(rawText) as OpenAICompatibleResponse;
  } catch {
    return { rawText };
  }
};

const createOpenAICompatibleMessages = (
  request: ProviderRequest,
  systemPrompt: string | undefined,
  toolNames: OpenAICompatibleToolNameMapping,
  vision: boolean,
  imageReplayBudget: ImageReplayBudget | undefined,
): { messages: OpenAICompatibleMessage[]; sent: ImageAttachment[] } => {
  const messages: OpenAICompatibleMessage[] = [];
  const replayed = imagesWithinReplayBudget(request.session.messages, imageReplayBudget);
  // The images this request actually carries, for a rejection to answer.
  const sent: ImageAttachment[] = vision
    ? request.session.messages.flatMap((message) => (message.images ?? []).filter((image) => replayed.has(image)))
    : [];

  // One shared reading of what an agent is told about itself — persona,
  // memory, skills — rendered by the kernel (see core's system prompt
  // renderer); this dialect sends each section as its own system message.
  for (const section of renderSystemPromptSections(request, {
    ...(systemPrompt ? { preamble: systemPrompt } : {}),
  })) {
    messages.push({ role: 'system', content: section });
  }

  const latest = latestUserMessageOf(request.session.messages);
  for (const message of request.session.messages) {
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      const wireCalls = message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: {
          name: toWireToolName(call.toolName, toolNames),
          arguments: JSON.stringify(call.input),
        },
      }));
      // The runner records one message per call (and the response's text
      // separately), but on the wire they are ONE assistant turn: OpenAI
      // rejects a tool_calls message that is not fully answered before the
      // next assistant message. Directly consecutive assistant messages
      // can only come from a single response, so merging is safe.
      const previous = messages.at(-1);
      if (previous && previous.role === 'assistant') {
        previous.tool_calls = [...(previous.tool_calls ?? []), ...wireCalls];
        continue;
      }
      messages.push({
        role: 'assistant',
        content: message.content.length > 0 ? message.content : null,
        tool_calls: wireCalls,
      });
      continue;
    }

    if (message.role === 'tool') {
      const result = message.toolResult;
      messages.push({
        role: 'tool',
        content: result
          ? JSON.stringify(result.ok ? result.output : { error: result.error ?? 'Tool failed' })
          : message.content,
        ...(result ? { tool_call_id: result.callId } : {}),
      });
      continue;
    }

    if (message.role === 'assistant' && message.content.length === 0) {
      // A turn nobody asked for that said nothing: the boundary is the
      // kernel's, and an empty assistant message is a wire-format error on
      // some endpoints and a blank line on the rest.
      continue;
    }
    // Framed by the kernel's one rule for it, so the OpenAI-compatible path
    // says "said to somebody else" the way the API and harness paths do —
    // an overheard message sent bare here would be an ordinary instruction
    // on exactly the endpoint with no other provenance signal.
    messages.push({
      role: message.role,
      content: message.role === 'user'
        ? (vision ? userContentParts(message, replayed, message === latest) : userMessageText(message, message === latest))
        : message.content,
      ...(message.name ? { name: message.name } : {}),
    });
  }

  return { messages, sent };
};

const userContentParts = (
  message: Pick<Message, 'content' | 'overheard' | 'images'>,
  replayed: ReadonlySet<ImageAttachment>,
  latest: boolean,
): OpenAICompatibleUserContent => {
  const text = promptTextOf(message, { latest });
  if (message.images === undefined || message.images.length === 0) {
    return text;
  }
  return [
    ...(text.length > 0 ? [{ type: 'text' as const, text }] : []),
    ...message.images.map((image) => (replayed.has(image)
      ? { type: 'image_url' as const, image_url: { url: `data:${image.mediaType};base64,${image.data}` } }
      : { type: 'text' as const, text: droppedImageNote(image) })),
  ];
};

const extractOpenAICompatibleText = (payload: OpenAICompatibleResponse): string => {
  const message = payload.choices?.[0]?.message;
  const content = message?.content;

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
      .join('');
  }

  return '';
};

const isProviderPart = (value: ProviderResponseInput): value is ProviderPart => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  return (
    'type' in value &&
    (value.type === 'text' || value.type === 'tool-call')
  );
};

const isProviderResponse = (value: ProviderResponseInput): value is ProviderResponse => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  return 'parts' in value && Array.isArray(value.parts);
};

// ---------------------------------------------------------------------------
// Hosted-loop provider helpers
//
// Shared by every provider that wraps a harness owning its own agent loop
// (`provider-claude-code`, `provider-codex`). These used to live in
// `provider-claude-code`; they moved here when a second harness provider
// needed the same rules, because a second hand-rolled copy of any of them
// drifts from the first. `provider-claude-code` re-exports them, so the
// documented import paths still work.
// ---------------------------------------------------------------------------

/**
 * Executes one kernel tool call on behalf of a provider-hosted loop. The
 * host owns approvals, events, allowlists, and the executor —
 * AgentRunner.executeHostedToolCall is the canonical implementation.
 */
export type HostedToolExecutor = (
  session: Session,
  call: ToolCall,
  context?: ExecutionContext,
) => Promise<ToolResult>;

const HOSTED_SIDE_EFFECTS = Symbol.for('stratus.hostedToolSideEffects');

/** Marks an error as coming from a turn that had already executed kernel tools. */
export const markHostedToolSideEffects = <T>(error: T): T => {
  if (typeof error === 'object' && error !== null) {
    (error as Record<PropertyKey, unknown>)[HOSTED_SIDE_EFFECTS] = true;
  }
  return error;
};

/**
 * True when this error aborted a turn that had already executed kernel
 * tools. Retrying such a request on another provider would repeat those
 * side effects (a fact remembered twice, a command run twice), so
 * fallback wrappers must rethrow instead of failing over.
 */
export const hasHostedToolSideEffects = (error: unknown): boolean =>
  typeof error === 'object' && error !== null
  && (error as Record<PropertyKey, unknown>)[HOSTED_SIDE_EFFECTS] === true;

// MCP tool names must match ^[a-zA-Z0-9_-]{1,64}$, so kernel names like
// "demo.echo" are flattened; the original name travels with the caller.
const sanitizeMcpToolName = (name: string): string => {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return cleaned.length > 0 ? cleaned : 'tool';
};

/**
 * The MCP name each kernel tool is bridged under, keyed by the kernel's
 * own dotted name.
 *
 * Exported because the mapping is needed in two directions and must not be
 * derived twice: a bridge registers tools under these names, and streamed
 * deltas arrive carrying them and have to be reported back to the kernel in
 * its own naming. A second copy of the dedup rule would drift the first
 * time two tools sanitize alike.
 */
export const bridgedToolNames = (descriptors: readonly ToolDescriptor[]): Map<string, string> => {
  const used = new Set<string>();
  const byKernelName = new Map<string, string>();
  for (const descriptor of descriptors) {
    const base = sanitizeMcpToolName(descriptor.name);
    let name = base;
    for (let suffix = 2; used.has(name); suffix += 1) {
      name = `${base.slice(0, 60)}_${suffix}`;
    }
    used.add(name);
    byKernelName.set(descriptor.name, name);
  }
  return byKernelName;
};

/**
 * A session rendered as one prompt string for a harness that takes a single
 * prompt per run: the whole conversation, latest user message last. Used
 * when a harness session is fresh (or its stored session could not be
 * resumed) and knows nothing yet.
 */
/**
 * What a text-only runtime is told about the images on a user message. The
 * harness providers hand their SDK one prompt string, so the image itself
 * cannot travel; naming it is what lets the model say it cannot see the
 * screenshot rather than describe one it was never shown.
 */
const describeImageAttachments = (images: readonly ImageAttachment[] | undefined): string => {
  if (images === undefined || images.length === 0) {
    return '';
  }
  const names = images.map((image) => image.name ?? `a ${image.mediaType} image`);
  return `\n[Attached: ${names.join(', ')}. This runtime cannot see images — say so rather than guessing at them.]`;
};

/**
 * A user message's text as a prompt carries it, with its images named after
 * it. `latest` marks the newest user message of the turn — the one an
 * unaddressed turn's note follows; see `PromptTextOptions`.
 */
const userMessageText = (message: Pick<Message, 'content' | 'overheard' | 'images'>, latest = false): string =>
  `${promptTextOf(message, { latest })}${describeImageAttachments(message.images)}`;

/** The newest user message — the one the turn being run ends on. */
const latestUserMessageOf = (messages: readonly Message[]): Message | undefined =>
  messages.findLast((message) => message.role === 'user');

export const renderTranscriptPrompt = (request: ProviderRequest): string => {
  const conversational = request.session.messages.filter(
    (message) => message.role === 'user' || message.role === 'assistant' || message.role === 'tool',
  );

  const latest = latestUserMessageOf(conversational);
  if (conversational.length === 1 && conversational[0]?.role === 'user') {
    return userMessageText(conversational[0], true);
  }

  const lines: string[] = ['Conversation so far:'];
  for (const message of conversational) {
    if (message.role === 'tool') {
      lines.push(`[tool ${message.name ?? 'result'}] ${message.content}`);
      continue;
    }
    // A tool call is part of the assistant's turn: without it, the next
    // run would see a result with no record of what was asked (e.g. a
    // memory id but not the remembered fact) and reason over half the
    // history. Its runner message carries empty content, so skip that.
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      for (const call of message.toolCalls) {
        lines.push(`[assistant called tool ${call.toolName}] ${JSON.stringify(call.input)}`);
      }
    }
    if (message.role === 'assistant' && message.content.length === 0) {
      // Either the tool-call message above, or the silence a turn nobody
      // asked for ends in — neither is a line the model should read.
      continue;
    }
    lines.push(`[${message.role}] ${message.role === 'user' ? userMessageText(message, message === latest) : message.content}`);
  }
  // A turn nobody asked for ends on an overheard message carrying its own
  // instruction, and "reply to the latest user message" would countermand
  // it in the next line.
  if (latest?.overheard !== true) {
    lines.push('', 'Continue the conversation by replying to the latest user message.');
  }
  return lines.join('\n');
};

/**
 * What a resumed harness session has not heard yet: every message
 * overheard since the agent last spoke, then the newest user message. The
 * harness holds everything before its own last reply, and until `observe`
 * that was always exactly one message — but a message overheard between
 * turns is appended with no turn run on it, so by the next turn there can
 * be several, and sending only the newest would leave the model answering
 * with the thread's middle missing on precisely the path that cannot
 * rebuild its history.
 *
 * Selected by the mark, not by position. "Every user message since the
 * last assistant" reads the same in the common case and differs after a
 * turn the harness accepted and then failed: no reply was appended, so
 * that turn's message is still ahead of the last assistant, and scanning
 * back would send it to a harness that already has it. An overheard
 * message is one the harness has never seen, by construction; an
 * addressed one before the newest was some turn's prompt.
 *
 * One addressed message with nothing overheard renders bare, as it always
 * did. Falls back to the full transcript when there is no user message to
 * isolate, so a caller can never end up sending nothing.
 */
export const latestUserMessagePrompt = (request: ProviderRequest): string => {
  const messages = request.session.messages;
  let start = messages.length;
  while (start > 0 && messages[start - 1]?.role !== 'assistant') {
    start -= 1;
  }
  const since = messages.slice(start).filter((message) => message.role === 'user');
  const newest = since.at(-1);
  if (!newest) {
    return renderTranscriptPrompt(request);
  }
  const unheard = since.filter((message) => message.overheard === true || message === newest);
  if (unheard.length === 1 && newest.overheard !== true) {
    return userMessageText(newest);
  }
  return unheard.map((message) => userMessageText(message, message === newest)).join('\n');
};
