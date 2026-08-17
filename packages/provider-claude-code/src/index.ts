import { randomUUID } from 'node:crypto';

import {
  createSdkMcpServer,
  query as sdkQuery,
  tool as sdkTool,
  type Options,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type {
  JsonObject,
  ModelProvider,
  ProviderRequest,
  Session,
  ToolCall,
  ToolDescriptor,
  ToolResult,
  ExecutionContext,
} from '@stratusagent/core';

export const DEFAULT_CLAUDE_CODE_MODEL = 'claude-opus-5';

/** Provider turns per generate call once kernel tools are bridged in. */
const DEFAULT_TOOL_MAX_TURNS = 8;

const MCP_SERVER_NAME = 'stratus';

/**
 * Executes one kernel tool call on behalf of the Claude Code loop. The
 * host owns approvals, events, allowlists, and the executor —
 * AgentRunner.executeHostedToolCall is the canonical implementation.
 */
export type ClaudeCodeToolExecutor = (session: Session, call: ToolCall, context?: ExecutionContext) => Promise<ToolResult>;

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
// "demo.echo" are flattened; the original name travels in the closure.
const sanitizeToolName = (name: string): string => {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return cleaned.length > 0 ? cleaned : 'tool';
};

const zodTypeFor = (schema: unknown): z.ZodType => {
  if (typeof schema !== 'object' || schema === null) {
    return z.unknown();
  }
  const spec = schema as Record<string, unknown>;
  let type: z.ZodType;
  if (Array.isArray(spec.enum) && spec.enum.length > 0 && spec.enum.every((value) => typeof value === 'string')) {
    type = z.enum(spec.enum as [string, ...string[]]);
  } else {
    switch (spec.type) {
      case 'string':
        type = z.string();
        break;
      case 'number':
      case 'integer':
        type = z.number();
        break;
      case 'boolean':
        type = z.boolean();
        break;
      case 'array':
        type = z.array(zodTypeFor(spec.items));
        break;
      case 'object':
        type = z.record(z.string(), z.unknown());
        break;
      default:
        type = z.unknown();
    }
  }
  return typeof spec.description === 'string' ? type.describe(spec.description) : type;
};

// Kernel tools describe inputs as JSON Schema; the Agent SDK wants a Zod
// shape. Unknown constructs degrade to z.unknown() rather than failing.
const zodShapeFor = (parameters: JsonObject | undefined): Record<string, z.ZodType> => {
  const shape: Record<string, z.ZodType> = {};
  if (!parameters || typeof parameters.properties !== 'object' || parameters.properties === null) {
    return shape;
  }
  const required = new Set(
    Array.isArray(parameters.required)
      ? parameters.required.filter((value): value is string => typeof value === 'string')
      : [],
  );
  for (const [key, propSchema] of Object.entries(parameters.properties as Record<string, unknown>)) {
    const type = zodTypeFor(propSchema);
    shape[key] = required.has(key) ? type : type.optional();
  }
  return shape;
};

/**
 * Renders kernel tools as in-process MCP tool definitions: Claude Code
 * calls them mid-loop, the host executes them (approvals and events
 * included), and the result feeds straight back into the same turn.
 * createClaudeCodeProvider wires this automatically; exported for hosts
 * with their own loops and for tests.
 */
export const bridgeKernelTools = (
  descriptors: readonly ToolDescriptor[],
  session: Session,
  executeTool: ClaudeCodeToolExecutor,
  context?: ExecutionContext,
): Array<SdkMcpToolDefinition<Record<string, z.ZodType>>> => {
  // The kernel loop executes tools one at a time; hosted execution keeps
  // that contract. Concurrent MCP calls would race a single interactive
  // approval prompt — and each other's side effects.
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const used = new Set<string>();
  return descriptors.map((descriptor) => {
    const base = sanitizeToolName(descriptor.name);
    let name = base;
    for (let suffix = 2; used.has(name); suffix += 1) {
      name = `${base.slice(0, 60)}_${suffix}`;
    }
    used.add(name);
    return sdkTool(
      name,
      descriptor.description ?? `Stratus tool ${descriptor.name}`,
      zodShapeFor(descriptor.parameters),
      async (args) => {
        const result = await serialize(() => executeTool(session, {
          id: `claude-code:${randomUUID()}`,
          toolName: descriptor.name,
          input: (args ?? {}) as JsonObject,
        }, context));
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result.ok ? result.output : { error: result.error ?? 'Tool failed.' }),
            },
          ],
          ...(result.ok ? {} : { isError: true }),
        };
      },
    );
  });
};

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
  /**
   * Executes kernel tool calls for the Claude Code loop. When set, the
   * request's tools are bridged in as an in-process MCP server; without
   * it runs stay text-only.
   */
  executeTool?: ClaudeCodeToolExecutor;
  /** Claude Code turns per generate call. Defaults to 1 without tools, 8 with. */
  maxTurns?: number;
  /** Path to a specific Claude Code executable (auto-detected otherwise). */
  pathToClaudeCodeExecutable?: string;
  /** Test injection point; defaults to the real Agent SDK query(). */
  queryFn?: ClaudeCodeQueryFn;
  /**
   * Abort a query when the SDK stream yields nothing for this long — a
   * wedged subprocess must not pin a turn (and a draining daemon) open
   * forever. Inactivity-based, so a healthy long run that keeps producing
   * messages stays alive. Sized above the local executor's timeout ceiling
   * so a slow hosted tool never trips it. 0 disables. Default 10 minutes.
   */
  idleTimeoutMs?: number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 600_000;

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

// Forwards the kernel's abort signal into an AbortController the Agent SDK
// understands, so aborting a turn terminates the underlying query.
const linkedAbortController = (signal: AbortSignal): AbortController => {
  const controller = new AbortController();
  if (signal.aborted) {
    controller.abort();
  } else {
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller;
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
    // A tool call is part of the assistant's turn: without it, the next
    // query would see a result with no record of what was asked (e.g. a
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
 * Runs turns through the Claude Agent SDK (Claude Code as a library), so a
 * Claude Pro/Max subscription covers usage instead of per-token API billing.
 *
 * The agent's persona and memory render as the system prompt, and kernel
 * tools bridge into the loop as an in-process MCP server when the host
 * supplies `executeTool` — approvals, allowlists, and events all run on
 * the host side, so this runtime is the same agent as the API provider.
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
  executeTool,
  maxTurns,
  pathToClaudeCodeExecutable,
  queryFn = sdkQuery as unknown as ClaudeCodeQueryFn,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
}: ClaudeCodeProviderConfig = {}): ModelProvider => ({
  name,
  async generate(request: ProviderRequest) {
    // Kernel tools ride into the loop as an in-process MCP server; the
    // host executes each call (approvals and events included) and Claude
    // Code continues the turn with the result. Executions are counted so
    // a failure after side effects can refuse fallback replay.
    const controller = request.signal
      ? linkedAbortController(request.signal)
      : new AbortController();

    // A wedged SDK subprocess yields nothing forever; the idle timer cuts
    // it loose. It resets on every yielded message so healthy long runs
    // stay alive, and it suspends entirely while a hosted tool (approval
    // waits included) is executing — those phases legitimately produce no
    // SDK output for as long as they need.
    let timedOutIdle = false;
    let idleTimer: NodeJS.Timeout | undefined;
    let activeHostedTools = 0;
    const suspendIdleTimer = (): void => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };
    const resetIdleTimer = (): void => {
      if (idleTimeoutMs <= 0 || activeHostedTools > 0) {
        return;
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => {
        timedOutIdle = true;
        controller.abort();
      }, idleTimeoutMs);
    };

    let hostedToolRuns = 0;
    const countedExecute: ClaudeCodeToolExecutor | undefined = executeTool
      ? async (session, call, context) => {
          hostedToolRuns += 1;
          activeHostedTools += 1;
          suspendIdleTimer();
          try {
            return await executeTool(session, call, context);
          } finally {
            activeHostedTools -= 1;
            resetIdleTimer();
          }
        }
      : undefined;
    const markIfSideEffects = <T>(error: T): T => (hostedToolRuns > 0 ? markHostedToolSideEffects(error) : error);
    // The abort signal riding into every hosted tool call is the provider's
    // own controller — the union of the caller's cancellation and the idle
    // timeout — so hosted work never outlives the query around it: a
    // cancelled or stalled turn stops local commands and delegated runs
    // too, and an approval granted after the abort can no longer execute.
    const bridgedTools = countedExecute && request.tools && request.tools.length > 0
      ? bridgeKernelTools(request.tools, request.session, countedExecute, { signal: controller.signal })
      : undefined;

    const options: Options = {
      model,
      systemPrompt: createSystemPrompt(request, systemPrompt),
      // No built-in Claude Code tools: Stratus owns the tool surface.
      tools: [],
      maxTurns: maxTurns ?? (bridgedTools ? DEFAULT_TOOL_MAX_TURNS : 1),
      ...(bridgedTools
        ? {
            mcpServers: {
              [MCP_SERVER_NAME]: createSdkMcpServer({
                name: MCP_SERVER_NAME,
                version: '1.0.0',
                instructions: 'Tools provided by the Stratus Agent runtime. Use them when they help; results return as JSON.',
                tools: bridgedTools,
              }),
            },
            allowedTools: bridgedTools.map((tool) => `mcp__${MCP_SERVER_NAME}__${tool.name}`),
          }
        : {}),
      // Aborting the turn must stop the SDK query itself, not just our
      // iteration over it — the kernel contract is that cancelled work
      // ends. The same controller also carries the idle-timeout abort.
      abortController: controller,
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
      resetIdleTimer();
      for await (const message of queryFn({ prompt: createPrompt(request), options })) {
        resetIdleTimer();
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
      if (timedOutIdle && !request.signal?.aborted) {
        throw markIfSideEffects(
          new Error(`Claude Code produced no output for ${idleTimeoutMs}ms; the run was aborted as stalled.`),
        );
      }
      throw markIfSideEffects(error);
    } finally {
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
    }

    if (resultText === undefined || resultText.length === 0) {
      throw markIfSideEffects(new Error('Claude Code returned an empty response.'));
    }

    return { parts: [{ type: 'text' as const, text: resultText }] };
  },
});
