import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_SUBPROCESS_PASS_ENV, type JsonObject, type JsonValue, type Plugin, type Session } from '@stratusagent/core';
import {
  defineLocalCommandTool,
  type LocalCommandExecution,
  type LocalCommandInvocation,
  type LocalCommandTool,
} from '@stratusagent/executor-local';
import { resolvePluginAgentConfig } from '@stratusagent/plugins';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 100_000;

// What the child is allowed to inherit by name — the kernel's one list,
// shared with the MCP bridge's stdio servers, so "what does a scrubbed
// child see" has one answer. See DEFAULT_SUBPROCESS_PASS_ENV in core.
const DEFAULT_PASS_ENV = [...DEFAULT_SUBPROCESS_PASS_ENV];

export interface ShellPluginConfig extends JsonObject {
  /** Where commands start. A starting directory, not a jail — see the README. */
  cwd?: string;
  /** Names forwarded from the daemon's environment. Defaults above. */
  passEnv?: string[];
  /** Variables set outright, name to value. */
  env?: JsonObject;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** The shell binary. `/bin/sh` unless you mean something else. */
  shell?: string;
  /** Supplied by the host: `~/.stratus/workspaces`, one directory per agent. */
  workspaceRoot?: string;
}

const asNumber = (value: JsonValue | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

const asStrings = (value: JsonValue | undefined, fallback: string[]): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : fallback;

// The executor already stopped keeping the stream at `maxBytes` (see
// `maxOutputBytes` on the invocation below), so the text arriving here is
// within the cap and `dropped` is how we know the command wrote more. The
// byte check stays for an executor that does not honor the cap.
const truncate = (value: string, maxBytes: number, dropped: boolean): { text: string; truncated: boolean } => {
  if (!dropped && Buffer.byteLength(value, 'utf8') <= maxBytes) {
    return { text: value, truncated: false };
  }
  return { text: `${value.slice(0, maxBytes)}\n… output truncated at ${maxBytes} bytes`, truncated: true };
};

const settingsFor = (config: JsonObject, session: Session, env: NodeJS.ProcessEnv) => {
  const resolved = resolvePluginAgentConfig(config, session.agent.id);
  const workspaceRoot = typeof resolved.workspaceRoot === 'string' ? resolved.workspaceRoot : undefined;
  const configuredCwd = typeof resolved.cwd === 'string' && resolved.cwd.length > 0 ? resolved.cwd : undefined;
  const cwd = configuredCwd ?? (workspaceRoot ? path.join(workspaceRoot, session.agent.id) : undefined);

  const granted: NodeJS.ProcessEnv = {};
  for (const name of asStrings(resolved.passEnv, DEFAULT_PASS_ENV)) {
    const value = env[name];
    if (value !== undefined) {
      granted[name] = value;
    }
  }
  const explicit = resolved.env;
  if (typeof explicit === 'object' && explicit !== null && !Array.isArray(explicit)) {
    for (const [name, value] of Object.entries(explicit)) {
      if (typeof value === 'string') {
        granted[name] = value;
      }
    }
  }

  return {
    ...(cwd ? { cwd } : {}),
    // Whether this agent's directory is ours to create. The workspace is —
    // it is a path this repository chose, and nobody has been asked to make
    // it. A directory an operator named is not.
    ownsCwd: configuredCwd === undefined && cwd !== undefined,
    env: granted,
    timeoutMs: asNumber(resolved.timeoutMs, DEFAULT_TIMEOUT_MS),
    maxOutputBytes: asNumber(resolved.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES),
    shell: typeof resolved.shell === 'string' && resolved.shell.length > 0 ? resolved.shell : '/bin/sh',
  };
};

export interface ShellToolOptions {
  /** The environment to grant *from*. Defaults to the daemon's. */
  processEnv?: NodeJS.ProcessEnv;
}

export const createShellTool = (config: JsonObject = {}, options: ShellToolOptions = {}): LocalCommandTool => {
  const tool = defineLocalCommandTool({
    name: 'shell.run',
    description: 'Run a shell command. The command is what gets approved, so write it plainly.',
    // `unknown`, because nobody can say: `git status` is the agent's own
    // work and `curl https://…` is a stranger's page, and they come back
    // through the same stdout. Labelling it `agent` would launder every
    // fetch made through a shell past the provenance `web.fetch` enforces;
    // labelling it `external` would call the agent's own `ls` a stranger's.
    // Absence of provenance is not evidence of trust, so the honest label
    // is the one for provenance nobody recorded — and a session that runs
    // commands writes `unknown` from then on, which is the safe direction.
    // Recognising fetching programs by name would be the enumerated list
    // the provenance contract rejects.
    outputTrust: 'unknown',
    // `gated`, not `dangerous`: the risk of a shell lives in its arguments,
    // and the permission engine narrows it per invocation from the command
    // string below. Marking the tool `dangerous` would mean no command
    // could ever run unattended, including `git status`.
    risk: 'gated',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to run.' },
        timeoutMs: { type: 'number' },
      },
      required: ['command'],
    },
    async createCommand(input, session): Promise<LocalCommandInvocation> {
      const command = typeof input.command === 'string' ? input.command.trim() : '';
      if (!command) {
        throw new Error('command is required.');
      }
      const settings = settingsFor(config, session, options.processEnv ?? process.env);
      if (settings.cwd) {
        // `spawn` fails with a bare `ENOENT` naming the *shell* when its
        // working directory does not exist — which on a fresh install is
        // every call, and reads as a broken interpreter rather than a
        // missing directory. So the agent's workspace is created here, and
        // a directory somebody else chose is reported by name instead.
        if (settings.ownsCwd) {
          await mkdir(settings.cwd, { recursive: true });
        } else {
          const usable = await stat(settings.cwd).then((info) => info.isDirectory(), () => false);
          if (!usable) {
            throw new Error(
              `The configured working directory does not exist: ${settings.cwd}. `
              + 'Create it, or change cwd for @stratusagent/tool-shell.',
            );
          }
        }
      }
      return {
        command: settings.shell,
        args: ['-c', command],
        ...(settings.cwd ? { cwd: settings.cwd } : {}),
        env: settings.env,
        // Required, not preferred. The daemon's environment holds every key
        // an operator exported, and a command an agent composed must not be
        // able to read one — an approver who allowed `curl $URL` did not
        // allow `curl -d "$ANTHROPIC_API_KEY"`.
        envMode: 'replace',
        timeoutMs: asNumber(input.timeoutMs, settings.timeoutMs),
        // Enforced as the output is read, not after: a command that floods
        // stdout must not be held whole in the daemon's heap for a result
        // that is about to be cut to this size anyway.
        maxOutputBytes: settings.maxOutputBytes,
      };
    },
    parseResult(result: LocalCommandExecution, context): JsonValue {
      const settings = settingsFor(config, context.session, options.processEnv ?? process.env);
      const stdout = truncate(result.stdout, settings.maxOutputBytes, result.stdoutTruncated);
      const stderr = truncate(result.stderr, settings.maxOutputBytes, result.stderrTruncated);
      return {
        stdout: stdout.text,
        stderr: stderr.text,
        exitCode: result.exitCode,
        truncated: stdout.truncated || stderr.truncated,
        ...(result.cwd ? { cwd: result.cwd } : {}),
        durationMs: result.durationMs,
      };
    },
  });

  return {
    ...tool,
    /**
     * The one thing this pack contributes to the approval decision.
     *
     * Everything about *what a command means* — safe scopes, flag and
     * refspec constraints, control-operator defeat, the per-agent whitelist
     * — is 03's engine in `@stratusagent/permissions`. A shell pack that
     * classified its own invocations would be a second policy, disagreeing
     * with the first one the day either changed.
     */
    commandFor: (input: JsonObject) => (typeof input.command === 'string' ? input.command.trim() : undefined),
  };
};

/**
 * The `shell` toolset.
 *
 * One tool, whose danger is entirely in its argument. That is why the
 * kernel grew `Tool.commandFor` and why the permission engine grew scopes:
 * a single risk level for every command a shell can run is either too
 * coarse to be safe or too coarse to be usable.
 */
export const createShellPlugin = (config: JsonObject = {}, options: ShellToolOptions = {}): Plugin => ({
  name: '@stratusagent/tool-shell',
  setup(context) {
    context.tools.register(createShellTool(config, options));
  },
});

/** The loader's ABI. See `docs/architecture/plugins.md`. */
export const createPlugin = createShellPlugin;
