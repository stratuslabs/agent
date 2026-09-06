import path from 'node:path';

import {
  FileLockBusyError,
  claimFileLock,
  stratusHomePath,
  type FileClaim,
  type StateEnvironment,
} from '@stratusagent/state';

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

export type HomeClaim = FileClaim;

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
 * The lock itself is `claimFileLock` — SQLite's own file lock, and the
 * reasoning for why it is that and not a pid file lives there. What this
 * adds is the policy: a claimed home is refused rather than waited for,
 * because two daemons is a state to report, and it is refused *by type* so
 * the caller can say who holds it while this only says that someone does.
 */
export const claimHome = (env: StateEnvironment): HomeClaim => {
  const lockPath = homeLockPath(env);
  try {
    return claimFileLock(lockPath);
  } catch (error) {
    if (error instanceof FileLockBusyError) {
      throw new HomeClaimedError(lockPath);
    }
    throw error;
  }
};
