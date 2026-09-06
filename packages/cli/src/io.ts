import { stat } from 'node:fs/promises';
import type { JsonValue } from '@stratusagent/core';

export const writeLine = (stream: Pick<typeof process.stdout, 'write'>, line = ''): void => {
  stream.write(`${line}\n`);
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
