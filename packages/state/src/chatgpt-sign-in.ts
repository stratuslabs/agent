import { lstat, readFile } from 'node:fs/promises';
import { replaceOwnerOnlyFile } from './durable-write.ts';
import type { StateEnvironment } from './environment.ts';
import { serializeFileWrite } from './file-lock.ts';
import { chatgptSignInLockPath, chatgptSignInPath } from './paths.ts';

/**
 * The file a Sign in with ChatGPT session lives in, for
 * `@stratusagent/provider-chatgpt`, which owns what goes in it. This side
 * owns where it is, how it is written, and its lock.
 *
 * Its own file rather than a key in `credentials.json`. The refresh token
 * rotates: each refresh spends the old one, and the replacement must reach
 * the disk before it is used. Every `credentials.json` writer rewrites the
 * whole file, and a CLI's writer doesn't share the daemon's in-process lock,
 * so a `stratus credential set` that read the file just before a refresh
 * would put the spent token back and end the sign-in. Nothing but the
 * session's own code writes this file, and only under its lock.
 */
export interface ChatGPTSignInFile {
  /** The whole document, or undefined when there is no file yet. */
  read(): Promise<Record<string, unknown> | undefined>;
  /** Replaces the whole document. Call only inside `withLock`. */
  write(contents: Record<string, unknown>): Promise<void>;
  /**
   * Runs `work` while no other writer, in this process or another, can
   * change the file. In-process callers queue; another process's holder is
   * waited for without blocking the thread, up to the lock wait, then
   * `FileLockHeldError` and `work` never runs. Refused, with `work` never
   * run, while the file has another hard link.
   */
  withLock<T>(work: () => Promise<T>): Promise<T>;
}

/**
 * How long a sign-in write waits for another process's. A refresh is one
 * request to OpenAI and normally takes a second or two; a caller still
 * waiting after this can use the access token it has until it runs out.
 */
export const CHATGPT_SIGN_IN_LOCK_WAIT_MS = 30_000;

const CHATGPT_SIGN_IN_LOCK_POLL_MS = 50;

/**
 * The host refuses a hard link to this file by its inode (see
 * `createHostProtectedPaths`). A write renames a new inode over the file, so
 * a link made earlier would be left on the old inode, no longer protected,
 * with the old tokens in it. Replacing is refused instead while another link
 * exists, and so is taking the lock: the inode stays the protected one, and
 * the sign-in stops refreshing until the link is gone.
 */
const refuseOtherLinks = async (filePath: string): Promise<void> => {
  let links: number;
  try {
    links = (await lstat(filePath)).nlink;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  if (links > 1) {
    throw new Error(
      `${filePath} has another hard link, so it wasn't replaced: the link would keep the old sign-in readable. `
      + `Remove the link (\`find ~ -samefile ${filePath}\` finds it), then try again.`,
    );
  }
};

export const createChatGPTSignInFile = (
  env: StateEnvironment,
  options: { lockWaitMs?: number } = {},
): ChatGPTSignInFile => {
  const filePath = chatgptSignInPath(env);
  return {
    read: async () => {
      let raw: string;
      try {
        raw = await readFile(filePath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return undefined;
        }
        throw error;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Not JSON.parse's own message, and not as the cause: it quotes the
        // text it choked on, which here is tokens.
        throw new Error(`${filePath} is not valid JSON, so the ChatGPT sign-in in it can't be used. Remove the file and sign in with ChatGPT again.`);
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`${filePath} must contain a JSON object, so the ChatGPT sign-in in it can't be used. Remove the file and sign in with ChatGPT again.`);
      }
      return parsed as Record<string, unknown>;
    },
    write: async (contents) => {
      await refuseOtherLinks(filePath);
      await replaceOwnerOnlyFile(filePath, `${JSON.stringify(contents, null, 2)}\n`);
    },
    withLock: (work) =>
      serializeFileWrite(chatgptSignInLockPath(env), async () => {
        // Here as well as in the write, so a refresh is never sent whose
        // replacement token the write would then refuse to save.
        await refuseOtherLinks(filePath);
        return work();
      }, {
        waitMs: options.lockWaitMs ?? CHATGPT_SIGN_IN_LOCK_WAIT_MS,
        pollMs: CHATGPT_SIGN_IN_LOCK_POLL_MS,
      }),
  };
};
