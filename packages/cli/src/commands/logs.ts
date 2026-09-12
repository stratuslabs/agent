import { logsDirPath } from '@stratusagent/state';
import {
  currentLogPosition,
  formatLogRecord,
  readRecentRecords,
  tailLog,
  type LogRecord,
} from '../logs.ts';
import type { CliStreams, CliEnvironment } from '../environment.ts';
import { writeLine } from '../io.ts';
import type { ParsedLogsCommand } from '../parse.ts';

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
