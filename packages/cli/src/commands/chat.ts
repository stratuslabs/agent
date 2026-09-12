import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { Session } from '@stratusagent/core';
import type { CliStreams, CliEnvironment } from '../environment.ts';
import { formatEvent } from '../events.ts';
import { writeLine } from '../io.ts';
import type { ParsedChatCommand } from '../parse.ts';
import { stratusHeaderLines } from '../prompter.ts';
import { resolveRuntimeConfig, warnOnCredentialOverride, createAgentRuntime } from '../runtime.ts';

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
