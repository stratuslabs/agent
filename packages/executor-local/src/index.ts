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
  ToolRisk,
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
  /**
   * Environment for the child. What this *means* depends on `envMode`:
   * added to the daemon's environment by default, or the whole of it when
   * the invocation asks for a replacement.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * How `env` combines with the daemon's own environment.
   *
   * - `inherit` (default) — `{ ...process.env, ...env }`, which is what a
   *   fixed-argv tool wants: it was written by us, its arguments are not
   *   attacker-chosen, and it may need PATH, HOME, and the rest.
   * - `replace` — the child receives **only** `env`. Nothing from the
   *   daemon's environment reaches it, and the daemon's environment is
   *   where `ANTHROPIC_API_KEY` and every other key an operator exported
   *   lives. A tool that runs a command an agent composed must use this:
   *   otherwise `sh -c 'echo $ANTHROPIC_API_KEY'` is a credential read
   *   that no approval prompt would describe as one, because the command
   *   string the approver saw is not where the secret is named.
   *
   * Pack discipline cannot buy this — a plugin cannot unset what it was
   * not the one to spawn with — so the seam is here.
   */
  envMode?: 'inherit' | 'replace';
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
  /** The turn's abort signal, for parsers that do asynchronous work. */
  signal?: AbortSignal;
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
  /** See ToolRisk in @stratusagent/core. Omitted means `gated`. */
  risk?: ToolRisk;
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
  risk,
  createCommand,
  parseResult,
}: LocalCommandToolDefinition): LocalCommandTool => ({
  name,
  ...(description ? { description } : {}),
  ...(parameters ? { parameters } : {}),
  // Forwarded, not dropped: this factory makes the tools that spawn
  // processes, so it is the last place a declared risk should go missing.
  ...(risk ? { risk } : {}),
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
      // The factory runs before any process exists, so the signal must be
      // observed here too: a cancelled turn settles even if createCommand
      // never does, and a command is never spawned after cancellation just
      // to be killed — its startup side effects would already be real.
      const signal = context?.signal;
      if (signal?.aborted) {
        return failureResult(call, `Command aborted before start: ${call.toolName}`);
      }
      const invocation = await raceWithAbort(tool.createCommand(call.input, session), signal, 'Command construction');
      if (signal?.aborted) {
        return failureResult(call, `Command aborted before start: ${call.toolName}`);
      }
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
        // Parsing can be asynchronous too; a parser blocked at cancellation
        // must not keep the settled subprocess's turn pending.
        const output = tool.parseResult
          ? await raceWithAbort(
              tool.parseResult(execution, { call, session, tool, ...(signal ? { signal } : {}) }),
              signal,
              'Result parsing',
            )
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

// Settles as soon as the signal fires, whether or not the wrapped work
// ever does — an unresponsive command factory must not pin a cancelled
// turn open.
const raceWithAbort = async <T>(work: Promise<T> | T, signal: AbortSignal | undefined, what: string): Promise<T> => {
  if (!signal) {
    return work;
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error(`${what} aborted.`));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(work).then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
};

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
    // `replace` hands over exactly what was granted — an empty object when
    // nothing was, which is a child with no environment rather than a child
    // with the daemon's.
    env: invocation.envMode === 'replace'
      ? { ...invocation.env }
      : (invocation.env ? { ...process.env, ...invocation.env } : process.env),
    shell: invocation.shell ?? false,
    // Own process group (POSIX), so cancellation and timeouts can kill the
    // whole tree — a shell's or tool's own children included — rather than
    // only the direct child.
    ...(process.platform !== 'win32' ? { detached: true } : {}),
  });

  const killTree = (): void => {
    if (process.platform !== 'win32' && typeof child.pid === 'number') {
      try {
        process.kill(-child.pid, 'SIGKILL');
        return;
      } catch {
        // Group already gone or not a leader; fall through to direct kill.
      }
    }
    child.kill('SIGKILL');
  };

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
    killTree();
  }, options.timeoutMs);
  timer.unref();

  // The turn's abort signal kills the child directly — an aborted turn must
  // leave no orphaned subprocess behind.
  const onAbort = (): void => {
    aborted = true;
    killTree();
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
