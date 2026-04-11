import type {
  Executor,
  JsonValue,
  Session,
  Tool,
  ToolCall,
  ToolResult,
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

export const successResult = (
  call: ToolCall | ExecutorResultCallRef,
  output: JsonValue,
): ToolResult => {
  const ref = toCallRef(call);
  return {
    callId: ref.id,
    toolName: ref.toolName,
    ok: true,
    output,
  };
};

export const failureResult = (
  call: ToolCall | ExecutorResultCallRef,
  error: unknown,
  output: JsonValue = null,
): ToolResult => {
  const ref = toCallRef(call);
  return {
    callId: ref.id,
    toolName: ref.toolName,
    ok: false,
    output,
    error: normalizeExecutorError(error),
  };
};

export interface ExecutorDefinition {
  execute(call: ToolCall, tool: Tool, session: Session): Promise<ToolResult>;
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

  async execute(call: ToolCall, tool: Tool, session: Session): Promise<ToolResult> {
    try {
      const output = await tool.execute(call.input, session);
      return successResult(call, output);
    } catch (error) {
      if (this.onError) {
        return this.onError({ call, tool, session, error });
      }

      return failureResult(call, error);
    }
  }
}

export const createDirectExecutor = (options: DirectExecutorOptions = {}): Executor =>
  new DirectExecutor(options);
