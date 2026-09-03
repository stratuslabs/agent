import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendFile, chmod, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import {
  AgentRunner,
  AllowAllApprovalPolicy,
  EventBus,
  SkillRegistry,
  ToolRegistry,
  matchesSkillAllowlist,
  missingSkillRequirements,
  type AgentDefinition,
  type AgentMemoryStore,
  type ApprovalPolicy,
  type AvatarTheme,
  type JsonObject,
  type JsonValue,
  type MemoryEntry,
  type ModelProvider,
  type Session,
  type StratusEvent,
} from '@stratusagent/core';
import {
  createLocalCommandExecutor,
  defineLocalCommandTool,
} from '@stratusagent/executor-local';
// Type-only: the gateway itself is imported lazily (it pulls in node:sqlite
// and the whole runner stack), and a serve-only policy seam must not make
// `stratus run` pay for it.
import type { ApprovalTransport, GatewayChannelAdapter, HomeClaim, RestartOutcome } from '@stratusagent/gateway';
import { loadPlugins, type LoadedPlugin } from '@stratusagent/plugins';
import {
  createFileCommandWhitelist,
  createPermissionPolicy,
  describeCommandScope,
  type CommandScope,
  type PermissionDecision,
} from '@stratusagent/permissions';
import {
  createOpenAICompatibleProvider,
  createProviderResponseBuilder,
  defineProvider,
} from '@stratusagent/providers';
import {
  createAnthropicProvider,
  DEFAULT_ANTHROPIC_MODEL,
  redactAnthropicRawTurns,
} from '@stratusagent/provider-anthropic';
import {
  createClaudeCodeProvider,
  hasHostedToolSideEffects,
  type ClaudeCodeToolExecutor,
} from '@stratusagent/provider-claude-code';
import { DEFAULT_CODEX_MODEL } from '@stratusagent/provider-codex';
import {
  agentIdWithSuffix,
  canonicalDestination,
  createForgetTool,
  createRecallTool,
  createRememberTool,
  defineAgent,
  describeCadence,
  describeSchedule,
  FORGET_TOOL_NAME,
  MEMORY_TOOL_NAME,
  formatSoul,
  generateAgentName,
  isLoadableSkillId,
  parseSoul,
  type ParsedSoul,
} from '@stratusagent/agents';
import {
  agentsDirPath,
  apiKeyEnvNameFor,
  claimSoulFile,
  collectAvailableModels as collectModels,
  createDemoTool,
  createFileCredentialResolver,
  createFileMemoryStore,
  createRuntimeProvider,
  credentialsPath,
  defaultApiKeyEnvName,
  DEFAULT_ANTHROPIC_BASE_URL,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_STRATUS_AGENT,
  discoverActiveConfig,
  globalConfigPath,
  loadChannelCredentials,
  loadCredentials,
  loadNamedCredentials,
  discoverSkillsInDirectory,
  installSkillsFromDirectory,
  loadOperatorSkills,
  loadRosterSouls,
  skillsDirPath,
  listAgentSummaries,
  loadSoulFile,
  memoryFilePath,
  migrateLegacyMemory,
  parseProviderName,
  readNonEmptyString,
  readProcessEnv,
  resolveConfiguredSoul,
  logsDirPath,
  readWorkingDirectory,
  resolveAgentApprovals,
  resolveEnvApiKey,
  DEFAULT_CONFIG_FILENAME,
  loadConfigFile,
  resolveConfigLocation,
  resolveRuntimeConfig as resolveStateRuntimeConfig,
  saveChannelCredentials,
  saveConfigFile,
  readTrustedConfigBlock,
  saveCredentials,
  saveNamedCredentials,
  servedRuntimes,
  CREDENTIAL_PROVIDER_NAMES,
  verifyProviderKey,
  stratusHomePath,
  withLegacyDefaultMemories,
  workspacesDirPath,
  gatewayInfoPath,
  gatewayTokenPath,
  newerStateMessage,
  pendingStateMigrations,
  readStateStamp,
  runStateMigrations,
  STATE_SCHEMA_VERSION,
  type AgentSummary,
  type ApiConfig,
  type AppliedStateMigration,
  type ApprovalsConfig,
  type CatalogModel,
  type ChannelCredentials,
  type CredentialProviderName,
  type CredentialsFile,
  type PluginsConfig,
  type RosterEntry,
  type RuntimeSelection,
  type FallbackRuntime,
  type RuntimeConfig,
  type StoredCredential,
  type StratusConfigFile,
  type StratusProviderName,
} from '@stratusagent/state';

import {
  installService,
  readServiceCommand,
  readServiceStatus,
  servicePlatform,
  serviceUnitPath,
  startService,
  stopService,
  uninstallService,
  type ServiceEnvironment,
  type ServiceRunner,
} from './service.ts';

export {
  installService,
  launchdPlist,
  readServiceCommand,
  readServiceStatus,
  servicePlatform,
  serviceUnitPath,
  startService,
  stopService,
  systemdUnit,
  uninstallService,
  SERVICE_LABEL,
  type ServiceRunner,
  type ServiceStatus,
} from './service.ts';

import {
  createLogWriter,
  currentLogPosition,
  truncateRedirectLogs,
  formatLogRecord,
  readRecentRecords,
  tailLog,
  type LogRecord,
  type LogWriter,
} from './logs.ts';

export {
  createLogWriter,
  currentLogPosition,
  truncateRedirectLogs,
  formatLogRecord,
  parseLogLines,
  readRecentRecords,
  tailLog,
  type LogRecord,
} from './logs.ts';

// The shared state package owns config resolution, credentials, memory, and
// provider wiring now (the gateway uses the same code); the CLI re-exports
// its historical surface so existing importers keep working.
export { createFileMemoryStore } from '@stratusagent/state';
export type { StoredCredential, RuntimeConfig } from '@stratusagent/state';

export interface CliStreams {
  stdout: Pick<typeof process.stdout, 'write'>;
  stderr: Pick<typeof process.stderr, 'write'>;
}

export interface CliEnvironment {
  stdin?: string;
  stdinStream?: NodeJS.ReadableStream;
  approvalInput?: NodeJS.ReadableStream;
  setupInput?: NodeJS.ReadableStream;
  processEnv?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Home directory override (tests). Defaults to os.homedir(). */
  homeDir?: string;
  fetch?: typeof fetch;
  openExternal?: (url: string) => Promise<void> | void;
  dashboardAutoShutdownMs?: number;
  /** Shuts down `stratus serve` the way SIGTERM would (tests). */
  shutdownSignal?: AbortSignal;
  /**
   * Starts the fresh daemon an announced restart asks for and resolves
   * with its exit code. Injected so tests never spawn a process; the
   * default runs this CLI's own entrypoint with the serve arguments given.
   */
  serveRespawn?: (argv: string[], handoff: RestartHandoff) => Promise<RespawnResult>;
  /**
   * The link between a supervised daemon and its supervisor (tests): what
   * the daemon sends up — the port it bound, the dashboard sessions it
   * hands on — and what it receives. The default is the IPC channel a
   * supervisor opens when it spawns a daemon, and does nothing where
   * there is none.
   */
  supervisorLink?: SupervisorLink;
  /** Ends the process at once (tests). Default `process.exit`. */
  exitProcess?: (code: number) => void;
  /** Runs launchctl/systemctl. Injected so tests never touch the real one. */
  serviceRunner?: ServiceRunner;
  /** Service-manager platform override (tests) — which unit format and manager commands apply. */
  servicePlatform?: NodeJS.Platform;
  /** Reports whether an optional package is installed. Injected so tests do not assert on their own node_modules. */
  packageResolver?: PackageResolver;
  /** Installs optional packages. Injected so tests never run npm. */
  packageInstaller?: PackageInstaller;
  /** Looks up a package's latest published version. Injected so tests never ask npm. */
  packageVersionFetcher?: PackageVersionFetcher;
}

/**
 * A dashboard session as it crosses the restart hand-off: structurally the
 * control API's `DashboardSession`, declared here rather than imported.
 * That package is an optional peer, and a type import of it is kept in
 * this package's declarations — every TypeScript consumer of the CLI would
 * then need the optional package installed just to type-check.
 */
export interface DashboardSession {
  id: string;
  /** Epoch milliseconds; a handed session keeps the expiry it was minted with. */
  expiresAt: number;
  /** A fingerprint of the bearer token it was minted under; the replacement adopts it only under the same one. */
  vouchedBy: string;
}

/** What a daemon and its supervisor say to each other. See SupervisorLink. */
export type SupervisorMessage =
  | { type: 'stratusd.bound-api-port'; port: number }
  | { type: 'stratusd.sessions'; sessions: DashboardSession[] };

/** One end of the daemon–supervisor channel. */
export interface SupervisorLink {
  send(message: SupervisorMessage): void;
  receive(handler: (message: SupervisorMessage) => void): void;
}

/**
 * What a supervisor hands the daemon it starts: the port its predecessor
 * bound (a hint, see BOUND_API_PORT_ENV) and the dashboard sessions the
 * predecessor had live when it stopped, so `stratus restart` does not log
 * a browser out. In memory end to end; nothing here is written down.
 */
export interface RestartHandoff {
  boundApiPort?: number;
  sessions: DashboardSession[];
}

/** How a daemon the supervisor started ended, and what it handed back before it did. */
export interface RespawnResult {
  code: number;
  boundApiPort?: number;
  sessions?: DashboardSession[];
}

export interface PackageInstallResult {
  ok: boolean;
  /** Why it failed, as a line the operator can act on. Empty on success. */
  message: string;
}

/** Installs optional packages globally. */
export type PackageInstaller = (packages: string[]) => Promise<PackageInstallResult>;

/** The latest published version of a package, or undefined when the registry did not answer. */
export type PackageVersionFetcher = (packageName: string) => Promise<string | undefined>;

/** How long `stratus update` waits for npm to answer a version lookup. */
export const VERSION_LOOKUP_TIMEOUT_MS = 15_000;

const defaultPackageVersionFetcher: PackageVersionFetcher = async (packageName) => {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn('npm', ['view', packageName, 'version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: npmNeedsShell(process.platform),
    });
    let stdout = '';
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    // An unreachable registry must degrade to "unknown", never hang the
    // update on someone's terminal.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(undefined);
    }, VERSION_LOOKUP_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.once('error', () => finish(undefined));
    child.once('close', (code) => finish(code === 0 && stdout.trim().length > 0 ? stdout.trim() : undefined));
  });
};

/**
 * Dotted-numeric comparison, enough for this package's own versions:
 * positive when `a` is newer than `b`. Anything unparseable in a segment
 * counts as zero rather than throwing — a weird registry answer must not
 * crash the update that would fix things.
 */
export const compareVersions = (a: string, b: string): number => {
  const parse = (value: string): number[] =>
    value.trim().replace(/^v/, '').split('.').map((part) => {
      const numeric = Number.parseInt(part, 10);
      return Number.isInteger(numeric) ? numeric : 0;
    });
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
};

/**
 * Whether spawning npm needs a shell on this platform.
 *
 * On Windows npm is `npm.cmd`, a batch file: a bare `npm` does not exist as
 * an executable there (PATHEXT is a shell's job, not spawn's), and naming
 * the `.cmd` directly has thrown EINVAL since the fix for CVE-2024-27980 —
 * both land in the caller's error handler, so a Windows setup would report
 * that it could not install and leave Slack and the dashboard missing.
 *
 * Every package name reaching the shell is a constant in this file, so
 * there is nothing user-supplied here for it to re-parse.
 */
export const npmNeedsShell = (platform: NodeJS.Platform): boolean => platform === 'win32';

const defaultPackageInstaller: PackageInstaller = async (packages) => {
  const { spawn } = await import('node:child_process');
  return new Promise<PackageInstallResult>((resolve) => {
    // npm's own output is inherited rather than captured: a global install
    // runs for tens of seconds, and a silent one is indistinguishable from
    // a setup that has hung. stdin is NOT inherited — the setup prompter
    // owns it, and two readers on one stream race for the same bytes.
    const child = spawn('npm', ['install', '-g', ...packages], {
      stdio: ['ignore', 'inherit', 'inherit'],
      shell: npmNeedsShell(process.platform),
    });
    // `error` and `close` can both fire — a spawn that fails still closes.
    let settled = false;
    const finish = (result: PackageInstallResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };
    child.once('error', (error: Error) => {
      finish({ ok: false, message: error.message });
    });
    child.once('close', (code) => {
      finish(code === 0
        ? { ok: true, message: '' }
        : { ok: false, message: `npm exited with code ${code ?? 'unknown'}` });
    });
  });
};

export interface CliRunOptions {
  argv: string[];
  streams?: CliStreams;
  env?: CliEnvironment;
}

export type CliProviderName = StratusProviderName;
export type CliApprovalMode = 'always' | 'ask' | 'never';

export interface ParsedRunCommand {
  command: 'run';
  prompt: string;
  provider?: CliProviderName;
  model?: string;
  baseUrl?: string;
  configPath?: string;
  /** Path to a soul file defining the agent to run as. */
  soul?: string;
  format: 'text' | 'json';
  events: boolean;
  approvals: CliApprovalMode;
  maxTurns?: number;
}

export interface ParsedDashboardCommand {
  command: 'dashboard';
  port?: number;
  /**
   * Present only when `--host` was actually given.
   *
   * A defaulted string here would be indistinguishable from an explicit
   * `--host 127.0.0.1`, and the two mean opposite things when a trusted
   * config says `api.host: "0.0.0.0"`: absent means "let the config decide",
   * while explicit means "bind loopback, whatever the config says". Collapsing
   * them exposed the API on every interface to an operator who had just asked
   * for the opposite.
   */
  host?: string;
  openBrowser: boolean;
}

export interface ParsedSetupCommand {
  command: 'setup';
  configPath?: string;
}

export interface ParsedAgentNewCommand {
  command: 'agent-new';
  name?: string;
  instructions?: string;
  format: 'text' | 'json' | 'soul';
}

export interface ParsedChatCommand {
  command: 'chat';
  provider?: CliProviderName;
  model?: string;
  baseUrl?: string;
  configPath?: string;
  /** Path to a soul file defining the agent to chat with. */
  soul?: string;
  events: boolean;
  approvals: CliApprovalMode;
  maxTurns?: number;
}

export interface ParsedSkillAddCommand {
  command: 'skill-add';
  /** A GitHub `owner/repo`, a git URL, or a local path. */
  source: string;
  /** Install only these ids (repeatable --skill). */
  skillIds?: string[];
  /** Replace an already-installed id instead of refusing it. */
  force?: boolean;
  /** Enable the installed skills in this agent's soul afterwards. */
  agentId?: string;
  /** Tell a running daemon to reload its skills afterwards. Default true; `--no-reload` sets false. */
  reload?: boolean;
}

export interface ParsedSkillValidateCommand {
  command: 'skill-validate';
  /** A skill directory, a directory of skills, or an installed skill's id. */
  target: string;
}

export interface ParsedSkillsCommand {
  command: 'skills';
}

export interface ParsedCredentialCommand {
  command: 'credential';
  action: 'set' | 'list' | 'remove';
  /** The credential name — `search.apiKey` and whatever the ecosystem asks for next. */
  name?: string;
  /** Store or remove this agent's own entry rather than the fleet's shared one. */
  agentId?: string;
}

export interface ParsedSkillReloadCommand {
  command: 'skill-reload';
  /** A daemon's control API URL; default: the one `~/.stratus/gateway.json` names. */
  gateway?: string;
  token?: string;
}

export interface ParsedRestartCommand {
  command: 'restart';
  /** For the daemon's log. */
  reason?: string;
  /** How long the daemon lets in-flight turns finish, in milliseconds. */
  drainTimeoutMs?: number;
  gateway?: string;
  token?: string;
}

export interface ParsedAgentsCommand {
  command: 'agents';
  format: 'text' | 'json';
  /**
   * Ask a running gateway instead of resolving locally. The first
   * remote-consuming command: the same listing, rendered from the control
   * API's answer rather than from this machine's files.
   */
  gateway?: string;
  /** Bearer token override, for a gateway whose token file is not local. */
  token?: string;
}

export interface ParsedSchedulesCommand {
  command: 'schedules';
  action: 'list' | 'cancel';
  /** cancel only: which schedule. */
  scheduleId?: string;
  format: 'text' | 'json';
}

export interface ParsedDoctorCommand {
  command: 'doctor';
  format: 'text' | 'json';
  configPath?: string;
}

export interface ParsedUpdateCommand {
  command: 'update';
  /** Report what an update would do — version, migrations, unit health — without doing any of it. */
  check: boolean;
}

export interface ParsedServiceCommand {
  command: 'service';
  action: 'install' | 'uninstall' | 'status' | 'start' | 'stop';
  /** install only: start automatically at login. Defaults to true. */
  runAtLogin?: boolean;
  /** install only: the config the managed daemon should load. */
  configPath?: string;
}

export interface ParsedLogsCommand {
  command: 'logs';
  /** Keep streaming new records instead of exiting after the backlog. */
  follow: boolean;
  /** How many recent records to show before following. */
  limit: number;
  agentId?: string;
  sessionId?: string;
  format: 'text' | 'json';
}

export type ServeApprovalMode = 'headless' | 'remote';

export interface ParsedServeCommand {
  command: 'serve';
  configPath?: string;
  /** Overrides `approvals.mode` in the config file. */
  approvals?: ServeApprovalMode;
  /** Watchdog idle timeout in milliseconds. 0 disables. */
  idleTimeoutMs?: number;
  events: boolean;
  /** Write the structured log to ~/.stratus/logs. Defaults to true. */
  logToFile?: boolean;
  /** Serve the control API. Defaults to true when the package is installed. */
  api?: boolean;
  /** Overrides `api.port` in the config file. */
  apiPort?: number;
  /** Overrides `api.host` in the config file. */
  apiHost?: string;
}

export interface ParsedHelpCommand {
  command: 'help';
}

export type ParsedCommand =
  | ParsedRunCommand
  | ParsedChatCommand
  | ParsedDashboardCommand
  | ParsedSetupCommand
  | ParsedAgentNewCommand
  | ParsedAgentsCommand
  | ParsedSkillAddCommand
  | ParsedSkillValidateCommand
  | ParsedSkillsCommand
  | ParsedSkillReloadCommand
  | ParsedCredentialCommand
  | ParsedRestartCommand
  | ParsedSchedulesCommand
  | ParsedDoctorCommand
  | ParsedLogsCommand
  | ParsedUpdateCommand
  | ParsedServiceCommand
  | ParsedServeCommand
  | ParsedHelpCommand;

type CliConfigFile = StratusConfigFile;

export const CLI_VERSION = '0.10.0';

const DASHBOARD_TITLE = 'Stratus Agent Dashboard';

/**
 * The range every package declares in its `engines` field. Two floors, not
 * one: `node:sqlite` was unflagged in 22.13.0 on the LTS line and in 23.4.0
 * on the 23.x line, so 23.0 through 23.3 are NEWER than the 22.x floor and
 * still ship it behind `--experimental-sqlite`. A plain `>=22.13` admits
 * exactly those releases.
 */
export const SUPPORTED_NODE_RANGE = '>=22.13 <23 || >=23.4';

/**
 * Why the CLI checks a version its manifests already declare: `engines` is
 * advisory. npm and pnpm print EBADENGINE and carry on unless the user has
 * turned on engine-strict, so an install on Node 20 succeeds and the floor
 * is discovered later as an ERR_UNKNOWN_BUILTIN_MODULE for `node:sqlite`,
 * thrown from a lazy import inside whichever command first needed the
 * session store. That error names neither Node nor the version required.
 *
 * Returns the message to print, or undefined when the version is fine —
 * including when it cannot be parsed at all, since an unrecognized build
 * string is a bad reason to refuse to run.
 */
export const unsupportedNodeMessage = (version: string): string | undefined => {
  const parts = version.replace(/^v/, '').split('.');
  const major = Number.parseInt(parts[0] ?? '', 10);
  const minor = Number.parseInt(parts[1] ?? '', 10);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) {
    return undefined;
  }
  const supported = major > 23
    || (major === 23 && minor >= 4)
    || (major === 22 && minor >= 13);
  if (supported) {
    return undefined;
  }
  return `Stratus Agent needs Node 22.13 or newer, and 23.4 or newer on the 23.x line — this is Node ${version.replace(/^v/, '')}.\n`
    + "The gateway's session store uses node:sqlite, unflagged in 22.13.0 and, on the 23.x line, not until 23.4.0.\n"
    + 'Upgrade with `brew install node` on macOS, or your package manager or nvm on Linux.';
};

/**
 * The warning listeners to install in place of Node's default one, so the
 * `node:sqlite` ExperimentalWarning stops being the first thing the CLI
 * prints.
 *
 * The session store imports `node:sqlite`, which is experimental on every
 * Node release this supports — that is exactly why
 * {@link SUPPORTED_NODE_RANGE} is written the way it is — so the warning
 * announces a dependency the project chose deliberately and a user can do
 * nothing about. It landed above `stratusd ready` on every `stratus serve`,
 * and on `stratus schedules`.
 *
 * Filtered rather than silenced wholesale (`--no-warnings` would be the
 * blunt version): every other warning still reaches stderr through the
 * listeners passed in, because a deprecation in our own dependencies is
 * ours to act on.
 */
export const withoutSqliteExperimentalWarning = (
  listeners: readonly ((warning: Error) => void)[],
): ((warning: Error) => void) => (warning) => {
  if (warning.name === 'ExperimentalWarning' && /\bSQLite\b/i.test(warning.message)) {
    return;
  }
  for (const listener of listeners) {
    listener(warning);
  }
};

/**
 * The name Node gives its own `warning` printer. Matched rather than assumed
 * so that a Node which renames it simply stops being filtered — the warning
 * comes back, which is noise, where guessing wrong would rewrite somebody
 * else's listener.
 */
const NODE_DEFAULT_WARNING_LISTENER = 'onWarning';

/**
 * Swap Node's default warning printer for the filtered one above.
 *
 * Node installs its printer as an ordinary `warning` listener, so adding one
 * alongside it would print twice rather than filter; the default has to come
 * off and be handed to the replacement.
 *
 * **Only ever Node's own printer.** Wrapping a listener somebody else
 * registered changes it in two ways that are not ours to change: `listeners()`
 * hands back the *unwrapped* function for a `once` listener, so re-registering
 * it makes it permanent — it then runs for every later warning instead of one
 * — and a caller that keeps a reference can no longer `process.off('warning',
 * theirs)`, because what is registered is this wrapper. So when anything other
 * than the default is present — a `--require` preload, an embedding host — this
 * does nothing at all and the warning stays. A host that took an interest in
 * warnings owns them.
 *
 * Called once from the binary, before anything imports the session store.
 */
export const filterSqliteExperimentalWarning = (process_: NodeJS.EventEmitter = process): void => {
  // rawListeners, not listeners: the wrapper is the registration, and only it
  // carries the once-ness. It matters even here, where the guard below means
  // the sole listener is Node's own — the next reader should not have to know
  // that to see why this is safe.
  const existing = process_.rawListeners('warning') as ((warning: Error) => void)[];
  const [only] = existing;
  if (existing.length !== 1 || only?.name !== NODE_DEFAULT_WARNING_LISTENER) {
    return;
  }
  process_.removeAllListeners('warning');
  process_.on('warning', withoutSqliteExperimentalWarning([only]));
};

const HELP_TEXT = `Stratus Agent CLI

Usage:
  stratus setup
  stratus chat
  stratus chat --soul ./examples/souls/ava.md
  stratus run --prompt "Use the demo tool"
  stratus run "Say hello"
  ANTHROPIC_API_KEY=... stratus run --provider anthropic "Say hello"
  stratus run --soul ./examples/souls/ava.md "Say hello"
  echo "Use the echo tool" | stratus run --stdin
  STRATUS_PROVIDER=openai OPENAI_API_KEY=... stratus run "Say hello"
  stratus run --config ./stratus.config.json --provider openai "Say hello"
  stratus agents
  stratus agents --gateway http://127.0.0.1:4123
  stratus skill add stratuslabs/skill-code-review
  stratus skill add ./my-skills --skill code-review --agent ava
  stratus skill validate ./my-skill
  stratus skills
  stratus skill reload
  stratus restart
  stratus schedules
  stratus schedules cancel <id>
  printf %s "$BRAVE_KEY" | stratus credential set search.apiKey
  stratus credentials
  stratus doctor
  stratus update
  stratus update --check
  stratus service install
  stratus service status
  stratus logs -f
  stratus logs --agent ava -n 200
  stratus dashboard
  stratus dashboard --port 4123 --host 0.0.0.0 --no-open

Commands:
  setup            Menu-driven onboarding: pick a provider, sign in (Claude
                   subscription or API key), create your agent, connect it to
                   Slack, and test it — settings go to ~/.stratus/config.json,
                   sign-ins and channel tokens to ~/.stratus/credentials.json
                   (0600). Save & finish offers to install any optional
                   package your answers imply (the Slack channel, the control
                   API and dashboard) before it starts the daemon
  chat             Talk with your agent — the conversation persists across turns
                   and remembered facts accumulate; /exit or Ctrl+C to leave
  run              Execute one local Stratus Agent session
  serve            Run stratusd, the always-on gateway: durable sessions, the
                   whole roster live at once (each agent on its own provider),
                   delegation, and a watchdog — one per home (it refuses to
                   start over a daemon already serving ~/.stratus), and
                   Ctrl+C / SIGTERM drains cleanly
                   (--idle-timeout <seconds>, --approvals <headless|remote>,
                   --no-events, --no-log-file, --config <path>); everything it
                   says is also written to ~/.stratus/logs, which
                   "stratus logs" reads. With @stratusagent/control-api
                   installed it also serves the HTTP + WebSocket control API
                   on 127.0.0.1:4123 (--no-api, --api-host, --api-port, or
                   the config file's "api" block)
  service          Keep stratusd running under launchd (macOS) or systemd
                   (Linux): install, uninstall, status, start, stop.
                   Installing starts it now and at every login
                   (--no-login installs without the login trigger,
                   --config <path> pins the daemon to one config file)
  logs             Read the daemon's log from any terminal: -f to follow,
                   -n <count> for backlog, --agent / --session to filter,
                   --format json for the raw records
  skill add        Install skills from a GitHub repo (owner/repo or URL) or a
                   local path into ~/.stratus/skills — whole directories, one
                   per skill; works with skills published for other agents
                   (skills.sh-style repos). Installed is not enabled: a soul
                   opts in via skills:, or pass --agent <id> to enable now.
                   --skill <id> picks from a multi-skill repo (repeatable),
                   --force replaces an already-installed id. A skill that
                   does not conform to the Agent Skills spec is refused,
                   naming what is wrong; one that installs with caveats
                   (fields another host owns, a bundled scripts/) says so.
                   A running daemon reloads its skills afterwards, no
                   restart (--no-reload skips that)
  skill validate   Check a skill directory, a directory of skills, or an
                   installed skill id against the Agent Skills spec — the
                   same check "skill add" runs, so what validates installs.
                   Exit 1 if anything would be refused
  skills           List installed skills and which agents enable each
                   (also: stratus skill list)
  skill reload     Ask the running daemon to re-read ~/.stratus/skills — for a
                   skill edited or removed by hand. A skill that will not
                   load refuses the whole reload and the previous set keeps
                   serving; nothing becomes reachable to an agent whose soul
                   does not list it
  restart          Ask the running daemon for an announced restart — what a
                   plugin change needs: it refuses new turns, lets in-flight
                   ones finish for up to --drain-timeout <seconds> (default
                   30), then comes back with sessions, schedules, and
                   channels intact, under the service manager or not
  credential set   Store a named credential an agent can resolve — a search
                   backend asks for search.apiKey. The value is read from
                   stdin, never from a flag, so it stays out of your shell
                   history: printf %s "$KEY" | stratus credential set
                   search.apiKey. --agent <id> stores one agent's own key,
                   which outranks the shared entry for that agent. Storing
                   grants nothing: the soul still needs credentials: [name]
  credentials      List stored credential names and which agents have their
                   own — names only, never values (also: credential list)
  credential remove
                   Forget one (--agent <id> for that agent's own entry)
  schedules        List every schedule the fleet has set — cadence, prompt,
                   pre-authorized destination, next firing — straight from the
                   daemon's database (--format json). "stratus schedules
                   cancel <id>" stops the next firing and revokes the
                   destination that was approved with it
                   (also: stratus schedule list / schedule cancel <id>)
  agent new        Create an agent identity (generates a human-ish name + avatar theme)
  agents           List your agents: who they are, where their souls live, what
                   they run on, what they remember (also: stratus agent list).
                   --gateway <url> asks a running daemon instead of resolving
                   locally, authenticating with ~/.stratus/gateway-token
                   (override with --token or STRATUS_GATEWAY_TOKEN)
  doctor           Show what a run would use right now — provider, model, soul —
                   and which file or environment variable decided each, then
                   flag anything that would surprise you (--format json)
  update           The whole upgrade dance, in the order that cannot lose
                   data: stop stratusd, upgrade the package from npm, run
                   pending state migrations, rewrite the service unit with
                   current node/entrypoint paths, restart. --check reports
                   what it would do without doing any of it (exits 1 when
                   something is actionable). Works offline too — an
                   unreachable npm skips the upgrade but still migrates and
                   repairs the unit
  dashboard        Open the web dashboard: finds a running daemon (or starts one),
                   mints a single-use sign-in link, and opens your browser at it.
                   Needs @stratusagent/control-api and @stratusagent/dashboard
  help             Show this help message

Agent options:
  --name           Agent name (omit to have one generated)
  --instructions   The agent's persona/instructions
  --format         Output format for agent new: text, json, or soul (a ready-to-edit soul file)

Options:
  --prompt, -p     Prompt to send to the local agent loop
  --stdin          Read the prompt from stdin
  --provider       Provider to use: anthropic, openai, codex, or demo
  --model          Model name for real providers (anthropic default: ${DEFAULT_ANTHROPIC_MODEL}, openai default: gpt-4.1-mini, codex default: ${DEFAULT_CODEX_MODEL})
  --base-url       Override the provider API base URL
  --soul           Run as the agent defined by a soul file (markdown + frontmatter, see examples/souls)
  --config         Config file path (run: load settings from it, setup: write it)
  --format         Output format: text or json (default: text)
  --no-events      Hide event-by-event progress lines in text mode
  --approvals      run/chat: tool approval mode — always, ask, or never (default: always)
                   serve: how the daemon reaches a human — headless (refuse every
                   gated call) or remote (ask in Slack). Default headless, or
                   the config file's "approvals.mode"
  --max-turns      Maximum provider turns per run (default: 8)
  --port           dashboard: port for a daemon it starts (default: 4123)
  --host           dashboard: host for a daemon it starts (default: 127.0.0.1)
  --no-open        Do not open the browser automatically
  --gateway        agents / skill reload / restart: a running daemon's control
                   API (skill reload and restart default to the daemon
                   ~/.stratus/gateway.json names)
  --token          Bearer token for --gateway (default: ~/.stratus/gateway-token)
  --no-reload      skill add: install without reloading a running daemon
  --reason         restart: why, for the daemon's log
  --drain-timeout  restart: seconds the daemon lets in-flight turns finish
                   before aborting them (default: 30)
  --no-api         serve: do not serve the control API
  --api            serve: serve it even where the config says api.enabled: false
  --api-host       serve: control API interface (default: 127.0.0.1)
  --api-port       serve: control API port (default: 4123, 0 for any free port)
  --help, -h       Show this help message

Config file:
  The CLI looks for ./stratus.config.json first, then a path from --config / STRATUS_CONFIG,
  then the global ~/.stratus/config.json written by \`stratus setup\`.
  A "soul" key (or STRATUS_SOUL) points at a soul file so every run uses that agent.

Plugins (tools):
  Capability is optional: install a package, then list it under "plugins" in a
  TRUSTED config (--config, STRATUS_CONFIG, or ~/.stratus/config.json), keyed by
  package name. A plugin runs inside this process, so an auto-discovered
  project-local stratus.config.json may not enable one.

    "plugins": {
      "@stratusagent/tool-fs": { "enabled": true, "roots": ["~/notes"],
                                 "agents": { "ava": { "roots": ["~/work/ava"] } } },
      "@stratusagent/tool-web": { "enabled": true }
    }

  Available: @stratusagent/tool-fs (fs.read/list/search/write),
  @stratusagent/tool-shell (shell.run), @stratusagent/tool-web (web.fetch),
  @stratusagent/tool-browser (browser.goto/read/screenshot/act).
  Installing one grants no agent anything — each soul lists what it may call.

Soul files:
  A soul file is markdown with frontmatter (name, provider, model, tools, skills, credentials)
  followed by the agent's persona in prose. See examples/souls/ava.md.
  "tools" takes exact names or a whole toolset: tools: [fs.read, fs.search] or
  tools: [fs.*]. Omitted means every registered tool.
  "skills" is the same allowlist shape over installed skills (see stratus
  skills), except omitted means none — a skill is enabled per agent, never
  by being installed.
`;

const writeLine = (stream: Pick<typeof process.stdout, 'write'>, line = ''): void => {
  stream.write(`${line}\n`);
};

const stringifyValue = (value: JsonValue): string => {
  if (typeof value === 'string') {
    return value;
  }

  return JSON.stringify(value, null, 2);
};


const readPromptFromEnvironment = (env: CliEnvironment): string => (env.stdin ?? '').trim();

const readPromptFromStdin = async (stdin: NodeJS.ReadableStream): Promise<string> => {
  stdin.setEncoding('utf8');

  let data = '';
  for await (const chunk of stdin) {
    data += chunk;
  }

  return data.trim();
};

const readOptionValue = (tokens: string[], index: number, flag: string): string => {
  const value = tokens[index + 1];
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
};

export const parseCommand = (argv: string[], env: CliEnvironment = {}): ParsedCommand => {
  const [command, ...rest] = argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return { command: 'help' };
  }

  if (command === 'dashboard') {
    let port: number | undefined;
    let host: string | undefined;
    let openBrowser = true;

    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (!token) {
        continue;
      }
      if (token === '--help' || token === '-h') {
        return { command: 'help' };
      }
      if (token === '--port') {
        const value = Number(readOptionValue(rest, index, '--port'));
        if (!Number.isInteger(value) || value < 0 || value > 65535) {
          throw new Error(`Invalid value for --port: ${rest[index + 1] ?? '(missing)'}`);
        }
        port = value;
        index += 1;
        continue;
      }
      if (token === '--host') {
        host = readOptionValue(rest, index, '--host');
        index += 1;
        continue;
      }
      if (token === '--no-open') {
        openBrowser = false;
        continue;
      }
      throw new Error(`Unknown option: ${token}`);
    }

    return {
      command: 'dashboard',
      ...(port !== undefined ? { port } : {}),
      ...(host !== undefined ? { host } : {}),
      openBrowser,
    };
  }

  if (command === 'serve') {
    const parsed: ParsedServeCommand = { command: 'serve', events: true };
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (!token) {
        continue;
      }
      if (token === '--help' || token === '-h') {
        return { command: 'help' };
      }
      if (token === '--config') {
        parsed.configPath = readOptionValue(rest, index, '--config');
        index += 1;
        continue;
      }
      if (token === '--idle-timeout') {
        const seconds = Number(readOptionValue(rest, index, '--idle-timeout'));
        if (!Number.isFinite(seconds) || seconds < 0) {
          throw new Error(`Invalid value for --idle-timeout: ${rest[index + 1] ?? '(missing)'}`);
        }
        parsed.idleTimeoutMs = Math.round(seconds * 1000);
        index += 1;
        continue;
      }
      if (token === '--approvals') {
        const value = readOptionValue(rest, index, '--approvals');
        if (value !== 'headless' && value !== 'remote') {
          throw new Error(`Unsupported approvals mode: ${value}. Use headless or remote.`);
        }
        parsed.approvals = value;
        index += 1;
        continue;
      }
      if (token === '--no-events') {
        parsed.events = false;
        continue;
      }
      if (token === '--no-log-file') {
        parsed.logToFile = false;
        continue;
      }
      if (token === '--no-api') {
        parsed.api = false;
        continue;
      }
      if (token === '--api') {
        parsed.api = true;
        continue;
      }
      if (token === '--api-port') {
        const port = Number(readOptionValue(rest, index, '--api-port'));
        if (!Number.isInteger(port) || port < 0 || port > 65_535) {
          throw new Error(`Invalid value for --api-port: ${rest[index + 1] ?? '(missing)'}`);
        }
        parsed.apiPort = port;
        index += 1;
        continue;
      }
      if (token === '--api-host') {
        parsed.apiHost = readOptionValue(rest, index, '--api-host');
        index += 1;
        continue;
      }
      throw new Error(`Unknown option: ${token}`);
    }
    return parsed;
  }

  if (command === 'chat') {
    const parsed: ParsedChatCommand = { command: 'chat', events: false, approvals: 'always' };
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (!token) {
        continue;
      }
      if (token === '--help' || token === '-h') {
        return { command: 'help' };
      }
      if (token === '--provider') {
        parsed.provider = parseProviderName(readOptionValue(rest, index, '--provider'), '--provider');
        index += 1;
        continue;
      }
      if (token === '--model') {
        parsed.model = readOptionValue(rest, index, '--model');
        index += 1;
        continue;
      }
      if (token === '--base-url') {
        parsed.baseUrl = readOptionValue(rest, index, '--base-url');
        index += 1;
        continue;
      }
      if (token === '--soul') {
        parsed.soul = readOptionValue(rest, index, '--soul');
        index += 1;
        continue;
      }
      if (token === '--config') {
        parsed.configPath = readOptionValue(rest, index, '--config');
        index += 1;
        continue;
      }
      if (token === '--approvals') {
        const value = readOptionValue(rest, index, '--approvals');
        if (value !== 'always' && value !== 'ask' && value !== 'never') {
          throw new Error(`Invalid value for --approvals: ${value}`);
        }
        parsed.approvals = value;
        index += 1;
        continue;
      }
      if (token === '--max-turns') {
        const value = Number(readOptionValue(rest, index, '--max-turns'));
        if (!Number.isInteger(value) || value < 1) {
          throw new Error(`Invalid value for --max-turns: ${rest[index + 1] ?? '(missing)'}`);
        }
        parsed.maxTurns = value;
        index += 1;
        continue;
      }
      if (token === '--events') {
        parsed.events = true;
        continue;
      }
      throw new Error(`Unknown option: ${token}`);
    }
    return parsed;
  }

  if (command === 'agents' || (command === 'agent' && rest[0] === 'list')) {
    const agentsRest = command === 'agents' ? rest : rest.slice(1);
    let format: 'text' | 'json' = 'text';
    let gateway: string | undefined;
    let token: string | undefined;
    for (let index = 0; index < agentsRest.length; index += 1) {
      const argument = agentsRest[index];
      if (!argument) {
        continue;
      }
      if (argument === '--help' || argument === '-h') {
        return { command: 'help' };
      }
      if (argument === '--format') {
        const value = readOptionValue(agentsRest, index, '--format');
        if (value !== 'text' && value !== 'json') {
          throw new Error(`Unsupported format: ${value}`);
        }
        format = value;
        index += 1;
        continue;
      }
      if (argument === '--gateway') {
        gateway = readOptionValue(agentsRest, index, '--gateway');
        index += 1;
        continue;
      }
      if (argument === '--token') {
        token = readOptionValue(agentsRest, index, '--token');
        index += 1;
        continue;
      }
      throw new Error(`Unknown option: ${argument}`);
    }
    if (token !== undefined && gateway === undefined) {
      throw new Error('--token only applies with --gateway.');
    }
    return {
      command: 'agents',
      format,
      ...(gateway ? { gateway } : {}),
      ...(token ? { token } : {}),
    };
  }

  if (command === 'schedules' || (command === 'schedule' && rest[0] === 'list') || (command === 'schedule' && rest[0] === 'cancel')) {
    const schedulesRest = command === 'schedules' ? rest : rest.slice(1);
    const action = (command === 'schedule' ? rest[0] : schedulesRest[0]) === 'cancel' ? 'cancel' : 'list';
    const tokens = action === 'cancel' && command === 'schedules' ? schedulesRest.slice(1) : schedulesRest;
    let format: 'text' | 'json' = 'text';
    let scheduleId: string | undefined;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (!token || (action === 'list' && token === 'list' && index === 0)) {
        continue;
      }
      if (token === '--help' || token === '-h') {
        return { command: 'help' };
      }
      if (token === '--format') {
        const value = readOptionValue(tokens, index, '--format');
        if (value !== 'text' && value !== 'json') {
          throw new Error(`Unsupported format: ${value}`);
        }
        format = value;
        index += 1;
        continue;
      }
      if (token.startsWith('--')) {
        throw new Error(`Unknown option: ${token}`);
      }
      if (action === 'cancel' && scheduleId === undefined) {
        scheduleId = token;
        continue;
      }
      throw new Error(`Unexpected argument: ${token}. Try: stratus schedules, stratus schedules cancel <id>`);
    }
    if (action === 'cancel' && !scheduleId) {
      throw new Error('schedules cancel needs the schedule id: stratus schedules cancel <id>.');
    }
    return {
      command: 'schedules',
      action,
      ...(scheduleId ? { scheduleId } : {}),
      format,
    };
  }

  if (command === 'doctor') {
    let format: 'text' | 'json' = 'text';
    let configPath: string | undefined;
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (!token) {
        continue;
      }
      if (token === '--help' || token === '-h') {
        return { command: 'help' };
      }
      if (token === '--format') {
        const value = readOptionValue(rest, index, '--format');
        if (value !== 'text' && value !== 'json') {
          throw new Error(`Unsupported format: ${value}`);
        }
        format = value;
        index += 1;
        continue;
      }
      if (token === '--config') {
        configPath = readOptionValue(rest, index, '--config');
        index += 1;
        continue;
      }
      throw new Error(`Unknown option: ${token}`);
    }
    return { command: 'doctor', format, ...(configPath ? { configPath } : {}) };
  }

  if (command === 'update') {
    let check = false;
    for (const token of rest) {
      if (!token) {
        continue;
      }
      if (token === '--help' || token === '-h') {
        return { command: 'help' };
      }
      if (token === '--check') {
        check = true;
        continue;
      }
      throw new Error(`Unknown option: ${token}`);
    }
    return { command: 'update', check };
  }

  if (command === 'service') {
    const action = rest[0];
    if (action === '--help' || action === '-h' || action === undefined) {
      return { command: 'help' };
    }
    if (action !== 'install' && action !== 'uninstall' && action !== 'status' && action !== 'start' && action !== 'stop') {
      throw new Error(`Unknown service action: ${action} (expected install, uninstall, status, start, or stop)`);
    }
    const parsed: ParsedServiceCommand = { command: 'service', action };
    const serviceRest = rest.slice(1);
    for (let index = 0; index < serviceRest.length; index += 1) {
      const token = serviceRest[index];
      if (!token) {
        continue;
      }
      if (token === '--help' || token === '-h') {
        return { command: 'help' };
      }
      if (token === '--no-login') {
        if (action !== 'install') {
          throw new Error('--no-login applies to `stratus service install`.');
        }
        parsed.runAtLogin = false;
        continue;
      }
      if (token === '--config') {
        if (action !== 'install') {
          throw new Error('--config applies to `stratus service install`.');
        }
        parsed.configPath = readOptionValue(serviceRest, index, '--config');
        index += 1;
        continue;
      }
      throw new Error(`Unknown option: ${token}`);
    }
    return parsed;
  }

  if (command === 'logs') {
    let follow = false;
    let limit = 50;
    let agentId: string | undefined;
    let sessionId: string | undefined;
    let format: 'text' | 'json' = 'text';
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (!token) {
        continue;
      }
      if (token === '--help' || token === '-h') {
        return { command: 'help' };
      }
      if (token === '--follow' || token === '-f') {
        follow = true;
        continue;
      }
      if (token === '--lines' || token === '-n') {
        const value = Number(readOptionValue(rest, index, token));
        if (!Number.isFinite(value) || value < 0) {
          throw new Error(`Invalid value for ${token}: ${rest[index + 1] ?? '(missing)'}`);
        }
        limit = Math.floor(value);
        index += 1;
        continue;
      }
      if (token === '--agent') {
        agentId = readOptionValue(rest, index, '--agent');
        index += 1;
        continue;
      }
      if (token === '--session') {
        sessionId = readOptionValue(rest, index, '--session');
        index += 1;
        continue;
      }
      if (token === '--format') {
        const value = readOptionValue(rest, index, '--format');
        if (value !== 'text' && value !== 'json') {
          throw new Error(`Unsupported format: ${value}`);
        }
        format = value;
        index += 1;
        continue;
      }
      throw new Error(`Unknown option: ${token}`);
    }
    return {
      command: 'logs',
      follow,
      limit,
      format,
      ...(agentId ? { agentId } : {}),
      ...(sessionId ? { sessionId } : {}),
    };
  }

  if (command === 'credentials' || command === 'credential') {
    const [subcommand, ...credentialRest] = command === 'credentials' ? ['list', ...rest] : rest;
    if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
      return { command: 'help' };
    }
    if (subcommand !== 'set' && subcommand !== 'list' && subcommand !== 'remove') {
      throw new Error(`No credential subcommand named ${JSON.stringify(subcommand)}. It is set, list, or remove.`);
    }
    let name: string | undefined;
    let agentId: string | undefined;
    for (let index = 0; index < credentialRest.length; index += 1) {
      const token = credentialRest[index];
      if (!token) {
        continue;
      }
      if (token === '--help' || token === '-h') {
        return { command: 'help' };
      }
      if (token === '--agent') {
        agentId = readOptionValue(credentialRest, index, '--agent');
        index += 1;
        continue;
      }
      if (token.startsWith('--')) {
        throw new Error(`Unknown option: ${token}`);
      }
      if (name !== undefined) {
        throw new Error(`credential ${subcommand} takes one credential name; got both ${JSON.stringify(name)} and ${JSON.stringify(token)}.`);
      }
      name = token;
    }
    if (subcommand !== 'list' && name === undefined) {
      throw new Error(`credential ${subcommand} needs a credential name — for a search backend that is search.apiKey.`);
    }
    return {
      command: 'credential',
      action: subcommand,
      ...(name !== undefined ? { name } : {}),
      ...(agentId !== undefined ? { agentId } : {}),
    };
  }

  if (command === 'skills' || (command === 'skill' && rest[0] === 'list')) {
    const skillsRest = command === 'skills' ? rest : rest.slice(1);
    for (const token of skillsRest) {
      if (token === '--help' || token === '-h') {
        return { command: 'help' };
      }
      throw new Error(`Unknown option: ${token}`);
    }
    return { command: 'skills' };
  }

  if (command === 'skill') {
    const [subcommand, ...skillRest] = rest;
    if (subcommand === '--help' || subcommand === '-h') {
      return { command: 'help' };
    }
    if (subcommand === 'validate') {
      let target: string | undefined;
      for (const token of skillRest) {
        if (token === '--help' || token === '-h') {
          return { command: 'help' };
        }
        if (token.startsWith('--')) {
          throw new Error(`Unknown option: ${token}`);
        }
        if (target !== undefined) {
          throw new Error(`skill validate takes one target; got both ${JSON.stringify(target)} and ${JSON.stringify(token)}.`);
        }
        target = token;
      }
      if (target === undefined) {
        throw new Error('skill validate needs a target: a skill directory, a directory of skills, or an installed skill id.');
      }
      return { command: 'skill-validate', target };
    }
    if (subcommand === 'reload') {
      const parsed: ParsedSkillReloadCommand = { command: 'skill-reload' };
      for (let index = 0; index < skillRest.length; index += 1) {
        const token = skillRest[index];
        if (!token) {
          continue;
        }
        if (token === '--help' || token === '-h') {
          return { command: 'help' };
        }
        if (token === '--gateway') {
          parsed.gateway = readOptionValue(skillRest, index, '--gateway');
          index += 1;
          continue;
        }
        if (token === '--token') {
          parsed.token = readOptionValue(skillRest, index, '--token');
          index += 1;
          continue;
        }
        throw new Error(`Unknown option: ${token}`);
      }
      return parsed;
    }
    if (subcommand !== 'add') {
      throw new Error(`Unknown skill subcommand: ${subcommand ?? '(missing)'}. Try: stratus skill add <source>, stratus skill validate <path>, stratus skill reload, stratus skills`);
    }

    let source: string | undefined;
    const skillIds: string[] = [];
    let force = false;
    let agentId: string | undefined;
    let reload = true;

    for (let index = 0; index < skillRest.length; index += 1) {
      const token = skillRest[index];
      if (!token) {
        continue;
      }
      if (token === '--help' || token === '-h') {
        return { command: 'help' };
      }
      if (token === '--skill') {
        skillIds.push(readOptionValue(skillRest, index, '--skill'));
        index += 1;
        continue;
      }
      if (token === '--agent') {
        agentId = readOptionValue(skillRest, index, '--agent');
        index += 1;
        continue;
      }
      if (token === '--force') {
        force = true;
        continue;
      }
      if (token === '--no-reload') {
        reload = false;
        continue;
      }
      if (token.startsWith('--')) {
        throw new Error(`Unknown option: ${token}`);
      }
      if (source !== undefined) {
        throw new Error(`skill add takes one source; got both ${JSON.stringify(source)} and ${JSON.stringify(token)}.`);
      }
      source = token;
    }

    if (source === undefined) {
      throw new Error('skill add needs a source: a GitHub owner/repo, a git URL, or a local path.');
    }

    return {
      command: 'skill-add',
      source,
      ...(skillIds.length > 0 ? { skillIds } : {}),
      ...(force ? { force } : {}),
      ...(agentId !== undefined ? { agentId } : {}),
      ...(reload ? {} : { reload }),
    };
  }

  if (command === 'restart') {
    const parsed: ParsedRestartCommand = { command: 'restart' };
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (!token) {
        continue;
      }
      if (token === '--help' || token === '-h') {
        return { command: 'help' };
      }
      if (token === '--reason') {
        parsed.reason = readOptionValue(rest, index, '--reason');
        index += 1;
        continue;
      }
      if (token === '--drain-timeout') {
        const seconds = Number(readOptionValue(rest, index, '--drain-timeout'));
        if (!Number.isFinite(seconds) || seconds < 0) {
          throw new Error(`Invalid value for --drain-timeout: ${rest[index + 1] ?? '(missing)'}`);
        }
        parsed.drainTimeoutMs = Math.round(seconds * 1000);
        index += 1;
        continue;
      }
      if (token === '--gateway') {
        parsed.gateway = readOptionValue(rest, index, '--gateway');
        index += 1;
        continue;
      }
      if (token === '--token') {
        parsed.token = readOptionValue(rest, index, '--token');
        index += 1;
        continue;
      }
      throw new Error(`Unknown option: ${token}`);
    }
    return parsed;
  }

  if (command === 'agent') {
    const [subcommand, ...agentRest] = rest;
    if (subcommand === '--help' || subcommand === '-h') {
      return { command: 'help' };
    }
    if (subcommand !== 'new') {
      throw new Error(`Unknown agent subcommand: ${subcommand ?? '(missing)'}. Try: stratus agent new, stratus agent list`);
    }

    let name: string | undefined;
    let instructions: string | undefined;
    let format: 'text' | 'json' | 'soul' = 'text';

    for (let index = 0; index < agentRest.length; index += 1) {
      const token = agentRest[index];
      if (!token) {
        continue;
      }
      if (token === '--help' || token === '-h') {
        return { command: 'help' };
      }
      if (token === '--name') {
        name = readOptionValue(agentRest, index, '--name');
        index += 1;
        continue;
      }
      if (token === '--instructions') {
        instructions = readOptionValue(agentRest, index, '--instructions');
        index += 1;
        continue;
      }
      if (token === '--format') {
        const value = readOptionValue(agentRest, index, '--format');
        if (value !== 'text' && value !== 'json' && value !== 'soul') {
          throw new Error(`Unsupported format: ${value}`);
        }
        format = value;
        index += 1;
        continue;
      }
      throw new Error(`Unknown option: ${token}`);
    }

    return {
      command: 'agent-new',
      ...(name ? { name } : {}),
      ...(instructions ? { instructions } : {}),
      format,
    };
  }

  if (command === 'setup') {
    let configPath: string | undefined;

    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index];
      if (!token) {
        continue;
      }
      if (token === '--help' || token === '-h') {
        return { command: 'help' };
      }
      if (token === '--config') {
        configPath = readOptionValue(rest, index, '--config');
        index += 1;
        continue;
      }
      throw new Error(`Unknown option: ${token}`);
    }

    return { command: 'setup', ...(configPath ? { configPath } : {}) };
  }

  if (command !== 'run') {
    throw new Error(`Unknown command: ${command}`);
  }

  let prompt = '';
  let provider: CliProviderName | undefined;
  let model: string | undefined;
  let baseUrl: string | undefined;
  let configPath: string | undefined;
  let soul: string | undefined;
  let format: 'text' | 'json' = 'text';
  let events = true;
  let approvals: CliApprovalMode = 'always';
  let maxTurns: number | undefined;
  let useStdin = false;
  const positionals: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];

    if (!token) {
      continue;
    }

    if (token === '--help' || token === '-h') {
      return { command: 'help' };
    }

    if (token === '--prompt' || token === '-p') {
      prompt = readOptionValue(rest, index, '--prompt');
      index += 1;
      continue;
    }

    if (token === '--stdin') {
      useStdin = true;
      continue;
    }

    if (token === '--provider') {
      provider = parseProviderName(readOptionValue(rest, index, '--provider'), '--provider');
      index += 1;
      continue;
    }

    if (token === '--model') {
      model = readOptionValue(rest, index, '--model');
      index += 1;
      continue;
    }

    if (token === '--base-url') {
      baseUrl = readOptionValue(rest, index, '--base-url');
      index += 1;
      continue;
    }

    if (token === '--config') {
      configPath = readOptionValue(rest, index, '--config');
      index += 1;
      continue;
    }

    if (token === '--soul') {
      soul = readOptionValue(rest, index, '--soul');
      index += 1;
      continue;
    }

    if (token === '--format') {
      const value = readOptionValue(rest, index, '--format');
      if (value !== 'text' && value !== 'json') {
        throw new Error(`Unsupported format: ${value}`);
      }
      format = value;
      index += 1;
      continue;
    }

    if (token === '--no-events') {
      events = false;
      continue;
    }

    if (token === '--approvals') {
      const value = readOptionValue(rest, index, '--approvals');
      if (value !== 'always' && value !== 'ask' && value !== 'never') {
        throw new Error(`Unsupported approvals mode: ${value}. Use always, ask, or never.`);
      }
      approvals = value;
      index += 1;
      continue;
    }

    if (token === '--max-turns') {
      const value = Number(readOptionValue(rest, index, '--max-turns'));
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`Invalid value for --max-turns: ${rest[index + 1] ?? '(missing)'}`);
      }
      maxTurns = value;
      index += 1;
      continue;
    }

    if (token.startsWith('-')) {
      throw new Error(`Unknown option: ${token}`);
    }

    positionals.push(token);
  }

  if (!prompt) {
    prompt = positionals.join(' ').trim();
  }

  if (!prompt && useStdin) {
    prompt = readPromptFromEnvironment(env);
  }

  if (!prompt) {
    throw new Error('A prompt is required. Pass it with --prompt, --stdin, or as a positional argument.');
  }

  if (approvals === 'ask' && useStdin) {
    throw new Error('--approvals ask cannot be combined with --stdin because both read from standard input.');
  }

  return {
    command: 'run',
    prompt,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(configPath ? { configPath } : {}),
    ...(soul ? { soul } : {}),
    format,
    events,
    approvals,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  };
};

export const formatEvent = (event: StratusEvent): string | null => {
  switch (event.type) {
    case 'session.created':
      return `• session.created ${event.sessionId}`;
    case 'session.updated':
      return `• session.updated ${event.status}`;
    case 'provider.response':
      return `• provider.response ${event.parts.length} part(s)`;
    case 'tool.called':
      return `• tool.called ${event.call.toolName}`;
    case 'tool.completed':
      return `• tool.completed ${event.result.toolName} ok=${String(event.result.ok)}`;
    case 'tool.denied':
      return `• tool.denied ${event.call.toolName}`;
    case 'tool.approval-requested':
      return `• tool.approval-requested ${event.call.toolName} (${event.risk}) for ${event.agentId}`;
    case 'tool.approval-resolved':
      return `• tool.approval-resolved ${event.answer} (${event.reason})${event.actor ? ` by ${event.actor}` : ''}`;
    case 'session.completed':
      return `• session.completed ${event.sessionId}`;
    case 'session.failed':
      return `• session.failed ${event.error}`;
    default:
      return null;
  }
};

/**
 * The fields worth keeping per event type. Tool inputs and message text
 * are deliberately excluded: the log is a trace of what happened, not a
 * second copy of the transcript.
 *
 * The approval pair is the one place the trace carries a person's id, and
 * it earns it: `always` widens what an agent may do unattended for the rest
 * of the session, and "who decided that" is unanswerable afterwards from
 * anything else. The refusal path is warned about by `onDecision`, but an
 * *approval* produces no warning at all — without these two records a
 * granted permission leaves no trace whatsoever. Still no tool input: what
 * was asked is here, what it was asked with is not.
 */
export const eventDetail = (event: StratusEvent): Record<string, unknown> | undefined => {
  switch (event.type) {
    case 'session.updated':
      return { status: event.status };
    case 'provider.response':
      return { parts: event.parts.length };
    case 'tool.called':
    case 'tool.denied':
      return { tool: event.call.toolName };
    case 'tool.completed': {
      // A memory write or retirement names the entry it touched — the id
      // is a reference, not content, and "when did the agent learn/drop
      // this" is unanswerable later without it. The fact itself stays out
      // of the trace, like every other tool input and output.
      const output = event.result.output;
      const entry = (event.result.toolName === MEMORY_TOOL_NAME || event.result.toolName === FORGET_TOOL_NAME)
        && event.result.ok && typeof output === 'object' && output !== null && !Array.isArray(output)
        && typeof output.id === 'string'
        ? output.id
        : undefined;
      return { tool: event.result.toolName, ok: event.result.ok, ...(entry !== undefined ? { entry } : {}) };
    }
    case 'tool.approval-requested':
      return { tool: event.call.toolName, risk: event.risk, requestId: event.requestId };
    case 'tool.approval-resolved':
      return {
        requestId: event.requestId,
        answer: event.answer,
        reason: event.reason,
        ...(event.actor ? { actor: event.actor } : {}),
      };
    case 'session.failed':
      return { error: event.error };
    default:
      return undefined;
  }
};

/**
 * Kept with its historical CLI signature: a parsed run command is a
 * RuntimeSelection plus CLI-only fields the resolver ignores.
 *
 * Those fields are *permitted*, not required. Demanding a whole
 * `ParsedRunCommand` made the type claim the resolver cared about
 * `approvals`, `format`, and `events` — it reads none of them — so every
 * caller with a selection in hand had to invent values to get past it.
 */
export const resolveRuntimeConfig = (
  command: RuntimeSelection & Partial<Omit<ParsedRunCommand, keyof RuntimeSelection>>,
  env: CliEnvironment = {},
): Promise<RuntimeConfig> => resolveStateRuntimeConfig(command, env);

/**
 * A saved subscription sign-in silently demoted to per-token billing is the
 * one config surprise that costs money — an API key in the environment
 * outranks the stored credential, and the run otherwise looks identical.
 * Detected from the resolved config: an apiKey where the stored credential
 * is a subscription token means the environment won.
 */
export const warnOnCredentialOverride = async (
  runtime: RuntimeConfig,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<void> => {
  if (runtime.provider === 'demo') {
    return;
  }
  const credentials = await loadCredentials(env);
  const processEnv = readProcessEnv(env);
  // The resolver records the variable that actually won — guessing it here
  // would name the wrong one whenever a custom apiKeyEnv supplied the key,
  // sending the reader to unset something that was never the cause.
  const primaryOverride = runtime.apiKey !== undefined
    ? { provider: runtime.provider, envVar: runtime.apiKeyEnvVar }
    : undefined;
  // Both subscription sign-ins demote the same way: a Claude setup token
  // and the codex ChatGPT marker each lose to an environment API key, and
  // the run otherwise looks identical while billing per token.
  for (const target of ['anthropic', 'codex'] as const) {
    if (credentials[target]?.type !== 'oauth_token') {
      continue;
    }
    const planName = target === 'anthropic'
      ? 'Claude subscription sign-in'
      : 'ChatGPT (codex login) sign-in';
    const primary = primaryOverride?.provider === target ? primaryOverride.envVar : undefined;
    // A fallback demoted the same way costs exactly as much, and only bites
    // once the primary is already failing — the worst moment to discover it.
    // The fallback path consults the provider's own conventional variable.
    const conventionalVar = defaultApiKeyEnvName(target);
    const fallbackVar = runtime.fallback?.provider === target
      && runtime.fallback.apiKey !== undefined
      && readNonEmptyString(processEnv[conventionalVar]) === runtime.fallback.apiKey
      ? conventionalVar
      : undefined;
    const culprit = primary ?? fallbackVar;
    if (!culprit) {
      continue;
    }
    writeLine(
      streams.stderr,
      `Warning: ${culprit} in your environment outranks the ${planName} saved by \`stratus setup\`, `
      + `so ${primary ? 'this run is' : 'a fallback retry would be'} billed per token instead of through your plan. `
      + 'Unset it to use the subscription, or run `stratus doctor` to see everything that is being overridden.',
    );
  }
};

const createApprovalPolicy = (
  mode: CliApprovalMode,
  streams: CliStreams,
  env: CliEnvironment,
  ask?: (prompt: string) => Promise<string>,
): ApprovalPolicy => {
  if (mode === 'always') {
    return new AllowAllApprovalPolicy();
  }

  if (mode === 'never') {
    return {
      async approve() {
        return false;
      },
    };
  }

  // A caller that already owns stdin (chat's readline) supplies its own
  // asker — two readers on one stream would race for the same bytes.
  if (ask) {
    return {
      async approve({ call }) {
        const answer = await ask(`Approve tool call ${call.toolName} with input ${JSON.stringify(call.input)}? [y/N] `);
        return /^y(es)?$/i.test(answer.trim());
      },
    };
  }

  return {
    async approve({ call }) {
      const input = env.approvalInput ?? process.stdin;
      const readline = createInterface({ input, terminal: false });

      // Prompt on stderr so stdout stays parseable (e.g. --format json).
      streams.stderr.write(`Approve tool call ${call.toolName} with input ${JSON.stringify(call.input)}? [y/N] `);

      try {
        const answer = await new Promise<string>((resolve) => {
          readline.once('line', resolve);
          readline.once('close', () => resolve(''));
        });
        writeLine(streams.stderr);
        return /^y(es)?$/i.test(answer.trim());
      } finally {
        readline.close();
      }
    },
  };
};

// The shared wiring behind every conversational command: memory (with
// legacy migration), tools, events, provider (with fallback), and the
// agent the runtime resolved. run uses it for one shot; chat keeps the
// runner alive and resumes the same session turn after turn.
const createAgentRuntime = async (
  streams: CliStreams,
  options: {
    events?: boolean;
    /** Replaces the default event printer when provided. */
    onEvent?: (event: StratusEvent) => void;
    /** Answers --approvals ask questions when the caller owns stdin. */
    askApproval?: (prompt: string) => Promise<string>;
    runtime: RuntimeConfig;
    approvals?: CliApprovalMode;
    maxTurns?: number;
    env?: CliEnvironment;
    /** The config this command was pinned to, for reading its `plugins` block. */
    configPath?: string;
  },
) => {
  const runEnv = options.env ?? {};
  await migrateLegacyMemory(runEnv);
  const memory = withLegacyDefaultMemories(createFileMemoryStore(memoryFilePath(runEnv)));

  const tools = new ToolRegistry();
  tools.register(createDemoTool());
  tools.register(createRememberTool(memory));
  tools.register(createRecallTool(memory));
  tools.register(createForgetTool(memory));

  // The same skills the daemon would serve, from the same directory, for
  // the same reason the plugins below match: a skill that routes in
  // `stratus run` routes in `stratus serve`, and one that is broken is
  // broken (and warned about) in both. The runner registers `skill.read`
  // itself, gated on the soul enabling any skill.
  const skills = new SkillRegistry();
  await loadOperatorSkills(runEnv, skills, (line) => {
    writeLine(streams.stderr, `Warning: ${line}`);
  });

  const bus = new EventBus({
    onError: (error) => {
      writeLine(streams.stderr, `Warning: event handler failed: ${error instanceof Error ? error.message : String(error)}`);
    },
  });
  if (options.onEvent) {
    const onEvent = options.onEvent;
    bus.subscribe(async (event) => {
      onEvent(event);
    });
  } else if (options.events ?? true) {
    bus.subscribe(async (event) => {
      const line = formatEvent(event);
      if (line) {
        writeLine(streams.stdout, line);
      }
    });
  }

  // The same plugins the daemon would load, from the same trusted config,
  // so a tool that works in `stratus run` works in `stratus serve` and a
  // tool that is missing is missing in both. A local test that silently ran
  // a different toolset than the daemon would be worse than no local test.
  const pluginsConfig = await loadServePlugins(runEnv, options.configPath, (line) => {
    writeLine(streams.stderr, `Warning: ${line}`);
  });
  const loadedPlugins: LoadedPlugin[] = [];
  if (Object.keys(pluginsConfig).length > 0) {
    const result = await loadPlugins({
      config: pluginsConfig,
      host: {
        resolve: (specifier) => import.meta.resolve(specifier),
        import: (specifier) => import(specifier),
      },
      tools,
      skills,
      bus,
      credentials: createFileCredentialResolver(runEnv),
      workspaceRoot: workspacesDirPath(runEnv),
    });
    loadedPlugins.push(...result.loaded);
    for (const failure of result.failures) {
      writeLine(streams.stderr, `Warning: plugin ${failure.package} did not load: ${failure.reason}`);
    }
  }

  // The Claude Code runtime executes kernel tools by calling back into the
  // runner built just below — late-bound because the runner needs the
  // provider first.
  let hostedRunner: AgentRunner | undefined;
  const runtimeProvider = createRuntimeProvider(
    options.runtime,
    (error) => {
      const fallback = options.runtime.provider === 'demo' ? undefined : options.runtime.fallback;
      writeLine(
        streams.stderr,
        `Warning: the default model failed (${error instanceof Error ? error.message : String(error)}); falling back to ${fallback?.model ?? 'the fallback model'}.`,
      );
    },
    async (session, call, context) => {
      if (!hostedRunner) {
        throw new Error('The Stratus runtime is not ready to execute tools yet.');
      }
      return hostedRunner.executeHostedToolCall(session, call, context);
    },
    options.maxTurns,
  );

  const runner = new AgentRunner({
    provider: runtimeProvider,
    tools,
    executor: createLocalCommandExecutor(),
    approvals: createApprovalPolicy(options.approvals ?? 'always', streams, options.env ?? {}, options.askApproval),
    bus,
    skills,
    memory,
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
  });

  hostedRunner = runner;
  await runner.initialize();

  // A soul is a full identity — without one, every provider serves the
  // same built-in Stratus persona.
  const agent: AgentDefinition = options.runtime.soul?.agent ?? DEFAULT_STRATUS_AGENT;

  // The same advisory the daemon gives at roster load, from the same
  // kernel check: a soul enabling a skill whose `requires:` its `tools:`
  // does not cover must warn here too, or the local test stays silent
  // about a configuration `stratus serve` flags.
  for (const { skill, missing } of missingSkillRequirements(agent, skills)) {
    writeLine(
      streams.stderr,
      `Warning: agent ${agent.id} enables skill ${skill.id}, which expects tools the agent is not allowed: ${missing.join(', ')}`,
    );
  }


  const metadata = options.runtime.provider === 'demo'
    ? { provider: 'demo' as const, executor: 'local-command' }
    : {
        provider: options.runtime.provider,
        model: options.runtime.model,
        ...(options.runtime.provider === 'openai' ? { baseUrl: options.runtime.baseUrl } : {}),
      };

  // Handed back so a command can release what a plugin acquired — a browser
  // above all. A one-shot `stratus run` that left a Chromium behind would
  // be a leak per invocation.
  const disposePlugins = async (): Promise<void> => {
    for (const plugin of loadedPlugins) {
      try {
        await plugin.instance.dispose?.();
      } catch (error) {
        writeLine(
          streams.stderr,
          `Warning: plugin ${plugin.package} failed to shut down: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

  return { runner, agent, metadata, disposePlugins };
};

export const runSingleLoop = async (
  prompt: string,
  streams: CliStreams,
  options: {
    events?: boolean;
    runtime: RuntimeConfig;
    approvals?: CliApprovalMode;
    maxTurns?: number;
    env?: CliEnvironment;
    configPath?: string;
  },
): Promise<Session> => {
  const { runner, agent, metadata, disposePlugins } = await createAgentRuntime(streams, options);
  try {
    return await runner.run({
      sessionId: randomUUID(),
      agent,
      userMessage: prompt,
      metadata,
    });
  } finally {
    // Even when the run failed: a plugin that started a browser started it
    // before the turn could fail.
    await disposePlugins();
  }
};

export const printSessionSummary = (session: Session, streams: CliStreams): void => {
  writeLine(streams.stdout);
  writeLine(streams.stdout, 'Messages');

  for (const message of session.messages) {
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      const calls = message.toolCalls
        .map((call) => `${call.toolName}(${JSON.stringify(call.input)})`)
        .join(', ');
      const prefix = message.content ? `${message.content} ` : '';
      writeLine(streams.stdout, `[assistant] ${prefix}→ tool call ${calls}`);
      continue;
    }

    const nameSuffix = message.name ? `:${message.name}` : '';
    const content = message.role === 'tool' ? stringifyValue(JSON.parse(message.content) as JsonValue) : message.content;
    writeLine(streams.stdout, `[${message.role}${nameSuffix}] ${content}`);
  }
};

const lastAssistantReply = (session: Session): string => {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (message && message.role === 'assistant' && message.content.trim().length > 0) {
      return message.content;
    }
  }
  return '(no reply)';
};

const CHAT_HELP = [
  '  /help   show this',
  '  /exit   leave the chat (Ctrl+C and Ctrl+D work too)',
  'Everything else is a message to your agent. The conversation persists',
  'across turns, and facts they remember stick forever.',
].join('\n');

export const runChat = async (
  command: ParsedChatCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  const runtime = await resolveRuntimeConfig({
    command: 'run',
    prompt: '',
    format: 'text',
    events: false,
    approvals: command.approvals,
    ...(command.provider ? { provider: command.provider } : {}),
    ...(command.model ? { model: command.model } : {}),
    ...(command.baseUrl ? { baseUrl: command.baseUrl } : {}),
    ...(command.soul ? { soul: command.soul } : {}),
    ...(command.configPath ? { configPath: command.configPath } : {}),
  }, env);
  await warnOnCredentialOverride(runtime, streams, env);

  // Interactive means the real terminal: an injected stdinStream is by
  // definition not a TTY conversation, so it never gets prompts, ANSI
  // styling, or a terminal readline wired to a stream that can't take it.
  const interactive = env.setupInput === undefined
    && env.stdinStream === undefined
    && process.stdin.isTTY === true;
  // Styling is for eyes: piped transcripts stay plain text.
  const bold = (text: string): string => (interactive ? `\u001b[1m${text}\u001b[0m` : text);
  const dim = (text: string): string => (interactive ? `\u001b[2m${text}\u001b[0m` : text);

  const input = env.stdinStream ?? process.stdin;
  const rl = interactive
    ? createInterface({
        input,
        output: streams.stdout as unknown as NodeJS.WritableStream,
        prompt: '\u001b[36myou ›\u001b[0m ',
        terminal: true,
      })
    : createInterface({ input, terminal: false });
  // One reader owns stdin. Every line lands in this queue, and whoever is
  // waiting — the chat loop, or an approval question mid-turn — takes the
  // next one. A second readline would race for the same bytes, and
  // rl.question cannot be used while the interface is being iterated.
  const lineQueue: string[] = [];
  let inputClosed = false;
  let pendingApproval: ((answer: string) => void) | undefined;
  let notifyLine: (() => void) | undefined;
  rl.on('line', (rawLine) => {
    if (pendingApproval) {
      const resolve = pendingApproval;
      pendingApproval = undefined;
      resolve(rawLine);
      return;
    }
    lineQueue.push(rawLine);
    notifyLine?.();
  });
  rl.on('close', () => {
    inputClosed = true;
    if (pendingApproval) {
      const resolve = pendingApproval;
      pendingApproval = undefined;
      resolve('');
    }
    notifyLine?.();
  });

  const nextLine = (): Promise<string | undefined> => {
    if (lineQueue.length > 0) {
      return Promise.resolve(lineQueue.shift());
    }
    if (inputClosed) {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      notifyLine = () => {
        notifyLine = undefined;
        resolve(lineQueue.shift());
      };
    });
  };

  // An approval consumes the next unconsumed line (typed live, or already
  // queued from piped input). A closed stream denies instead of hanging.
  const askApproval = (prompt: string): Promise<string> => {
    streams.stderr.write(prompt);
    const queued = lineQueue.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    if (inputClosed) {
      return Promise.resolve('');
    }
    return new Promise((resolve) => {
      pendingApproval = resolve;
    });
  };

  const { runner, agent, metadata, disposePlugins } = await createAgentRuntime(streams, {
    runtime,
    approvals: command.approvals,
    askApproval,
    ...(command.maxTurns !== undefined ? { maxTurns: command.maxTurns } : {}),
    ...(command.configPath ? { configPath: command.configPath } : {}),
    env,
    onEvent: (event) => {
      if (command.events) {
        const line = formatEvent(event);
        if (line) {
          writeLine(streams.stdout, dim(line));
        }
        return;
      }
      // Quiet by default — just a whisper when the agent reaches for a tool.
      if (event.type === 'tool.called') {
        writeLine(streams.stdout, dim(`  · using ${event.call.toolName}`));
      } else if (event.type === 'tool.denied') {
        writeLine(streams.stdout, dim(`  · ${event.call.toolName} denied`));
      }
    },
  });

  const modelLine = runtime.provider === 'demo'
    ? 'demo (offline)'
    : `${runtime.provider} · ${runtime.model}`;

  if (interactive) {
    streams.stdout.write('\u001b[2J\u001b[H');
    for (const line of stratusHeaderLines()) {
      writeLine(streams.stdout, line);
    }
    writeLine(streams.stdout);
    writeLine(streams.stdout, `Chatting with ${bold(agent.name)} — ${modelLine}.`);
    writeLine(streams.stdout, dim('The conversation persists across turns. /exit to leave, /help for more.'));
    writeLine(streams.stdout);
  }

  // Ctrl+C between turns closes the chat gracefully; mid-turn there is
  // nothing to cancel in the kernel yet, so leave immediately instead of
  // silently waiting out a slow provider call.
  let turnInFlight = false;
  rl.on('SIGINT', () => {
    if (turnInFlight) {
      writeLine(streams.stdout);
      writeLine(streams.stdout, dim('Interrupted.'));
      process.exit(130);
    }
    rl.close();
  });

  // One session for the whole sitting: the first message starts it, every
  // later message resumes it — the same plumbing a channel will use to
  // keep a thread alive.
  let sessionId: string | undefined;

  if (interactive) {
    rl.prompt();
  }
  for (;;) {
    const rawLine = await nextLine();
    if (rawLine === undefined) {
      break;
    }
    const line = rawLine.trim();
    if (line.length === 0) {
      if (interactive) {
        rl.prompt();
      }
      continue;
    }
    if (line === '/exit' || line === '/quit' || line === 'exit' || line === 'quit') {
      break;
    }
    if (line === '/help') {
      writeLine(streams.stdout, CHAT_HELP);
      if (interactive) {
        rl.prompt();
      }
      continue;
    }

    if (!interactive) {
      writeLine(streams.stdout, `you › ${line}`);
    }
    try {
      turnInFlight = true;
      let session: Session;
      if (sessionId === undefined) {
        const id = randomUUID();
        sessionId = id;
        session = await runner.run({ sessionId: id, agent, userMessage: line, metadata });
      } else {
        session = await runner.resume({ sessionId, userMessage: line });
      }
      writeLine(streams.stdout, `${bold(`${agent.name} ›`)} ${lastAssistantReply(session)}`);
    } catch (error) {
      writeLine(streams.stderr, `Error: ${error instanceof Error ? error.message : String(error)}`);
      writeLine(streams.stdout, dim('(that turn failed — the conversation is still here, try again)'));
    } finally {
      turnInFlight = false;
    }
    writeLine(streams.stdout);
    if (interactive) {
      rl.prompt();
    }
  }
  rl.close();
  // A chat that held a browser open for an hour still has to put it down.
  await disposePlugins();

  if (interactive) {
    writeLine(streams.stdout, dim(`Bye — ${agent.name} keeps what they remembered.`));
  }
  return 0;
};

const formatRuntimeBanner = (runtime: RuntimeConfig): string => {
  const soulSuffix = runtime.soul ? ` as ${runtime.soul.agent.name}` : '';

  if (runtime.provider === 'demo') {
    return `Starting Stratus Agent local loop with provider=demo${soulSuffix}`;
  }

  const fallbackSuffix = runtime.fallback ? ` fallback=${runtime.fallback.model}` : '';
  return `Starting Stratus Agent local loop with provider=${runtime.provider} model=${runtime.model}${fallbackSuffix}${soulSuffix}`;
};

export const openExternalUrl = async (url: string): Promise<void> => {
  const platform = process.platform;
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: platform !== 'win32' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
};

// Printed commands must survive copy-paste into a shell, so anything outside
// the safe character set gets single-quoted.
const quoteShellArg = (value: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

/** How a menu was answered: a picked option, free text, or backed out. */
type MenuAnswer =
  | { kind: 'index'; index: number }
  | { kind: 'text'; text: string }
  | { kind: 'back' };

interface MenuOptions {
  /** Preselected option (defaults to 0). */
  defaultIndex?: number;
  /** Non-interactive mode: a non-numeric line becomes a 'text' answer. */
  allowText?: boolean;
  /** Extra line printed under the heading (e.g. overflow notes). */
  footnote?: string;
}

// The fixed header drawn at the top of every interactive screen.
const stratusHeaderLines = (): string[] => {
  const title = 'Stratus Agent';
  const version = `v${CLI_VERSION}`;
  const gap = '   ';
  const content = `  ${title}${gap}${version}  `;
  return [
    `\u001b[2m╭${'─'.repeat(content.length)}╮\u001b[0m`,
    `\u001b[2m│\u001b[0m  \u001b[1m${title}\u001b[0m${gap}\u001b[2m${version}\u001b[0m  \u001b[2m│\u001b[0m`,
    `\u001b[2m╰${'─'.repeat(content.length)}╯\u001b[0m`,
  ];
};

interface PrompterView {
  /** Lines drawn at the top of every interactive menu screen. */
  header(): string[];
  /** Recent status lines to carry onto the next screen (consumed). */
  consumeNotices(): string[];
}

interface SetupPrompter {
  ask(question: string, opts?: { prefill?: string }): Promise<string>;
  /** Like ask, but typed characters are not echoed on interactive TTYs. */
  askSecret(question: string): Promise<string>;
  /** True when menus are arrow-key driven on a real terminal. */
  isInteractive(): boolean;
  /**
   * Present a menu. On interactive TTYs this is arrow-key navigation with a
   * highlighted cursor (↑/↓ or j/k to move, Enter to pick, digits to jump,
   * Esc/q to back out). With piped input it renders the numbered list and
   * reads one line, so scripts and tests drive it exactly as before.
   */
  select(heading: string, options: string[], opts?: MenuOptions): Promise<MenuAnswer>;
  isClosed(): boolean;
  close(): void;
}

const createSetupPrompter = (
  streams: CliStreams,
  env: CliEnvironment,
  view?: PrompterView,
): SetupPrompter => {
  // On a real TTY, menus are arrow-key driven and secrets are read without
  // echo; with piped input (tests, scripts) everything is plain lines.
  const interactive = env.setupInput === undefined && process.stdin.isTTY === true;

  if (interactive) {
    let closed = false;
    process.stdin.once('end', () => {
      closed = true;
    });

    const question = (prompt: string, secret: boolean, prefill?: string): Promise<string> => {
      const readline = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      if (secret) {
        const internal = readline as unknown as { _writeToOutput?: (chunk: string) => void };
        const original = internal._writeToOutput?.bind(readline);
        internal._writeToOutput = (chunk: string) => {
          // Echo the prompt itself, swallow the typed secret.
          if (chunk.startsWith(prompt)) {
            original?.(prompt);
          }
        };
      }
      return new Promise((resolve) => {
        readline.on('SIGINT', () => {
          readline.close();
          streams.stdout.write('\n');
          process.exit(130);
        });
        readline.question(prompt, (answer) => {
          readline.close();
          if (secret) {
            streams.stdout.write('\n');
          }
          resolve(answer.trim());
        });
        if (prefill) {
          // Pre-typed and editable: backspace over it or press Enter to keep.
          readline.write(prefill);
        }
      });
    };

    // Each menu replaces the screen: clear, draw the header, carry over the
    // most recent status lines, then the menu itself.
    const drawScreen = (out: Pick<typeof process.stdout, 'write'>): void => {
      out.write('\u001b[2J\u001b[H');
      for (const line of view?.header() ?? []) {
        out.write(`${line}\n`);
      }
      const notices = view?.consumeNotices() ?? [];
      if (notices.length > 0) {
        for (const line of notices) {
          out.write(`\u001b[2m${line}\u001b[0m\n`);
        }
        out.write('\n');
      }
    };

    const selectInteractive = (
      heading: string,
      options: string[],
      opts: MenuOptions,
    ): Promise<MenuAnswer> => new Promise((resolve) => {
      const stdin = process.stdin;
      const out = streams.stdout;
      let index = Math.min(Math.max(opts.defaultIndex ?? 0, 0), options.length - 1);

      const wasRaw = stdin.isRaw === true;
      stdin.setRawMode?.(true);
      stdin.resume();

      const render = (redraw: boolean): void => {
        if (redraw) {
          out.write(`\u001b[${options.length}A`);
        } else {
          drawScreen(out);
          if (heading.length > 0) {
            out.write(`${heading}\n`);
          }
          if (opts.footnote) {
            out.write(`${opts.footnote}\n`);
          }
        }
        options.forEach((option, i) => {
          const active = i === index;
          out.write(`\u001b[2K\r${active ? '\u001b[36m\u276f ' : '  '}${i + 1}) ${option}${active ? '\u001b[0m' : ''}\n`);
        });
      };

      const finish = (answer: MenuAnswer): void => {
        if (pendingTimer !== undefined) {
          clearTimeout(pendingTimer);
          pendingTimer = undefined;
        }
        stdin.off('data', onData);
        if (!wasRaw) {
          stdin.setRawMode?.(false);
        }
        // Pause so keys typed between menus buffer for the next consumer
        // instead of being dropped by a flowing stream with no listener.
        stdin.pause();
        if (pendingEscape.length > 0) {
          stdin.unshift(Buffer.from(pendingEscape, 'utf8'));
          pendingEscape = '';
        }
        resolve(answer);
      };

      const handleKey = (key: string): boolean => {
        if (key === '\u0003') {
          // Ctrl-C: restore the terminal and leave setup entirely.
          stdin.setRawMode?.(false);
          out.write('\n');
          process.exit(130);
        }
        if (key === '\u001b[A' || key === '\u001bOA' || key === 'k') {
          index = (index - 1 + options.length) % options.length;
          render(true);
          return false;
        }
        if (key === '\u001b[B' || key === '\u001bOB' || key === 'j' || key === '\t') {
          index = (index + 1) % options.length;
          render(true);
          return false;
        }
        if (key === '\r' || key === '\n') {
          finish({ kind: 'index', index });
          return true;
        }
        if (key === '\u001b' || key === 'q') {
          finish({ kind: 'back' });
          return true;
        }
        if (/^[1-9]$/.test(key)) {
          const jump = Number(key) - 1;
          if (jump < options.length) {
            index = jump;
            render(true);
            finish({ kind: 'index', index });
            return true;
          }
        }
        return false;
      };

      // Key repeat and pasted input arrive as one chunk containing several
      // sequences — split it into individual keys before handling. Bytes
      // that follow the selecting key (e.g. a pasted "2sk-ant-…") are
      // pushed back onto stdin for whatever prompt comes next. Terminals
      // and SSH can also split an escape sequence ACROSS chunks (ESC, then
      // "[A"), so an incomplete escape tail is held briefly: completed by
      // the next chunk, or treated as a real Esc press after a beat.
      let pendingEscape = '';
      let pendingTimer: ReturnType<typeof setTimeout> | undefined;

      const processText = (text: string): void => {
        let position = 0;
        while (position < text.length) {
          const remaining = text.length - position;
          if (text[position] === '\u001b' && remaining < 3
            && (remaining === 1 || text[position + 1] === '[' || text[position + 1] === 'O')) {
            pendingEscape = text.slice(position);
            pendingTimer = setTimeout(() => {
              // No continuation arrived: it was a genuine Esc press.
              pendingEscape = '';
              pendingTimer = undefined;
              handleKey('\u001b');
            }, 75);
            return;
          }
          let key: string;
          if (text[position] === '\u001b' && (text[position + 1] === '[' || text[position + 1] === 'O')) {
            key = text.slice(position, position + 3);
            position += 3;
          } else {
            key = text[position]!;
            position += 1;
          }
          if (handleKey(key)) {
            const rest = text.slice(position);
            if (rest.length > 0) {
              stdin.unshift(Buffer.from(rest, 'utf8'));
            }
            return;
          }
        }
      };

      const onData = (chunk: Buffer): void => {
        if (pendingTimer !== undefined) {
          clearTimeout(pendingTimer);
          pendingTimer = undefined;
        }
        const text = pendingEscape + chunk.toString('utf8');
        pendingEscape = '';
        processText(text);
      };

      render(false);
      stdin.on('data', onData);
    });

    return {
      ask: (q, opts) => question(q, false, opts?.prefill),
      askSecret: (q) => question(q, true),
      isInteractive: () => true,
      async select(heading, options, opts = {}) {
        if (options.length === 0) {
          return { kind: 'back' };
        }
        return selectInteractive(heading, options, opts);
      },
      isClosed: () => closed,
      close: () => {
        // A resumed raw-mode stdin keeps the event loop alive; release it
        // so the process can exit once setup returns.
        process.stdin.setRawMode?.(false);
        process.stdin.pause();
      },
    };
  }

  const input = env.setupInput ?? process.stdin;
  const readline = createInterface({ input, terminal: false });
  const pendingLines: string[] = [];
  let closed = false;

  readline.on('line', (line) => {
    pendingLines.push(line);
  });
  readline.once('close', () => {
    closed = true;
  });

  const nextLine = async (): Promise<string> => {
    while (pendingLines.length === 0) {
      if (closed) {
        return '';
      }
      await new Promise<void>((resolve) => {
        readline.once('line', () => resolve());
        readline.once('close', () => resolve());
      });
    }
    return (pendingLines.shift() ?? '').trim();
  };

  const selectPlain = async (
    heading: string,
    options: string[],
    opts: MenuOptions,
  ): Promise<MenuAnswer> => {
    const defaultIndex = Math.min(Math.max(opts.defaultIndex ?? 0, 0), options.length - 1);
    while (true) {
      streams.stdout.write(`${heading}\n`);
      if (opts.footnote) {
        streams.stdout.write(`${opts.footnote}\n`);
      }
      for (const [i, option] of options.entries()) {
        streams.stdout.write(`  ${i + 1}) ${option}\n`);
      }
      streams.stdout.write(`Choose [${defaultIndex + 1}]: `);
      const line = await nextLine();

      if (line === '') {
        if (closed && pendingLines.length === 0) {
          return { kind: 'back' };
        }
        return { kind: 'index', index: defaultIndex };
      }
      if (/^\d+$/.test(line)) {
        const picked = Number(line) - 1;
        if (picked >= 0 && picked < options.length) {
          return { kind: 'index', index: picked };
        }
        writeLine(streams.stdout, `Pick a number between 1 and ${options.length}.`);
        continue;
      }
      if (/^(back|b|q(uit)?)$/i.test(line)) {
        return { kind: 'back' };
      }
      if (opts.allowText) {
        return { kind: 'text', text: line };
      }
      const matched = options.findIndex((option) => option.toLowerCase().includes(line.toLowerCase()));
      if (matched !== -1) {
        return { kind: 'index', index: matched };
      }
      writeLine(streams.stdout, `Pick a number between 1 and ${options.length}.`);
    }
  };

  return {
    async ask(q, opts) {
      streams.stdout.write(q);
      const line = await nextLine();
      return line || (opts?.prefill ?? '');
    },
    async askSecret(q) {
      // Piped input never echoes, so plain reads are safe here.
      streams.stdout.write(q);
      return nextLine();
    },
    isInteractive: () => false,
    async select(heading, options, opts = {}) {
      if (options.length === 0) {
        return { kind: 'back' };
      }
      return selectPlain(heading, options, opts);
    },
    isClosed: () => closed && pendingLines.length === 0,
    close: () => {
      readline.close();
    },
  };
};

// Slack verification talks to the Web API over plain fetch rather than
// through @stratusagent/channel-slack. Setup must stay usable before that
// optional package is installed, and the CLI deliberately does not depend
// on it (or on the ~9 MB of Slack SDKs underneath).
const SLACK_API_ROOT = 'https://slack.com/api';

interface SlackIdentity {
  botUserId?: string;
  teamName?: string;
  teamId?: string;
}

type SlackVerdict =
  | { status: 'ok'; identity: SlackIdentity }
  | { status: 'rejected'; detail: string }
  | { status: 'unreachable'; detail: string };

const callSlack = async (
  method: string,
  token: string,
  fetchImpl: typeof fetch | undefined,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; verdict: SlackVerdict }> => {
  if (typeof fetchImpl !== 'function') {
    return { ok: false, verdict: { status: 'unreachable', detail: 'fetch is unavailable' } };
  }
  try {
    const response = await fetchImpl(`${SLACK_API_ROOT}/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
    });
    if (!response.ok) {
      return { ok: false, verdict: { status: 'unreachable', detail: `HTTP ${response.status}` } };
    }
    const body = await response.json() as Record<string, unknown>;
    if (body.ok === true) {
      return { ok: true, body };
    }
    // Slack answers 200 with { ok: false, error } for bad credentials, so
    // the error string — not the status — is what condemns a token.
    return { ok: false, verdict: { status: 'rejected', detail: String(body.error ?? 'unknown error') } };
  } catch (error) {
    return { ok: false, verdict: { status: 'unreachable', detail: error instanceof Error ? error.message : String(error) } };
  }
};

/** Verifies a bot token and reports the identity it belongs to. */
const verifySlackBotToken = async (token: string, fetchImpl: typeof fetch | undefined): Promise<SlackVerdict> => {
  const result = await callSlack('auth.test', token, fetchImpl);
  if (!result.ok) {
    return result.verdict;
  }
  return {
    status: 'ok',
    identity: {
      ...(typeof result.body.user_id === 'string' ? { botUserId: result.body.user_id } : {}),
      ...(typeof result.body.team === 'string' ? { teamName: result.body.team } : {}),
      ...(typeof result.body.team_id === 'string' ? { teamId: result.body.team_id } : {}),
    },
  };
};

/**
 * Verifies an app-level token by opening a Socket Mode URL. The URL is
 * discarded — this only proves the token carries connections:write, which
 * is the failure the daemon would otherwise hit at start time.
 */
const verifySlackAppToken = async (token: string, fetchImpl: typeof fetch | undefined): Promise<SlackVerdict> => {
  const result = await callSlack('apps.connections.open', token, fetchImpl);
  return result.ok ? { status: 'ok', identity: {} } : result.verdict;
};

// Scopes and events the adapter needs. Kept in step with the manifest
// shipped by @stratusagent/channel-slack (a test pins them together) so
// setup can hand over a ready-to-paste manifest without depending on that
// package being installed.
const SLACK_BOT_SCOPES = [
  'app_mentions:read',
  // The conversations read family backs outbound destination validation
  // (conversations.info): whether a channel a schedule wants to report to
  // exists, and whether this app is a member of it.
  'channels:read',
  'chat:write',
  'files:write',
  'groups:read',
  'im:history',
  'im:read',
  'im:write',
  'mpim:read',
  'users:read',
];
const SLACK_BOT_EVENTS = ['app_mention', 'message.im'];

export const slackAppManifest = (agentName: string): string => JSON.stringify({
  display_information: {
    name: agentName,
    description: 'A Stratus agent',
    background_color: '#1a1d21',
  },
  features: {
    bot_user: { display_name: agentName, always_online: true },
  },
  oauth_config: { scopes: { bot: SLACK_BOT_SCOPES } },
  settings: {
    event_subscriptions: { bot_events: SLACK_BOT_EVENTS },
    // Required for remote approval: Allow / Always allow / Deny arrive as
    // block_actions, and Slack delivers none of them to an app that has
    // interactivity switched off. Enabled unconditionally rather than per
    // mode — an app is created once, and discovering months later that the
    // buttons do nothing means editing the manifest and reinstalling.
    interactivity: { is_enabled: true },
    org_deploy_enabled: false,
    socket_mode_enabled: true,
    token_rotation_enabled: false,
  },
}, null, 2);

const DEFAULT_SOUL_STARTER = [
  'You are a helpful, warm generalist. Answer first, explain second, and',
  'keep replies short unless the question genuinely needs depth. Use',
  'memory.remember for durable facts about the people you work with, and',
  'memory.recall to look up what you know when a conversation calls for it.',
].join('\n');

interface SetupState {
  provider: CliProviderName;
  model?: string;
  fallbackModel?: string;
  fallbackProvider?: CliProviderName;
  fallbackBaseUrl?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  systemPrompt?: string;
  soulPath?: string;
  credentials: CredentialsFile;
  credentialsDirty: boolean;
  /** Channel tokens (Slack apps, keyed by agent id) and whether they changed. */
  channels: ChannelCredentials;
  channelsDirty: boolean;
  /** Run stratusd under the platform's service manager after saving. */
  service: { install: boolean; runAtLogin: boolean };
}

export const runSetup = async (
  command: ParsedSetupCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  const cwd = readWorkingDirectory(env);
  const processEnv = readProcessEnv(env);

  // Config target: --config, then STRATUS_CONFIG, then the global
  // ~/.stratus/config.json — the file `stratus run` falls back to from any
  // directory, which is what makes setup a one-time step.
  const envConfigVar = readNonEmptyString(processEnv.STRATUS_CONFIG) ? 'STRATUS_CONFIG' : undefined;
  const envConfigPath = envConfigVar ? String(processEnv.STRATUS_CONFIG).trim() : undefined;
  const configPath = command.configPath
    ? path.resolve(cwd, command.configPath)
    : envConfigPath
      ? path.resolve(cwd, envConfigPath)
      : globalConfigPath(env);
  // A path passed via --config is not auto-discovered by `stratus run`, so
  // suggested commands must carry it explicitly.
  const runConfigFlag = command.configPath ? ` --config ${quoteShellArg(command.configPath)}` : '';
  // Set once save() detects a project config shadowing the global one.
  // Suggested commands must carry it too, or they read a different config
  // than the one just written — for `serve` that means a different roster,
  // and Slack apps stored here would be skipped as having no agent.
  let shadowConfigFlag = '';
  const serveCommand = (): string => `stratus serve${runConfigFlag}${shadowConfigFlag}`;

  // Seed from what is already configured, so re-running setup edits instead
  // of clobbering.
  let existing: CliConfigFile = {};
  try {
    existing = await loadConfigFile(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      writeLine(streams.stderr, `Warning: could not read ${configPath} (${error instanceof Error ? error.message : String(error)}); starting fresh.`);
    }
  }

  // Interactive mode is a screen-based interface: every menu clears and
  // redraws under a fixed header, and status lines printed between menus
  // are carried onto the next screen (dimmed) so nothing is missed.
  const interactive = env.setupInput === undefined && process.stdin.isTTY === true;
  const baseStreams = streams;
  const recentNotices: string[] = [];
  if (interactive) {
    streams = {
      stderr: baseStreams.stderr,
      stdout: {
        write(chunk: string) {
          for (const raw of String(chunk).split('\n')) {
            const line = raw.trimEnd();
            if (line.trim().length > 0) {
              recentNotices.push(line);
              if (recentNotices.length > 8) {
                recentNotices.shift();
              }
            }
          }
          return baseStreams.stdout.write(chunk);
        },
      },
    };
  }

  const state: SetupState = {
    provider: existing.provider ?? 'anthropic',
    ...(existing.model ? { model: existing.model } : {}),
    ...(existing.baseUrl ? { baseUrl: existing.baseUrl } : {}),
    ...(existing.apiKeyEnv ? { apiKeyEnv: existing.apiKeyEnv } : {}),
    ...(existing.systemPrompt ? { systemPrompt: existing.systemPrompt } : {}),
    ...(existing.soul ? { soulPath: existing.soul } : {}),
    ...(existing.fallbackModel ? { fallbackModel: existing.fallbackModel } : {}),
    // Pin an implicit fallback provider now, so a later default-provider
    // switch cannot silently change what the fallback means.
    ...(existing.fallbackModel || existing.fallbackProvider
      ? { fallbackProvider: existing.fallbackProvider ?? existing.provider ?? 'anthropic' }
      : {}),
    ...(existing.fallbackBaseUrl ? { fallbackBaseUrl: existing.fallbackBaseUrl } : {}),
    credentials: await loadCredentials(env),
    credentialsDirty: false,
    channels: await loadChannelCredentials(env),
    channelsDirty: false,
    // On by default: setup's whole promise is that you finish it and the
    // agents are working. An always-on runtime you have to remember to
    // start is not always-on, and every Slack app configured here stays
    // silent until stratusd is up. An existing install keeps ITS login
    // setting, though — rerunning setup and pressing save must not quietly
    // undo a deliberate `service install --no-login`.
    service: await (async () => {
      const status = await readServiceStatus(serviceEnvFor(env)).catch(() => undefined);
      // An unknown answer (a broken user bus, a timed-out query) must not
      // read as "they chose --no-login" — that would disable a service on
      // the next save because of a transient failure.
      return {
        install: true,
        runAtLogin: status?.installed && status.runAtLogin !== undefined ? status.runAtLogin : true,
      };
    })(),
  };

  const prompter = createSetupPrompter(baseStreams, env, {
    header: stratusHeaderLines,
    consumeNotices: () => recentNotices.splice(0),
  });

  const defaultModelFor = (provider: CliProviderName): string =>
    provider === 'openai'
      ? DEFAULT_OPENAI_MODEL
      : provider === 'codex'
        ? DEFAULT_CODEX_MODEL
        : DEFAULT_ANTHROPIC_MODEL;
  // Widened to CliProviderName only so setup can ask about the provider it
  // currently has selected, `demo` included; the rule itself is the shared one.
  const defaultKeyEnvFor = (provider: CliProviderName): string =>
    defaultApiKeyEnvName(provider === 'demo' ? 'anthropic' : provider);

  const credentialLabel = (provider: CredentialProviderName, credential: StoredCredential): string =>
    credential.type === 'oauth_token'
      ? (provider === 'codex' ? 'ChatGPT sign-in' : 'Claude subscription')
      : 'API key';

  const providerSignInStatus = (provider: CredentialProviderName): string => {
    const credential = state.credentials[provider];
    if (credential) {
      return `signed in (${credentialLabel(provider, credential)})`;
    }
    if (readNonEmptyString(processEnv[defaultKeyEnvFor(provider)])) {
      return `using ${defaultKeyEnvFor(provider)} from your environment`;
    }
    return 'not signed in';
  };

  const providersSummary = (): string => {
    const parts: string[] = [];
    for (const provider of CREDENTIAL_PROVIDER_NAMES) {
      const credential = state.credentials[provider];
      if (credential) {
        parts.push(`${provider} (${credentialLabel(provider, credential)})`);
      } else if (readNonEmptyString(processEnv[defaultKeyEnvFor(provider)])) {
        parts.push(`${provider} (env key)`);
      }
    }
    if (parts.length === 0) {
      return state.provider === 'demo' ? 'demo — offline, no account' : 'none signed in yet';
    }
    if (state.provider === 'demo') {
      parts.push('default: demo');
    }
    return parts.join(' · ');
  };

  const modelsSummary = (): string => {
    if (state.provider === 'demo') {
      return 'demo (no model)';
    }
    const base = `default ${state.model ?? `${defaultModelFor(state.provider)} (default)`}`;
    return state.fallbackModel ? `${base} · fallback ${state.fallbackModel}` : `${base} · no fallback`;
  };

  const signInSummary = (): string => {
    if (state.provider === 'demo') {
      return 'no account needed';
    }
    const credential = state.credentials[state.provider];
    if (credential) {
      return credential.type === 'oauth_token'
        ? (state.provider === 'codex'
            ? 'using your ChatGPT (codex login) sign-in'
            : 'signed in with your Claude subscription')
        : 'signed in with an API key';
    }
    const keyEnv = state.apiKeyEnv ?? defaultKeyEnvFor(state.provider);
    if (readNonEmptyString(processEnv.STRATUS_API_KEY) ?? readNonEmptyString(processEnv[keyEnv])) {
      return `using ${readNonEmptyString(processEnv.STRATUS_API_KEY) ? 'STRATUS_API_KEY' : keyEnv} from your environment`;
    }
    return 'not signed in yet';
  };

  const agentSummary = (): string => {
    if (!state.soulPath) {
      return 'none — every run uses the built-in default agent';
    }
    return state.soulPath;
  };

  const channelsSummary = (): string => {
    const connected = Object.keys(state.channels.slack ?? {}).length;
    if (connected === 0) {
      return 'Slack: not connected';
    }
    return `Slack: ${connected} agent${connected === 1 ? '' : 's'} connected`;
  };

  const storeCredential = (provider: CredentialProviderName, credential: StoredCredential): void => {
    state.credentials[provider] = credential;
    state.credentialsDirty = true;
  };

  const signInAnthropic = async (): Promise<void> => {
    const signedIn = state.credentials.anthropic !== undefined;
    const answer = await prompter.select('How should Stratus connect to Claude?', [
      'Claude subscription (Pro/Max) — sign in through Claude Code, no per-token cost',
      'Anthropic API key — pay per use (console.anthropic.com)',
      'Skip for now',
      ...(signedIn ? ['Sign out'] : []),
    ]);

    if (signedIn && answer.kind === 'index' && answer.index === 3) {
      delete state.credentials.anthropic;
      state.credentialsDirty = true;
      writeLine(streams.stdout, 'Signed out of Anthropic.');
      return;
    }

    if (answer.kind !== 'index' || answer.index === 2) {
      return;
    }

    if (answer.index === 1) {
      const key = await prompter.askSecret('Paste your Anthropic API key (starts with sk-ant-, Enter to skip; input is hidden): ');
      if (!key) {
        writeLine(streams.stdout, 'Skipped — you can sign in any time by re-running this menu.');
        return;
      }
      writeLine(streams.stdout, 'Checking the key against the Anthropic API…');
      // The key is verified against the configured endpoint and bound to
      // it, so a later provider switch (or an anthropic fallback) can never
      // send a proxy credential to the official endpoint.
      const verifyEndpoint = state.provider === 'anthropic' ? state.baseUrl : undefined;
      const binding = verifyEndpoint && verifyEndpoint.replace(/\/+$/, '') !== DEFAULT_ANTHROPIC_BASE_URL
        ? { baseUrl: verifyEndpoint }
        : {};
      const verdict = await verifyProviderKey('anthropic', key, verifyEndpoint, env.fetch ?? globalThis.fetch);
      if (verdict.status === 'ok') {
        storeCredential('anthropic', { type: 'api_key', value: key, ...binding });
        writeLine(streams.stdout, '✓ Key verified — you are signed in to Anthropic.');
      } else if (verdict.status === 'rejected') {
        writeLine(streams.stdout, `✗ Anthropic rejected that key (${verdict.detail}). It was NOT saved — check console.anthropic.com and try again from this menu.`);
      } else {
        storeCredential('anthropic', { type: 'api_key', value: key, ...binding });
        writeLine(streams.stdout, `! Could not reach the Anthropic API to verify (${verdict.detail}). Saved the key anyway — it will be checked on your first run.`);
      }
      return;
    }

    // Default: subscription sign-in via Claude Code.
    writeLine(streams.stdout, 'Your Claude Pro/Max subscription covers usage made through Claude Code.');
    writeLine(streams.stdout, 'In another terminal on this machine, run:');
    writeLine(streams.stdout, '  claude setup-token');
    writeLine(streams.stdout, '(requires Claude Code installed and signed in to your Claude account)');
    const token = await prompter.askSecret('Paste the setup token it prints (starts with sk-ant-oat, Enter to skip; input is hidden): ');
    if (!token) {
      writeLine(streams.stdout, 'Skipped — you can sign in any time by re-running this menu.');
      return;
    }
    storeCredential('anthropic', { type: 'oauth_token', value: token });
    writeLine(streams.stdout, '✓ Subscription token saved. It is verified on your first run.');
  };

  const signInOpenAI = async (): Promise<void> => {
    const currentEndpoint = (state.provider === 'openai' ? state.baseUrl : undefined)
      ?? state.credentials.openai?.baseUrl
      ?? DEFAULT_OPENAI_BASE_URL;
    const baseUrlAnswer = await prompter.ask(`API base URL [${currentEndpoint}]: `);
    const chosenEndpoint = baseUrlAnswer || currentEndpoint;
    // state.baseUrl describes the DEFAULT provider's endpoint; a secondary
    // openai sign-in keeps its endpoint on the credential instead. The
    // change is committed only once a sign-in is accepted — a rejected key
    // must not leave a new endpoint paired with the old credential.
    const commitEndpoint = (): void => {
      if (state.provider === 'openai') {
        state.baseUrl = chosenEndpoint;
      }
    };
    const key = await prompter.askSecret('Paste your API key (Enter to skip; input is hidden): ');
    if (!key) {
      // Without a stored credential there is no old key the new endpoint
      // could be mispaired with.
      if (!state.credentials.openai) {
        commitEndpoint();
      } else if (chosenEndpoint !== currentEndpoint) {
        writeLine(streams.stdout, 'Endpoint left unchanged — paste a key for the new endpoint to switch to it.');
      }
      writeLine(streams.stdout, 'Skipped — you can sign in any time by re-running this menu.');
      return;
    }
    writeLine(streams.stdout, 'Checking the key…');
    // The endpoint travels with the credential, so this sign-in keeps
    // working even when another provider is the default.
    const endpoint = chosenEndpoint !== DEFAULT_OPENAI_BASE_URL ? { baseUrl: chosenEndpoint } : {};
    const verdict = await verifyProviderKey('openai', key, chosenEndpoint, env.fetch ?? globalThis.fetch);
    if (verdict.status === 'ok') {
      storeCredential('openai', { type: 'api_key', value: key, ...endpoint });
      commitEndpoint();
      writeLine(streams.stdout, '✓ Key verified — you are signed in.');
    } else if (verdict.status === 'rejected') {
      writeLine(streams.stdout, `✗ The API rejected that key (${verdict.detail}). It was NOT saved — try again from this menu.`);
      if (chosenEndpoint !== currentEndpoint) {
        writeLine(streams.stdout, 'The endpoint was left unchanged as well.');
      }
    } else {
      storeCredential('openai', { type: 'api_key', value: key, ...endpoint });
      commitEndpoint();
      writeLine(streams.stdout, `! Could not reach the API to verify (${verdict.detail}). Saved the key anyway — it will be checked on your first run.`);
    }
  };

  const signInCodex = async (): Promise<void> => {
    const signedIn = state.credentials.codex !== undefined;
    const answer = await prompter.select('How should Stratus connect to Codex?', [
      'ChatGPT subscription — uses this machine\'s `codex login` sign-in, no per-token cost',
      'OpenAI API key — pay per use (platform.openai.com)',
      'Skip for now',
      ...(signedIn ? ['Sign out'] : []),
    ]);

    if (signedIn && answer.kind === 'index' && answer.index === 3) {
      delete state.credentials.codex;
      state.credentialsDirty = true;
      writeLine(streams.stdout, 'Signed out of Codex. (A `codex login` sign-in, if any, stays with codex itself — run `codex logout` to clear it.)');
      return;
    }

    if (answer.kind !== 'index' || answer.index === 2) {
      return;
    }

    if (answer.index === 1) {
      const key = await prompter.askSecret('Paste your OpenAI API key (Enter to skip; input is hidden): ');
      if (!key) {
        writeLine(streams.stdout, 'Skipped — you can sign in any time by re-running this menu.');
        return;
      }
      writeLine(streams.stdout, 'Checking the key against the OpenAI API…');
      const verdict = await verifyProviderKey('codex', key, undefined, env.fetch ?? globalThis.fetch);
      if (verdict.status === 'ok') {
        storeCredential('codex', { type: 'api_key', value: key });
        writeLine(streams.stdout, '✓ Key verified — Codex runs will bill this OpenAI API key.');
      } else if (verdict.status === 'rejected') {
        writeLine(streams.stdout, `✗ OpenAI rejected that key (${verdict.detail}). It was NOT saved — check platform.openai.com and try again from this menu.`);
      } else {
        storeCredential('codex', { type: 'api_key', value: key });
        writeLine(streams.stdout, `! Could not reach the OpenAI API to verify (${verdict.detail}). Saved the key anyway — it will be checked on your first run.`);
      }
      return;
    }

    // Default: the machine's own ChatGPT sign-in. Codex keeps those tokens
    // in its own auth store; Stratus records only that this machine uses
    // it, so nothing secret is written here.
    writeLine(streams.stdout, 'Your ChatGPT plan covers usage made through Codex.');
    writeLine(streams.stdout, 'If you have not signed in yet, run this in another terminal on this machine:');
    writeLine(streams.stdout, '  codex login');
    writeLine(streams.stdout, '(requires the Codex CLI: npm install -g @openai/codex)');
    const confirmed = await prompter.select('Use this machine\'s codex sign-in?', ['Yes — codex is (or will be) signed in here', 'Skip for now']);
    if (confirmed.kind !== 'index' || confirmed.index !== 0) {
      writeLine(streams.stdout, 'Skipped — you can sign in any time by re-running this menu.');
      return;
    }
    storeCredential('codex', { type: 'oauth_token', value: 'chatgpt' });
    writeLine(streams.stdout, '✓ Recorded — Codex runs use this machine\'s ChatGPT sign-in. It is verified on your first run.');
  };

  // Changing the default provider invalidates settings that were chosen
  // for the old one: the model and apiKeyEnv are cleared (defaults take
  // over), while the openai base URL is kept — it belongs to the openai
  // sign-in and still serves openai fallbacks. A soul that pins a provider
  // outranks the config at run time, so that earns a warning, not a reset.
  const switchDefaultProvider = async (next: CliProviderName): Promise<void> => {
    if (state.provider === next) {
      return;
    }
    state.provider = next;
    delete state.model;
    delete state.apiKeyEnv;
    // state.baseUrl is the DEFAULT provider's endpoint; the old provider's
    // URL must not follow the switch. An openai default reseeds from the
    // credential's bound endpoint.
    delete state.baseUrl;
    if (next === 'openai' && state.credentials.openai?.baseUrl) {
      state.baseUrl = state.credentials.openai.baseUrl;
    }
    if (state.soulPath) {
      try {
        const soul = parseSoul(await readFile(state.soulPath, 'utf8'), { seed: state.soulPath });
        if (soul.provider && soul.provider !== next) {
          writeLine(
            streams.stdout,
            `Heads up: your default agent (${soul.agent.name}) pins provider ${soul.provider} in their soul, which outranks this choice at run time. Edit ${state.soulPath} or clear the agent (menu 3).`,
          );
        }
      } catch {
        // A broken soul file surfaces when it is actually used.
      }
    }
  };

  // Whether a provider could actually serve a run right now, through any
  // credential source a real run would consider: the stored sign-in, the
  // generic STRATUS_API_KEY, a configured apiKeyEnv, or the provider's own
  // env var.
  const providerUsable = (provider: CliProviderName): boolean => {
    if (provider === 'demo') {
      return true;
    }
    const keyEnvSelector = provider === state.provider
      ? readNonEmptyString(processEnv.STRATUS_API_KEY_ENV)
        ?? state.apiKeyEnv
      : undefined;
    return state.credentials[provider] !== undefined
      || readNonEmptyString(processEnv.STRATUS_API_KEY) !== undefined
      || (keyEnvSelector ? readNonEmptyString(processEnv[String(keyEnvSelector)]) !== undefined : false)
      || readNonEmptyString(processEnv[defaultKeyEnvFor(provider)]) !== undefined;
  };

  // Signing in makes that provider the default only when the current
  // default cannot actually run (demo, or a provider with no usable key).
  const maybeSwitchDefault = async (provider: CredentialProviderName): Promise<void> => {
    if (state.provider === 'demo' || (state.provider !== provider && !providerUsable(state.provider))) {
      await switchDefaultProvider(provider);
    }
  };

  const chooseProviders = async (): Promise<void> => {
    const answer = await prompter.select('Providers — sign in to one or more:', [
      `Claude (Anthropic) — ${providerSignInStatus('anthropic')}`,
      `OpenAI-compatible — ${providerSignInStatus('openai')}`,
      `Codex (ChatGPT) — ${providerSignInStatus('codex')}`,
      'Demo — built-in fake model, offline, no account',
      'Back',
    ]);

    if (answer.kind !== 'index' || answer.index === 4) {
      return;
    }

    if (answer.index === 3) {
      await switchDefaultProvider('demo');
      writeLine(streams.stdout, 'Demo selected — no sign-in needed. Mention "echo" or "tool" in a prompt to see tool calls.');
      return;
    }

    if (answer.index === 2) {
      await signInCodex();
      if (state.credentials.codex) {
        await maybeSwitchDefault('codex');
      }
      return;
    }

    if (answer.index === 1) {
      await signInOpenAI();
      if (state.credentials.openai) {
        await maybeSwitchDefault('openai');
      }
      return;
    }

    await signInAnthropic();
    if (state.credentials.anthropic) {
      await maybeSwitchDefault('anthropic');
    }
  };

  // Every model the current sign-ins can actually reach. The rule lives in
  // @stratusagent/state because the control API answers the same question —
  // setup passes the selection it is *holding* rather than the saved one, so
  // a key pasted a moment ago is already in play.
  const collectAvailableModels = (): Promise<CatalogModel[]> => collectModels(
    {
      provider: state.provider,
      ...(state.baseUrl !== undefined ? { baseUrl: state.baseUrl } : {}),
      ...(state.apiKeyEnv !== undefined ? { apiKeyEnv: state.apiKeyEnv } : {}),
      credentials: state.credentials,
    },
    env,
  );

  const pickModel = async (kind: 'default' | 'fallback'): Promise<void> => {
    const available = await collectAvailableModels();
    if (available.length === 0) {
      writeLine(streams.stdout, 'No models available yet — sign in to a provider first (menu 1).');
      return;
    }

    const shown = available.slice(0, 30);
    const labels = shown.map((entry) => `${entry.id} — ${entry.provider}`);
    const typeItOption = labels.length;
    labels.push('Type a model id…');
    const footnote = available.length > shown.length
      ? `  …and ${available.length - shown.length} more — pick "Type a model id…" to name one.`
      : undefined;

    const answer = await prompter.select('Available models:', labels, {
      allowText: true,
      ...(footnote ? { footnote } : {}),
    });
    if (answer.kind === 'back') {
      return;
    }

    const parseTyped = (typed: string): { provider: CredentialProviderName; id: string } | undefined => {
      if (typed.includes(':')) {
        const [providerPart, ...idParts] = typed.split(':');
        const id = idParts.join(':').trim();
        if ((providerPart === 'anthropic' || providerPart === 'openai' || providerPart === 'codex') && id) {
          return { provider: providerPart, id };
        }
        writeLine(streams.stdout, 'Use provider:model, e.g. anthropic:claude-opus-5 or codex:gpt-5.5.');
        return undefined;
      }
      // A typed id that appears in the collected list belongs to that
      // provider, wherever the default currently points.
      const listed = available.find((entry) => entry.id === typed);
      const inferred = listed?.provider
        ?? (state.provider !== 'demo' ? state.provider : available[0]!.provider);
      return { provider: inferred, id: typed };
    };

    let choice: { provider: CredentialProviderName; id: string } | undefined;
    if (answer.kind === 'text') {
      choice = parseTyped(answer.text);
    } else if (answer.index === typeItOption) {
      const typed = await prompter.ask('Model id (or provider:model): ');
      choice = typed ? parseTyped(typed) : undefined;
    } else {
      choice = shown[answer.index];
    }

    if (!choice) {
      return;
    }

    if (kind === 'default') {
      await switchDefaultProvider(choice.provider);
      state.model = choice.id;
      writeLine(streams.stdout, `Default model set to ${choice.id} (${choice.provider}).`);
      // A soul's model pin outranks the config at run time, so a silent
      // mismatch here would make this choice a no-op.
      if (state.soulPath) {
        try {
          const soul = parseSoul(await readFile(state.soulPath, 'utf8'), { seed: state.soulPath });
          if (soul.model && soul.model !== choice.id
            && (soul.provider === undefined || soul.provider === choice.provider)) {
            writeLine(
              streams.stdout,
              `Heads up: your default agent (${soul.agent.name}) pins model ${soul.model} in their soul, which outranks this choice at run time. Edit ${state.soulPath} or clear the agent (menu 3).`,
            );
          }
        } catch {
          // A broken soul file surfaces when it is actually used.
        }
      }
    } else {
      state.fallbackProvider = choice.provider;
      state.fallbackModel = choice.id;
      const openaiEndpoint = (state.provider === 'openai' ? state.baseUrl : undefined)
        ?? state.credentials.openai?.baseUrl;
      if (choice.provider === 'openai' && openaiEndpoint && openaiEndpoint !== DEFAULT_OPENAI_BASE_URL) {
        state.fallbackBaseUrl = openaiEndpoint;
      } else {
        delete state.fallbackBaseUrl;
      }
      if (choice.id === (state.model ?? defaultModelFor(state.provider)) && choice.provider === state.provider) {
        writeLine(streams.stdout, 'Note: the fallback matches the default model, so it will not add resilience.');
      }
      writeLine(streams.stdout, `Fallback model set to ${choice.id} (${choice.provider}) — used when the default model errors mid-run.`);
    }
  };

  const chooseModels = async (): Promise<void> => {
    const answer = await prompter.select(`Models — ${modelsSummary()}`, [
      'Choose the default model',
      'Choose a fallback model',
      'Clear the fallback',
      'Back',
    ]);

    if (answer.kind !== 'index' || answer.index === 3) {
      return;
    }
    if (answer.index === 1) {
      await pickModel('fallback');
      return;
    }
    if (answer.index === 2) {
      delete state.fallbackModel;
      delete state.fallbackProvider;
      writeLine(streams.stdout, 'Fallback cleared.');
      return;
    }
    await pickModel('default');
  };

  const chooseAgent = async (): Promise<void> => {
    const answer = await prompter.select('Your default agent:', [
      'Create a new agent',
      'Use an existing soul file',
      'No default agent',
    ]);

    if (answer.kind !== 'index') {
      return;
    }

    if (answer.index === 2) {
      delete state.soulPath;
      writeLine(streams.stdout, 'Cleared — runs use the built-in default agent.');
      return;
    }

    if (answer.index === 1) {
      const soulAnswer = await prompter.ask('Path to the soul file: ');
      if (!soulAnswer) {
        return;
      }
      const resolved = path.resolve(cwd, soulAnswer);
      try {
        const soul = parseSoul(await readFile(resolved, 'utf8'), { seed: resolved });
        state.soulPath = resolved;
        writeLine(streams.stdout, `Loaded ${soul.agent.name} from ${resolved}.`);
      } catch (error) {
        writeLine(streams.stdout, `Could not load that soul file: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    const name = await prompter.ask('Name your agent (Enter to have one generated): ');
    const instructions = await prompter.ask('Describe their personality in a sentence or two (Enter for a starter you can edit later): ');
    const persona = instructions || DEFAULT_SOUL_STARTER;
    const pin = state.provider !== 'demo'
      ? { provider: state.provider, model: state.model ?? defaultModelFor(state.provider) }
      : {};
    const claimed = await claimSoulFile(
      env,
      { ...(name ? { name } : {}), instructions: persona },
      (agent) => formatSoul({ agent, ...pin }),
      (message) => writeLine(streams.stdout, message),
    );
    const { agent, soulPath } = claimed;
    state.soulPath = soulPath;
    writeLine(streams.stdout, `Say hello to ${agent.name}.`);
    writeLine(streams.stdout, `Their soul lives at ${soulPath} — edit it any time to change how they talk.`);
  };

  // Mirror the saved config's fallback so option 4 exercises the same
  // failover a real run would perform.
  const buildTestFallback = (): FallbackRuntime | undefined => {
    if (!state.fallbackModel || state.provider === 'demo') {
      return undefined;
    }
    const fallbackProvider = (state.fallbackProvider ?? state.provider) as CredentialProviderName;
    const envKey = (fallbackProvider === state.provider
      ? readNonEmptyString(processEnv.STRATUS_API_KEY)
      : undefined)
      ?? readNonEmptyString(processEnv[defaultKeyEnvFor(fallbackProvider)]);
    const candidate = envKey ? undefined : state.credentials[fallbackProvider];
    // A codex fallback consumes no endpoint URL, so a stored key bound to
    // one cannot serve it — the same skip resolveRuntimeConfig performs.
    const credential = fallbackProvider === 'codex' && candidate?.type === 'api_key' && candidate.baseUrl !== undefined
      ? undefined
      : candidate;
    const apiKey = envKey ?? (credential?.type === 'api_key' ? credential.value : undefined);
    // A codex oauth entry is the subscription marker, not a token to send.
    const codexSubscription = fallbackProvider === 'codex' && !apiKey && credential?.type === 'oauth_token';
    const authToken = fallbackProvider !== 'codex' && credential?.type === 'oauth_token' ? credential.value : undefined;
    if (!apiKey && !authToken && !codexSubscription) {
      return undefined;
    }
    return {
      provider: fallbackProvider,
      model: state.fallbackModel,
      ...(fallbackProvider === 'openai'
        ? {
            baseUrl: (credential?.type === 'api_key' ? credential.baseUrl : undefined)
              ?? state.fallbackBaseUrl
              ?? (state.provider === 'openai' ? state.baseUrl : undefined)
              ?? DEFAULT_OPENAI_BASE_URL,
          }
        // The codex harness owns its endpoints; only anthropic can carry one.
        : fallbackProvider === 'codex'
          ? {}
          : (() => {
              const url = (fallbackProvider === state.provider ? state.baseUrl : undefined)
                ?? (credential?.type === 'api_key' ? credential.baseUrl : undefined);
              return url ? { baseUrl: url } : {};
            })()),
      ...(apiKey ? { apiKey } : {}),
      ...(authToken ? { authToken } : {}),
      ...(codexSubscription ? { codexSubscription: true as const } : {}),
    };
  };

  const buildTestRuntime = async (): Promise<RuntimeConfig | undefined> => {
    let soul: ParsedSoul | undefined;
    if (state.soulPath) {
      try {
        soul = parseSoul(await readFile(state.soulPath, 'utf8'), { seed: state.soulPath });
      } catch (error) {
        writeLine(streams.stdout, `Warning: could not load the soul file (${error instanceof Error ? error.message : String(error)}); testing without it.`);
      }
    }

    if (state.provider === 'demo') {
      return { provider: 'demo', ...(soul ? { soul } : {}) };
    }

    // Mirror resolveRuntimeConfig exactly: environment keys (including the
    // STRATUS_API_KEY_ENV selector) outrank the stored sign-in, and a
    // stored key's bound endpoint is authoritative — so the inline test
    // exercises precisely what a real run will use.
    const keyEnv = readNonEmptyString(processEnv.STRATUS_API_KEY_ENV)
      ?? state.apiKeyEnv
      ?? defaultKeyEnvFor(state.provider);
    const envKey = readNonEmptyString(processEnv.STRATUS_API_KEY)
      ?? readNonEmptyString(processEnv[String(keyEnv)]);
    const credential = envKey ? undefined : state.credentials[state.provider];
    const boundUrl = credential?.type === 'api_key' ? credential.baseUrl : undefined;
    const model = state.model ?? defaultModelFor(state.provider);

    if (state.provider === 'anthropic') {
      const apiKey = envKey ?? (credential?.type === 'api_key' ? credential.value : undefined);
      const authToken = credential?.type === 'oauth_token' ? credential.value : undefined;
      if (!apiKey && !authToken) {
        writeLine(streams.stdout, 'You are not signed in yet — pick option 1 first (or export ANTHROPIC_API_KEY).');
        return undefined;
      }
      const fallback = buildTestFallback();
      const anthropicUrl = boundUrl ?? state.baseUrl;
      return {
        provider: 'anthropic',
        model,
        ...(anthropicUrl ? { baseUrl: anthropicUrl } : {}),
        ...(apiKey ? { apiKey } : {}),
        ...(authToken ? { authToken } : {}),
        ...(state.systemPrompt ? { systemPrompt: state.systemPrompt } : {}),
        ...(env.fetch ? { fetch: env.fetch } : {}),
        ...(soul ? { soul } : {}),
        ...(fallback ? { fallback } : {}),
      };
    }

    if (state.provider === 'codex') {
      // The harness owns its endpoints: a key bound to one cannot be
      // honored on codex — resolveRuntimeConfig refuses this outright, and
      // the inline test mirrors it rather than quietly unbinding the key.
      if (boundUrl !== undefined) {
        writeLine(streams.stdout, `Your saved codex key is bound to ${boundUrl}, and codex does not use a custom base URL. Store the key without one to run on codex.`);
        return undefined;
      }
      const apiKey = envKey ?? (credential?.type === 'api_key' ? credential.value : undefined);
      // The subscription marker means the machine's own codex sign-in
      // serves the run — nothing more to resolve here.
      if (!apiKey && credential?.type !== 'oauth_token') {
        writeLine(streams.stdout, 'You are not signed in yet — pick option 1 first (or export CODEX_API_KEY).');
        return undefined;
      }
      const fallback = buildTestFallback();
      return {
        provider: 'codex',
        model,
        ...(apiKey ? { apiKey } : {}),
        ...(state.systemPrompt ? { systemPrompt: state.systemPrompt } : {}),
        ...(env.fetch ? { fetch: env.fetch } : {}),
        ...(soul ? { soul } : {}),
        ...(fallback ? { fallback } : {}),
      };
    }

    const apiKey = envKey ?? (credential?.type === 'api_key' ? credential.value : undefined);
    if (!apiKey) {
      writeLine(streams.stdout, 'You are not signed in yet — pick option 1 first (or export OPENAI_API_KEY).');
      return undefined;
    }
    const fallback = buildTestFallback();
    return {
      provider: 'openai',
      model,
      baseUrl: boundUrl ?? state.baseUrl ?? DEFAULT_OPENAI_BASE_URL,
      apiKey,
      ...(state.systemPrompt ? { systemPrompt: state.systemPrompt } : {}),
      ...(env.fetch ? { fetch: env.fetch } : {}),
      ...(soul ? { soul } : {}),
      ...(fallback ? { fallback } : {}),
    };
  };

  /**
   * Walks an agent through connecting their own Slack app: show the
   * manifest to paste, take both tokens, verify each against Slack, and
   * store them under the agent's id. Tokens are keyed by a roster agent
   * picked from a list rather than typed, so the id can never drift from
   * the roster — the mismatch that otherwise surfaces only as a startup
   * warning about an agent the gateway cannot find.
   */
  const connectSlackAgent = async (agentId: string, agentName: string): Promise<void> => {
    writeLine(streams.stdout);
    writeLine(streams.stdout, `Create a Slack app for ${agentName}:`);
    writeLine(streams.stdout, '  1. Open https://api.slack.com/apps → Create New App → From a manifest');
    writeLine(streams.stdout, '  2. Pick your workspace, then paste this manifest:');
    writeLine(streams.stdout);
    for (const line of slackAppManifest(agentName).split('\n')) {
      writeLine(streams.stdout, `    ${line}`);
    }
    writeLine(streams.stdout);
    writeLine(streams.stdout, '  3. Create the app, then Basic Information → App-Level Tokens →');
    writeLine(streams.stdout, '     Generate a token with the connections:write scope (xapp-…)');
    writeLine(streams.stdout, '  4. Install App → copy the Bot User OAuth Token (xoxb-…)');
    writeLine(streams.stdout, `  5. Basic Information → Display Information → upload ${agentName}'s avatar`);
    writeLine(streams.stdout);

    const appToken = await prompter.askSecret('Paste the app-level token (xapp-…, Enter to cancel; input is hidden): ');
    if (!appToken) {
      writeLine(streams.stdout, 'Cancelled — nothing was saved.');
      return;
    }
    if (!appToken.startsWith('xapp-')) {
      writeLine(streams.stdout, '✗ That does not look like an app-level token (they start with xapp-). Nothing was saved.');
      return;
    }
    const botToken = await prompter.askSecret('Paste the bot user OAuth token (xoxb-…, Enter to cancel; input is hidden): ');
    if (!botToken) {
      writeLine(streams.stdout, 'Cancelled — nothing was saved.');
      return;
    }
    if (!botToken.startsWith('xoxb-')) {
      writeLine(streams.stdout, '✗ That does not look like a bot token (they start with xoxb-). Nothing was saved.');
      return;
    }

    writeLine(streams.stdout, 'Checking the tokens with Slack…');
    const fetchImpl = env.fetch ?? globalThis.fetch;
    const bot = await verifySlackBotToken(botToken, fetchImpl);
    if (bot.status === 'rejected') {
      writeLine(streams.stdout, `✗ Slack rejected the bot token (${bot.detail}). Nothing was saved — reinstall the app and copy the token again.`);
      return;
    }
    const app = await verifySlackAppToken(appToken, fetchImpl);
    if (app.status === 'rejected') {
      writeLine(streams.stdout, `✗ Slack rejected the app-level token (${app.detail}). Nothing was saved — check it has the connections:write scope.`);
      return;
    }

    const slack = { ...(state.channels.slack ?? {}) };
    slack[agentId] = { appToken, botToken };
    state.channels = { ...state.channels, slack };
    state.channelsDirty = true;

    if (bot.status === 'ok' && app.status === 'ok') {
      const where = bot.identity.teamName ? ` in ${bot.identity.teamName}` : '';
      const who = bot.identity.botUserId ? ` (bot ${bot.identity.botUserId})` : '';
      writeLine(streams.stdout, `✓ Verified — ${agentName} is connected to Slack${where}${who}.`);
    } else {
      // Unreachable is not a verdict on the tokens: save and let the
      // daemon report on its first connection attempt.
      const detail = bot.status === 'unreachable' ? bot.detail : (app as { detail?: string }).detail;
      writeLine(streams.stdout, `! Could not reach Slack to verify (${detail}). Saved the tokens anyway — \`${serveCommand()}\` will report on startup.`);
    }
  };

  /**
   * A roster entry with an optional path: the built-in Stratus agent
   * comes from no file at all, exactly as the gateway registers it.
   */
  interface ChannelRosterEntry extends Omit<RosterEntry, 'path'> {
    path?: string;
  }

  /**
   * Every agent the gateway would dispatch to: the built-in Stratus
   * agent, the ~/.stratus/agents roster, and the configured default soul,
   * which `stratus setup` can point at a file anywhere. The gateway
   * registers all three, so a Channels list built from the agents
   * directory alone would hide agents Slack can perfectly well talk to.
   * Reads state.soulPath rather than the saved config so a soul chosen
   * earlier in this same setup session is already connectable.
   */
  const channelRoster = async (): Promise<{ entries: ChannelRosterEntry[]; loaded: boolean }> => {
    const warnOnce = (message: string): void => writeLine(streams.stderr, `Warning: ${message}.`);
    // Seeded before the roster loads, exactly as loadRoster does it: a
    // fresh install with no soul files still has an agent to put on
    // Slack, and a roster file that declares id "stratus" cannot take the
    // built-in's place — the gateway skips it, so offering it here would
    // name an app after an agent that never receives the messages.
    const entries: ChannelRosterEntry[] = [{ soul: { agent: { ...DEFAULT_STRATUS_AGENT } } }];
    // loadRosterSouls refuses a roster whose files collide, and drops the
    // ones claiming the reserved built-in id, so what comes back here is
    // already unambiguous.
    let rosterSouls: RosterEntry[] = [];
    let rosterLoaded = true;
    try {
      rosterSouls = await loadRosterSouls(env, warnOnce);
    } catch (error) {
      // A roster that cannot say who its agents are cannot have channels
      // configured for them — but the rest of setup (providers, models,
      // sign-ins) still works, so this reports and moves on rather than
      // taking the whole command down.
      rosterLoaded = false;
      warnOnce(error instanceof Error ? error.message : String(error));
      // Nothing is offered, not merely the colliding pair. A roster that
      // refuses to load fails `createGateway.start()` outright, so no
      // agent is servable — not the built-in seeded above, and not the
      // configured soul resolved below (which can itself BE one of the
      // colliding files). Listing any of them invites connecting a Slack
      // app to an agent the daemon cannot bring online, and connecting an
      // app is the expensive half of that mistake.
      return { entries: [], loaded: false };
    }
    entries.push(...rosterSouls);

    // The soul a run resolves to, in resolveSoulPath's own order: an env
    // override outranks the config value this setup session is editing.
    // Listing the config soul while `stratus serve` registers the env one
    // would store tokens against an id the adapter then skips.
    const processEnv = readProcessEnv(env);
    const envSoul = readNonEmptyString(processEnv.STRATUS_SOUL);
    if (typeof envSoul === 'string' && state.soulPath && envSoul !== state.soulPath) {
      warnOnce(`STRATUS_SOUL points at ${envSoul}, which outranks the configured ${state.soulPath} — Channels lists what a run would actually use`);
    }
    const effectiveSoul = typeof envSoul === 'string' ? envSoul : state.soulPath;
    if (!effectiveSoul) {
      return { entries, loaded: rosterLoaded };
    }
    const resolved = path.resolve(readWorkingDirectory(env), effectiveSoul);
    if (entries.some((entry) => entry.path === resolved)) {
      return { entries, loaded: rosterLoaded };
    }
    try {
      const soul = await loadSoulFile(resolved);
      // An explicit id can collide with a roster file, or with the
      // built-in. The gateway's defaultAgentId replaces the registered
      // source whenever it is pathless (the built-in) or resolves to a
      // different file, so the configured soul is the one Slack actually
      // dispatches to — offering the namesake here would connect an app
      // to a different agent than it names.
      const collision = entries.findIndex((entry) => entry.soul.agent.id === soul.agent.id);
      if (collision >= 0) {
        entries.splice(collision, 1);
      }
      entries.unshift({ soul, path: resolved });
    } catch (error) {
      warnOnce(`could not read the default soul ${resolved} (${error instanceof Error ? error.message : String(error)})`);
    }
    return { entries, loaded: rosterLoaded };
  };

  const serviceSummary = (): string => {
    if (!servicePlatform(serviceEnvFor(env))) {
      return `not available on ${env.processEnv?.OSTYPE ?? process.platform} — run \`stratus serve\` yourself`;
    }
    if (!state.service.install) {
      return 'off — start stratusd yourself with `stratus serve`';
    }
    return state.service.runAtLogin
      ? 'stratusd runs after setup, and at every login'
      : 'stratusd runs after setup, but not at login';
  };

  /**
   * Whether the roster keeps answering once this terminal closes. On by
   * default: an agent you have to remember to start is not always-on, and
   * every Slack app configured above is silent until stratusd runs.
   */
  const chooseService = async (): Promise<void> => {
    if (!servicePlatform(serviceEnvFor(env))) {
      writeLine(streams.stdout);
      writeLine(streams.stdout, `Stratus has no service integration for ${process.platform} yet — run \`stratus serve\` yourself, or supervise it however you prefer.`);
      await prompter.ask('Press Enter to return to the menu… ');
      return;
    }
    const choice = await prompter.select('Always on — keep stratusd running in the background', [
      'Run after setup, and start again at every login (recommended)',
      'Run after setup, but do not start at login',
      'Do not run it for me — I will start `stratus serve` myself',
      'Back',
    ], {
      footnote: process.platform === 'darwin'
        // Said here rather than left to be discovered after a reboot.
        ? 'A LaunchAgent starts at login, not at power-on. For a machine that should recover unattended, turn on automatic login too.'
        : 'A user service starts at login. `loginctl enable-linger` keeps it up on a machine you do not stay logged in to.',
    });
    if (choice.kind !== 'index' || choice.index === 3) {
      return;
    }
    state.service = {
      install: choice.index !== 2,
      runAtLogin: choice.index === 0,
    };
  };

  const chooseChannels = async (): Promise<void> => {
    while (true) {
      const { entries: roster, loaded: rosterLoaded } = await channelRoster();
      const slack = state.channels.slack ?? {};

      // The roster always holds at least the built-in agent, so there is
      // no empty state to short-circuit on — and short-circuiting would
      // strand orphaned tokens, which are only reachable from this list.
      const options = roster.map((entry) => {
        const id = entry.soul.agent.id;
        const status = slack[id] ? '✓ connected' : '— not connected';
        return `${entry.soul.agent.name} (${id})`.padEnd(34) + status;
      });
      // Orphans: tokens whose agent left the roster would otherwise be
      // invisible here while still being loaded by `stratus serve`.
      //
      // Only when the roster actually loaded. "No agent has this id" is a
      // claim about the roster, and a roster that refused to load cannot
      // support it — every stored token would look orphaned, and this list
      // offers to DELETE them. Losing a working agent's Slack credentials
      // because a different pair of files collided is a far worse outcome
      // than leaving a real orphan on screen for one run.
      const orphans = rosterLoaded
        ? Object.keys(slack).filter((id) => !roster.some((entry) => entry.soul.agent.id === id))
        : [];
      if (!rosterLoaded) {
        writeLine(
          streams.stderr,
          'Warning: no agents are offered while the roster is unreadable — the daemon cannot start either. Fix the roster first.',
        );
      }
      for (const id of orphans) {
        options.push(`${id}`.padEnd(34) + '! tokens without a matching agent');
      }
      options.push('Back');

      const choice = await prompter.select(
        'Channels — Slack (one app per agent: its own name, avatar, and presence)',
        options,
        { footnote: `Run \`${serveCommand()}\` afterwards to bring the connected agents online.` },
      );
      if (choice.kind !== 'index' || choice.index === options.length - 1) {
        return;
      }

      if (choice.index >= roster.length) {
        // An orphaned entry — offer to clear it.
        const orphanId = orphans[choice.index - roster.length];
        if (!orphanId) {
          return;
        }
        const confirm = await prompter.select(`No agent with id ${orphanId} is in the roster.`, [
          'Remove these Slack tokens',
          'Keep them',
        ]);
        if (confirm.kind === 'index' && confirm.index === 0) {
          const next = { ...slack };
          delete next[orphanId];
          state.channels = { ...state.channels, slack: next };
          state.channelsDirty = true;
          writeLine(streams.stdout, `Removed the Slack tokens for ${orphanId}.`);
        }
        continue;
      }

      const entry = roster[choice.index];
      if (!entry) {
        return;
      }
      const agentId = entry.soul.agent.id;
      const agentName = entry.soul.agent.name;

      if (!slack[agentId]) {
        await connectSlackAgent(agentId, agentName);
        continue;
      }

      const action = await prompter.select(`${agentName} is connected to Slack.`, [
        'Replace the tokens (re-run the app setup)',
        'Disconnect from Slack (forget the tokens)',
        'Back',
      ]);
      if (action.kind !== 'index' || action.index === 2) {
        continue;
      }
      if (action.index === 0) {
        await connectSlackAgent(agentId, agentName);
        continue;
      }
      const next = { ...slack };
      delete next[agentId];
      state.channels = { ...state.channels, slack: next };
      state.channelsDirty = true;
      writeLine(streams.stdout, `${agentName} is no longer connected to Slack. The Slack app itself still exists — delete it at api.slack.com/apps if you are done with it.`);
    }
  };

  const testRun = async (): Promise<void> => {
    const runtime = await buildTestRuntime();
    if (!runtime) {
      return;
    }
    writeLine(streams.stdout, `Running a quick hello (${formatRuntimeBanner(runtime).replace('Starting Stratus Agent local loop with ', '')})…`);
    try {
      const session = await runSingleLoop(
        'Say hello and introduce yourself in one short sentence.',
        streams,
        { events: false, runtime, env },
      );
      printSessionSummary(session, streams);
      writeLine(streams.stdout);
      if (prompter.isInteractive()) {
        await prompter.ask('Press Enter to return to the menu… ');
        recentNotices.length = 0;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeLine(streams.stdout, `Test run failed: ${message}`);
      if (runtime.provider === 'anthropic' && runtime.authToken && /Claude Code|\b(401|403|429)\b/.test(message)) {
        writeLine(streams.stdout, 'Subscription runs go through Claude Code. Make sure it is installed (npm install -g @anthropic-ai/claude-code) and signed in (run `claude`), or sign in with an Anthropic API key instead (Providers menu → Claude → API key).');
      } else if (/\b429\b/.test(message)) {
        writeLine(streams.stdout, 'A 429 means the provider rate-limited the request. On a new Anthropic account this usually means no purchased credits yet — check console.anthropic.com → Billing and Limits, then try again.');
      } else if (/\b(401|403)\b/.test(message)) {
        writeLine(streams.stdout, 'The provider rejected the credential — re-run sign-in from the Providers menu.');
      }
    }
  };

  const detectEnvOverride = (
    primary: string,
    chosen: string,
    flagName?: string,
  ): { envVar: string; envValue: string; flag?: string } | undefined => {
    if (!readNonEmptyString(processEnv[primary])) {
      return undefined;
    }
    const envValue = String(processEnv[primary]).trim();
    if (envValue === chosen) {
      return undefined;
    }
    return {
      envVar: primary,
      envValue,
      ...(flagName ? { flag: `${flagName} ${quoteShellArg(chosen)}` } : {}),
    };
  };

  /**
   * An optional package this setup's own choices imply, and why. Setup knows
   * both facts before the daemon does — that Slack tokens were just stored,
   * and that it is about to recommend `stratus dashboard` — so it is the one
   * place that can offer the install rather than leave the gap to be found
   * in a log after the fact.
   */
  interface PackageGroup {
    id: 'slack' | 'dashboard';
    label: string;
    why: string;
    packages: string[];
  }

  /**
   * Whether `stratus dashboard` can work. Read before the offer and set by
   * it, so the closing suggestions never name a command this machine cannot
   * run — the failure that sends someone to the logs to find out why.
   */
  let dashboardReady = packageInstalled('@stratusagent/control-api', env)
    && packageInstalled('@stratusagent/dashboard', env);

  const missingPackageGroups = (): PackageGroup[] => {
    const groups: PackageGroup[] = [];
    const slackAgents = Object.keys(state.channels.slack ?? {}).length;
    if (slackAgents > 0 && !packageInstalled('@stratusagent/channel-slack', env)) {
      groups.push({
        id: 'slack',
        label: 'Slack channel',
        why: `Slack tokens are stored for ${slackAgents} agent(s), but nothing connects to Slack without it`,
        packages: ['@stratusagent/channel-slack'],
      });
    }
    // Both, because the dashboard is what was offered: the control API is
    // the port and the dashboard is the page served on it. Only the missing
    // half is installed, so accepting this on a machine that already has
    // the API does not reinstall it.
    const dashboardPackages = ['@stratusagent/control-api', '@stratusagent/dashboard']
      .filter((name) => !packageInstalled(name, env));
    if (dashboardPackages.length > 0) {
      groups.push({
        id: 'dashboard',
        label: 'Web dashboard',
        why: '`stratus dashboard` needs it, and it opens an authenticated port on 127.0.0.1',
        packages: dashboardPackages,
      });
    }
    return groups;
  };

  /**
   * Offers the packages above. Declining is a real answer and prints the
   * command; the control API in particular binds a port, and installing it
   * is how an operator says they want one open, so this asks rather than
   * deciding for them.
   */
  const offerOptionalPackages = async (): Promise<void> => {
    const groups = missingPackageGroups();
    if (groups.length === 0) {
      return;
    }
    writeLine(streams.stdout);
    writeLine(streams.stdout, groups.length === 1
      ? 'One optional package is not installed:'
      : `${groups.length} optional packages are not installed:`);
    for (const group of groups) {
      writeLine(streams.stdout, `  ${group.packages.join(' ')}`);
      writeLine(streams.stdout, `    ${group.why}.`);
    }

    const answer = await prompter.select('Install now with npm install -g?', groups.length === 1
      ? ['Install it now', 'Skip']
      : ['Install all of them now', ...groups.map((group) => `Install the ${group.label} only`), 'Skip']);

    const chosen = ((): PackageGroup[] => {
      if (answer.kind !== 'index') {
        return [];
      }
      if (groups.length === 1) {
        return answer.index === 0 ? groups : [];
      }
      if (answer.index === 0) {
        return groups;
      }
      const only = groups[answer.index - 1];
      return only ? [only] : [];
    })();

    // Held before the install rather than derived after it: picking one
    // group is not a decision about the other, and the daemon starts a few
    // lines below and warns about exactly what is still missing — the
    // notice this whole offer exists to pre-empt.
    const declined = groups.filter((group) => !chosen.includes(group));

    if (chosen.length > 0) {
      const packages = chosen.flatMap((group) => group.packages);
      writeLine(streams.stdout, `Running: npm install -g ${packages.join(' ')}`);
      // Never fails setup — not even its exit code, unlike the always-on
      // service step below: the config and credentials are already written,
      // and a package that did not install is a warning at the next start,
      // not a broken machine.
      const result = await (env.packageInstaller ?? defaultPackageInstaller)(packages)
        .catch((error: unknown) => ({
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        }));
      if (result.ok) {
        writeLine(streams.stdout, `Installed ${packages.join(' ')}.`);
        // npm's exit code, not a second resolve: a package written into the
        // global prefix a moment ago need not be resolvable from THIS
        // process, whose module resolution was fixed when it started.
        if (chosen.some((group) => group.id === 'dashboard')) {
          dashboardReady = true;
        }
      } else {
        writeLine(streams.stderr, `Could not install: ${result.message}`);
        writeLine(streams.stderr, `Setup is saved either way — run \`npm install -g ${packages.join(' ')}\` yourself.`);
      }
    }

    if (declined.length > 0) {
      const rest = declined.flatMap((group) => group.packages).join(' ');
      writeLine(streams.stdout, chosen.length > 0
        ? `Still missing. Install with: npm install -g ${rest}`
        : `Skipped. Install them yourself with: npm install -g ${rest}`);
    }
  };

  /**
   * Write everything the menu decided, then report whether the always-on
   * service step it performed — installing the service, or removing one the
   * user chose not to run — succeeded.
   *
   * A boolean rather than a throw: the service is the one optional part of
   * setup and everything else is already on disk by the time it runs, so
   * failing outright would lose the saved config to a service that can be
   * installed (or removed) later. The exit code carries it instead — the
   * same answer `stratus service install` and `stratus service uninstall`
   * give for the identical failure, which is what a script driving setup
   * has to be able to see.
   */
  const save = async (): Promise<boolean> => {
    // The always-on service step is the only one here that can fail without
    // taking the rest of setup with it, so it is the only one the exit code
    // has to carry. Both signs count: a unit left in place after "do not run
    // it for me" starts a daemon at login the user asked not to have, which
    // is no more a successful setup than one that will not come up at all.
    let serviceStepFailed = false;
    const config: Record<string, string> = { provider: state.provider };
    if (state.provider !== 'demo') {
      config.model = state.model ?? defaultModelFor(state.provider);
    }
    if (state.provider === 'openai') {
      config.baseUrl = state.baseUrl ?? state.credentials.openai?.baseUrl ?? DEFAULT_OPENAI_BASE_URL;
    } else if (state.provider === 'anthropic' && state.baseUrl) {
      // A configured anthropic endpoint (a proxy) must survive re-running
      // setup, or runs silently revert to the official endpoint.
      config.baseUrl = state.baseUrl;
    }
    if (state.apiKeyEnv) {
      config.apiKeyEnv = state.apiKeyEnv;
    }
    if (state.systemPrompt) {
      config.systemPrompt = state.systemPrompt;
    }
    if (state.soulPath) {
      config.soul = state.soulPath;
    }
    if (state.provider !== 'demo' && state.fallbackModel) {
      config.fallbackModel = state.fallbackModel;
      config.fallbackProvider = state.fallbackProvider ?? state.provider;
      if (config.fallbackProvider === 'openai' && state.fallbackBaseUrl) {
        config.fallbackBaseUrl = state.fallbackBaseUrl;
      }
    }

    await saveConfigFile(configPath, config);

    writeLine(streams.stdout);
    writeLine(streams.stdout, `Wrote ${configPath}`);

    // A project-local config in this directory outranks the global file for
    // bare runs started here — say so, and make the suggested command pick
    // the file that was just written.
    if (configPath === globalConfigPath(env)) {
      const shadowPath = path.join(cwd, DEFAULT_CONFIG_FILENAME);
      try {
        await readFile(shadowPath, 'utf8');
        writeLine(streams.stdout, `Note: ${shadowPath} exists and takes precedence over the global config for runs started in this directory.`);
        writeLine(streams.stdout, 'The suggested commands below include --config so they use what you just saved.');
        shadowConfigFlag = ` --config ${quoteShellArg(configPath)}`;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
    if (state.credentialsDirty) {
      await saveCredentials(env, state.credentials);
      writeLine(streams.stdout, `Saved your sign-in to ${credentialsPath(env)} (readable only by you).`);
    }
    if (state.channelsDirty) {
      // Channel tokens live in their own namespace of the same file; the
      // writers merge, so this never clobbers the provider sign-in above.
      await saveChannelCredentials(env, state.channels);
      const connected = Object.keys(state.channels.slack ?? {}).length;
      writeLine(streams.stdout, connected > 0
        ? `Saved Slack tokens for ${connected} agent${connected === 1 ? '' : 's'} to ${credentialsPath(env)} — run \`${serveCommand()}\` to bring them online.`
        : `Removed the stored Slack tokens from ${credentialsPath(env)}.`);
    }

    // Before the service block below, deliberately. A package installed
    // after the daemon starts is invisible to it — installing does not
    // reload a running process — so offering here is what makes the
    // LaunchAgent come up with the Slack channel and the control API
    // already present, instead of warning about them in a log nobody reads
    // until the dashboard fails.
    await offerOptionalPackages();

    // Last, so the daemon starts against the config and credentials that
    // were just written rather than the ones it would have found a moment
    // ago. A service failure is reported and never fails setup: the
    // settings are already saved, and `stratus serve` still works by hand.
    if (!state.service.install && servicePlatform(serviceEnvFor(env))) {
      // Opting out has to actually take effect. Skipping the install would
      // leave a unit from an earlier setup running and enabled at login,
      // while the menu said "off" — still burning provider usage and still
      // answering in Slack after an explicit opt-out.
      const existing = await readServiceStatus(serviceEnvFor(env)).catch(() => undefined);
      if (existing?.installed) {
        // Removal deletes the unit file, so it can reject the same way the
        // install can. Setup's settings are already written by this point;
        // the optional service must not take the whole command down.
        const removed = await uninstallService(serviceEnvFor(env)).catch((error: unknown) => ({
          ok: false,
          messages: [
            `Could not remove the always-on service: ${error instanceof Error ? error.message : String(error)}`,
            `${serviceUnitPath(serviceEnvFor(env))} is still in place — remove it by hand, or it will start again at login.`,
          ],
        }));
        for (const message of removed.messages) {
          writeLine(removed.ok ? streams.stdout : streams.stderr, message);
        }
        if (!removed.ok) {
          serviceStepFailed = true;
        }
      }
    } else if (state.service.install && servicePlatform(serviceEnvFor(env))) {
      // The unit is pinned to the file setup just wrote. Its working
      // directory is the home directory, so discovery from there would
      // find a different config whenever setup was run with --config or
      // STRATUS_CONFIG — the daemon would come up on another roster and
      // leave the Slack apps configured above offline.
      // installService writes files, so it can reject outright — an
      // inaccessible ~/Library/LaunchAgents, a read-only home. Letting
      // that escape would fail setup itself, after the config and
      // credentials were already saved, when the always-on service is the
      // one optional part of it.
      const result = await installService(serviceEnvFor(env), {
        runAtLogin: state.service.runAtLogin,
        configPath,
      }).catch((error: unknown) => ({
        ok: false,
        messages: [`Could not install the always-on service: ${error instanceof Error ? error.message : String(error)}`],
      }));
      for (const message of result.messages) {
        writeLine(result.ok ? streams.stdout : streams.stderr, message);
      }
      if (!result.ok) {
        writeLine(streams.stderr, `Setup is saved either way — start the daemon yourself with \`${serveCommand()}\`.`);
        serviceStepFailed = true;
      }
    }
    writeLine(streams.stdout);

    // Exported STRATUS_* variables outrank the config file, so warn when one
    // would make `stratus run` behave differently from what was just saved.
    const conflicts = [
      detectEnvOverride('STRATUS_PROVIDER', state.provider, '--provider'),
      ...(state.provider !== 'demo'
        ? [detectEnvOverride('STRATUS_MODEL', state.model ?? defaultModelFor(state.provider), '--model')]
        : []),
      ...(state.provider === 'openai'
        ? [detectEnvOverride('STRATUS_BASE_URL', state.baseUrl ?? DEFAULT_OPENAI_BASE_URL, '--base-url')]
        : [detectEnvOverride('STRATUS_BASE_URL', '')]),
      detectEnvOverride('STRATUS_SYSTEM_PROMPT', state.systemPrompt ?? ''),
    ].filter((conflict) => conflict !== undefined);

    for (const conflict of conflicts) {
      writeLine(
        streams.stdout,
        `Note: ${conflict.envVar}=${conflict.envValue} is exported and takes precedence over the config file (run \`unset ${conflict.envVar}\` to clear it).`,
      );
    }
    if (conflicts.some((conflict) => conflict.flag)) {
      writeLine(streams.stdout, 'The suggested commands below include flags so they use what you just configured.');
    }
    if (conflicts.length > 0) {
      writeLine(streams.stdout);
    }
    const extraFlags = conflicts.flatMap((conflict) => (conflict.flag ? [` ${conflict.flag}`] : [])).join('');

    if (state.provider === 'demo') {
      writeLine(streams.stdout, 'You are ready to go — no account needed. Try:');
    } else if (readNonEmptyString(processEnv.STRATUS_API_KEY)) {
      writeLine(streams.stdout, 'STRATUS_API_KEY is exported and takes precedence over your saved sign-in. You are ready to go. Try:');
    } else if (state.credentials[state.provider]) {
      writeLine(streams.stdout, `You are ${signInSummary()} — ready to go. Try:`);
    } else {
      const keyEnv = state.apiKeyEnv ?? defaultKeyEnvFor(state.provider);
      if (readNonEmptyString(processEnv[keyEnv])) {
        writeLine(streams.stdout, `${keyEnv} is set in your environment — you are ready to go. Try:`);
      } else {
        writeLine(streams.stdout, 'You are NOT signed in yet — re-run `stratus setup` and pick option 1, or:');
        writeLine(streams.stdout, `  export ${keyEnv}=your-key`);
        writeLine(streams.stdout);
        writeLine(streams.stdout, 'Then try:');
      }
    }
    writeLine(streams.stdout, `  stratus run${extraFlags}${runConfigFlag}${shadowConfigFlag} "say hello"`);
    if (dashboardReady) {
      writeLine(streams.stdout, '  stratus dashboard');
    }
    return !serviceStepFailed;
  };

  try {
    if (!interactive) {
      writeLine(streams.stdout, 'Stratus Agent setup');
      writeLine(streams.stdout, 'Pick a provider, sign in, and create your agent — all from this menu.');
    }
    if (envConfigVar && !command.configPath) {
      writeLine(streams.stdout, `${envConfigVar} is set, so the config will be written to ${configPath}.`);
    }

    while (true) {
      writeLine(streams.stdout);
      const choice = await prompter.select('', [
        `Providers            ${providersSummary()}`,
        `Models               ${modelsSummary()}`,
        `Agent                ${agentSummary()}`,
        `Channels             ${channelsSummary()}`,
        `Always on            ${serviceSummary()}`,
        'Test run             say hello with the current settings',
        'Save & finish',
      ]);

      // Backing out of the top level (Esc, or the input ending) saves.
      if (choice.kind !== 'index' || choice.index === 6) {
        break;
      }

      if (choice.index === 0) {
        await chooseProviders();
      } else if (choice.index === 1) {
        await chooseModels();
      } else if (choice.index === 2) {
        await chooseAgent();
      } else if (choice.index === 3) {
        await chooseChannels();
      } else if (choice.index === 4) {
        await chooseService();
      } else if (choice.index === 5) {
        await testRun();
      }
    }

    // Non-zero when the always-on service step failed, matching `stratus
    // service install` and `stratus service uninstall`. Everything setup
    // saved is still saved, and the output above says so — but a daemon that
    // will not come up at login, or one that will after the user said not to
    // run it, is not a successful setup, and a script that only reads the
    // exit code had no way to tell.
    return (await save()) ? 0 : 1;
  } finally {
    prompter.close();
  }
};

/**
 * The bearer token for a gateway: an explicit flag, the environment, or the
 * token file this machine's daemon wrote.
 *
 * The file is the normal case and the reason `--gateway` needs no ceremony
 * locally. It is not always right, though: a gateway reached through a tunnel
 * has its own token, which is what the flag and the variable are for.
 */
const gatewayToken = async (
  env: CliEnvironment,
  explicit: string | undefined,
): Promise<string> => {
  const fromEnv = readNonEmptyString(readProcessEnv(env).STRATUS_GATEWAY_TOKEN);
  if (explicit || fromEnv) {
    return String(explicit ?? fromEnv);
  }
  try {
    return (await readFile(gatewayTokenPath(env), 'utf8')).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    throw new Error(
      `No gateway token: ${gatewayTokenPath(env)} does not exist, and neither --token nor STRATUS_GATEWAY_TOKEN was set. `
      + 'Start the daemon with `stratus serve` (or `stratus service install`) to create one, or pass the remote gateway\'s token.',
    );
  }
};

/** Ask a running gateway for its roster, as data. */
const remoteAgentSummaries = async (
  command: ParsedAgentsCommand,
  env: CliEnvironment,
): Promise<AgentSummary[]> => {
  const token = await gatewayToken(env, command.token);
  const base = String(command.gateway).replace(/\/+$/, '');
  const fetchImpl = env.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is unavailable, so --gateway cannot reach a daemon from this runtime.');
  }

  let response: Response;
  try {
    response = await fetchImpl(`${base}/api/v1/agents`, {
      headers: { authorization: `Bearer ${token}` },
    });
  } catch (error) {
    throw new Error(
      `Could not reach the gateway at ${base} (${error instanceof Error ? error.message : String(error)}). `
      + 'Is stratusd running, and does it have @stratusagent/control-api installed?',
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`The gateway at ${base} rejected this token. Check --token, STRATUS_GATEWAY_TOKEN, or ~/.stratus/gateway-token.`);
  }
  if (!response.ok) {
    throw new Error(`The gateway at ${base} answered HTTP ${response.status} for the roster.`);
  }
  const payload = await response.json() as { agents?: AgentSummary[] };
  return payload.agents ?? [];
};

export const runAgents = async (
  command: ParsedAgentsCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  // The same listing either way — the shared builder produces it locally, and
  // the control API serves exactly what that builder produced. Rendering is
  // the only thing this command does with it.
  let listings: AgentSummary[];
  if (command.gateway) {
    listings = await remoteAgentSummaries(command, env);
  } else {
    // Fold any legacy per-directory memory in first so the counts below
    // reflect everything each agent actually remembers.
    await migrateLegacyMemory(env);
    listings = await listAgentSummaries(env, (message) => {
      writeLine(streams.stderr, `Warning: ${message}.`);
    });
  }

  // The palette travels structurally now, because a web or macOS surface has
  // to draw it. This output has always been one prose line, and a shape
  // change here would break every script reading it — so the rendering, not
  // the data, stays where it was.
  const describeAvatar = (avatar: AvatarTheme): string =>
    `${avatar.style} theme, hue ${avatar.hue}, palette ${avatar.palette.join(' ')}`;

  if (command.format === 'json') {
    writeLine(streams.stdout, JSON.stringify({
      agents: listings.map(({ default: isDefault, avatar, ...rest }) => ({
        ...rest,
        ...(avatar ? { avatar: describeAvatar(avatar) } : {}),
        default: isDefault,
      })),
    }, null, 2));
    return 0;
  }

  const describeRunsOn = (runsOn: { provider: string; model?: string }): string =>
    (runsOn.provider === 'demo' ? 'demo (offline)' : `${runsOn.provider}${runsOn.model ? ` · ${runsOn.model}` : ''}`);

  writeLine(streams.stdout, command.gateway ? `Agents on ${command.gateway}` : 'Agents');
  for (const agent of listings) {
    const labels = [
      ...(agent.default ? ['default'] : []),
      ...(agent.builtIn ? ['built-in'] : []),
    ];
    writeLine(streams.stdout);
    writeLine(streams.stdout, `  ${agent.name}${labels.length > 0 ? `  (${labels.join(', ')})` : ''}`);
    writeLine(streams.stdout, `    id        ${agent.id}`);
    if (agent.soulPath) {
      writeLine(streams.stdout, `    soul      ${agent.soulPath}`);
    }
    writeLine(streams.stdout, `    runs on   ${agent.provider ? describeRunsOn(agent.runsOn) : `follows your setup — currently ${describeRunsOn(agent.runsOn)}`}`);
    writeLine(streams.stdout, `    memory    ${agent.memories === 0 ? 'nothing yet' : `${agent.memories} remembered fact${agent.memories === 1 ? '' : 's'}`}`);
    if (agent.persona) {
      writeLine(streams.stdout, `    persona   ${agent.persona}`);
    }
    if (agent.avatar) {
      writeLine(streams.stdout, `    avatar    ${describeAvatar(agent.avatar)}`);
    }
  }
  writeLine(streams.stdout);
  writeLine(streams.stdout, listings.length === 1
    ? 'That is just the built-in default — create your own with: stratus agent new'
    : 'Talk to the default with stratus run, or to anyone with stratus run --soul <file>.');
  return 0;
};

/** One resolved setting, with the thing that decided it. */
interface DoctorSetting {
  value: string;
  source: string;
}

export interface DoctorReport {
  configInUse?: string;
  /** Config files that exist but lost to `configInUse`, nearest first. */
  configShadowed: string[];
  provider: DoctorSetting;
  model?: DoctorSetting;
  soul?: DoctorSetting;
  agent?: string;
  /** The model a failing run retries on, when one is configured. */
  fallback?: { provider: string; model: string };
  signIns: Array<{ provider: CredentialProviderName; status: string }>;
  slackAgents: string[];
  slackPackageInstalled: boolean;
  rosterCount: number;
  problems: string[];
}

/**
 * `stratus doctor` — what a run would resolve to right now, and which file
 * or variable decided each part. Every "why is it using X" question needs
 * the precedence chain, and reading it out of the source is not something
 * anyone should have to do.
 */
export const collectDoctorReport = async (
  command: ParsedDoctorCommand,
  warn: (message: string) => void,
  env: CliEnvironment = {},
): Promise<DoctorReport> => {
  const processEnv = readProcessEnv(env);
  const cwd = readWorkingDirectory(env);
  const problems: string[] = [];

  // Config discovery, spelled out rather than delegated: doctor has to
  // report the files that LOST as well as the one in use, which is the
  // whole point when a stray project config is the answer.
  // Which of the two named it, not just that one did: telling someone to
  // fix STRATUS_CONFIG when --config is what is set leaves the real
  // override in place — the same mistake as provider and key attribution,
  // in the one place a typo is most likely.
  const explicitSource = command.configPath !== undefined
    ? { name: '--config', value: command.configPath }
    : readNonEmptyString(processEnv.STRATUS_CONFIG)
      ? { name: 'STRATUS_CONFIG', value: String(processEnv.STRATUS_CONFIG) }
      : undefined;
  const explicit = explicitSource?.value;
  const candidates = explicitSource
    ? [{ path: path.resolve(cwd, explicitSource.value), label: explicitSource.name }]
    : [
        { path: path.join(cwd, DEFAULT_CONFIG_FILENAME), label: 'project' },
        { path: globalConfigPath(env), label: 'global' },
      ];
  const present: Array<{ path: string; label: string }> = [];
  let unreadable: { path: string; label: string } | undefined;
  for (const candidate of candidates) {
    try {
      await readFile(candidate.path, 'utf8');
      present.push(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        // resolveConfigLocation throws here rather than trying the next
        // candidate, so discovery stops: a lower-priority file that a real
        // run never reaches must not be reported as the config in use.
        unreadable = candidate;
        problems.push(`${candidate.path} exists but cannot be read (${(error as Error).message}). Every run fails here — discovery never reaches a lower-priority config.`);
        break;
      }
      if (explicit) {
        // Discovery treats a missing candidate as "try the next one", but
        // an explicitly named config has no next one: a real run calls
        // loadConfigFile on it and fails. Reporting built-in defaults here
        // would describe a run that cannot happen, and hide the typo.
        problems.push(
          `${candidate.path} does not exist, but ${candidate.label} names it — every run with this setting fails. `
          + 'Fix the path, or drop the setting to fall back to config discovery.',
        );
      }
    }
  }
  const winner = unreadable ?? present[0];
  const shadowed = unreadable ? [] : present.slice(1);
  if (winner && shadowed.length > 0 && winner.label.startsWith('project')) {
    problems.push(
      `${winner.path} outranks ${shadowed.map((entry) => entry.path).join(' and ')} for runs started in this directory. `
      + 'Run from elsewhere, or pass --config to pick one explicitly.',
    );
  }

  let fileConfig: StratusConfigFile = {};
  let configFatal = unreadable !== undefined;
  if (winner && !unreadable) {
    try {
      fileConfig = await loadConfigFile(winner.path);
    } catch (error) {
      // resolveRuntimeConfig propagates this — no run reaches provider or
      // credential resolution, so presenting defaults as resolved settings
      // would describe a run that cannot happen.
      configFatal = true;
      problems.push(`${winner.path} could not be parsed (${(error as Error).message}). Every run fails until it is fixed or removed.`);
      warn(`ignoring unreadable config ${winner.path}`);
    }
  }

  // Which variable supplied a value, not just the value: naming the wrong
  // one sends the reader to unset something that was never the cause,
  // leaving the real override in place.
  const envPick = (name: string): { name: string; value: string } | undefined => {
    const value = readNonEmptyString(processEnv[name]);
    return typeof value === 'string' ? { name, value } : undefined;
  };

  /**
   * The verdict comes from the resolver, not from a second copy of its
   * rules. Everything below only *attributes* values to the file or
   * variable that supplied them — which the resolver does not report —
   * while whether a run works at all, and what it bills, is whatever
   * resolveRuntimeConfig actually returns or throws.
   */
  const envSoul = envPick('STRATUS_SOUL');
  const soulValue = envSoul?.value ?? fileConfig.soul;
  const soulSource = envSoul ? envSoul.name : (winner ? winner.path : '');
  const soulPath = typeof soulValue === 'string' ? path.resolve(cwd, soulValue) : undefined;
  // Loaded here for ATTRIBUTION only — the soul's frontmatter is what
  // explains a provider nobody wrote in a config file. Whether a run works
  // is still the resolver's verdict below.
  const soul = soulPath ? await loadSoulFile(soulPath).catch(() => undefined) : undefined;

  let resolved: RuntimeConfig | undefined;
  if (!configFatal) {
    try {
      resolved = await resolveStateRuntimeConfig(
        command.configPath ? { configPath: command.configPath } : {},
        env,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      problems.push(`No run can start: ${message}`);
      if (soulPath && /soul/i.test(message)) {
        // Worth saying explicitly: a soul that fails to load is fatal, not
        // a quiet downgrade to the built-in agent.
        problems.push(
          `Every run fails until ${soulPath} is fixed or the soul setting is removed — the built-in agent is not substituted.`,
        );
      }
    }
  }

  const envProviderPick = envPick('STRATUS_PROVIDER');
  const providerSource = envProviderPick
    ? envProviderPick.name
    : soul?.provider
      ? `${soulPath} (soul frontmatter)`
      : fileConfig.provider
        ? (winner?.path ?? 'config')
        : 'built-in default — nothing set a provider';
  // When resolution fails the intended provider is still worth reporting:
  // "why is it anthropic" is exactly the question, and the problems below
  // already say no run can start.
  const intendedProvider = envProviderPick?.value ?? soul?.provider ?? fileConfig.provider ?? 'demo';
  const provider: DoctorSetting = resolved
    ? { value: resolved.provider, source: providerSource }
    : { value: `${intendedProvider} (unreachable)`, source: providerSource };

  if (provider.value === 'demo') {
    // Setup writes the config file, which is the LOWEST precedence of the
    // three — so when an env var or a soul chose demo, "run setup" is
    // advice that changes nothing and leaves every run on demo.
    const fix = envProviderPick
      ? `Unset ${envProviderPick.name}; it outranks both your config and any soul.`
      : soul?.provider === 'demo'
        ? `Change or remove the provider pin in ${soulPath}; a soul outranks the config file.`
        : fileConfig.provider === 'demo'
          ? `Change "provider" in ${winner?.path}, or run \`stratus setup\` → Providers.`
          : 'Run `stratus setup` → Providers and sign in, then Save & finish.';
    problems.push(`Provider is the offline demo model, so replies are canned. ${fix}`);
  }

  let model: DoctorSetting | undefined;
  if (resolved && resolved.provider !== 'demo') {
    const envModel = envPick('STRATUS_MODEL');
    // A soul's model belongs to the soul's provider, and the config's model
    // to the config's provider — either can be stranded by an override.
    const soulModelApplies = soul?.provider === undefined || soul.provider === resolved.provider;
    const configModelApplies = (fileConfig.provider ?? 'openai') === resolved.provider;
    model = {
      value: resolved.model,
      source: envModel
        ? envModel.name
        : soulModelApplies && soul?.model === resolved.model
          ? `${soulPath} (soul frontmatter)`
          : configModelApplies && fileConfig.model === resolved.model
            ? (winner?.path ?? 'config')
            : 'built-in default for this provider',
    };
  }

  const credentials = await loadCredentials(env);
  const signIns: DoctorReport['signIns'] = [];
  const usedKeyEnvVar = resolved && resolved.provider !== 'demo' ? resolved.apiKeyEnvVar : undefined;
  const usesAuthToken = resolved?.provider === 'anthropic' && resolved.authToken !== undefined;
  const fallback = resolved && resolved.provider !== 'demo' ? resolved.fallback : undefined;

  for (const target of CREDENTIAL_PROVIDER_NAMES) {
    const stored = credentials[target];
    const label = stored?.type === 'oauth_token'
      ? (target === 'codex' ? 'ChatGPT sign-in (codex login)' : 'Claude subscription (Pro/Max)')
      : 'API key';
    const isDefault = resolved?.provider === target;
    const isFallback = fallback?.provider === target;

    // A provider no resolved run consults is reported, never diagnosed:
    // flagging an override on a credential nothing reads is a false alarm.
    if (!isDefault && !isFallback) {
      signIns.push({
        provider: target,
        status: stored
          ? `${label} (unused — ${resolved ? resolved.provider : 'nothing'} serves your runs)`
          : 'not signed in',
      });
      continue;
    }

    const envVar = isDefault ? usedKeyEnvVar : defaultApiKeyEnvName(target);
    const viaEnv = isDefault
      ? usedKeyEnvVar !== undefined
      : fallback?.apiKey !== undefined && fallback.apiKey === readNonEmptyString(processEnv[String(envVar)]);
    const where = isDefault ? 'runs are' : 'fallback runs are';

    if (stored && viaEnv) {
      signIns.push({ provider: target, status: `${label}, overridden by ${envVar} in your environment` });
      // The costly case: an env key silently demotes a subscription to
      // per-token billing, and nothing in a normal run says so.
      problems.push(stored.type === 'oauth_token'
        ? `${envVar} in your environment outranks your saved ${target} subscription sign-in, so ${where} billed per token instead of through your plan. Unset it (check your shell profile) to use the subscription.`
        : `${envVar} in your environment outranks your saved ${target} sign-in. Unset it to use the one \`stratus setup\` stored.`);
      continue;
    }
    if (viaEnv) {
      signIns.push({ provider: target, status: `using ${envVar} from your environment` });
      continue;
    }
    if (stored) {
      signIns.push({ provider: target, status: isDefault && usesAuthToken ? `${label} — runs go through the Claude Code runtime` : label });
      continue;
    }
    signIns.push({ provider: target, status: 'not signed in' });
  }

  // A fallback the resolver dropped is the quiet failure: the config still
  // names one, but a failing primary has nothing to retry on.
  if (fileConfig.fallbackModel !== undefined && resolved && resolved.provider !== 'demo' && !fallback) {
    problems.push(
      `A fallback model (${fileConfig.fallbackModel}) is configured but could not be resolved — usually no sign-in for its provider, or an endpoint its saved key is not sent to. `
      + 'A failing primary model has nothing to retry on.',
    );
  }

  const channels = await loadChannelCredentials(env);
  const slackAgents = Object.keys(channels.slack ?? {}).sort();
  const slackPackageInstalled = (await loadSlackAdapter()) !== undefined;
  if (slackAgents.length > 0 && !slackPackageInstalled) {
    problems.push(
      `Slack tokens are stored for ${slackAgents.length} agent(s) but @stratusagent/channel-slack is not installed, so \`stratus serve\` skips them. `
      + 'Install it with: npm install -g @stratusagent/channel-slack',
    );
  }

  let rosterCount = 0;
  try {
    rosterCount = (await readdir(agentsDirPath(env))).filter((file) => file.endsWith('.md')).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  // Tokens keyed to an agent the roster no longer has are loaded and
  // skipped on every start, silently.
  let rosterEntries: RosterEntry[] = [];
  let rosterLoaded = true;
  try {
    rosterEntries = await loadRosterSouls(env, warn);
  } catch (error) {
    // Doctor exists to name problems, so a roster it cannot load is a
    // finding to report — not an exception that replaces the report.
    rosterLoaded = false;
    problems.push(error instanceof Error ? error.message : String(error));
  }
  const rosterIds = new Set(rosterEntries.map((entry) => entry.soul.agent.id));
  rosterIds.add(DEFAULT_STRATUS_AGENT.id);
  if (soul) {
    rosterIds.add(soul.agent.id);
  }
  // Only against a roster that actually loaded. "No agent has this id" is
  // a claim about the roster, and a refused one cannot support it — every
  // stored token would be reported as orphaned, and this advises clearing
  // them. Advice is not deletion, but an operator who follows it loses the
  // same credentials by hand.
  const orphans = rosterLoaded ? slackAgents.filter((id) => !rosterIds.has(id)) : [];
  if (orphans.length > 0) {
    problems.push(
      `Slack tokens are stored for ${orphans.join(', ')}, which no agent matches — \`stratus serve\` skips them. `
      + 'Clear them from `stratus setup` → Channels.',
    );
  }

  // The invisible failure doctor exists to surface: the service unit embeds
  // absolute node and entrypoint paths, and upgrading node (an nvm version
  // directory, say) leaves the unit pointing at an interpreter that no
  // longer exists. The service stops working and nothing else says so.
  const unitCommand = await readServiceCommand(serviceEnvFor(env));
  if (unitCommand?.execPath !== undefined && !(await pathExists(unitCommand.execPath))) {
    problems.push(
      `The service unit points at a node interpreter that no longer exists (${unitCommand.execPath}), so stratusd cannot start. `
      + 'Run `stratus update` (or `stratus service install`) to rewrite it with current paths.',
    );
  }
  if (unitCommand?.scriptPath !== undefined && !(await pathExists(unitCommand.scriptPath))) {
    problems.push(
      `The service unit points at a CLI entrypoint that no longer exists (${unitCommand.scriptPath}), so stratusd cannot start. `
      + 'Run `stratus update` (or `stratus service install`) to rewrite it with current paths.',
    );
  }

  return {
    ...(winner ? { configInUse: winner.path } : {}),
    configShadowed: shadowed.map((entry) => entry.path),
    provider,
    ...(model ? { model } : {}),
    ...(soulPath ? { soul: { value: soulPath, source: soulSource } } : {}),
    ...(soul ? { agent: `${soul.agent.name} (${soul.agent.id})` } : {}),
    ...(fallback ? { fallback: { provider: fallback.provider, model: fallback.model } } : {}),
    signIns,
    slackAgents,
    slackPackageInstalled,
    rosterCount,
    problems,
  };
};

export const runDoctor = async (
  command: ParsedDoctorCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  const report = await collectDoctorReport(command, (message) => {
    writeLine(streams.stderr, `Warning: ${message}.`);
  }, env);

  if (command.format === 'json') {
    writeLine(streams.stdout, JSON.stringify(report, null, 2));
    return report.problems.length > 0 ? 1 : 0;
  }

  const field = (label: string, setting?: DoctorSetting): void => {
    if (!setting) {
      return;
    }
    writeLine(streams.stdout, `  ${label.padEnd(10)}${setting.value}`);
    writeLine(streams.stdout, `  ${''.padEnd(10)}from ${setting.source}`);
  };

  writeLine(streams.stdout, 'Stratus Agent — what a run would use right now');
  writeLine(streams.stdout);
  field('provider', report.provider);
  field('model', report.model);
  field('soul', report.soul);
  if (report.agent) {
    writeLine(streams.stdout, `  ${'agent'.padEnd(10)}${report.agent}`);
  } else if (report.soul) {
    // A soul is configured but did not load — saying "built-in" here would
    // describe a run that cannot happen.
    writeLine(streams.stdout, `  ${'agent'.padEnd(10)}unresolved — the configured soul could not be read`);
  } else {
    writeLine(streams.stdout, `  ${'agent'.padEnd(10)}${DEFAULT_STRATUS_AGENT.name} (built-in — no soul configured)`);
  }

  writeLine(streams.stdout);
  writeLine(streams.stdout, 'Files');
  writeLine(streams.stdout, `  config    ${report.configInUse ?? 'none found — built-in defaults apply'}`);
  for (const shadowedPath of report.configShadowed) {
    writeLine(streams.stdout, `            (${shadowedPath} exists but is outranked)`);
  }
  writeLine(streams.stdout, `  agents    ${report.rosterCount} soul file${report.rosterCount === 1 ? '' : 's'}`);

  if (report.fallback) {
    writeLine(streams.stdout, `  ${'fallback'.padEnd(10)}${report.fallback.provider} · ${report.fallback.model}`);
    writeLine(streams.stdout, `  ${''.padEnd(10)}used when the default model errors mid-run`);
  }

  writeLine(streams.stdout);
  writeLine(streams.stdout, 'Sign-ins');
  for (const entry of report.signIns) {
    writeLine(streams.stdout, `  ${entry.provider.padEnd(10)}${entry.status}`);
  }

  writeLine(streams.stdout);
  writeLine(streams.stdout, 'Channels');
  writeLine(streams.stdout, `  slack     ${report.slackAgents.length === 0
    ? 'no agents connected'
    : `${report.slackAgents.length} connected (${report.slackAgents.join(', ')})`}`);
  writeLine(streams.stdout, `            @stratusagent/channel-slack ${report.slackPackageInstalled ? 'installed' : 'not installed'}`);

  writeLine(streams.stdout);
  if (report.problems.length === 0) {
    writeLine(streams.stdout, 'No problems found.');
    return 0;
  }
  writeLine(streams.stdout, `${report.problems.length} problem${report.problems.length === 1 ? '' : 's'} found:`);
  for (const problem of report.problems) {
    writeLine(streams.stdout, `  ! ${problem}`);
  }
  return 1;
};

/**
 * `stratus logs` — the daemon's structured log, filtered. `serve` streams
 * to its own stdout, which is gone the moment it runs under a service
 * manager; this reads the file it also writes, from any terminal.
 */
export const runLogs = async (
  command: ParsedLogsCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  const dir = logsDirPath(env);
  const filter = {
    ...(command.agentId ? { agentId: command.agentId } : {}),
    ...(command.sessionId ? { sessionId: command.sessionId } : {}),
  };
  const emit = (record: LogRecord): void => {
    writeLine(streams.stdout, command.format === 'json' ? JSON.stringify(record) : formatLogRecord(record));
  };

  // Captured BEFORE the backlog is read: the daemon keeps writing while a
  // large backlog prints, and a follower that takes its offset afterwards
  // skips everything written in between — permanently.
  const followFrom = command.follow ? await currentLogPosition(dir) : undefined;
  // Bounded by the same offset the follower resumes from: without it, a
  // record written between the two reads is printed by the backlog and
  // then again by the stream.
  const recent = await readRecentRecords(dir, command.limit, filter, followFrom);
  for (const record of recent) {
    emit(record);
  }

  if (!command.follow) {
    if (recent.length === 0 && command.format === 'text') {
      writeLine(streams.stdout, `No log records yet in ${dir}. Start the daemon with \`stratus serve\`.`);
    }
    return 0;
  }

  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  env.shutdownSignal?.addEventListener('abort', stop, { once: true });
  if (env.shutdownSignal?.aborted) {
    stop();
  }
  try {
    await tailLog({
      dir,
      filter,
      ...(followFrom !== undefined ? { startPosition: followFrom } : {}),
      signal: controller.signal,
      onRecord: emit,
    });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
  return 0;
};

/** Builds the service view of the CLI environment (home, exec paths, runner). */
const serviceEnvFor = (env: CliEnvironment): ServiceEnvironment => ({
  ...(env.homeDir !== undefined ? { homeDir: env.homeDir } : {}),
  cwd: readWorkingDirectory(env),
  ...(env.serviceRunner !== undefined ? { run: env.serviceRunner } : {}),
  ...(env.servicePlatform !== undefined ? { platform: env.servicePlatform } : {}),
});

/**
 * A credential that exists only in this shell cannot reach the daemon: a
 * service manager starts with its own environment and never sources a
 * profile, so the unit would come up unauthenticated while setup had just
 * reported everything ready. Returns the variable to name, if so.
 */
/**
 * The daemon's `approvals` block, from the config file the daemon itself
 * would load. Discovery goes through the shared resolver rather than
 * reading ~/.stratus/config.json directly: `--config` and STRATUS_CONFIG
 * both move it, and a second copy of that precedence would resolve the
 * approver set from a file the gateway is not running on.
 *
 * **Only from a trusted location.** An auto-discovered project-local
 * `stratus.config.json` outranks the global one and can be checked into any
 * repository — which is why stored credentials are already never combined
 * with an endpoint it selects. This block is the same kind of boundary and
 * a sharper one: it names the people who may authorize an agent's gated
 * tool calls, and it would do so through Slack tokens the user configured
 * globally. A cloned repo must not be able to appoint its own approver, so
 * an untrusted config's approvals are ignored — loudly, since silently
 * dropping the block someone is looking at is its own kind of wrong.
 *
 * An unreadable config degrades to headless with a warning, matching how
 * every other consumer treats one: refusing to start would take the whole
 * fleet down over a policy block that may not even be present.
 */
const loadServeApprovals = async (
  env: CliEnvironment,
  configPath: string | undefined,
  warn: (line: string) => void,
): Promise<ApprovalsConfig> => {
  const block = await readTrustedConfigBlock('approvals', env, configPath);
  if (block.status === 'untrusted') {
    warn(
      `ignoring the approvals config in ${block.path}: a project-local config cannot decide who may approve `
      + 'this daemon\'s tool calls. Move it to ~/.stratus/config.json, or pass it with --config.',
    );
    return {};
  }
  if (block.status === 'unreadable') {
    warn(`ignoring the approvals config (${block.error instanceof Error ? block.error.message : String(block.error)}); refusing gated calls`);
    return {};
  }
  return block.status === 'present' ? block.value : {};
};

/**
 * One line naming who can actually answer, so a remote daemon does not look
 * configured when it is not. Two ways it can be hollow, and they fail
 * differently, so they read differently:
 *
 * - No channel running at all (no Slack tokens, or the optional package is
 *   not installed) — nothing renders the request, so the turn waits out the
 *   whole timeout before being denied. That is the bad one, and the only
 *   place it is visible is here, at startup.
 * - A channel is running but an agent has no approvers — the adapter denies
 *   that agent's requests on arrival, which is at least prompt.
 *
 * `agentIds` is therefore the agents that can actually be *asked*, not
 * every agent with tokens on disk.
 */
const describeApprovers = (approvals: ApprovalsConfig, agentIds: string[]): string => {
  if (agentIds.length === 0) {
    return 'but no channel is running to ask through, so gated calls will wait out the approval timeout and then be denied';
  }
  const covered = agentIds.filter((agentId) => (resolveAgentApprovals(approvals, agentId).slackApprovers ?? []).length > 0);
  if (covered.length === 0) {
    return 'but no approvers are configured, so every gated call is denied on arrival';
  }
  const uncovered = agentIds.filter((agentId) => !covered.includes(agentId));
  return uncovered.length === 0
    ? `approvers set for ${covered.join(', ')}`
    : `approvers set for ${covered.join(', ')}; none for ${uncovered.join(', ')}, whose calls are denied on arrival`;
};

/**
 * `stratus service` — run the daemon under launchd or systemd, so it
 * survives logout, crashes, and reboots. `serve` itself stays a plain
 * foreground process; this only tells the platform how to keep it up.
 */
export const runService = async (
  command: ParsedServiceCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  const serviceEnv = serviceEnvFor(env);

  if (command.action === 'status') {
    const status = await readServiceStatus(serviceEnv);
    if (!status) {
      writeLine(streams.stdout, `No service manager for ${process.platform}. Run \`stratus serve\` yourself.`);
      return 1;
    }
    writeLine(streams.stdout, `stratusd  ${status.running === undefined
      ? 'state unknown — the service manager did not answer'
      : status.running ? 'running' : status.installed ? 'installed, not running' : 'not installed'}`);
    writeLine(streams.stdout, `  manager   ${status.platform}`);
    writeLine(streams.stdout, `  unit      ${status.unitPath}`);
    if (status.detail) {
      writeLine(streams.stdout, `  note      ${status.detail}`);
    }
    if (status.installed) {
      writeLine(streams.stdout, `  at login  ${status.runAtLogin === undefined
        ? 'unknown — the service manager did not answer'
        : status.runAtLogin ? 'yes' : 'no'}`);
    }
    writeLine(streams.stdout, status.installed
      ? '  logs      stratus logs -f'
      : '  install   stratus service install');
    return status.running === true ? 0 : 1;
  }

  // A service manager passes none of this shell's environment on, so a
  // config selected by STRATUS_CONFIG has to be baked into the unit
  // exactly as --config is. Without it the daemon rediscovers from the
  // install directory and can come up on a different roster entirely.
  const processEnv = readProcessEnv(env);
  const selectedConfig = command.configPath
    ?? readNonEmptyString(processEnv.STRATUS_CONFIG);
  if (command.action === 'install') {
    // A config the daemon cannot parse kills it during gateway.start(),
    // and the manager — having accepted the start — restarts it on a
    // loop. Better to refuse now, while there is someone reading stderr.
    // Without an explicit selection the unit carries no --config flag and
    // discovers from its working directory — the same directory this is
    // running in — so the discovered file has to be validated too, not
    // just an explicitly named one.
    let configToCheck: string | undefined;
    if (selectedConfig) {
      configToCheck = path.resolve(readWorkingDirectory(env), String(selectedConfig));
    } else {
      try {
        configToCheck = (await resolveConfigLocation({}, env))?.path;
      } catch (error) {
        // Discovery throws when a candidate exists but cannot be read.
        // Treating that as "no config" would install a daemon that hits
        // the same error on its first dispatch.
        writeLine(streams.stderr, `Not installing: ${error instanceof Error ? error.message : String(error)}`);
        writeLine(streams.stderr, 'The daemon would fail the same way on startup. Fix the file, or move it aside.');
        return 1;
      }
    }
    if (configToCheck) {
      try {
        await loadConfigFile(configToCheck);
      } catch (error) {
        writeLine(streams.stderr, `Not installing: ${configToCheck} cannot be used (${error instanceof Error ? error.message : String(error)}).`);
        writeLine(streams.stderr, 'The daemon would exit on startup and be restarted in a loop. Fix the file, or move it aside.');
        return 1;
      }
    }
  }

  const action = command.action === 'install'
    ? installService(serviceEnv, {
        ...(command.runAtLogin === false ? { runAtLogin: false } : {}),
        // Absolute: resolved against the directory the install ran in.
        ...(selectedConfig ? { configPath: path.resolve(readWorkingDirectory(env), String(selectedConfig)) } : {}),
      })
    : command.action === 'uninstall'
      ? uninstallService(serviceEnv)
      : command.action === 'start'
        ? startService(serviceEnv)
        : stopService(serviceEnv);

  const result = await action;
  for (const message of result.messages) {
    writeLine(result.ok ? streams.stdout : streams.stderr, message);
  }
  return result.ok ? 0 : 1;
};

const CLI_PACKAGE_NAME = '@stratusagent/cli';

const pathExists = async (candidate: string): Promise<boolean> => {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
};

/**
 * `stratus update` — the whole upgrade dance, in the order that cannot lose
 * data: stop the service (so no daemon holds the session database while
 * state migrates), upgrade the package, run pending migrations, rewrite the
 * service unit with current paths, restart.
 *
 * The unit rewrite is the step that repairs the failure nothing else
 * surfaces: the unit embeds absolute node and entrypoint paths (a service
 * manager loads no shell profile, so it must), and upgrading node — under
 * nvm, a whole new version directory — leaves the unit pointing at an
 * interpreter that no longer exists. The service stops working and nothing
 * says so; the agents just stop answering.
 *
 * Each step degrades independently: an unreachable npm skips the version
 * check and package upgrade but still migrates and rewrites the unit —
 * which is exactly the repair the offline case needs.
 */
const runUpdate = async (
  command: ParsedUpdateCommand,
  streams: CliStreams,
  env: CliEnvironment,
): Promise<number> => {
  const serviceEnv = serviceEnvFor(env);
  const out = (line: string): void => writeLine(streams.stdout, line);

  const latest = await (env.packageVersionFetcher ?? defaultPackageVersionFetcher)(CLI_PACKAGE_NAME);
  const upgradeAvailable = latest !== undefined && compareVersions(latest, CLI_VERSION) > 0;

  // A stamp from a newer build makes every later step wrong, not just the
  // migration one: this build would migrate — and stop the daemon to do it —
  // against a format it does not understand. Checked here, before anything
  // has a side effect.
  const stamp = await readStateStamp(env);
  const stateNewer = stamp.schemaVersion > STATE_SCHEMA_VERSION;

  const status = await readServiceStatus(serviceEnv).catch(() => undefined);
  const unit = status?.installed ? await readServiceCommand(serviceEnv) : undefined;
  const unitNotes: string[] = [];
  if (status?.installed && unit?.execPath !== undefined) {
    if (!(await pathExists(unit.execPath))) {
      unitNotes.push(`the unit's interpreter no longer exists: ${unit.execPath} — stratusd cannot start until the unit is rewritten`);
    } else if (unit.execPath !== process.execPath) {
      unitNotes.push(`the unit runs ${unit.execPath}; this shell runs ${process.execPath}`);
    }
    if (unit.scriptPath !== undefined && !(await pathExists(unit.scriptPath))) {
      unitNotes.push(`the unit's entrypoint no longer exists: ${unit.scriptPath}`);
    } else if (unit.scriptPath !== undefined && process.argv[1] !== undefined && unit.scriptPath !== process.argv[1]) {
      // A versioned package directory can keep the old file alive after an
      // upgrade — the daemon then runs the old CLI indefinitely with
      // nothing missing on disk to notice.
      unitNotes.push(`the unit runs entrypoint ${unit.scriptPath}; this shell runs ${process.argv[1]}`);
    }
  }

  const pending = await pendingStateMigrations(env);

  out(`stratus ${CLI_VERSION}`);
  out(latest === undefined
    ? '  latest      unknown — npm did not answer'
    : `  latest      ${latest}${upgradeAvailable ? ' — update available' : ' — up to date'}`);
  out(`  state       schema ${stamp.schemaVersion}${stateNewer
    ? ` — written by a NEWER build than this one (which understands ${STATE_SCHEMA_VERSION})`
    : `, ${pending.length === 0 ? 'no pending migrations' : `${pending.length} pending migration${pending.length === 1 ? '' : 's'}`}`}`);
  out(`  service     ${status === undefined
    ? `no service manager for ${process.platform}`
    : status.installed
      ? (status.running === undefined ? 'installed, state unknown' : status.running ? 'installed, running' : 'installed, not running')
      : 'not installed'}`);
  for (const note of unitNotes) {
    out(`  unit        ${note}`);
  }

  if (command.check) {
    for (const migration of pending) {
      out(`  pending     ${migration.id} — ${migration.description}`);
    }
    if (stateNewer) {
      out('This build cannot update that state — upgrade the package itself (`npm install -g @stratusagent/cli`).');
      return 1;
    }
    const actionable = upgradeAvailable || pending.length > 0 || unitNotes.length > 0;
    out(actionable
      ? 'Run `stratus update` to apply the above.'
      : 'Nothing to do.');
    // Actionable exits 1, so a cron job or script can notice.
    return actionable ? 1 : 0;
  }

  if (stateNewer) {
    writeLine(streams.stderr, newerStateMessage(stamp.schemaVersion));
    return 1;
  }

  if (status?.installed && (status.runAtLogin === undefined || status.running === undefined)) {
    // The rewrite has to re-state the login setting and restore the prior
    // run state, and the manager could not say what either currently is.
    // Guessing would let a transient status failure convert a deliberate
    // --no-login install, or rewrite-and-stop a daemon that was actually
    // running — refuse instead, before anything has been stopped.
    writeLine(streams.stderr, `Not updating: whether stratusd ${status.running === undefined ? 'is running' : 'starts at login'} could not be determined (the service manager did not answer), and the unit rewrite would have to guess. Check \`stratus service status\` and retry.`);
    return 1;
  }

  const wasRunning = status?.running === true;
  if (wasRunning) {
    // No daemon may hold the session database while state migrates — this
    // bracket is the one place an update could otherwise lose data.
    out('Stopping stratusd for the update…');
    const stopped = await stopService(serviceEnv);
    for (const message of stopped.messages) {
      writeLine(stopped.ok ? streams.stdout : streams.stderr, message);
    }
    if (!stopped.ok) {
      writeLine(streams.stderr, 'Not updating while the daemon may still be running.');
      return 1;
    }
  }

  let upgradeFailed = false;
  if (upgradeAvailable) {
    out(`Upgrading ${CLI_PACKAGE_NAME} ${CLI_VERSION} → ${latest}…`);
    const installed = await (env.packageInstaller ?? defaultPackageInstaller)([`${CLI_PACKAGE_NAME}@latest`]);
    if (installed.ok) {
      // This process is still the old build; migrations the new version
      // adds run when it first starts — which the restart below is.
      out('Upgraded. Migrations the new version adds run on its first start.');
    } else {
      upgradeFailed = true;
      writeLine(streams.stderr, `npm install failed: ${installed.message || 'unknown error'} — continuing with migrations and the unit rewrite.`);
    }
  } else {
    out(latest === undefined
      ? 'Skipping the package upgrade — npm did not answer.'
      : 'Package already up to date.');
  }

  let applied: AppliedStateMigration[];
  try {
    applied = await runStateMigrations(env);
  } catch (error) {
    // A daemon stopped for an update that then failed must not stay down:
    // the old unit is still in place (the rewrite has not happened), so
    // restarting restores the world the update found. The failure is still
    // a failure — but an offline fleet on top of it is not.
    writeLine(streams.stderr, `State migration failed: ${error instanceof Error ? error.message : String(error)}`);
    if (wasRunning) {
      const restarted = await startService(serviceEnv);
      for (const message of restarted.messages) {
        writeLine(restarted.ok ? streams.stdout : streams.stderr, message);
      }
      writeLine(streams.stderr, restarted.ok
        ? 'stratusd was restarted on its previous unit. Fix the migration failure and run `stratus update` again.'
        : 'stratusd could not be restarted either — bring it back with `stratus service start` once the failure is fixed.');
    }
    return 1;
  }
  if (applied.length === 0) {
    out('No pending state migrations.');
  }
  for (const migration of applied) {
    out(`Migrated: ${migration.description}${migration.detail !== undefined ? ` — ${migration.detail}` : ''}`);
  }

  if (status?.installed) {
    out('Rewriting the service unit with current node and entrypoint paths…');
    // The rewrite overwrites the unit before it bootstraps, so a failure
    // in between must be able to put the old definition back — otherwise
    // a stopped daemon is left with neither unit to start from.
    const previousUnit = await readFile(serviceUnitPath(serviceEnv), 'utf8').catch(() => undefined);
    const install = await installService(
      // The unit's own working directory survives the rewrite: relative
      // paths in the pinned config (a `soul`) resolve against it, so a
      // rewrite run from some other directory must not substitute its own.
      unit?.workingDirectory !== undefined ? { ...serviceEnv, cwd: unit.workingDirectory } : serviceEnv,
      {
        ...(status.runAtLogin === false ? { runAtLogin: false } : {}),
        // The config the existing unit was pinned to survives the rewrite —
        // a unit rewritten onto a different roster is its own outage.
        ...(unit?.configPath !== undefined ? { configPath: unit.configPath } : {}),
      },
    );
    for (const message of install.messages) {
      writeLine(install.ok ? streams.stdout : streams.stderr, message);
    }
    if (!install.ok) {
      if (wasRunning) {
        // The fleet was up when the update began and must not stay down
        // over a failed rewrite: restore the previous unit definition and
        // start it again. The exit code stays 1 — the update failed — but
        // the world it found is put back.
        if (previousUnit !== undefined) {
          await writeFile(serviceUnitPath(serviceEnv), previousUnit, { mode: 0o644 }).catch((error: unknown) => {
            writeLine(streams.stderr, `Could not restore the previous unit either: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
        const restarted = await startService(serviceEnv);
        for (const message of restarted.messages) {
          writeLine(restarted.ok ? streams.stdout : streams.stderr, message);
        }
        writeLine(streams.stderr, restarted.ok
          ? 'The unit rewrite failed, so stratusd was restarted on its previous unit. Fix the failure above and run `stratus update` again.'
          : 'The unit rewrite failed AND stratusd could not be restarted — bring it back with `stratus service start`, or `stratus service install` to rewrite the unit by hand.');
      }
      return 1;
    }
    if (!wasRunning) {
      // installService starts the daemon; a service that was deliberately
      // stopped before the update stays that way.
      const stopped = await stopService(serviceEnv);
      if (!stopped.ok) {
        // The update itself succeeded, but the user's prior state was not
        // restored: an intentionally stopped daemon is now running. That
        // is a failure a script must see, not a footnote.
        writeLine(streams.stderr, 'stratusd was not running before the update, and stopping it again failed — it is now RUNNING. Stop it with `stratus service stop`.');
        return 1;
      }
      out('stratusd was not running before the update, so it was left stopped.');
    }
  } else if (status !== undefined) {
    out('No service installed — nothing to rewrite. `stratus service install` sets one up.');
  }

  return upgradeFailed ? 1 : 0;
};

/**
 * What a `skill add` source string means, in order: a directory on this
 * machine, a GitHub `owner/repo` shorthand, or a URL git can clone. The
 * shorthand is the form skills.sh and its CLI print, so a skill published
 * there installs by the name its listing shows.
 */
const resolveSkillSource = async (
  source: string,
  env: CliEnvironment,
): Promise<{ kind: 'local'; directory: string } | { kind: 'git'; url: string }> => {
  const localPath = path.resolve(readWorkingDirectory(env), source);
  try {
    if ((await stat(localPath)).isDirectory()) {
      // The real directory, not the path as typed: a source that is
      // itself a symlink would otherwise be copied as that link — an
      // installed entry pointing back at the source tree, which the
      // loader ignores as not-a-directory.
      return { kind: 'local', directory: await realpath(localPath) };
    }
  } catch {
    // Not a local directory; read it as a remote source.
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(source)) {
    return { kind: 'git', url: `https://github.com/${source}` };
  }
  if (/^(https?|git|ssh|file):\/\//.test(source) || /^git@[\w.-]+:/.test(source)) {
    return { kind: 'git', url: source };
  }
  throw new Error(
    `Cannot read ${JSON.stringify(source)} as a skill source. Pass a GitHub owner/repo, a git URL, or a local path.`,
  );
};

/**
 * A source URL safe to print: userinfo stripped. A token travels in exactly
 * this position (`https://user:token@host/repo.git`), stdout is commonly
 * retained in CI logs, and git's own stderr already redacts — only the
 * unredacted URL is handed to git itself.
 */
const redactedSourceUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = '***';
      parsed.password = '';
    }
    return parsed.toString();
  } catch {
    // scp-style (git@host:path) or anything else URL() refuses: keep the
    // shape, hide whatever sits before the @.
    return url.replace(/^[^@/]+@/, '***@');
  }
};

/** Shallow-clone a skills source. Git owns every transport we would otherwise re-implement. */
const cloneSkillSource = async (url: string, destination: string): Promise<void> => {
  const display = redactedSourceUrl(url);
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', ['clone', '--depth', '1', '--quiet', url, destination], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      reject(new Error(`Could not run git to fetch ${display}: ${error.message}`));
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        // git redacts credentials in its own messages; the URL we echo is
        // ours to redact.
        reject(new Error(`git clone failed for ${display}: ${stderr.trim() || `exit code ${code}`}`));
      }
    });
  });
};

/**
 * The souls skill enablement is judged against: the agents directory plus
 * the configured default soul (config `soul:` / STRATUS_SOUL), which may
 * live outside it and is served all the same. The daemon's roster and
 * `stratus agents` both include it, so `skill add --agent` and `stratus
 * skills` must not answer from a narrower set.
 */
const rosterSoulsWithConfigured = async (
  env: CliEnvironment,
  warn: (line: string) => void,
): Promise<{ entries: Awaited<ReturnType<typeof loadRosterSouls>>; complete: boolean }> => {
  const entries = await loadRosterSouls(env, warn);
  let complete = true;
  try {
    const configured = await resolveConfiguredSoul({}, env);
    if (configured) {
      const entry = { soul: configured.soul, path: configured.path };
      const clash = entries.findIndex((candidate) => candidate.soul.agent.id === configured.soul.agent.id);
      // Replaced, not skipped: a roster file claiming the configured
      // soul's id is the one the gateway stops serving — both commands
      // must answer for the soul a dispatch actually runs.
      if (clash >= 0) {
        entries[clash] = entry;
      } else {
        entries.push(entry);
      }
    }
  } catch (error) {
    // The configured agent's allowlist was not read, so the set is not
    // the roster — callers making enablement claims must withhold them.
    complete = false;
    warn(`could not read the configured soul: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { entries, complete };
};

export const runSkillAdd = async (
  command: ParsedSkillAddCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  const resolved = await resolveSkillSource(command.source, env);
  let sourceDir: string;
  let cleanup: (() => Promise<void>) | undefined;
  if (resolved.kind === 'local') {
    sourceDir = resolved.directory;
  } else {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'stratus-skill-add-'));
    cleanup = () => rm(scratch, { recursive: true, force: true });
    writeLine(streams.stdout, `Fetching ${redactedSourceUrl(resolved.url)} …`);
    try {
      await cloneSkillSource(resolved.url, scratch);
    } catch (error) {
      await cleanup();
      throw error;
    }
    sourceDir = scratch;
  }

  try {
    // For a cloned source the temp directory's random basename must not
    // name a root-level skill — the repository's own name is what a
    // nameless root SKILL.md installs under.
    const rootId = resolved.kind === 'git'
      ? path.basename(new URL(resolved.url.replace(/^git@([^:]+):/, 'ssh://git@$1/')).pathname, '.git')
      : undefined;
    const result = await installSkillsFromDirectory(env, sourceDir, {
      ...(command.skillIds ? { only: command.skillIds } : {}),
      ...(command.force ? { force: true } : {}),
      ...(rootId !== undefined && rootId.length > 0 ? { rootId } : {}),
    });

    for (const skill of result.installed) {
      writeLine(streams.stdout, `installed ${skill.id} — ${skill.description}`);
      // The spec's compatibility field is written for exactly this reader:
      // the person deciding whether this environment can carry the skill.
      if (skill.compatibility !== undefined) {
        writeLine(streams.stdout, `  compatibility: ${skill.compatibility}`);
      }
    }
    // What installed with a caveat — a field another host owns, the
    // legacy key form, a bundled scripts/ — is said next to the install,
    // per skill: the operator deciding to enable it is the one who needs
    // to hear it, and this is the moment they are looking.
    for (const warning of result.warnings) {
      writeLine(streams.stderr, `Warning: ${warning.id}: ${warning.message}`);
    }
    // Present already is a no-op, not a failure — and exactly what the
    // "rerun with --agent" hint below produces, so these stay eligible
    // for the enablement step.
    for (const skill of result.alreadyInstalled) {
      writeLine(streams.stdout, `already installed ${skill.id} — ${skill.description}`);
    }
    for (const skip of result.skipped) {
      writeLine(streams.stderr, `Warning: skipped ${skip.id}: ${skip.reason}`);
    }
    if (result.installed.length === 0 && result.alreadyInstalled.length === 0) {
      writeLine(streams.stderr, result.skipped.length > 0
        ? 'Error: nothing was installed.'
        : `Error: no skills found in ${command.source}. A skill is a directory with a SKILL.md.`);
      return 1;
    }

    // The ordinary path needs no second step: a daemon that is running
    // serves what was just installed from its next turn. Only when
    // something changed on disk — a re-run that installed nothing has
    // nothing to reload — and only where a daemon has said it is running.
    if (result.installed.length > 0 && command.reload !== false) {
      await reloadRunningDaemonSkills(streams, env);
    }

    // Installed is not enabled: a soul opts in through its skills:
    // allowlist, and that stays true when the install came through a
    // command. --agent is the explicit way to say both at once.
    const ids = [...result.installed, ...result.alreadyInstalled].map((skill) => skill.id);
    if (command.agentId === undefined) {
      writeLine(streams.stdout);
      writeLine(streams.stdout, 'Installed, not yet enabled. Add to an agent\'s soul frontmatter:');
      writeLine(streams.stdout, '  skills:');
      for (const id of ids) {
        writeLine(streams.stdout, `    - ${id}`);
      }
      writeLine(streams.stdout, `(or rerun with --agent <id>, or list them: stratus skills)`);
      return 0;
    }

    const { entries: roster } = await rosterSoulsWithConfigured(env, (line) => writeLine(streams.stderr, `Warning: ${line}`));
    const entry = roster.find((candidate) => candidate.soul.agent.id === command.agentId);
    if (!entry) {
      writeLine(streams.stderr, `Error: no agent with id ${command.agentId} in ${agentsDirPath(env)} or the configured soul. The skills are installed; enable them by editing a soul.`);
      return 1;
    }
    const existing = entry.soul.agent.skills ?? [];
    const additions = ids.filter((id) => !matchesSkillAllowlist(id, existing));
    if (additions.length === 0) {
      writeLine(streams.stdout, `${entry.soul.agent.name} already has all of these enabled.`);
      return 0;
    }
    // A field edit renders through formatSoul, which canonicalizes the
    // file — same trade the control API's field edits make.
    const next: ParsedSoul = {
      ...entry.soul,
      agent: { ...entry.soul.agent, skills: [...existing, ...additions] },
    };
    await writeFile(entry.path, formatSoul(next));
    writeLine(streams.stdout, `enabled for ${next.agent.name} (${entry.path}): ${additions.join(', ')}`);
    return 0;
  } finally {
    await cleanup?.();
  }
};

/**
 * List and cancel what the fleet has scheduled — against the daemon's own
 * database, the way `stratus logs` reads the daemon's own log. WAL makes a
 * second process on the file routine; a running daemon re-reads due rows
 * every tick and the destination grant on every send, so a cancel from
 * here takes effect without asking it anything.
 */
export const runSchedules = async (
  command: ParsedSchedulesCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  // Lazy like the serve path: node:sqlite loads only for the command that
  // needs it.
  const { SqliteScheduleStore, defaultSessionDbPath } = await import('@stratusagent/gateway');
  const store = new SqliteScheduleStore(defaultSessionDbPath(env));
  try {
    if (command.action === 'cancel') {
      const id = command.scheduleId ?? '';
      const record = store.get(id);
      if (!record || !store.delete(id)) {
        writeLine(streams.stderr, `No schedule with id ${id}. \`stratus schedules\` lists what exists.`);
        return 1;
      }
      writeLine(streams.stdout, `Cancelled ${id} (${record.agentId}, ${describeCadence(record.cadence)}).`);
      if (record.destination) {
        writeLine(streams.stdout, `Its pre-authorized destination ${canonicalDestination(record.destination)} is revoked with it.`);
      }
      return 0;
    }

    const schedules = store.list();
    if (command.format === 'json') {
      writeLine(streams.stdout, JSON.stringify({ schedules: schedules.map(describeSchedule) }, null, 2));
      return 0;
    }
    if (schedules.length === 0) {
      writeLine(streams.stdout, 'No schedules set. An agent sets one with the schedule.every / schedule.at tools.');
      return 0;
    }
    for (const record of schedules) {
      const destination = record.destination ? `  →  ${canonicalDestination(record.destination)}` : '';
      writeLine(streams.stdout, `${record.id}  [${record.agentId}]  ${describeCadence(record.cadence)}${destination}`);
      writeLine(streams.stdout, `  next: ${record.nextFireAt ?? '(spent — awaiting cleanup)'}${record.lastFiredAt ? `   last: ${record.lastFiredAt}` : ''}`);
      writeLine(streams.stdout, `  prompt: ${record.prompt}`);
    }
    return 0;
  } finally {
    store.close();
  }
};

/**
 * `stratus credential set|list|remove`: the place a named credential goes.
 *
 * A credential nobody can add is a credential nobody has, which is why this
 * exists at all — a search backend asks for `search.apiKey` and until now
 * there was nowhere to put one. Three rules it keeps, all of them
 * deliberate:
 *
 * The value is read from **stdin, never from a flag**. A secret in argv is
 * a secret in shell history and in every `ps` on the machine.
 *
 * Nothing here ever prints a value back. `list` reports names and which
 * agents have their own, the same posture the control API's credential read
 * already keeps.
 *
 * And storing one grants no agent anything: the agent's soul still has to
 * list the name under `credentials:`, which is the per-identity gate.
 */
export const runCredential = async (
  command: ParsedCredentialCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  const named = await loadNamedCredentials(env);

  if (command.action === 'list') {
    const shared = Object.keys(named.shared).sort();
    const agents = Object.entries(named.agents).sort(([a], [b]) => a.localeCompare(b));
    if (shared.length === 0 && agents.length === 0) {
      writeLine(streams.stdout, `No named credentials stored in ${credentialsPath(env)}.`);
      writeLine(streams.stdout, 'A search backend wants `stratus credential set search.apiKey`.');
      return 0;
    }
    if (shared.length > 0) {
      writeLine(streams.stdout, 'Shared with the whole fleet:');
      for (const name of shared) {
        writeLine(streams.stdout, `  ${name}`);
      }
    }
    for (const [agentId, entries] of agents) {
      writeLine(streams.stdout, `Only ${agentId}:`);
      for (const name of Object.keys(entries).sort()) {
        writeLine(streams.stdout, `  ${name}`);
      }
    }
    // Names, never values — and say so, so nobody goes looking for a flag
    // that prints one.
    writeLine(streams.stdout, '');
    writeLine(streams.stdout, `Values are never printed. They live in ${credentialsPath(env)}, readable only by you.`);
    return 0;
  }

  const name = command.name ?? '';

  if (command.action === 'remove') {
    const scope = command.agentId;
    const store = scope === undefined ? named.shared : named.agents[scope];
    if (!store || store[name] === undefined) {
      writeLine(
        streams.stderr,
        scope === undefined
          ? `No shared credential named ${name}. \`stratus credentials\` lists what is stored.`
          : `Agent ${scope} has no credential of its own named ${name}. \`stratus credentials\` lists what is stored.`,
      );
      return 1;
    }
    delete store[name];
    if (scope !== undefined && Object.keys(store).length === 0) {
      delete named.agents[scope];
    }
    await saveNamedCredentials(env, named);
    writeLine(streams.stdout, scope === undefined ? `Removed ${name}.` : `Removed ${name} for ${scope}.`);
    return 0;
  }

  writeLine(
    streams.stderr,
    `Reading the value for ${name} from stdin — it is never taken from the command line, where it would land in your shell history. Ctrl-D when done.`,
  );
  const value = (env.stdin ?? await readPromptFromStdin(env.stdinStream ?? process.stdin)).trim();
  if (value.length === 0) {
    writeLine(streams.stderr, `Nothing arrived on stdin, so ${name} was not stored. Pipe the value in: \`printf %s "$KEY" | stratus credential set ${name}\`.`);
    return 1;
  }

  if (command.agentId === undefined) {
    named.shared[name] = value;
  } else {
    named.agents[command.agentId] = { ...(named.agents[command.agentId] ?? {}), [name]: value };
  }
  await saveNamedCredentials(env, named);
  writeLine(
    streams.stdout,
    command.agentId === undefined
      ? `Stored ${name} in ${credentialsPath(env)} (readable only by you).`
      : `Stored ${name} for ${command.agentId} in ${credentialsPath(env)} (readable only by you). It outranks the shared entry for that agent.`,
  );
  // Storing grants nothing: the soul is the second gate, and an operator
  // who stops here gets "not allowed to access credential" on every call.
  writeLine(streams.stdout, `Each agent that may use it still needs \`credentials: [${name}]\` in its soul.`);
  return 0;
};

/**
 * `stratus skill validate <target>`: the install-time check, run without
 * installing — for an author about to publish a skill, or an operator
 * asking why one was refused. A local path is a skill directory or a
 * directory of skills, discovered exactly as `skill add` would; a bare id
 * names an installed skill under `~/.stratus/skills/`. Exit 1 when
 * anything would be refused, so a publish step can gate on it.
 */
export const runSkillValidate = async (
  command: ParsedSkillValidateCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  let directory: string | undefined;
  let installed = false;
  const localPath = path.resolve(readWorkingDirectory(env), command.target);
  try {
    if ((await stat(localPath)).isDirectory()) {
      directory = localPath;
    }
  } catch {
    // Not a local directory; try it as an installed id.
  }
  // The loader's rule for the lookup, so a directory that loads with a
  // pre-spec id can be validated — and told what to rename.
  if (directory === undefined && isLoadableSkillId(command.target)) {
    const installedPath = path.join(skillsDirPath(env), command.target);
    try {
      if ((await stat(installedPath)).isDirectory()) {
        directory = installedPath;
        installed = true;
      }
    } catch {
      // Not installed either.
    }
  }
  if (directory === undefined) {
    writeLine(
      streams.stderr,
      `Error: ${JSON.stringify(command.target)} is neither a directory nor an installed skill id (stratus skills lists those).`,
    );
    return 1;
  }

  // An installed directory IS the layout the spec's directory rule is
  // about, so its name is checked; a path the author typed is a checkout
  // or a container, judged as `skill add` would judge it.
  const { candidates, skipped } = await discoverSkillsInDirectory(
    directory,
    installed ? { checkRootDirectoryName: true } : {},
  );
  if (candidates.length === 0 && skipped.length === 0) {
    writeLine(streams.stderr, `Error: no skills found in ${directory}. A skill is a directory with a SKILL.md.`);
    return 1;
  }
  for (const candidate of candidates) {
    const caveat = candidate.warnings.length > 0
      ? ` — ${candidate.warnings.length} warning${candidate.warnings.length === 1 ? '' : 's'}`
      : '';
    writeLine(streams.stdout, `${candidate.id}: ok${caveat}`);
    for (const warning of candidate.warnings) {
      writeLine(streams.stdout, `  warning: ${warning}`);
    }
  }
  for (const skip of skipped) {
    writeLine(streams.stdout, `${skip.id}: refused`);
    writeLine(streams.stdout, `  error: ${skip.reason}`);
  }
  if (skipped.length > 0) {
    const noun = skipped.length === 1 ? 'skill' : 'skills';
    writeLine(streams.stderr, `Error: ${skipped.length} ${noun} would be refused at install.`);
    return 1;
  }
  return 0;
};

/** Where a command aimed at "the running daemon" is pointed. */
interface RunningGatewayTarget {
  gateway?: string;
  token?: string;
}

/**
 * The control API base a command should talk to: `--gateway` when given,
 * else whatever daemon `~/.stratus/gateway.json` says is serving, else
 * nothing — the file is written when the API binds and removed when it
 * stops, so its absence means no daemon has said where it is.
 */
const runningGatewayBase = async (env: CliEnvironment, target: RunningGatewayTarget): Promise<string | undefined> => {
  if (target.gateway) {
    return target.gateway.replace(/\/+$/, '');
  }
  const info = await readGatewayInfo(env);
  return info?.url.replace(/\/+$/, '');
};

/** One authenticated call to a daemon's control API, with the network and auth failures said plainly. */
const callRunningGateway = async (
  env: CliEnvironment,
  target: RunningGatewayTarget,
  base: string,
  pathname: string,
  body?: Record<string, unknown>,
): Promise<Response> => {
  const token = await gatewayToken(env, target.token);
  const fetchImpl = env.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is unavailable, so this runtime cannot reach a daemon.');
  }
  let response: Response;
  try {
    response = await fetchImpl(`${base}${pathname}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    throw new Error(
      `Could not reach the gateway at ${base} (${error instanceof Error ? error.message : String(error)}). `
      + 'Is stratusd running, and does it have @stratusagent/control-api installed?',
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`The gateway at ${base} rejected this token. Check --token, STRATUS_GATEWAY_TOKEN, or ~/.stratus/gateway-token.`);
  }
  return response;
};

/** The API's own sentence for a failure, or the status when it sent none. */
const gatewayErrorMessage = async (response: Response): Promise<string> => {
  try {
    const payload = await response.json() as { error?: { message?: string } };
    if (payload.error?.message) {
      return payload.error.message;
    }
  } catch {
    // Not JSON; the status is all there is to say.
  }
  return `HTTP ${response.status}`;
};

const noRunningDaemonMessage = (env: CliEnvironment): string =>
  `no running daemon found — ${gatewayInfoPath(env)} does not exist, and no --gateway was given. `
  + 'Start one with `stratus serve` or `stratus service start`; a daemon loads ~/.stratus/skills at start.';

/**
 * After `skill add`: tell the daemon, if one says it is running. Silent
 * when none does — a `stratus run` user with no daemon should not read a
 * note about one — and a warning, never a failure, when the file names a
 * daemon that did not answer: the install itself succeeded.
 */
const reloadRunningDaemonSkills = async (streams: CliStreams, env: CliEnvironment): Promise<void> => {
  const info = await readGatewayInfo(env);
  if (!info) {
    return;
  }
  const base = info.url.replace(/\/+$/, '');
  try {
    const response = await callRunningGateway(env, {}, base, '/api/v1/skills/reload');
    if (!response.ok) {
      throw new Error(await gatewayErrorMessage(response));
    }
    writeLine(streams.stdout, `reloaded the running daemon's skills (${base}) — no restart needed`);
  } catch (error) {
    writeLine(
      streams.stderr,
      `Warning: ${gatewayInfoPath(env)} names a daemon at ${base}, but its skills were not reloaded: `
      + `${error instanceof Error ? error.message : String(error)} If it is running, reload it with: stratus skill reload`,
    );
  }
};

export const runSkillReload = async (
  command: ParsedSkillReloadCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  const base = await runningGatewayBase(env, command);
  if (!base) {
    writeLine(streams.stderr, `Error: ${noRunningDaemonMessage(env)}`);
    return 1;
  }
  const response = await callRunningGateway(env, command, base, '/api/v1/skills/reload');
  if (!response.ok) {
    writeLine(streams.stderr, `Error: ${await gatewayErrorMessage(response)}`);
    return 1;
  }
  const { skills } = await response.json() as { skills?: Array<{ id: string }> };
  const ids = (skills ?? []).map((skill) => skill.id);
  writeLine(streams.stdout, `reloaded skills in the daemon at ${base} — ${ids.length} skill(s) serving${ids.length > 0 ? `: ${ids.join(', ')}` : ''}`);
  return 0;
};

export const runRestart = async (
  command: ParsedRestartCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  const base = await runningGatewayBase(env, command);
  if (!base) {
    writeLine(streams.stderr, `Error: ${noRunningDaemonMessage(env)}`);
    return 1;
  }
  const response = await callRunningGateway(env, command, base, '/api/v1/restart', {
    reason: command.reason ?? 'stratus restart',
    ...(command.drainTimeoutMs !== undefined ? { drainTimeoutMs: command.drainTimeoutMs } : {}),
  });
  if (!response.ok) {
    writeLine(streams.stderr, `Error: ${await gatewayErrorMessage(response)}`);
    return 1;
  }
  const status = await response.json() as { inflight?: number; drainTimeoutMs?: number };
  const inflight = status.inflight ?? 0;
  const window = Math.round((status.drainTimeoutMs ?? 0) / 1000);
  writeLine(
    streams.stdout,
    `restart announced to the daemon at ${base} — new turns are refused; ${inflight} turn(s) in flight `
    + `get up to ${window}s to finish, then it comes back.`,
  );
  writeLine(streams.stdout, 'Watch it come back: stratus logs -f');
  return 0;
};

export const runSkills = async (
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  const registry = new SkillRegistry();
  const skills = await loadOperatorSkills(env, registry, (line) => {
    writeLine(streams.stderr, `Warning: ${line}`);
  });
  if (skills.length === 0) {
    writeLine(streams.stdout, `No skills installed in ${skillsDirPath(env)}.`);
    writeLine(streams.stdout, 'Install some: stratus skill add <owner/repo | git url | path>');
    return 0;
  }

  // Who has each skill enabled, so the listing answers the question that
  // follows "what is installed" — read from the same roster a dispatch
  // serves. Plugin-contributed skills are the daemon's to list
  // (/catalog/tools); this command reads the operator directory.
  //
  // A roster that will not load (a duplicate agent id, deliberately
  // fatal) is unreadable enablement, not empty enablement: say so and
  // withhold the claim rather than reporting every skill unused.
  let roster: Awaited<ReturnType<typeof loadRosterSouls>> = [];
  let rosterUnreadable = false;
  try {
    const resolved = await rosterSoulsWithConfigured(env, (line) => writeLine(streams.stderr, `Warning: ${line}`));
    roster = resolved.entries;
    rosterUnreadable = !resolved.complete;
  } catch (error) {
    rosterUnreadable = true;
    writeLine(
      streams.stderr,
      `Warning: cannot say who enables what — the roster did not load: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const skill of skills) {
    let suffix = '';
    if (!rosterUnreadable) {
      const enabledBy = roster
        .filter((entry) => {
          const allowlist = entry.soul.agent.skills;
          return allowlist !== undefined
            && allowlist.length > 0
            && matchesSkillAllowlist(skill.id, allowlist);
        })
        .map((entry) => entry.soul.agent.name);
      suffix = enabledBy.length > 0 ? ` — enabled by ${enabledBy.join(', ')}` : ' — enabled by nobody yet';
    }
    writeLine(streams.stdout, `${skill.id.padEnd(24)}${skill.description}${suffix}`);
  }
  return 0;
};

/**
 * The provider/model a newly created soul pins. Frontmatter pins what a run
 * from this directory would actually use: env vars outrank the active
 * config file (project-local or explicit first, global otherwise), and no
 * provider anywhere falls back to demo — the exact precedence of stratus
 * run. Demo produces no model at all: the soul keeps following the
 * machine's configuration instead of demanding credentials nothing has
 * signed in for. The active config's model was written for the provider
 * named in that config, so it only travels into the soul when they still
 * match; otherwise the selected provider's own default model stands in.
 *
 * Exported for tests: the interactive path that consumes it needs a TTY.
 */
export const soulPinForNewAgent = (
  activeConfig: StratusConfigFile,
  processEnv: NodeJS.ProcessEnv,
): { provider: StratusProviderName; model?: string } => {
  // The map already validates, so the value is a provider name; the cast
  // only undoes `readNonEmptyString`'s widening to `string`.
  const envProvider = readNonEmptyString(
    processEnv.STRATUS_PROVIDER,
    (value) => parseProviderName(value, 'STRATUS_PROVIDER'),
  ) as StratusProviderName | undefined;
  const provider = envProvider ?? activeConfig.provider ?? 'demo';
  if (provider === 'demo') {
    return { provider };
  }
  const configModelApplies = (activeConfig.provider ?? 'openai') === provider;
  const model = readNonEmptyString(processEnv.STRATUS_MODEL)
    ?? (configModelApplies ? activeConfig.model : undefined)
    ?? (provider === 'openai'
      ? DEFAULT_OPENAI_MODEL
      : provider === 'codex'
        ? DEFAULT_CODEX_MODEL
        : DEFAULT_ANTHROPIC_MODEL);
  return { provider, model };
};

export const runAgentNew = async (
  command: ParsedAgentNewCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  // On a real terminal, creating an agent is the same guided experience as
  // setup: a headed screen, a prefilled (editable) name, a personality, and
  // an offer to make them the default. Scripted formats and piped input
  // keep the plain one-shot output.
  const interactive = env.setupInput === undefined
    && process.stdin.isTTY === true
    && command.format === 'text';

  if (interactive) {
    const prompter = createSetupPrompter(streams, env, {
      header: stratusHeaderLines,
      consumeNotices: () => [],
    });
    try {
      streams.stdout.write('\u001b[2J\u001b[H');
      for (const line of stratusHeaderLines()) {
        writeLine(streams.stdout, line);
      }
      writeLine(streams.stdout);

      const suggested = command.name ?? generateAgentName();
      const name = (await prompter.ask('Choose your name: ', { prefill: suggested })) || suggested;
      const instructions = await prompter.ask(
        'Describe their personality (Enter for a starter you can edit later): ',
        ...(command.instructions ? [{ prefill: command.instructions }] : []),
      );

      const persona = instructions || DEFAULT_SOUL_STARTER;

      const processEnv = readProcessEnv(env);
      // Creating an agent must not be blocked by a broken config — it only
      // feeds the soul's provider/model hint, so fall back to defaults.
      const { location: configLocation, config: activeConfig } = await discoverActiveConfig(env, (message) => {
        writeLine(streams.stdout, `Note: ${message}.`);
      });
      const { provider: soulProvider, model: soulModel } = soulPinForNewAgent(activeConfig, processEnv);
      const soulPin = soulProvider !== 'demo' && soulModel !== undefined
        ? { provider: soulProvider, model: soulModel }
        : {};

      const claimed = await claimSoulFile(
        env,
        { name, instructions: persona },
        (candidate) => formatSoul({ agent: candidate, ...soulPin }),
        (message) => writeLine(streams.stdout, message),
      );
      const { agent, soulPath } = claimed;

      const makeDefault = await prompter.select(`Make ${agent.name} your default agent?`, [
        'Yes — every stratus run talks to them',
        'Not now',
      ]);
      let madeDefault = false;
      if (makeDefault.kind === 'index' && makeDefault.index === 0) {
        // The default agent is a machine-wide setting, so it lands in the
        // global config even when a project config is active here.
        let globalConfig: CliConfigFile | undefined;
        try {
          globalConfig = await loadConfigFile(globalConfigPath(env));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            globalConfig = {};
          } else {
            // A malformed config is recoverable by hand — never overwrite it.
            writeLine(streams.stdout, `Could not read ${globalConfigPath(env)} (${error instanceof Error ? error.message : String(error)}), so it was left untouched. Fix it, then make ${agent.name} the default from stratus setup.`);
          }
        }
        if (globalConfig !== undefined) {
          // Re-validated rather than cast: `readNonEmptyString` widens to
          // `string`, and the shared parser is what says which strings are
          // provider names. Every source feeding soulProvider is already one,
          // so this narrows without being able to throw.
          const config: CliConfigFile = {
            ...globalConfig,
            provider: globalConfig.provider ?? parseProviderName(soulProvider, 'provider'),
            soul: soulPath,
          };
          await saveConfigFile(globalConfigPath(env), config);
          madeDefault = true;
          if (configLocation && configLocation.path !== globalConfigPath(env)) {
            writeLine(streams.stdout, `Note: ${configLocation.path} takes precedence over the global config for runs started in this directory.`);
          }
        }
      }

      writeLine(streams.stdout);
      writeLine(streams.stdout, `Say hello to ${agent.name}.`);
      writeLine(streams.stdout, `Their soul lives at ${soulPath} — edit it any time to change how they talk.`);
      writeLine(streams.stdout);
      writeLine(streams.stdout, 'Try:');
      writeLine(streams.stdout, madeDefault
        ? '  stratus run "introduce yourself"'
        : `  stratus run --soul ${quoteShellArg(soulPath)} "introduce yourself"`);
      return 0;
    } finally {
      prompter.close();
    }
  }

  const agent = defineAgent({
    ...(command.name ? { name: command.name } : {}),
    ...(command.instructions ? { instructions: command.instructions } : {}),
  });

  if (command.format === 'json') {
    writeLine(streams.stdout, JSON.stringify(agent, null, 2));
    return 0;
  }

  if (command.format === 'soul') {
    streams.stdout.write(
      formatSoul({ agent, provider: 'anthropic', model: DEFAULT_ANTHROPIC_MODEL }),
    );
    return 0;
  }

  writeLine(streams.stdout, `Say hello to ${agent.name}.`);
  writeLine(streams.stdout);
  writeLine(streams.stdout, `  id      ${agent.id}`);
  writeLine(streams.stdout, `  avatar  ${agent.avatar?.style} theme, hue ${agent.avatar?.hue}, palette ${agent.avatar?.palette.join(' ')}`);
  if (agent.instructions) {
    writeLine(streams.stdout, `  soul    ${agent.instructions}`);
  }
  writeLine(streams.stdout);
  writeLine(streams.stdout, 'Save this as a soul file and run it:');
  writeLine(streams.stdout, `  stratus agent new --name ${quoteShellArg(agent.name)}${command.instructions ? ` --instructions ${quoteShellArg(command.instructions)}` : ''} --format soul > my-agent.md`);
  writeLine(streams.stdout, '  stratus run --soul my-agent.md "hello"');
  writeLine(streams.stdout);
  writeLine(streams.stdout, 'Definition (JSON):');
  writeLine(streams.stdout, JSON.stringify(agent, null, 2));
  return 0;
};

/** What a running daemon published about itself, if one is running. */
interface GatewayInfo {
  url: string;
  pid?: number;
}

const readGatewayInfo = async (env: CliEnvironment): Promise<GatewayInfo | undefined> => {
  try {
    const parsed = JSON.parse(await readFile(gatewayInfoPath(env), 'utf8')) as Partial<GatewayInfo>;
    return typeof parsed.url === 'string' ? { url: parsed.url, ...(parsed.pid ? { pid: parsed.pid } : {}) } : undefined;
  } catch {
    // No file, or one left behind by a daemon that died without cleaning up.
    // Either way there is nothing to talk to until the health check says so.
    return undefined;
  }
};

/**
 * A one-time URL for the browser.
 *
 * This is the whole reason the exchange exists: the CLI can read the token
 * file and a page cannot, so the CLI lends its authority for exactly one
 * short-lived trip.
 */
const mintDashboardUrl = async (
  env: CliEnvironment,
  base: string,
  fetchImpl: typeof fetch,
): Promise<string> => {
  const token = await gatewayToken(env, undefined);
  const response = await fetchImpl(`${base}/api/v1/auth/ott`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`The gateway at ${base} refused to open a dashboard session (HTTP ${response.status}).`);
  }
  const payload = await response.json() as { url?: string; path?: string };
  // The relative form joined to the base we already reached, in preference to
  // the absolute one: this command knows exactly which address answered, and
  // the daemon can only infer it from headers.
  if (payload.path) {
    return `${base.replace(/\/+$/, '')}${payload.path}`;
  }
  if (!payload.url) {
    throw new Error(`The gateway at ${base} did not return a dashboard URL.`);
  }
  return payload.url;
};

/** Whether something is actually answering there, as opposed to a stale file. */
const gatewayAnswering = async (
  env: CliEnvironment,
  base: string,
  fetchImpl: typeof fetch,
): Promise<boolean> => {
  try {
    const token = await gatewayToken(env, undefined);
    const response = await fetchImpl(`${base}/api/v1/health`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return response.ok;
  } catch {
    return false;
  }
};

/**
 * Whether a process with this pid exists. EPERM is an answer — the process
 * is there, it is just not ours to signal.
 */
const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * The error for a home another daemon holds (see `claimHome` in
 * @stratusagent/gateway — the claim is what decides; this only says who).
 *
 * The discovery file names the holder when it has one to name: a daemon
 * that has bound its API. Read for the message alone, and only trusted as
 * far as a live pid — a daemon still starting has not written it, a
 * daemon draining its last turn has already removed it, and a SIGKILLed
 * one leaves it behind for the next pid to inherit. Not probed over HTTP:
 * a `STRATUS_GATEWAY_TOKEN` exported for some remote gateway would answer
 * 401 for the local one, and the claim needs no second opinion.
 */
/**
 * `stratus serve` refused because another daemon holds the home. Its own
 * type so `stratus dashboard` can tell "a daemon is there, wait for it to
 * publish" from "the daemon could not start".
 */
class HomeHeldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HomeHeldError';
  }
}

/**
 * Whether a daemon from before the lock existed is serving this home.
 *
 * Such a daemon — alive across an upgrade that did not stop it — never
 * took the claim, so the claim alone cannot see it. The discovery file it
 * published is its only trace, held to the two proofs the lock made
 * unnecessary for everything since: the pid it names is alive, and its
 * URL answers `/health` with this home's own token file — never the
 * `STRATUS_GATEWAY_TOKEN` override, which names some other gateway and
 * would make a live daemon read as absent. A stale file fails either
 * proof and refuses nothing.
 */
const legacyDaemonServing = async (env: CliEnvironment): Promise<boolean> => {
  const info = await readGatewayInfo(env);
  if (info?.pid === undefined || info.pid === process.pid || !processAlive(info.pid)) {
    return false;
  }
  const fetchImpl = env.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return false;
  }
  try {
    const token = (await readFile(gatewayTokenPath(env), 'utf8')).trim();
    const response = await fetchImpl(`${info.url}/api/v1/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
};

const describeHeldHome = async (env: CliEnvironment): Promise<string> => {
  const info = await readGatewayInfo(env);
  const holder = info?.pid !== undefined && processAlive(info.pid)
    ? ` (pid ${info.pid}, ${info.url})`
    : ' — one that is still starting, or still draining its last turns';
  return `stratusd is already running for this home${holder}. Two daemons on one ~/.stratus `
    + 'would each fire the other\'s schedules and re-ask its approvals. Stop it first: `stratus service stop` '
    + 'if it is the installed service, otherwise Ctrl+C where it runs — and let it finish; it holds the home until '
    + 'its last turn is written.';
};

/**
 * `stratus dashboard` — open the web UI against a running daemon, starting
 * one in the foreground when there is none.
 *
 * The daemon is started by calling `runServe`, not by rebuilding its wiring:
 * channels, approvals, the credential preflight, and the log writer are all
 * decisions `serve` already makes, and a second copy of them here would drift
 * the first time either side gained a rule.
 */
export const runDashboard = async (
  command: ParsedDashboardCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  const fetchImpl = env.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    writeLine(streams.stderr, 'Error: fetch is unavailable, so the dashboard cannot reach a gateway.');
    return 1;
  }

  const existing = await readGatewayInfo(env);
  let base = existing && await gatewayAnswering(env, existing.url, fetchImpl) ? existing.url : undefined;

  const ownDaemon = new AbortController();
  let serving: Promise<number> | undefined;

  if (!base) {
    writeLine(streams.stdout, 'No daemon is running — starting one. It stops when you do.');
    writeLine(streams.stdout, 'Run `stratus service install` to keep one running instead.');

    // One attempt at a daemon of our own. `runServe` can reject before it
    // publishes anything — an unreadable roster, a session store that will
    // not open — and a rejected promise nobody is watching for fifteen
    // seconds is an unhandled rejection, which terminates the process
    // instead of reaching the message below. Captured rather than
    // swallowed, so the reason the daemon gave is the reason this command
    // reports.
    let daemonFailure: unknown;
    let daemonSettled = false;
    let daemonExit: Promise<void> = Promise.resolve();
    let attemptedAt = 0;
    const attempt = (): void => {
      daemonFailure = undefined;
      daemonSettled = false;
      attemptedAt = Date.now();
      serving = runServe(
        {
          command: 'serve',
          events: false,
          // Explicitly on. A trusted config may set `api.enabled: false` —
          // a reasonable thing for a headless box — but this command exists
          // to open the dashboard, and honouring it here would start a
          // daemon with no API and then time out waiting for the one it
          // promised.
          api: true,
          ...(command.port !== undefined ? { apiPort: command.port } : {}),
          // Passed whenever it was asked for, including when it is the
          // default. `--host 127.0.0.1` against a config saying `0.0.0.0`
          // is an operator narrowing the bind, and dropping it because it
          // matched the default did the reverse of what they typed.
          ...(command.host !== undefined ? { apiHost: command.host } : {}),
        },
        // The daemon's own chatter belongs on stderr here: stdout is where
        // this command says where to point a browser, and interleaving the
        // two makes the one line that matters hard to find.
        { stdout: streams.stderr, stderr: streams.stderr },
        { ...env, shutdownSignal: ownDaemon.signal },
      );
      daemonExit = serving.then(
        () => { daemonSettled = true; },
        (error: unknown) => { daemonFailure = error; daemonSettled = true; },
      );
    };
    attempt();

    // Gated on a daemon actually answering, not on a delay: one publishes
    // where it bound the moment it binds, and anything less would be a race
    // dressed up as a timeout. It also stops the moment our daemon gives up
    // — except when it gave up because another one holds the home. An
    // installed service still starting has not published its address yet
    // and is about to: that is the daemon to wait for. And a daemon still
    // draining may simply exit, with nothing replacing it — so while the
    // home is held, our own attempt is repeated about once a second, and
    // takes the home the moment it is free.
    const startedBy = Date.now() + 15_000;
    while (!base && Date.now() < startedBy) {
      const info = await readGatewayInfo(env);
      if (info && await gatewayAnswering(env, info.url, fetchImpl)) {
        base = info.url;
        break;
      }
      if (daemonSettled) {
        if (!(daemonFailure instanceof HomeHeldError)) {
          break;
        }
        if (Date.now() - attemptedAt >= 1_000) {
          attempt();
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (!base) {
      ownDaemon.abort();
      await daemonExit;
      writeLine(
        streams.stderr,
        daemonFailure instanceof HomeHeldError
          ? 'Error: another daemon holds this home but never published its address. It may still be starting or '
            + 'draining — try again in a moment, or check `stratus service status`.'
          : daemonFailure
            ? `Error: the daemon could not start: ${daemonFailure instanceof Error ? daemonFailure.message : String(daemonFailure)}`
            : 'Error: the daemon did not start serving its control API. Is @stratusagent/control-api installed?',
      );
      return 1;
    }
    if (daemonFailure instanceof HomeHeldError) {
      // The daemon that answered is the one that held the home. Ours never
      // started, so there is nothing of ours to wait for or to stop: from
      // here this is the found-a-running-daemon case.
      serving = undefined;
    }
  }

  let url: string;
  try {
    url = await mintDashboardUrl(env, base, fetchImpl);
  } catch (error) {
    ownDaemon.abort();
    await serving?.catch(() => 0);
    writeLine(streams.stderr, `Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  writeLine(streams.stdout, `${DASHBOARD_TITLE} ready at ${base}`);
  writeLine(streams.stdout, 'That link signs one browser in and can only be used once.');

  if (command.openBrowser) {
    try {
      await (env.openExternal ?? openExternalUrl)(url);
      writeLine(streams.stdout, 'Opened your default browser.');
    } catch (error) {
      writeLine(streams.stderr, `Warning: Could not open the browser automatically: ${error instanceof Error ? error.message : String(error)}`);
      writeLine(streams.stdout, `Open this yourself: ${url}`);
    }
  } else {
    writeLine(streams.stdout, `Open this to sign in: ${url}`);
  }

  if (!serving) {
    // Someone else owns the daemon; this command's job is done.
    return 0;
  }

  writeLine(streams.stdout, 'Press Ctrl+C to stop the daemon.');
  if (env.dashboardAutoShutdownMs !== undefined) {
    await new Promise((resolve) => setTimeout(resolve, env.dashboardAutoShutdownMs));
    ownDaemon.abort();
  }
  // An attempt still in flight when the daemon answered may yet be refused
  // — the holder published while ours was claiming. The dashboard found a
  // daemon; that refusal is not its failure.
  return serving.catch((error: unknown) => {
    if (error instanceof HomeHeldError) {
      return 0;
    }
    throw error;
  });
};

/** Reports whether an optional package is installed. */
export type PackageResolver = (specifier: string) => boolean;

/**
 * Resolution and loading are separate questions, and only the first one
 * means "not installed". Inspecting an import's error message cannot tell
 * them apart: a package that IS installed but is missing one of its own
 * dependencies throws ERR_MODULE_NOT_FOUND naming that dependency and the
 * importer — so a broken install would read as an absent one, silently
 * disabling a channel whose stored tokens say it should be running, or
 * leaving a daemon without the API an operator installed it to have.
 */
const defaultPackageResolver: PackageResolver = (specifier) => {
  try {
    import.meta.resolve(specifier);
    return true;
  } catch {
    return false;
  }
};

/**
 * Whether an optional package is installed. The resolver is injectable
 * because what is installed is a property of the machine: a test asserting
 * on the real one would be asserting on its own node_modules, which is why
 * every optional package is a devDependency here in the first place.
 */
const packageInstalled = (specifier: string, env: CliEnvironment = {}): boolean =>
  (env.packageResolver ?? defaultPackageResolver)(specifier);

type SlackAdapterFactory = typeof import('@stratusagent/channel-slack').createSlackChannelAdapter;

/**
 * Loads the optional Slack channel package, or undefined when it is not
 * installed. Only that package being absent is tolerated: an adapter that
 * fails to load for any other reason (a broken install, a bad transitive
 * dependency) surfaces rather than silently disabling Slack for a daemon
 * whose stored tokens say it should be running.
 */
const loadSlackAdapter = async (): Promise<SlackAdapterFactory | undefined> => {
  if (!packageInstalled('@stratusagent/channel-slack')) {
    return undefined;
  }
  // Resolvable: any failure from here is a real problem with the
  // installed package, and surfaces.
  return (await import('@stratusagent/channel-slack')).createSlackChannelAdapter;
};

type ControlApiFactory = typeof import('@stratusagent/control-api').createControlApi;
type GatewayFactory = typeof import('@stratusagent/gateway').createGateway;

/**
 * Loads the optional control-API package, or undefined when it is not
 * installed. Same two-step as the Slack adapter, and for the same reason:
 * only the package being absent means "not installed". A package that IS
 * installed but is missing one of its own dependencies throws
 * ERR_MODULE_NOT_FOUND naming that dependency, so inspecting the message
 * would read a broken install as an absent one — silently leaving a daemon
 * without the API an operator installed it to have.
 */
const loadControlApi = async (): Promise<ControlApiFactory | undefined> => {
  if (!packageInstalled('@stratusagent/control-api')) {
    return undefined;
  }
  return (await import('@stratusagent/control-api')).createControlApi;
};

/**
 * The daemon's `api` block, from the config file the daemon itself would
 * load — and only from a trusted location.
 *
 * An auto-discovered project-local `stratus.config.json` outranks the global
 * one and can be checked into any repository. Which interface a daemon binds
 * is exactly the kind of decision a cloned repo must not get to make, so an
 * untrusted config's block is ignored loudly rather than obeyed.
 */
const loadServeApi = async (
  env: CliEnvironment,
  configPath: string | undefined,
  warn: (line: string) => void,
): Promise<ApiConfig> => {
  const block = await readTrustedConfigBlock('api', env, configPath);
  if (block.status === 'untrusted') {
    warn(
      `ignoring the api config in ${block.path}: a project-local config cannot decide which interface this `
      + 'daemon binds. Move it to ~/.stratus/config.json, or pass it with --config.',
    );
    return {};
  }
  if (block.status === 'unreadable') {
    warn(`ignoring the api config (${block.error instanceof Error ? block.error.message : String(block.error)}); using the defaults`);
    return {};
  }
  return block.status === 'present' ? block.value : {};
};

/**
 * The daemon's `plugins` block — the same trust boundary as the two above,
 * and the one it was written for. A plugin runs in-process with the daemon,
 * so a list of them is a list of code; a `stratus.config.json` that ships
 * in a cloned repository must not be able to write it.
 */
const loadServePlugins = async (
  env: CliEnvironment,
  configPath: string | undefined,
  warn: (line: string) => void,
): Promise<PluginsConfig> => {
  const block = await readTrustedConfigBlock('plugins', env, configPath);
  if (block.status === 'untrusted') {
    warn(
      `ignoring the plugins config in ${block.path}: a project-local config cannot decide which code runs inside `
      + 'this daemon. Move it to ~/.stratus/config.json, or pass it with --config.',
    );
    return {};
  }
  if (block.status === 'unreadable') {
    warn(`ignoring the plugins config (${block.error instanceof Error ? block.error.message : String(block.error)}); loading no plugins`);
    return {};
  }
  return block.status === 'present' ? block.value : {};
};

/**
 * `stratus serve` — run the gateway (stratusd) in the foreground: load the
 * roster, accept dispatches, print events, and drain cleanly on SIGTERM,
 * SIGINT, or the injected shutdown signal.
 */
/**
 * What a daemon exits with to ask for a fresh process. Only ever seen by the
 * supervisor below, which is the only thing that starts a daemon with the
 * environment marker that makes it exit this way instead of supervising.
 */
export const RESTART_EXIT_CODE = 75;

/**
 * What a daemon exits with when a restart could not drain — a turn that
 * ignored its abort, a plugin or channel that did not let go. Distinct from
 * the restart status on purpose: the supervisor answers this one by
 * exiting with it too, so the process the service manager started ends
 * and the manager restarts the whole unit — under systemd, cleaning the
 * cgroup of whatever the plugin left running. A supervisor that started
 * another daemon instead would keep that cgroup, and its leaks, alive.
 */
export const UNDRAINED_RESTART_EXIT_CODE = 76;

/** Set in a daemon the supervisor started, so its own restart is an exit, not a second supervisor. */
const SUPERVISED_ENV = 'STRATUS_SERVE_SUPERVISED';

/**
 * The control API port the last daemon bound, handed to its replacement by
 * the supervisor. Honoured only where the replacement's own request — the
 * flag, else the config it reads afresh — is still for any free port: a
 * daemon that asked for port 0 comes back on the port it had, so a
 * dashboard page reconnects to it, while a config since edited to a fixed
 * port takes effect on that restart, as an `api` block change is meant to.
 * A hint, never a pin: passing the port back as `--api-port` would outrank
 * the config for every restart after.
 */
const BOUND_API_PORT_ENV = 'STRATUS_SERVE_BOUND_API_PORT';

const isDashboardSession = (value: unknown): value is DashboardSession =>
  typeof value === 'object' && value !== null
  && typeof (value as { id?: unknown }).id === 'string'
  && typeof (value as { expiresAt?: unknown }).expiresAt === 'number'
  && typeof (value as { vouchedBy?: unknown }).vouchedBy === 'string';

/** Shape-checked, because the other end of an IPC channel is still another process. */
const isSupervisorMessage = (value: unknown): value is SupervisorMessage => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const message = value as { type?: unknown; port?: unknown; sessions?: unknown };
  if (message.type === 'stratusd.bound-api-port') {
    return typeof message.port === 'number' && Number.isInteger(message.port) && message.port > 0;
  }
  if (message.type === 'stratusd.sessions') {
    return Array.isArray(message.sessions) && message.sessions.every(isDashboardSession);
  }
  return false;
};

/**
 * The IPC channel a supervisor opens when it spawns a daemon: what a
 * supervised daemon says up it (the port it bound, so the supervisor
 * carries *that* port to the next daemon rather than the first one's; the
 * dashboard sessions it hands on) and what comes down it. Where there is
 * no channel — the first daemon, or one a service manager started — there
 * is no one to say it to, and nothing is said.
 */
const defaultSupervisorLink: SupervisorLink = {
  send(message) {
    if (typeof process.send === 'function' && process.channel) {
      process.send(message);
    }
  },
  receive(handler) {
    const channel = process.channel;
    if (!channel) {
      return;
    }
    process.on('message', (message: unknown) => {
      if (isSupervisorMessage(message)) {
        handler(message);
      }
    });
    // A 'message' listener refs the channel, which would keep this process
    // alive after its drain; the daemon's own work is what holds it open.
    channel.unref?.();
  },
};

/**
 * The parsed serve command as arguments again — what the fresh daemon is
 * started with. From the command, not from `process.argv`: `stratus
 * dashboard` runs the daemon through `runServe` with a command it built,
 * and the process's own arguments would start a second dashboard.
 */
export const serveArgv = (command: ParsedServeCommand): string[] => [
  'serve',
  ...(command.configPath !== undefined ? ['--config', command.configPath] : []),
  ...(command.idleTimeoutMs !== undefined ? ['--idle-timeout', String(command.idleTimeoutMs / 1000)] : []),
  ...(command.approvals !== undefined ? ['--approvals', command.approvals] : []),
  ...(command.events ? [] : ['--no-events']),
  ...(command.logToFile === false ? ['--no-log-file'] : []),
  ...(command.api === false ? ['--no-api'] : command.api === true ? ['--api'] : []),
  ...(command.apiPort !== undefined ? ['--api-port', String(command.apiPort)] : []),
  ...(command.apiHost !== undefined ? ['--api-host', command.apiHost] : []),
];

/**
 * The `bin` beside the module at `moduleUrl`, with that module's own
 * extension: `dist/index.js` respawns `dist/bin.js`, and a source checkout
 * running `src/index.ts` under type stripping respawns `src/bin.ts` — the
 * flags that made that possible travel in `process.execArgv`. Assuming
 * compiled output would hand a source checkout a file that does not exist,
 * and a daemon that never comes back.
 */
export const restartEntrypoint = (moduleUrl: string): string => {
  const modulePath = fileURLToPath(moduleUrl);
  return path.join(path.dirname(modulePath), `bin${path.extname(modulePath)}`);
};

/**
 * Run this CLI's own entrypoint as a child with the daemon's streams and
 * exit code, forwarding the signals a supervisor would otherwise swallow.
 *
 * A child, and the parent waits, rather than a detached process and an
 * exit: under systemd and launchd the process the manager started is the
 * service, and its exit ends the job — cgroup and all, on Linux — so the
 * daemon that received the restart has to stay the manager's process and
 * become the supervisor of the next one. That is what makes the same path
 * hold in the foreground and under `--no-login`, where nothing else would
 * bring a clean exit back.
 */
const defaultServeRespawn = (env: CliEnvironment) => (argv: string[], handoff: RestartHandoff): Promise<RespawnResult> =>
  new Promise((resolve, reject) => {
    const entrypoint = restartEntrypoint(import.meta.url);
    // The daemon's own streams, plus an IPC channel for what it and its
    // supervisor have to tell each other. See SupervisorLink.
    const child = spawn(process.execPath, [...process.execArgv, entrypoint, ...argv], {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: {
        ...process.env,
        [SUPERVISED_ENV]: '1',
        ...(handoff.boundApiPort !== undefined ? { [BOUND_API_PORT_ENV]: String(handoff.boundApiPort) } : {}),
      },
    });
    if (handoff.sessions.length > 0 && child.connected) {
      // Queued in the channel until the daemon listens, which it does
      // before its API is up; the API holds them until it can adopt them.
      // A send that fails (the daemon died before reading) is not this
      // supervisor's failure: the exit below reports what happened, and a
      // daemon that never took them simply comes up signed out.
      const sessions: SupervisorMessage = { type: 'stratusd.sessions', sessions: handoff.sessions };
      child.send(sessions, () => undefined);
    }
    const forward = (signal: NodeJS.Signals) => (): void => {
      child.kill(signal);
    };
    const onTerm = forward('SIGTERM');
    const onInt = forward('SIGINT');
    const onAbort = (): void => {
      child.kill('SIGTERM');
    };
    process.on('SIGTERM', onTerm);
    process.on('SIGINT', onInt);
    env.shutdownSignal?.addEventListener('abort', onAbort, { once: true });
    const done = (): void => {
      process.off('SIGTERM', onTerm);
      process.off('SIGINT', onInt);
      env.shutdownSignal?.removeEventListener('abort', onAbort);
    };
    let reportedPort: number | undefined;
    let handedBack: DashboardSession[] | undefined;
    child.on('message', (message: unknown) => {
      if (!isSupervisorMessage(message)) {
        return;
      }
      if (message.type === 'stratusd.bound-api-port') {
        reportedPort = message.port;
      } else {
        handedBack = message.sessions;
      }
    });
    child.once('error', (error) => {
      done();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      done();
      // Killed by a signal is a stop, not a request to come back.
      resolve({
        code: code ?? (signal ? 1 : 0),
        ...(reportedPort !== undefined ? { boundApiPort: reportedPort } : {}),
        ...(handedBack !== undefined ? { sessions: handedBack } : {}),
      });
    });
  });

/**
 * Keep starting daemons for as long as they exit asking for another; the
 * first exit that does not is this process's own — an undrained restart's
 * status included, which ends the supervisor rather than starting a daemon
 * beside what the last one could not release.
 */
const superviseRestarts = async (
  command: ParsedServeCommand,
  first: RestartHandoff,
  streams: CliStreams,
  env: CliEnvironment,
): Promise<number> => {
  const respawn = env.serveRespawn ?? defaultServeRespawn(env);
  // The hand-off follows the daemons: the port each one said it bound is
  // what the next one is told (so a config edited to a fixed port and
  // back hands on the last address, not the first), and the sessions are
  // whatever the last one handed back — a daemon that handed nothing
  // hands nothing on.
  let handoff = first;
  let result: RespawnResult;
  do {
    writeLine(streams.stdout, 'Restarting stratusd.');
    result = await respawn(serveArgv(command), handoff);
    handoff = {
      ...(result.boundApiPort !== undefined || handoff.boundApiPort !== undefined
        ? { boundApiPort: result.boundApiPort ?? handoff.boundApiPort }
        : {}),
      sessions: result.sessions ?? [],
    };
  } while (result.code === RESTART_EXIT_CODE);
  return result.code;
};

export const runServe = async (
  command: ParsedServeCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  // First, before anything that can throw. A broken install makes the
  // gateway import below fail, the manager restarts, and the CLI's error
  // and help text append to the redirect file again — the crash loop this
  // bounding exists for. Running it after the import would skip exactly
  // that case.
  if (command.logToFile !== false) {
    await truncateRedirectLogs(logsDirPath(env)).catch(() => undefined);
  }

  // Loaded lazily: the gateway pulls in node:sqlite, which every other CLI
  // command neither needs nor should pay for (Node still prints an
  // experimental warning for it).
  const { createGateway, claimHome, HomeClaimedError } = await import('@stratusagent/gateway');

  // Before anything of this daemon's is written or opened: a second daemon
  // on this home is refused here, with no log line, no store, and no sweep
  // or firing of its own.
  let claim: HomeClaim;
  try {
    claim = claimHome(env);
  } catch (error) {
    if (error instanceof HomeClaimedError) {
      throw new HomeHeldError(await describeHeldHome(env));
    }
    throw error;
  }
  let outcome: ServeOutcome;
  try {
    // The one daemon the claim cannot see: one that predates it.
    if (await legacyDaemonServing(env)) {
      throw new HomeHeldError(await describeHeldHome(env));
    }
    outcome = await serveHeldHome(command, streams, env, createGateway);
  } finally {
    // After everything: the store closed by stop(), or whatever a throw
    // reached — a preflight that rejected before the gateway existed
    // included, so a host that calls runServe again is not refused for a
    // daemon that never started. And never sooner, so a replacement cannot
    // open the store while this one still writes.
    claim.release();
  }
  // An announced restart, once the home is let go — the replacement claims
  // it next. A daemon the supervisor started asks it for the next one by
  // exiting; the first daemon becomes the supervisor itself. Either way the
  // process the service manager (or the terminal) started is what stays.
  if (outcome.code === RESTART_EXIT_CODE && !readProcessEnv(env)[SUPERVISED_ENV]) {
    return superviseRestarts(
      command,
      { ...(outcome.boundApiPort !== undefined ? { boundApiPort: outcome.boundApiPort } : {}), sessions: outcome.sessions },
      streams,
      env,
    );
  }
  return outcome.code;
};

/** Everything `stratus serve` does once it holds the home. */
/** How a served daemon ended, and what a replacement should know. */
interface ServeOutcome {
  code: number;
  /** The control API port this daemon bound, if it served one. See BOUND_API_PORT_ENV. */
  boundApiPort?: number;
  /** The dashboard sessions live when it stopped, for the replacement. See RestartHandoff. */
  sessions: DashboardSession[];
}

const serveHeldHome = async (
  command: ParsedServeCommand,
  streams: CliStreams,
  env: CliEnvironment,
  createGateway: GatewayFactory,
): Promise<ServeOutcome> => {
  // Under a service manager the daemon's stdout is gone, so everything it
  // says is also written to ~/.stratus/logs — that file is what `stratus
  // logs` reads, and the only record of an overnight run.
  const logWriter: LogWriter | undefined = command.logToFile === false
    ? undefined
    : createLogWriter({
        dir: logsDirPath(env),
        onError: (error) => writeLine(
          streams.stderr,
          `Warning: could not write the log file (${error instanceof Error ? error.message : String(error)}); continuing.`,
        ),
      });
  const log = (line: string): void => {
    writeLine(streams.stdout, line);
    void logWriter?.write({ ts: new Date().toISOString(), level: 'info', msg: line });
  };
  const warn = (line: string): void => {
    writeLine(streams.stderr, `Warning: ${line}`);
    void logWriter?.write({ ts: new Date().toISOString(), level: 'warn', msg: line });
  };

  // Agents with stored Slack tokens go live in Slack automatically — the
  // tokens are gateway infrastructure secrets in the channels namespace of
  // ~/.stratus/credentials.json (see @stratusagent/channel-slack's README
  // for the 2-minute per-agent app setup).
  // The approval policy and the Slack approver sets come from the same
  // config block, resolved once here: the daemon must not answer "who can
  // approve this" differently from "is anyone being asked at all".
  const approvalsConfig = await loadServeApprovals(env, command.configPath, warn);
  const approvalMode = command.approvals ?? approvalsConfig.mode ?? 'headless';

  // Read here rather than inside the gateway for the same reason as the two
  // blocks above: the trust boundary is a property of *which file* said it,
  // and this is where the file precedence is already understood.
  const pluginsConfig = await loadServePlugins(env, command.configPath, warn);

  // The control API is a channel adapter like any other: started after the
  // roster loads, stopped before the store drains. It is optional because
  // installing it is how an operator says they want a port open.
  const apiConfig = await loadServeApi(env, command.configPath, warn);
  const apiWanted = command.api ?? apiConfig.enabled ?? true;
  // Typed as the seam, not as whatever the first push happens to be: the
  // list holds the control API and the Slack adapter alike.
  const controlApiChannels: GatewayChannelAdapter[] = [];
  /** The API adapter itself, for what the seam does not carry: its address, and the sessions it hands across a restart. */
  let boundApi: {
    readonly url: string | undefined;
    adoptSessions(sessions: DashboardSession[]): void;
    sessionsAtStop(): DashboardSession[];
  } | undefined;
  if (apiWanted) {
    const createControlApi = await loadControlApi();
    // Resolved into locals first. Inlined, `a ?? b !== undefined` parses as
    // `a ?? (b !== undefined)` — so an explicit `--api-port 0`, which is how
    // you ask for any free port, was falsy and fell through to the default.
    // Everything still bound and every test still passed, on whichever port
    // nobody happened to be using.
    const apiHost = command.apiHost ?? apiConfig.host;
    const requestedPort = command.apiPort ?? apiConfig.port;
    // The port the last daemon bound, from the supervisor that started
    // this one — taken only where this daemon's own request is still for
    // any free port. See BOUND_API_PORT_ENV.
    const hinted = Number(readProcessEnv(env)[BOUND_API_PORT_ENV]);
    const apiPort = requestedPort === 0 && Number.isInteger(hinted) && hinted > 0 ? hinted : requestedPort;
    if (createControlApi) {
      const api = createControlApi({
        env,
        ...(apiHost !== undefined ? { host: apiHost } : {}),
        ...(apiPort !== undefined ? { port: apiPort } : {}),
        ...(command.configPath ? { configPath: command.configPath } : {}),
        log,
        warn,
      });
      boundApi = api;
      controlApiChannels.push(api);
    } else if (command.api === true || apiConfig.enabled === true) {
      // Only when someone asked for it explicitly. A daemon that was never
      // told to serve an API should not complain about not having one.
      warn(
        'the control API was requested, but @stratusagent/control-api is not installed. '
        + 'Run `npm install -g @stratusagent/control-api` to bring it online; starting without it.',
      );
    }
  }

  // Listening before anything else is awaited: what the supervisor hands
  // this daemon is queued in the channel until then, and the API keeps it
  // until it is serving.
  const supervised = Boolean(readProcessEnv(env)[SUPERVISED_ENV]);
  const link = env.supervisorLink ?? defaultSupervisorLink;
  if (supervised) {
    link.receive((message) => {
      if (message.type === 'stratusd.sessions') {
        boundApi?.adoptSessions(message.sessions);
      }
    });
  }

  const channelCredentials = await loadChannelCredentials(env);
  const slackAgents = Object.entries(channelCredentials.slack ?? {});
  const channels = [...controlApiChannels];
  // Tracked on its own, never as `channels.length`: the list now holds the
  // control API too, and "can anyone be asked for an approval" is a question
  // about the Slack adapter specifically. Reading it off the list length
  // would tell a daemon with an API and no Slack app that every agent is
  // reachable, and its gated calls would park with nobody rendering them.
  let slackAdapterUp = false;
  if (slackAgents.length > 0) {
    // Channel packages are optional peers: the CLI never bundles a
    // transport nobody asked for (the Slack SDKs alone are ~9 MB). A
    // missing one degrades like a broken app does — the daemon serves
    // every other channel — with an actionable line instead of a
    // module-not-found stack.
    const adapter = await loadSlackAdapter();
    if (adapter) {
      slackAdapterUp = true;
      channels.push(adapter({
        agents: slackAgents.map(([agentId, tokens]) => {
          const route = resolveAgentApprovals(approvalsConfig, agentId);
          return {
            agentId,
            appToken: tokens.appToken,
            botToken: tokens.botToken,
            ...(route.slackApprovers ? { approvers: route.slackApprovers } : {}),
            ...(route.slackChannel ? { approvalChannel: route.slackChannel } : {}),
          };
        }),
        log,
        warn,
      }));
    } else {
      warn(
        `Slack tokens are stored for ${slackAgents.length} agent(s), but @stratusagent/channel-slack is not installed. `
        + 'Run `npm install -g @stratusagent/channel-slack` to bring them online; starting without the Slack channel.',
      );
    }
  }

  // A daemon is the costliest place for a silently demoted subscription:
  // every dispatch for as long as it runs, with nobody watching. The
  // gateway resolves each agent's soul independently on dispatch, so an
  // agent pinning anthropic can pick up an environment key even when the
  // daemon's own default is openai — checking only the default selection
  // would miss exactly the agent that is being billed. Each distinct
  // selection is resolved once here, and duplicate warnings are collapsed
  // so a ten-agent roster does not print ten identical lines.
  {
    const warned = new Set<string>();
    const collect = (line: string): void => {
      if (warned.has(line)) {
        return;
      }
      warned.add(line);
      // Through `warn`, not straight to stderr: under a service manager
      // stderr is gone, and a cost warning that only exists there is
      // invisible in exactly the deployment it matters for. `warn` adds
      // its own prefix, so the one already on the line comes off.
      warn(line.replace(/^Warning: /, ''));
    };
    const captured: CliStreams = {
      stdout: { write: () => true },
      stderr: { write: (chunk: string) => { collect(chunk.replace(/\n$/, '')); return true; } },
    };
    // A pinned soul does not merely add a provider — the gateway DEMOTES
    // the daemon-wide defaults it outranks, including STRATUS_PROVIDER, so
    // each served runtime is resolved the way a dispatch resolves it.
    for (const served of await servedRuntimes(env, command.configPath)) {
      await warnOnCredentialOverride(served.runtime, captured, served.env);
    }
  }

  // The daemon had no policy at all: createGateway falls back to
  // AllowAllApprovalPolicy, so every tool call from every agent
  // auto-approved, indefinitely, with nobody watching. That was survivable
  // while `serve` was something you ran in a terminal you were sitting at;
  // it is not, now that setup installs it under launchd by default.
  //
  // There is no terminal behind a service manager, so the choice is
  // between refusing every gated call (`headless`) and parking the turn to
  // ask through a channel (`remote`). Headless stays the default: a daemon
  // that starts waiting on people who were never told they are on the hook
  // hangs turns instead of refusing them. Every refusal is logged — an
  // unattended denial that appears nowhere reads like an agent that decided
  // not to bother.
  const onDecision = (decision: PermissionDecision): void => {
    if (decision.allowed) {
      return;
    }
    warn(`${decision.agentId}: ${decision.reason} (session ${decision.sessionId})`);
  };
  // A factory, not a policy: remote mode parks turns on a transport the
  // gateway owns, so the policy cannot exist until the gateway is building
  // it. Headless takes the same path so there is one construction site.
  // The command-scope engine, which only has a caller once a shell pack is
  // installed. Wired unconditionally because it costs nothing without one:
  // a tool that carries no command string is judged by its risk exactly as
  // before. The whitelist lives beside the agent's soul, per agent.
  const commands = {
    // A whitelist that exists and will not read is said here, once, and
    // never written over — the daemon's log is where a grant list going
    // quiet would otherwise go unnoticed.
    whitelist: createFileCommandWhitelist({ directory: agentsDirPath(env), warn }),
    onScopeRemembered: ({ agentId, scope }: { agentId: string; scope: CommandScope }) => {
      // An approval that widens what runs unattended, for every future
      // session, is precisely the decision that must not be the one leaving
      // no trace.
      log(`${agentId}: "${describeCommandScope(scope)}" now runs without asking`);
    },
  };
  const approvals = (transport: ApprovalTransport): ApprovalPolicy => createPermissionPolicy(
    // The destination scope rides along in BOTH modes — it is what lets a
    // scheduled turn report to the channel a human approved with the
    // schedule, and headless (where every other gated call is refused) is
    // exactly the deployment it exists for.
    approvalMode === 'remote'
      ? { mode: 'remote', request: transport.request, onDecision, commands, destinations: transport.destinations }
      : { mode: 'headless', onDecision, commands, destinations: transport.destinations },
  );

  if (approvalMode === 'remote') {
    // Only agents whose channel actually came up can be asked: tokens on
    // disk with the Slack package missing means nothing renders the
    // request, and the turn discovers that by hanging.
    const askable = slackAdapterUp ? slackAgents.map(([agentId]) => agentId) : [];
    log(`approvals: remote — gated calls are parked and asked in Slack (${describeApprovers(approvalsConfig, askable)})`);
  }

  /**
   * The one signal handler this daemon has, for the whole of its life —
   * installed by the wait below, removed in the finally after the drain.
   * See the wait for why it is never `once` and never removed sooner.
   */
  let stopSignal: (() => void) | undefined;
  let repeatWarned = false;

  // The gateway's restart hands the process back here once it has stopped:
  // the outcome is kept and the wait below released, and the tail of this
  // function decides what "come back" means for this process.
  let restart: RestartOutcome | undefined;
  /** A signal or the host's abort asked for a stop — set when the wait ends for that reason. */
  let stopRequested = false;
  let requestShutdown: () => void = () => {};
  const shutdownRequested = new Promise<void>((resolve) => {
    requestShutdown = resolve;
  });

  const gateway = createGateway({
    env,
    approvals,
    onRestart: (outcome) => {
      restart = outcome;
      requestShutdown();
    },
    ...(Object.keys(pluginsConfig).length > 0
      ? {
          plugins: pluginsConfig,
          // Resolved from *here*, not from inside the gateway.
          // `import.meta.resolve` answers relative to the module that calls
          // it, and a plugin is installed alongside the thing the operator
          // installed — this CLI. Letting the gateway resolve from its own
          // location works only where the layout happens to be flat.
          pluginHost: {
            resolve: (specifier: string) => import.meta.resolve(specifier),
            import: (specifier: string) => import(specifier),
          },
        }
      : {}),
    ...(approvalsConfig.timeoutMs !== undefined ? { approvalTimeoutMs: approvalsConfig.timeoutMs } : {}),
    ...(command.configPath ? { selection: { configPath: command.configPath } } : {}),
    ...(command.idleTimeoutMs !== undefined ? { idleTimeoutMs: command.idleTimeoutMs } : {}),
    ...(channels.length > 0 ? { channels } : {}),
    log,
    warn,
  });

  if (command.events) {
    gateway.bus.subscribe((event) => {
      const line = formatEvent(event);
      if (line) {
        writeLine(streams.stdout, line);
      }
    });
  }

  if (logWriter) {
    // Only session.created carries the agent id, so it seeds a map the
    // later events in that session read from. A session resumed after a
    // restart never re-creates, so an unmapped id falls back to the
    // durable store — which is exactly the case where attribution matters.
    const agentBySession = new Map<string, string>();
    // EventBus.emit awaits its subscribers, and a streaming provider awaits
    // the delta sink — so anything awaited here lands on the critical path
    // of every streamed token. This handler is deliberately synchronous:
    // provider.delta is dropped outright (it carries no detail worth
    // keeping, one record per token), the timestamp is taken now, and the
    // write is queued without awaiting it.
    gateway.bus.subscribe((event) => {
      if (event.type === 'provider.delta') {
        return;
      }
      const ts = new Date().toISOString();
      if (event.type === 'session.created') {
        agentBySession.set(event.sessionId, event.agentId);
      }
      const detail = eventDetail(event);
      const base = {
        ts,
        level: 'event' as const,
        event: event.type,
        sessionId: event.sessionId,
        ...(detail ? { detail } : {}),
      };
      const known = agentBySession.get(event.sessionId);
      if (known) {
        void logWriter.write({ ...base, agentId: known });
      } else {
        // A session resumed after a restart never re-creates, so its agent
        // is only in the store. That lookup is deferred off this path; the
        // timestamp above keeps ordering honest.
        void gateway.store.get(event.sessionId)
          .then((session) => {
            const agentId = session?.agent.id;
            if (agentId) {
              agentBySession.set(event.sessionId, agentId);
            }
            return logWriter.write({ ...base, ...(agentId ? { agentId } : {}) });
          })
          .catch(() => logWriter.write(base));
      }
      if (event.type === 'session.completed' || event.type === 'session.failed') {
        agentBySession.delete(event.sessionId);
      }
    });
  }

  await gateway.start();

  // Read now, while the API is bound: its stop forgets the address, and
  // a restart's respawn needs it (see ServeOutcome).
  const boundApiPort = boundApi?.url !== undefined ? Number(new URL(boundApi.url).port) : undefined;
  if (supervised && boundApiPort !== undefined && Number.isInteger(boundApiPort) && boundApiPort > 0) {
    link.send({ type: 'stratusd.bound-api-port', port: boundApiPort });
  }

  // Under one finally from here: a throw anywhere after the start — a
  // host's writable refusing a line, say — must still stop the gateway
  // before the claim on the home is released, or a live gateway would be
  // left behind a lock the next daemon can take.
  let redirectTimer: NodeJS.Timeout | undefined;
  try {
    // The roster is only known once the gateway has loaded it, and in remote
    // mode an agent no channel can ask for is the quietest failure this
    // feature has: its gated calls park with nobody rendering them and wait
    // out the whole timeout before being denied. No channel can detect this
    // on its own — a request is a broadcast, and no adapter knows whether
    // another one is about to answer — so it is reported here, where the
    // roster and the channel list are both in view.
    if (approvalMode === 'remote') {
      const askable = new Set(slackAdapterUp ? slackAgents.map(([agentId]) => agentId) : []);
      const unreachable = gateway.agents().map((agent) => agent.id).filter((id) => !askable.has(id));
      if (unreachable.length > 0) {
        warn(
          `no channel can ask for ${unreachable.join(', ')}, so their gated calls will wait out the `
          + 'approval timeout and then be denied. Connect a Slack app for them, or run with --approvals headless.',
        );
      }
    }

    writeLine(streams.stdout, 'Press Ctrl+C to stop.');

    // And periodically, for a long-running daemon that warns steadily
    // without ever writing enough records to rotate. Unref'd, so it never
    // holds the process open. Armed only once the daemon is actually
    // serving: every step above can throw, and runServe is an exported
    // function as much as a process entry point — in a host that survives
    // the failure, a timer armed before the throw would outlive the call
    // and go on truncating that environment's redirect logs. The finally
    // below takes it down on every other exit path.
    if (logWriter) {
      redirectTimer = setInterval(() => void truncateRedirectLogs(logsDirPath(env)), 5 * 60_000);
      redirectTimer.unref?.();
    }

    // Hold the event loop open until a shutdown request, then drain: new
    // dispatches are refused while in-flight turns finish.
    await new Promise<void>((resolve) => {
      const keepAlive = setInterval(() => {}, 2_147_000_000);
      let settled = false;
      const shutdown = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearInterval(keepAlive);
        resolve();
      };
      stopSignal = (): void => {
        if (!settled) {
          shutdown();
          return;
        }
        // A signal while a drain is already running — a repeat, or a stop
        // arriving during a restart's drain. Either way the drain goes on,
        // and a daemon told to stop does not come back.
        stopRequested = true;
        if (!repeatWarned) {
          repeatWarned = true;
          // Said from signal dispatch, outside the promise and its finally:
          // a stream that throws on write (a host's injected stderr) would
          // otherwise end the process from here — mid-drain, the very
          // thing this handler exists to prevent. The word is best effort.
          try {
            warn('stop signal received while draining; still draining, and this daemon will not come back (SIGKILL ends it at once)');
          } catch {
            // Nothing to say it to; the drain is what matters.
          }
        }
      };
      // `on`, never `once`, and not removed until the drain is over (the
      // finally below). `once` drops the listener before running it, Node
      // uninstalls its native handler the moment no listener is left, and
      // a second SIGTERM landing in that window ends the process by the
      // default action — mid-drain, with nothing said. The second signal
      // is the normal case, not an edge: a stop delivered to the process
      // group, as systemd's KillMode=control-group and a terminal's Ctrl+C
      // deliver it, reaches a supervised daemon once from the kernel and
      // once more forwarded by its supervisor. Reproduced two runs in
      // three: the replacement died and the supervisor exited 1 on a
      // `stratus service stop` after a restart. SIGKILL still ends the
      // process at once.
      process.on('SIGTERM', stopSignal);
      process.on('SIGINT', stopSignal);
      void shutdownRequested.then(shutdown);
      if (env.shutdownSignal?.aborted) {
        shutdown();
      } else {
        env.shutdownSignal?.addEventListener('abort', shutdown, { once: true });
      }
    });

    // Decided now, before the stop below: a restart's drain can still be
    // running when a stop signal releases this wait, and `onRestart` then
    // fires during that stop. A daemon told to stop does not come back,
    // whatever it was told before.
    if (!restart) {
      stopRequested = true;
    }
    if (restart) {
      // Already stopped: the gateway drained and closed before handing the
      // process over, and the stop() below finds nothing to do. Said here,
      // while the structured log still takes writes — the next lines
      // belong to a process that has none.
      if (!restart.drained) {
        // A turn that ignored its abort is still running in this process,
        // possibly still writing sessions. Starting a fresh daemon beside
        // it would be two processes on one store; exiting instead leaves
        // the service manager, where there is one, to bring it back.
        warn(`restart: something did not let go; exiting with status ${UNDRAINED_RESTART_EXIT_CODE} for the service manager to restart, instead of starting a new daemon beside it`);
      } else {
        log(`restarting stratusd${restart.reason ? ` (${restart.reason})` : ''}`);
      }
    } else {
      writeLine(streams.stdout, 'Stopping — draining in-flight turns.');
    }
  } finally {
    try {
      await gateway.stop();
      // Writes are queued and dropped on the hot path so logging never sits
      // on a streamed token. That makes the tail of the log the part most
      // likely to be lost — and the tail is the shutdown reason, the last
      // warning, the line explaining a restart.
      await logWriter?.flush();
    } finally {
      // The shutdown is over, the flush included: a stop signal from here
      // on is the process's to handle by default again — and a host that
      // calls runServe repeatedly (the tests) must not accumulate handlers.
      // Last, and under its own finally, because the listener is on the
      // global process: taken off before the flush, a repeated signal
      // landing during it would end the process by the default action
      // (which a supervisor reports as a failure, and a service manager
      // set to restart on failure would then bring back a daemon an
      // operator just stopped); left on by a stop() that rejects (its last
      // log line can throw through an injected stream), a settled handler
      // would swallow the host's next signal.
      if (stopSignal) {
        process.off('SIGTERM', stopSignal);
        process.off('SIGINT', stopSignal);
      }
      if (redirectTimer) {
        clearInterval(redirectTimer);
      }
    }
  }

  const bound = boundApiPort !== undefined && Number.isInteger(boundApiPort) && boundApiPort > 0
    ? { boundApiPort }
    : {};
  if (!restart || stopRequested) {
    return { code: 0, ...bound, sessions: [] };
  }
  if (!restart.drained) {
    (env.exitProcess ?? process.exit)(UNDRAINED_RESTART_EXIT_CODE);
    return { code: UNDRAINED_RESTART_EXIT_CODE, ...bound, sessions: [] };
  }
  // Coming back: the browser sessions live at the stop go to the
  // replacement — up the channel to the supervisor when this daemon has
  // one, else with the outcome to the supervisor this process becomes.
  const sessions = boundApi?.sessionsAtStop() ?? [];
  if (supervised && sessions.length > 0) {
    link.send({ type: 'stratusd.sessions', sessions });
  }
  // Asked to come back. Whether this process starts the next daemon or
  // exits for its supervisor to is `runServe`'s decision, after the home
  // is released: the claim is held until this returns, and a daemon
  // started before that would be refused as a second one on the home.
  return { code: RESTART_EXIT_CODE, ...bound, sessions };
};

export const runCli = async ({ argv, streams = process, env = {} }: CliRunOptions): Promise<number> => {
  try {
    const resolvedEnv = argv.includes('--stdin') && env.stdin === undefined
      ? {
          ...env,
          stdin: await readPromptFromStdin(env.stdinStream ?? process.stdin),
        }
      : env;

    const command = parseCommand(argv, resolvedEnv);

    if (command.command === 'help') {
      writeLine(streams.stdout, HELP_TEXT);
      return 0;
    }

    // Migrations run on first use of a newer build — every command, every
    // install path — not only via `stratus update`: state that migrates
    // only sometimes is worse than state that never migrates, because the
    // two populations diverge silently. `update` is excluded because it
    // owns the migration step at its own place in the upgrade sequence
    // (after the service stop and the package upgrade), and `--check` has
    // to be able to report what is pending rather than having just done it.
    if (command.command !== 'update') {
      const stamp = await readStateStamp(resolvedEnv);
      if (stamp.schemaVersion > STATE_SCHEMA_VERSION) {
        // Anything that writes under ~/.stratus refuses, not only the
        // daemon: a downgraded build's setup, chat, or run can discard
        // fields and invariants the newer format relies on — the exact
        // hazard the stamp exists to close. Read-only commands warn and
        // continue, because reading logs or the roster is how someone
        // diagnoses their way OUT of this state; so do `service stop`,
        // `status`, and `uninstall`, for the same reason. (`agent new`
        // only prints an identity — it writes nothing.)
        const writesState = command.command === 'serve'
          || command.command === 'setup'
          || command.command === 'chat'
          || command.command === 'run'
          || command.command === 'skill-add'
          || command.command === 'dashboard'
          || (command.command === 'credential' && command.action !== 'list')
          || (command.command === 'schedules' && command.action === 'cancel')
          || (command.command === 'service' && (command.action === 'install' || command.action === 'start'));
        if (writesState) {
          writeLine(streams.stderr, newerStateMessage(stamp.schemaVersion));
          writeLine(streams.stderr, `Refusing \`stratus ${command.command}\` — it writes state the newer format owns. Read-only commands (logs, agents, doctor, service status/stop) still work.`);
          return 1;
        }
        writeLine(streams.stderr, `Warning: ${newerStateMessage(stamp.schemaVersion)}`);
      } else {
        try {
          for (const migration of await runStateMigrations(resolvedEnv)) {
            if (migration.detail !== undefined) {
              writeLine(streams.stderr, `state migration ${migration.id}: ${migration.detail}`);
            }
          }
        } catch (error) {
          // A failed migration must not brick every command, but running
          // on unmigrated state is worth a line: silence here is how the
          // migrated and unmigrated populations diverge.
          writeLine(streams.stderr, `Warning: state migration failed (${error instanceof Error ? error.message : String(error)}). Continuing on unmigrated state — \`stratus update\` retries it.`);
        }
      }
    }

    // Every handler is awaited, never bare-returned: a bare `return
    // promise` inside try/catch settles the async function before the
    // catch can see it, so a command that fails at runtime — a gateway
    // that cannot open its store, a missing credential — would escape as
    // a raw rejection instead of the error line and exit code below.
    if (command.command === 'agent-new') {
      return await runAgentNew(command, streams, resolvedEnv);
    }

    if (command.command === 'agents') {
      return await runAgents(command, streams, resolvedEnv);
    }

    if (command.command === 'skill-add') {
      return await runSkillAdd(command, streams, resolvedEnv);
    }

    if (command.command === 'skill-validate') {
      return await runSkillValidate(command, streams, resolvedEnv);
    }

    if (command.command === 'skills') {
      return await runSkills(streams, resolvedEnv);
    }

    if (command.command === 'credential') {
      return await runCredential(command, streams, resolvedEnv);
    }

    if (command.command === 'skill-reload') {
      return await runSkillReload(command, streams, resolvedEnv);
    }

    if (command.command === 'restart') {
      return await runRestart(command, streams, resolvedEnv);
    }

    if (command.command === 'schedules') {
      return await runSchedules(command, streams, resolvedEnv);
    }

    if (command.command === 'doctor') {
      return await runDoctor(command, streams, resolvedEnv);
    }

    if (command.command === 'logs') {
      return await runLogs(command, streams, resolvedEnv);
    }

    if (command.command === 'service') {
      return await runService(command, streams, resolvedEnv);
    }

    if (command.command === 'update') {
      return await runUpdate(command, streams, resolvedEnv);
    }

    if (command.command === 'chat') {
      return await runChat(command, streams, resolvedEnv);
    }

    if (command.command === 'setup') {
      return await runSetup(command, streams, resolvedEnv);
    }

    if (command.command === 'dashboard') {
      return await runDashboard(command, streams, resolvedEnv);
    }

    if (command.command === 'serve') {
      return await runServe(command, streams, resolvedEnv);
    }

    const runtime = await resolveRuntimeConfig(command, resolvedEnv);
    await warnOnCredentialOverride(runtime, streams, resolvedEnv);

    if (command.format === 'text') {
      writeLine(streams.stdout, formatRuntimeBanner(runtime));
    }

    const session = await runSingleLoop(command.prompt, streams, {
      events: command.events && command.format === 'text',
      runtime,
      approvals: command.approvals,
      ...(command.maxTurns !== undefined ? { maxTurns: command.maxTurns } : {}),
      ...(command.configPath ? { configPath: command.configPath } : {}),
      env: resolvedEnv,
    });

    if (command.format === 'json') {
      writeLine(streams.stdout, JSON.stringify({
        provider: runtime.provider,
        // Replay state (Claude's raw thinking turns) stays in the stored
        // session but never in user-facing output.
        session: redactAnthropicRawTurns(session),
      }, null, 2));
      return 0;
    }

    printSessionSummary(session, streams);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeLine(streams.stderr, `Error: ${message}`);
    writeLine(streams.stderr, '');
    writeLine(streams.stderr, HELP_TEXT);
    return 1;
  }
};

export { HELP_TEXT, stringifyValue };
