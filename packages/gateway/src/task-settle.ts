import {
  carriesKey,
  latestTurnReply,
  sessionWriteTrust,
  startsTurn,
  turnMessageOf,
  turnReplyFor,
  workItemState,
  type Session,
  type TrustLevel,
} from '@stratusagent/core';

import { isOpenTaskStatus, type SqliteTaskStore, type TaskDelivery, type TaskRow, type TaskStatus } from './tasks.ts';

// Settling a background task (AGT-211, agent-plans
// roadmap/952-background-tasks.md, "Delivering the result"): the one
// function a worker turn's end and the startup sweep both run. It derives
// how the task ended from the worker session, writes that to the row, and
// gets the outcome into the origin session's transcript exactly once:
// dispatched under `task:<id>:outcome`, and when that turn fails or says
// nothing, written as a fallback under `task:<id>:outcome-fallback` and
// posted once. Every decision is read from the two transcripts, never from
// memory or from whether a call threw, so a crash between any two steps is
// repaired by settling again. The gateway supplies the session reads and
// writes (`TaskSettleHost`); nothing here knows about chains or channels.

/**
 * The one error a worker turn is failed with when a restart cut it off (the
 * startup sweep) or a drain ended it. Settling reads it back as
 * `interrupted`, so a crash during the sweep itself reads the same answer
 * the next time.
 */
export const TASK_CUT_OFF_ERROR = 'A restart cut this background task off before it finished. It was not run again.';

/** The most of a worker's reply or error a notice carries. */
export const TASK_RESULT_LIMIT_BYTES = 16 * 1024;

export const taskOutcomeKey = (taskId: string): string => `task:${taskId}:outcome`;
export const taskFallbackKey = (taskId: string): string => `task:${taskId}:outcome-fallback`;

export type FinalTaskStatus = Exclude<TaskStatus, 'running' | 'waiting_approval'>;

/** How a task ended, as its worker session tells it. */
export interface TaskOutcome {
  status: FinalTaskStatus;
  /** Responses the worker's turn took. */
  steps: number;
  /** A completed task's reply. */
  reply?: string;
  /** A failed task's error. */
  error?: string;
  /** Who stopped it: a cancelled task, or a completed one whose stop came after it finished. */
  stoppedBy?: string;
  /** Why an interrupted task ended. */
  why?: 'never-started' | 'cut-off' | 'lost-in-restore';
}

const inFlight = (session: Pick<Session, 'status'>): boolean =>
  session.status === 'running' || session.status === 'pending_approval';

/**
 * Responses the worker's turn took: each run of assistant messages after
 * its start message, since one response's parts are saved together.
 */
const stepsOf = (worker: Pick<Session, 'messages'>): number => {
  const start = worker.messages.findIndex(startsTurn);
  if (start < 0) {
    return 0;
  }
  let steps = 0;
  let inResponse = false;
  for (const message of worker.messages.slice(start + 1)) {
    if (message.role === 'assistant' && !inResponse) {
      steps += 1;
    }
    inResponse = message.role === 'assistant';
  }
  return steps;
};

/**
 * Step 1 of settling: the outcome the worker session says, or undefined
 * while a turn nobody stopped is still in flight. A stopped one in flight
 * is already `cancelled`: the stop was written before any abort, so a
 * crash before the abort took effect still reads as the stop it was. In
 * the spec's order: a turn that
 * finished is `completed` even when a stop was recorded (it lost the race);
 * anything else with a stop recorded is `cancelled`, a start that never
 * landed included; no start message is `interrupted`, never started; the
 * fixed cut-off error is `interrupted` (lost in a restore when the row had
 * already called it finished); any other failure is `failed`.
 */
export const deriveTaskOutcome = (
  row: Pick<TaskRow, 'status' | 'stoppedBy'>,
  worker: Pick<Session, 'status' | 'messages' | 'lastError'> | undefined,
): TaskOutcome | undefined => {
  const start = worker === undefined ? undefined : turnMessageOf(worker);
  const steps = worker === undefined ? 0 : stepsOf(worker);
  if (worker !== undefined && start !== undefined && (worker.status === 'completed' || worker.status === 'idle')) {
    const reply = latestTurnReply(worker);
    return {
      status: 'completed',
      steps,
      ...(reply !== undefined ? { reply } : {}),
      ...(row.stoppedBy !== undefined ? { stoppedBy: row.stoppedBy } : {}),
    };
  }
  if (row.stoppedBy !== undefined) {
    return { status: 'cancelled', steps, stoppedBy: row.stoppedBy };
  }
  if (worker === undefined || start === undefined) {
    return { status: 'interrupted', steps: 0, why: 'never-started' };
  }
  if (inFlight(worker)) {
    return undefined;
  }
  const error = start.turnError ?? worker.lastError ?? 'The task failed.';
  if (error === TASK_CUT_OFF_ERROR) {
    return { status: 'interrupted', steps, why: row.status === 'completed' || row.status === 'failed' ? 'lost-in-restore' : 'cut-off' };
  }
  return { status: 'failed', steps, error };
};

/** At most `TASK_RESULT_LIMIT_BYTES` of UTF-8, cut between characters, saying so when cut. */
const capped = (text: string): string => {
  const bytes = Buffer.byteLength(text);
  if (bytes <= TASK_RESULT_LIMIT_BYTES) {
    return text;
  }
  let kept = '';
  let used = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (used + size > TASK_RESULT_LIMIT_BYTES) {
      break;
    }
    kept += character;
    used += size;
  }
  return `${kept}\n(Cut at ${TASK_RESULT_LIMIT_BYTES / 1024} KB of ${Math.ceil(bytes / 1024)} KB.)`;
};

const stopper = (stoppedBy: string): string => {
  switch (stoppedBy) {
    case 'cli':
      return 'from the CLI';
    case 'dashboard':
      return 'from the dashboard';
    case 'agent':
      return 'by the agent';
    default:
      return `by ${stoppedBy}`;
  }
};

const stepsText = (steps: number): string => (steps === 1 ? '1 step' : `${steps} steps`);

/**
 * The runtime notice for an outcome, from the row and the outcome alone, so
 * settling after a crash builds the same text again.
 */
export const taskNoticeText = (row: Pick<TaskRow, 'id' | 'workerAgentId'>, outcome: TaskOutcome): string => {
  const head = `Background task ${row.id} (${row.workerAgentId})`;
  switch (outcome.status) {
    case 'completed': {
      const late = outcome.stoppedBy !== undefined ? ` The stop ${stopper(outcome.stoppedBy)} came after it had finished.` : '';
      return `[${head} completed after ${stepsText(outcome.steps)}.${late}\nResult: ${capped(outcome.reply ?? '(no reply)')}]`;
    }
    case 'failed':
      return `[${head} failed after ${stepsText(outcome.steps)}.\nError: ${capped(outcome.error ?? 'The task failed.')}]`;
    case 'cancelled': {
      const by = stopper(outcome.stoppedBy ?? 'agent');
      return outcome.steps === 0
        ? `[${head} was stopped ${by} before it started.]`
        : `[${head} was stopped ${by} after ${stepsText(outcome.steps)}.]`;
    }
    case 'interrupted':
      if (outcome.why === 'never-started') {
        return `[${head} never started: the daemon stopped before its turn began. It was not run.]`;
      }
      return outcome.why === 'lost-in-restore'
        ? `[${head} was interrupted after ${stepsText(outcome.steps)}: its result was lost in a restore, and it was not run again.]`
        : `[${head} was interrupted after ${stepsText(outcome.steps)}: a restart cut it off, and it was not run again.]`;
  }
};

/** The notice, or its fallback, on its way into the origin session. */
export interface TaskNotice {
  taskId: string;
  /** The origin session. */
  sessionId: string;
  /** The origin session's agent. */
  agentId: string;
  text: string;
  idempotencyKey: string;
  /**
   * The label the notice carries: the worker session's write label when it
   * quotes the worker's words (a reply or an error), else `agent`, since
   * every other notice is the runtime's own sentence.
   */
  trust: TrustLevel;
}

export interface TaskSettleHost {
  tasks: Pick<SqliteTaskStore, 'get' | 'setStatus' | 'setDelivery'>;
  getSession(sessionId: string): Promise<Session | undefined>;
  /**
   * Startup only: fail the worker turn the last process left in flight with
   * `error` (`recordTurnFailure`), durably, on the worker session's chain.
   * Never continued or re-asked.
   */
  failCutOffTurn(sessionId: string, error: string): Promise<void>;
  /**
   * Dispatch the notice into the origin session under its key, labeled
   * with its trust, queued behind any running turn. Resolves or rejects
   * once that turn ends; settling reads what happened from the transcript.
   */
  dispatchNotice(notice: TaskNotice): Promise<unknown>;
  /** Append the fallback to the origin transcript without a turn, under its key, on the origin's chain. */
  appendFallback(notice: TaskNotice): Promise<unknown>;
  /** Post the fallback to the origin conversation, once, best-effort. Rejects when the channel refused it. */
  postFallback(notice: TaskNotice): Promise<void>;
  now?(): string;
  warn(line: string): void;
}

export type TaskSettlement =
  | { kind: 'missing' }
  /** The worker's turn is still in flight; its end settles it. */
  | { kind: 'open'; task: TaskRow }
  | { kind: 'settled'; task: TaskRow; delivery: TaskDelivery };

/**
 * Where the origin transcript stands on this task's outcome: `delivered`
 * once the fallback is there or the keyed turn finished with a reply,
 * `needs-fallback` when the keyed turn finished without one (it failed,
 * or said nothing), `absent` while the key isn't there or its turn is
 * unfinished. A notice only queued behind a running turn is `absent`,
 * because that queue is in memory.
 */
const outcomeIn = (origin: Session, taskId: string): 'delivered' | 'needs-fallback' | 'absent' => {
  if (origin.messages.some((message) => carriesKey(message, taskFallbackKey(taskId)))) {
    return 'delivered';
  }
  const key = taskOutcomeKey(taskId);
  if (workItemState(origin, key) !== 'finished') {
    return 'absent';
  }
  return turnReplyFor(origin, key) !== undefined ? 'delivered' : 'needs-fallback';
};

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The settle function, one per gateway. Single-flight per task: a turn's
 * end and anything else asking at the same moment share one settlement, so
 * one process never dispatches a notice twice.
 */
export const createTaskSettler = (host: TaskSettleHost) => {
  const now = (): string => host.now?.() ?? new Date().toISOString();
  const running = new Map<string, Promise<TaskSettlement>>();

  const settleOnce = async (taskId: string, startup: boolean): Promise<TaskSettlement> => {
    let row = host.tasks.get(taskId);
    if (row === undefined) {
      return { kind: 'missing' };
    }
    if (!isOpenTaskStatus(row.status) && row.delivery !== 'pending') {
      return { kind: 'settled', task: row, delivery: row.delivery };
    }
    let worker = await host.getSession(row.workerSessionId);
    if (worker !== undefined && inFlight(worker)) {
      if (!startup) {
        host.tasks.setStatus(taskId, worker.status === 'pending_approval' ? 'waiting_approval' : 'running', now());
        return { kind: 'open', task: host.tasks.get(taskId) ?? row };
      }
      await host.failCutOffTurn(row.workerSessionId, TASK_CUT_OFF_ERROR);
      worker = await host.getSession(row.workerSessionId);
    }
    const outcome = deriveTaskOutcome(row, worker);
    if (outcome === undefined) {
      host.warn(`task ${taskId}: its worker turn is still in flight after the startup sweep failed it; left for the next start.`);
      return { kind: 'open', task: row };
    }
    host.tasks.setStatus(taskId, outcome.status, now());
    row = host.tasks.get(taskId) ?? row;
    if (row.delivery !== 'pending') {
      return { kind: 'settled', task: row, delivery: row.delivery };
    }

    const task = row;
    const settled = (): TaskSettlement => {
      const final = host.tasks.get(taskId) ?? task;
      return { kind: 'settled', task: final, delivery: final.delivery };
    };
    const dropped = (): TaskSettlement => {
      host.tasks.setDelivery(taskId, 'dropped', now());
      return settled();
    };

    let origin = await host.getSession(task.originSessionId);
    if (origin === undefined) {
      return dropped();
    }
    const quotesWorker = outcome.reply !== undefined || outcome.error !== undefined;
    const base = {
      taskId,
      sessionId: task.originSessionId,
      agentId: origin.agent.id,
      text: taskNoticeText(task, outcome),
      trust: quotesWorker && worker !== undefined ? sessionWriteTrust(worker) : 'agent',
    } satisfies Omit<TaskNotice, 'idempotencyKey'>;
    const notice = (idempotencyKey: string): TaskNotice => ({ ...base, idempotencyKey });

    let landed = outcomeIn(origin, taskId);
    if (landed === 'absent') {
      let refused: unknown;
      try {
        await host.dispatchNotice(notice(taskOutcomeKey(taskId)));
      } catch (error) {
        // A failed outcome turn rejects too; the transcript says which.
        refused = error;
      }
      origin = await host.getSession(task.originSessionId);
      if (origin === undefined) {
        return dropped();
      }
      landed = outcomeIn(origin, taskId);
      if (landed === 'absent') {
        host.warn(`task ${taskId}: its outcome notice did not reach ${task.originSessionId}; the next start sends it again under the same key${refused !== undefined ? ` (${reason(refused)})` : ''}.`);
        return settled();
      }
    }

    if (landed === 'needs-fallback') {
      const fallback = notice(taskFallbackKey(taskId));
      try {
        await host.appendFallback(fallback);
      } catch (error) {
        host.warn(`task ${taskId}: could not write the fallback notice into ${task.originSessionId}; the next start tries again (${reason(error)}).`);
        return settled();
      }
      origin = await host.getSession(task.originSessionId);
      if (origin === undefined) {
        return dropped();
      }
      if (!origin.messages.some((message) => carriesKey(message, fallback.idempotencyKey))) {
        host.warn(`task ${taskId}: the fallback notice is not in ${task.originSessionId} after writing it; the next start tries again.`);
        return settled();
      }
      // Posted once, best-effort, like every reply the runtime posts: the
      // transcript holds the outcome either way, and nothing records what a
      // channel took, so nothing posts it again.
      try {
        await host.postFallback(fallback);
      } catch (error) {
        host.warn(`task ${taskId}: the fallback notice is in ${task.originSessionId}, but posting it to the conversation failed: ${reason(error)}`);
      }
    }

    host.tasks.setDelivery(taskId, 'delivered', now());
    return settled();
  };

  return {
    /**
     * Settle one task: at a worker turn's end, or with `startup` from the
     * startup sweep, which alone may fail a worker turn the last process
     * left in flight.
     */
    settle(taskId: string, options: { startup?: boolean } = {}): Promise<TaskSettlement> {
      const current = running.get(taskId);
      if (current !== undefined) {
        return current;
      }
      const settling = settleOnce(taskId, options.startup === true).finally(() => {
        running.delete(taskId);
      });
      running.set(taskId, settling);
      return settling;
    },
  };
};
