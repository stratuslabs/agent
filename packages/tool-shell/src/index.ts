import path from 'node:path';

import type { JsonObject, JsonValue, Plugin, Session } from '@stratusagent/core';
import {
  defineLocalCommandTool,
  type LocalCommandExecution,
  type LocalCommandInvocation,
  type LocalCommandTool,
} from '@stratusagent/executor-local';
import { resolvePluginAgentConfig } from '@stratusagent/plugins';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 100_000;

/**
 * What the child is allowed to inherit by name.
 *
 * Short, and every entry is here because commands break without it rather
 * than because it seemed harmless. Nothing on this list is a secret, and
 * that is the test for adding one: an operator who needs `GITHUB_TOKEN` in
 * a command's environment is making a deliberate decision, in config, that
 * an auditor can see.
 */
const DEFAULT_PASS_ENV = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ'];

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

const truncate = (value: string, maxBytes: number): { text: string; truncated: boolean } => {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
    return { text: value, truncated: false };
  }
  return { text: `${value.slice(0, maxBytes)}\n… output truncated at ${maxBytes} bytes`, truncated: true };
};

const settingsFor = (config: JsonObject, session: Session, env: NodeJS.ProcessEnv) => {
  const resolved = resolvePluginAgentConfig(config, session.agent.id);
  const workspaceRoot = typeof resolved.workspaceRoot === 'string' ? resolved.workspaceRoot : undefined;
  const cwd = typeof resolved.cwd === 'string' && resolved.cwd.length > 0
    ? resolved.cwd
    : (workspaceRoot ? path.join(workspaceRoot, session.agent.id) : undefined);

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
    createCommand(input, session): LocalCommandInvocation {
      const command = typeof input.command === 'string' ? input.command.trim() : '';
      if (!command) {
        throw new Error('command is required.');
      }
      const settings = settingsFor(config, session, options.processEnv ?? process.env);
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
      };
    },
    parseResult(result: LocalCommandExecution, context): JsonValue {
      const settings = settingsFor(config, context.session, options.processEnv ?? process.env);
      const stdout = truncate(result.stdout, settings.maxOutputBytes);
      const stderr = truncate(result.stderr, settings.maxOutputBytes);
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
