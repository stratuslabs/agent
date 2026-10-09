import { createHash, randomUUID } from 'node:crypto';

import {
  createSdkMcpServer,
  query as sdkQuery,
  tool as sdkTool,
  type Options,
  type SDKUserMessage,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  DEFAULT_MAX_TURNS,
  markPromptDelivered,
  isUnaddressedTurn,
  TURN_LIMIT_NOTE,
  omitImage,
  renderSystemPromptSections,
  droppedImageNote,
  renderToolResultContent,
  type JsonObject,
  type ModelProvider,
  type ProviderRequest,
  type Session,
  type ToolDescriptor,
  type ExecutionContext,
  type ImageAttachment,
} from '@stratusagent/core';
import {
  bridgedToolNames,
  hasHostedToolSideEffects,
  latestUserMessagePrompt,
  promptImagesOf,
  markHostedToolSideEffects,
  renderTranscriptPrompt,
  type HostedToolExecutor,
} from '@stratusagent/providers';

// These helpers are shared with every provider that wraps a harness owning
// its own loop, and they moved to `@stratusagent/providers` when a second
// one appeared. Re-exported here because this is where they used to live,
// and the documented import paths keep working.
export { bridgedToolNames, hasHostedToolSideEffects, markHostedToolSideEffects };

export const DEFAULT_CLAUDE_CODE_MODEL = 'claude-opus-5-5';


const MCP_SERVER_NAME = 'stratus';

/**
 * Executes one kernel tool call on behalf of the Claude Code loop. The
 * host owns approvals, events, allowlists, and the executor —
 * AgentRunner.executeHostedToolCall is the canonical implementation.
 */
export type ClaudeCodeToolExecutor = HostedToolExecutor;

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

  const wireNames = bridgedToolNames(descriptors);
  return descriptors.map((descriptor) => {
    // The map is built from these same descriptors, so the lookup always hits.
    const name = wireNames.get(descriptor.name) ?? descriptor.name;
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
              text: renderToolResultContent(result),
            },
            // What the call showed, as MCP carries an image: the harness
            // hands it to the model as that tool's output.
            // An image the replay budget already let go of is a note, never
            // an empty image block.
            ...(result.images ?? []).map((image) => (image.omitted === true || image.data.length === 0
              ? { type: 'text' as const, text: droppedImageNote(image) }
              : { type: 'image' as const, data: image.data, mimeType: image.mediaType })),
          ],
          ...(result.ok ? {} : { isError: true }),
        };
      },
    );
  });
};

/**
 * One model's token totals for a `query()` call, as the SDK's `ModelUsage`
 * reports them. The three input counts are Anthropic's disjoint buckets,
 * summed per model — the same shape `TokenUsage` took from that API — so
 * nothing is normalized on the way through.
 */
export interface ClaudeCodeModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/**
 * The slice of the Agent SDK's message stream this provider consumes.
 * Kept loose so tests can inject a plain async generator.
 */
export interface ClaudeCodeStreamMessage {
  type: string;
  subtype?: string;
  result?: string;
  is_error?: boolean;
  /**
   * On a `result` message: per-model totals for every model call the query
   * pipeline made — the main loop, sub-agents, and internal calls such as
   * compaction. The SDK names this the field to use for token accounting,
   * and it is the only place a harness turn's several calls are visible at
   * all: they never cross the provider interface. Present on an error
   * result too, which is how a failed run's tokens still get reported.
   *
   * Keyed by the model string the pipeline used.
   */
  modelUsage?: Record<string, ClaudeCodeModelUsage>;
  /**
   * The SDK's own session id, carried on every message it emits — the
   * init system message, each assistant message, the result. Reading it
   * needs no handshake; the first message that arrives has it.
   */
  session_id?: string;
  /**
   * On a `stream_event` message, the raw Anthropic stream event the SDK
   * saw. Same shape the Messages API emits, so it maps to kernel deltas
   * the same way the API provider maps its own — deliberately typed
   * loosely here rather than re-exporting the SDK's beta types.
   */
  event?: {
    type?: string;
    index?: number;
    delta?: { type?: string; text?: string; partial_json?: string };
    content_block?: { type?: string; name?: string };
  };
}

export type ClaudeCodeQueryFn = (params: {
  /** A string, or — when the message carries images — one user message with its image blocks. */
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => AsyncIterable<ClaudeCodeStreamMessage>;

/**
 * The prompt for one run: the rendered text, and beside it the newest
 * message's images as image blocks.
 *
 * The Agent SDK takes images only through its message-stream input, never
 * in a prompt string, so this runtime used to be told an image was attached
 * and that it could not see it — an agent on a Claude subscription was
 * shown a screenshot's name and nothing else. A message with no image keeps
 * the plain string, exactly as before: the stream input is only for what a
 * string cannot carry. The SDK holds its input open until the first result
 * while in-process MCP tools are attached, so a stream of one message still
 * runs the whole tool loop.
 */
const runPrompt = (text: string, images: readonly ImageAttachment[]): string | AsyncIterable<SDKUserMessage> => {
  if (images.length === 0) {
    return text;
  }
  const message: SDKUserMessage = {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        // A screenshot sent with no words leaves the text empty, and the API
        // refuses an empty text block — the direct provider omits it too.
        ...(text.length > 0 ? [{ type: 'text' as const, text }] : []),
        ...images.map((image) => ({
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: image.mediaType, data: image.data },
        })),
      ],
    },
  };
  return (async function* () {
    yield message;
  })();
};

/**
 * Whether a failed run is the API refusing an image this turn sent. The
 * SDK passes the API's error text through, and the API names the refused
 * block's address — `messages.0.content.1.image.source.base64.data: Could
 * not process image` — the same wording provider-anthropic reads.
 */
const refusedImage = (error: unknown): boolean =>
  /content\.\d+\.image\b|could not process image/i.test(error instanceof Error ? error.message : String(error));

export interface ClaudeCodeProviderConfig {
  /**
   * Called when a stored SDK session could not be resumed and the turn is
   * about to replay the kernel's history into a fresh one instead. The
   * conversation continues either way; this exists so a host can say so
   * rather than leave a silently more expensive turn unexplained.
   */
  onResumeFailed?: (error: unknown) => void;
  /**
   * Claude Code setup token (`claude setup-token`) minted from a Pro/Max
   * subscription. Omit to use the machine's existing Claude Code sign-in.
   */
  authToken?: string;
  /**
   * Who `authToken` belongs to when it is not the machine's shared
   * sign-in: an agent id. Named in an authentication failure so the error
   * points at that agent's entry rather than at `claude /login`, which
   * would change nothing. Never a secret, and never used to pick a token.
   */
  authOwner?: string;
  /** Defaults to claude-opus-5-5. */
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

// One shared reading of what an agent is told about itself — persona,
// memory, skills — rendered by the kernel rather than per provider package.
// This runtime always sends a system prompt, so an agent with no
// instructions gets the shared default persona line.
const createSystemPrompt = (
  request: ProviderRequest,
  systemPrompt: string | undefined,
): string =>
  renderSystemPromptSections(request, {
    ...(systemPrompt ? { preamble: systemPrompt } : {}),
    fallbackPersona: true,
  }).join('\n\n');

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
/**
 * Where a session records the SDK session it is continuing.
 *
 * The pairing is the whole point of resuming: the kernel's session id is
 * ours and durable, the SDK's is its own and lives beside its transcript
 * under `~/.claude/projects`. Storing the link in session metadata means
 * it survives tool execution, approval waits, and a daemon restart, and
 * is garbage-collected with the session — the same treatment the
 * Anthropic provider gives its raw turns, for the same reasons.
 */
export const SDK_SESSION_METADATA_KEY = 'claudeCodeSessionId';

/**
 * Which sign-in the stored SDK session was made under, as a fingerprint.
 *
 * An SDK session is resumed only under the sign-in that made it. Two
 * agents can run on two subscriptions in one daemon, and a token can be
 * replaced or removed while a conversation is open; resuming across that
 * change would carry one account's harness session into another's. A
 * mismatch starts a fresh SDK session and replays the kernel's history
 * into it, the same recovery a lost transcript gets.
 *
 * A one-way hash, truncated, with a fixed prefix, so the session store
 * never holds anything a token could be recovered from. A session stored
 * before this key existed has none. On the shared sign-in it resumes as it
 * always did, because the upgrade itself must not cost every open
 * conversation a replay. Under an agent's own sign-in it does not: nothing
 * says which account made it, and that agent's sign-in is the one case
 * where it matters.
 */
export const SDK_SESSION_AUTH_METADATA_KEY = 'claudeCodeAuth';

const authFingerprintOf = (authToken: string | undefined): string => (authToken
  ? `token:${createHash('sha256').update(`stratus-claude-code-auth\0${authToken}`).digest('hex').slice(0, 16)}`
  : 'machine');

const readSdkSessionId = (
  session: ProviderRequest['session'],
  fingerprint: string,
  ownSignIn: boolean,
): string | undefined => {
  const stored = session.metadata?.[SDK_SESSION_METADATA_KEY];
  if (typeof stored !== 'string' || stored.length === 0) {
    return undefined;
  }
  const madeUnder = session.metadata?.[SDK_SESSION_AUTH_METADATA_KEY];
  return madeUnder === fingerprint || (madeUnder === undefined && !ownSignIn) ? stored : undefined;
};

const rememberSdkSessionId = (session: ProviderRequest['session'], id: string, fingerprint: string): void => {
  const metadata = (session.metadata ??= {});
  metadata[SDK_SESSION_METADATA_KEY] = id;
  metadata[SDK_SESSION_AUTH_METADATA_KEY] = fingerprint;
};

/**
 * Whether a failed run is Claude refusing the sign-in. The Agent SDK passes
 * the CLI's text through, which says so in a handful of ways: an HTTP 401,
 * `authentication_error`, an invalid or expired OAuth token, or the CLI's
 * own advice to run `/login`.
 */
const isAuthFailure = (error: unknown): boolean =>
  /\b401\b|authentication_error|invalid api key|invalid bearer|oauth token|unauthori[sz]ed|\/login\b/i
    .test(error instanceof Error ? error.message : String(error));

// The transcript-per-prompt rendering is shared with every harness provider:
// `renderTranscriptPrompt` for a fresh SDK session, `latestUserMessagePrompt`
// for a resumed one.

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
/**
 * One SDK message, short of the final `result`, as kernel deltas.
 *
 * A `stream_event` is the provider's own stream event forwarded, so it gets
 * the same mapping the API provider performs on the same shapes — kept here
 * rather than shared because the two consume different transports to reach
 * it, and a shared helper would have to be generic over both.
 *
 * Everything else the SDK yields still becomes a delta, a content-free one,
 * because every one of them is the harness reporting that it is working.
 * This used to forward only text, thinking text, and tool input, while this
 * provider's own idle timer counted every message — so the gateway's
 * watchdog, which sees nothing but deltas, aborted turns this provider knew
 * were healthy. Three phases stream none of those fragments: a long think on
 * a model whose thinking display defaults to omitted (the SDK reports it as
 * `thinking_tokens`, not as `thinking_delta`), the SDK waiting out an API
 * retry (`api_retry`), and an automatic compaction (`status`). Slack agents
 * on a subscription failed with `Run aborted: no activity for 120000ms`
 * after their tools had all completed — the watchdog re-arms there — and
 * any of the three would do that while the SDK was still reporting in.
 */
const forwardDelta = async (
  message: ClaudeCodeStreamMessage,
  onDelta: ProviderRequest['onDelta'],
  toolNamesByIndex: Map<number, string>,
  kernelNameFor: (wireName: string) => string,
): Promise<void> => {
  if (!onDelta) {
    return;
  }
  const event = message.event;
  if (message.type !== 'stream_event' || !event) {
    await onDelta(message.type === 'system' && message.subtype === 'thinking_tokens'
      ? { type: 'thinking' }
      : { type: 'progress' });
    return;
  }
  if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
    const toolName = kernelNameFor(event.content_block.name ?? '');
    if (typeof event.index === 'number') {
      toolNamesByIndex.set(event.index, toolName);
    }
    await onDelta({ type: 'tool-call', toolName });
    return;
  }
  if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
    await onDelta({ type: 'text', text: event.delta.text });
    return;
  }
  if (
    (event.type === 'content_block_delta'
      && (event.delta?.type === 'thinking_delta' || event.delta?.type === 'signature_delta'))
    || (event.type === 'content_block_start' && event.content_block?.type === 'thinking')
  ) {
    // Content-free on purpose: a watchdog needs to see a long thinking
    // stretch as progress, and the reasoning itself is never carried.
    await onDelta({ type: 'thinking' });
    return;
  }
  if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta' && typeof event.delta.partial_json === 'string') {
    const toolName = typeof event.index === 'number' ? toolNamesByIndex.get(event.index) : undefined;
    if (toolName !== undefined) {
      await onDelta({ type: 'tool-call', toolName, inputFragment: event.delta.partial_json });
      return;
    }
  }
  // A message boundary, a ping, a block closing: no fragment to forward, and
  // still the stream moving.
  await onDelta({ type: 'progress' });
};

/**
 * The SDK's rethrow of the CLI's non-zero exit after the max-turns result.
 * `readMessages` in the Agent SDK puts any error result's text behind the
 * same prefix — an auth failure or an interruption included — so the
 * max-turns text is matched too, and any other error still propagates.
 */
const isMaxTurnsExit = (error: unknown): boolean =>
  error instanceof Error
  && /^Claude Code returned an error result: Reached maximum number of turns\b/.test(error.message);

export const createClaudeCodeProvider = ({
  authToken,
  authOwner,
  model = DEFAULT_CLAUDE_CODE_MODEL,
  name = 'claude-code',
  systemPrompt,
  executeTool,
  maxTurns,
  pathToClaudeCodeExecutable,
  queryFn = sdkQuery as unknown as ClaudeCodeQueryFn,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  onResumeFailed,
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
    // Set for the wrap-up query only, which may not act: a call made there
    // is answered with a refusal and nothing runs — the same shape codex
    // gives a call past its budget.
    let refuseTools = false;
    const countedExecute: ClaudeCodeToolExecutor | undefined = executeTool
      ? async (session, call, context) => {
          if (refuseTools) {
            return {
              callId: call.id,
              toolName: call.toolName,
              ok: false,
              output: null,
              error: 'No steps are left on this message, so nothing was run. Answer with what you have.',
            };
          }
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
    // Whether the SDK has yielded anything at all: from the first message
    // on, the harness has this turn's prompt in its own history, and a
    // failure after that must say so (`markPromptDelivered`) or the kernel
    // will send the prompt again on the next resume.
    let delivered = false;
    const markIfDelivered = <T>(error: T): T => (delivered ? markPromptDelivered(error) : error);
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
      maxTurns: maxTurns ?? (bridgedTools ? DEFAULT_MAX_TURNS : 1),
      // Only when someone is listening: partial messages are pure overhead
      // for a caller that discards them, and the kernel only supplies a
      // sink when a consumer wants deltas.
      ...(request.onDelta ? { includePartialMessages: true } : {}),
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
    // The SDK session a run that used up its turns belongs to, so the
    // wrap-up can resume it; see TURN_LIMIT_NOTE in core.
    let outOfTurns: string | undefined;
    // Whether the SDK reported the turn finished: a stream that closes
    // without a `result` is a run that did not complete, whatever it
    // yielded on the way, and is never silence.
    let completed = false;
    // Tool input arrives as JSON fragments after the block's start event,
    // so the name has to be remembered from the start to label them.
    const toolNamesByIndex = new Map<number, string>();
    // Deltas name tools the way the SDK sees them; consumers are the
    // kernel's, so they are translated back. The SDK prefixes an MCP tool
    // with its server, and a bare name still resolves for anything that
    // does not.
    const wireToKernel = new Map<string, string>();
    for (const [kernelName, wireName] of bridgedToolNames(request.tools ?? [])) {
      wireToKernel.set(wireName, kernelName);
      wireToKernel.set(`mcp__${MCP_SERVER_NAME}__${wireName}`, kernelName);
    }
    const kernelNameFor = (wireName: string): string => wireToKernel.get(wireName) ?? wireName;

    /**
     * Report one attempt's per-model totals through the request's usage
     * sink, one call per model.
     *
     * Per model rather than summed, because a harness turn routinely spends
     * against several — a sub-agent on a cheaper one, a compaction pass on
     * another — and a thousand tokens of one model is not a thousand of
     * another. The key is the model string the pipeline actually used; the
     * SDK's `canonicalModel` is its own pricing normalization, and pricing
     * is deliberately not this layer's business.
     *
     * An all-zero entry is dropped. The SDK zeroes `modelUsage` on a
     * crash-or-startup-error result, and a model that truly consumed nothing
     * never ran — so a zeroed row is a placeholder rather than a
     * measurement, and recording it would state a cost of zero for a call
     * nobody can see.
     */
    const reportUsage = (byModel: Record<string, ClaudeCodeModelUsage> | undefined): void => {
      const onUsage = request.onUsage;
      if (!onUsage || !byModel) {
        return;
      }
      for (const [reportedModel, usage] of Object.entries(byModel)) {
        const counts = {
          ...(typeof usage.inputTokens === 'number' ? { inputTokens: usage.inputTokens } : {}),
          ...(typeof usage.outputTokens === 'number' ? { outputTokens: usage.outputTokens } : {}),
          ...(typeof usage.cacheReadInputTokens === 'number' ? { cacheReadTokens: usage.cacheReadInputTokens } : {}),
          ...(typeof usage.cacheCreationInputTokens === 'number'
            ? { cacheWriteTokens: usage.cacheCreationInputTokens }
            : {}),
        };
        const values = Object.values(counts);
        if (values.length === 0 || values.every((value) => value === 0)) {
          continue;
        }
        onUsage({
          provider: name,
          ...(reportedModel.length > 0 ? { model: reportedModel } : {}),
          ...counts,
        });
      }
    };

    // Resume the SDK's own session when this conversation already has one.
    // The alternative — replaying a flattened transcript every turn — re-
    // sends the whole history on each request and leaves the SDK no way to
    // carry state of its own between turns.
    const fingerprint = authFingerprintOf(authToken);
    const resumeId = readSdkSessionId(request.session, fingerprint, authOwner !== undefined);
    const attempt = async (resume: string | undefined): Promise<void> => {
      const attemptOptions: Options = { ...options, ...(resume ? { resume } : {}) };
      resetIdleTimer();
      // The LATEST result's totals, not a sum across results: the SDK
      // documents `modelUsage` as the running total for the query() call, so
      // adding two results together would double-count the first.
      let attemptUsage: Record<string, ClaudeCodeModelUsage> | undefined;
      // Set when this attempt ran out of turns with a session to wrap up.
      let ranOutOfTurns = false;
      try {
        for await (const message of queryFn({
          prompt: runPrompt(
            resume
              ? latestUserMessagePrompt(request, { inlineImages: true })
              : renderTranscriptPrompt(request, { inlineImages: true }),
            promptImagesOf(request),
          ),
          options: attemptOptions,
        })) {
          resetIdleTimer();
          delivered = true;
          // Every message carries it, so the id is captured whether the turn
          // succeeds or not — a session that fails mid-turn is still the
          // session the next turn should continue.
          if (message.session_id) {
            rememberSdkSessionId(request.session, message.session_id, fingerprint);
          }
          if (message.type !== 'result') {
            // AWAIT the sink per fragment, the same backpressure the API
            // provider gives it: a throttled consumer pauses this loop
            // rather than queueing the rest of the turn behind itself.
            //
            // With the clock stopped, because that pause is the consumer's
            // time and not the SDK's silence. Counting it as idleness would
            // abort a healthy query for honouring the contract this await
            // exists to keep — the same distinction the gateway watchdog
            // draws when it excludes subscriber time.
            suspendIdleTimer();
            try {
              await forwardDelta(message, request.onDelta, toolNamesByIndex, kernelNameFor);
            } finally {
              resetIdleTimer();
            }
            continue;
          }
          // Captured before the failure branch below: an error result carries
          // the tokens the run spent before it broke, and those were spent.
          if (message.modelUsage) {
            attemptUsage = message.modelUsage;
          }
          if (message.subtype === 'success' && !message.is_error) {
            completed = true;
            resultText = message.result;
            continue;
          }
          // Out of turns is where a long task checks in, not a failure —
          // when there is a session to resume for the summary. Without one
          // there is nothing to wrap up, and it fails as before.
          if (message.subtype === 'error_max_turns' && message.session_id && !refuseTools) {
            outOfTurns = message.session_id;
            ranOutOfTurns = true;
            continue;
          }
          throw new Error(
            `Claude Code run failed (${message.subtype ?? 'unknown error'})${message.result ? `: ${message.result}` : ''}`,
          );
        }
      } catch (error) {
        // The SDK does not stop at the out-of-turns result: the CLI then
        // exits non-zero, and the SDK raises that exit as "Claude Code
        // returned an error result: Reached maximum number of turns (40)".
        // That reached Slack verbatim as "Something went wrong", in place
        // of the wrap-up the result above already asked for. The result is
        // the answer; the exit after it is the same event again. An abort
        // still fails, because a cancelled turn must not start a wrap-up.
        // Only that exit: any other failure after the result, such as a
        // consumer rejecting a late delta, is still a failure.
        if (ranOutOfTurns && !controller.signal.aborted && isMaxTurnsExit(error)) {
          return;
        }
        throw error;
      } finally {
        // In a finally so a thrown attempt still reports: the SDK put the
        // counts on the error result, and a failed harness turn that
        // reported nothing would leave the run unreconcilable against
        // Anthropic's own numbers — the only external check this has.
        reportUsage(attemptUsage);
      }
    };

    const wrapUp = async (sdkSessionId: string): Promise<void> => {
      refuseTools = true;
      let attemptUsage: Record<string, ClaudeCodeModelUsage> | undefined;
      resetIdleTimer();
      try {
        for await (const message of queryFn({
          prompt: TURN_LIMIT_NOTE,
          options: { ...options, resume: sdkSessionId, maxTurns: 1 },
        })) {
          resetIdleTimer();
          if (message.type !== 'result') {
            suspendIdleTimer();
            try {
              await forwardDelta(message, request.onDelta, toolNamesByIndex, kernelNameFor);
            } finally {
              resetIdleTimer();
            }
            continue;
          }
          if (message.modelUsage) {
            attemptUsage = message.modelUsage;
          }
          if (message.subtype === 'success' && !message.is_error) {
            completed = true;
            resultText = message.result;
            continue;
          }
          throw new Error(
            `Claude Code used all ${options.maxTurns ?? DEFAULT_MAX_TURNS} turns this message allows and could not summarize its progress (${message.subtype ?? 'unknown error'}). `
            + 'Raise maxTurns in ~/.stratus/config.json for agents that do long multi-step work, or reply to carry on from here.',
          );
        }
      } finally {
        reportUsage(attemptUsage);
      }
    };

    // The images this turn sends beside its prompt, held so a refusal can
    // drop exactly these. Emptied once they are dropped, so a second
    // refusal is not mistaken for theirs.
    let sentImages = promptImagesOf(request);
    const dropRefusedImages = (error: unknown): boolean => {
      if (sentImages.length === 0 || hostedToolRuns > 0 || controller.signal.aborted || !refusedImage(error)) {
        return false;
      }
      sentImages.forEach(omitImage);
      sentImages = [];
      return true;
    };
    const freshAttempt = async (): Promise<void> => {
      // The abandoned attempt may already have streamed fragments, and
      // the replay is a different answer to the same question — without
      // a reset an aggregator concatenates the two into one garbled
      // reply. This is precisely what reset is for: a partial attempt
      // the provider gave up on.
      //
      // Clock stopped around it for the same reason every other awaited
      // sink is: it is the consumer's time, and billing it to the SDK
      // would turn a recoverable failure into an idle timeout before the
      // replacement attempt even starts.
      suspendIdleTimer();
      try {
        await request.onDelta?.({ type: 'reset', reason: 'retry' });
      } finally {
        resetIdleTimer();
      }
      toolNamesByIndex.clear();
      try {
        await attempt(undefined);
      } catch (error) {
        if (!dropRefusedImages(error)) {
          throw error;
        }
        await freshAttempt();
      }
    };

    try {
      try {
        await attempt(resumeId);
      } catch (error) {
        // An image the API could not process. The channel checked its
        // header and trailer, but that is not a decode. It is emptied on
        // the session itself — stored already, and left alone it would
        // fail every later turn the same way — and the turn goes on with
        // a note in its place, the recovery provider-anthropic makes.
        // Fresh rather than resumed: the SDK wrote the refused message into
        // its own session before calling the API, so resuming would send
        // the image again.
        if (dropRefusedImages(error)) {
          await freshAttempt();
        } else {
          // A stored id the SDK no longer has — the transcript was cleared,
          // or the session was made on another machine — must not strand the
          // conversation. Start a fresh SDK session and replay the kernel's
          // history into it, which is what this provider did before resume
          // existed and is still correct, just costlier.
          //
          // Only when nothing has run yet. Once a hosted tool has executed,
          // its side effects are real and already recorded, so replaying the
          // turn would do them twice — the same rule the fallback provider
          // follows, for the same reason.
          if (resumeId === undefined || hostedToolRuns > 0 || controller.signal.aborted) {
            throw error;
          }
          onResumeFailed?.(error);
          await freshAttempt();
        }
      }
      if (outOfTurns !== undefined && resultText === undefined) {
        await wrapUp(outOfTurns);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(
          'Claude Code could not be started. Install it (npm install -g @anthropic-ai/claude-code) and sign in with `claude`, or use an Anthropic API key instead.',
        );
      }
      if (timedOutIdle && !request.signal?.aborted) {
        throw markIfDelivered(markIfSideEffects(
          new Error(`Claude Code produced no output for ${idleTimeoutMs}ms; the run was aborted as stalled.`),
        ));
      }
      if (authOwner !== undefined && !controller.signal.aborted && isAuthFailure(error)) {
        throw markIfDelivered(markIfSideEffects(new Error(
          `Claude refused ${authOwner}'s own sign-in (${error instanceof Error ? error.message : String(error)}). `
          + `The run was not moved onto the shared sign-in. Store a fresh setup token with \`stratus signin set anthropic --agent ${authOwner}\`, `
          + `or remove it with \`stratus signin remove anthropic --agent ${authOwner}\` to use the shared one.`,
          { cause: error },
        )));
      }
      throw markIfDelivered(markIfSideEffects(error));
    } finally {
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
    }

    if (resultText === undefined || resultText.length === 0) {
      // Silence is the answer a turn nobody asked for may give — see
      // `RunInput.addressed` in core — when the SDK said the turn finished
      // with nothing to say. A stream that ended without a result is a run
      // that did not complete, and on any turn is an error.
      if (completed && isUnaddressedTurn(request.session)) {
        return { parts: [] };
      }
      throw markIfDelivered(markIfSideEffects(new Error(
        completed ? 'Claude Code returned an empty response.' : 'Claude Code ended without reporting a result.',
      )));
    }

    return { parts: [{ type: 'text' as const, text: resultText }] };
  },
});
