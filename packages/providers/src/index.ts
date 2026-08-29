import {
  renderSystemPromptSections,
  type ExecutionContext,
  type JsonObject,
  type ModelProvider,
  type ProviderPart,
  type ProviderRequest,
  type ProviderResponse,
  type Session,
  type ToolCall,
  type ToolDescriptor,
  type ToolResult,
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
}

interface OpenAICompatibleToolCall {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenAICompatibleMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
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
  }>;
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
    return providerResponse(...input.parts);
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
            messages: createOpenAICompatibleMessages(request, systemPrompt, toolNames),
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

      if (!response.ok) {
        throw new Error(payload.error?.message ?? payload.rawText ?? `Provider request failed with status ${response.status}`);
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
        throw new Error('Provider returned an empty response.');
      }

      return result;
    },
  });
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
): OpenAICompatibleMessage[] => {
  const messages: OpenAICompatibleMessage[] = [];

  // One shared reading of what an agent is told about itself — persona,
  // memory, skills — rendered by the kernel (see core's system prompt
  // renderer); this dialect sends each section as its own system message.
  for (const section of renderSystemPromptSections(request, {
    ...(systemPrompt ? { preamble: systemPrompt } : {}),
  })) {
    messages.push({ role: 'system', content: section });
  }

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

    messages.push({
      role: message.role,
      content: message.content,
      ...(message.name ? { name: message.name } : {}),
    });
  }

  return messages;
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
export const renderTranscriptPrompt = (request: ProviderRequest): string => {
  const conversational = request.session.messages.filter(
    (message) => message.role === 'user' || message.role === 'assistant' || message.role === 'tool',
  );

  if (conversational.length === 1 && conversational[0]?.role === 'user') {
    return conversational[0].content;
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
      if (message.content.length === 0) {
        continue;
      }
    }
    lines.push(`[${message.role}] ${message.content}`);
  }
  lines.push('', 'Continue the conversation by replying to the latest user message.');
  return lines.join('\n');
};

/**
 * The newest user message, which is all a resumed harness session needs:
 * the harness is holding everything before it. Falls back to the full
 * transcript when there is no user message to isolate, so a caller can
 * never end up sending nothing.
 */
export const latestUserMessagePrompt = (request: ProviderRequest): string => {
  for (let index = request.session.messages.length - 1; index >= 0; index -= 1) {
    const message = request.session.messages[index];
    if (message?.role === 'user') {
      return message.content;
    }
  }
  return renderTranscriptPrompt(request);
};
