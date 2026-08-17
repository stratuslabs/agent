import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import type {
  ExecutionContext,
  Executor,
  JsonObject,
  JsonValue,
  Session,
  Tool,
  ToolCall,
  ToolResult,
} from '@stratusagent/core';
import {
  createDirectExecutor,
  failureResult,
  successResult,
} from '@stratusagent/executors';

export interface LocalCommandInvocation {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  shell?: boolean;
  timeoutMs?: number;
}

export interface LocalCommandExecution {
  command: string;
  args: string[];
  cwd?: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  /** True when the turn's abort signal killed the child before completion. */
  aborted: boolean;
  durationMs: number;
}

export interface LocalCommandContext {
  call: ToolCall;
  session: Session;
  tool: LocalCommandTool;
}

export interface LocalCommandTool extends Tool {
  runtime: 'local-command';
  createCommand(input: ToolCall['input'], session: Session): LocalCommandInvocation | Promise<LocalCommandInvocation>;
  parseResult?(result: LocalCommandExecution, context: LocalCommandContext): JsonValue | Promise<JsonValue>;
}

export interface LocalCommandToolDefinition {
  name: string;
  description?: string;
  parameters?: JsonObject;
  createCommand(input: ToolCall['input'], session: Session): LocalCommandInvocation | Promise<LocalCommandInvocation>;
  parseResult?(result: LocalCommandExecution, context: LocalCommandContext): JsonValue | Promise<JsonValue>;
}

export type LocalSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface LocalCommandExecutorOptions {
  fallback?: Executor;
  spawn?: LocalSpawn;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TIMEOUT_MS = 300_000;

export const defineLocalCommandTool = ({
  name,
  description,
  parameters,
  createCommand,
  parseResult,
}: LocalCommandToolDefinition): LocalCommandTool => ({
  name,
  ...(description ? { description } : {}),
  ...(parameters ? { parameters } : {}),
  runtime: 'local-command',
  createCommand,
  ...(parseResult ? { parseResult } : {}),
  async execute() {
    throw new Error(`Local command tool must run through LocalCommandExecutor: ${name}`);
  },
});

export const isLocalCommandTool = (tool: Tool): tool is LocalCommandTool => {
  return 'runtime' in tool && tool.runtime === 'local-command' && typeof (tool as LocalCommandTool).createCommand === 'function';
};

export class LocalCommandExecutor implements Executor {
  private readonly fallback: Executor;
  private readonly spawn: LocalSpawn;
  private readonly defaultTimeoutMs: number;
  private readonly maxTimeoutMs: number;

  constructor(options: LocalCommandExecutorOptions = {}) {
    this.fallback = options.fallback ?? createDirectExecutor();
    this.spawn = options.spawn ?? nodeSpawn;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxTimeoutMs = options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
  }

  async execute(call: ToolCall, tool: Tool, session: Session, context?: ExecutionContext): Promise<ToolResult> {
    if (!isLocalCommandTool(tool)) {
      return this.fallback.execute(call, tool, session, context);
    }

    try {
      const invocation = await tool.createCommand(call.input, session);
      const timeoutMs = resolveTimeoutMs(invocation.timeoutMs, this.defaultTimeoutMs, this.maxTimeoutMs);
      const execution = await runLocalCommand(invocation, {
        spawn: this.spawn,
        timeoutMs,
        ...(context?.signal ? { signal: context.signal } : {}),
      });

      if (execution.aborted) {
        return failureResult(
          call,
          `Command aborted: ${execution.command}`,
          serializeExecution(execution),
        );
      }

      if (execution.timedOut) {
        return failureResult(
          call,
          `Command timed out after ${timeoutMs}ms: ${execution.command}`,
          serializeExecution(execution),
        );
      }

      if (execution.exitCode !== 0) {
        return failureResult(
          call,
          `Command exited with code ${execution.exitCode}: ${execution.command}`,
          serializeExecution(execution),
        );
      }

      try {
        const output = tool.parseResult
          ? await tool.parseResult(execution, { call, session, tool })
          : serializeExecution(execution);
        return successResult(call, output);
      } catch (error) {
        return failureResult(call, error, serializeExecution(execution));
      }
    } catch (error) {
      return failureResult(call, error);
    }
  }
}

export const createLocalCommandExecutor = (
  options: LocalCommandExecutorOptions = {},
): Executor => new LocalCommandExecutor(options);

const resolveTimeoutMs = (
  requested: number | undefined,
  defaultTimeoutMs: number,
  maxTimeoutMs: number,
): number => {
  const candidate = requested ?? defaultTimeoutMs;
  if (!Number.isFinite(candidate) || candidate <= 0) {
    return defaultTimeoutMs;
  }

  return Math.min(candidate, maxTimeoutMs);
};

const runLocalCommand = async (
  invocation: LocalCommandInvocation,
  options: { spawn: LocalSpawn; timeoutMs: number; signal?: AbortSignal },
): Promise<LocalCommandExecution> => {
  const startedAt = Date.now();
  const args = invocation.args ?? [];
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let aborted = false;
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');

  const child = options.spawn(invocation.command, args, {
    cwd: invocation.cwd,
    env: invocation.env ? { ...process.env, ...invocation.env } : process.env,
    shell: invocation.shell ?? false,
  });

  child.stdout.on('data', (chunk) => {
    stdout += stdoutDecoder.write(chunk);
  });

  child.stderr.on('data', (chunk) => {
    stderr += stderrDecoder.write(chunk);
  });

  if (typeof invocation.stdin === 'string') {
    child.stdin.end(invocation.stdin);
  } else {
    child.stdin.end();
  }

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, options.timeoutMs);
  timer.unref();

  // The turn's abort signal kills the child directly — an aborted turn must
  // leave no orphaned subprocess behind.
  const onAbort = (): void => {
    aborted = true;
    child.kill('SIGKILL');
  };
  if (options.signal?.aborted) {
    onAbort();
  } else {
    options.signal?.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const exitCode = await waitForChild(child);
    stdout += stdoutDecoder.end();
    stderr += stderrDecoder.end();

    return {
      command: invocation.command,
      args: [...args],
      ...(invocation.cwd ? { cwd: invocation.cwd } : {}),
      stdout,
      stderr,
      exitCode,
      timedOut,
      aborted,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
};

const waitForChild = async (child: ChildProcessWithoutNullStreams): Promise<number> => {
  return new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      resolve(code ?? -1);
    });
  });
};

const serializeExecution = (execution: LocalCommandExecution): JsonValue => ({
  command: execution.command,
  args: execution.args,
  ...(execution.cwd ? { cwd: execution.cwd } : {}),
  stdout: execution.stdout,
  stderr: execution.stderr,
  exitCode: execution.exitCode,
  timedOut: execution.timedOut,
  aborted: execution.aborted,
  durationMs: execution.durationMs,
});
