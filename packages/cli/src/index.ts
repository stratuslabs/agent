import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AgentRunner,
  EventBus,
  ToolRegistry,
  type JsonObject,
  type JsonValue,
  type ModelProvider,
  type Session,
  type StratusEvent,
  type Tool,
} from '@stratusclaw/core';
import {
  createOpenAICompatibleProvider,
  createProviderResponseBuilder,
  defineProvider,
} from '@stratusclaw/providers';

export interface CliStreams {
  stdout: Pick<typeof process.stdout, 'write'>;
  stderr: Pick<typeof process.stderr, 'write'>;
}

export interface CliEnvironment {
  stdin?: string;
  stdinStream?: NodeJS.ReadableStream;
  processEnv?: NodeJS.ProcessEnv;
  cwd?: string;
  fetch?: typeof fetch;
}

export interface CliRunOptions {
  argv: string[];
  streams?: CliStreams;
  env?: CliEnvironment;
}

export type CliProviderName = 'demo' | 'openai';

export interface ParsedRunCommand {
  command: 'run';
  prompt: string;
  provider?: CliProviderName;
  model?: string;
  baseUrl?: string;
  configPath?: string;
  format: 'text' | 'json';
  events: boolean;
}

export interface ParsedHelpCommand {
  command: 'help';
}

export type ParsedCommand = ParsedRunCommand | ParsedHelpCommand;

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

const DEFAULT_CONFIG_FILENAME = 'stratusclaw.config.json';
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini';

const HELP_TEXT = `StratusClaw CLI

Usage:
  pnpm cli run --prompt "Use the demo tool"
  pnpm cli run "Say hello"
  echo "Use the echo tool" | pnpm cli run --stdin
  STRATUSCLAW_PROVIDER=openai OPENAI_API_KEY=... pnpm cli run "Say hello"
  pnpm cli run --config ./stratusclaw.config.json --provider openai "Say hello"

Commands:
  run              Execute one local StratusClaw session
  help             Show this help message

Options:
  --prompt, -p     Prompt to send to the local agent loop
  --stdin          Read the prompt from stdin
  --provider       Provider to use: demo or openai
  --model          Model name for real providers (default: gpt-4.1-mini)
  --base-url       Override the OpenAI-compatible API base URL
  --config         Load provider settings from a JSON config file
  --format         Output format: text or json (default: text)
  --no-events      Hide event-by-event progress lines in text mode
  --help, -h       Show this help message

Config file:
  The CLI looks for ./stratusclaw.config.json by default, or a path from --config / STRATUSCLAW_CONFIG.
  Example:
    {
      "provider": "openai",
      "model": "gpt-4.1-mini",
      "baseUrl": "https://api.openai.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY"
    }
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

const createDemoTool = (): Tool => ({
  name: 'demo.echo',
  description: 'Return a tiny transformed summary for CLI demos.',
  async execute(input) {
    const text = typeof input.text === 'string' ? input.text : '';
    const normalized = text.trim() || 'empty input';

    return {
      received: normalized,
      uppercase: normalized.toUpperCase(),
      length: normalized.length,
    } satisfies JsonObject;
  },
});

const createDemoProvider = (): ModelProvider =>
  defineProvider({
    name: 'demo',
    async generate({ session }) {
      const prompt = session.messages.at(-1)?.content?.trim() ?? '';
      const builder = createProviderResponseBuilder();
      const wantsTool = /\b(tool|echo|uppercase|inspect)\b/i.test(prompt);

      builder.addText(`Demo provider ready. Prompt received: ${prompt || '(empty)'}`);

      if (wantsTool) {
        builder.addToolCall({
          id: `${session.id}:call:demo-echo`,
          toolName: 'demo.echo',
          input: { text: prompt },
        });
        builder.addText('Demo provider queued demo.echo so you can see the local loop execute a tool.');
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

export const parseCommand = (argv: string[], env: CliEnvironment = {}): ParsedCommand => {
  const [command, ...rest] = argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return { command: 'help' };
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
      const value = rest[index + 1];
      if (!value) {
        throw new Error('Missing value for --prompt');
      }
      prompt = value;
      index += 1;
      continue;
    }

    if (token === '--stdin') {
      useStdin = true;
      continue;
    }

    if (token === '--provider') {
      const value = rest[index + 1];
      if (!value) {
        throw new Error('Missing value for --provider');
      }
      provider = parseProviderName(value, '--provider');
      index += 1;
      continue;
    }

    if (token === '--model') {
      const value = rest[index + 1];
      if (!value) {
        throw new Error('Missing value for --model');
      }
      model = value;
      index += 1;
      continue;
    }

    if (token === '--base-url') {
      const value = rest[index + 1];
      if (!value) {
        throw new Error('Missing value for --base-url');
      }
      baseUrl = value;
      index += 1;
      continue;
    }

    if (token === '--config') {
      const value = rest[index + 1];
      if (!value) {
        throw new Error('Missing value for --config');
      }
      configPath = value;
      index += 1;
      continue;
    }

    if (token === '--format') {
      const value = rest[index + 1];
      if (value !== 'text' && value !== 'json') {
        throw new Error(`Unsupported format: ${value ?? '(missing)'}`);
      }
      format = value;
      index += 1;
      continue;
    }

    if (token === '--no-events') {
      events = false;
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

  return {
    command: 'run',
    prompt,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(configPath ? { configPath } : {}),
    format,
    events,
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
  const explicit = command.configPath ?? processEnv.STRATUSCLAW_CONFIG;

  if (explicit) {
    return path.resolve(cwd, explicit);
  }

  const defaultPath = path.join(cwd, DEFAULT_CONFIG_FILENAME);
  try {
    await readFile(defaultPath, 'utf8');
    return defaultPath;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
};

export const resolveRuntimeConfig = async (
  command: ParsedRunCommand,
  env: CliEnvironment = {},
): Promise<RuntimeConfig> => {
  const processEnv = readProcessEnv(env);
  const configPath = await resolveConfigPath(command, env);
  const fileConfig = configPath ? await loadConfigFile(configPath) : {};

  const provider = command.provider
    ?? readNonEmptyString(processEnv.STRATUSCLAW_PROVIDER, (value) => parseProviderName(value, 'STRATUSCLAW_PROVIDER'))
    ?? fileConfig.provider
    ?? 'demo';

  if (provider === 'demo') {
    return { provider: 'demo' };
  }

  const model = command.model ?? readNonEmptyString(processEnv.STRATUSCLAW_MODEL) ?? fileConfig.model ?? DEFAULT_OPENAI_MODEL;
  const baseUrl = command.baseUrl ?? readNonEmptyString(processEnv.STRATUSCLAW_BASE_URL) ?? fileConfig.baseUrl ?? DEFAULT_OPENAI_BASE_URL;
  const apiKeyEnvName = readNonEmptyString(processEnv.STRATUSCLAW_API_KEY_ENV) ?? fileConfig.apiKeyEnv ?? 'OPENAI_API_KEY';
  const apiKey = readNonEmptyString(processEnv.STRATUSCLAW_API_KEY) ?? readNonEmptyString(processEnv[apiKeyEnvName]);

  if (!apiKey) {
    throw new Error(`Missing API key for provider=openai. Set STRATUSCLAW_API_KEY or ${apiKeyEnvName}.`);
  }

  const resolved: RuntimeConfig = {
    provider: 'openai',
    model,
    baseUrl,
    apiKey,
  };

  const systemPrompt = readNonEmptyString(processEnv.STRATUSCLAW_SYSTEM_PROMPT) ?? fileConfig.systemPrompt;
  if (systemPrompt) {
    resolved.systemPrompt = systemPrompt;
  }

  if (env.fetch) {
    resolved.fetch = env.fetch;
  }

  return resolved;
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

export const runSingleLoop = async (
  prompt: string,
  streams: CliStreams,
  options: { events?: boolean; runtime: RuntimeConfig },
): Promise<Session> => {
  const tools = new ToolRegistry();
  tools.register(createDemoTool());

  const bus = new EventBus();
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
    bus,
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
    metadata,
  });
};

export const printSessionSummary = (session: Session, streams: CliStreams): void => {
  writeLine(streams.stdout);
  writeLine(streams.stdout, 'Messages');

  for (const message of session.messages) {
    const nameSuffix = message.name ? `:${message.name}` : '';
    const content = message.role === 'tool' ? stringifyValue(JSON.parse(message.content) as JsonValue) : message.content;
    writeLine(streams.stdout, `[${message.role}${nameSuffix}] ${content}`);
  }
};

const formatRuntimeBanner = (runtime: RuntimeConfig): string => {
  if (runtime.provider === 'demo') {
    return 'Starting StratusClaw local loop with provider=demo';
  }

  return `Starting StratusClaw local loop with provider=openai model=${runtime.model}`;
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

    const runtime = await resolveRuntimeConfig(command, resolvedEnv);

    if (command.format === 'text') {
      writeLine(streams.stdout, formatRuntimeBanner(runtime));
    }

    const session = await runSingleLoop(command.prompt, streams, {
      events: command.events && command.format === 'text',
      runtime,
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
