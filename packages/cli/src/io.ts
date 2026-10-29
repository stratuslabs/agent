import { stat } from 'node:fs/promises';
import type { JsonValue } from '@stratusagent/core';

export const writeLine = (stream: Pick<typeof process.stdout, 'write'>, line = ''): void => {
  stream.write(`${line}\n`);
};

/** The part of a stdio stream `watchOutputReader` needs: its error events. */
export interface OutputErrorSource {
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown;
}

/**
 * Lets the reader of a piped stream stop early. `stratus events | grep -q
 * github` closes the pipe once grep matches, and the next write fails with
 * EPIPE: unhandled, that was a stack trace and exit 1, which fails a script
 * under `set -o pipefail` that got exactly the answer it asked for (#909).
 *
 * The output nobody reads is dropped and the command carries on to its own
 * exit code. Exiting 0 at the first failed write, the usual EPIPE idiom,
 * would report success for a command it cut short: `stratus update | head
 * -1` would stop partway through the update it was reporting on. A
 * foreground `stratus serve` keeps serving the same way; everything it
 * prints is in its log file too. The returned signal aborts when the reader
 * is gone, for a command that never finishes on its own (`logs --follow`)
 * to stop on.
 *
 * Every other write error still throws, as an uncaught exception the way it
 * did before: a full disk is not a reader that stopped reading, and the
 * output that was asked for did not arrive.
 */
export const watchOutputReader = (stream: OutputErrorSource): AbortSignal => {
  const readerGone = new AbortController();
  stream.on('error', (error) => {
    if (error.code !== 'EPIPE') {
      throw error;
    }
    readerGone.abort();
  });
  return readerGone.signal;
};

export const stringifyValue = (value: JsonValue): string => {
  if (typeof value === 'string') {
    return value;
  }

  return JSON.stringify(value, null, 2);
};

export const readPromptFromStdin = async (stdin: NodeJS.ReadableStream): Promise<string> => {
  stdin.setEncoding('utf8');

  let data = '';
  for await (const chunk of stdin) {
    data += chunk;
  }

  return data.trim();
};

/**
 * Stdin exactly as it arrived, for a value where whitespace may be part of
 * it.
 *
 * `readPromptFromStdin` trims, which is right for a prompt and wrong for a
 * secret: a key whose real value has a leading space would be stored as a
 * *different* key, reported as stored, and then fail authentication with
 * nothing to look at — this command never prints a value back.
 */
export const readSecretFromStdin = async (stdin: NodeJS.ReadableStream): Promise<string> => {
  stdin.setEncoding('utf8');

  let data = '';
  for await (const chunk of stdin) {
    data += chunk;
  }

  return data;
};

export const pathExists = async (candidate: string): Promise<boolean> => {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
};
