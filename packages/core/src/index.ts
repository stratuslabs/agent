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
}

export interface AgentDescriptor {
  id: string;
  name: string;
  instructions?: string;
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

export interface ProviderRequest {
  session: Session;
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
  | { type: 'session.completed'; sessionId: string }
  | { type: 'session.failed'; sessionId: string; error: string };

export type EventHandler = (event: StratusEvent) => void | Promise<void>;

export class EventBus {
  private handlers = new Set<EventHandler>();

  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async emit(event: StratusEvent): Promise<void> {
    for (const handler of this.handlers) {
      await handler(event);
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

export interface AgentRunnerOptions {
  provider: ModelProvider;
  tools?: ToolRegistry;
  executor?: Executor;
  approvals?: ApprovalPolicy;
  store?: SessionStore;
  bus?: EventBus;
  plugins?: PluginRegistry;
}

export class AgentRunner {
  readonly bus: EventBus;
  readonly store: SessionStore;
  readonly tools: ToolRegistry;
  readonly executor: Executor;
  readonly approvals: ApprovalPolicy;
  readonly plugins: PluginRegistry;
  private readonly options: AgentRunnerOptions;

  constructor(options: AgentRunnerOptions) {
    this.options = options;
    this.bus = options.bus ?? new EventBus();
    this.store = options.store ?? new InMemorySessionStore();
    this.tools = options.tools ?? new ToolRegistry();
    this.executor = options.executor ?? new DefaultExecutor();
    this.approvals = options.approvals ?? new AllowAllApprovalPolicy();
    this.plugins = options.plugins ?? new PluginRegistry();
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

    let session = await this.store.create(sessionInput);

    await this.bus.emit({ type: 'session.created', sessionId: session.id, agentId: session.agent.id });
    await this.bus.emit({ type: 'session.updated', sessionId: session.id, status: session.status });

    try {
      const response = await this.options.provider.generate({ session });
      await this.bus.emit({ type: 'provider.response', sessionId: session.id, parts: response.parts });

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

        const approved = await this.approvals.approve({ session, call: part.call });
        if (!approved) {
          throw new Error(`Tool call denied: ${part.call.toolName}`);
        }

        const tool = this.tools.get(part.call.toolName);
        if (!tool) {
          throw new Error(`Tool not found: ${part.call.toolName}`);
        }

        await this.bus.emit({ type: 'tool.called', sessionId: session.id, call: part.call });
        const result = await this.executor.execute(part.call, tool, session);
        await this.bus.emit({ type: 'tool.completed', sessionId: session.id, result });

        session.messages.push({
          id: `${session.id}:tool:${result.callId}`,
          role: 'tool',
          name: result.toolName,
          content: JSON.stringify(result),
          createdAt: new Date().toISOString(),
        });

        if (!result.ok) {
          throw new Error(result.error ?? `Tool failed: ${result.toolName}`);
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
}
