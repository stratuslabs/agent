import type {
  ModelProvider,
  ProviderPart,
  ProviderRequest,
  ProviderResponse,
  ToolCall,
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

interface OpenAICompatibleMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
}

interface OpenAICompatibleResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
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
      const response = await fetchImpl(`${normalizedBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
          ...headers,
        },
        body: JSON.stringify({
          model,
          messages: createOpenAICompatibleMessages(request, systemPrompt),
        }),
      });

      const payload = await parseOpenAICompatibleResponse(response);

      if (!response.ok) {
        throw new Error(payload.error?.message ?? payload.rawText ?? `Provider request failed with status ${response.status}`);
      }

      const text = extractOpenAICompatibleText(payload);
      if (text.length === 0) {
        throw new Error('Provider returned an empty response.');
      }

      return createProviderResponseBuilder().addText(text).done();
    },
  });
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
  systemPrompt?: string,
): OpenAICompatibleMessage[] => {
  const messages: OpenAICompatibleMessage[] = [];

  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }

  for (const message of request.session.messages) {
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
