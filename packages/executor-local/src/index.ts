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
  /**
   * How much of each stream is kept, in bytes. Output past it is read and
   * dropped — read, so the child never blocks on a full pipe — and the
   * execution says so in `stdoutTruncated` / `stderrTruncated`. Omitted,
   * the executor's own cap applies.
   */
  maxOutputBytes?: number;
}

export interface LocalCommandExecution {
  command: string;
  args: string[];
  cwd?: string;
  stdout: string;
  stderr: string;
  /** True when stdout hit `maxOutputBytes` and the rest was dropped. */
  stdoutTruncated: boolean;
  /** True when stderr hit `maxOutputBytes` and the rest was dropped. */
  stderrTruncated: boolean;
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
  /**
   * Per-stream cap for invocations that set none of their own. Not a
   * ceiling on theirs: a tool that asks for more gets it.
   */
  maxOutputBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TIMEOUT_MS = 300_000;
// Per stream. Output is accumulated in the daemon's heap as it arrives, and
// before this cap existed `head -c 300000000 /dev/zero | tr '\0' a` took a
// daemon from 108 MB to 785 MB resident — and left it there — for a result
// tool-shell then cut to 100 KB. Generous, because this is the floor for
// every local-command tool, not a tool's own idea of a useful result.
const DEFAULT_MAX_OUTPUT_BYTES = 10_000_000;

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
  private readonly maxOutputBytes: number;

  constructor(options: LocalCommandExecutorOptions = {}) {
    this.fallback = options.fallback ?? createDirectExecutor();
    this.spawn = options.spawn ?? nodeSpawn;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxTimeoutMs = options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
    this.maxOutputBytes = resolveMaxOutputBytes(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES);
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
        maxOutputBytes: resolveMaxOutputBytes(invocation.maxOutputBytes, this.maxOutputBytes),
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

const resolveMaxOutputBytes = (requested: number | undefined, fallback: number): number =>
  requested !== undefined && Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : fallback;

/**
 * Collects one stream up to `maxBytes`, decoding as it goes so a multibyte
 * character split across chunks still comes out whole. Past the cap, chunks
 * are consumed and dropped rather than left in the pipe: an unread pipe
 * fills and blocks the writer, and a command stalled on its own output is
 * indistinguishable from a hang until the timeout kills it.
 */
const createOutputSink = (maxBytes: number): { write: (chunk: Buffer) => void; end: () => string; truncated: () => boolean } => {
  const decoder = new StringDecoder('utf8');
  let text = '';
  let bytes = 0;
  let truncated = false;
  return {
    write: (chunk) => {
      const room = maxBytes - bytes;
      if (room <= 0) {
        truncated = true;
        return;
      }
      if (chunk.length > room) {
        text += decoder.write(chunk.subarray(0, room));
        bytes = maxBytes;
        truncated = true;
        return;
      }
      text += decoder.write(chunk);
      bytes += chunk.length;
    },
    // A cut can land inside a multibyte character; the decoder is holding
    // its first bytes, and flushing them would end the text with U+FFFD.
    // Dropped output ends on a character boundary instead.
    end: () => text + (truncated ? '' : decoder.end()),
    truncated: () => truncated,
  };
};

const runLocalCommand = async (
  invocation: LocalCommandInvocation,
  options: { spawn: LocalSpawn; timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal },
): Promise<LocalCommandExecution> => {
  const startedAt = Date.now();
  const args = invocation.args ?? [];
  let timedOut = false;
  let aborted = false;
  const stdout = createOutputSink(options.maxOutputBytes);
  const stderr = createOutputSink(options.maxOutputBytes);

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

  child.stdout.on('data', (chunk: Buffer) => {
    stdout.write(chunk);
  });

  child.stderr.on('data', (chunk: Buffer) => {
    stderr.write(chunk);
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

    return {
      command: invocation.command,
      args: [...args],
      ...(invocation.cwd ? { cwd: invocation.cwd } : {}),
      stdout: stdout.end(),
      stderr: stderr.end(),
      stdoutTruncated: stdout.truncated(),
      stderrTruncated: stderr.truncated(),
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
  stdoutTruncated: execution.stdoutTruncated,
  stderrTruncated: execution.stderrTruncated,
  exitCode: execution.exitCode,
  timedOut: execution.timedOut,
  aborted: execution.aborted,
  durationMs: execution.durationMs,
});
