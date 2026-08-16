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
import { createClaudeCodeProvider } from '@stratusagent/provider-claude-code';
import {
  createRememberTool,
  defineAgent,
  formatSoul,
  generateAgentName,
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
  /** Base URL for an openai-compatible fallback (e.g. a local model). */
  fallbackBaseUrl?: string;
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
  /**
   * The endpoint this credential belongs to (openai-compatible services).
   * Kept with the credential so a key for a local model or proxy is never
   * sent to a different service, whatever the current default provider is.
   */
  baseUrl?: string;
}

type CredentialProviderName = 'anthropic' | 'openai';
type CredentialsFile = Partial<Record<CredentialProviderName, StoredCredential>>;

export interface DashboardServerHandle {
  url: string;
  close: () => Promise<void>;
}

export const CLI_VERSION = '0.2.2';

// The agent every run uses when no soul is configured. A Stratus agent is
// a Stratus agent — never "the model" — whichever provider serves it.
const DEFAULT_STRATUS_AGENT = {
  id: 'stratus',
  name: 'Stratus',
  instructions: 'You are Stratus, a personal agent on the Stratus Agent platform. Be warm, direct, and concise. When asked who or what you are, you are Stratus — a Stratus agent — regardless of which model is serving the conversation.',
};

// Unsouled runs used to remember facts under a per-provider default agent.
// Stratus inherits all of them: reads for the built-in agent also return
// entries stored under the legacy ids, while new facts land under 'stratus'.
const LEGACY_DEFAULT_AGENT_IDS = ['demo-agent', 'anthropic-agent', 'openai-agent'];

const withLegacyDefaultMemories = (store: AgentMemoryStore): AgentMemoryStore => ({
  append: (agentId, content, metadata) => store.append(agentId, content, metadata),
  async list(agentId) {
    if (agentId !== DEFAULT_STRATUS_AGENT.id) {
      return store.list(agentId);
    }
    const batches = await Promise.all(
      [DEFAULT_STRATUS_AGENT.id, ...LEGACY_DEFAULT_AGENT_IDS].map((id) => store.list(id)),
    );
    return batches.flat().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },
});

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

const MEMORY_FILENAME = 'memory.jsonl';
const memoryFilePath = (env: CliEnvironment): string =>
  path.join(stratusHomePath(env), MEMORY_FILENAME);

// Memory used to live under the working directory. Fold any such file into
// the global store the first time a run happens from that directory, then
// archive it — an upgrade must never look like the agent forgot.
//
// Every import first takes exclusive ownership by atomically renaming its
// source to a unique claim file: of any competing processes, exactly one
// wins the rename and the rest see ENOENT. A crash mid-import leaves the
// claim file behind; later runs re-claim it the same way and finish the
// job, with entries deduped against the global store by id. Only records
// that parse as real memory entries are imported — malformed lines stay in
// the archive instead of poisoning the global store for every agent.
const isMemoryEntryLine = (line: string): boolean => {
  try {
    const parsed = JSON.parse(line) as Partial<MemoryEntry> | null;
    return typeof parsed === 'object' && parsed !== null
      && typeof parsed.id === 'string'
      && typeof parsed.agentId === 'string'
      && typeof parsed.content === 'string';
  } catch {
    return false;
  }
};

const migrateLegacyMemory = async (env: CliEnvironment): Promise<void> => {
  const legacyPath = path.join(readWorkingDirectory(env), '.stratus', MEMORY_FILENAME);
  const globalPath = memoryFilePath(env);
  if (legacyPath === globalPath) {
    return;
  }
  const legacyDir = path.dirname(legacyPath);
  const archivePath = `${legacyPath}.migrated`;

  const claimAndImport = async (sourcePath: string): Promise<void> => {
    const claimPath = path.join(legacyDir, `${MEMORY_FILENAME}.migrating-${randomUUID()}`);
    try {
      await rename(sourcePath, claimPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return; // another process owns it, or there is nothing to migrate
      }
      throw error;
    }

    const claimed = await readFile(claimPath, 'utf8');

    let existingIds: Set<string>;
    try {
      existingIds = new Set(
        (await readFile(globalPath, 'utf8'))
          .split('\n')
          .filter(isMemoryEntryLine)
          .map((line) => (JSON.parse(line) as MemoryEntry).id),
      );
    } catch {
      existingIds = new Set();
    }

    const entries = claimed
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .filter(isMemoryEntryLine)
      .filter((line) => !existingIds.has((JSON.parse(line) as MemoryEntry).id));
    if (entries.length > 0) {
      await mkdir(path.dirname(globalPath), { recursive: true });
      await appendFile(globalPath, `${entries.join('\n')}\n`);
    }

    // Archive by appending (never overwriting an earlier archive), then
    // drop the claim — its content is fully preserved in the archive.
    if (claimed.length > 0) {
      await appendFile(archivePath, claimed.endsWith('\n') || claimed.length === 0 ? claimed : `${claimed}\n`);
    }
    await unlink(claimPath);
  };

  await claimAndImport(legacyPath);

  // Finish any claims a crashed run left behind (both the current unique
  // names and the fixed .migrating name from earlier versions).
  let leftovers: string[];
  try {
    leftovers = await readdir(legacyDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  for (const name of leftovers) {
    if (name.startsWith(`${MEMORY_FILENAME}.migrating`)) {
      await claimAndImport(path.join(legacyDir, name));
    }
  }
};

// Agents keep the same memory across CLI runs: every remembered fact lands
// in ~/.stratus/memory.jsonl (keyed by agent id), so the Ava you talk to
// tomorrow — from any directory — is the Ava you talked to today. One JSON
// entry per line, written with O_APPEND: concurrent runs each add their own
// line instead of re-writing the file, so no run can clobber another's
// remembered fact.
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
      // Dedupe by id at read time: even if a rare race double-imported a
      // fact, the agent only ever sees it once.
      const seen = new Set<string>();
      return (await readEntries()).filter((entry) => {
        if (entry.agentId !== agentId || seen.has(entry.id)) {
          return false;
        }
        seen.add(entry.id);
        return true;
      });
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
  if (typeof config.fallbackBaseUrl === 'string' && config.fallbackBaseUrl.length > 0) {
    resolved.fallbackBaseUrl = config.fallbackBaseUrl;
  }

  return resolved;
};

interface ResolvedConfigLocation {
  path: string;
  /**
   * Whether the config came from something the user chose themselves
   * (--config, STRATUS_CONFIG, or the global ~/.stratus/config.json written
   * by setup). Auto-discovered project-local files are untrusted: a cloned
   * repository can ship one, so stored credentials are never combined with
   * a custom endpoint it selects.
   */
  trusted: boolean;
}

const resolveConfigLocation = async (
  command: Pick<ParsedRunCommand, 'configPath'>,
  env: CliEnvironment,
): Promise<ResolvedConfigLocation | undefined> => {
  const processEnv = readProcessEnv(env);
  const cwd = readWorkingDirectory(env);
  const explicit = command.configPath ?? processEnv.STRATUS_CONFIG ?? processEnv.STRATUSCLAW_CONFIG;

  if (explicit) {
    return { path: path.resolve(cwd, explicit), trusted: true };
  }

  // Project-local configs win; the global ~/.stratus/config.json written by
  // `stratus setup` is the fallback that makes the CLI work from anywhere.
  const candidates: ResolvedConfigLocation[] = [
    { path: path.join(cwd, DEFAULT_CONFIG_FILENAME), trusted: false },
    { path: path.join(cwd, LEGACY_CONFIG_FILENAME), trusted: false },
    { path: globalConfigPath(env), trusted: true },
  ];
  for (const candidate of candidates) {
    try {
      await readFile(candidate.path, 'utf8');
      return candidate;
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
  const configLocation = await resolveConfigLocation(command, env);
  const fileConfig = configLocation ? await loadConfigFile(configLocation.path) : {};
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

  const apiKeyEnvName = readNonEmptyString(processEnv.STRATUS_API_KEY_ENV)
    ?? readNonEmptyString(processEnv.STRATUSCLAW_API_KEY_ENV)
    ?? (fileConfigApplies ? fileConfig.apiKeyEnv : undefined)
    ?? (provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY');

  const credentials = await loadCredentials(env);

  // A custom endpoint chosen by an auto-discovered project config is not a
  // place the stored sign-in ever gets sent — a cloned repository could
  // point it anywhere. Flags and env vars are the user's own choice, and
  // the provider's default endpoint is harmless.
  const defaultEndpointFor = (target: string): string =>
    target === 'anthropic' ? DEFAULT_ANTHROPIC_BASE_URL : DEFAULT_OPENAI_BASE_URL;
  const untrustedCustomBaseUrl = configLocation?.trusted === false
    && command.baseUrl === undefined
    && readNonEmptyString(processEnv.STRATUS_BASE_URL) === undefined
    && readNonEmptyString(processEnv.STRATUSCLAW_BASE_URL) === undefined
    && fileConfigApplies
    && fileConfig.baseUrl !== undefined
    && fileConfig.baseUrl.replace(/\/+$/, '') !== defaultEndpointFor(String(provider));

  // Env vars outrank the stored sign-in from `stratus setup`.
  const envApiKey = readNonEmptyString(processEnv.STRATUS_API_KEY)
    ?? readNonEmptyString(processEnv.STRATUSCLAW_API_KEY)
    ?? readNonEmptyString(processEnv[String(apiKeyEnvName)]);
  const candidateCredential = credentials[provider as CredentialProviderName];
  // A bound credential ignores config URLs entirely, so an untrusted
  // project URL cannot redirect it — only unbound stored keys are blocked.
  const credentialIsBound = candidateCredential?.type === 'api_key' && candidateCredential.baseUrl !== undefined;
  const storedCredential = envApiKey || (untrustedCustomBaseUrl && !credentialIsBound)
    ? undefined
    : candidateCredential;

  const apiKey = envApiKey
    ?? (storedCredential?.type === 'api_key' ? storedCredential.value : undefined);
  const authToken = provider === 'anthropic' && storedCredential?.type === 'oauth_token'
    ? storedCredential.value
    : undefined;

  // A stored key bound to an endpoint is used ONLY with that endpoint — a
  // config file can never redirect it, not even to the official default
  // URL (a project config could otherwise reroute a local-service key to
  // the official API). An explicit flag or env URL that disagrees refuses
  // the stored key instead of leaking it. This applies to both providers.
  const boundBaseUrl = !envApiKey && storedCredential?.type === 'api_key'
    ? storedCredential.baseUrl
    : undefined;
  const explicitBaseUrl = command.baseUrl
    ?? readNonEmptyString(processEnv.STRATUS_BASE_URL)
    ?? readNonEmptyString(processEnv.STRATUSCLAW_BASE_URL);
  if (boundBaseUrl && explicitBaseUrl
    && String(explicitBaseUrl).replace(/\/+$/, '') !== boundBaseUrl.replace(/\/+$/, '')) {
    throw new Error(
      `Your saved ${provider} sign-in is bound to ${boundBaseUrl} and is not sent to ${explicitBaseUrl}. Set ${apiKeyEnvName} or STRATUS_API_KEY to use that endpoint.`,
    );
  }

  const baseUrl = boundBaseUrl
    ?? explicitBaseUrl
    ?? (fileConfigApplies ? fileConfig.baseUrl : undefined)
    // The Anthropic SDK knows its own endpoint; only openai needs a default.
    ?? (provider === 'anthropic' ? undefined : DEFAULT_OPENAI_BASE_URL);

  if (!apiKey && !authToken) {
    if (untrustedCustomBaseUrl && credentials[provider as CredentialProviderName]) {
      throw new Error(
        `The project config at ${configLocation?.path} sets a custom base URL (${fileConfig.baseUrl}), so your saved sign-in is not sent to it. Set ${apiKeyEnvName} or STRATUS_API_KEY to use this endpoint, or run with --config to trust the file explicitly.`,
      );
    }
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
  // An implicit fallback (no fallbackProvider key) was written for the
  // config's own provider — when a flag, env var, or soul overrides that
  // provider, the fallback model would target the wrong API, so it is
  // ignored. An explicit fallbackProvider stays valid regardless.
  if (fileConfig.fallbackModel && (fileConfig.fallbackProvider !== undefined || fileConfigApplies)) {
    const fallbackProvider = fileConfig.fallbackProvider ?? (provider as CliProviderName);
    if (fallbackProvider !== 'demo') {
      // Same precedence as the primary sign-in: environment keys outrank
      // the stored credential. And the same endpoint rule: an untrusted
      // project config's custom fallback URL never receives a stored key —
      // including the primary's stored key when both share a provider.
      // Only env-supplied keys follow such a URL.
      const fallbackUntrustedUrl = fallbackProvider === 'openai'
        && configLocation?.trusted === false
        && fileConfig.fallbackBaseUrl !== undefined
        && fileConfig.fallbackBaseUrl.replace(/\/+$/, '') !== DEFAULT_OPENAI_BASE_URL;
      const fallbackEnvKey = readNonEmptyString(processEnv[fallbackProvider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY']);
      const fallbackCredential = fallbackEnvKey || fallbackUntrustedUrl ? undefined : credentials[fallbackProvider];
      const primaryReusable = fallbackProvider === provider
        && (envApiKey !== undefined || !fallbackUntrustedUrl);
      const fallbackApiKey = (primaryReusable ? apiKey : undefined)
        ?? fallbackEnvKey
        ?? (fallbackCredential?.type === 'api_key' ? fallbackCredential.value : undefined);
      const fallbackAuthToken = fallbackProvider !== provider && fallbackProvider === 'anthropic' && fallbackCredential?.type === 'oauth_token'
        ? fallbackCredential.value
        : (primaryReusable ? authToken : undefined);

      if (fallbackApiKey || fallbackAuthToken) {
        // When the fallback key comes out of the credential store (its own
        // entry, or the primary's reused stored key), its bound endpoint is
        // authoritative — config URLs cannot redirect it.
        const fallbackBoundUrl = fallbackCredential?.type === 'api_key'
          ? fallbackCredential.baseUrl
          : (primaryReusable && !envApiKey ? boundBaseUrl : undefined);
        // An anthropic fallback on the same provider keeps the primary's
        // configured endpoint — retrying the same credential against the
        // official endpoint instead of the configured service would leak
        // it and likely fail.
        const fallbackAnthropicBaseUrl = fallbackProvider === 'anthropic'
          ? (fallbackProvider === provider && baseUrl ? String(baseUrl) : undefined)
            ?? (fallbackCredential?.type === 'api_key' ? fallbackCredential.baseUrl : undefined)
          : undefined;
        resolved.fallback = {
          provider: fallbackProvider,
          model: fileConfig.fallbackModel,
          ...(fallbackProvider === 'openai'
            ? {
                baseUrl: fallbackBoundUrl
                  ?? fileConfig.fallbackBaseUrl
                  ?? (fallbackProvider === provider ? String(baseUrl) : undefined)
                  ?? DEFAULT_OPENAI_BASE_URL,
              }
            : (fallbackAnthropicBaseUrl ? { baseUrl: fallbackAnthropicBaseUrl } : {})),
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
    // Subscription setup tokens are only honored inside the Claude Code
    // harness, so they route through the Agent SDK runtime; API keys use
    // the raw Messages API.
    if (config.authToken && !config.apiKey) {
      return createClaudeCodeProvider({
        authToken: config.authToken,
        model: config.model,
        ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
      });
    }
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

  // A soul is a full identity — without one, every provider serves the
  // same built-in Stratus persona.
  const agent = options.runtime.soul?.agent ?? DEFAULT_STRATUS_AGENT;

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
    let shadowConfigFlag = '';
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
        'Test run             say hello with the current settings',
        'Save & finish',
      ]);

      // Backing out of the top level (Esc, or the input ending) saves.
      if (choice.kind !== 'index' || choice.index === 4) {
        break;
      }

      if (choice.index === 0) {
        await chooseProviders();
      } else if (choice.index === 1) {
        await chooseModels();
      } else if (choice.index === 2) {
        await chooseAgent();
      } else if (choice.index === 3) {
        await testRun();
      }
    }

    await save();
    return 0;
  } finally {
    prompter.close();
  }
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
      const configLocation = await resolveConfigLocation({}, env);
      // Creating an agent must not be blocked by a broken config — it only
      // feeds the soul's provider/model hint, so fall back to defaults.
      let activeConfig: CliConfigFile = {};
      if (configLocation) {
        try {
          activeConfig = await loadConfigFile(configLocation.path);
        } catch (error) {
          writeLine(streams.stdout, `Note: ignoring unreadable config ${configLocation.path} (${error instanceof Error ? error.message : String(error)}).`);
        }
      }
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
