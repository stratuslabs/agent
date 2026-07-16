import type {
  JsonObject,
  ModelProvider,
  ProviderPart,
  ProviderRequest,
  ProviderResponse,
  ToolCall,
  ToolDescriptor,
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

      const response = await fetchImpl(`${normalizedBaseUrl}/chat/completions`, {
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
      });

      const payload = await parseOpenAICompatibleResponse(response);

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

  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }

  for (const message of request.session.messages) {
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: message.content.length > 0 ? message.content : null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: {
            name: toWireToolName(call.toolName, toolNames),
            arguments: JSON.stringify(call.input),
          },
        })),
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
