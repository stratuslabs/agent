import { query as sdkQuery, type Options } from '@anthropic-ai/claude-agent-sdk';
import type { ModelProvider, ProviderRequest } from '@stratusagent/core';

export const DEFAULT_CLAUDE_CODE_MODEL = 'claude-opus-5';

/**
 * The slice of the Agent SDK's message stream this provider consumes.
 * Kept loose so tests can inject a plain async generator.
 */
export interface ClaudeCodeStreamMessage {
  type: string;
  subtype?: string;
  result?: string;
  is_error?: boolean;
}

export type ClaudeCodeQueryFn = (params: {
  prompt: string;
  options?: Options;
}) => AsyncIterable<ClaudeCodeStreamMessage>;

export interface ClaudeCodeProviderConfig {
  /**
   * Claude Code setup token (`claude setup-token`) minted from a Pro/Max
   * subscription. Omit to use the machine's existing Claude Code sign-in.
   */
  authToken?: string;
  /** Defaults to claude-opus-5. */
  model?: string;
  name?: string;
  /** Extra system prompt, rendered before the agent's own persona. */
  systemPrompt?: string;
  /** Claude Code turns per generate call. Default 1 (no tools yet). */
  maxTurns?: number;
  /** Path to a specific Claude Code executable (auto-detected otherwise). */
  pathToClaudeCodeExecutable?: string;
  /** Test injection point; defaults to the real Agent SDK query(). */
  queryFn?: ClaudeCodeQueryFn;
}

const createSystemPrompt = (
  request: ProviderRequest,
  systemPrompt: string | undefined,
): string => {
  const sections: string[] = [];

  if (systemPrompt) {
    sections.push(systemPrompt);
  }

  // The agent's own persona travels with the session and must reach the
  // model — this is what makes a Stratus agent themselves on any runtime.
  const { name, instructions } = request.session.agent;
  if (instructions && instructions.length > 0) {
    sections.push(`You are ${name}. ${instructions}`);
  } else {
    sections.push(`You are ${name}, a helpful assistant.`);
  }

  if (request.memory && request.memory.length > 0) {
    const facts = request.memory.map((entry) => `- ${entry.content}`).join('\n');
    sections.push(`Things you remember from previous conversations (your own long-term memory):\n${facts}`);
  }

  return sections.join('\n\n');
};

// The Agent SDK takes a single prompt string per query, so multi-turn
// sessions are rendered as a transcript with the latest user message last.
const createPrompt = (request: ProviderRequest): string => {
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
    lines.push(`[${message.role}] ${message.content}`);
  }
  lines.push('', 'Continue the conversation by replying to the latest user message.');
  return lines.join('\n');
};

/**
 * Runs turns through the Claude Agent SDK (Claude Code as a library), so a
 * Claude Pro/Max subscription covers usage instead of per-token API billing.
 *
 * Current scope: text conversations with the agent's persona and memory.
 * Kernel tools are not yet bridged into the Claude Code loop, so runs
 * through this provider do not execute Stratus tools.
 *
 * Requires Claude Code available on the machine (bundled with the Agent
 * SDK) and either a setup token (`authToken`) or an existing `claude`
 * sign-in.
 */
export const createClaudeCodeProvider = ({
  authToken,
  model = DEFAULT_CLAUDE_CODE_MODEL,
  name = 'claude-code',
  systemPrompt,
  maxTurns = 1,
  pathToClaudeCodeExecutable,
  queryFn = sdkQuery as unknown as ClaudeCodeQueryFn,
}: ClaudeCodeProviderConfig = {}): ModelProvider => ({
  name,
  async generate(request: ProviderRequest) {
    const options: Options = {
      model,
      systemPrompt: createSystemPrompt(request, systemPrompt),
      // No built-in Claude Code tools: Stratus owns the tool surface, and
      // kernel tools are not bridged into this runtime yet.
      tools: [],
      maxTurns,
      // The env REPLACES the subprocess environment, so inherit ours and
      // then pin the auth: this provider is subscription-billed in both
      // modes (setup token or existing sign-in), so an ambient API key must
      // never silently turn a run into metered API usage.
      env: {
        ...process.env,
        CLAUDE_AGENT_SDK_CLIENT_APP: 'stratus-agent',
        ANTHROPIC_API_KEY: undefined,
        ...(authToken ? { CLAUDE_CODE_OAUTH_TOKEN: authToken } : {}),
      },
      ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
    };

    let resultText: string | undefined;

    try {
      for await (const message of queryFn({ prompt: createPrompt(request), options })) {
        if (message.type !== 'result') {
          continue;
        }
        if (message.subtype === 'success' && !message.is_error) {
          resultText = message.result;
          continue;
        }
        throw new Error(
          `Claude Code run failed (${message.subtype ?? 'unknown error'})${message.result ? `: ${message.result}` : ''}`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(
          'Claude Code could not be started. Install it (npm install -g @anthropic-ai/claude-code) and sign in with `claude`, or use an Anthropic API key instead.',
        );
      }
      throw error;
    }

    if (resultText === undefined || resultText.length === 0) {
      throw new Error('Claude Code returned an empty response.');
    }

    return { parts: [{ type: 'text' as const, text: resultText }] };
  },
});
