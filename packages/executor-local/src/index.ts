import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import {
  createTrustMarking,
  type ExecutionContext,
  type Executor,
  type JsonObject,
  type JsonValue,
  type Session,
  type Tool,
  type ToolCall,
  type ToolResult,
  type ToolRisk,
  type TrustLevel,
  createDirectExecutor,
  failureResult,
  successResult,
} from '@stratusagent/core';

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
  /**
   * The per-call producer channel, for a parser that can tell its output
   * came from outside — see `ExecutionContext.markTrust`. A tool whose
   * every result does declares `outputTrust` instead.
   */
  markTrust?: (trust: TrustLevel) => void;
}

/**
 * What `createCommand` is handed besides the input: the per-call producer
 * channel, so a tool that knows before the process starts what its output
 * can carry labels it once — every result below, the failures included.
 */
export interface LocalCommandCreateContext {
  markTrust?: (trust: TrustLevel) => void;
  /**
   * The label the call was approved under (`ExecutionContext.decidedTrust`),
   * for a tool with `trustBeforeCall` to compare with what it reads now,
   * the last moment before the process exists.
   */
  decidedTrust?: TrustLevel;
}

export interface LocalCommandTool extends Tool {
  runtime: 'local-command';
  createCommand(
    input: ToolCall['input'],
    session: Session,
    context?: LocalCommandCreateContext,
  ): LocalCommandInvocation | Promise<LocalCommandInvocation>;
  /**
   * Asked once the process has exited — success, failure, timeout or abort
   * alike — for a label its output may carry that was not knowable when the
   * command was built: a file it read may have been marked since. Whatever
   * it returns is marked like `markTrust`; a hook that throws marks
   * `external`, since that output's provenance is then unvouched for.
   */
  settleTrust?(session: Session): TrustLevel | undefined | Promise<TrustLevel | undefined>;
  parseResult?(result: LocalCommandExecution, context: LocalCommandContext): JsonValue | Promise<JsonValue>;
  /**
   * Asked when the command exited non-zero (not on a timeout or an abort),
   * for fields to add to the failed result's output beside the execution
   * record: what the tool can say about why it failed. A key the record
   * already has keeps the record's value. A hook that throws, returns
   * anything but an object, or hasn't answered within 2 s or by the time
   * the turn stops adds nothing, and the failure is reported as it was.
   */
  annotateFailure?(result: LocalCommandExecution, context: LocalCommandContext): JsonObject | undefined | Promise<JsonObject | undefined>;
}

export interface LocalCommandToolDefinition {
  name: string;
  description?: string;
  parameters?: JsonObject;
  /** See ToolRisk in @stratusagent/core. Omitted means `gated`. */
  risk?: ToolRisk;
  /** See Tool.outputTrust in @stratusagent/core. Omitted means `agent`. */
  outputTrust?: TrustLevel;
  /** See Tool.trustBeforeCall in @stratusagent/core. */
  trustBeforeCall?(session: Session): TrustLevel | undefined | Promise<TrustLevel | undefined>;
  createCommand(
    input: ToolCall['input'],
    session: Session,
    context?: LocalCommandCreateContext,
  ): LocalCommandInvocation | Promise<LocalCommandInvocation>;
  /**
   * Asked once the process has exited — success, failure, timeout or abort
   * alike — for a label its output may carry that was not knowable when the
   * command was built: a file it read may have been marked since. Whatever
   * it returns is marked like `markTrust`; a hook that throws marks
   * `external`, since that output's provenance is then unvouched for.
   */
  settleTrust?(session: Session): TrustLevel | undefined | Promise<TrustLevel | undefined>;
  parseResult?(result: LocalCommandExecution, context: LocalCommandContext): JsonValue | Promise<JsonValue>;
  /**
   * Asked when the command exited non-zero (not on a timeout or an abort),
   * for fields to add to the failed result's output beside the execution
   * record: what the tool can say about why it failed. A key the record
   * already has keeps the record's value. A hook that throws, returns
   * anything but an object, or hasn't answered within 2 s or by the time
   * the turn stops adds nothing, and the failure is reported as it was.
   */
  annotateFailure?(result: LocalCommandExecution, context: LocalCommandContext): JsonObject | undefined | Promise<JsonObject | undefined>;
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
/**
 * The longest a local command may run unless the host sets its own
 * ceiling: five minutes. A request for longer is cut to it, and the
 * timeout message says so, because a model that asked for an hour and was
 * killed at five minutes otherwise has no way to tell why.
 */
export const LOCAL_COMMAND_MAX_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_TIMEOUT_MS = LOCAL_COMMAND_MAX_TIMEOUT_MS;
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
  outputTrust,
  trustBeforeCall,
  createCommand,
  settleTrust,
  parseResult,
  annotateFailure,
}: LocalCommandToolDefinition): LocalCommandTool => ({
  name,
  ...(description ? { description } : {}),
  ...(parameters ? { parameters } : {}),
  // Forwarded, not dropped: this factory makes the tools that spawn
  // processes, so it is the last place a declared risk should go missing.
  ...(risk ? { risk } : {}),
  ...(outputTrust ? { outputTrust } : {}),
  ...(trustBeforeCall ? { trustBeforeCall } : {}),
  runtime: 'local-command',
  createCommand,
  ...(settleTrust ? { settleTrust } : {}),
  ...(parseResult ? { parseResult } : {}),
  ...(annotateFailure ? { annotateFailure } : {}),
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

    // Every result below carries the label the tool's channels resolve to,
    // the failures included: a command's stderr is that command's text.
    const marking = createTrustMarking(tool, context);
    const trust = (): TrustLevel => marking.resolve();
    try {
      // The factory runs before any process exists, so the signal must be
      // observed here too: a cancelled turn settles even if createCommand
      // never does, and a command is never spawned after cancellation just
      // to be killed — its startup side effects would already be real.
      const signal = context?.signal;
      if (signal?.aborted) {
        return failureResult(call, `Command aborted before start: ${call.toolName}`, null, trust());
      }
      const invocation = await raceWithAbort(tool.createCommand(call.input, session, {
        markTrust: marking.context.markTrust!,
        ...(context?.decidedTrust ? { decidedTrust: context.decidedTrust } : {}),
      }), signal, 'Command construction');
      if (signal?.aborted) {
        return failureResult(call, `Command aborted before start: ${call.toolName}`, null, trust());
      }
      const timeoutMs = resolveTimeoutMs(invocation.timeoutMs, this.defaultTimeoutMs, this.maxTimeoutMs);
      const execution = await runLocalCommand(invocation, {
        spawn: this.spawn,
        timeoutMs,
        maxOutputBytes: resolveMaxOutputBytes(invocation.maxOutputBytes, this.maxOutputBytes),
        ...(context?.signal ? { signal: context.signal } : {}),
      });
      // Before any result is built, so each one below carries it. Not raced
      // against the signal: an aborted command's partial output still
      // reaches the model, and must not lose its label to the abort. Bounded
      // instead: a hook that never settles (a ledger swapped for a FIFO)
      // labels `external` rather than holding the turn forever.
      if (tool.settleTrust) {
        try {
          const settled = await settleWithin(tool.settleTrust(session), SETTLE_TRUST_TIMEOUT_MS);
          if (settled !== undefined) {
            marking.context.markTrust!(settled);
          }
        } catch {
          marking.context.markTrust!('external');
        }
      }

      if (execution.aborted) {
        return failureResult(
          call,
          `Command aborted: ${execution.command}`,
          serializeExecution(execution),
          trust(),
        );
      }

      if (execution.timedOut) {
        // Cut to the ceiling rather than the timeout it asked for: say so,
        // and what to do instead, or the next attempt asks for the same
        // impossible hour and is killed at the same five minutes.
        // What was asked for is the invocation's own timeout or, without a
        // usable one, the executor's default — either can exceed the ceiling.
        const requested = typeof invocation.timeoutMs === 'number' && Number.isFinite(invocation.timeoutMs) && invocation.timeoutMs > 0
          ? invocation.timeoutMs
          : this.defaultTimeoutMs;
        const capped = requested > timeoutMs;
        return failureResult(
          call,
          capped
            ? `Command timed out after ${timeoutMs}ms, the most a command may run here (it asked for ${requested}ms): ${execution.command}. `
              + 'Start longer work in the background with its output redirected to a file, and check the file in a later call.'
            : `Command timed out after ${timeoutMs}ms: ${execution.command}`,
          serializeExecution(execution),
          trust(),
        );
      }

      if (execution.exitCode !== 0) {
        return failureResult(
          call,
          `Command exited with code ${execution.exitCode}: ${execution.command}`,
          await annotatedFailure(execution, tool, { call, session, tool, ...(signal ? { signal } : {}) }),
          trust(),
        );
      }

      try {
        // Parsing can be asynchronous too; a parser blocked at cancellation
        // must not keep the settled subprocess's turn pending.
        const markTrust = marking.context.markTrust;
        const output = tool.parseResult
          ? await raceWithAbort(
              tool.parseResult(execution, {
                call,
                session,
                tool,
                ...(signal ? { signal } : {}),
                ...(markTrust ? { markTrust } : {}),
              }),
              signal,
              'Result parsing',
            )
          : serializeExecution(execution);
        return successResult(call, output, trust());
      } catch (error) {
        return failureResult(call, error, serializeExecution(execution), trust());
      }
    } catch (error) {
      return failureResult(call, error, null, trust());
    }
  }
}

/** The longest a tool's `annotateFailure` may take before the failure is reported without its fields. */
const ANNOTATE_FAILURE_TIMEOUT_MS = 2_000;

/**
 * A non-zero exit's execution record, plus what its tool's `annotateFailure`
 * adds. The command has already run, so its failure is reported whatever
 * the hook does: one that throws, stalls or outlives the turn loses only
 * its own fields. It adds to the record and never rewrites it, so a key the
 * record has keeps the record's value.
 */
const annotatedFailure = async (
  execution: LocalCommandExecution,
  tool: LocalCommandTool,
  context: LocalCommandContext,
): Promise<JsonObject> => {
  const record = serializeExecution(execution);
  if (!tool.annotateFailure) {
    return record;
  }
  let fields: unknown;
  try {
    fields = await raceWithAbort(
      settleWithin(tool.annotateFailure(execution, context), ANNOTATE_FAILURE_TIMEOUT_MS),
      context.signal,
      'Failure annotation',
    );
  } catch {
    return record;
  }
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
    return record;
  }
  const added = Object.entries(fields as JsonObject).filter(([key]) => !Object.hasOwn(record, key));
  return { ...record, ...Object.fromEntries(added) };
};

/** The longest a tool's `settleTrust` may take before its output is labelled `external`. */
const SETTLE_TRUST_TIMEOUT_MS = 2_000;

/** The hook's answer, or a rejection once `ms` pass, so the caller's catch labels `external`. */
const settleWithin = async <T>(value: T | Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(value),
      new Promise<never>((_, reject) => {
        // Not unref'd: cleared below either way, and an unref'd bound lets a
        // process with nothing else running exit mid-turn instead of
        // labelling the result (`stratus run`, or a test on Node 22).
        timer = setTimeout(() => reject(new Error('settleTrust timed out')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

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

  // A kill reaches the process group, not the pipes. A grandchild that
  // moved to its own session — `setsid`, a daemonizing server, anything
  // `nohup … &` starts under a shell that then exits — inherited the
  // command's stdout and keeps it open after everything in the group is
  // dead, and `'close'` waits for every stdio stream: a 2s timeout on
  // `setsid sleep 60 &` settled after 61s, when the escapee happened to
  // exit. So once the tree has been killed, the call settles on the
  // child's exit instead, and whatever the survivor writes afterwards is
  // read and dropped. Read, not cut off: destroying the read end would
  // hand the survivor SIGPIPE on its next write, and the point of leaving
  // it alive is that it stays alive. The handles are unref'd so an
  // escapee's pipe cannot hold a one-shot CLI run open either.
  let released = false;
  const releaseStdio = (): void => {
    released = true;
    unrefStream(child.stdout);
    unrefStream(child.stderr);
    settleOnExit();
  };

  child.stdout.on('data', (chunk: Buffer) => {
    if (!released) {
      stdout.write(chunk);
    }
  });

  child.stderr.on('data', (chunk: Buffer) => {
    if (!released) {
      stderr.write(chunk);
    }
  });

  let settle: (code: number) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const settled = new Promise<number>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  let exitCode: number | undefined;
  // The exit may already have happened when the timeout fires — a command
  // that finished, leaving a survivor on its pipe, looks exactly like one
  // still running until then.
  const settleOnExit = (): void => {
    if (released && exitCode !== undefined) {
      settle(exitCode);
    }
  };
  child.once('error', fail);
  child.once('exit', (code) => {
    exitCode = code ?? -1;
    settleOnExit();
  });
  child.once('close', (code) => {
    settle(code ?? -1);
  });

  if (typeof invocation.stdin === 'string') {
    child.stdin.end(invocation.stdin);
  } else {
    child.stdin.end();
  }

  const timer = setTimeout(() => {
    timedOut = true;
    killTree();
    releaseStdio();
  }, options.timeoutMs);
  timer.unref();

  // The turn's abort signal kills the child directly — an aborted turn must
  // leave no orphaned subprocess behind.
  const onAbort = (): void => {
    aborted = true;
    killTree();
    releaseStdio();
  };
  if (options.signal?.aborted) {
    onAbort();
  } else {
    options.signal?.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const exitCode = await settled;

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

// The stdio streams are typed as bare Readables, but a spawned child's are
// sockets over pipes, and a socket can be unref'd.
const unrefStream = (stream: NodeJS.ReadableStream): void => {
  const candidate = stream as { unref?: () => void };
  if (typeof candidate.unref === 'function') {
    candidate.unref();
  }
};

const serializeExecution = (execution: LocalCommandExecution): JsonObject => ({
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
