import {
  carriesKey,
  latestTurnReply,
  leastTrusted,
  sessionWriteTrust,
  startsTurn,
  turnMessageOf,
  turnReplyFor,
  workItemState,
  type Session,
  type TaskEvent,
  type TaskEventType,
  type TrustLevel,
} from '@stratusagent/core';

import { isOpenTaskStatus, type SqliteTaskStore, type TaskDelivery, type TaskRow, type TaskStatus } from './tasks.ts';

// Settling a background task: the one
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
  /** Why an interrupted task ended, or that a cancelled one never started. */
  why?: 'never-started' | 'cut-off' | 'lost-in-restore';
}

const inFlight = (session: Pick<Session, 'status'>): boolean =>
  session.status === 'running' || session.status === 'pending_approval';

/**
 * Responses the worker's turn took: each run of assistant messages after
 * its start message, since one response's parts are saved together.
 */
export const taskSteps = (worker: Pick<Session, 'messages'>): number => {
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
  const steps = worker === undefined ? 0 : taskSteps(worker);
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
    return { status: 'cancelled', steps, stoppedBy: row.stoppedBy, ...(start === undefined ? { why: 'never-started' as const } : {}) };
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
 * What a stopped worker's turn fails with: the abort reason a cancel gives
 * its signal and its running turn. Settling reads the stop from the row,
 * not from this text; it is what the worker session says.
 */
export const taskStoppedError = (taskId: string, stoppedBy: string): string =>
  `Background task ${taskId} was stopped ${stopper(stoppedBy)}.`;

/** A follow-up `agent.messageTask` queued for a task: what it said, and the label it carries. */
export interface TaskFollowUp {
  text: string;
  trust: TrustLevel;
}

/** What the outcome says, inside the notice's brackets. */
const outcomeText = (head: string, outcome: TaskOutcome): string => {
  switch (outcome.status) {
    case 'completed': {
      const late = outcome.stoppedBy !== undefined ? ` The stop ${stopper(outcome.stoppedBy)} came after it had finished.` : '';
      return `${head} completed after ${stepsText(outcome.steps)}.${late}\nResult: ${capped(outcome.reply ?? '(no reply)')}`;
    }
    case 'failed':
      return `${head} failed after ${stepsText(outcome.steps)}.\nError: ${capped(outcome.error ?? 'The task failed.')}`;
    case 'cancelled': {
      const by = stopper(outcome.stoppedBy ?? 'agent');
      if (outcome.why === 'never-started') {
        return `${head} was stopped ${by} before it started.`;
      }
      return outcome.steps === 0
        ? `${head} was stopped ${by} before its first step finished.`
        : `${head} was stopped ${by} after ${stepsText(outcome.steps)}.`;
    }
    case 'interrupted':
      if (outcome.why === 'never-started') {
        // A restart before the turn began, or a start that failed in this
        // process (the agent gone, its provider unset): the row can't tell
        // which, and nothing of the task ran either way.
        return `${head} never started: its turn did not begin. It was not run.`;
      }
      return outcome.why === 'lost-in-restore'
        ? `${head} was interrupted after ${stepsText(outcome.steps)}: its result was lost in a restore, and it was not run again.`
        : `${head} was interrupted after ${stepsText(outcome.steps)}: a restart cut it off, and it was not run again.`;
  }
};

/**
 * The runtime notice for an outcome, from the row and the outcome, so
 * settling after a crash builds the same text again; plus the follow-ups
 * the task ended without reading, listed so the conversation can start a
 * new task or tell the person. Those live in memory, so a notice a restart
 * sends again lists none.
 */
export const taskNoticeText = (
  row: Pick<TaskRow, 'id' | 'workerAgentId'>,
  outcome: TaskOutcome,
  unread: readonly string[] = [],
): string => {
  const text = outcomeText(`Background task ${row.id} (${row.workerAgentId})`, outcome);
  if (unread.length === 0) {
    return `[${text}]`;
  }
  const count = unread.length === 1 ? '1 follow-up' : `${unread.length} follow-ups`;
  // One budget for the whole list, not one each: a task on a provider that
  // reads none mid-task can end with any number of them.
  const listed = capped(unread.map((followUp) => `- ${followUp}`).join('\n'));
  return `[${text}\n${count} sent with agent.messageTask never reached it, because it ended first:\n${listed}]`;
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
  /**
   * The follow-ups the task's worker ended without reading, for the notice,
   * judged against `worker`, its session as settling read it. None when the
   * host keeps none.
   */
  unreadFollowUps?(taskId: string, worker: Session | undefined): readonly TaskFollowUp[];
  /** Send a task event on the gateway's bus. */
  emit(event: TaskEvent): Promise<void>;
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

const ENDED_EVENT: Record<FinalTaskStatus, TaskEventType> = {
  completed: 'task.completed',
  failed: 'task.failed',
  cancelled: 'task.cancelled',
  interrupted: 'task.interrupted',
};

/** A task event for `row`: ids only, never what it was asked or answered. */
export const taskEvent = (type: TaskEventType, row: TaskRow): TaskEvent => ({
  type,
  sessionId: row.originSessionId,
  agentId: row.agentId,
  taskId: row.id,
  workerSessionId: row.workerSessionId,
  workerAgentId: row.workerAgentId,
});

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
    // The row read again, with nothing awaited between this and the status
    // write: a stop a cancel recorded while this settle waited on the
    // sessions counts, so the row never ends `interrupted` or `failed` with
    // a stop on it, and a cancel after this write finds the row final.
    const outcome = deriveTaskOutcome(host.tasks.get(taskId) ?? row, worker);
    if (outcome === undefined) {
      host.warn(`task ${taskId}: its worker turn is still in flight after the startup sweep failed it; left for the next start.`);
      return { kind: 'open', task: row };
    }
    const ended = host.tasks.setStatus(taskId, outcome.status, now());
    row = host.tasks.get(taskId) ?? row;
    // Only when this write ended it: a notice sent again after a crash is
    // the same end, already announced.
    if (ended) {
      await host.emit(taskEvent(ENDED_EVENT[outcome.status], row));
    }
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
    const unread = host.unreadFollowUps?.(taskId, worker) ?? [];
    const base = {
      taskId,
      sessionId: task.originSessionId,
      agentId: origin.agent.id,
      text: taskNoticeText(task, outcome, unread.map((followUp) => followUp.text)),
      // A follow-up it lists is the conversation's own words, under the
      // label they were sent with.
      trust: leastTrusted(quotesWorker && worker !== undefined ? sessionWriteTrust(worker) : 'agent', ...unread.map((followUp) => followUp.trust)),
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
