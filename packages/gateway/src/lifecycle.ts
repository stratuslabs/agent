/*
 * Restart, stop and pause: the errors a cut-short turn records, the drain
 * windows, what a restart or a roster reload reports, and the intake state a
 * paused daemon keeps on disk. Moved out of `index.ts` as is; `index.ts`
 * re-exports the public names, so the package's surface is unchanged.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  intakeStatePath,
  type StateEnvironment,
  syncDirectory,
  writeFileSynced,
} from '@stratusagent/state';

/** What a turn cut short by an announced restart records as its failure. */
export const RESTARTING_TURN_ERROR = 'Run aborted: stratusd is restarting';

/** The error a turn still running when a stop's drain window closes is aborted with. */
export const STOPPING_TURN_ERROR = 'Run aborted: stratusd is stopping';

/**
 * How long an announced restart lets in-flight turns finish before aborting
 * them. The same as a stop's window (`DEFAULT_STOP_DRAIN_TIMEOUT_MS`), so the
 * two windows an operator can hit agree.
 */
export const DEFAULT_RESTART_DRAIN_TIMEOUT_MS = 30_000;
/** How long a roster reload waits on one channel's `reload()`. */
export const DEFAULT_CHANNEL_RELOAD_TIMEOUT_MS = 30_000;

/**
 * What one channel did with a roster reload. `reloaded`: its `reload()`
 * resolved. `failed`: it rejected, with the reason. `still-reloading`: it
 * had not settled within `channelReloadTimeoutMs`, and finishes on its own.
 */
export interface ChannelReloadOutcome {
  name: string;
  outcome: 'reloaded' | 'failed' | 'still-reloading';
  reason?: string;
}

/**
 * How long a stop lets in-flight turns finish before aborting them. The
 * daemon's documented drain ("up to 30 seconds"), and shorter than the
 * service units' stop timeouts, so the abort happens in this process
 * rather than as the manager's SIGKILL. That matters beyond the turn's
 * record: a shell command runs in its own process group, which launchd's
 * kill of the job does not reach, so only the turn's abort stops it.
 */
export const DEFAULT_STOP_DRAIN_TIMEOUT_MS = 30_000;

export interface RestartRequest {
  /** Why, for the log — "plugin stratus-plugin-github enabled". */
  reason?: string;
  /** Overrides the gateway's drain window for this restart. */
  drainTimeoutMs?: number;
}

/** What `restart()` announced: the terms the drain is running under. */
export interface RestartStatus {
  reason?: string;
  drainTimeoutMs: number;
  /** Turns that were running when the restart was announced. */
  inflight: number;
}

/** What the host is handed once the daemon has stopped for a restart. */
export interface RestartOutcome {
  reason?: string;
  /**
   * Whether everything let go — every turn finished inside the window or
   * after being aborted at it, every channel stopped, and every plugin
   * released what it held. False means a turn ignored its abort for a
   * whole second window, or a channel's stop or a plugin's dispose never
   * settled or rejected, and the gateway shut down around it; a host
   * should exit the process rather than start a new daemon beside a turn
   * still writing, a channel still connected, or a plugin still holding a
   * browser or a socket.
   */
  drained: boolean;
}

/** Whether the daemon is taking new work. */
export interface IntakeState {
  paused: boolean;
  /** What a refused message is answered with. Present only while paused. */
  message?: string;
  /** When the pause began (ISO 8601). Present only while paused. */
  since?: string;
  /**
   * Whether this pause is the one the daemon started in because its intake
   * file could not be read. Reported while paused: true only for that pause,
   * false once a pause written since has replaced it, so `stratus doctor`
   * can tell a startup warning about the file from a pause someone chose.
   * Never written to the file.
   */
  unreadable?: boolean;
}

/** What a paused daemon says when nobody gave it a sentence of its own. */
export const DEFAULT_PAUSED_MESSAGE = "I'm paused right now and not taking new work. Please try again later.";

/** What a held gateway answers a dispatch with, before it is promoted. */
export const HELD_MESSAGE = "I'm starting up and not taking work yet. Please try again in a moment.";

/** The longest pause message, so a reply to a refused message stays one. */
export const MAX_PAUSED_MESSAGE_LENGTH = 500;

/** A pause message the gateway will not take: empty, or too long. */
export class PauseMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PauseMessageError';
  }
}

/**
 * A dispatch refused because intake is paused. Its message is the sentence
 * to show whoever sent the work, as it is: a channel posts it as the reply,
 * not as a failure.
 */
export class IntakePausedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntakePausedError';
  }
}

/**
 * A dispatch refused because the daemon is restarting or stopping. Channels
 * stay connected while a restart drains, so they hear people during it, and
 * this is what tells them the message reached a daemon on its way down: a
 * channel can say so and keep the message for the next one. Matched by name
 * there, as channel packages do not import the gateway.
 */
export class GatewayStoppingError extends Error {
  /** True for a restart, which comes back on its own; false for a stop. */
  readonly restarting: boolean;
  constructor(message: string, restarting: boolean) {
    super(message);
    this.name = 'GatewayStoppingError';
    this.restarting = restarting;
  }
}

/**
 * The intake state a previous process left, or open when there is none.
 *
 * Fails closed: a file that exists but cannot be read or parsed starts the
 * daemon paused, with a warning naming it. A pause exists to stop work (a
 * spending cap, a maintenance window), and a file nobody can read is no
 * evidence that it was lifted.
 */
export const readIntakeState = async (env: StateEnvironment, warn: (line: string) => void): Promise<IntakeState> => {
  const file = intakeStatePath(env);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { paused: false };
    }
    warn(`intake: ${file} could not be read (${(error as Error).message}); starting paused. Resume intake to clear it.`);
    return { paused: true, since: new Date().toISOString(), unreadable: true };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<IntakeState> | null;
    // Only a pause is ever written here (resuming removes the file), so
    // anything else in it is not a record this build wrote, and the same
    // rule as an unreadable file applies.
    if (typeof parsed !== 'object' || parsed === null || parsed.paused !== true) {
      warn(`intake: ${file} does not hold a pause record; starting paused. Resume intake to clear it.`);
      return { paused: true, since: new Date().toISOString(), unreadable: true };
    }
    return {
      paused: true,
      ...(typeof parsed.message === 'string' && parsed.message.trim().length > 0 ? { message: parsed.message } : {}),
      since: typeof parsed.since === 'string' ? parsed.since : new Date().toISOString(),
    };
  } catch {
    warn(`intake: ${file} is not valid JSON; starting paused. Resume intake to clear it.`);
    return { paused: true, since: new Date().toISOString(), unreadable: true };
  }
};

/**
 * Record a pause durably (0600, replaced in one atomic step), or remove the
 * record when intake reopens: open is the default, so nothing on disk
 * means open.
 */
export const writeIntakeState = async (env: StateEnvironment, state: IntakeState): Promise<void> => {
  const file = intakeStatePath(env);
  if (!state.paused) {
    await rm(file, { force: true });
    return;
  }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const staging = `${file}.${randomBytes(8).toString('hex')}`;
  try {
    await writeFileSynced(staging, `${JSON.stringify(state)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(staging, file);
    await syncDirectory(path.dirname(file));
  } finally {
    await rm(staging, { force: true });
  }
};

/**
 * `restart()` on a gateway whose host gave it no way back. Exported so the
 * control API can answer it as "not supported here" rather than as a
 * failure of the daemon.
 */
export class RestartUnsupportedError extends Error {
  constructor() {
    super(
      'This daemon cannot restart itself: the host that started it did not say how. '
      + 'Restart it from the service manager (stratus service stop, then start) or from the terminal it runs in.',
    );
    this.name = 'RestartUnsupportedError';
  }
}
