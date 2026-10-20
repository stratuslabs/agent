import { realpathSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_SUBPROCESS_PASS_ENV,
  leastTrusted,
  type AgentWorkspaces,
  type JsonObject,
  type JsonValue,
  type Plugin,
  type ProtectedPaths,
  type Session,
  type TrustLevel,
} from '@stratusagent/core';
import {
  defineLocalCommandTool,
  LOCAL_COMMAND_MAX_TIMEOUT_MS,
  type LocalCommandExecution,
  type LocalCommandInvocation,
  type LocalCommandTool,
} from '@stratusagent/executor-local';
import {
  allAgentWorkspaces,
  createFileLedger,
  expandHome,
  resolvePluginAgentConfig,
  workspacePreparer,
  workspaceResolver,
  type TaintedWriteLedger,
} from '@stratusagent/plugins';

import {
  relocatedCredentials,
  credentialAgentEndpoints,
  DEFAULT_DENIED_HOME_PATHS,
  DEFAULT_DENIED_SOCKETS,
  parseSandboxMode,
  planSandbox,
  spellings,
  stratusHomesFor,
  userRuntimeEndpoints,
  writableHomePathsFor,
  type SandboxPolicy,
} from './sandbox.ts';

export {
  credentialAgentEndpoints,
  relocatedCredentials,
  DEFAULT_DENIED_HOME_PATHS,
  DEFAULT_DENIED_SOCKETS,
  DEFAULT_WRITABLE_HOME_PATHS,
  bwrapArgs,
  darwinProfile,
  planSandbox,
  resetSandboxProbe,
  stratusHomesFor,
  userRuntimeEndpoints,
  type SandboxMode,
  type SandboxPolicy,
} from './sandbox.ts';

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
export const COMMAND_OPTION_VARIABLES = ['RIPGREP_CONFIG_PATH', 'GREP_OPTIONS', 'GZIP'] as const;

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

/**
 * Variables that make git use a repository other than the one the command
 * runs in, which the permission engine finds from the working directory.
 * Identity and config (`GIT_CONFIG_GLOBAL`, author names) are untouched.
 */
const GIT_REPOSITORY_VARIABLES: readonly string[] = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE',
];

/**
 * Variables that make a shell run code before the command, or read it
 * differently from the permission engine. Never passed. `CDPATH` sends a
 * relative `cd` somewhere other than the working directory the engine
 * follows it from. `BASHOPTS`, `SHELLOPTS` and `POSIXLY_CORRECT` switch on
 * shell options at startup (`cdable_vars` makes `cd HOME` follow `$HOME`).
 */
const SHELL_STARTUP_VARIABLES: readonly string[] = [
  'BASH_ENV', 'ENV', 'ZDOTDIR', 'CDPATH', 'BASHOPTS', 'SHELLOPTS', 'POSIXLY_CORRECT',
];

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
  // pattern`, BSD grep reads GREP_OPTIONS, and gzip reads GZIP (`-S x`
  // names an output file no operand does). The permission engine judges
  // the command as written, so what it judges has to be what runs. Withheld
  // whatever the config says.
  for (const name of COMMAND_OPTION_VARIABLES) {
    delete granted[name];
  }
  // And what a shell runs before the command: a startup file (`BASH_ENV`,
  // `ENV`, `ZDOTDIR`'s `.zshenv`) or an exported function (`BASH_FUNC_*`)
  // can define `cat` as anything. The command judged is the command run.
  for (const name of Object.keys(granted)) {
    if (SHELL_STARTUP_VARIABLES.includes(name) || GIT_REPOSITORY_VARIABLES.includes(name) || name.startsWith('BASH_FUNC_')) {
      delete granted[name];
    }
  }
  // A PATH entry the agent can write to is a program the agent chose
  // running under a command name the permission engine trusts: a workspace
  // `cat` or `git` would be approved as the real one. Relative entries (`.`,
  // empty) resolve to the working directory, which is the workspace. Kept
  // out, whatever env or passEnv says; the system's own paths are unchanged.
  if (typeof granted.PATH === 'string') {
    // Compared as written and through symlinks on both sides: a workspace
    // reached by an alias, or a PATH entry that is one, is the same directory.
    const owned = [cwd, workspaceResolver(workspaces, workspaceRoot)?.(session.agent.id)]
      .filter((dir): dir is string => typeof dir === 'string' && dir.length > 0)
      .flatMap((dir) => [path.resolve(dir), canonicalPath(dir)]);
    granted.PATH = granted.PATH
      .split(':')
      .filter((entry) => entry.length > 0 && path.isAbsolute(entry)
        && ![path.resolve(entry), canonicalPath(entry)].some((candidate) => owned.some((dir) => isWithin(dir, candidate))))
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
    sandbox: parseSandboxMode(resolved.sandbox),
    // The agent's own workspace, whatever cwd says: it is what the sandbox
    // leaves writable inside a Stratus home it otherwise hides.
    workspace: workspaceResolver(workspaces, workspaceRoot)?.(session.agent.id),
    // Creates it (owner-only, through the host) for the sandbox to bind.
    // Only needed when a configured cwd won: otherwise the cwd *is* the
    // prepared workspace, and it is prepared once per call.
    prepareWorkspace: configuredCwd !== undefined && workspaceFor ? () => workspaceFor(session.agent.id) : undefined,
    workspaceRoot,
    deniedPaths: asStrings(resolved.deniedPaths, []).map((entry) => expandHome(entry, home)),
    writablePaths: asStrings(resolved.writablePaths, []).map((entry) => expandHome(entry, home)),
  };
};

/**
 * The command to spawn for `shell shellArgs…`, under the sandbox unless the
 * operator turned it off. `required` refuses when no sandbox can start;
 * `auto` runs unconfined then, after saying so once per process.
 */
const sandboxed = async (
  settings: ReturnType<typeof settingsFor>,
  shellArgs: string[],
  options: ShellToolOptions,
): Promise<{ command: string; args: string[] }> => {
  const unconfined = { command: settings.shell, args: shellArgs };
  if (settings.sandbox === 'off') {
    return unconfined;
  }
  const workspace = settings.workspace ?? settings.cwd;
  if (workspace === undefined) {
    if (settings.sandbox === 'required') {
      throw new Error('shell.run is set to sandbox: "required", but this agent has no workspace to confine commands to.');
    }
    warnUnconfined(options, 'this agent has no workspace to confine commands to');
    return unconfined;
  }
  const userHome = options.home ?? os.homedir();
  const processEnv = options.processEnv ?? process.env;
  const platform = options.platform ?? process.platform;
  // The workspace is bound into the sandbox, and bwrap refuses a source
  // that does not exist; a configured cwd means nothing prepared it yet.
  if (settings.workspace !== undefined && settings.prepareWorkspace) {
    await mkdir(settings.prepareWorkspace(), { recursive: true });
  }
  // What the host protects (its home, the credential files, every soul) and
  // every other agent's workspace, each also by its real path: in the
  // surfaced layout those are links into a visible folder (`~/Stratus/<id>/`)
  // that hiding the home by name leaves readable.
  const own = new Set(spellings(workspace));
  // A configured `workspaceRoot` puts every agent's workspace under it,
  // outside the host's seam, so its other entries are listed from disk.
  // Listed the way every guard lists them: a root that is not there holds
  // no siblings, and any other failure (EACCES, EMFILE) fails the call,
  // since an empty list would leave every sibling readable.
  const underRoot = settings.workspaceRoot === undefined
    ? []
    : await allAgentWorkspaces(undefined, settings.workspaceRoot);
  const others = [...await options.workspaces?.all() ?? [], ...underRoot]
    .filter((dir) => !spellings(dir).some((spelling) => own.has(spelling)));
  const hostProtected = await options.protectedPaths?.all() ?? [];
  const policy: SandboxPolicy = {
    workspace,
    ...(settings.cwd && settings.cwd !== workspace ? { cwd: settings.cwd } : {}),
    denied: [...new Set([
      ...stratusHomesFor(workspace, processEnv, userHome),
      ...hostProtected,
      ...others,
      ...DEFAULT_DENIED_HOME_PATHS.map((entry) => path.join(userHome, entry)),
      ...DEFAULT_DENIED_SOCKETS,
      ...userRuntimeEndpoints(processEnv, process.getuid?.()),
      ...credentialAgentEndpoints(processEnv, platform),
      ...relocatedCredentials(processEnv, userHome, workspace),
      ...settings.deniedPaths,
    ].flatMap(spellings))],
    writable: [
      ...writableHomePathsFor(platform).map((entry) => path.join(userHome, entry)),
      ...settings.writablePaths,
    ],
    tmp: os.tmpdir(),
  };
  // bwrap binds only what exists, under a read-only root, so a cache
  // missing now could never be created by the command. macOS's profile
  // allows creating it, so nothing is made there ahead of use.
  if (platform === 'linux') {
    for (const dir of policy.writable) {
      await mkdir(dir, { recursive: true }).catch(() => undefined);
    }
  }
  const plan = (options.planSandbox ?? planSandbox)(policy, settings.shell, shellArgs);
  if (plan.kind === 'sandboxed') {
    return plan.command;
  }
  if (settings.sandbox === 'required') {
    throw new Error(
      `shell.run refused: commands must run sandboxed (sandbox: "required"), and ${plan.reason}. `
      + 'Fix that, or set sandbox to "off" for @stratusagent/tool-shell to run commands with the daemon user\'s full access.',
    );
  }
  warnUnconfined(options, plan.reason);
  return unconfined;
};

/** The one line `auto` owes before running unconfined, once per process. */
const warnUnconfined = (options: ShellToolOptions, reason: string): void => {
  if (unconfinedWarned) {
    return;
  }
  unconfinedWarned = true;
  (options.warn ?? ((message: string) => process.stderr.write(`${message}\n`)))(
    `tool-shell: commands run without a sandbox because ${reason}; they can read the Stratus home and your credentials. `
    + 'Set sandbox to "required" to refuse instead, or "off" to silence this.',
  );
};

let unconfinedWarned = false;

/** For tests: say the unconfined warning again. */
export const resetSandboxWarning = (): void => {
  unconfinedWarned = false;
};

const isWithin = (dir: string, candidate: string): boolean => {
  const relative = path.relative(dir, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

/**
 * Where a path really is, symlinks resolved. Walked one component at a time
 * in the order the kernel does: a symlink is followed before the `..` after
 * it, so `/alias/../bin` lands beside the link's target, not beside the link
 * (collapsing `..` first would get that wrong). A path that does not exist
 * yet resolves through its nearest existing ancestor, so a `bin` the agent
 * could still create under an aliased workspace is placed where it would land.
 */
const canonicalPath = (target: string): string => {
  const parts = (path.isAbsolute(target) ? target : `${process.cwd()}/${target}`).split('/');
  let current = '/';
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (part === '' || part === '.') continue;
    if (part === '..') {
      current = path.dirname(current);
      continue;
    }
    const next = path.join(current, part);
    try {
      current = realpathSync(next);
    } catch {
      return path.join(next, ...parts.slice(index + 1));
    }
  }
  return current;
};

export interface ShellToolOptions {
  /** Where an unconfined-shell warning goes. Defaults to the plugin context's log, then stderr. */
  warn?: (message: string) => void;
  /** For tests: how a sandbox is planned on this host. */
  planSandbox?: typeof planSandbox;
  /** For tests: the platform the sandbox is prepared for. Defaults to this one. */
  platform?: NodeJS.Platform;
  /** The environment to grant *from*. Defaults to the daemon's. */
  processEnv?: NodeJS.ProcessEnv;
  /**
   * Where each agent's files go, from the host. The plugin passes its
   * `setup` context's seam through; a caller building the tool directly
   * supplies one or leaves the cwd to `workspaceRoot`.
   */
  workspaces?: AgentWorkspaces;
  /**
   * What the host protects, `PluginContext.protectedPaths`: the sandbox
   * hides each of these by its real path as well as its name. The plugin
   * passes its `setup` context's seam through.
   */
  protectedPaths?: ProtectedPaths;
  /** What `~` in `cwd` expands to. Defaults to the daemon user's home. */
  home?: string;
  /**
   * The host's tainted-write ledger, the one `fs.read` consults. The plugin
   * opens it from the `workspaces` seam; without one nothing is looked up
   * and results stay at `unknown`.
   */
  ledger?: TaintedWriteLedger;
}

/**
 * The label a command's output can carry, given what this agent has on
 * record as written from a tainted session.
 *
 * A command can print any file it can read, and `cat notes.txt` of a page
 * saved last week must not come back cleaner than `fs.read` of it would:
 * that is the laundering the ledger exists to stop. Which files a command
 * reads cannot be told from its text (`python x.py` reads what `x.py`
 * says), so the result takes the ledger's lowest label — over-marking, the
 * safe direction the ledger already chose. Never higher than `unknown`. A
 * ledger that cannot be read is provenance nobody can vouch for, and labels
 * the result `external` rather than refusing a command that may be how the
 * operator repairs it.
 */
const recordedLabel = async (ledger: TaintedWriteLedger, agentId: string): Promise<TrustLevel> => {
  // Bounded as well, for a ledger this plugin did not open: the file ledger
  // refuses a FIFO or device before reading it, but a host-supplied one, or
  // a stalled network filesystem, could still never answer, and a command
  // must not wait on it either before it starts or after it exits. Not
  // unref'd: it is cleared below, and an unref'd bound is one a process
  // with nothing else running exits through instead of waiting out.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const snapshot = await Promise.race([
      ledger.snapshot(agentId),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), LEDGER_READ_TIMEOUT_MS);
      }),
    ]);
    return snapshot === undefined ? 'external' : leastTrusted('unknown', ...Object.values(snapshot));
  } catch {
    return 'external';
  } finally {
    clearTimeout(timer);
  }
};

/** How long a command waits for the ledger before labelling its output `external`. */
const LEDGER_READ_TIMEOUT_MS = 1_000;

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
        timeoutMs: {
          type: 'number',
          // The host's executor owns the ceiling and may set its own, so
          // this states the stock one as a default, not as the rule; a call
          // cut to whatever ceiling applies is told so in its result.
          description: 'How long to wait before killing the command, in milliseconds. '
            + `The host caps it, at ${LOCAL_COMMAND_MAX_TIMEOUT_MS} (${LOCAL_COMMAND_MAX_TIMEOUT_MS / 60_000} minutes) unless configured otherwise, and a command cut to the cap is told so. `
            + 'For work that may run longer, start it in the background with its output redirected to a file '
            + '(`long-job > job.log 2>&1 &`) and check the file in a later call.',
        },
      },
      required: ['command'],
    },
    async createCommand(input, session, context): Promise<LocalCommandInvocation> {
      const command = typeof input.command === 'string' ? input.command.trim() : '';
      if (!command) {
        throw new Error('command is required.');
      }
      // Before the process exists, so every result the executor makes from
      // here carries it: a failing command's stdout reaches the model too.
      if (options.ledger !== undefined) {
        context?.markTrust?.(await recordedLabel(options.ledger, session.agent.id));
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
      const shellArgs = [...startupOff(settings.shell), '-c', command];
      const run = await sandboxed(settings, shellArgs, options);
      return {
        command: run.command,
        args: run.args,
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
    // And again after: another turn of this agent may record a tainted
    // write while the command runs, before it reads that file. A record is
    // made before its bytes land and never clears, so the read after the
    // process exits sees every write the command could have read.
    ...(options.ledger !== undefined
      ? { settleTrust: (session: Session) => recordedLabel(options.ledger!, session.agent.id) }
      : {}),
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
    // The host's seam, unless the caller that constructed this plugin
    // already supplied one: an option passed by hand is the more specific
    // answer, the way `plugin-mcp` treats `log`.
    const workspaces = options.workspaces ?? context.workspaces;
    // The ledger follows the host's seam only, never this plugin's own
    // `workspaceRoot` or `cwd`, the way `tool-fs` and `plugin-mcp` open it:
    // relocating where commands run must not point it at a second ledger.
    // Read only here, so naming the path is enough.
    const ledgerFor = options.ledger === undefined && context.workspaces !== undefined
      ? workspaceResolver(context.workspaces, undefined)
      : undefined;
    const warn = options.warn ?? context.log;
    const protectedPaths = options.protectedPaths ?? context.protectedPaths;
    context.tools.register(createShellTool(config, {
      ...options,
      ...(protectedPaths !== undefined ? { protectedPaths } : {}),
      ...(warn !== undefined ? { warn } : {}),
      ...(workspaces !== undefined ? { workspaces } : {}),
      ...(ledgerFor !== undefined ? { ledger: createFileLedger(ledgerFor) } : {}),
    }));
  },
});

/** The loader's ABI. See `docs/architecture/plugins.md`. */
export const createPlugin = createShellPlugin;
