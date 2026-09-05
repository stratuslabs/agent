import {
  createTrustMarking,
  type ExecutionContext,
  type Executor,
  type JsonValue,
  type Session,
  type Tool,
  type ToolCall,
  type ToolResult,
  type TrustLevel,
} from '@stratusagent/core';

export interface ExecutorResultCallRef {
  id: string;
  toolName: string;
}

const toCallRef = (call: ToolCall | ExecutorResultCallRef): ExecutorResultCallRef => ({
  id: call.id,
  toolName: call.toolName,
});

export const normalizeExecutorError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * A successful result, labelled. `trust` is what the executor resolved from
 * the tool's producer channels (`createTrustMarking`); a caller building a
 * result by hand with no idea where the content came from should say
 * `unknown` rather than take the default, which is the label for a tool
 * that declared nothing and marked nothing — its own work.
 */
export const successResult = (
  call: ToolCall | ExecutorResultCallRef,
  output: JsonValue,
  trust: TrustLevel = 'agent',
): ToolResult => {
  const ref = toCallRef(call);
  return {
    callId: ref.id,
    toolName: ref.toolName,
    ok: true,
    output,
    trust,
  };
};

export const failureResult = (
  call: ToolCall | ExecutorResultCallRef,
  error: unknown,
  output: JsonValue = null,
  trust: TrustLevel = 'agent',
): ToolResult => {
  const ref = toCallRef(call);
  return {
    callId: ref.id,
    toolName: ref.toolName,
    ok: false,
    output,
    error: normalizeExecutorError(error),
    trust,
  };
};

export interface ExecutorDefinition {
  execute(call: ToolCall, tool: Tool, session: Session, context?: ExecutionContext): Promise<ToolResult>;
}

export const defineExecutor = ({ execute }: ExecutorDefinition): Executor => ({
  execute,
});

export interface DirectExecutorErrorContext {
  call: ToolCall;
  tool: Tool;
  session: Session;
  error: unknown;
}

export interface DirectExecutorOptions {
  onError?: (context: DirectExecutorErrorContext) => ToolResult | Promise<ToolResult>;
}

export class DirectExecutor implements Executor {
  private readonly onError?: DirectExecutorOptions['onError'];

  constructor(options: DirectExecutorOptions = {}) {
    this.onError = options.onError;
  }

  async execute(call: ToolCall, tool: Tool, session: Session, context?: ExecutionContext): Promise<ToolResult> {
    const marking = createTrustMarking(tool, context);
    try {
      const output = await tool.execute(call.input, session, marking.context);
      return successResult(call, output, marking.resolve());
    } catch (error) {
      if (this.onError) {
        // A mapper that said where its text came from is believed; one
        // that did not gets what the tool's channels said, never the
        // default — the error it is wrapping may quote a server.
        const mapped = await this.onError({ call, tool, session, error });
        return mapped.trust === undefined ? { ...mapped, trust: marking.resolve() } : mapped;
      }

      return failureResult(call, error, null, marking.resolve());
    }
  }
}

export const createDirectExecutor = (options: DirectExecutorOptions = {}): Executor =>
  new DirectExecutor(options);
