import { chmodSync, mkdirSync, truncateSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { stratusHomePath, type StateEnvironment } from '@stratusagent/state';

const HOME_LOCK_FILENAME = 'stratusd.lock';

/** `~/.stratus/stratusd.lock` — held by the daemon serving that home. */
export const homeLockPath = (env: StateEnvironment): string =>
  path.join(stratusHomePath(env), HOME_LOCK_FILENAME);

/** Thrown by `claimHome` when another process holds the home. */
export class HomeClaimedError extends Error {
  constructor(lockPath: string) {
    super(`${lockPath} is held by another stratusd.`);
    this.name = 'HomeClaimedError';
  }
}

export interface HomeClaim {
  /**
   * Let the home go. Idempotent. A process that exits without calling it
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
 * tear, and a machine that dies leaves a file the next daemon can claim.
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
 * Claim a home for one daemon, exclusively, for as long as the claim is
 * held.
 *
 * Two daemons on one `~/.stratus` share a session store and a schedule
 * table with nothing coordinating them: each slot fires in whichever
 * process claims it first, each start sweep re-asks the approvals the
 * other is holding, and the newer one's abandoned sweep fails turns the
 * older one is still running. Reproduced against a running daemon: a
 * second `stratus serve` lost the port to the first and served on with
 * no channel, and the next scheduled firing ran in it.
 *
 * The claim is SQLite's own file lock (see `claimAt`), which gives three
 * things a pid file cannot. It is atomic across processes — two starters
 * cannot both read it as stale and both take it, the case
 * `ensureGatewayToken` spells out for the token file. It covers the whole
 * lifetime: released after the store closes, so a daemon still draining
 * its last turn holds the home against its replacement. And a daemon that
 * dies releases it with its descriptors, so it is never stale. The
 * discovery file could do none of this — it appears after the API binds
 * and goes when the API stops, both inside the window that matters.
 *
 * The file is disposable, since nothing is ever written to it. One that is
 * not a database any more — damaged from outside, or left by something
 * that was not this — is emptied in place and claimed: nobody can be
 * holding it, because holding it needed the header this read refused.
 * Emptied, never removed and recreated: the OS lock lives on the inode,
 * and a starter that unlinked the file would hand every later starter an
 * inode of its own to hold. Two starters that read the same damage both
 * empty the same file — the second finds it already empty, which is a
 * valid database — and then contend for the one lock, where exactly one
 * wins. There is nothing to serialize and nothing that can be unlinked
 * from under a holder.
 */
export const claimHome = (env: StateEnvironment): HomeClaim => {
  const lockPath = homeLockPath(env);
  mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  let held: DatabaseSync | undefined;
  // At most twice: the file as found, then the file emptied in place.
  for (const emptied of [false, true]) {
    try {
      held = claimAt(lockPath);
      break;
    } catch (error) {
      if (isBusy(error)) {
        throw new HomeClaimedError(lockPath);
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
    throw new HomeClaimedError(lockPath);
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
