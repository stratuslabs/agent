import type {
  ModelProvider,
  ProviderPart,
  ProviderRequest,
  ProviderResponse,
  ToolCall,
} from '@stratusclaw/core';

export interface ProviderResponseBuilder {
  addText(text: string): ProviderResponseBuilder;
  addToolCall(call: ToolCall): ProviderResponseBuilder;
  done(): ProviderResponse;
}

export const textPart = (text: string): ProviderPart => ({ type: 'text', text });

export const toolCallPart = (call: ToolCall): ProviderPart => ({
  type: 'tool-call',
  call,
});

export const providerResponse = (...parts: ProviderPart[]): ProviderResponse => ({
  parts,
});

export const createProviderResponseBuilder = (
  initialParts: ProviderPart[] = [],
): ProviderResponseBuilder => {
  const parts = [...initialParts];

  return {
    addText(text) {
      parts.push(textPart(text));
      return this;
    },
    addToolCall(call) {
      parts.push(toolCallPart(call));
      return this;
    },
    done() {
      return providerResponse(...parts);
    },
  };
};

export interface ProviderAdapterDefinition {
  name: string;
  generate(request: ProviderRequest): Promise<ProviderResponse>;
}

export const defineProvider = ({ name, generate }: ProviderAdapterDefinition): ModelProvider => ({
  name,
  generate,
});
