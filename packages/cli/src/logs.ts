import { appendFile, mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

/**
 * One line of `~/.stratus/logs/stratusd.jsonl`. Structured rather than
 * pretty-printed because the interesting questions are filters — what did
 * this agent do, what happened in this session — and a whole roster
 * answering at once makes an unattributed stream unreadable.
 */
export interface LogRecord {
  /** ISO-8601, always UTC. */
  ts: string;
  level: 'info' | 'warn' | 'event';
  /** Event type for level 'event'; absent for daemon lines. */
  event?: string;
  /** Human-readable line for level 'info' and 'warn'. */
  msg?: string;
  agentId?: string;
  sessionId?: string;
  /** Event-specific fields: tool name, status, part count, error text. */
  detail?: Record<string, unknown>;
}

export const LOG_FILENAME = 'stratusd.jsonl';
/** Rotate past this size. Small enough to stay greppable, large enough to hold a busy day. */
export const LOG_MAX_BYTES = 8 * 1024 * 1024;
/** Rotated generations kept beside the live file. */
export const LOG_KEEP = 3;

export interface LogWriter {
  write(record: LogRecord): Promise<void>;
  /** Absolute path of the live log file. */
  readonly path: string;
}

export interface LogWriterOptions {
  dir: string;
  maxBytes?: number;
  keep?: number;
  /** Reports a logging failure without taking the daemon down with it. */
  onError?: (error: unknown) => void;
}

const rotatedName = (index: number): string => `${LOG_FILENAME}.${index}`;

/**
 * Appends JSONL, rotating by size. Writes are serialized through a promise
 * chain: concurrent turns emit events from independent async contexts, and
 * interleaved appends would split lines down the middle.
 */
export const createLogWriter = (options: LogWriterOptions): LogWriter => {
  const maxBytes = options.maxBytes ?? LOG_MAX_BYTES;
  const keep = options.keep ?? LOG_KEEP;
  const logPath = path.join(options.dir, LOG_FILENAME);
  let queue: Promise<void> = Promise.resolve();
  let ensured = false;

  const rotate = async (): Promise<void> => {
    // Oldest first, so each generation moves into a free slot.
    for (let index = keep; index >= 1; index -= 1) {
      const from = path.join(options.dir, index === 1 ? LOG_FILENAME : rotatedName(index - 1));
      const to = path.join(options.dir, rotatedName(index));
      if (index === keep) {
        await unlink(to).catch(() => undefined);
      }
      await rename(from, to).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      });
    }
  };

  const append = async (record: LogRecord): Promise<void> => {
    if (!ensured) {
      await mkdir(options.dir, { recursive: true, mode: 0o700 });
      ensured = true;
    }
    // Sessions carry prompts and tool output, so the log is as sensitive as
    // the transcript it describes.
    const size = await stat(logPath).then((info) => info.size).catch(() => 0);
    if (size >= maxBytes) {
      await rotate();
    }
    await appendFile(logPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  };

  return {
    path: logPath,
    write(record: LogRecord): Promise<void> {
      // A logging failure must never fail the turn that produced the line.
      queue = queue.then(() => append(record)).catch((error) => {
        options.onError?.(error);
      });
      return queue;
    },
  };
};

export interface LogFilter {
  agentId?: string;
  sessionId?: string;
}

export const matchesFilter = (record: LogRecord, filter: LogFilter): boolean => {
  if (filter.agentId && record.agentId !== filter.agentId) {
    return false;
  }
  if (filter.sessionId && record.sessionId !== filter.sessionId) {
    return false;
  }
  return true;
};

/** Malformed lines are skipped: a torn final line must not end the read. */
export const parseLogLines = (chunk: string): LogRecord[] => {
  const records: LogRecord[] = [];
  for (const line of chunk.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as LogRecord;
      if (typeof parsed?.ts === 'string' && typeof parsed?.level === 'string') {
        records.push(parsed);
      }
    } catch {
      continue;
    }
  }
  return records;
};

/**
 * The most recent `limit` records, oldest first, reaching back through
 * rotated generations when the live file is short — a rotation must not
 * make `stratus logs` look like the daemon just started.
 */
export const readRecentRecords = async (
  dir: string,
  limit: number,
  filter: LogFilter = {},
  /**
   * Read the live file only up to this byte offset. A follower that starts
   * from the same offset then covers everything after it — without the
   * bound, records written between the two reads appear in both.
   */
  untilOffset?: number,
): Promise<LogRecord[]> => {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  // Newest first: the live file, then .1, .2, …
  const ordered = [
    ...(names.includes(LOG_FILENAME) ? [LOG_FILENAME] : []),
    ...names
      .filter((name) => name.startsWith(`${LOG_FILENAME}.`))
      .sort((left, right) => Number(left.split('.').pop()) - Number(right.split('.').pop())),
  ];

  // slice(-0) is slice(0), which would return everything — the opposite of
  // what `-n 0` asks for, and `-n 0 -f` is the ordinary way to follow
  // without replaying the file.
  if (limit === 0) {
    return [];
  }

  const collected: LogRecord[] = [];
  const { readFile } = await import('node:fs/promises');
  for (const name of ordered) {
    const raw = await readFile(path.join(dir, name)).catch(() => Buffer.alloc(0));
    // Sliced as bytes, not characters: the offset a follower resumes from
    // is a byte count, and a multi-byte character would shift the seam.
    const contents = (name === LOG_FILENAME && untilOffset !== undefined
      ? raw.subarray(0, untilOffset)
      : raw).toString('utf8');
    const matching = parseLogLines(contents).filter((record) => matchesFilter(record, filter));
    collected.unshift(...matching);
    if (collected.length >= limit) {
      break;
    }
  }
  return collected.slice(-limit);
};

/**
 * Where a follower should resume from: a byte offset AND the identity of
 * the file it refers to. The offset alone is meaningless after a rotation,
 * because the bytes it counted are in a different file by then.
 */
export interface LogPosition {
  offset: number;
  /** inode of the live file; undefined when there is no file yet. */
  ino?: number;
}

export const currentLogPosition = async (dir: string): Promise<LogPosition> =>
  stat(path.join(dir, LOG_FILENAME))
    .then((info) => ({ offset: info.size, ino: info.ino }))
    .catch(() => ({ offset: 0 }));

export interface TailOptions {
  dir: string;
  filter?: LogFilter;
  /** Poll interval; the daemon writes from another process, so there is nothing to await. */
  intervalMs?: number;
  signal?: AbortSignal;
  /**
   * Where to resume. Callers that print a backlog first must capture this
   * BEFORE reading it (`currentLogPosition`), or records written in between
   * are in neither the backlog nor the stream — and the file identity has
   * to travel with the offset, or a rotation in that same window makes the
   * offset point into the wrong file.
   */
  startPosition?: LogPosition;
  onRecord: (record: LogRecord) => void;
}

/**
 * Follows the live log from its current end. Polls rather than watching:
 * fs.watch semantics differ across platforms and miss rotation, and a
 * rotation mid-tail is exactly when you are reading the log.
 */
export const tailLog = async (options: TailOptions): Promise<void> => {
  const intervalMs = options.intervalMs ?? 400;
  const filter = options.filter ?? {};
  const logPath = path.join(options.dir, LOG_FILENAME);
  const start = options.startPosition ?? await currentLogPosition(options.dir);
  let offset = start.offset;
  let carry = '';
  // Rotation is a file-identity change, not a size change. A burst can
  // rotate and grow the replacement past the old offset before the next
  // poll, and a size comparison reads that as "the file just grew" —
  // skipping the replacement's prefix and never draining what moved to .1.
  let liveIno = start.ino;

  /** Reads from `from` to EOF, emitting whole lines. Returns the new offset. */
  const drain = async (target: string, from: number): Promise<number> => {
    const handle = await open(target, 'r').catch(() => undefined);
    if (!handle) {
      return from;
    }
    try {
      const size = await handle.stat().then((info) => info.size);
      if (size <= from) {
        return from;
      }
      const length = size - from;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, from);
      const text = carry + buffer.subarray(0, bytesRead).toString('utf8');
      // A partial trailing line is held back until its newline lands.
      const lastBreak = text.lastIndexOf('\n');
      carry = lastBreak >= 0 ? text.slice(lastBreak + 1) : text;
      for (const record of parseLogLines(lastBreak >= 0 ? text.slice(0, lastBreak) : '')) {
        if (matchesFilter(record, filter)) {
          options.onRecord(record);
        }
      }
      return from + bytesRead;
    } finally {
      await handle.close();
    }
  };

  while (!options.signal?.aborted) {
    const info = await stat(logPath).catch(() => undefined);
    if (info) {
      if (liveIno !== undefined && info.ino !== liveIno) {
        // The file we were reading is now .1 — drain the bytes we never
        // got to before switching. Only if .1 really is that file: a
        // second rotation in one interval evicts it, and draining the
        // wrong generation would replay records instead of recovering them.
        const rotated = path.join(options.dir, rotatedName(1));
        const rotatedIno = await stat(rotated).then((entry) => entry.ino).catch(() => undefined);
        if (rotatedIno === liveIno) {
          await drain(rotated, offset).catch(() => offset);
        }
        offset = 0;
        carry = '';
      }
      liveIno = info.ino;
      offset = await drain(logPath, offset);
    }
    if (options.signal?.aborted) {
      return;
    }
    await new Promise<void>((resolve) => {
      // Both paths detach the listener: {once:true} only fires on abort, so
      // a poll loop running for days would otherwise retain one closure per
      // tick — roughly 216,000 a day at the default interval.
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        options.signal?.removeEventListener('abort', onAbort);
        resolve();
      }, intervalMs);
      options.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
};

/** `14:32:07  ava  tool.called memory.remember` — time, who, what. */
export const formatLogRecord = (record: LogRecord): string => {
  const time = record.ts.slice(11, 19);
  const who = (record.agentId ?? '—').padEnd(12);
  if (record.level === 'event') {
    const detail = record.detail ? Object.entries(record.detail).map(([key, value]) => `${key}=${String(value)}`).join(' ') : '';
    const session = record.sessionId ? ` [${record.sessionId.slice(0, 8)}]` : '';
    return `${time}  ${who}${record.event ?? 'event'}${detail ? ` ${detail}` : ''}${session}`;
  }
  const prefix = record.level === 'warn' ? 'warning: ' : '';
  return `${time}  ${who}${prefix}${record.msg ?? ''}`;
};
