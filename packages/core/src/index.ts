export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type SessionStatus = 'idle' | 'running' | 'completed' | 'failed';
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
  agent: AgentDescriptor;
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
  | { type: 'reset' };

export interface ToolDescriptor {
  name: string;
  description?: string;
  parameters?: JsonObject;
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
  execute(input: JsonObject, session: Session, context?: ExecutionContext): Promise<JsonValue>;
}

export interface Executor {
  execute(call: ToolCall, tool: Tool, session: Session, context?: ExecutionContext): Promise<ToolResult>;
}

export interface ApprovalContext {
  session: Session;
  call: ToolCall;
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

export type StratusEvent =
  | { type: 'session.created'; sessionId: string; agentId: string }
  | { type: 'session.updated'; sessionId: string; status: SessionStatus }
  | { type: 'provider.delta'; sessionId: string; delta: ProviderDelta }
  | { type: 'provider.response'; sessionId: string; parts: ProviderPart[] }
  | { type: 'tool.called'; sessionId: string; call: ToolCall }
  | { type: 'tool.completed'; sessionId: string; result: ToolResult }
  | { type: 'tool.denied'; sessionId: string; call: ToolCall }
  | { type: 'session.completed'; sessionId: string }
  | { type: 'session.failed'; sessionId: string; error: string };

export type EventHandler = (event: StratusEvent) => void | Promise<void>;

export interface EventBusOptions {
  /** Called when a subscriber throws. Handler errors never interrupt the run. */
  onError?: (error: unknown, event: StratusEvent) => void;
}

export class EventBus {
  private handlers = new Set<EventHandler>();
  private readonly onError: EventBusOptions['onError'];

  constructor(options: EventBusOptions = {}) {
    this.onError = options.onError;
  }

  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async emit(event: StratusEvent): Promise<void> {
    for (const handler of this.handlers) {
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
  agent: AgentDescriptor;
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

  /** Tool names this session's agent may use, or undefined for no limit. */
  private allowedToolsFor(session: Session): Set<string> | undefined {
    // The definition handed to run()/resume() travels with the session, so an
    // agent's own allowlist applies even when it was never registered.
    const sessionAgent = session.agent as AgentDefinition;
    const tools = sessionAgent.tools ?? this.agents.get(session.agent.id)?.tools;
    return tools ? new Set(tools) : undefined;
  }

  private async executeTurns(initialSession: Session, signal?: AbortSignal): Promise<Session> {
    let session = initialSession;

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
        await this.bus.emit({ type: 'provider.response', sessionId: session.id, parts: response.parts });

        let sawToolCall = false;

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

          sawToolCall = true;
          throwIfAborted(signal);
          session.messages.push({
            id: `${session.id}:assistant:${session.messages.length + 1}`,
            role: 'assistant',
            content: '',
            createdAt: new Date().toISOString(),
            toolCalls: [part.call],
          });

          const result = await this.executeToolCall(session, part.call, signal);

          session.messages.push({
            id: `${session.id}:tool:${result.callId}`,
            role: 'tool',
            name: result.toolName,
            content: JSON.stringify(result),
            createdAt: new Date().toISOString(),
            toolResult: result,
          });
        }

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
   * Executes one tool call with this runner's allowlist, approval policy,
   * events, and executor — for providers that drive their own inner loop
   * (e.g. the Claude Code runtime) but must run Stratus tools exactly as
   * if the kernel loop had called them.
   */
  async executeHostedToolCall(session: Session, call: ToolCall, context?: ExecutionContext): Promise<ToolResult> {
    const result = await this.executeToolCall(session, call, context?.signal);

    // Persistence is part of this seam's contract, not a courtesy: a
    // provider-driven loop consumes tool results internally and returns
    // only final text, so without recording here the durable session would
    // omit every hosted tool action — including its side effects. The
    // paired messages match what the kernel loop writes, and the save
    // makes the record survive even if the provider turn later fails.
    session.messages.push({
      id: `${session.id}:assistant:${session.messages.length + 1}`,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      toolCalls: [call],
    });
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

  private async executeToolCall(session: Session, call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    const allowedTools = this.allowedToolsFor(session);
    if (allowedTools !== undefined && !allowedTools.has(call.toolName)) {
      return {
        callId: call.id,
        toolName: call.toolName,
        ok: false,
        output: null,
        error: `Tool not permitted for agent ${session.agent.id}: ${call.toolName}`,
      };
    }

    const approved = await this.approvals.approve({ session, call, ...(signal ? { signal } : {}) });
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

    const tool = this.tools.get(call.toolName);
    if (!tool) {
      return {
        callId: call.id,
        toolName: call.toolName,
        ok: false,
        output: null,
        error: `Tool not found: ${call.toolName}`,
      };
    }

    throwIfAborted(signal);
    await this.bus.emit({ type: 'tool.called', sessionId: session.id, call });
    const result = await this.executor.execute(call, tool, session, signal ? { signal } : undefined);
    await this.bus.emit({ type: 'tool.completed', sessionId: session.id, result });
    return result;
  }
}
