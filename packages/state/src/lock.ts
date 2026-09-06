import { chmodSync, mkdirSync, truncateSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Cross-process file locks, held on a file's inode rather than in it.
 *
 * The gateway has claimed `~/.stratus` this way since the two-daemons
 * incident (see `claimHome`), and agent creation needs the same primitive
 * for a different file: the CLI and the dashboard both read-modify-write
 * `~/.stratus/config.json`, and last-writer-wins there is how an operator
 * loses a plugin entry they never touched. One implementation, two
 * policies — refuse when somebody else holds it, or wait for them.
 */

/** Thrown by `claimFileLock` when another holder has the file. */
export class FileLockBusyError extends Error {
  constructor(lockPath: string) {
    super(`${lockPath} is held by another process.`);
    this.name = 'FileLockBusyError';
  }
}

/** Thrown by `withFileLock` when the wait ran out before the lock came free. */
export class FileLockTimeoutError extends Error {
  constructor(lockPath: string, waitedMs: number) {
    super(
      `Waited ${Math.round(waitedMs / 1000)}s for ${lockPath} and it is still held. `
      + 'Another stratus command is writing the same file; try again when it finishes.',
    );
    this.name = 'FileLockTimeoutError';
  }
}

export interface FileClaim {
  /**
   * Let the lock go. Idempotent. A process that exits without calling it
   * lets go too — the lock lives on the file descriptor, not on disk.
   */
  release(): void;
}

/** SQLITE_BUSY: another connection holds a lock this one needs. */
const isBusy = (error: unknown): boolean => errcodeOf(error) === 5;

/** SQLITE_CORRUPT or SQLITE_NOTADB: the file is not a database any more. */
const isNotADatabase = (error: unknown): boolean => {
  const code = errcodeOf(error);
  return code === 11 || code === 26;
};

const errcodeOf = (error: unknown): unknown =>
  typeof error === 'object' && error !== null ? (error as { errcode?: unknown }).errcode : undefined;

/**
 * Open the file and take the lock, or close the file and throw.
 *
 * The claim is an exclusive transaction held open, never committed: SQLite
 * takes the OS file lock for it and nothing is ever written — not a row,
 * not a page, not a journal — so there is nothing a crash mid-claim can
 * tear, and a machine that dies leaves a file the next claimant can take.
 * The in-memory journal mode is only so no `-journal` file appears beside
 * the lock; it has nothing to roll back.
 */
const claimAt = (lockPath: string): DatabaseSync => {
  const db = new DatabaseSync(lockPath);
  try {
    db.exec('PRAGMA journal_mode = MEMORY');
    // A holder anywhere makes this fail with SQLITE_BUSY at once —
    // node:sqlite waits for nothing by default.
    db.exec('BEGIN EXCLUSIVE');
    // Created under the umask, like every other file SQLite makes;
    // tightened to match the rest of ~/.stratus. Inside the try: a
    // filesystem that refuses the chmod must not leave the lock held by a
    // connection nobody can close.
    chmodSync(lockPath, 0o600);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
};

/**
 * Take a lock file exclusively, for as long as the claim is held, or throw
 * `FileLockBusyError` at once.
 *
 * SQLite's own file lock, which gives three things a pid file cannot. It is
 * atomic across processes — two claimants cannot both read it as stale and
 * both take it. It covers the whole lifetime of the holder rather than the
 * moment it was written. And a process that dies releases it with its
 * descriptors, so it is never stale.
 *
 * The file is disposable, since nothing is ever written to it. One that is
 * not a database any more — damaged from outside, or left by something that
 * was not this — is emptied in place and claimed: nobody can be holding it,
 * because holding it needed the header this read refused. Emptied, never
 * removed and recreated: the OS lock lives on the inode, and a claimant that
 * unlinked the file would hand every later claimant an inode of its own to
 * hold. Two claimants that read the same damage both empty the same file —
 * the second finds it already empty, which is a valid database — and then
 * contend for the one lock, where exactly one wins. There is nothing to
 * serialize and nothing that can be unlinked from under a holder.
 */
export const claimFileLock = (lockPath: string): FileClaim => {
  mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  let held: DatabaseSync | undefined;
  // At most twice: the file as found, then the file emptied in place.
  for (const emptied of [false, true]) {
    try {
      held = claimAt(lockPath);
      break;
    } catch (error) {
      if (isBusy(error)) {
        throw new FileLockBusyError(lockPath);
      }
      if (emptied || !isNotADatabase(error)) {
        throw error;
      }
      try {
        truncateSync(lockPath, 0);
      } catch (truncateError) {
        // Gone meanwhile: the claim below creates it afresh.
        if ((truncateError as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw truncateError;
        }
      }
    }
  }
  if (!held) {
    throw new FileLockBusyError(lockPath);
  }

  let released = false;
  return {
    release() {
      if (released) {
        return;
      }
      released = true;
      held.close();
    },
  };
};

export interface WithFileLockOptions {
  /** How long to keep trying before giving up. Default 10s. */
  timeoutMs?: number;
  /** Longest pause between attempts. Default 50ms. */
  maxDelayMs?: number;
}

// Not unref'd: a caller is awaiting this, and an unref'd timer lets the
// event loop drain out from under the wait — the lock is never re-tried and
// the promise never settles.
const wait = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

/**
 * Run `body` holding `lockPath`, waiting for whoever has it rather than
 * refusing.
 *
 * The daemon refuses a claimed home because two daemons is a state to
 * report, not to wait out. A config write is the opposite: two commands
 * creating agents at once is ordinary, both should succeed, and the only
 * requirement is that the second reads what the first wrote. So this waits,
 * with a bound — an indefinite wait behind a lock some crashed process
 * *could* still hold would hang a command with nothing to look at, and the
 * timeout's message names the file.
 *
 * Backoff is jittered because two waiters that retry in lockstep re-collide
 * in lockstep.
 */
export const withFileLock = async <T>(
  lockPath: string,
  body: () => Promise<T>,
  options: WithFileLockOptions = {},
): Promise<T> => {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxDelayMs = options.maxDelayMs ?? 50;
  const started = Date.now();
  let delayMs = 1;
  for (;;) {
    let claim: FileClaim;
    try {
      claim = claimFileLock(lockPath);
    } catch (error) {
      if (!(error instanceof FileLockBusyError)) {
        throw error;
      }
      const waited = Date.now() - started;
      if (waited >= timeoutMs) {
        throw new FileLockTimeoutError(lockPath, waited);
      }
      await wait(Math.random() * delayMs);
      delayMs = Math.min(delayMs * 2, maxDelayMs);
      continue;
    }
    try {
      return await body();
    } finally {
      claim.release();
    }
  }
};
