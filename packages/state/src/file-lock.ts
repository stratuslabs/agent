import { chmodSync, mkdirSync, truncateSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { StateEnvironment } from './environment.ts';
import { grantsLockPath } from './paths.ts';

/** Thrown by `claimFileLock` when another holder kept the lock past the wait. */
export class FileLockHeldError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string) {
    super(`${lockPath} is held by another process.`);
    this.name = 'FileLockHeldError';
    this.lockPath = lockPath;
  }
}

export interface FileLock {
  /**
   * Let the lock go. Idempotent. A process that exits without calling it
   * lets go too: the lock lives on the file descriptor, not on disk.
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
 * `node:sqlite`, loaded only when a lock is taken, and synchronously,
 * because taking a lock is.
 *
 * Every importer of this package would otherwise load it, and with it the
 * experimental warning Node still prints; that is why the gateway is
 * imported lazily too. `getBuiltinModule` is what makes it lazy without
 * making the claim async.
 */
const sqlite = (): typeof import('node:sqlite') =>
  process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

/**
 * Open the file and take the lock, or close the file and throw.
 *
 * The claim is an exclusive transaction held open, never committed: SQLite
 * takes the OS file lock for it and nothing is ever written — not a row,
 * not a page, not a journal — so there is nothing a crash mid-claim can
 * tear, and a machine that dies leaves a file the next holder can claim.
 * The in-memory journal mode is only so no `-journal` file appears beside
 * the lock; it has nothing to roll back.
 */
const claimAt = (lockPath: string, waitMs: number): DatabaseSync => {
  const { DatabaseSync: Database } = sqlite();
  const db = new Database(lockPath);
  try {
    // How long a held lock is retried before SQLITE_BUSY. Zero is
    // node:sqlite's default and means at once. First, before anything that
    // touches the file: setting the journal mode contends for the lock as
    // well, and with no timeout yet it failed at once against a holder, so
    // a waiter never waited and a daemon read went ahead without the lock.
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(waitMs))}`);
    db.exec('PRAGMA journal_mode = MEMORY');
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
 * Take an exclusive lock on a file, across processes, until released.
 *
 * SQLite's own file lock, which gives three things a pid file cannot. It is
 * atomic across processes: two takers cannot both read it as free. It
 * covers exactly as long as it is held. And a process that dies releases it
 * with its descriptors, so it is never stale.
 *
 * `waitMs` is how long to wait for another holder before giving up with
 * `FileLockHeldError`. The daemon's home claim wants none (a second daemon
 * is refused, not queued). A short write lock wants a little. The wait
 * blocks the thread, which is why whatever runs under a lock other code in
 * the same process can wait on has to be synchronous: an `await` in it
 * would hand the thread to a waiter that cannot give it back.
 *
 * The file is disposable, since nothing is ever written to it. One that is
 * not a database any more — damaged from outside, or left by something
 * that was not this — is emptied in place and claimed: nobody can be
 * holding it, because holding it needed the header this read refused.
 * Emptied, never removed and recreated: the OS lock lives on the inode,
 * and a taker that unlinked the file would hand every later taker an inode
 * of its own to hold. Two takers that read the same damage both empty the
 * same file — the second finds it already empty, which is a valid database
 * — and then contend for the one lock, where exactly one wins.
 *
 * Lifted from the gateway's home claim (#184), whose policy `claimHome`
 * still is, when the grant file gained a lock of its own.
 */
export const claimFileLock = (lockPath: string, options: { waitMs?: number } = {}): FileLock => {
  mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const waitMs = options.waitMs ?? 0;
  let held: DatabaseSync | undefined;
  // At most twice: the file as found, then the file emptied in place.
  for (const emptied of [false, true]) {
    try {
      held = claimAt(lockPath, waitMs);
      break;
    } catch (error) {
      if (isBusy(error)) {
        throw new FileLockHeldError(lockPath);
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
    throw new FileLockHeldError(lockPath);
  }

  let released = false;
  return {
    release() {
      if (released) {
        return;
      }
      released = true;
      held!.close();
    },
  };
};

/**
 * How long a grant read or revoke waits for the other side. A revoke
 * rewrites one small file, so anything longer than this is a process that
 * is stuck rather than busy.
 */
export const GRANTS_LOCK_WAIT_MS = 5_000;

/**
 * Run a grant file's read under the grants lock, for the daemon's store.
 *
 * A revoke that cannot reach the control API rewrites the file itself, and
 * the store caches what it read for the life of the process. A daemon that
 * read the file in the middle of that revoke cached the grant the CLI then
 * reported as revoked, and honoured it until it restarted (#184). Under the
 * lock, the read comes either wholly before the revoke or wholly after it.
 *
 * `read` must be synchronous; see `claimFileLock` for why. A lock still
 * held after the wait is read through rather than refused, with a line
 * saying so: that is how every read went before this lock existed, and an
 * agent's grants failing to load over a stuck CLI would be worse.
 */
export const grantReadSerializer = (env: StateEnvironment, warn?: (line: string) => void) =>
  <T>(read: () => T): T => {
    let lock: FileLock | undefined;
    try {
      lock = claimFileLock(grantsLockPath(env), { waitMs: GRANTS_LOCK_WAIT_MS });
    } catch (error) {
      if (!(error instanceof FileLockHeldError)) {
        throw error;
      }
      warn?.(`${error.lockPath} was still held after ${GRANTS_LOCK_WAIT_MS}ms; reading grants without it.`);
    }
    try {
      return read();
    } finally {
      lock?.release();
    }
  };
