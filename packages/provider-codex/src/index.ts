import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  renderSystemPromptSections,
  type ExecutionContext,
  type JsonObject,
  type JsonValue,
  type ModelProvider,
  type ProviderRequest,
  type Session,
  type ToolDescriptor,
} from '@stratusagent/core';
import {
  bridgedToolNames,
  latestUserMessagePrompt,
  markHostedToolSideEffects,
  renderTranscriptPrompt,
  type HostedToolExecutor,
} from '@stratusagent/providers';

/** The codex CLI's own current default model. */
export const DEFAULT_CODEX_MODEL = 'gpt-5.5';

const MCP_SERVER_NAME = 'stratus';

/**
 * The environment variable the codex subprocess reads the MCP bearer token
 * from (`mcp_servers.stratus.bearer_token_env_var`). The token itself is
 * minted per turn and never appears in configuration or on a command line.
 */
export const MCP_TOKEN_ENV_VAR = 'STRATUS_CODEX_MCP_TOKEN';

/**
 * Executes one kernel tool call on behalf of the Codex loop. The host owns
 * approvals, events, allowlists, and the executor —
 * AgentRunner.executeHostedToolCall is the canonical implementation.
 */
export type CodexToolExecutor = HostedToolExecutor;

const DEFAULT_IDLE_TIMEOUT_MS = 600_000;

// ---------------------------------------------------------------------------
// The kernel-tool MCP endpoint
//
// Codex cannot host an in-process MCP server the way the Claude Agent SDK
// can: it is a separate binary, and its configuration takes MCP servers as
// either a command to spawn or a streamable-HTTP URL. The daemon hosts the
// URL form on loopback, so nothing is spawned and every tool call arrives
// back in-process, where approvals, allowlists, and events already live.
//
// What authenticates the socket: a 256-bit bearer token minted per turn,
// carried to the codex subprocess only through its environment (codex reads
// the variable named by `bearer_token_env_var`). Every request must present
// it, compared in constant time; connections from any non-loopback address
// are refused outright. The server exists only for the duration of the turn
// and serves only that turn's session and tool allowlist, so a leaked URL
// is useless once the turn ends.
// ---------------------------------------------------------------------------

export interface KernelMcpServerOptions {
  descriptors: readonly ToolDescriptor[];
  session: Session;
  executeTool: CodexToolExecutor;
  context?: ExecutionContext;
  instructions?: string;
}

export interface KernelMcpServer {
  /** The streamable-HTTP endpoint, bound to 127.0.0.1 on an ephemeral port. */
  url: string;
  /** The bearer token every request must present. */
  token: string;
  close(): Promise<void>;
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Requests larger than this are refused: tool inputs are small. */
const MAX_MCP_BODY_BYTES = 10 * 1024 * 1024;

const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_MCP_BODY_BYTES) {
        reject(new Error('MCP request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const sendJson = (res: ServerResponse, status: number, body: JsonValue): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

const jsonRpcResult = (id: JsonValue, result: JsonValue): JsonValue => ({
  jsonrpc: '2.0',
  id,
  result,
});

const jsonRpcError = (id: JsonValue, code: number, message: string): JsonValue => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});

const bearerTokenMatches = (header: string | undefined, token: string): boolean => {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    return false;
  }
  const presented = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
};

/**
 * Serves the session's kernel tools over MCP streamable HTTP for the codex
 * subprocess. Exported for tests, which drive it with plain fetch — the
 * same protocol slice codex's client speaks: JSON-RPC over POST, JSON
 * responses, 202 for notifications.
 */
export const startKernelMcpServer = async (
  options: KernelMcpServerOptions,
): Promise<KernelMcpServer> => {
  const token = randomBytes(32).toString('hex');

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

  const wireNames = bridgedToolNames(options.descriptors);
  const byWireName = new Map<string, ToolDescriptor>();
  for (const descriptor of options.descriptors) {
    const wireName = wireNames.get(descriptor.name);
    if (wireName !== undefined) {
      byWireName.set(wireName, descriptor);
    }
  }

  const handleRequest = async (message: {
    id: JsonValue;
    method: string;
    params?: JsonObject;
  }): Promise<JsonValue> => {
    if (message.method === 'initialize') {
      const requested = message.params?.protocolVersion;
      return jsonRpcResult(message.id, {
        // Echo the client's protocol version: the only client this socket
        // admits is the codex subprocess this daemon just configured.
        protocolVersion: typeof requested === 'string' ? requested : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: '1.0.0' },
        ...(options.instructions ? { instructions: options.instructions } : {}),
      });
    }
    if (message.method === 'ping') {
      return jsonRpcResult(message.id, {});
    }
    if (message.method === 'tools/list') {
      return jsonRpcResult(message.id, {
        tools: options.descriptors.map((descriptor) => ({
          name: wireNames.get(descriptor.name) ?? descriptor.name,
          description: descriptor.description ?? `Stratus tool ${descriptor.name}`,
          inputSchema: descriptor.parameters ?? { type: 'object', properties: {} },
        })),
      });
    }
    if (message.method === 'tools/call') {
      const wireName = message.params?.name;
      const descriptor = typeof wireName === 'string' ? byWireName.get(wireName) : undefined;
      if (!descriptor) {
        return jsonRpcError(message.id, -32602, `Unknown tool: ${String(wireName)}`);
      }
      const input = message.params?.arguments;
      try {
        const result = await serialize(() => options.executeTool(options.session, {
          id: `codex:${randomUUID()}`,
          toolName: descriptor.name,
          input: (typeof input === 'object' && input !== null && !Array.isArray(input) ? input : {}) as JsonObject,
        }, options.context));
        return jsonRpcResult(message.id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result.ok ? result.output : { error: result.error ?? 'Tool failed.' }),
            },
          ],
          ...(result.ok ? {} : { isError: true }),
        });
      } catch (error) {
        return jsonRpcError(message.id, -32603, error instanceof Error ? error.message : String(error));
      }
    }
    return jsonRpcError(message.id, -32601, `Method not found: ${message.method}`);
  };

  const server = createServer((req, res) => {
    void (async () => {
      if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? '')) {
        sendJson(res, 403, jsonRpcError(null, -32000, 'Loopback connections only'));
        return;
      }
      if (!bearerTokenMatches(req.headers.authorization, token)) {
        // No WWW-Authenticate header on purpose: the one legitimate client
        // already holds the token, and an OAuth discovery dance is not on
        // offer here.
        sendJson(res, 401, jsonRpcError(null, -32000, 'Unauthorized'));
        return;
      }
      if (req.method !== 'POST') {
        // The client MAY open a GET SSE stream for server-initiated
        // messages; this server never initiates, so it declines, which the
        // protocol allows.
        sendJson(res, 405, jsonRpcError(null, -32000, 'POST only'));
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse((await readBody(req)).toString('utf8'));
      } catch {
        sendJson(res, 400, jsonRpcError(null, -32700, 'Parse error'));
        return;
      }
      if (typeof message !== 'object' || message === null || Array.isArray(message)) {
        sendJson(res, 400, jsonRpcError(null, -32600, 'A single JSON-RPC message is required'));
        return;
      }
      const rpc = message as { id?: JsonValue; method?: string; params?: JsonObject };
      if (typeof rpc.method !== 'string') {
        // A response or malformed frame; nothing to do with it.
        res.writeHead(202).end();
        return;
      }
      if (rpc.id === undefined || rpc.id === null) {
        // Notifications (notifications/initialized, cancellations) are
        // acknowledged and otherwise ignored: tool execution state lives
        // in the kernel, which has its own cancellation.
        res.writeHead(202).end();
        return;
      }
      sendJson(res, 200, await handleRequest({ id: rpc.id, method: rpc.method, ...(rpc.params !== undefined ? { params: rpc.params } : {}) }));
    })().catch(() => {
      if (!res.headersSent) {
        sendJson(res, 500, jsonRpcError(null, -32603, 'Internal error'));
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        // A wedged subprocess must not be able to hold the daemon's
        // shutdown hostage through a kept-alive connection.
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
};

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

/**
 * The slice of the Codex SDK's thread event stream this provider consumes
 * (`codex exec --json` events). Kept loose so tests can inject a plain
 * async generator.
 */
export interface CodexThreadEvent {
  type: string;
  /** On `thread.started`: the codex thread id later turns resume. */
  thread_id?: string;
  /** On `turn.failed`. */
  error?: { message?: string };
  /** On a top-level `error` event. */
  message?: string;
  item?: {
    id?: string;
    type?: string;
    /** agent_message / reasoning text, a snapshot that grows across updates. */
    text?: string;
    /** mcp_tool_call: the server and wire tool name being invoked. */
    server?: string;
    tool?: string;
    status?: string;
  };
}

/** What the provider passes the Codex SDK client for one turn. */
export interface CodexClientOptions {
  /** Config overrides for the codex binary (flattened to `-c key=value`). */
  config: JsonObject;
  /** OpenAI API key for metered billing (CODEX_API_KEY). Absent = ChatGPT sign-in. */
  apiKey?: string;
  /**
   * The full environment for the codex subprocess — the SDK replaces the
   * child environment rather than merging into it.
   */
  env: Record<string, string>;
  codexPathOverride?: string;
}

export interface CodexThreadOptions {
  model: string;
  sandboxMode: 'read-only';
  approvalPolicy: 'never';
  skipGitRepoCheck: true;
}

export interface CodexTurnParams {
  input: string;
  /** Codex thread id to resume; absent starts a fresh thread. */
  resumeThreadId?: string;
  clientOptions: CodexClientOptions;
  threadOptions: CodexThreadOptions;
  signal: AbortSignal;
}

/**
 * Runs one codex turn and yields its thread events. The default
 * implementation wraps `@openai/codex-sdk`; tests (and embedders pinning
 * their own transport) inject a fake.
 */
export type CodexRunTurn = (params: CodexTurnParams) => AsyncIterable<CodexThreadEvent>;

// Typed structurally rather than against the SDK's declarations so the
// package builds without the SDK's types and the seam stays exactly the
// slice this provider consumes.
interface CodexSdkThreadLike {
  runStreamed(input: string, turnOptions?: { signal?: AbortSignal }): Promise<{ events: AsyncIterable<unknown> }>;
}
interface CodexSdkModuleLike {
  Codex: new (options?: Record<string, unknown>) => {
    startThread(options?: Record<string, unknown>): CodexSdkThreadLike;
    resumeThread(id: string, options?: Record<string, unknown>): CodexSdkThreadLike;
  };
}

const runTurnWithSdk: CodexRunTurn = async function* (params) {
  let sdk: CodexSdkModuleLike;
  try {
    sdk = (await import('@openai/codex-sdk')) as unknown as CodexSdkModuleLike;
  } catch (error) {
    throw new Error(
      `The Codex SDK could not be loaded (${error instanceof Error ? error.message : String(error)}). Install @openai/codex-sdk where Stratus runs.`,
    );
  }
  const codex = new sdk.Codex({
    config: params.clientOptions.config,
    env: params.clientOptions.env,
    ...(params.clientOptions.apiKey ? { apiKey: params.clientOptions.apiKey } : {}),
    ...(params.clientOptions.codexPathOverride
      ? { codexPathOverride: params.clientOptions.codexPathOverride }
      : {}),
  });
  const thread = params.resumeThreadId
    ? codex.resumeThread(params.resumeThreadId, params.threadOptions as unknown as Record<string, unknown>)
    : codex.startThread(params.threadOptions as unknown as Record<string, unknown>);
  const { events } = await thread.runStreamed(params.input, { signal: params.signal });
  yield* events as AsyncIterable<CodexThreadEvent>;
};

export interface CodexProviderConfig {
  /**
   * OpenAI API key for metered billing, handed to the harness as
   * CODEX_API_KEY. Omit to use the machine's existing `codex login`
   * (ChatGPT subscription) sign-in.
   */
  apiKey?: string;
  /** Defaults to gpt-5.5. */
  model?: string;
  name?: string;
  /** Extra system prompt, rendered before the agent's own persona. */
  systemPrompt?: string;
  /**
   * Executes kernel tool calls for the Codex loop. When set, the request's
   * tools are served to the subprocess over a loopback MCP endpoint;
   * without it runs stay text-only.
   */
  executeTool?: CodexToolExecutor;
  /** Path to a specific codex executable (the SDK's bundled one otherwise). */
  codexPathOverride?: string;
  /** Test injection point; defaults to the real Codex SDK. */
  runTurn?: CodexRunTurn;
  /**
   * Abort a run when the event stream yields nothing for this long — a
   * wedged subprocess must not pin a turn (and a draining daemon) open
   * forever. Inactivity-based, so a healthy long run that keeps producing
   * events stays alive; suspended while a hosted tool (approval waits
   * included) is executing. 0 disables. Default 10 minutes.
   */
  idleTimeoutMs?: number;
  /**
   * Called when a stored codex thread could not be resumed and the turn is
   * about to replay the kernel's history into a fresh one instead. The
   * conversation continues either way; this exists so a host can say so
   * rather than leave a silently more expensive turn unexplained.
   */
  onResumeFailed?: (error: unknown) => void;
}

/**
 * Where a session records the codex thread it is continuing.
 *
 * The kernel's session id is ours and durable; the thread id is codex's
 * and lives beside its transcript under `~/.codex/sessions`. Storing the
 * link in session metadata means it survives tool execution, approval
 * waits, and a daemon restart, and is garbage-collected with the session —
 * the same treatment the Claude Code provider gives its SDK session id.
 */
export const CODEX_THREAD_METADATA_KEY = 'codexThreadId';

const readThreadId = (session: ProviderRequest['session']): string | undefined => {
  const stored = session.metadata?.[CODEX_THREAD_METADATA_KEY];
  return typeof stored === 'string' && stored.length > 0 ? stored : undefined;
};

const rememberThreadId = (session: ProviderRequest['session'], id: string): void => {
  (session.metadata ??= {})[CODEX_THREAD_METADATA_KEY] = id;
};

// One shared reading of what an agent is told about itself — persona,
// memory, skills — rendered by the kernel rather than per provider package.
// This runtime always sends instructions, so an agent with no persona gets
// the shared default line.
const createInstructions = (
  request: ProviderRequest,
  systemPrompt: string | undefined,
): string =>
  renderSystemPromptSections(request, {
    ...(systemPrompt ? { preamble: systemPrompt } : {}),
    fallbackPersona: true,
  }).join('\n\n');

// Forwards the kernel's abort signal into an AbortController the SDK
// understands, so aborting a turn kills the underlying subprocess.
const linkedAbortController = (signal: AbortSignal): AbortController => {
  const controller = new AbortController();
  if (signal.aborted) {
    controller.abort();
  } else {
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller;
};

/**
 * The environment for the codex subprocess. The SDK *replaces* the child
 * environment with what it is given, so the daemon's own environment is
 * carried (codex needs HOME/CODEX_HOME to find its sign-in) — and the auth
 * posture is pinned on top: without a configured API key this provider is
 * subscription-billed, so an ambient CODEX_API_KEY must never silently
 * turn a run into metered API usage.
 */
const buildSubprocessEnv = (apiKeyConfigured: boolean, mcpToken: string | undefined): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }
  if (!apiKeyConfigured) {
    delete env.CODEX_API_KEY;
  }
  if (mcpToken !== undefined) {
    env[MCP_TOKEN_ENV_VAR] = mcpToken;
  }
  return env;
};

/**
 * Runs turns through the OpenAI Codex harness (`@openai/codex-sdk`), so a
 * ChatGPT subscription covers usage instead of per-token API billing — or
 * an OpenAI API key, when one is configured.
 *
 * The agent's persona and memory render as codex developer instructions,
 * and kernel tools are served to the subprocess over a loopback MCP
 * endpoint when the host supplies `executeTool` — approvals, allowlists,
 * and events all run on the host side, so this runtime is the same agent
 * as every other provider.
 *
 * Stratus stays authoritative over tool execution: codex's own shell (and
 * with it file edits), web search, image reads, and lifecycle hooks are
 * disabled outright, its sandbox is pinned read-only and its approval
 * policy to `never`, so the kernel's registry → approval → executor chain
 * is the only thing that can act. AGENTS.md discovery is disabled for the
 * same reason: repository content is not agent instructions.
 */
export const createCodexProvider = ({
  apiKey,
  model = DEFAULT_CODEX_MODEL,
  name = 'codex',
  systemPrompt,
  executeTool,
  codexPathOverride,
  runTurn = runTurnWithSdk,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  onResumeFailed,
}: CodexProviderConfig = {}): ModelProvider => ({
  name,
  async generate(request: ProviderRequest) {
    const controller = request.signal
      ? linkedAbortController(request.signal)
      : new AbortController();

    // A wedged subprocess yields nothing forever; the idle timer cuts it
    // loose. It resets on every event so healthy long runs stay alive, and
    // it suspends entirely while a hosted tool (approval waits included)
    // is executing — those phases legitimately produce no codex output for
    // as long as they need.
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
    const countedExecute: CodexToolExecutor | undefined = executeTool
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
    // timeout — so hosted work never outlives the subprocess around it.
    const mcp = countedExecute && request.tools && request.tools.length > 0
      ? await startKernelMcpServer({
          descriptors: request.tools,
          session: request.session,
          executeTool: countedExecute,
          context: { signal: controller.signal },
          instructions: 'Tools provided by the Stratus Agent runtime. Use them when they help; results return as JSON.',
        })
      : undefined;

    const instructions = createInstructions(request, systemPrompt);
    const clientOptions: CodexClientOptions = {
      config: {
        // Stratus owns the tool surface. `shell_tool` off removes codex's
        // exec tools entirely (and with them file edits, which ride the
        // shell in current codex); web search, the image reader, the plan
        // and sleep tools, and lifecycle hooks are off for the same
        // reason. The read-only sandbox and `approval_policy = never` in
        // the thread options below are belt and braces, not the gate.
        features: { shell_tool: false, view_image: false, sleep_tool: false, hooks: false },
        web_search: 'disabled',
        tools: { update_plan: { enabled: false } },
        // An AGENTS.md in the daemon's working directory is repository
        // content, not agent instructions.
        project_doc_max_bytes: 0,
        developer_instructions: instructions,
        ...(mcp
          ? {
              mcp_servers: {
                [MCP_SERVER_NAME]: {
                  url: mcp.url,
                  bearer_token_env_var: MCP_TOKEN_ENV_VAR,
                  // A tool endpoint that fails to connect must fail the
                  // run, not silently strip the agent of its tools.
                  required: true,
                },
              },
            }
          : {}),
      },
      env: buildSubprocessEnv(apiKey !== undefined, mcp?.token),
      ...(apiKey ? { apiKey } : {}),
      ...(codexPathOverride ? { codexPathOverride } : {}),
    };
    const threadOptions: CodexThreadOptions = {
      model,
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      skipGitRepoCheck: true,
    };

    // Reply text accumulates across agent messages; deltas stream the
    // growing snapshots as suffixes. Wire tool names are translated back
    // to the kernel's own naming before consumers see them.
    const completedMessages: string[] = [];
    const emittedByItemId = new Map<string, number>();
    const wireToKernel = new Map<string, string>();
    for (const [kernelName, wireName] of bridgedToolNames(request.tools ?? [])) {
      wireToKernel.set(wireName, kernelName);
    }
    const kernelNameFor = (wireName: string): string => wireToKernel.get(wireName) ?? wireName;

    const forwardEvent = async (event: CodexThreadEvent): Promise<void> => {
      if (event.type === 'thread.started' && typeof event.thread_id === 'string' && event.thread_id.length > 0) {
        rememberThreadId(request.session, event.thread_id);
        return;
      }
      if (event.type === 'turn.failed') {
        throw new Error(`Codex run failed${event.error?.message ? `: ${event.error.message}` : ''}`);
      }
      if (event.type === 'error') {
        throw new Error(`Codex run failed${event.message ? `: ${event.message}` : ''}`);
      }
      const item = event.item;
      if (!item || (event.type !== 'item.started' && event.type !== 'item.updated' && event.type !== 'item.completed')) {
        return;
      }
      if (item.type === 'agent_message') {
        const text = typeof item.text === 'string' ? item.text : '';
        if (event.type === 'item.completed') {
          completedMessages.push(text);
        }
        if (request.onDelta && item.id !== undefined) {
          const emitted = emittedByItemId.get(item.id) ?? 0;
          if (text.length > emitted) {
            emittedByItemId.set(item.id, text.length);
            // AWAIT the sink per fragment (backpressure), with the clock
            // stopped: the pause is the consumer's time, not the
            // subprocess's silence.
            suspendIdleTimer();
            try {
              await request.onDelta({ type: 'text', text: text.slice(emitted) });
            } finally {
              resetIdleTimer();
            }
          }
        }
        return;
      }
      if (item.type === 'reasoning' && request.onDelta && event.type !== 'item.completed') {
        // Content-free on purpose: a watchdog needs to see reasoning as
        // progress, and the reasoning itself is never carried.
        suspendIdleTimer();
        try {
          await request.onDelta({ type: 'thinking' });
        } finally {
          resetIdleTimer();
        }
        return;
      }
      if (item.type === 'mcp_tool_call' && request.onDelta && event.type === 'item.started' && typeof item.tool === 'string') {
        suspendIdleTimer();
        try {
          await request.onDelta({ type: 'tool-call', toolName: kernelNameFor(item.tool) });
        } finally {
          resetIdleTimer();
        }
      }
    };

    const attempt = async (resumeThreadId: string | undefined): Promise<void> => {
      resetIdleTimer();
      for await (const event of runTurn({
        input: resumeThreadId ? latestUserMessagePrompt(request) : renderTranscriptPrompt(request),
        ...(resumeThreadId ? { resumeThreadId } : {}),
        clientOptions,
        threadOptions,
        signal: controller.signal,
      })) {
        resetIdleTimer();
        await forwardEvent(event);
      }
    };

    const resumeId = readThreadId(request.session);
    try {
      try {
        await attempt(resumeId);
      } catch (error) {
        // A stored thread id codex no longer has — the sessions directory
        // was cleared, or the thread was made on another machine — must
        // not strand the conversation. Start a fresh thread and replay the
        // kernel's history into it. Only when nothing has run yet: once a
        // hosted tool has executed, its side effects are real and already
        // recorded, so replaying the turn would do them twice.
        if (resumeId === undefined || hostedToolRuns > 0 || controller.signal.aborted) {
          throw error;
        }
        onResumeFailed?.(error);
        // The abandoned attempt may already have streamed fragments, and
        // the replay is a different answer to the same question — without
        // a reset an aggregator concatenates the two into one garbled
        // reply. Clock stopped around it like every other awaited sink.
        suspendIdleTimer();
        try {
          await request.onDelta?.({ type: 'reset', reason: 'retry' });
        } finally {
          resetIdleTimer();
        }
        completedMessages.length = 0;
        emittedByItemId.clear();
        await attempt(undefined);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(
          'Codex could not be started. Install @openai/codex-sdk (it bundles the codex binary) where Stratus runs, and sign in with `codex login` or configure an OpenAI API key.',
        );
      }
      if (timedOutIdle && !request.signal?.aborted) {
        throw markIfSideEffects(
          new Error(`Codex produced no output for ${idleTimeoutMs}ms; the run was aborted as stalled.`),
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      if (/not (?:yet )?logged in|codex login/i.test(message)) {
        throw markIfSideEffects(new Error(
          `Codex is not signed in on this machine. Run \`codex login\`, or add an OpenAI API key with \`stratus setup\`. (${message})`,
        ));
      }
      throw markIfSideEffects(error);
    } finally {
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      await mcp?.close();
    }

    const resultText = completedMessages.filter((text) => text.length > 0).join('\n\n');
    if (resultText.length === 0) {
      throw markIfSideEffects(new Error('Codex returned an empty response.'));
    }

    return { parts: [{ type: 'text' as const, text: resultText }] };
  },
});
