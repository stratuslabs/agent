export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

/**
 * `pending_approval` is a turn parked on a human, and it is durable on
 * purpose: it is the index a restarting daemon uses to find the turns it
 * owes an answer. Everything else about the turn is already in the
 * session; this is what makes it findable without reading every row.
 */
export type SessionStatus = 'idle' | 'running' | 'pending_approval' | 'completed' | 'failed';
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  name?: string;
  createdAt: string;
  toolCalls?: ToolCall[];
  toolResult?: ToolResult;
}

export interface AgentDescriptor {
  id: string;
  name: string;
  instructions?: string;
}

export interface AvatarTheme {
  seed: string;
  hue: number;
  palette: string[];
  style: string;
}

/**
 * A full agent identity. An agent is one "person": the same definition —
 * memory, tool access, credentials — applies no matter which channel,
 * thread, or session the agent is talking through.
 */
export interface AgentDefinition extends AgentDescriptor {
  avatar?: AvatarTheme;
  /** Tool names this agent may call. Omitted = every registered tool. */
  tools?: string[];
  /** Credential names this agent may resolve. Omitted = none. */
  credentials?: string[];
}

export class AgentRegistry {
  private agents = new Map<string, AgentDefinition>();

  register(agent: AgentDefinition): AgentDefinition {
    this.agents.set(agent.id, agent);
    return agent;
  }

  get(id: string): AgentDefinition | undefined {
    return this.agents.get(id);
  }

  /**
   * Look up an agent by display name. Names are not required to be unique
   * (ids are), so an ambiguous name throws rather than silently picking one
   * — routing work to the wrong identity would cross memory and access
   * scopes.
   */
  getByName(name: string): AgentDefinition | undefined {
    const matches = this.list().filter((agent) => agent.name === name);
    if (matches.length > 1) {
      throw new Error(
        `Agent name is ambiguous: ${name} (ids: ${matches.map((agent) => agent.id).join(', ')}). Use the id instead.`,
      );
    }
    return matches[0];
  }

  require(id: string): AgentDefinition {
    const agent = this.agents.get(id);
    if (!agent) {
      throw new Error(`Agent not found: ${id}`);
    }
    return agent;
  }

  list(): AgentDefinition[] {
    return [...this.agents.values()];
  }
}

export interface Session {
  id: string;
  /**
   * The full definition, not just the descriptor: an agent's tool allowlist
   * travels with its session, so a runner can enforce it for an agent that
   * was never registered. Typed as a descriptor, this was read through a
   * cast — the type said the allowlist could not be here while the runner
   * depended on it being here.
   */
  agent: AgentDefinition;
  status: SessionStatus;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
  metadata?: JsonObject;
  lastError?: string;
}

export interface ToolCall {
  id: string;
  toolName: string;
  input: JsonObject;
}

export interface ToolResult {
  callId: string;
  toolName: string;
  ok: boolean;
  output: JsonValue;
  error?: string;
}

export type ProviderPart =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; call: ToolCall };

/**
 * A streamed fragment of an in-progress provider response. Text deltas carry
 * output as it is generated; tool-call deltas announce that the model has
 * started emitting a call (input may still be incomplete). A reset delta
 * tells consumers to DISCARD every fragment streamed so far for this
 * response — emitted when a provider abandons a partial attempt (e.g. a
 * fallback wrapper retrying after the primary failed mid-stream), so
 * renderers never fuse two attempts into one message.
 */
export type ProviderDelta =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolName: string; inputFragment?: string }
  /**
   * The model is reasoning: a content-free progress signal so activity
   * watchdogs see a healthy turn during long thinking stretches. The
   * reasoning itself is deliberately never carried here.
   */
  | { type: 'thinking' }
  | { type: 'reset' };

/**
 * How much damage an invocation of this tool could do, coarse on purpose:
 * a policy needs to separate "let it run unattended" from "a human decides"
 * without understanding what any particular tool does.
 *
 * - `safe` — contained: reads, work inside the fleet, and writes the agent
 *   already owns (its own memory).
 * - `gated` — a human should decide when nobody is watching: anything that
 *   acts on the world outside Stratus — the filesystem, the network,
 *   another service — or writes where other people read.
 * - `dangerous` — destructive or hard to undo.
 *
 * Provider spend is deliberately not the line. Every turn spends: a message
 * arriving in Slack causes a provider call nobody approved, so a policy
 * that gated on cost would have to gate the conversation itself. What is
 * worth a human's attention is effects that outlive the turn and reach
 * past Stratus — which is also what containment (later) would isolate.
 *
 * Undeclared is not `safe`. `resolveToolRisk` treats a missing risk as
 * `gated`, so a tool added without thinking about this is held back rather
 * than waved through — the failure mode of forgetting should be a prompt,
 * not an unattended shell command.
 */
export type ToolRisk = 'safe' | 'gated' | 'dangerous';

export const DEFAULT_TOOL_RISK: ToolRisk = 'gated';

/** The declared risk, or the fail-closed default for a tool that omits it. */
export const resolveToolRisk = (tool: Pick<Tool, 'risk'> | undefined): ToolRisk =>
  tool?.risk ?? DEFAULT_TOOL_RISK;

export interface ToolDescriptor {
  name: string;
  description?: string;
  parameters?: JsonObject;
  /** Carried so providers hosting their own loop can see it too. */
  risk?: ToolRisk;
}

/**
 * One remembered fact. Memory is keyed by agent, never by session or
 * channel, so an agent carries the same knowledge everywhere it appears.
 */
export interface MemoryEntry {
  id: string;
  agentId: string;
  content: string;
  createdAt: string;
  metadata?: JsonObject;
}

export interface AgentMemoryStore {
  append(agentId: string, content: string, metadata?: JsonObject): Promise<MemoryEntry>;
  list(agentId: string): Promise<MemoryEntry[]>;
}

export class InMemoryAgentMemoryStore implements AgentMemoryStore {
  private entries = new Map<string, MemoryEntry[]>();
  private counter = 0;

  async append(agentId: string, content: string, metadata?: JsonObject): Promise<MemoryEntry> {
    this.counter += 1;
    const entry: MemoryEntry = {
      id: `${agentId}:memory:${this.counter}`,
      agentId,
      content,
      createdAt: new Date().toISOString(),
      ...(metadata ? { metadata } : {}),
    };
    const existing = this.entries.get(agentId) ?? [];
    existing.push(entry);
    this.entries.set(agentId, existing);
    return entry;
  }

  async list(agentId: string): Promise<MemoryEntry[]> {
    return [...(this.entries.get(agentId) ?? [])];
  }
}

/**
 * Resolves named credentials for an agent. Implementations must enforce the
 * agent's `credentials` allowlist so secrets stay scoped per agent.
 */
export interface CredentialResolver {
  resolve(agent: AgentDefinition, name: string): Promise<string | undefined>;
}

export interface ScopedCredentials {
  get(name: string): Promise<string>;
}

export class EnvCredentialResolver implements CredentialResolver {
  private readonly env: Record<string, string | undefined>;

  // Pass process.env (or any map) explicitly — core stays platform-agnostic.
  constructor(env: Record<string, string | undefined>) {
    this.env = env;
  }

  async resolve(agent: AgentDefinition, name: string): Promise<string | undefined> {
    if (!agent.credentials?.includes(name)) {
      throw new Error(`Agent ${agent.id} is not allowed to access credential: ${name}`);
    }
    return this.env[name];
  }
}

export const scopeCredentials = (
  agent: AgentDefinition,
  resolver: CredentialResolver,
): ScopedCredentials => ({
  async get(name) {
    const value = await resolver.resolve(agent, name);
    if (value === undefined) {
      throw new Error(`Credential not found: ${name}`);
    }
    return value;
  },
});

export interface ProviderRequest {
  session: Session;
  tools?: ToolDescriptor[];
  /** Agent-scoped long-term memory, newest last. */
  memory?: MemoryEntry[];
  /**
   * Streaming sink. Adapters that stream call this per fragment and MUST
   * await the returned promise before the next call (backpressure); the
   * runner drains every pending delta before emitting the final
   * provider.response, so a delta can never arrive after the response.
   * A single-promise generate() cannot stream on its own — this is the
   * provider-to-runner streaming contract. Optional on both sides:
   * non-streaming adapters ignore it.
   */
  onDelta?: (delta: ProviderDelta) => void | Promise<void>;
  /**
   * Abort signal for the turn. Adapters MUST cancel their underlying
   * operation (HTTP request, SDK query) when it fires — racing the promise
   * is not cancellation; the underlying work has to stop.
   */
  signal?: AbortSignal;
}

export interface ProviderResponse {
  parts: ProviderPart[];
}

export interface ModelProvider {
  name: string;
  generate(request: ProviderRequest): Promise<ProviderResponse>;
}

/**
 * Ambient context for one tool execution. The abort signal is the turn's:
 * executors kill in-flight subprocesses on abort, and long-running tools
 * should observe it too.
 */
export interface ExecutionContext {
  signal?: AbortSignal;
}

export interface Tool {
  name: string;
  description?: string;
  /** JSON Schema describing the tool's input, advertised to model providers. */
  parameters?: JsonObject;
  /** See ToolRisk. Omitted means `gated`, never `safe`. */
  risk?: ToolRisk;
  execute(input: JsonObject, session: Session, context?: ExecutionContext): Promise<JsonValue>;
}

export interface Executor {
  execute(call: ToolCall, tool: Tool, session: Session, context?: ExecutionContext): Promise<ToolResult>;
}

export interface ApprovalContext {
  session: Session;
  call: ToolCall;
  /**
   * The resolved tool, and the risk the policy should judge by. A call name
   * alone cannot classify an invocation — the policy would have to guess
   * from a string — so the runner resolves the tool before asking, and a
   * call naming no registered tool never reaches a policy at all.
   */
  tool: Tool;
  risk: ToolRisk;
  /**
   * The turn's abort signal. A policy that waits on a human MUST observe it:
   * an aborted turn rejects the in-flight wait and invalidates its pending
   * request, so a later approval can never execute a tool for a cancelled
   * turn.
   */
  signal?: AbortSignal;
}

export interface ApprovalPolicy {
  approve(context: ApprovalContext): Promise<boolean>;
}

/** Where a parked turn's checkpoint lives in `session.metadata`. */
export const PENDING_APPROVAL_METADATA_KEY = 'pendingApproval';

/**
 * The checkpoint a turn leaves behind while it waits for a human.
 *
 * Its whole job is to record something the transcript cannot: that this
 * call **has not started**. A tool result is saved only after execution, so
 * a call with no result looks identical whether the daemon died waiting for
 * an approver or died halfway through the tool's side effects — and
 * `resume()` rightly treats that ambiguity as "may not have run to
 * completion". Approval happens strictly *before* execution, so a call
 * carrying this record is unambiguous, and the only kind that can safely be
 * re-entered rather than closed as interrupted.
 *
 * Written before the policy is asked and cleared before the tool runs, so
 * the window it covers is exactly the window in which nothing has happened.
 */
export interface PendingApprovalRecord {
  /** The parked call, by id — not by index, which shifts as history grows. */
  callId: string;
  toolName: string;
  /**
   * The calls after it in the same provider response, in order and none of
   * them started. Recovery drains these once the parked one settles, so
   * every `tool_use` in the response still gets its `tool_result`.
   */
  remainingCallIds: string[];
  /**
   * When the request gives up, ISO-8601. Carried across the restart so a
   * deadline is honoured rather than restarted: downtime is not a reason to
   * extend a security decision.
   */
  expiresAt?: string;
  parkedAt: string;
}

/** Reads the checkpoint off a session, if it is parked. */
export const readPendingApproval = (session: Session): PendingApprovalRecord | undefined => {
  const raw = session.metadata?.[PENDING_APPROVAL_METADATA_KEY];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as unknown as PendingApprovalRecord;
  if (typeof record.callId !== 'string' || typeof record.toolName !== 'string') {
    return undefined;
  }
  return {
    callId: record.callId,
    toolName: record.toolName,
    remainingCallIds: Array.isArray(record.remainingCallIds)
      ? record.remainingCallIds.filter((id): id is string => typeof id === 'string')
      : [],
    ...(typeof record.expiresAt === 'string' ? { expiresAt: record.expiresAt } : {}),
    parkedAt: typeof record.parkedAt === 'string' ? record.parkedAt : '',
  };
};

/**
 * What a human decided about one gated call.
 *
 * - `once` — run this call, ask again next time.
 * - `always` — run it and stop asking for this tool in this session.
 * - `deny` — refuse it.
 *
 * `always` is deliberately not "forever": a persistent whitelist is a
 * different, narrower promise (a normalized command scope) and belongs
 * with the shell tool that needs one.
 */
export type ApprovalAnswer = 'once' | 'always' | 'deny';

/**
 * Why an approval request stopped being pending. Only `decided` involved a
 * person; the rest are the request running out of patience, the turn it
 * belonged to disappearing, or nobody ever being asked at all.
 *
 * The distinction is not cosmetic. `decided` is what an audit record means
 * by "somebody refused this", and folding an undelivered request into it
 * would put a denial nobody made on the same footing as one somebody did.
 */
export type ApprovalResolutionReason = 'decided' | 'timeout' | 'cancelled' | 'undeliverable';

export type StratusEvent =
  | { type: 'session.created'; sessionId: string; agentId: string }
  | { type: 'session.updated'; sessionId: string; status: SessionStatus }
  | { type: 'provider.delta'; sessionId: string; delta: ProviderDelta }
  | { type: 'provider.response'; sessionId: string; parts: ProviderPart[] }
  | { type: 'tool.called'; sessionId: string; call: ToolCall }
  | { type: 'tool.completed'; sessionId: string; result: ToolResult }
  | { type: 'tool.denied'; sessionId: string; call: ToolCall }
  /**
   * A gated call is parked, waiting for a human somewhere else. Channels
   * render it (Slack buttons) and resolve it through the gateway; nothing
   * about the request is channel-specific, so the dashboard consumes the
   * same event.
   *
   * `metadata` is the session's, carried because it says where the turn is
   * happening — a channel that renders the request into the conversation it
   * came from needs that without reaching into the store.
   */
  | {
      type: 'tool.approval-requested';
      sessionId: string;
      agentId: string;
      /** Opaque id the decision is quoted back with. */
      requestId: string;
      call: ToolCall;
      risk: ToolRisk;
      metadata?: JsonObject;
      /**
       * When the request gives up and denies itself, ISO-8601. Absent when
       * it never will — a deadline of "now" would be a worse lie than
       * saying nothing.
       */
      expiresAt?: string;
    }
  | {
      type: 'tool.approval-resolved';
      sessionId: string;
      requestId: string;
      answer: ApprovalAnswer;
      reason: ApprovalResolutionReason;
      /** Who decided, when a person did. Channel-native id (a Slack user). */
      actor?: string;
    }
  | { type: 'session.completed'; sessionId: string }
  | { type: 'session.failed'; sessionId: string; error: string };

export type EventHandler = (event: StratusEvent) => void | Promise<void>;

export interface EventBusOptions {
  /** Called when a subscriber throws. Handler errors never interrupt the run. */
  onError?: (error: unknown, event: StratusEvent) => void;
}

export interface SubscribeOptions {
  /**
   * Run this handler before previously registered ones. Emission awaits
   * handlers in order, so a slow consumer delays everyone after it — a
   * liveness observer (an activity watchdog) must sit in front, or the
   * activity it exists to notice reaches it only after the delay it is
   * timing against.
   */
  prepend?: boolean;
}

export class EventBus {
  private handlers: EventHandler[] = [];
  private readonly onError: EventBusOptions['onError'];

  constructor(options: EventBusOptions = {}) {
    this.onError = options.onError;
  }

  subscribe(handler: EventHandler, options: SubscribeOptions = {}): () => void {
    if (options.prepend) {
      this.handlers.unshift(handler);
    } else {
      this.handlers.push(handler);
    }
    return () => {
      const index = this.handlers.indexOf(handler);
      if (index >= 0) {
        this.handlers.splice(index, 1);
      }
    };
  }

  async emit(event: StratusEvent): Promise<void> {
    for (const handler of [...this.handlers]) {
      try {
        await handler(event);
      } catch (error) {
        this.onError?.(error, event);
      }
    }
  }
}

export interface SessionStore {
  create(input: Omit<Session, 'createdAt' | 'updatedAt'>): Promise<Session>;
  get(id: string): Promise<Session | undefined>;
  save(session: Session): Promise<void>;
  /**
   * Session ids in a given state, oldest first. Optional: a store that
   * cannot enumerate simply cannot recover parked turns, and a caller that
   * needs to sweep says so by checking for the method.
   *
   * Ids rather than sessions, deliberately — a sweep over a large store
   * should not deserialize every conversation body to find the few it wants.
   */
  listIdsByStatus?(status: SessionStatus): Promise<string[]>;
}

export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, Session>();

  async create(input: Omit<Session, 'createdAt' | 'updatedAt'>): Promise<Session> {
    const now = new Date().toISOString();
    const session = { ...input, createdAt: now, updatedAt: now };
    this.sessions.set(session.id, session);
    return session;
  }

  async get(id: string): Promise<Session | undefined> {
    return this.sessions.get(id);
  }

  async save(session: Session): Promise<void> {
    this.sessions.set(session.id, { ...session, updatedAt: new Date().toISOString() });
  }

  async listIdsByStatus(status: SessionStatus): Promise<string[]> {
    return [...this.sessions.values()]
      .filter((session) => session.status === status)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .map((session) => session.id);
  }
}

export interface PluginContext {
  bus: EventBus;
  tools: ToolRegistry;
}

export interface Plugin {
  name: string;
  setup(context: PluginContext): Promise<void> | void;
}

export class PluginRegistry {
  private plugins: Plugin[] = [];

  register(plugin: Plugin): void {
    this.plugins.push(plugin);
  }

  async loadAll(context: PluginContext): Promise<void> {
    for (const plugin of this.plugins) {
      await plugin.setup(context);
    }
  }
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  describe(): ToolDescriptor[] {
    return this.list().map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.parameters ? { parameters: tool.parameters } : {}),
      risk: resolveToolRisk(tool),
    }));
  }
}

export class DefaultExecutor implements Executor {
  async execute(call: ToolCall, tool: Tool, session: Session, context?: ExecutionContext): Promise<ToolResult> {
    try {
      const output = await tool.execute(call.input, session, context);
      return { callId: call.id, toolName: call.toolName, ok: true, output };
    } catch (error) {
      return {
        callId: call.id,
        toolName: call.toolName,
        ok: false,
        output: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export class AllowAllApprovalPolicy implements ApprovalPolicy {
  async approve(): Promise<boolean> {
    return true;
  }
}

export interface RunInput {
  sessionId: string;
  /** See Session.agent: the allowlist travels with the run. */
  agent: AgentDefinition;
  userMessage: string;
  metadata?: JsonObject;
  /** Aborting fails the turn cleanly; see RunAbortedError. */
  signal?: AbortSignal;
}

export interface ResumeInput {
  sessionId: string;
  userMessage: string;
  /** Aborting fails the turn cleanly; see RunAbortedError. */
  signal?: AbortSignal;
}

/**
 * Thrown when a run is stopped by its abort signal. The session ends up
 * `failed` with this error's message as `lastError`, so an aborted turn is
 * distinguishable from a genuine failure.
 */
export class RunAbortedError extends Error {
  constructor(message = 'Run aborted') {
    super(message);
    this.name = 'RunAbortedError';
  }
}

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) {
    throw new RunAbortedError();
  }
};

export interface AgentRunnerOptions {
  provider: ModelProvider;
  tools?: ToolRegistry;
  executor?: Executor;
  approvals?: ApprovalPolicy;
  store?: SessionStore;
  bus?: EventBus;
  plugins?: PluginRegistry;
  /** Known agent definitions; enables per-agent tool allowlists. */
  agents?: AgentRegistry;
  /** Agent-scoped long-term memory, injected into every provider request. */
  memory?: AgentMemoryStore;
  /** Maximum provider turns per run before the session fails. */
  maxTurns?: number;
  /**
   * When true, the runner hands providers a delta sink and re-emits their
   * fragments as provider.delta events. Off by default: streaming is
   * additive, and consumers that render only final responses (one-shot CLI
   * runs, tests) keep the simpler non-streaming provider path.
   */
  streaming?: boolean;
}

const DEFAULT_MAX_TURNS = 8;

export class AgentRunner {
  readonly bus: EventBus;
  readonly store: SessionStore;
  readonly tools: ToolRegistry;
  readonly executor: Executor;
  readonly approvals: ApprovalPolicy;
  readonly plugins: PluginRegistry;
  readonly agents: AgentRegistry;
  readonly memory: AgentMemoryStore | undefined;
  readonly maxTurns: number;
  readonly streaming: boolean;
  private readonly options: AgentRunnerOptions;

  constructor(options: AgentRunnerOptions) {
    this.options = options;
    this.bus = options.bus ?? new EventBus();
    this.store = options.store ?? new InMemorySessionStore();
    this.tools = options.tools ?? new ToolRegistry();
    this.executor = options.executor ?? new DefaultExecutor();
    this.approvals = options.approvals ?? new AllowAllApprovalPolicy();
    this.plugins = options.plugins ?? new PluginRegistry();
    this.agents = options.agents ?? new AgentRegistry();
    this.memory = options.memory;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.streaming = options.streaming ?? false;
  }

  async initialize(): Promise<void> {
    await this.plugins.loadAll({ bus: this.bus, tools: this.tools });
  }

  async run(input: RunInput): Promise<Session> {
    const sessionInput: Omit<Session, 'createdAt' | 'updatedAt'> = {
      id: input.sessionId,
      agent: input.agent,
      status: 'running',
      messages: [
        {
          id: `${input.sessionId}:user:1`,
          role: 'user',
          content: input.userMessage,
          createdAt: new Date().toISOString(),
        },
      ],
    };

    if (input.metadata) {
      sessionInput.metadata = input.metadata;
    }

    const session = await this.store.create(sessionInput);

    await this.bus.emit({ type: 'session.created', sessionId: session.id, agentId: session.agent.id });
    await this.bus.emit({ type: 'session.updated', sessionId: session.id, status: session.status });

    return this.executeTurns(session, input.signal);
  }

  async resume(input: ResumeInput): Promise<Session> {
    const session = await this.store.get(input.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${input.sessionId}`);
    }

    // Mid-turn saves make tool calls durable before their results; a
    // daemon killed in between leaves a call with no result, and provider
    // wire formats reject a tool call that is never answered. Close each
    // dangling call with an explicit interrupted result so the durable
    // conversation stays resumable.
    this.reconcileInterruptedToolCalls(session);

    session.status = 'running';
    delete session.lastError;
    session.messages.push({
      id: `${session.id}:user:${session.messages.length + 1}`,
      role: 'user',
      content: input.userMessage,
      createdAt: new Date().toISOString(),
    });

    // The accepted input is durable BEFORE any provider work: a crash
    // mid-turn must not silently lose a message the caller believes was
    // received — restarting with the same session id recovers it.
    await this.store.save(session);
    const stored = await this.store.get(session.id);
    const working = stored ?? session;

    await this.bus.emit({ type: 'session.updated', sessionId: working.id, status: working.status });

    return this.executeTurns(working, input.signal);
  }

  /**
   * Appends a synthetic failed result directly after every tool call that
   * has none — the durable trace of a turn interrupted between the call's
   * save and its result's. The model sees an honest record ("interrupted,
   * never ran to completion") instead of a wire-format violation, and a
   * resume can decide to retry rather than assume the side effect landed.
   */
  private reconcileInterruptedToolCalls(session: Session): void {
    // Matched by OCCURRENCE, not by id alone: providers can reuse ids
    // (the OpenAI-compatible adapter synthesizes tool-call-1 whenever an
    // endpoint omits them), and an earlier answered occurrence must not
    // make a later dangling one look answered. The nth call with an id
    // needs the nth result with that id, in transcript order.
    const resultsAvailable = new Map<string, number>();
    for (const message of session.messages) {
      if (message.role === 'tool' && message.toolResult) {
        const id = message.toolResult.callId;
        resultsAvailable.set(id, (resultsAvailable.get(id) ?? 0) + 1);
      }
    }

    const callsSeen = new Map<string, number>();
    for (let index = 0; index < session.messages.length; index += 1) {
      const message = session.messages[index];
      if (message?.role !== 'assistant' || !message.toolCalls) {
        continue;
      }
      for (const call of message.toolCalls) {
        const occurrence = (callsSeen.get(call.id) ?? 0) + 1;
        callsSeen.set(call.id, occurrence);
        if (occurrence <= (resultsAvailable.get(call.id) ?? 0)) {
          continue;
        }
        resultsAvailable.set(call.id, occurrence);
        const result: ToolResult = {
          callId: call.id,
          toolName: call.toolName,
          ok: false,
          output: null,
          error: 'Tool execution was interrupted before a result was recorded; it may not have run to completion.',
        };
        index += 1;
        session.messages.splice(index, 0, {
          id: `${session.id}:tool:${call.id}`,
          role: 'tool',
          name: call.toolName,
          content: JSON.stringify(result),
          createdAt: new Date().toISOString(),
          toolResult: result,
        });
      }
    }
  }

  /** Tool names this session's agent may use, or undefined for no limit. */
  private allowedToolsFor(session: Session): Set<string> | undefined {
    // The definition handed to run()/resume() travels with the session, so an
    // agent's own allowlist applies even when it was never registered.
    const tools = session.agent.tools ?? this.agents.get(session.agent.id)?.tools;
    return tools ? new Set(tools) : undefined;
  }

  private async executeTurns(
    initialSession: Session,
    signal?: AbortSignal,
    /**
     * Re-enter an interrupted turn at its parked call instead of starting
     * with the provider. The response these calls came from is already in
     * the session — replaying it would duplicate the assistant messages and
     * re-ask the model — so recovery picks up exactly where the wait was.
     */
    resumeFrom?: { pending: ToolCall | undefined; remaining: ToolCall[] },
  ): Promise<Session> {
    let session = initialSession;
    let pendingEntry = resumeFrom;

    try {
      const allowedTools = this.allowedToolsFor(session);
      const tools = this.tools
        .describe()
        .filter((tool) => allowedTools === undefined || allowedTools.has(tool.name));

      for (let turn = 1; ; turn += 1) {
        throwIfAborted(signal);
        if (turn > this.maxTurns) {
          throw new Error(`Session exceeded the maximum of ${this.maxTurns} provider turns.`);
        }

        if (pendingEntry) {
          // The whole recovered queue — the parked call first, then the
          // ones behind it — so the response's every `tool_use` ends up
          // with a `tool_result` before the loop goes back to the provider.
          const recovered = [
            ...(pendingEntry.pending ? [pendingEntry.pending] : []),
            ...pendingEntry.remaining,
          ];
          pendingEntry = undefined;
          await this.runToolCalls(session, recovered, signal);
          continue;
        }

        const memory = this.memory ? await this.memory.list(session.agent.id) : [];

        // Deltas re-emit on the bus through a serial chain that is drained
        // before the final provider.response goes out — a delta arriving
        // after the response would let a late edit overwrite final output.
        let deltaChain: Promise<void> = Promise.resolve();
        const onDelta = (delta: ProviderDelta): Promise<void> => {
          const emission = deltaChain.then(() =>
            this.bus.emit({ type: 'provider.delta', sessionId: session.id, delta }),
          );
          deltaChain = emission;
          return emission;
        };

        const response = await this.options.provider.generate({
          session,
          ...(tools.length > 0 ? { tools } : {}),
          ...(memory.length > 0 ? { memory } : {}),
          ...(this.streaming ? { onDelta } : {}),
          ...(signal ? { signal } : {}),
        });
        throwIfAborted(signal);
        await deltaChain;

        // Record and SAVE the entire response — text and every tool call —
        // before anything else happens with it. Two consumers depend on
        // that order: provider replay state (the Anthropic raw-turn cache)
        // carries the complete response, so a partially persisted call set
        // would replay tool_use blocks that resume-time reconciliation
        // cannot answer; and provider.response subscribers may publish the
        // answer externally (a channel edit) the moment the event fires —
        // an answer a user has seen must already be durable, or a crash
        // resumes with history that contradicts what was delivered.
        const calls: ToolCall[] = [];
        for (const part of response.parts) {
          if (part.type === 'text') {
            session.messages.push({
              id: `${session.id}:assistant:${session.messages.length + 1}`,
              role: 'assistant',
              content: part.text,
              createdAt: new Date().toISOString(),
            });
            continue;
          }
          calls.push(part.call);
          session.messages.push({
            id: `${session.id}:assistant:${session.messages.length + 1}`,
            role: 'assistant',
            content: '',
            createdAt: new Date().toISOString(),
            toolCalls: [part.call],
          });
        }
        const sawToolCall = calls.length > 0;
        await this.store.save(session);
        await this.bus.emit({ type: 'provider.response', sessionId: session.id, parts: response.parts });

        await this.runToolCalls(session, calls, signal);

        if (!sawToolCall) {
          break;
        }
      }

      session.status = 'completed';
      await this.store.save(session);
      const stored = await this.store.get(session.id);
      session = stored ?? session;
      await this.bus.emit({ type: 'session.updated', sessionId: session.id, status: session.status });
      await this.bus.emit({ type: 'session.completed', sessionId: session.id });
      return session;
    } catch (caught) {
      // An abort can surface first from any layer (the provider's cancelled
      // request, an executor, this loop's own checks) — normalize so an
      // aborted turn is always distinguishable from a genuine failure.
      const error = signal?.aborted && !(caught instanceof RunAbortedError)
        ? new RunAbortedError()
        : caught;
      const lastError = error instanceof Error ? error.message : String(error);
      session.status = 'failed';
      session.lastError = lastError;
      await this.store.save(session);
      const stored = await this.store.get(session.id);
      session = stored ?? session;
      await this.bus.emit({ type: 'session.updated', sessionId: session.id, status: session.status });
      await this.bus.emit({ type: 'session.failed', sessionId: session.id, error: lastError });
      throw error;
    }
  }

  /**
   * Finishes a turn that was parked on a human when the process died.
   *
   * This is the one path allowed to re-enter a tool call rather than close
   * it as interrupted, and the checkpoint is what earns that: approval
   * happens strictly before execution, so a call carrying the record
   * provably never started. `resume()`'s reconciliation must not run first
   * — it would answer the parked call with "may not have run to
   * completion" and strand the queue behind it.
   *
   * Returns undefined when the session is not parked, so a caller sweeping
   * the store does not have to pre-filter.
   */
  async recoverPendingApproval(
    sessionId: string,
    options: {
      /**
       * Refuse the parked call without asking — its deadline passed while
       * the process was down. The calls queued behind it were never asked
       * about at all, so they still face the policy normally.
       */
      denyPending?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<Session | undefined> {
    const session = await this.store.get(sessionId);
    if (!session) {
      return undefined;
    }
    const record = readPendingApproval(session);
    if (!record) {
      return undefined;
    }

    // Rebuilt from the transcript by id: the response is already durable,
    // so the calls are already there, and the record says which of them had
    // not run. An id the transcript no longer holds means the record and
    // the history disagree — recovery stops rather than inventing a call.
    const byId = new Map<string, ToolCall>();
    for (const message of session.messages) {
      for (const call of message.toolCalls ?? []) {
        if (!byId.has(call.id)) {
          byId.set(call.id, call);
        }
      }
    }
    const pending = byId.get(record.callId);
    if (!pending) {
      return undefined;
    }
    const remaining = record.remainingCallIds
      .map((id) => byId.get(id))
      .filter((call): call is ToolCall => call !== undefined);

    // The checkpoint comes off before anything runs. It describes a wait
    // that is over either way, and leaving it would let a second sweep
    // recover the same call again.
    await this.checkpointPendingApproval(session, undefined);
    await this.bus.emit({ type: 'session.updated', sessionId: session.id, status: 'running' });

    if (options.denyPending) {
      // Written exactly as executeToolCall would have written a refusal,
      // so a turn denied by an expired deadline is indistinguishable
      // downstream from one denied by a person — and the queue behind it
      // still drains, leaving no `tool_use` without a `tool_result`.
      const result: ToolResult = {
        callId: pending.id,
        toolName: pending.toolName,
        ok: false,
        output: null,
        error: `Tool call denied by approval policy: ${pending.toolName}`,
      };
      await this.bus.emit({ type: 'tool.denied', sessionId: session.id, call: pending });
      session.messages.push({
        id: `${session.id}:tool:${result.callId}`,
        role: 'tool',
        name: result.toolName,
        content: JSON.stringify(result),
        createdAt: new Date().toISOString(),
        toolResult: result,
      });
      await this.store.save(session);
      return this.executeTurns(session, options.signal, { pending: undefined, remaining });
    }

    return this.executeTurns(session, options.signal, { pending, remaining });
  }

  /**
   * Runs a response's tool calls in order, recording each result as it
   * lands. Shared by the normal path and by recovery, so a resumed turn
   * writes exactly what an uninterrupted one would.
   */
  private async runToolCalls(session: Session, calls: ToolCall[], signal?: AbortSignal): Promise<void> {
    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index]!;
      throwIfAborted(signal);
      const result = await this.executeToolCall(session, call, signal, calls.slice(index + 1));

      // The result lands immediately after execution, so side effects
      // are never durable without their record.
      session.messages.push({
        id: `${session.id}:tool:${result.callId}`,
        role: 'tool',
        name: result.toolName,
        content: JSON.stringify(result),
        createdAt: new Date().toISOString(),
        toolResult: result,
      });
      await this.store.save(session);
    }
  }

  /**
   * Executes one tool call with this runner's allowlist, approval policy,
   * events, and executor — for providers that drive their own inner loop
   * (e.g. the Claude Code runtime) but must run Stratus tools exactly as
   * if the kernel loop had called them.
   */
  async executeHostedToolCall(session: Session, call: ToolCall, context?: ExecutionContext): Promise<ToolResult> {
    // Persistence is part of this seam's contract, not a courtesy: a
    // provider-driven loop consumes tool results internally and returns
    // only final text, so without recording here the durable session would
    // omit every hosted tool action — including its side effects. The
    // paired messages match what the kernel loop writes, in the same
    // order: the call is saved before it runs and the result immediately
    // after, so a daemon killed mid-tool never holds a session whose side
    // effects happened without a recorded attempt.
    session.messages.push({
      id: `${session.id}:assistant:${session.messages.length + 1}`,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      toolCalls: [call],
    });
    await this.store.save(session);

    const result = await this.executeToolCall(session, call, context?.signal);

    session.messages.push({
      id: `${session.id}:tool:${result.callId}`,
      role: 'tool',
      name: result.toolName,
      content: JSON.stringify(result),
      createdAt: new Date().toISOString(),
      toolResult: result,
    });
    await this.store.save(session);

    return result;
  }

  /**
   * Marks the turn parked, durably, for the window in which nothing has
   * happened yet — and unmarks it the instant a decision arrives, before
   * the tool runs. A crash inside that window is recoverable exactly; a
   * crash outside it is not, and must stay indistinguishable from any other
   * interrupted call.
   */
  private async checkpointPendingApproval(
    session: Session,
    record: PendingApprovalRecord | undefined,
  ): Promise<void> {
    const metadata = { ...(session.metadata ?? {}) };
    if (record) {
      metadata[PENDING_APPROVAL_METADATA_KEY] = record as unknown as JsonObject;
    } else {
      delete metadata[PENDING_APPROVAL_METADATA_KEY];
    }
    session.metadata = metadata;
    session.status = record ? 'pending_approval' : 'running';
    // Saved, not announced. The durable status exists so a restarting
    // daemon can find this turn; live consumers already get
    // tool.approval-requested and tool.approval-resolved, which say the
    // same thing with the call and the risk attached. Emitting here would
    // add two session.updated events to every gated call and tell nobody
    // anything they were not told better.
    await this.store.save(session);
  }

  private async executeToolCall(
    session: Session,
    call: ToolCall,
    signal?: AbortSignal,
    /**
     * The calls queued behind this one in the same response. Recorded on
     * the checkpoint so a recovering daemon can finish the response rather
     * than leaving its later `tool_use` blocks unanswered.
     */
    remaining: ToolCall[] = [],
  ): Promise<ToolResult> {
    // Every tool call settles with exactly one event — tool.completed
    // (executed or rejected, the result says which) or tool.denied. Event
    // consumers tracking a response's outstanding calls (the gateway's
    // phase-aware watchdog) count on rejected calls settling too.
    const rejected = async (error: string): Promise<ToolResult> => {
      const result: ToolResult = {
        callId: call.id,
        toolName: call.toolName,
        ok: false,
        output: null,
        error,
      };
      await this.bus.emit({ type: 'tool.completed', sessionId: session.id, result });
      return result;
    };

    const allowedTools = this.allowedToolsFor(session);
    if (allowedTools !== undefined && !allowedTools.has(call.toolName)) {
      return rejected(`Tool not permitted for agent ${session.agent.id}: ${call.toolName}`);
    }

    // Resolved before the policy is asked, not after: a policy classifies
    // an invocation by the tool's declared risk, and a call name is not
    // enough to look that up on the policy's side. It also stops an unknown
    // tool from reaching a human — a call naming nothing registered is a
    // model mistake, and prompting someone to approve it is noise.
    const tool = this.tools.get(call.toolName);
    if (!tool) {
      return rejected(`Tool not found: ${call.toolName}`);
    }

    // Only a call that can actually be held for a human is checkpointed:
    // a `safe` one is never asked about, and writing a record for it would
    // add a save to every unattended call to describe a wait that does not
    // happen.
    const risk = resolveToolRisk(tool);
    const parks = risk !== 'safe';
    if (parks) {
      await this.checkpointPendingApproval(session, {
        callId: call.id,
        toolName: call.toolName,
        remainingCallIds: remaining.map((queued) => queued.id),
        parkedAt: new Date().toISOString(),
      });
    }

    let approved: boolean;
    try {
      approved = await this.approvals.approve({
        session,
        call,
        tool,
        risk,
        ...(signal ? { signal } : {}),
      });
    } finally {
      // Cleared before anything executes and on every exit — an abort that
      // throws out of the policy must not leave the session looking parked
      // on a question nobody is waiting for.
      if (parks) {
        await this.checkpointPendingApproval(session, undefined);
      }
    }

    if (!approved) {
      await this.bus.emit({ type: 'tool.denied', sessionId: session.id, call });
      return {
        callId: call.id,
        toolName: call.toolName,
        ok: false,
        output: null,
        error: `Tool call denied by approval policy: ${call.toolName}`,
      };
    }

    throwIfAborted(signal);
    await this.bus.emit({ type: 'tool.called', sessionId: session.id, call });
    const result = await this.executor.execute(call, tool, session, signal ? { signal } : undefined);
    await this.bus.emit({ type: 'tool.completed', sessionId: session.id, result });
    return result;
  }
}
