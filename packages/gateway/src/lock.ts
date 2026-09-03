import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { stratusHomePath, type StateEnvironment } from '@stratusagent/state';

const HOME_LOCK_FILENAME = 'stratusd.lock';
/** Beside the lock, held only while a damaged lock file is being replaced. */
const REPAIR_SUFFIX = '.repair';

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
 * Replace a lock file that is not a database and claim the replacement —
 * under a second claim, on a sibling file, so only one starter does it.
 *
 * Two starters can both have read the same damaged file. Without this,
 * the first removes it and claims a fresh one, and the second, acting on
 * its own earlier error, removes *that* — the file the first now holds —
 * and claims yet another: two daemons on two inodes, one home. So the
 * repair is serialized on `<lock>.repair` (never written either), and the
 * lock is tried once more under it before anything is removed: a file
 * that is by then the fresh one is claimed, or refused because its holder
 * is the starter that got there first. The loser is refused as a daemon
 * still starting, which by then it is.
 */
const replaceDamaged = (lockPath: string): DatabaseSync => {
  let repair: DatabaseSync;
  try {
    repair = claimAt(`${lockPath}${REPAIR_SUFFIX}`);
  } catch (error) {
    if (isBusy(error)) {
      throw new HomeClaimedError(lockPath);
    }
    throw error;
  }
  try {
    try {
      return claimAt(lockPath);
    } catch (error) {
      if (isBusy(error)) {
        throw new HomeClaimedError(lockPath);
      }
      if (!isNotADatabase(error)) {
        throw error;
      }
    }
    rmSync(lockPath, { force: true });
    try {
      return claimAt(lockPath);
    } catch (error) {
      if (isBusy(error)) {
        throw new HomeClaimedError(lockPath);
      }
      throw error;
    }
  } finally {
    repair.close();
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
 * that was not this — is replaced and claimed: nobody can be holding it,
 * because holding it needed the header this read refused.
 */
export const claimHome = (env: StateEnvironment): HomeClaim => {
  const lockPath = homeLockPath(env);
  mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  let held: DatabaseSync;
  try {
    held = claimAt(lockPath);
  } catch (error) {
    if (isBusy(error)) {
      throw new HomeClaimedError(lockPath);
    }
    if (!isNotADatabase(error)) {
      throw error;
    }
    held = replaceDamaged(lockPath);
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
