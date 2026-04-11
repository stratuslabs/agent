import { randomUUID } from 'node:crypto';
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
import { createProviderResponseBuilder, defineProvider } from '@stratusclaw/providers';

export interface CliStreams {
  stdout: Pick<typeof process.stdout, 'write'>;
  stderr: Pick<typeof process.stderr, 'write'>;
}

export interface CliEnvironment {
  stdin?: string;
  stdinStream?: NodeJS.ReadableStream;
}

export interface CliRunOptions {
  argv: string[];
  streams?: CliStreams;
  env?: CliEnvironment;
}

export interface ParsedRunCommand {
  command: 'run';
  prompt: string;
  provider: 'demo';
  format: 'text' | 'json';
  events: boolean;
}

export interface ParsedHelpCommand {
  command: 'help';
}

export type ParsedCommand = ParsedRunCommand | ParsedHelpCommand;

const HELP_TEXT = `StratusClaw CLI

Usage:
  pnpm cli run --prompt "Use the demo tool"
  pnpm cli run "Say hello"
  echo "Use the echo tool" | pnpm cli run --stdin

Commands:
  run              Execute the local demo loop
  help             Show this help message

Options:
  --prompt, -p     Prompt to send to the local agent loop
  --stdin          Read the prompt from stdin
  --provider       Provider mode to use (default: demo)
  --format         Output format: text or json (default: text)
  --no-events      Hide event-by-event progress lines in text mode
  --help, -h       Show this help message
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

export const parseCommand = (argv: string[], env: CliEnvironment = {}): ParsedCommand => {
  const [command, ...rest] = argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return { command: 'help' };
  }

  if (command !== 'run') {
    throw new Error(`Unknown command: ${command}`);
  }

  let prompt = '';
  let provider: 'demo' = 'demo';
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
      if (value !== 'demo') {
        throw new Error(`Unsupported provider: ${value ?? '(missing)'}`);
      }
      provider = value;
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

  return { command: 'run', prompt, provider, format, events };
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

export const runSingleLoop = async (
  prompt: string,
  streams: CliStreams,
  options: { events?: boolean } = {},
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

  const runner = new AgentRunner({
    provider: createDemoProvider(),
    tools,
    bus,
  });

  await runner.initialize();

  return runner.run({
    sessionId: randomUUID(),
    agent: {
      id: 'demo-agent',
      name: 'Demo Agent',
      instructions: 'Keep the loop tiny and readable.',
    },
    userMessage: prompt,
    metadata: { provider: 'demo' },
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

    if (command.format === 'text') {
      writeLine(streams.stdout, `Starting StratusClaw local loop with provider=${command.provider}`);
    }

    const session = await runSingleLoop(command.prompt, streams, { events: command.events && command.format === 'text' });

    if (command.format === 'json') {
      writeLine(streams.stdout, JSON.stringify({
        provider: command.provider,
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
