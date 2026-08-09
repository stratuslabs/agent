import Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlock,
  ContentBlockParam,
  MessageParam,
  Tool as AnthropicTool,
} from '@anthropic-ai/sdk/resources/messages/messages';
import type {
  JsonObject,
  ModelProvider,
  ProviderRequest,
  ToolCall,
  ToolDescriptor,
} from '@stratusagent/core';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';
const DEFAULT_MAX_TOKENS = 4096;
// Session metadata key holding raw assistant turns, keyed by tool_use id.
export const RAW_TURNS_METADATA_KEY = 'anthropicRawTurns';

export interface AnthropicProviderConfig {
  apiKey: string;
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

const createSystemPrompt = (
  request: ProviderRequest,
  systemPrompt: string | undefined,
): string | undefined => {
  const sections: string[] = [];

  if (systemPrompt) {
    sections.push(systemPrompt);
  }

  // The agent's own persona travels with the session and must reach the
  // model — this is what makes a delegated specialist act like themselves.
  const { name, instructions } = request.session.agent;
  if (instructions && instructions.length > 0) {
    sections.push(`You are ${name}. ${instructions}`);
  }

  if (request.memory && request.memory.length > 0) {
    const facts = request.memory.map((entry) => `- ${entry.content}`).join('\n');
    sections.push(`Things you remember from previous conversations (your own long-term memory):\n${facts}`);
  }

  return sections.length > 0 ? sections.join('\n\n') : undefined;
};

type RawTurns = Record<string, ContentBlock[]>;

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
 * Model provider backed by Anthropic's Claude API via the official SDK.
 * Supports multi-turn tool calling, renders the agent's persona and
 * long-term memory as the system prompt, and preserves Claude's thinking
 * blocks across tool-use turns.
 */
export const createAnthropicProvider = ({
  apiKey,
  model = DEFAULT_ANTHROPIC_MODEL,
  name = 'anthropic',
  maxTokens = DEFAULT_MAX_TOKENS,
  systemPrompt,
  baseUrl,
  thinking = 'default',
  fetch: fetchImpl,
}: AnthropicProviderConfig): ModelProvider => {
  const client = new Anthropic({
    apiKey,
    ...(baseUrl ? { baseURL: baseUrl } : {}),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });

  return {
    name,
    async generate(request: ProviderRequest) {
      const rawTurns = rawTurnsFrom(request.session);
      const mapping = createToolNameMapping(request.tools);
      const tools = createAnthropicTools(request.tools, mapping);
      const system = createSystemPrompt(request, systemPrompt);

      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        ...(tools.length > 0 ? { tools } : {}),
        // Claude Opus 5 thinks adaptively when `thinking` is omitted.
        ...(thinking === 'disabled' ? { thinking: { type: 'disabled' as const } } : {}),
        messages: createAnthropicMessages(request, mapping, rawTurns),
      });

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

      return { parts };
    },
  };
};
