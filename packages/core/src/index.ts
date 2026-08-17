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
}

export interface ProviderResponse {
  parts: ProviderPart[];
}

export interface ModelProvider {
  name: string;
  generate(request: ProviderRequest): Promise<ProviderResponse>;
}

export interface Tool {
  name: string;
  description?: string;
  /** JSON Schema describing the tool's input, advertised to model providers. */
  parameters?: JsonObject;
  execute(input: JsonObject, session: Session): Promise<JsonValue>;
}

export interface Executor {
  execute(call: ToolCall, tool: Tool, session: Session): Promise<ToolResult>;
}

export interface ApprovalContext {
  session: Session;
  call: ToolCall;
}

export interface ApprovalPolicy {
  approve(context: ApprovalContext): Promise<boolean>;
}

export type StratusEvent =
  | { type: 'session.created'; sessionId: string; agentId: string }
  | { type: 'session.updated'; sessionId: string; status: SessionStatus }
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
  async execute(call: ToolCall, tool: Tool, session: Session): Promise<ToolResult> {
    try {
      const output = await tool.execute(call.input, session);
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
}

export interface ResumeInput {
  sessionId: string;
  userMessage: string;
}

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

    return this.executeTurns(session);
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

    await this.bus.emit({ type: 'session.updated', sessionId: session.id, status: session.status });

    return this.executeTurns(session);
  }

  /** Tool names this session's agent may use, or undefined for no limit. */
  private allowedToolsFor(session: Session): Set<string> | undefined {
    // The definition handed to run()/resume() travels with the session, so an
    // agent's own allowlist applies even when it was never registered.
    const sessionAgent = session.agent as AgentDefinition;
    const tools = sessionAgent.tools ?? this.agents.get(session.agent.id)?.tools;
    return tools ? new Set(tools) : undefined;
  }

  private async executeTurns(initialSession: Session): Promise<Session> {
    let session = initialSession;

    try {
      const allowedTools = this.allowedToolsFor(session);
      const tools = this.tools
        .describe()
        .filter((tool) => allowedTools === undefined || allowedTools.has(tool.name));

      for (let turn = 1; ; turn += 1) {
        if (turn > this.maxTurns) {
          throw new Error(`Session exceeded the maximum of ${this.maxTurns} provider turns.`);
        }

        const memory = this.memory ? await this.memory.list(session.agent.id) : [];

        const response = await this.options.provider.generate({
          session,
          ...(tools.length > 0 ? { tools } : {}),
          ...(memory.length > 0 ? { memory } : {}),
        });
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
          session.messages.push({
            id: `${session.id}:assistant:${session.messages.length + 1}`,
            role: 'assistant',
            content: '',
            createdAt: new Date().toISOString(),
            toolCalls: [part.call],
          });

          const result = await this.executeToolCall(session, part.call);

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
    } catch (error) {
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
  async executeHostedToolCall(session: Session, call: ToolCall): Promise<ToolResult> {
    return this.executeToolCall(session, call);
  }

  private async executeToolCall(session: Session, call: ToolCall): Promise<ToolResult> {
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

    const approved = await this.approvals.approve({ session, call });
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

    await this.bus.emit({ type: 'tool.called', sessionId: session.id, call });
    const result = await this.executor.execute(call, tool, session);
    await this.bus.emit({ type: 'tool.completed', sessionId: session.id, result });
    return result;
  }
}
