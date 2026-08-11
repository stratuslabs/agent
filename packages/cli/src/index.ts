import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFile, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
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
  createRememberTool,
  defineAgent,
  formatSoul,
  parseSoul,
  type ParsedSoul,
} from '@stratusagent/agents';

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
}

export interface CliRunOptions {
  argv: string[];
  streams?: CliStreams;
  env?: CliEnvironment;
}

export type CliProviderName = 'demo' | 'openai' | 'anthropic';
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

export interface ParsedHelpCommand {
  command: 'help';
}

export type ParsedCommand =
  | ParsedRunCommand
  | ParsedDashboardCommand
  | ParsedSetupCommand
  | ParsedAgentNewCommand
  | ParsedHelpCommand;

interface CliConfigFile {
  provider?: CliProviderName;
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  systemPrompt?: string;
  /** Path to a soul file, resolved relative to the working directory. */
  soul?: string;
  /** Model to retry with when the default model errors mid-run. */
  fallbackModel?: string;
  /** Provider serving the fallback model. Defaults to the main provider. */
  fallbackProvider?: CliProviderName;
}

/** A resolved, ready-to-run fallback model (always a real provider). */
interface FallbackRuntime {
  provider: 'anthropic' | 'openai';
  model: string;
  baseUrl?: string;
  apiKey?: string;
  authToken?: string;
}

type RuntimeConfig =
  | { provider: 'demo'; soul?: ParsedSoul }
  | {
      provider: 'openai';
      model: string;
      baseUrl: string;
      apiKey: string;
      systemPrompt?: string;
      fetch?: typeof fetch;
      soul?: ParsedSoul;
      fallback?: FallbackRuntime;
    }
  | {
      provider: 'anthropic';
      model: string;
      baseUrl?: string;
      apiKey?: string;
      /** Claude subscription auth (Claude Code setup token). */
      authToken?: string;
      systemPrompt?: string;
      fetch?: typeof fetch;
      soul?: ParsedSoul;
      fallback?: FallbackRuntime;
    };

/** A stored sign-in for a provider, kept in ~/.stratus/credentials.json. */
export interface StoredCredential {
  type: 'api_key' | 'oauth_token';
  value: string;
}

type CredentialProviderName = 'anthropic' | 'openai';
type CredentialsFile = Partial<Record<CredentialProviderName, StoredCredential>>;

export interface DashboardServerHandle {
  url: string;
  close: () => Promise<void>;
}

const DEFAULT_CONFIG_FILENAME = 'stratus.config.json';
const LEGACY_CONFIG_FILENAME = 'stratusclaw.config.json';
const STRATUS_HOME_DIRNAME = '.stratus';
const GLOBAL_CONFIG_FILENAME = 'config.json';
const CREDENTIALS_FILENAME = 'credentials.json';
const AGENTS_DIRNAME = 'agents';
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini';
const DEFAULT_DASHBOARD_HOST = '127.0.0.1';
const DASHBOARD_TITLE = 'Stratus Agent Dashboard';

const HELP_TEXT = `Stratus Agent CLI

Usage:
  stratus setup
  stratus run --prompt "Use the demo tool"
  stratus run "Say hello"
  ANTHROPIC_API_KEY=... stratus run --provider anthropic "Say hello"
  stratus run --soul ./examples/souls/ava.md "Say hello"
  echo "Use the echo tool" | stratus run --stdin
  STRATUS_PROVIDER=openai OPENAI_API_KEY=... stratus run "Say hello"
  stratus run --config ./stratus.config.json --provider openai "Say hello"
  stratus dashboard
  stratus dashboard --port 4123 --host 0.0.0.0 --no-open

Commands:
  setup            Menu-driven onboarding: pick a provider, sign in (Claude
                   subscription or API key), create your agent, and test it —
                   settings go to ~/.stratus/config.json, sign-ins to
                   ~/.stratus/credentials.json (0600)
  run              Execute one local Stratus Agent session
  agent new        Create an agent identity (generates a human-ish name + avatar theme)
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

const createDemoTool = () =>
  defineLocalCommandTool({
    name: 'demo.echo',
    description: 'Return a tiny transformed summary for CLI demos through a real local process.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to echo back through the local process.' },
      },
      required: ['text'],
    },
    async createCommand(input) {
      const text = typeof input.text === 'string' ? input.text : '';
      const normalized = text.trim() || 'empty input';
      const script = `const text = ${JSON.stringify(normalized)}; console.log(JSON.stringify({ received: text, uppercase: text.toUpperCase(), length: text.length }));`;

      return {
        command: process.execPath,
        args: ['-e', script],
      };
    },
    parseResult(result) {
      return JSON.parse(result.stdout) as JsonValue;
    },
  });

const createDemoProvider = (): ModelProvider =>
  defineProvider({
    name: 'demo',
    async generate({ session }) {
      const builder = createProviderResponseBuilder();
      const lastMessage = session.messages.at(-1);

      if (lastMessage?.role === 'tool') {
        const result = lastMessage.toolResult;
        if (result?.ok) {
          builder.addText(`The demo.echo tool finished with: ${JSON.stringify(result.output)}`);
        } else {
          builder.addText(`The demo.echo tool did not run (${result?.error ?? 'unknown error'}), so this run ends here.`);
        }
        return builder.done();
      }

      const prompt = [...session.messages].reverse().find((message) => message.role === 'user')?.content?.trim() ?? '';
      const wantsTool = /\b(tool|echo|uppercase|inspect)\b/i.test(prompt);

      builder.addText(`Demo provider ready. Prompt received: ${prompt || '(empty)'}`);

      if (wantsTool) {
        builder.addToolCall({
          id: `${session.id}:call:demo-echo`,
          toolName: 'demo.echo',
          input: { text: prompt },
        });
      } else {
        builder.addText('No tool call was needed, so this run stays text-only. Mention “tool” or “echo” to trigger the demo tool.');
      }

      return builder.done();
    },
  });

const MEMORY_FILE_RELATIVE_PATH = path.join('.stratus', 'memory.jsonl');

// Agents keep the same memory across CLI runs: every remembered fact lands
// in .stratus/memory.jsonl (keyed by agent id), so the Ava you talk to
// tomorrow is the Ava you talked to today. One JSON entry per line, written
// with O_APPEND: concurrent runs each add their own line instead of
// re-writing the file, so no run can clobber another's remembered fact.
export const createFileMemoryStore = (filePath: string): AgentMemoryStore => {
  const readEntries = async (): Promise<MemoryEntry[]> => {
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as MemoryEntry;
        } catch {
          throw new Error(`Memory file has an invalid line: ${filePath}`);
        }
      });
  };

  return {
    async append(agentId: string, content: string, metadata?: JsonObject) {
      const entry: MemoryEntry = {
        id: `${agentId}:memory:${randomUUID()}`,
        agentId,
        content,
        createdAt: new Date().toISOString(),
        ...(metadata ? { metadata } : {}),
      };
      await mkdir(path.dirname(filePath), { recursive: true });
      await appendFile(filePath, `${JSON.stringify(entry)}\n`);
      return entry;
    },
    async list(agentId: string) {
      const entries = await readEntries();
      return entries.filter((entry) => entry.agentId === agentId);
    },
  };
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

const parseProviderName = (value: string, label: string): CliProviderName => {
  if (value === 'demo' || value === 'openai' || value === 'anthropic') {
    return value;
  }

  throw new Error(`Unsupported provider in ${label}: ${value}`);
};

const readProcessEnv = (env: CliEnvironment): NodeJS.ProcessEnv => env.processEnv ?? process.env;
const readWorkingDirectory = (env: CliEnvironment): string => env.cwd ?? process.cwd();
const readHomeDirectory = (env: CliEnvironment): string => env.homeDir ?? os.homedir();

const stratusHomePath = (env: CliEnvironment): string =>
  path.join(readHomeDirectory(env), STRATUS_HOME_DIRNAME);
const globalConfigPath = (env: CliEnvironment): string =>
  path.join(stratusHomePath(env), GLOBAL_CONFIG_FILENAME);
const credentialsPath = (env: CliEnvironment): string =>
  path.join(stratusHomePath(env), CREDENTIALS_FILENAME);
const agentsDirPath = (env: CliEnvironment): string =>
  path.join(stratusHomePath(env), AGENTS_DIRNAME);

const loadCredentials = async (env: CliEnvironment): Promise<CredentialsFile> => {
  let raw: string;
  try {
    raw = await readFile(credentialsPath(env), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }

  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Credentials file must contain a JSON object: ${credentialsPath(env)}`);
  }

  const credentials: CredentialsFile = {};
  for (const provider of ['anthropic', 'openai'] as const) {
    const entry = (parsed as Record<string, unknown>)[provider];
    if (
      typeof entry === 'object' && entry !== null && !Array.isArray(entry) &&
      ((entry as StoredCredential).type === 'api_key' || (entry as StoredCredential).type === 'oauth_token') &&
      typeof (entry as StoredCredential).value === 'string'
    ) {
      credentials[provider] = entry as StoredCredential;
    }
  }
  return credentials;
};

// Credentials never live in a project directory or a shell profile — they
// are written once by `stratus setup` and read on every run, 0600 so only
// the owner can read them.
const saveCredentials = async (env: CliEnvironment, credentials: CredentialsFile): Promise<void> => {
  const filePath = credentialsPath(env);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  await chmod(filePath, 0o600);
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

  if (command === 'agent') {
    const [subcommand, ...agentRest] = rest;
    if (subcommand === '--help' || subcommand === '-h') {
      return { command: 'help' };
    }
    if (subcommand !== 'new') {
      throw new Error(`Unknown agent subcommand: ${subcommand ?? '(missing)'}. Try: stratus agent new`);
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

const loadConfigFile = async (configPath: string): Promise<CliConfigFile> => {
  const raw = await readFile(configPath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Config file must contain a JSON object: ${configPath}`);
  }

  const config = parsed as Record<string, unknown>;
  const resolved: CliConfigFile = {};

  if (typeof config.provider === 'string') {
    resolved.provider = parseProviderName(config.provider, `config ${configPath}`);
  }
  if (typeof config.model === 'string' && config.model.length > 0) {
    resolved.model = config.model;
  }
  if (typeof config.baseUrl === 'string' && config.baseUrl.length > 0) {
    resolved.baseUrl = config.baseUrl;
  }
  if (typeof config.apiKeyEnv === 'string' && config.apiKeyEnv.length > 0) {
    resolved.apiKeyEnv = config.apiKeyEnv;
  }
  if (typeof config.systemPrompt === 'string' && config.systemPrompt.length > 0) {
    resolved.systemPrompt = config.systemPrompt;
  }
  if (typeof config.soul === 'string' && config.soul.length > 0) {
    resolved.soul = config.soul;
  }
  if (typeof config.fallbackModel === 'string' && config.fallbackModel.length > 0) {
    resolved.fallbackModel = config.fallbackModel;
  }
  if (typeof config.fallbackProvider === 'string') {
    resolved.fallbackProvider = parseProviderName(config.fallbackProvider, `config ${configPath}`);
  }

  return resolved;
};

const resolveConfigPath = async (
  command: ParsedRunCommand,
  env: CliEnvironment,
): Promise<string | undefined> => {
  const processEnv = readProcessEnv(env);
  const cwd = readWorkingDirectory(env);
  const explicit = command.configPath ?? processEnv.STRATUS_CONFIG ?? processEnv.STRATUSCLAW_CONFIG;

  if (explicit) {
    return path.resolve(cwd, explicit);
  }

  // Project-local configs win; the global ~/.stratus/config.json written by
  // `stratus setup` is the fallback that makes the CLI work from anywhere.
  const candidates = [
    path.join(cwd, DEFAULT_CONFIG_FILENAME),
    path.join(cwd, LEGACY_CONFIG_FILENAME),
    globalConfigPath(env),
  ];
  for (const candidatePath of candidates) {
    try {
      await readFile(candidatePath, 'utf8');
      return candidatePath;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw error;
      }
    }
  }

  return undefined;
};

const readNonEmptyString = <T = string>(
  value: string | undefined,
  map?: (resolved: string) => T,
): T | string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  return map ? map(trimmed) : trimmed;
};

// A soul travels with the run: --soul outranks STRATUS_SOUL, which outranks
// the config file's "soul" key.
const resolveSoul = async (
  command: ParsedRunCommand,
  env: CliEnvironment,
  fileConfig: CliConfigFile,
): Promise<ParsedSoul | undefined> => {
  const processEnv = readProcessEnv(env);
  const soulPath = command.soul
    ?? readNonEmptyString(processEnv.STRATUS_SOUL)
    ?? readNonEmptyString(processEnv.STRATUSCLAW_SOUL)
    ?? fileConfig.soul;

  if (!soulPath) {
    return undefined;
  }

  const resolvedPath = path.resolve(readWorkingDirectory(env), String(soulPath));
  let raw: string;
  try {
    raw = await readFile(resolvedPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Soul file not found: ${resolvedPath}`);
    }
    throw error;
  }

  try {
    // Seeding with the resolved path keeps an unnamed soul's generated
    // identity (name, id, avatar) stable across runs — persisted memory is
    // keyed by that id, so it must not change between invocations.
    return parseSoul(raw, { seed: resolvedPath });
  } catch (error) {
    throw new Error(
      `Could not parse soul file ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export const resolveRuntimeConfig = async (
  command: ParsedRunCommand,
  env: CliEnvironment = {},
): Promise<RuntimeConfig> => {
  const processEnv = readProcessEnv(env);
  const configPath = await resolveConfigPath(command, env);
  const fileConfig = configPath ? await loadConfigFile(configPath) : {};
  const soul = await resolveSoul(command, env, fileConfig);

  // Explicit flags and env vars outrank the soul's own provider/model hints,
  // which outrank the config file's defaults.
  const provider = command.provider
    ?? readNonEmptyString(processEnv.STRATUS_PROVIDER, (value) => parseProviderName(value, 'STRATUS_PROVIDER'))
    ?? readNonEmptyString(processEnv.STRATUSCLAW_PROVIDER, (value) => parseProviderName(value, 'STRATUSCLAW_PROVIDER'))
    ?? readNonEmptyString(soul?.provider, (value) => parseProviderName(value, 'soul file'))
    ?? fileConfig.provider
    ?? 'demo';

  if (provider === 'demo') {
    return { provider: 'demo', ...(soul ? { soul } : {}) };
  }

  // A config file's model/baseUrl/apiKeyEnv were written for the provider
  // named in that file. When a flag, env var, or soul selects a different
  // provider, those values would point at the wrong API (e.g. an OpenAI
  // base URL handed to the Anthropic SDK), so they are ignored. A file with
  // no provider key predates the anthropic option, so its settings are
  // treated as openai-specific.
  const fileConfigApplies = (fileConfig.provider ?? 'openai') === provider;

  // A soul's model was chosen for the soul's own provider. If a flag or env
  // var overrides that provider, the model hint would target the wrong API
  // (e.g. a Claude model sent to OpenAI), so it only applies when the soul
  // names no provider or names the selected one.
  const soulModelApplies = soul?.provider === undefined || soul.provider === provider;

  const model = command.model
    ?? readNonEmptyString(processEnv.STRATUS_MODEL)
    ?? readNonEmptyString(processEnv.STRATUSCLAW_MODEL)
    ?? (soulModelApplies ? readNonEmptyString(soul?.model) : undefined)
    ?? (fileConfigApplies ? fileConfig.model : undefined)
    ?? (provider === 'anthropic' ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_OPENAI_MODEL);

  const baseUrl = command.baseUrl
    ?? readNonEmptyString(processEnv.STRATUS_BASE_URL)
    ?? readNonEmptyString(processEnv.STRATUSCLAW_BASE_URL)
    ?? (fileConfigApplies ? fileConfig.baseUrl : undefined)
    // The Anthropic SDK knows its own endpoint; only openai needs a default.
    ?? (provider === 'anthropic' ? undefined : DEFAULT_OPENAI_BASE_URL);

  const apiKeyEnvName = readNonEmptyString(processEnv.STRATUS_API_KEY_ENV)
    ?? readNonEmptyString(processEnv.STRATUSCLAW_API_KEY_ENV)
    ?? (fileConfigApplies ? fileConfig.apiKeyEnv : undefined)
    ?? (provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY');

  const credentials = await loadCredentials(env);

  // Env vars outrank the stored sign-in from `stratus setup`.
  const envApiKey = readNonEmptyString(processEnv.STRATUS_API_KEY)
    ?? readNonEmptyString(processEnv.STRATUSCLAW_API_KEY)
    ?? readNonEmptyString(processEnv[String(apiKeyEnvName)]);
  const storedCredential = envApiKey
    ? undefined
    : credentials[provider as CredentialProviderName];

  const apiKey = envApiKey
    ?? (storedCredential?.type === 'api_key' ? storedCredential.value : undefined);
  const authToken = provider === 'anthropic' && storedCredential?.type === 'oauth_token'
    ? storedCredential.value
    : undefined;

  if (!apiKey && !authToken) {
    throw new Error(
      `Missing API key for provider=${provider}. Run \`stratus setup\` to sign in, or set STRATUS_API_KEY or ${apiKeyEnvName}.`,
    );
  }

  const resolved: RuntimeConfig = provider === 'anthropic'
    ? {
        provider: 'anthropic',
        model: String(model),
        ...(baseUrl ? { baseUrl: String(baseUrl) } : {}),
        ...(apiKey ? { apiKey: String(apiKey) } : {}),
        ...(authToken ? { authToken } : {}),
      }
    : {
        provider: 'openai',
        model: String(model),
        baseUrl: String(baseUrl),
        apiKey: String(apiKey),
      };

  const systemPrompt = readNonEmptyString(processEnv.STRATUS_SYSTEM_PROMPT)
    ?? readNonEmptyString(processEnv.STRATUSCLAW_SYSTEM_PROMPT)
    ?? fileConfig.systemPrompt;

  if (systemPrompt) {
    resolved.systemPrompt = String(systemPrompt);
  }

  if (env.fetch) {
    resolved.fetch = env.fetch;
  }

  if (soul) {
    resolved.soul = soul;
  }

  // A configured fallback model kicks in when the default model errors
  // mid-run. It needs its own working sign-in; without one the fallback is
  // quietly skipped rather than failing the run it exists to rescue.
  if (fileConfig.fallbackModel) {
    const fallbackProvider = fileConfig.fallbackProvider ?? (provider as CliProviderName);
    if (fallbackProvider !== 'demo') {
      const fallbackEnvKeyName = fallbackProvider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
      const fallbackCredential = credentials[fallbackProvider];
      const fallbackApiKey = (fallbackProvider === provider ? apiKey : undefined)
        ?? (fallbackCredential?.type === 'api_key' ? fallbackCredential.value : undefined)
        ?? readNonEmptyString(processEnv[fallbackEnvKeyName]);
      const fallbackAuthToken = fallbackProvider === 'anthropic' && fallbackCredential?.type === 'oauth_token'
        ? fallbackCredential.value
        : undefined;

      if (fallbackApiKey || fallbackAuthToken) {
        resolved.fallback = {
          provider: fallbackProvider,
          model: fileConfig.fallbackModel,
          ...(fallbackProvider === 'openai'
            ? { baseUrl: (fallbackProvider === provider ? String(baseUrl) : undefined) ?? DEFAULT_OPENAI_BASE_URL }
            : {}),
          ...(fallbackApiKey ? { apiKey: String(fallbackApiKey) } : {}),
          ...(fallbackAuthToken ? { authToken: fallbackAuthToken } : {}),
        };
      }
    }
  }

  return resolved;
};

// Wraps the fallback runtime as a provider: the primary model serves every
// turn until it throws, then the run switches to the fallback for good.
const createFallbackWrappedProvider = (
  primary: ModelProvider,
  fallback: ModelProvider,
  onFallback: (error: unknown) => void,
): ModelProvider => {
  let usingFallback = false;

  return {
    name: primary.name,
    async generate(request) {
      if (!usingFallback) {
        try {
          return await primary.generate(request);
        } catch (error) {
          usingFallback = true;
          onFallback(error);
        }
      }
      return fallback.generate(request);
    },
  };
};

const createRuntimeProvider = (
  config: RuntimeConfig,
  onFallback?: (error: unknown) => void,
): ModelProvider => {
  if (config.provider === 'demo') {
    return createDemoProvider();
  }

  if (config.fallback) {
    const { fallback, ...primaryConfig } = config;
    const primary = createRuntimeProvider(primaryConfig);
    const fallbackProvider = createRuntimeProvider({
      ...fallback,
      ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
      ...(config.fetch ? { fetch: config.fetch } : {}),
    } as RuntimeConfig);
    return createFallbackWrappedProvider(primary, fallbackProvider, onFallback ?? (() => {}));
  }

  if (config.provider === 'anthropic') {
    return createAnthropicProvider({
      model: config.model,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      ...(config.authToken ? { authToken: config.authToken } : {}),
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
      ...(config.fetch ? { fetch: config.fetch } : {}),
    });
  }

  return createOpenAICompatibleProvider({
    name: 'openai',
    model: config.model,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
    ...(config.fetch ? { fetch: config.fetch } : {}),
  });
};

const createApprovalPolicy = (
  mode: CliApprovalMode,
  streams: CliStreams,
  env: CliEnvironment,
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
  const memory = createFileMemoryStore(
    path.join(readWorkingDirectory(options.env ?? {}), MEMORY_FILE_RELATIVE_PATH),
  );

  const tools = new ToolRegistry();
  tools.register(createDemoTool());
  tools.register(createRememberTool(memory));

  const bus = new EventBus({
    onError: (error) => {
      writeLine(streams.stderr, `Warning: event handler failed: ${error instanceof Error ? error.message : String(error)}`);
    },
  });
  if (options.events ?? true) {
    bus.subscribe(async (event) => {
      const line = formatEvent(event);
      if (line) {
        writeLine(streams.stdout, line);
      }
    });
  }

  const runtimeProvider = createRuntimeProvider(options.runtime, (error) => {
    const fallback = options.runtime.provider === 'demo' ? undefined : options.runtime.fallback;
    writeLine(
      streams.stderr,
      `Warning: the default model failed (${error instanceof Error ? error.message : String(error)}); falling back to ${fallback?.model ?? 'the fallback model'}.`,
    );
  });

  const runner = new AgentRunner({
    provider: runtimeProvider,
    tools,
    executor: createLocalCommandExecutor(),
    approvals: createApprovalPolicy(options.approvals ?? 'always', streams, options.env ?? {}),
    bus,
    memory,
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
  });

  await runner.initialize();

  // A soul is a full identity — it replaces the built-in per-provider agent.
  const agent = options.runtime.soul?.agent
    ?? (options.runtime.provider === 'demo'
      ? {
          id: 'demo-agent',
          name: 'Demo Agent',
          instructions: 'Keep the loop tiny and readable.',
        }
      : options.runtime.provider === 'anthropic'
        ? {
            id: 'anthropic-agent',
            name: 'Claude Agent',
            instructions: 'Respond clearly and directly to the user request.',
          }
        : {
            id: 'openai-agent',
            name: 'OpenAI Agent',
            instructions: 'Respond clearly and directly to the user request.',
          });

  const metadata = options.runtime.provider === 'demo'
    ? { provider: 'demo' as const }
    : {
        provider: options.runtime.provider,
        model: options.runtime.model,
        ...(options.runtime.provider === 'openai' ? { baseUrl: options.runtime.baseUrl } : {}),
      };

  return runner.run({
    sessionId: randomUUID(),
    agent,
    userMessage: prompt,
    metadata: options.runtime.provider === 'demo'
      ? {
          ...metadata,
          executor: 'local-command',
        }
      : metadata,
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
        version: '0.2.0',
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

interface SetupPrompter {
  ask(question: string): Promise<string>;
  isClosed(): boolean;
  close(): void;
}

const createSetupPrompter = (streams: CliStreams, env: CliEnvironment): SetupPrompter => {
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

  return {
    async ask(question) {
      streams.stdout.write(question);

      while (pendingLines.length === 0) {
        if (closed) {
          return '';
        }
        await new Promise<void>((resolve) => {
          readline.once('line', () => resolve());
          readline.once('close', () => resolve());
        });
      }

      const answer = pendingLines.shift() ?? '';
      return answer.trim();
    },
    isClosed() {
      return closed && pendingLines.length === 0;
    },
    close() {
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
    return { status: 'rejected', detail: `HTTP ${response.status}` };
  } catch (error) {
    return { status: 'unreachable', detail: error instanceof Error ? error.message : String(error) };
  }
};

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
  baseUrl?: string;
  apiKeyEnv?: string;
  systemPrompt?: string;
  soulPath?: string;
  credentials: CredentialsFile;
  credentialsDirty: boolean;
}

// Shown when live model listing is unavailable (e.g. subscription tokens
// cannot call the models endpoint, or the machine is offline).
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

  const state: SetupState = {
    provider: existing.provider ?? 'anthropic',
    ...(existing.model ? { model: existing.model } : {}),
    ...(existing.baseUrl ? { baseUrl: existing.baseUrl } : {}),
    ...(existing.apiKeyEnv ? { apiKeyEnv: existing.apiKeyEnv } : {}),
    ...(existing.systemPrompt ? { systemPrompt: existing.systemPrompt } : {}),
    ...(existing.soul ? { soulPath: existing.soul } : {}),
    ...(existing.fallbackModel ? { fallbackModel: existing.fallbackModel } : {}),
    ...(existing.fallbackProvider ? { fallbackProvider: existing.fallbackProvider } : {}),
    credentials: await loadCredentials(env),
    credentialsDirty: false,
  };

  const prompter = createSetupPrompter(streams, env);

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

  const storeCredential = (provider: CredentialProviderName, credential: StoredCredential): void => {
    state.credentials[provider] = credential;
    state.credentialsDirty = true;
  };

  const signInAnthropic = async (): Promise<void> => {
    const signedIn = state.credentials.anthropic !== undefined;
    const answer = await prompter.ask(
      'How should Stratus connect to Claude?\n'
      + '  1) Claude subscription (Pro/Max) — sign in through Claude Code, no per-token cost\n'
      + '  2) Anthropic API key — pay per use (console.anthropic.com)\n'
      + '  3) Skip for now\n'
      + (signedIn ? '  4) Sign out\n' : '')
      + 'Choose [1]: ',
    );

    if (signedIn && (answer === '4' || /^sign ?out$/i.test(answer))) {
      delete state.credentials.anthropic;
      state.credentialsDirty = true;
      writeLine(streams.stdout, 'Signed out of Anthropic.');
      return;
    }

    if (answer === '3' || /^skip$/i.test(answer)) {
      return;
    }

    if (answer === '2' || /^(api|key)/i.test(answer)) {
      const key = await prompter.ask('Paste your Anthropic API key (starts with sk-ant-, Enter to skip): ');
      if (!key) {
        writeLine(streams.stdout, 'Skipped — you can sign in any time by re-running this menu.');
        return;
      }
      writeLine(streams.stdout, 'Checking the key against the Anthropic API…');
      const verdict = await verifyProviderKey('anthropic', key, undefined, env.fetch ?? globalThis.fetch);
      if (verdict.status === 'ok') {
        storeCredential('anthropic', { type: 'api_key', value: key });
        writeLine(streams.stdout, '✓ Key verified — you are signed in to Anthropic.');
      } else if (verdict.status === 'rejected') {
        writeLine(streams.stdout, `✗ Anthropic rejected that key (${verdict.detail}). It was NOT saved — check console.anthropic.com and try again from this menu.`);
      } else {
        storeCredential('anthropic', { type: 'api_key', value: key });
        writeLine(streams.stdout, `! Could not reach the Anthropic API to verify (${verdict.detail}). Saved the key anyway — it will be checked on your first run.`);
      }
      return;
    }

    // Default: subscription sign-in via Claude Code.
    writeLine(streams.stdout, 'Your Claude Pro/Max subscription covers usage made through Claude Code.');
    writeLine(streams.stdout, 'In another terminal on this machine, run:');
    writeLine(streams.stdout, '  claude setup-token');
    writeLine(streams.stdout, '(requires Claude Code installed and signed in to your Claude account)');
    const token = await prompter.ask('Paste the setup token it prints (starts with sk-ant-oat, Enter to skip): ');
    if (!token) {
      writeLine(streams.stdout, 'Skipped — you can sign in any time by re-running this menu.');
      return;
    }
    storeCredential('anthropic', { type: 'oauth_token', value: token });
    writeLine(streams.stdout, '✓ Subscription token saved. It is verified on your first run.');
  };

  const signInOpenAI = async (): Promise<void> => {
    const baseUrlAnswer = await prompter.ask(`API base URL [${state.baseUrl ?? DEFAULT_OPENAI_BASE_URL}]: `);
    if (baseUrlAnswer) {
      state.baseUrl = baseUrlAnswer;
    }
    const key = await prompter.ask('Paste your API key (Enter to skip): ');
    if (!key) {
      writeLine(streams.stdout, 'Skipped — you can sign in any time by re-running this menu.');
      return;
    }
    writeLine(streams.stdout, 'Checking the key…');
    const verdict = await verifyProviderKey('openai', key, state.baseUrl, env.fetch ?? globalThis.fetch);
    if (verdict.status === 'ok') {
      storeCredential('openai', { type: 'api_key', value: key });
      writeLine(streams.stdout, '✓ Key verified — you are signed in.');
    } else if (verdict.status === 'rejected') {
      writeLine(streams.stdout, `✗ The API rejected that key (${verdict.detail}). It was NOT saved — try again from this menu.`);
    } else {
      storeCredential('openai', { type: 'api_key', value: key });
      writeLine(streams.stdout, `! Could not reach the API to verify (${verdict.detail}). Saved the key anyway — it will be checked on your first run.`);
    }
  };

  // Signing in makes that provider the default only when the current
  // default cannot actually run (demo, or a provider with no sign-in).
  const maybeSwitchDefault = (provider: CredentialProviderName): void => {
    if (state.provider === 'demo') {
      state.provider = provider;
      return;
    }
    if (state.provider !== provider && !state.credentials[state.provider]
      && !readNonEmptyString(processEnv[defaultKeyEnvFor(state.provider)])) {
      state.provider = provider;
    }
  };

  const chooseProviders = async (): Promise<void> => {
    const answer = await prompter.ask(
      'Providers — sign in to one or more:\n'
      + `  1) Claude (Anthropic) — ${providerSignInStatus('anthropic')}\n`
      + `  2) OpenAI-compatible — ${providerSignInStatus('openai')}\n`
      + '  3) Demo — built-in fake model, offline, no account\n'
      + '  4) Back\n'
      + 'Choose [1]: ',
    );

    if (answer === '4' || /^back$/i.test(answer)) {
      return;
    }

    if (answer === '3' || /^demo$/i.test(answer)) {
      state.provider = 'demo';
      writeLine(streams.stdout, 'Demo selected — no sign-in needed. Mention "echo" or "tool" in a prompt to see tool calls.');
      return;
    }

    if (answer === '2' || /^openai$/i.test(answer)) {
      await signInOpenAI();
      if (state.credentials.openai) {
        maybeSwitchDefault('openai');
      }
      return;
    }

    await signInAnthropic();
    if (state.credentials.anthropic) {
      maybeSwitchDefault('anthropic');
    }
  };

  // Every model the current sign-ins can actually reach, fetched live where
  // possible. Subscription tokens cannot call the models endpoint, so those
  // fall back to the known Claude lineup.
  const collectAvailableModels = async (): Promise<Array<{ provider: CredentialProviderName; id: string }>> => {
    const fetchImpl = env.fetch ?? globalThis.fetch;
    const models: Array<{ provider: CredentialProviderName; id: string }> = [];

    for (const provider of ['anthropic', 'openai'] as const) {
      const credential = state.credentials[provider];
      const envKey = readNonEmptyString(processEnv[defaultKeyEnvFor(provider)]);
      if (!credential && !envKey) {
        continue;
      }

      if (provider === 'anthropic') {
        if (credential?.type === 'oauth_token' || typeof fetchImpl !== 'function') {
          models.push(...KNOWN_CLAUDE_MODELS.map((id) => ({ provider, id })));
          continue;
        }
        try {
          const response = await fetchImpl(`${DEFAULT_ANTHROPIC_BASE_URL}/v1/models?limit=100`, {
            headers: { 'x-api-key': String(credential?.value ?? envKey), 'anthropic-version': '2023-06-01' },
          });
          const payload = await response.json() as { data?: Array<{ id?: string }> };
          const ids = (payload.data ?? []).map((entry) => entry.id).filter((id): id is string => typeof id === 'string');
          models.push(...(ids.length > 0 ? ids : KNOWN_CLAUDE_MODELS).map((id) => ({ provider, id })));
        } catch {
          models.push(...KNOWN_CLAUDE_MODELS.map((id) => ({ provider, id })));
        }
        continue;
      }

      if (typeof fetchImpl !== 'function') {
        continue;
      }
      try {
        const root = (state.baseUrl ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');
        const response = await fetchImpl(`${root}/models`, {
          headers: { authorization: `Bearer ${String(credential?.value ?? envKey)}` },
        });
        const payload = await response.json() as { data?: Array<{ id?: string }> };
        const ids = (payload.data ?? [])
          .map((entry) => entry.id)
          .filter((id): id is string => typeof id === 'string')
          .sort();
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
    const lines = shown.map((entry, index) => `  ${index + 1}) ${entry.id} — ${entry.provider}`);
    if (available.length > shown.length) {
      lines.push(`  …and ${available.length - shown.length} more — type the model id instead.`);
    }
    const answer = await prompter.ask(
      `Available models:\n${lines.join('\n')}\nChoose a number, or type a model id [1]: `,
    );

    let choice: { provider: CredentialProviderName; id: string } | undefined;
    if (!answer) {
      choice = shown[0];
    } else if (/^\d+$/.test(answer)) {
      choice = shown[Number(answer) - 1];
      if (!choice) {
        writeLine(streams.stdout, `Pick a number between 1 and ${shown.length}.`);
        return;
      }
    } else if (answer.includes(':')) {
      const [providerPart, ...idParts] = answer.split(':');
      const id = idParts.join(':').trim();
      if ((providerPart === 'anthropic' || providerPart === 'openai') && id) {
        choice = { provider: providerPart, id };
      } else {
        writeLine(streams.stdout, 'Use provider:model, e.g. anthropic:claude-opus-5.');
        return;
      }
    } else {
      const inferred = state.provider !== 'demo' ? state.provider : available[0]!.provider;
      choice = { provider: inferred, id: answer };
    }

    if (!choice) {
      return;
    }

    if (kind === 'default') {
      state.provider = choice.provider;
      state.model = choice.id;
      writeLine(streams.stdout, `Default model set to ${choice.id} (${choice.provider}).`);
    } else {
      state.fallbackProvider = choice.provider;
      state.fallbackModel = choice.id;
      if (choice.id === (state.model ?? defaultModelFor(state.provider)) && choice.provider === state.provider) {
        writeLine(streams.stdout, 'Note: the fallback matches the default model, so it will not add resilience.');
      }
      writeLine(streams.stdout, `Fallback model set to ${choice.id} (${choice.provider}) — used when the default model errors mid-run.`);
    }
  };

  const chooseModels = async (): Promise<void> => {
    const answer = await prompter.ask(
      `Models — ${modelsSummary()}\n`
      + '  1) Choose the default model\n'
      + '  2) Choose a fallback model\n'
      + '  3) Clear the fallback\n'
      + '  4) Back\n'
      + 'Choose [1]: ',
    );

    if (answer === '2') {
      await pickModel('fallback');
      return;
    }
    if (answer === '3') {
      delete state.fallbackModel;
      delete state.fallbackProvider;
      writeLine(streams.stdout, 'Fallback cleared.');
      return;
    }
    if (answer === '4' || /^back$/i.test(answer)) {
      return;
    }
    await pickModel('default');
  };

  const chooseAgent = async (): Promise<void> => {
    const answer = await prompter.ask(
      'Your default agent:\n'
      + '  1) Create a new agent\n'
      + '  2) Use an existing soul file\n'
      + '  3) No default agent\n'
      + 'Choose [1]: ',
    );

    if (answer === '3' || /^none$/i.test(answer)) {
      delete state.soulPath;
      writeLine(streams.stdout, 'Cleared — runs use the built-in default agent.');
      return;
    }

    if (answer === '2') {
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

    const credential = state.credentials[state.provider];
    const keyEnv = state.apiKeyEnv ?? defaultKeyEnvFor(state.provider);
    const envKey = readNonEmptyString(processEnv.STRATUS_API_KEY) ?? readNonEmptyString(processEnv[keyEnv]);
    const model = state.model ?? defaultModelFor(state.provider);

    if (state.provider === 'anthropic') {
      const apiKey = credential?.type === 'api_key' ? credential.value : envKey;
      const authToken = credential?.type === 'oauth_token' ? credential.value : undefined;
      if (!apiKey && !authToken) {
        writeLine(streams.stdout, 'You are not signed in yet — pick option 1 first (or export ANTHROPIC_API_KEY).');
        return undefined;
      }
      return {
        provider: 'anthropic',
        model,
        ...(apiKey ? { apiKey } : {}),
        ...(authToken ? { authToken } : {}),
        ...(state.systemPrompt ? { systemPrompt: state.systemPrompt } : {}),
        ...(env.fetch ? { fetch: env.fetch } : {}),
        ...(soul ? { soul } : {}),
      };
    }

    const apiKey = credential?.type === 'api_key' ? credential.value : envKey;
    if (!apiKey) {
      writeLine(streams.stdout, 'You are not signed in yet — pick option 1 first (or export OPENAI_API_KEY).');
      return undefined;
    }
    return {
      provider: 'openai',
      model,
      baseUrl: state.baseUrl ?? DEFAULT_OPENAI_BASE_URL,
      apiKey,
      ...(state.systemPrompt ? { systemPrompt: state.systemPrompt } : {}),
      ...(env.fetch ? { fetch: env.fetch } : {}),
      ...(soul ? { soul } : {}),
    };
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
    } catch (error) {
      writeLine(streams.stdout, `Test run failed: ${error instanceof Error ? error.message : String(error)}`);
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
      config.baseUrl = state.baseUrl ?? DEFAULT_OPENAI_BASE_URL;
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
    }

    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    writeLine(streams.stdout);
    writeLine(streams.stdout, `Wrote ${configPath}`);
    if (state.credentialsDirty) {
      await saveCredentials(env, state.credentials);
      writeLine(streams.stdout, `Saved your sign-in to ${credentialsPath(env)} (readable only by you).`);
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
    writeLine(streams.stdout, `  stratus run${extraFlags}${runConfigFlag} "say hello"`);
    writeLine(streams.stdout, '  stratus dashboard');
  };

  try {
    writeLine(streams.stdout, 'Stratus Agent setup');
    writeLine(streams.stdout, 'Pick a provider, sign in, and create your agent — all from this menu.');
    if (envConfigVar && !command.configPath) {
      writeLine(streams.stdout, `${envConfigVar} is set, so the config will be written to ${configPath}.`);
    }

    while (true) {
      writeLine(streams.stdout);
      const choice = await prompter.ask(
        `  1) Providers            ${providersSummary()}\n`
        + `  2) Models               ${modelsSummary()}\n`
        + `  3) Agent                ${agentSummary()}\n`
        + '  4) Test run             say hello with the current settings\n'
        + '  5) Save & finish\n'
        + 'Choose [1-5]: ',
      );

      if (prompter.isClosed() && choice === '') {
        break;
      }

      if (choice === '1') {
        await chooseProviders();
      } else if (choice === '2') {
        await chooseModels();
      } else if (choice === '3') {
        await chooseAgent();
      } else if (choice === '4') {
        await testRun();
      } else if (choice === '5' || /^(save|done|finish|q(uit)?)$/i.test(choice)) {
        break;
      } else {
        writeLine(streams.stdout, 'Pick a number between 1 and 5.');
      }
    }

    await save();
    return 0;
  } finally {
    prompter.close();
  }
};

export const runAgentNew = (
  command: ParsedAgentNewCommand,
  streams: CliStreams,
): number => {
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
      return runAgentNew(command, streams);
    }

    if (command.command === 'setup') {
      return runSetup(command, streams, resolvedEnv);
    }

    if (command.command === 'dashboard') {
      return runDashboard(command, streams, resolvedEnv);
    }

    const runtime = await resolveRuntimeConfig(command, resolvedEnv);

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
