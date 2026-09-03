import { chmodSync, mkdirSync } from 'node:fs';
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
const isBusy = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { errcode?: unknown }).errcode === 5;

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
 * The claim is an SQLite file in EXCLUSIVE locking mode: the first write
 * takes the OS file lock and the connection keeps it until it closes. That
 * gives three things a pid file cannot. It is atomic across processes —
 * two starters cannot both read it as stale and both take it, the case
 * `ensureGatewayToken` spells out for the token file. It covers the whole
 * lifetime: released after the store closes, so a daemon still draining
 * its last turn holds the home against its replacement. And a daemon that
 * dies releases it with its descriptors, so it is never stale. The
 * discovery file could do none of this — it appears after the API binds
 * and goes when the API stops, both inside the window that matters.
 */
export const claimHome = (env: StateEnvironment): HomeClaim => {
  const lockPath = homeLockPath(env);
  mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(lockPath);
  try {
    // The first read takes a SHARED lock that is never dropped; the first
    // write, an EXCLUSIVE one held until close. A holder anywhere makes
    // the next statement fail with SQLITE_BUSY at once — node:sqlite waits
    // for nothing by default.
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    // Nothing here needs to survive a crash, and a rollback journal beside
    // the lock would outlive the claim.
    db.exec('PRAGMA journal_mode = MEMORY');
    db.exec('CREATE TABLE IF NOT EXISTS holder (pid INTEGER NOT NULL)');
    db.exec('DELETE FROM holder');
    db.prepare('INSERT INTO holder (pid) VALUES (?)').run(process.pid);
  } catch (error) {
    db.close();
    if (isBusy(error)) {
      throw new HomeClaimedError(lockPath);
    }
    throw error;
  }
  // Created under the umask, like every other file SQLite makes; tightened
  // to match the rest of ~/.stratus. It holds a pid, nothing more.
  chmodSync(lockPath, 0o600);

  let released = false;
  return {
    release() {
      if (released) {
        return;
      }
      released = true;
      db.close();
    },
  };
};
