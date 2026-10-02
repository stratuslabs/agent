import path from 'node:path';

import { claimFileLock, FileLockHeldError, stratusHomePath, type StateEnvironment } from '@stratusagent/state';

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
 * The claim is SQLite's own file lock, `claimFileLock` in `state` — which
 * says what it gives that a pid file cannot, and how a damaged lock file is
 * reclaimed. Fail-fast, never waiting: a second daemon is refused, not
 * queued behind the first. Held for the whole lifetime, released after the
 * store closes, so a daemon still draining its last turn holds the home
 * against its replacement. The discovery file could not do this — it
 * appears after the API binds and goes when the API stops, both inside the
 * window that matters.
 */
export const claimHome = (env: StateEnvironment): HomeClaim => {
  try {
    return claimFileLock(homeLockPath(env));
  } catch (error) {
    if (error instanceof FileLockHeldError) {
      throw new HomeClaimedError(error.lockPath);
    }
    throw error;
  }
};
