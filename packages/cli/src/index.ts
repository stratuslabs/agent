import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { createInterface } from 'node:readline';
import {
  AgentRunner,
  AllowAllApprovalPolicy,
  EventBus,
  ToolRegistry,
  type ApprovalPolicy,
  type JsonValue,
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
  fetch?: typeof fetch;
  openExternal?: (url: string) => Promise<void> | void;
  dashboardAutoShutdownMs?: number;
}

export interface CliRunOptions {
  argv: string[];
  streams?: CliStreams;
  env?: CliEnvironment;
}

export type CliProviderName = 'demo' | 'openai';
export type CliApprovalMode = 'always' | 'ask' | 'never';

export interface ParsedRunCommand {
  command: 'run';
  prompt: string;
  provider?: CliProviderName;
  model?: string;
  baseUrl?: string;
  configPath?: string;
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

export interface ParsedHelpCommand {
  command: 'help';
}

export type ParsedCommand =
  | ParsedRunCommand
  | ParsedDashboardCommand
  | ParsedSetupCommand
  | ParsedHelpCommand;

interface CliConfigFile {
  provider?: CliProviderName;
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  systemPrompt?: string;
}

type RuntimeConfig =
  | { provider: 'demo' }
  | {
      provider: 'openai';
      model: string;
      baseUrl: string;
      apiKey: string;
      systemPrompt?: string;
      fetch?: typeof fetch;
    };

export interface DashboardServerHandle {
  url: string;
  close: () => Promise<void>;
}

const DEFAULT_CONFIG_FILENAME = 'stratus.config.json';
const LEGACY_CONFIG_FILENAME = 'stratusclaw.config.json';
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini';
const DEFAULT_DASHBOARD_HOST = '127.0.0.1';
const DASHBOARD_TITLE = 'Stratus Agent Dashboard';

const HELP_TEXT = `Stratus Agent CLI

Usage:
  stratus setup
  stratus run --prompt "Use the demo tool"
  stratus run "Say hello"
  echo "Use the echo tool" | stratus run --stdin
  STRATUS_PROVIDER=openai OPENAI_API_KEY=... stratus run "Say hello"
  stratus run --config ./stratus.config.json --provider openai "Say hello"
  stratus dashboard
  stratus dashboard --port 4123 --host 0.0.0.0 --no-open

Commands:
  setup            Interactive walkthrough that writes stratus.config.json
  run              Execute one local Stratus Agent session
  dashboard        Start the local Stratus Agent dashboard and open it in your browser
  help             Show this help message

Options:
  --prompt, -p     Prompt to send to the local agent loop
  --stdin          Read the prompt from stdin
  --provider       Provider to use: demo or openai
  --model          Model name for real providers (default: gpt-4.1-mini)
  --base-url       Override the OpenAI-compatible API base URL
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
  The CLI looks for ./stratus.config.json by default, or a path from --config / STRATUS_CONFIG.
  Legacy STRATUSCLAW_* env vars and stratusclaw.config.json are still supported for compatibility.
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
  if (value === 'demo' || value === 'openai') {
    return value;
  }

  throw new Error(`Unsupported provider in ${label}: ${value}`);
};

const readProcessEnv = (env: CliEnvironment): NodeJS.ProcessEnv => env.processEnv ?? process.env;
const readWorkingDirectory = (env: CliEnvironment): string => env.cwd ?? process.cwd();

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

  for (const candidate of [DEFAULT_CONFIG_FILENAME, LEGACY_CONFIG_FILENAME]) {
    const candidatePath = path.join(cwd, candidate);
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

export const resolveRuntimeConfig = async (
  command: ParsedRunCommand,
  env: CliEnvironment = {},
): Promise<RuntimeConfig> => {
  const processEnv = readProcessEnv(env);
  const configPath = await resolveConfigPath(command, env);
  const fileConfig = configPath ? await loadConfigFile(configPath) : {};

  const provider = command.provider
    ?? readNonEmptyString(processEnv.STRATUS_PROVIDER, (value) => parseProviderName(value, 'STRATUS_PROVIDER'))
    ?? readNonEmptyString(processEnv.STRATUSCLAW_PROVIDER, (value) => parseProviderName(value, 'STRATUSCLAW_PROVIDER'))
    ?? fileConfig.provider
    ?? 'demo';

  if (provider === 'demo') {
    return { provider: 'demo' };
  }

  const model = command.model
    ?? readNonEmptyString(processEnv.STRATUS_MODEL)
    ?? readNonEmptyString(processEnv.STRATUSCLAW_MODEL)
    ?? fileConfig.model
    ?? DEFAULT_OPENAI_MODEL;

  const baseUrl = command.baseUrl
    ?? readNonEmptyString(processEnv.STRATUS_BASE_URL)
    ?? readNonEmptyString(processEnv.STRATUSCLAW_BASE_URL)
    ?? fileConfig.baseUrl
    ?? DEFAULT_OPENAI_BASE_URL;

  const apiKeyEnvName = readNonEmptyString(processEnv.STRATUS_API_KEY_ENV)
    ?? readNonEmptyString(processEnv.STRATUSCLAW_API_KEY_ENV)
    ?? fileConfig.apiKeyEnv
    ?? 'OPENAI_API_KEY';

  const apiKey = readNonEmptyString(processEnv.STRATUS_API_KEY)
    ?? readNonEmptyString(processEnv.STRATUSCLAW_API_KEY)
    ?? readNonEmptyString(processEnv[String(apiKeyEnvName)]);

  if (!apiKey) {
    throw new Error(`Missing API key for provider=openai. Set STRATUS_API_KEY or ${apiKeyEnvName}.`);
  }

  const resolved: RuntimeConfig = {
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

  return resolved;
};

const createRuntimeProvider = (config: RuntimeConfig): ModelProvider => {
  if (config.provider === 'demo') {
    return createDemoProvider();
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
  const tools = new ToolRegistry();
  tools.register(createDemoTool());

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

  const runtimeProvider = createRuntimeProvider(options.runtime);

  const runner = new AgentRunner({
    provider: runtimeProvider,
    tools,
    executor: createLocalCommandExecutor(),
    approvals: createApprovalPolicy(options.approvals ?? 'always', streams, options.env ?? {}),
    bus,
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
  });

  await runner.initialize();

  const agent = options.runtime.provider === 'demo'
    ? {
        id: 'demo-agent',
        name: 'Demo Agent',
        instructions: 'Keep the loop tiny and readable.',
      }
    : {
        id: 'openai-agent',
        name: 'OpenAI Agent',
        instructions: 'Respond clearly and directly to the user request.',
      };

  const metadata = options.runtime.provider === 'demo'
    ? { provider: 'demo' as const }
    : {
        provider: 'openai' as const,
        model: options.runtime.model,
        baseUrl: options.runtime.baseUrl,
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
  if (runtime.provider === 'demo') {
    return 'Starting Stratus Agent local loop with provider=demo';
  }

  return `Starting Stratus Agent local loop with provider=openai model=${runtime.model}`;
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
        version: '0.1.0',
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

interface SetupPrompter {
  ask(question: string): Promise<string>;
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
    close() {
      readline.close();
    },
  };
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await readFile(filePath, 'utf8');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};

export const runSetup = async (
  command: ParsedSetupCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  const cwd = readWorkingDirectory(env);
  const processEnv = readProcessEnv(env);

  // Mirror resolveConfigPath's precedence (--config, then STRATUS_CONFIG /
  // STRATUSCLAW_CONFIG, then the default filename) so the file written here
  // is the one `stratus run` actually loads afterwards.
  const envConfigVar = readNonEmptyString(processEnv.STRATUS_CONFIG)
    ? 'STRATUS_CONFIG'
    : readNonEmptyString(processEnv.STRATUSCLAW_CONFIG)
      ? 'STRATUSCLAW_CONFIG'
      : undefined;
  const envConfigPath = envConfigVar ? String(processEnv[envConfigVar]).trim() : undefined;
  const chosenPath = command.configPath ?? envConfigPath ?? DEFAULT_CONFIG_FILENAME;
  const configPath = path.resolve(cwd, chosenPath);
  // A path passed via --config is not auto-discovered by `stratus run`, so
  // suggested commands must carry it explicitly. Env-derived paths need no
  // flag because `run` reads the same variable.
  const runConfigFlag = command.configPath ? ` --config ${command.configPath}` : '';
  const prompter = createSetupPrompter(streams, env);

  try {
    writeLine(streams.stdout, 'Stratus Agent setup');
    writeLine(streams.stdout, 'This walkthrough writes a stratus.config.json so `stratus run` works out of the box.');
    writeLine(streams.stdout, 'Press Enter to accept the [default] for any question.');
    if (!command.configPath && envConfigVar) {
      writeLine(streams.stdout, `${envConfigVar} is set, so the config will be written to ${configPath}.`);
    }
    writeLine(streams.stdout);

    if (await fileExists(configPath)) {
      const overwrite = await prompter.ask(`${configPath} already exists. Overwrite it? [y/N] `);
      if (!/^y(es)?$/i.test(overwrite)) {
        writeLine(streams.stdout, 'Keeping the existing config. Nothing was changed.');
        return 0;
      }
      writeLine(streams.stdout);
    }

    const providerAnswer = await prompter.ask(
      'Which provider do you want to use?\n  1) openai — any OpenAI-compatible API (needs an API key)\n  2) demo — built-in provider, no key required\nChoose [1]: ',
    );
    const provider: CliProviderName = providerAnswer === '2' || /^demo$/i.test(providerAnswer) ? 'demo' : 'openai';

    if (provider === 'demo') {
      await writeFile(configPath, `${JSON.stringify({ provider: 'demo' }, null, 2)}\n`);
      writeLine(streams.stdout);
      writeLine(streams.stdout, `Wrote ${configPath}`);
      writeLine(streams.stdout);
      writeLine(streams.stdout, 'You are ready to go — no API key needed. Try:');
      writeLine(streams.stdout, `  stratus run${runConfigFlag} "please use the echo tool"`);
      writeLine(streams.stdout, '  stratus dashboard');
      return 0;
    }

    const model = (await prompter.ask(`Model [${DEFAULT_OPENAI_MODEL}]: `)) || DEFAULT_OPENAI_MODEL;
    const baseUrl = (await prompter.ask(`Base URL [${DEFAULT_OPENAI_BASE_URL}]: `)) || DEFAULT_OPENAI_BASE_URL;
    const apiKeyEnv = (await prompter.ask('Environment variable holding your API key [OPENAI_API_KEY]: ')) || 'OPENAI_API_KEY';
    const systemPrompt = await prompter.ask('System prompt (optional, Enter to skip): ');

    const config: Record<string, string> = { provider, model, baseUrl, apiKeyEnv };
    if (systemPrompt) {
      config.systemPrompt = systemPrompt;
    }

    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    writeLine(streams.stdout);
    writeLine(streams.stdout, `Wrote ${configPath}`);
    writeLine(streams.stdout);

    if (processEnv[apiKeyEnv]) {
      writeLine(streams.stdout, `${apiKeyEnv} is set in your environment — you are ready to go. Try:`);
    } else {
      writeLine(streams.stdout, `${apiKeyEnv} is NOT set in your environment yet. Set it first:`);
      writeLine(streams.stdout, `  export ${apiKeyEnv}=your-key`);
      writeLine(streams.stdout);
      writeLine(streams.stdout, 'Then try:');
    }
    writeLine(streams.stdout, `  stratus run${runConfigFlag} "say hello"`);
    writeLine(streams.stdout, '  stratus dashboard');
    return 0;
  } finally {
    prompter.close();
  }
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
        session,
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
