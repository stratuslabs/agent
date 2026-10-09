import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  DEFAULT_SUBPROCESS_PASS_ENV,
  type AgentWorkspaces,
  type JsonObject,
  type JsonValue,
  type Plugin,
  type Session,
} from '@stratusagent/core';
import {
  defineLocalCommandTool,
  type LocalCommandExecution,
  type LocalCommandInvocation,
  type LocalCommandTool,
} from '@stratusagent/executor-local';
import { expandHome, resolvePluginAgentConfig, workspacePreparer, workspaceResolver } from '@stratusagent/plugins';

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
  /**
   * A root this plugin appends the agent id to. Only an operator sets it
   * now — the host answers per agent through the `workspaces` seam — and
   * setting it still relocates the agent's shell cwd, which is the point.
   */
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

/**
 * The output cap, without asking where the workspace is.
 *
 * `parseResult` runs after the subprocess has finished, and asking the
 * preparing seam again there would let a workspace that went away between
 * the two turn a command that already ran — and may already have changed
 * something — into a failed tool result somebody retries.
 */
const maxOutputBytesFor = (config: JsonObject, session: Session): number =>
  asNumber(resolvePluginAgentConfig(config, session.agent.id).maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES);

/**
 * Environment variables that carry options for a command the permission
 * engine judges by its arguments. Never passed to a child: see `settingsFor`.
 */
// Not POSIXLY_CORRECT: macOS's /bin/sh exports it to every command it runs,
// so the permission engine reads arguments both ways instead (see
// `operandsToo` in @stratusagent/permissions).
export const COMMAND_OPTION_VARIABLES = ['RIPGREP_CONFIG_PATH', 'GREP_OPTIONS'] as const;

/**
 * Flags that stop a shell from running its user startup files before the
 * command. Without them zsh sources `$HOME/.zshenv`, tcsh and csh
 * `~/.tcshrc`/`~/.cshrc`, and fish its config, even non-interactively, and any
 * of them can redefine `cat`. bash, `sh`, dash, and ksh read none when not
 * interactive, once `BASH_ENV`/`ENV` are withheld. Another shell named in
 * config is the operator's choice, startup files and all.
 */
const startupOff = (shell: string): string[] => {
  const name = path.basename(shell);
  // zsh, tcsh, and csh all spell it `-f`.
  if (name === 'zsh' || name === 'tcsh' || name === 'csh') {
    return ['-f'];
  }
  if (name === 'fish') {
    return ['--no-config'];
  }
  return [];
};

/** Variables that make a shell run code before the command. Never passed. */
const SHELL_STARTUP_VARIABLES: readonly string[] = ['BASH_ENV', 'ENV', 'ZDOTDIR'];

const settingsFor = (
  config: JsonObject,
  session: Session,
  env: NodeJS.ProcessEnv,
  workspaces: AgentWorkspaces | undefined,
  home: string | undefined,
) => {
  // `env` merges rather than replacing: an agent given its own token keeps
  // the fleet's PATH (#205). A `null` withholds a shared variable from one
  // agent, since only strings are set below.
  const resolved = resolvePluginAgentConfig(config, session.agent.id, { mergeKeys: ['env'] });
  const workspaceRoot = typeof resolved.workspaceRoot === 'string' ? resolved.workspaceRoot : undefined;
  // Expanded here because nothing upstream does: this README's own example
  // is `"cwd": "~/work/ava"`, and unexpanded that is a relative path whose
  // first segment is a directory literally named `~`, so every command
  // failed as a missing working directory.
  const configuredCwd = typeof resolved.cwd === 'string' && resolved.cwd.length > 0
    ? expandHome(resolved.cwd, home)
    : undefined;
  // Resolved per call, and through the shared rule rather than a join of
  // this plugin's own: where an agent's workspace is is the host's to say,
  // and appending the id here is what made this plugin one of five copies
  // of a layout that then moved. See `workspaceResolver`.
  // Prepared, not just resolved: this is the directory the command is
  // about to start in, and the host makes it owner-only before it does.
  const workspaceFor = workspacePreparer(workspaces, workspaceRoot);
  const cwd = configuredCwd ?? workspaceFor?.(session.agent.id);

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
      } else if (value === null) {
        // Withheld, wherever it would have come from: the shared `env` or
        // the daemon's own environment through `passEnv`. Skipping the
        // name here would only stop the first, and an operator who wrote
        // `null` meant the agent does not get it.
        delete granted[name];
      }
    }
  }

  // Variables that hand a judged command options the command line never
  // shows: `rg pattern` with RIPGREP_CONFIG_PATH can be `rg --pre … --follow
  // pattern`, and BSD grep reads GREP_OPTIONS. The permission engine judges
  // the command as written, so what it judges has to be what runs. Withheld
  // whatever the config says.
  for (const name of COMMAND_OPTION_VARIABLES) {
    delete granted[name];
  }
  // And what a shell runs before the command: a startup file (`BASH_ENV`,
  // `ENV`, `ZDOTDIR`'s `.zshenv`) or an exported function (`BASH_FUNC_*`)
  // can define `cat` as anything. The command judged is the command run.
  for (const name of Object.keys(granted)) {
    if (SHELL_STARTUP_VARIABLES.includes(name) || name.startsWith('BASH_FUNC_')) {
      delete granted[name];
    }
  }
  // A PATH entry the agent can write to is a program the agent chose
  // running under a command name the permission engine trusts: a workspace
  // `cat` or `git` would be approved as the real one. Relative entries (`.`,
  // empty) resolve to the working directory, which is the workspace. Kept
  // out, whatever env or passEnv says; the system's own paths are unchanged.
  if (typeof granted.PATH === 'string') {
    const owned = [cwd, workspaceResolver(workspaces, workspaceRoot)?.(session.agent.id)]
      .filter((dir): dir is string => typeof dir === 'string' && dir.length > 0);
    granted.PATH = granted.PATH
      .split(':')
      .filter((entry) => entry.length > 0 && path.isAbsolute(entry) && !owned.some((dir) => {
        const relative = path.relative(dir, path.resolve(entry));
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
      }))
      .join(':');
    // An empty PATH is the current directory to `sh`, the one thing this
    // filter exists to keep out.
    if (granted.PATH.length === 0) {
      granted.PATH = '/usr/bin:/bin';
    }
  }
  // No terminal, so an editor can only hang or, named in a repository's
  // config, run a program nobody approved. `true` exits at once: git takes
  // the message it already has (or aborts an empty one) instead. The
  // environment variables win over `core.editor` and `sequence.editor`.
  granted.GIT_EDITOR = 'true';
  granted.GIT_SEQUENCE_EDITOR = 'true';
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
  /**
   * Where each agent's files go, from the host. The plugin passes its
   * `setup` context's seam through; a caller building the tool directly
   * supplies one or leaves the cwd to `workspaceRoot`.
   */
  workspaces?: AgentWorkspaces;
  /** What `~` in `cwd` expands to. Defaults to the daemon user's home. */
  home?: string;
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
      const settings = settingsFor(
        config,
        session,
        options.processEnv ?? process.env,
        options.workspaces,
        options.home,
      );
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
        args: [...startupOff(settings.shell), '-c', command],
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
      const maxOutputBytes = maxOutputBytesFor(config, context.session);
      const stdout = truncate(result.stdout, maxOutputBytes, result.stdoutTruncated);
      const stderr = truncate(result.stderr, maxOutputBytes, result.stderrTruncated);
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
    // Where the command would run, resolved the way `createCommand` resolves
    // it but without creating anything: this is asked before the call is
    // approved. A configured cwd wins, as it does there.
    cwdFor: (session: Session) => {
      const resolved = resolvePluginAgentConfig(config, session.agent.id, { mergeKeys: ['env'] });
      if (typeof resolved.cwd === 'string' && resolved.cwd.length > 0) {
        return expandHome(resolved.cwd, options.home);
      }
      const workspaceRoot = typeof resolved.workspaceRoot === 'string' ? resolved.workspaceRoot : undefined;
      return workspaceResolver(options.workspaces, workspaceRoot)?.(session.agent.id);
    },
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
    context.tools.register(createShellTool(config, {
      ...options,
      // The host's seam, unless the caller that constructed this plugin
      // already supplied one: an option passed by hand is the more specific
      // answer, the way `plugin-mcp` treats `log`.
      ...(options.workspaces === undefined && context.workspaces !== undefined
        ? { workspaces: context.workspaces }
        : {}),
    }));
  },
});

/** The loader's ABI. See `docs/architecture/plugins.md`. */
export const createPlugin = createShellPlugin;
