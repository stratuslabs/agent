import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFile, chmod, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import {
  AgentRunner,
  AllowAllApprovalPolicy,
  EventBus,
  ToolRegistry,
  type AgentMemoryStore,
  type ApprovalPolicy,
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
import {
  createRememberTool,
  defineAgent,
  formatSoul,
  generateAgentName,
  parseSoul,
  type ParsedSoul,
} from '@stratusagent/agents';
import {
  agentsDirPath,
  apiKeyEnvNameFor,
  createDemoTool,
  createFileMemoryStore,
  createRuntimeProvider,
  credentialsPath,
  DEFAULT_ANTHROPIC_BASE_URL,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_STRATUS_AGENT,
  discoverActiveConfig,
  globalConfigPath,
  loadChannelCredentials,
  loadCredentials,
  loadRosterSouls,
  loadSoulFile,
  memoryFilePath,
  migrateLegacyMemory,
  parseProviderName,
  readNonEmptyString,
  readProcessEnv,
  logsDirPath,
  readWorkingDirectory,
  resolveEnvApiKey,
  DEFAULT_CONFIG_FILENAME,
  LEGACY_CONFIG_FILENAME,
  loadConfigFile,
  resolveConfigLocation,
  resolveRuntimeConfig as resolveStateRuntimeConfig,
  saveChannelCredentials,
  saveCredentials,
  stratusHomePath,
  withLegacyDefaultMemories,
  type ChannelCredentials,
  type CredentialProviderName,
  type CredentialsFile,
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
  /** Runs launchctl/systemctl. Injected so tests never touch the real one. */
  serviceRunner?: ServiceRunner;
}

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
  host: string;
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

export interface ParsedAgentsCommand {
  command: 'agents';
  format: 'text' | 'json';
}

export interface ParsedDoctorCommand {
  command: 'doctor';
  format: 'text' | 'json';
  configPath?: string;
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

export interface ParsedServeCommand {
  command: 'serve';
  configPath?: string;
  /** Watchdog idle timeout in milliseconds. 0 disables. */
  idleTimeoutMs?: number;
  events: boolean;
  /** Write the structured log to ~/.stratus/logs. Defaults to true. */
  logToFile?: boolean;
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
  | ParsedDoctorCommand
  | ParsedLogsCommand
  | ParsedServiceCommand
  | ParsedServeCommand
  | ParsedHelpCommand;

type CliConfigFile = StratusConfigFile;

export interface DashboardServerHandle {
  url: string;
  close: () => Promise<void>;
}

export const CLI_VERSION = '0.2.5';

const DEFAULT_DASHBOARD_HOST = '127.0.0.1';
const DASHBOARD_TITLE = 'Stratus Agent Dashboard';

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
  stratus doctor
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
                   (0600)
  chat             Talk with your agent — the conversation persists across turns
                   and remembered facts accumulate; /exit or Ctrl+C to leave
  run              Execute one local Stratus Agent session
  serve            Run stratusd, the always-on gateway: durable sessions, the
                   whole roster live at once (each agent on its own provider),
                   delegation, and a watchdog — Ctrl+C / SIGTERM drains cleanly
                   (--idle-timeout <seconds>, --no-events, --no-log-file,
                   --config <path>); everything it says is also written to
                   ~/.stratus/logs, which "stratus logs" reads
  service          Keep stratusd running under launchd (macOS) or systemd
                   (Linux): install, uninstall, status, start, stop.
                   Installing starts it now and at every login
                   (--no-login installs without the login trigger,
                   --config <path> pins the daemon to one config file)
  logs             Read the daemon's log from any terminal: -f to follow,
                   -n <count> for backlog, --agent / --session to filter,
                   --format json for the raw records
  agent new        Create an agent identity (generates a human-ish name + avatar theme)
  agents           List your agents: who they are, where their souls live, what
                   they run on, what they remember (also: stratus agent list)
  doctor           Show what a run would use right now — provider, model, soul —
                   and which file or environment variable decided each, then
                   flag anything that would surprise you (--format json)
  dashboard        Start the local Stratus Agent dashboard and open it in your browser
  help             Show this help message

Agent options:
  --name           Agent name (omit to have one generated)
  --instructions   The agent's persona/instructions
  --format         Output format for agent new: text, json, or soul (a ready-to-edit soul file)

Options:
  --prompt, -p     Prompt to send to the local agent loop
  --stdin          Read the prompt from stdin
  --provider       Provider to use: anthropic, openai, or demo
  --model          Model name for real providers (anthropic default: ${DEFAULT_ANTHROPIC_MODEL}, openai default: gpt-4.1-mini)
  --base-url       Override the provider API base URL
  --soul           Run as the agent defined by a soul file (markdown + frontmatter, see examples/souls)
  --config         Config file path (run: load settings from it, setup: write it)
  --format         Output format: text or json (default: text)
  --no-events      Hide event-by-event progress lines in text mode
  --approvals      Tool approval mode: always, ask, or never (default: always)
  --max-turns      Maximum provider turns per run (default: 8)
  --port           Dashboard port, defaults to an open local port
  --host           Dashboard host (default: 127.0.0.1)
  --no-open        Do not open the browser automatically
  --help, -h       Show this help message

Config file:
  The CLI looks for ./stratus.config.json first, then a path from --config / STRATUS_CONFIG,
  then the global ~/.stratus/config.json written by \`stratus setup\`.
  A "soul" key (or STRATUS_SOUL) points at a soul file so every run uses that agent.
  Legacy STRATUSCLAW_* env vars and stratusclaw.config.json are still supported for compatibility.

Soul files:
  A soul file is markdown with frontmatter (name, provider, model, tools, credentials)
  followed by the agent's persona in prose. See examples/souls/ava.md.
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
    let host = DEFAULT_DASHBOARD_HOST;
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

    return { command: 'dashboard', ...(port !== undefined ? { port } : {}), host, openBrowser };
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
      if (token === '--no-events') {
        parsed.events = false;
        continue;
      }
      if (token === '--no-log-file') {
        parsed.logToFile = false;
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
    for (let index = 0; index < agentsRest.length; index += 1) {
      const token = agentsRest[index];
      if (!token) {
        continue;
      }
      if (token === '--help' || token === '-h') {
        return { command: 'help' };
      }
      if (token === '--format') {
        const value = readOptionValue(agentsRest, index, '--format');
        if (value !== 'text' && value !== 'json') {
          throw new Error(`Unsupported format: ${value}`);
        }
        format = value;
        index += 1;
        continue;
      }
      throw new Error(`Unknown option: ${token}`);
    }
    return { command: 'agents', format };
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
 */
const eventDetail = (event: StratusEvent): Record<string, unknown> | undefined => {
  switch (event.type) {
    case 'session.updated':
      return { status: event.status };
    case 'provider.response':
      return { parts: event.parts.length };
    case 'tool.called':
    case 'tool.denied':
      return { tool: event.call.toolName };
    case 'tool.completed':
      return { tool: event.result.toolName, ok: event.result.ok };
    case 'session.failed':
      return { error: event.error };
    default:
      return undefined;
  }
};

// Kept with its historical CLI signature: a parsed run command is a
// RuntimeSelection plus CLI-only fields the resolver ignores.
export const resolveRuntimeConfig = (
  command: ParsedRunCommand,
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
  const stored = (await loadCredentials(env)).anthropic;
  if (stored?.type !== 'oauth_token') {
    return;
  }
  // The resolver records the variable that actually won — guessing it here
  // would name the wrong one whenever a custom apiKeyEnv or the legacy
  // STRATUSCLAW_ prefix supplied the key, sending the reader to unset
  // something that was never the cause.
  const primary = runtime.provider === 'anthropic' && runtime.apiKey ? runtime.apiKeyEnvVar : undefined;
  // A fallback demoted the same way costs exactly as much, and only bites
  // once the primary is already failing — the worst moment to discover it.
  // The fallback path consults the provider's own conventional variable.
  const processEnv = readProcessEnv(env);
  const fallbackVar = runtime.fallback?.provider === 'anthropic'
    && runtime.fallback.apiKey !== undefined
    && readNonEmptyString(processEnv.ANTHROPIC_API_KEY) === runtime.fallback.apiKey
    ? 'ANTHROPIC_API_KEY'
    : undefined;
  const culprit = primary ?? fallbackVar;
  if (!culprit) {
    return;
  }
  writeLine(
    streams.stderr,
    `Warning: ${culprit} in your environment outranks the Claude subscription sign-in saved by \`stratus setup\`, `
    + `so ${primary ? 'this run is' : 'a fallback retry would be'} billed per token instead of through your plan. `
    + 'Unset it to use the subscription, or run `stratus doctor` to see everything that is being overridden.',
  );
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
  },
) => {
  const runEnv = options.env ?? {};
  await migrateLegacyMemory(runEnv);
  const memory = withLegacyDefaultMemories(createFileMemoryStore(memoryFilePath(runEnv)));

  const tools = new ToolRegistry();
  tools.register(createDemoTool());
  tools.register(createRememberTool(memory));

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
    memory,
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
  });

  hostedRunner = runner;
  await runner.initialize();

  // A soul is a full identity — without one, every provider serves the
  // same built-in Stratus persona.
  const agent = options.runtime.soul?.agent ?? DEFAULT_STRATUS_AGENT;

  const metadata = options.runtime.provider === 'demo'
    ? { provider: 'demo' as const, executor: 'local-command' }
    : {
        provider: options.runtime.provider,
        model: options.runtime.model,
        ...(options.runtime.provider === 'openai' ? { baseUrl: options.runtime.baseUrl } : {}),
      };

  return { runner, agent, metadata };
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
  },
): Promise<Session> => {
  const { runner, agent, metadata } = await createAgentRuntime(streams, options);
  return runner.run({
    sessionId: randomUUID(),
    agent,
    userMessage: prompt,
    metadata,
  });
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

  const { runner, agent, metadata } = await createAgentRuntime(streams, {
    runtime,
    approvals: command.approvals,
    askApproval,
    ...(command.maxTurns !== undefined ? { maxTurns: command.maxTurns } : {}),
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

const escapeHtml = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

const renderDashboardHtml = (url: string): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${DASHBOARD_TITLE}</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
        background: radial-gradient(circle at top, #1f3a5f 0%, #0b1020 45%, #05070f 100%);
        color: #f3f7ff;
      }
      main { max-width: 960px; margin: 0 auto; padding: 40px 20px 72px; }
      .hero, .card { background: rgba(10, 16, 32, 0.74); border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 20px; backdrop-filter: blur(12px); }
      .hero { padding: 32px; margin-bottom: 20px; }
      .eyebrow { display: inline-block; font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; color: #93c5fd; }
      h1 { font-size: clamp(32px, 6vw, 56px); line-height: 1; margin: 14px 0 12px; }
      p { color: #cbd5e1; line-height: 1.6; }
      .grid { display: grid; gap: 20px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
      .card { padding: 24px; }
      .stat { font-size: 28px; font-weight: 700; margin: 6px 0; }
      code, pre, textarea { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      textarea {
        width: 100%; min-height: 120px; border-radius: 14px; border: 1px solid rgba(148, 163, 184, 0.28);
        background: rgba(15, 23, 42, 0.9); color: #e2e8f0; padding: 14px; resize: vertical;
      }
      button {
        margin-top: 12px; border: 0; border-radius: 999px; padding: 12px 18px; font-weight: 700; cursor: pointer;
        background: linear-gradient(135deg, #60a5fa, #22d3ee); color: #08111f;
      }
      pre {
        margin: 14px 0 0; padding: 14px; border-radius: 14px; overflow: auto;
        background: rgba(2, 6, 23, 0.9); border: 1px solid rgba(148, 163, 184, 0.2); color: #bfdbfe;
      }
      a { color: #7dd3fc; }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <span class="eyebrow">Stratus Agent local dashboard</span>
        <h1>Stratus Agent is up.</h1>
        <p>A tiny dashboard for local testing. It confirms the CLI is reachable, gives you a quick action, and keeps the current repo intent visible.</p>
        <p><strong>Local URL:</strong> <a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>
      </section>
      <section class="grid">
        <article class="card">
          <div class="eyebrow">Status</div>
          <div class="stat">Ready</div>
          <p>The local server is running with Node standard library primitives only.</p>
        </article>
        <article class="card">
          <div class="eyebrow">About</div>
          <div class="stat">Minimal by design</div>
          <p>Use <code>stratus run</code> for the agent loop, or use the tester here to verify browser-to-local requests during development.</p>
        </article>
      </section>
      <section class="card" style="margin-top:20px;">
        <div class="eyebrow">Actionable test</div>
        <h2 style="margin:12px 0 8px;">Echo tester</h2>
        <p>Send a payload to the local dashboard API and inspect the response.</p>
        <textarea id="payload">Hello from Stratus Agent dashboard</textarea>
        <button id="send">POST /api/echo</button>
        <pre id="result">Waiting for input…</pre>
      </section>
    </main>
    <script>
      const button = document.getElementById('send');
      const payload = document.getElementById('payload');
      const result = document.getElementById('result');
      button.addEventListener('click', async () => {
        result.textContent = 'Sending...';
        try {
          const response = await fetch('/api/echo', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: payload.value })
          });
          const data = await response.json();
          result.textContent = JSON.stringify(data, null, 2);
        } catch (error) {
          result.textContent = String(error);
        }
      });
    </script>
  </body>
</html>`;

const readBody = async (request: IncomingMessage): Promise<string> => {
  let data = '';
  for await (const chunk of request) {
    data += chunk.toString();
  }
  return data;
};

const sendJson = (response: ServerResponse, statusCode: number, payload: unknown): void => {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload, null, 2));
};

const sendHtml = (response: ServerResponse, html: string): void => {
  response.statusCode = 200;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(html);
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

export const startDashboardServer = async (
  options: { host: string; port?: number },
): Promise<DashboardServerHandle> => {
  const server = createServer(async (request, response) => {
    const method = request.method ?? 'GET';
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');

    if (method === 'GET' && requestUrl.pathname === '/') {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : options.port ?? 0;
      const host = typeof address === 'object' && address && address.address ? address.address : options.host;
      sendHtml(response, renderDashboardHtml(`http://${host === '::' ? '127.0.0.1' : host}:${port}`));
      return;
    }

    if (method === 'GET' && requestUrl.pathname === '/api/status') {
      sendJson(response, 200, {
        ok: true,
        service: 'stratus-dashboard',
        version: CLI_VERSION,
        now: new Date().toISOString(),
      });
      return;
    }

    if (method === 'POST' && requestUrl.pathname === '/api/echo') {
      const raw = await readBody(request);
      let text = '';
      if (raw.trim().length > 0) {
        const payload = JSON.parse(raw) as { text?: unknown };
        text = typeof payload.text === 'string' ? payload.text : '';
      }
      sendJson(response, 200, {
        ok: true,
        received: text,
        uppercase: text.toUpperCase(),
        length: text.length,
      });
      return;
    }

    sendJson(response, 404, { ok: false, error: 'Not found' });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Unable to determine dashboard server address.');
  }

  const host = address.address === '::' ? '127.0.0.1' : address.address;
  const url = `http://${host}:${address.port}`;

  return {
    url,
    close: async () => {
      if (!server.listening) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
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

// Live check that a pasted key actually works, so the user finds out inside
// setup instead of on their first run.
const verifyProviderKey = async (
  provider: 'anthropic' | 'openai',
  key: string,
  baseUrl: string | undefined,
  fetchImpl: typeof fetch | undefined,
): Promise<{ status: 'ok' | 'rejected' | 'unreachable'; detail?: string }> => {
  if (typeof fetchImpl !== 'function') {
    return { status: 'unreachable', detail: 'fetch is unavailable' };
  }

  const root = (baseUrl ?? (provider === 'anthropic' ? DEFAULT_ANTHROPIC_BASE_URL : DEFAULT_OPENAI_BASE_URL)).replace(/\/+$/, '');
  const url = provider === 'anthropic' ? `${root}/v1/models` : `${root}/models`;
  const headers = provider === 'anthropic'
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : { authorization: `Bearer ${key}` };

  try {
    const response = await fetchImpl(url, { headers });
    if (response.ok) {
      return { status: 'ok' };
    }
    // Only an explicit auth failure condemns the key. Compatible endpoints
    // (local models, proxies) often lack GET /models entirely — a 404/405
    // there says nothing about the key, so it stays saveable.
    if (response.status === 401 || response.status === 403) {
      return { status: 'rejected', detail: `HTTP ${response.status}` };
    }
    return { status: 'unreachable', detail: `the endpoint did not support a key check (HTTP ${response.status})` };
  } catch (error) {
    return { status: 'unreachable', detail: error instanceof Error ? error.message : String(error) };
  }
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
  'chat:write',
  'files:write',
  'im:history',
  'im:read',
  'im:write',
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
    interactivity: { is_enabled: false },
    org_deploy_enabled: false,
    socket_mode_enabled: true,
    token_rotation_enabled: false,
  },
}, null, 2);

const DEFAULT_SOUL_STARTER = [
  'You are a helpful, warm generalist. Answer first, explain second, and',
  'keep replies short unless the question genuinely needs depth. Use',
  'memory.remember for durable facts about the people you work with.',
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

// Shown when live model listing is unavailable (e.g. subscription tokens
// cannot call the models endpoint, or the machine is offline).
// Model ids that cannot serve /chat/completions and must not become the
// default: embeddings, audio, images, moderation, and legacy completions.
const NON_CHAT_MODEL_PATTERN = /embed|whisper|tts|audio|dall-e|image|moderation|realtime|transcribe|davinci|babbage|curie|(^|[-_])ada([-_]|$)/i;

const KNOWN_CLAUDE_MODELS = [
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-4-5',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
];

export const runSetup = async (
  command: ParsedSetupCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  const cwd = readWorkingDirectory(env);
  const processEnv = readProcessEnv(env);

  // Config target: --config, then STRATUS_CONFIG / STRATUSCLAW_CONFIG, then
  // the global ~/.stratus/config.json — the file `stratus run` falls back to
  // from any directory, which is what makes setup a one-time step.
  const envConfigVar = readNonEmptyString(processEnv.STRATUS_CONFIG)
    ? 'STRATUS_CONFIG'
    : readNonEmptyString(processEnv.STRATUSCLAW_CONFIG)
      ? 'STRATUSCLAW_CONFIG'
      : undefined;
  const envConfigPath = envConfigVar ? String(processEnv[envConfigVar]).trim() : undefined;
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
    provider === 'openai' ? DEFAULT_OPENAI_MODEL : DEFAULT_ANTHROPIC_MODEL;
  const defaultKeyEnvFor = (provider: CliProviderName): string =>
    provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';

  const credentialLabel = (credential: StoredCredential): string =>
    credential.type === 'oauth_token' ? 'Claude subscription' : 'API key';

  const providerSignInStatus = (provider: CredentialProviderName): string => {
    const credential = state.credentials[provider];
    if (credential) {
      return `signed in (${credentialLabel(credential)})`;
    }
    if (readNonEmptyString(processEnv[defaultKeyEnvFor(provider)])) {
      return `using ${defaultKeyEnvFor(provider)} from your environment`;
    }
    return 'not signed in';
  };

  const providersSummary = (): string => {
    const parts: string[] = [];
    for (const provider of ['anthropic', 'openai'] as const) {
      const credential = state.credentials[provider];
      if (credential) {
        parts.push(`${provider} (${credentialLabel(credential)})`);
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
        ? 'signed in with your Claude subscription'
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
        ?? readNonEmptyString(processEnv.STRATUSCLAW_API_KEY_ENV)
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
      'Demo — built-in fake model, offline, no account',
      'Back',
    ]);

    if (answer.kind !== 'index' || answer.index === 3) {
      return;
    }

    if (answer.index === 2) {
      await switchDefaultProvider('demo');
      writeLine(streams.stdout, 'Demo selected — no sign-in needed. Mention "echo" or "tool" in a prompt to see tool calls.');
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

  // Every model the current sign-ins can actually reach, fetched live where
  // possible. Subscription tokens cannot call the models endpoint, so those
  // fall back to the known Claude lineup.
  const collectAvailableModels = async (): Promise<Array<{ provider: CredentialProviderName; id: string }>> => {
    const fetchImpl = env.fetch ?? globalThis.fetch;
    const models: Array<{ provider: CredentialProviderName; id: string }> = [];

    for (const provider of ['anthropic', 'openai'] as const) {
      // Discovery uses the credential a real run would use. STRATUS_API_KEY
      // and a configured apiKeyEnv authenticate the DEFAULT provider only —
      // a secondary provider relies on its own env var or stored sign-in,
      // never the default provider's secret.
      const envKey = (provider === state.provider
        ? readNonEmptyString(processEnv.STRATUS_API_KEY)
          ?? (state.apiKeyEnv ? readNonEmptyString(processEnv[state.apiKeyEnv]) : undefined)
        : undefined)
        ?? readNonEmptyString(processEnv[defaultKeyEnvFor(provider)]);
      const credential = envKey ? undefined : state.credentials[provider];
      const apiKey = envKey ?? (credential?.type === 'api_key' ? credential.value : undefined);
      if (!apiKey && !credential) {
        continue;
      }

      if (provider === 'anthropic') {
        if (!apiKey || typeof fetchImpl !== 'function') {
          // Subscription tokens cannot call the models endpoint.
          models.push(...KNOWN_CLAUDE_MODELS.map((id) => ({ provider, id })));
          continue;
        }
        // The same endpoint a real run uses: the stored key's bound URL is
        // authoritative, then a configured anthropic base URL (a proxy) —
        // never the official endpoint by accident.
        const anthropicRoot = ((credential?.type === 'api_key' ? credential.baseUrl : undefined)
          ?? (state.provider === 'anthropic' ? state.baseUrl : undefined)
          ?? DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, '');
        try {
          const response = await fetchImpl(`${anthropicRoot}/v1/models?limit=100`, {
            headers: { 'x-api-key': String(apiKey), 'anthropic-version': '2023-06-01' },
          });
          const payload = await response.json() as { data?: Array<{ id?: string }> };
          const ids = (payload.data ?? []).map((entry) => entry.id).filter((id): id is string => typeof id === 'string');
          models.push(...(ids.length > 0 ? ids : KNOWN_CLAUDE_MODELS).map((id) => ({ provider, id })));
        } catch {
          models.push(...KNOWN_CLAUDE_MODELS.map((id) => ({ provider, id })));
        }
        continue;
      }

      if (!apiKey || typeof fetchImpl !== 'function') {
        continue;
      }
      try {
        // A stored key's bound endpoint is authoritative, exactly as at run
        // time; only env-supplied keys follow the default provider's URL.
        const root = ((credential?.type === 'api_key' ? credential.baseUrl : undefined)
          ?? (state.provider === 'openai' ? state.baseUrl : undefined)
          ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');
        const response = await fetchImpl(`${root}/models`, {
          headers: { authorization: `Bearer ${String(apiKey)}` },
        });
        const payload = await response.json() as { data?: Array<{ id?: string }> };
        const allIds = (payload.data ?? [])
          .map((entry) => entry.id)
          .filter((id): id is string => typeof id === 'string');
        // Runs always call /chat/completions, so embedding, audio, image,
        // moderation, and legacy completion models would save a default
        // that cannot execute. If filtering leaves nothing (an exotic local
        // service), show everything rather than an empty menu.
        const chatIds = allIds.filter((id) => !NON_CHAT_MODEL_PATTERN.test(id));
        const ids = (chatIds.length > 0 ? chatIds : allIds).sort((a, b) => {
          const rank = (id: string): number => (/^gpt/i.test(id) ? 0 : /^o\d/i.test(id) ? 1 : 2);
          return rank(a) - rank(b) || a.localeCompare(b);
        });
        models.push(...ids.map((id) => ({ provider, id })));
      } catch {
        // No reachable model list for this provider; skip it.
      }
    }

    return models;
  };

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
        if ((providerPart === 'anthropic' || providerPart === 'openai') && id) {
          return { provider: providerPart, id };
        }
        writeLine(streams.stdout, 'Use provider:model, e.g. anthropic:claude-opus-5.');
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
    const agent = defineAgent({
      ...(name ? { name } : {}),
      instructions: instructions || DEFAULT_SOUL_STARTER,
    });
    const soul = formatSoul({
      agent,
      ...(state.provider !== 'demo' ? { provider: state.provider, model: state.model ?? defaultModelFor(state.provider) } : {}),
    });
    const soulPath = path.join(agentsDirPath(env), `${agent.id}.md`);
    await mkdir(path.dirname(soulPath), { recursive: true });
    await writeFile(soulPath, soul);
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
    const credential = envKey ? undefined : state.credentials[fallbackProvider];
    const apiKey = envKey ?? (credential?.type === 'api_key' ? credential.value : undefined);
    const authToken = credential?.type === 'oauth_token' ? credential.value : undefined;
    if (!apiKey && !authToken) {
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
        : (() => {
            const url = (fallbackProvider === state.provider ? state.baseUrl : undefined)
              ?? (credential?.type === 'api_key' ? credential.baseUrl : undefined);
            return url ? { baseUrl: url } : {};
          })()),
      ...(apiKey ? { apiKey } : {}),
      ...(authToken ? { authToken } : {}),
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
      ?? readNonEmptyString(processEnv.STRATUSCLAW_API_KEY_ENV)
      ?? state.apiKeyEnv
      ?? defaultKeyEnvFor(state.provider);
    const envKey = readNonEmptyString(processEnv.STRATUS_API_KEY)
      ?? readNonEmptyString(processEnv.STRATUSCLAW_API_KEY)
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
  const channelRoster = async (): Promise<ChannelRosterEntry[]> => {
    const warnOnce = (message: string): void => writeLine(streams.stderr, `Warning: ${message}.`);
    // Seeded before the roster loads, exactly as loadRoster does it: a
    // fresh install with no soul files still has an agent to put on
    // Slack, and a roster file that declares id "stratus" cannot take the
    // built-in's place — the gateway skips it, so offering it here would
    // name an app after an agent that never receives the messages.
    const entries: ChannelRosterEntry[] = [{ soul: { agent: { ...DEFAULT_STRATUS_AGENT } } }];
    // Mirror the gateway's loadRoster: two soul files declaring the same
    // id are not two agents. Offering both would let someone create and
    // name an app for the loser, which can never receive a message —
    // Slack credentials are keyed by the shared id, and dispatch reaches
    // the first sorted file.
    for (const entry of await loadRosterSouls(env, warnOnce)) {
      const clash = entries.find((seen) => seen.soul.agent.id === entry.soul.agent.id);
      if (clash) {
        warnOnce(`duplicate agent id ${entry.soul.agent.id} (${clash.path ?? 'built-in'} vs ${entry.path}); keeping the first`);
        continue;
      }
      entries.push(entry);
    }

    // The soul a run resolves to, in resolveSoulPath's own order: an env
    // override outranks the config value this setup session is editing.
    // Listing the config soul while `stratus serve` registers the env one
    // would store tokens against an id the adapter then skips.
    const processEnv = readProcessEnv(env);
    const envSoul = readNonEmptyString(processEnv.STRATUS_SOUL)
      ?? readNonEmptyString(processEnv.STRATUSCLAW_SOUL);
    if (typeof envSoul === 'string' && state.soulPath && envSoul !== state.soulPath) {
      warnOnce(`STRATUS_SOUL points at ${envSoul}, which outranks the configured ${state.soulPath} — Channels lists what a run would actually use`);
    }
    const effectiveSoul = typeof envSoul === 'string' ? envSoul : state.soulPath;
    if (!effectiveSoul) {
      return entries;
    }
    const resolved = path.resolve(readWorkingDirectory(env), effectiveSoul);
    if (entries.some((entry) => entry.path === resolved)) {
      return entries;
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
    return entries;
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
      const roster = await channelRoster();
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
      const orphans = Object.keys(slack).filter((id) => !roster.some((entry) => entry.soul.agent.id === id));
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
    legacy: string,
    chosen: string,
    flagName?: string,
  ): { envVar: string; envValue: string; flag?: string } | undefined => {
    const envVar = readNonEmptyString(processEnv[primary])
      ? primary
      : readNonEmptyString(processEnv[legacy])
        ? legacy
        : undefined;
    if (!envVar) {
      return undefined;
    }
    const envValue = String(processEnv[envVar]).trim();
    if (envValue === chosen) {
      return undefined;
    }
    return {
      envVar,
      envValue,
      ...(flagName ? { flag: `${flagName} ${quoteShellArg(chosen)}` } : {}),
    };
  };

  const save = async (): Promise<void> => {
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

    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    writeLine(streams.stdout);
    writeLine(streams.stdout, `Wrote ${configPath}`);

    // A project-local config in this directory outranks the global file for
    // bare runs started here — say so, and make the suggested command pick
    // the file that was just written.
    if (configPath === globalConfigPath(env)) {
      for (const shadow of [DEFAULT_CONFIG_FILENAME, LEGACY_CONFIG_FILENAME]) {
        const shadowPath = path.join(cwd, shadow);
        try {
          await readFile(shadowPath, 'utf8');
          writeLine(streams.stdout, `Note: ${shadowPath} exists and takes precedence over the global config for runs started in this directory.`);
          writeLine(streams.stdout, 'The suggested commands below include --config so they use what you just saved.');
          shadowConfigFlag = ` --config ${quoteShellArg(configPath)}`;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
          }
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
      }
    }
    writeLine(streams.stdout);

    // Exported STRATUS_* variables outrank the config file, so warn when one
    // would make `stratus run` behave differently from what was just saved.
    const conflicts = [
      detectEnvOverride('STRATUS_PROVIDER', 'STRATUSCLAW_PROVIDER', state.provider, '--provider'),
      ...(state.provider !== 'demo'
        ? [detectEnvOverride('STRATUS_MODEL', 'STRATUSCLAW_MODEL', state.model ?? defaultModelFor(state.provider), '--model')]
        : []),
      ...(state.provider === 'openai'
        ? [detectEnvOverride('STRATUS_BASE_URL', 'STRATUSCLAW_BASE_URL', state.baseUrl ?? DEFAULT_OPENAI_BASE_URL, '--base-url')]
        : [detectEnvOverride('STRATUS_BASE_URL', 'STRATUSCLAW_BASE_URL', '')]),
      detectEnvOverride('STRATUS_SYSTEM_PROMPT', 'STRATUSCLAW_SYSTEM_PROMPT', state.systemPrompt ?? ''),
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
    writeLine(streams.stdout, '  stratus dashboard');
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

    await save();
    return 0;
  } finally {
    prompter.close();
  }
};

const personaSnippet = (instructions: string | undefined): string | undefined => {
  const firstLine = instructions?.split('\n').map((line) => line.trim()).find((line) => line.length > 0);
  if (!firstLine) {
    return undefined;
  }
  return firstLine.length > 78 ? `${firstLine.slice(0, 77)}…` : firstLine;
};

export const runAgents = async (
  command: ParsedAgentsCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  // Fold any legacy per-directory memory in first so the counts below
  // reflect everything each agent actually remembers.
  await migrateLegacyMemory(env);
  const memory = withLegacyDefaultMemories(createFileMemoryStore(memoryFilePath(env)));

  const processEnv = readProcessEnv(env);
  // Listing must never be blocked by a broken config — it only feeds the
  // default marker and the "runs on" lines.
  const { config: activeConfig } = await discoverActiveConfig(env, (message) => {
    writeLine(streams.stderr, `Warning: ${message}.`);
  });

  const envProvider = readNonEmptyString(processEnv.STRATUS_PROVIDER, (value) => parseProviderName(value, 'STRATUS_PROVIDER'))
    ?? readNonEmptyString(processEnv.STRATUSCLAW_PROVIDER, (value) => parseProviderName(value, 'STRATUSCLAW_PROVIDER'));
  const envModel = readNonEmptyString(processEnv.STRATUS_MODEL)
    ?? readNonEmptyString(processEnv.STRATUSCLAW_MODEL);

  // What a run as this soul would actually use right now — the same
  // precedence as resolveRuntimeConfig (env vars, soul hints, config,
  // demo), so a model-only or provider-only pin still resolves honestly.
  const runsOnFor = (soulProvider?: string, soulModel?: string): { provider: string; model?: string } => {
    const provider = envProvider ?? soulProvider ?? activeConfig.provider ?? 'demo';
    if (provider === 'demo') {
      return { provider };
    }
    const soulModelApplies = soulProvider === undefined || soulProvider === provider;
    const configModelApplies = (activeConfig.provider ?? 'openai') === provider;
    const model = envModel
      ?? (soulModelApplies ? soulModel : undefined)
      ?? (configModelApplies ? activeConfig.model : undefined)
      ?? (provider === 'openai' ? DEFAULT_OPENAI_MODEL : DEFAULT_ANTHROPIC_MODEL);
    return { provider, model };
  };

  const defaultSoulPath = readNonEmptyString(processEnv.STRATUS_SOUL)
    ?? readNonEmptyString(processEnv.STRATUSCLAW_SOUL)
    ?? activeConfig.soul;
  const resolvedDefaultSoul = defaultSoulPath
    ? path.resolve(readWorkingDirectory(env), defaultSoulPath)
    : undefined;

  interface AgentListing {
    id: string;
    name: string;
    isDefault: boolean;
    builtIn: boolean;
    soulPath?: string;
    /** The soul's own frontmatter pin, verbatim. */
    provider?: string;
    model?: string;
    /** What a run as this agent resolves to right now. */
    runsOn: { provider: string; model?: string };
    memories: number;
    persona?: string;
    avatar?: string;
  }

  const listings: AgentListing[] = [];

  const addSoul = async (soulPath: string): Promise<void> => {
    let parsed: ParsedSoul;
    try {
      parsed = parseSoul(await readFile(soulPath, 'utf8'), { seed: soulPath });
    } catch (error) {
      writeLine(streams.stderr, `Warning: skipping ${soulPath}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const { agent } = parsed;
    const persona = personaSnippet(agent.instructions);
    listings.push({
      id: agent.id,
      name: agent.name,
      isDefault: soulPath === resolvedDefaultSoul,
      builtIn: false,
      soulPath,
      ...(parsed.provider ? { provider: parsed.provider } : {}),
      ...(parsed.model ? { model: parsed.model } : {}),
      runsOn: runsOnFor(parsed.provider, parsed.model),
      memories: (await memory.list(agent.id)).length,
      ...(persona ? { persona } : {}),
      ...(agent.avatar ? { avatar: `${agent.avatar.style} theme, hue ${agent.avatar.hue}, palette ${agent.avatar.palette.join(' ')}` } : {}),
    });
  };

  let rosterFiles: string[] = [];
  try {
    rosterFiles = (await readdir(agentsDirPath(env)))
      .filter((file) => file.endsWith('.md'))
      .sort()
      .map((file) => path.join(agentsDirPath(env), file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  for (const soulPath of rosterFiles) {
    await addSoul(soulPath);
  }
  // A default soul can live outside ~/.stratus/agents (a project soul, a
  // hand-written file) — the roster would be lying without it.
  if (resolvedDefaultSoul && !rosterFiles.includes(resolvedDefaultSoul)) {
    await addSoul(resolvedDefaultSoul);
  }

  // The built-in Stratus persona serves every run that has no soul.
  const builtInPersona = personaSnippet(DEFAULT_STRATUS_AGENT.instructions);
  listings.push({
    id: DEFAULT_STRATUS_AGENT.id,
    name: DEFAULT_STRATUS_AGENT.name,
    isDefault: resolvedDefaultSoul === undefined,
    builtIn: true,
    runsOn: runsOnFor(),
    memories: (await memory.list(DEFAULT_STRATUS_AGENT.id)).length,
    ...(builtInPersona ? { persona: builtInPersona } : {}),
  });

  listings.sort((a, b) => {
    if (a.isDefault !== b.isDefault) {
      return a.isDefault ? -1 : 1;
    }
    if (a.builtIn !== b.builtIn) {
      return a.builtIn ? 1 : -1;
    }
    return a.name.localeCompare(b.name);
  });

  if (command.format === 'json') {
    writeLine(streams.stdout, JSON.stringify({
      agents: listings.map(({ isDefault, ...rest }) => ({ ...rest, default: isDefault })),
    }, null, 2));
    return 0;
  }

  const describeRunsOn = (runsOn: { provider: string; model?: string }): string =>
    (runsOn.provider === 'demo' ? 'demo (offline)' : `${runsOn.provider}${runsOn.model ? ` · ${runsOn.model}` : ''}`);

  writeLine(streams.stdout, 'Agents');
  for (const agent of listings) {
    const labels = [
      ...(agent.isDefault ? ['default'] : []),
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
      writeLine(streams.stdout, `    avatar    ${agent.avatar}`);
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
  // Which of the three named it, not just that one did: telling someone to
  // fix STRATUS_CONFIG when STRATUSCLAW_CONFIG is what is set leaves the
  // real override in place — the same mistake as provider and key
  // attribution, in the one place a typo is most likely.
  const explicitSource = command.configPath !== undefined
    ? { name: '--config', value: command.configPath }
    : readNonEmptyString(processEnv.STRATUS_CONFIG)
      ? { name: 'STRATUS_CONFIG', value: String(processEnv.STRATUS_CONFIG) }
      : readNonEmptyString(processEnv.STRATUSCLAW_CONFIG)
        ? { name: 'STRATUSCLAW_CONFIG', value: String(processEnv.STRATUSCLAW_CONFIG) }
        : undefined;
  const explicit = explicitSource?.value;
  const candidates = explicitSource
    ? [{ path: path.resolve(cwd, explicitSource.value), label: explicitSource.name }]
    : [
        { path: path.join(cwd, DEFAULT_CONFIG_FILENAME), label: 'project' },
        { path: path.join(cwd, LEGACY_CONFIG_FILENAME), label: 'project (legacy)' },
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
  // leaving the real override in place. The legacy STRATUSCLAW_ prefix is
  // still honored by the resolver, so it has to be reportable too.
  const envPick = (...names: string[]): { name: string; value: string } | undefined => {
    for (const name of names) {
      const value = readNonEmptyString(processEnv[name]);
      if (typeof value === 'string') {
        return { name, value };
      }
    }
    return undefined;
  };

  /**
   * The verdict comes from the resolver, not from a second copy of its
   * rules. Everything below only *attributes* values to the file or
   * variable that supplied them — which the resolver does not report —
   * while whether a run works at all, and what it bills, is whatever
   * resolveRuntimeConfig actually returns or throws.
   */
  const envSoul = envPick('STRATUS_SOUL', 'STRATUSCLAW_SOUL');
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

  const envProviderPick = envPick('STRATUS_PROVIDER', 'STRATUSCLAW_PROVIDER');
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
    const envModel = envPick('STRATUS_MODEL', 'STRATUSCLAW_MODEL');
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

  for (const target of ['anthropic', 'openai'] as const) {
    const stored = credentials[target];
    const label = stored?.type === 'oauth_token' ? 'Claude subscription (Pro/Max)' : 'API key';
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

    const envVar = isDefault ? usedKeyEnvVar : (target === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY');
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
  const rosterIds = new Set((await loadRosterSouls(env, warn)).map((entry) => entry.soul.agent.id));
  rosterIds.add(DEFAULT_STRATUS_AGENT.id);
  if (soul) {
    rosterIds.add(soul.agent.id);
  }
  const orphans = slackAgents.filter((id) => !rosterIds.has(id));
  if (orphans.length > 0) {
    problems.push(
      `Slack tokens are stored for ${orphans.join(', ')}, which no agent matches — \`stratus serve\` skips them. `
      + 'Clear them from `stratus setup` → Channels.',
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
});

/**
 * A credential that exists only in this shell cannot reach the daemon: a
 * service manager starts with its own environment and never sources a
 * profile, so the unit would come up unauthenticated while setup had just
 * reported everything ready. Returns the variable to name, if so.
 */
/**
 * Every runtime the daemon would resolve: the config-wide default plus one
 * per roster soul, normalized the way a dispatch normalizes it. A soul that
 * pins its own provider resolves to different credentials entirely, so any
 * check that looks only at the default misses exactly the agent that is
 * misconfigured.
 */
const servedRuntimes = async (
  env: CliEnvironment,
  configPath?: string,
): Promise<Array<{ runtime: RuntimeConfig; env: CliEnvironment }>> => {
  const { applySoulPins } = await import('@stratusagent/gateway');
  const { config: activeConfig, location } = await discoverActiveConfig(env, () => {});
  const context = {
    ...(activeConfig.provider !== undefined ? { configProvider: activeConfig.provider } : {}),
    configPresent: location !== undefined,
  };
  const passes: Array<{ selection: RuntimeSelection; env: CliEnvironment }> = [{ selection: {}, env }];
  for (const entry of await loadRosterSouls(env, () => {})) {
    const normalized = applySoulPins(entry.soul, {}, env, context);
    passes.push({ selection: normalized.selection, env: normalized.env as CliEnvironment });
  }

  const resolved: Array<{ runtime: RuntimeConfig; env: CliEnvironment }> = [];
  for (const pass of passes) {
    // A runtime that cannot resolve is the gateway's to report, per
    // dispatch and with far better context than a startup pass has.
    const runtime = await resolveStateRuntimeConfig(
      { ...pass.selection, ...(configPath ? { configPath } : {}) },
      pass.env,
    ).catch(() => undefined);
    if (runtime) {
      resolved.push({ runtime, env: pass.env });
    }
  }
  return resolved;
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
    writeLine(streams.stdout, `stratusd  ${status.running ? 'running' : status.installed ? 'installed, not running' : 'not installed'}`);
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
    return status.running ? 0 : 1;
  }

  // A service manager passes none of this shell's environment on, so a
  // config selected by STRATUS_CONFIG has to be baked into the unit
  // exactly as --config is. Without it the daemon rediscovers from the
  // install directory and can come up on a different roster entirely.
  const processEnv = readProcessEnv(env);
  const selectedConfig = command.configPath
    ?? readNonEmptyString(processEnv.STRATUS_CONFIG)
    ?? readNonEmptyString(processEnv.STRATUSCLAW_CONFIG);
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
      let agent = defineAgent({ name, instructions: persona });

      // Frontmatter pins what a run from this directory would actually use:
      // env vars outrank the active config file (project-local or explicit
      // first, global otherwise), and no provider anywhere falls back to
      // demo — the exact precedence of stratus run. Demo produces no pin
      // at all: the soul keeps following the machine's configuration
      // instead of demanding credentials nothing has signed in for.
      const processEnv = readProcessEnv(env);
      // Creating an agent must not be blocked by a broken config — it only
      // feeds the soul's provider/model hint, so fall back to defaults.
      const { location: configLocation, config: activeConfig } = await discoverActiveConfig(env, (message) => {
        writeLine(streams.stdout, `Note: ${message}.`);
      });
      const soulProvider = readNonEmptyString(processEnv.STRATUS_PROVIDER, (value) => parseProviderName(value, 'STRATUS_PROVIDER'))
        ?? readNonEmptyString(processEnv.STRATUSCLAW_PROVIDER, (value) => parseProviderName(value, 'STRATUSCLAW_PROVIDER'))
        ?? activeConfig.provider
        ?? 'demo';
      // The active config's model was written for the provider named in
      // that config; it only travels into the soul when they still match.
      const configModelApplies = (activeConfig.provider ?? 'openai') === soulProvider;
      const soulModel = readNonEmptyString(processEnv.STRATUS_MODEL)
        ?? readNonEmptyString(processEnv.STRATUSCLAW_MODEL)
        ?? (configModelApplies ? activeConfig.model : undefined)
        ?? (soulProvider === 'openai' ? DEFAULT_OPENAI_MODEL : DEFAULT_ANTHROPIC_MODEL);
      const soulPin = soulProvider !== 'demo' ? { provider: soulProvider, model: soulModel } : {};

      // The name stays theirs, but the id — the soul filename and the
      // memory key — must be unique: the suggestion pool is small, so a
      // repeat name would otherwise silently overwrite an earlier agent's
      // soul and share their memory. 'wx' makes each claim atomic; on a
      // collision the id gets a fresh suffix and we try again.
      await mkdir(agentsDirPath(env), { recursive: true });
      const baseId = agent.id;
      let soulPath = path.join(agentsDirPath(env), `${agent.id}.md`);
      for (;;) {
        try {
          await writeFile(soulPath, formatSoul({ agent, ...soulPin }), { flag: 'wx' });
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw error;
          }
          agent = defineAgent({ id: `${baseId}-${randomUUID().slice(0, 4)}`, name, instructions: persona });
          soulPath = path.join(agentsDirPath(env), `${agent.id}.md`);
        }
      }

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
          const config: Record<string, unknown> = { ...globalConfig, provider: globalConfig.provider ?? soulProvider, soul: soulPath };
          await mkdir(path.dirname(globalConfigPath(env)), { recursive: true });
          await writeFile(globalConfigPath(env), `${JSON.stringify(config, null, 2)}\n`);
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

export const runDashboard = async (
  command: ParsedDashboardCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  const handle = await startDashboardServer({
    host: command.host,
    ...(command.port !== undefined ? { port: command.port } : {}),
  });

  writeLine(streams.stdout, `${DASHBOARD_TITLE} ready at ${handle.url}`);
  writeLine(streams.stdout, 'Press Ctrl+C to stop.');

  if (command.openBrowser) {
    try {
      await (env.openExternal ?? openExternalUrl)(handle.url);
      writeLine(streams.stdout, 'Opened your default browser.');
    } catch (error) {
      writeLine(streams.stderr, `Warning: Could not open the browser automatically: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (env.dashboardAutoShutdownMs !== undefined) {
    await new Promise((resolve) => setTimeout(resolve, env.dashboardAutoShutdownMs));
    await handle.close();
    return 0;
  }

  await once(process, 'SIGINT');
  await handle.close();
  return 0;
};

type SlackAdapterFactory = typeof import('@stratusagent/channel-slack').createSlackChannelAdapter;

/**
 * Loads the optional Slack channel package, or undefined when it is not
 * installed. Only that package being absent is tolerated: an adapter that
 * fails to load for any other reason (a broken install, a bad transitive
 * dependency) surfaces rather than silently disabling Slack for a daemon
 * whose stored tokens say it should be running.
 */
const loadSlackAdapter = async (): Promise<SlackAdapterFactory | undefined> => {
  // Resolution and loading are separate questions, and only the first one
  // means "not installed". Inspecting the import's error message cannot
  // tell them apart: a package that IS installed but is missing one of
  // its own dependencies throws ERR_MODULE_NOT_FOUND naming that
  // dependency and this package as the importer — a broken install would
  // read as an absent one, silently disabling a channel whose tokens say
  // it should be running.
  try {
    import.meta.resolve('@stratusagent/channel-slack');
  } catch {
    return undefined;
  }
  // Resolvable: any failure from here is a real problem with the
  // installed package, and surfaces.
  return (await import('@stratusagent/channel-slack')).createSlackChannelAdapter;
};

/**
 * `stratus serve` — run the gateway (stratusd) in the foreground: load the
 * roster, accept dispatches, print events, and drain cleanly on SIGTERM,
 * SIGINT, or the injected shutdown signal.
 */
export const runServe = async (
  command: ParsedServeCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  // Loaded lazily: the gateway pulls in node:sqlite, which every other CLI
  // command neither needs nor should pay for (Node still prints an
  // experimental warning for it).
  const { createGateway } = await import('@stratusagent/gateway');
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
  // The manager's redirect files are bounded on their own clock, not only
  // when the structured log rotates: a daemon crash-looping at startup
  // writes launchd diagnostics without ever producing enough records to
  // trigger a rotation. Once now — which covers each restart of a loop —
  // and periodically for a long-running daemon that warns without
  // rotating. Unref'd, so it never holds the process open.
  let redirectTimer: NodeJS.Timeout | undefined;
  if (logWriter) {
    void truncateRedirectLogs(logsDirPath(env));
    redirectTimer = setInterval(() => void truncateRedirectLogs(logsDirPath(env)), 5 * 60_000);
    redirectTimer.unref?.();
  }
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
  const channelCredentials = await loadChannelCredentials(env);
  const slackAgents = Object.entries(channelCredentials.slack ?? {});
  const channels = [];
  if (slackAgents.length > 0) {
    // Channel packages are optional peers: the CLI never bundles a
    // transport nobody asked for (the Slack SDKs alone are ~9 MB). A
    // missing one degrades like a broken app does — the daemon serves
    // every other channel — with an actionable line instead of a
    // module-not-found stack.
    const adapter = await loadSlackAdapter();
    if (adapter) {
      channels.push(adapter({
        agents: slackAgents.map(([agentId, tokens]) => ({
          agentId,
          appToken: tokens.appToken,
          botToken: tokens.botToken,
        })),
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

  const gateway = createGateway({
    env,
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
  writeLine(streams.stdout, 'Press Ctrl+C to stop.');

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
      if (redirectTimer) {
        clearInterval(redirectTimer);
      }
      process.off('SIGTERM', shutdown);
      process.off('SIGINT', shutdown);
      resolve();
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    if (env.shutdownSignal?.aborted) {
      shutdown();
    } else {
      env.shutdownSignal?.addEventListener('abort', shutdown, { once: true });
    }
  });

  writeLine(streams.stdout, 'Stopping — draining in-flight turns.');
  await gateway.stop();
  return 0;
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

    if (command.command === 'agent-new') {
      return runAgentNew(command, streams, resolvedEnv);
    }

    if (command.command === 'agents') {
      return runAgents(command, streams, resolvedEnv);
    }

    if (command.command === 'doctor') {
      return runDoctor(command, streams, resolvedEnv);
    }

    if (command.command === 'logs') {
      return runLogs(command, streams, resolvedEnv);
    }

    if (command.command === 'service') {
      return runService(command, streams, resolvedEnv);
    }

    if (command.command === 'chat') {
      return runChat(command, streams, resolvedEnv);
    }

    if (command.command === 'setup') {
      return runSetup(command, streams, resolvedEnv);
    }

    if (command.command === 'dashboard') {
      return runDashboard(command, streams, resolvedEnv);
    }

    if (command.command === 'serve') {
      return runServe(command, streams, resolvedEnv);
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
