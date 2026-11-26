import {
  carriesKey,
  leastTrusted,
  PENDING_APPROVAL_METADATA_KEY,
  recordTurnFailure,
  RunAbortedError,
  SENDER_TRUST_METADATA_KEY,
  turnMessageOf,
  type EventBus,
  type ObserveInput,
  type Session,
  type SteeredMessage,
  type TasksStop,
} from '@stratusagent/core';
import {
  type DelegateBackgroundStart,
  TASK_ID_METADATA_KEY,
  type TaskMessageAnswer,
  type TaskMessageInput,
  type TaskSummary,
  type TaskToolsHost,
} from '@stratusagent/agents';

import type { TaskApprovalWait } from './approvals.ts';
import { MERGED_SEPARATOR, MERGED_TEXT_BUDGET_CHARS } from './merge-batch.ts';
import type { ShardedSessionStore } from './sessions.ts';
import {
  createTaskSettler,
  deriveTaskOutcome,
  TASK_CUT_OFF_ERROR,
  taskEvent,
  taskSteps,
  taskStoppedError,
  type TaskFollowUp,
  type TaskNotice,
} from './task-settle.ts';
import { isOpenTaskStatus, newTaskId, SqliteTaskStore, taskPromptDigest, type TaskDelivery, type TaskRow, type TaskStatus } from './tasks.ts';
import type { DispatchInput, GatewayOptions } from './types.ts';

// Background tasks in the gateway: `agent.delegate`'s background hook.
// It claims the row, starts the worker on its own session chain without
// waiting for it, and settles the task on that chain when the worker's
// turn ends. A cancel (`cancel`) records its stop before it aborts
// anything, so settling reports it whatever happens next. Starting tasks is
// on unless `tasks.enabled` is false. The restart sweep runs either way:
// rows a process left before tasks were turned off still get settled, and
// their workers failed as cut off, never left running.
//
// Follow-ups (`agent.messageTask`) wait in memory, per task, until the
// worker's turn takes them at its next tool step through the same steer
// hook a person's follow-up uses. Any its turn ended without reading,
// judged from its transcript, are listed in the outcome notice. A restart
// loses them with the task, which is never run again; the conversation
// still holds the calls that sent them.

/** Open background tasks one agent may have unless `tasks.maxRunningPerAgent` names it. */
export const DEFAULT_MAX_RUNNING_TASKS_PER_AGENT = 3;

/** Finished tasks `agent.tasks` shows after the open and undelivered ones. */
export const TASKS_LIST_FINISHED_LIMIT = 10;

/** Finished tasks the operator's list (`stratus tasks`, `GET /api/v1/tasks`) shows after the open and undelivered ones. */
export const TASKS_OPERATOR_FINISHED_LIMIT = 20;

/**
 * One task as the operator sees it (`stratus tasks`, `GET /api/v1/tasks`):
 * ids, who, where and how it stands, never what was asked or answered (the
 * prompt and result stay in the two sessions). `status` is read live from
 * the worker session (`liveTaskStatus`).
 */
export interface TaskListing {
  id: string;
  /** The agent that started it. */
  agentId: string;
  /** The agent doing the work; may be the same. */
  workerAgentId: string;
  /** The conversation its outcome goes back to. */
  originSessionId: string;
  workerSessionId: string;
  status: TaskStatus;
  /** Whether the outcome is in that conversation's transcript: `pending`, `delivered`, or `dropped` once it is gone. */
  delivery: TaskDelivery;
  /** Who asked for a stop, once someone did. */
  stoppedBy?: string;
  /** Responses the worker's turn has taken so far. */
  steps: number;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
}

/** What a cancel did. */
export type TaskCancelResult =
  /** No such task, or not the asking agent's. */
  | { kind: 'missing' }
  /**
   * It had already ended, or its worker's turn had: nothing was written or
   * stopped. `status` is how it ended: the row's once settled, else what
   * the worker session says, which settling is about to write.
   */
  | { kind: 'finished'; task: TaskRow; status: TaskStatus }
  /**
   * The stop is recorded and the task's turn is being stopped; settling
   * reports it `cancelled`. `already` when an earlier cancel recorded it
   * (its stopper is kept); the abort is repeated either way.
   */
  | { kind: 'stopping'; task: TaskRow; already?: boolean };

export interface TaskCancelInput {
  /** Who asked: `cli`, `dashboard`, `agent`, or a person's chat id. Kept on the row and named in the notice. */
  stoppedBy: string;
  /** Only this agent's tasks: what an agent's own tool passes. Omitted, any task (the operator's authority). */
  agentId?: string;
}

/** What a follow-up says to the task, above the conversation's own words. */
export const TASK_FOLLOW_UP_HEADER = 'A follow-up about this task, from the conversation that asked for it:';

/**
 * One task's follow-ups while its worker runs here: those its turn hasn't
 * taken yet, those handed to it as one steered message each time, and
 * every key queued, so the same call is passed on once. `open` until the
 * worker's turn ends; after that nothing is queued, and what never reached
 * the turn goes into the outcome notice (`unreadOf`).
 */
interface FollowUps {
  open: boolean;
  queued: TaskFollowUp[];
  handed: Array<{ message: string; followUps: TaskFollowUp[] }>;
  keys: Set<string>;
}

/**
 * The follow-ups a worker's turn ended without reading: every batch handed
 * to it whose steered message isn't in its transcript, then every one never
 * handed over. A batch is handed over before the runner records it, and the
 * turn can stop in between (an abort, a failed save), so being handed over
 * isn't being read: only the transcript says that. Each steered message
 * there accounts for one batch with the same text.
 */
const unreadOf = (entry: FollowUps, worker: Pick<Session, 'messages'> | undefined): TaskFollowUp[] => {
  const recorded = (worker?.messages ?? [])
    .filter((message) => message.role === 'user' && message.steered === true)
    .map((message) => message.content);
  const lost = entry.handed.flatMap((batch) => {
    const at = recorded.indexOf(batch.message);
    if (at < 0) {
      return batch.followUps;
    }
    recorded.splice(at, 1);
    return [];
  });
  return [...lost, ...entry.queued];
};

/** What background tasks close over in `createGateway`. */
export interface BackgroundTasksDeps {
  options: GatewayOptions;
  /** `fleet.db`, where the task table lives next to the schedules. */
  fleetDb: string;
  stateHome: string;
  store: ShardedSessionStore;
  bus: Pick<EventBus, 'emit'>;
  /**
   * `conversation` and `steer` as in `TurnDispatch.dispatchInternal`:
   * `conversation` true only for a notice to a person's conversation,
   * `steer` only for a worker's turn, which takes its follow-ups through it.
   */
  dispatchInternal: (
    input: DispatchInput,
    conversation?: boolean,
    steer?: (turnSignal: AbortSignal) => Promise<SteeredMessage | undefined>,
  ) => Promise<Session>;
  onSessionChain: <T>(sessionId: string, work: () => Promise<T>) => Promise<T>;
  /**
   * The same chain, for a worker's turn: work a shutdown's drain doesn't
   * wait for, because `cutOff` ends it once the ordinary turns are done.
   */
  onWorkerChain: <T>(sessionId: string, work: () => Promise<T>) => Promise<T>;
  /** The keyed-dispatch check the public door makes: the finished or settled turn a key already names, else undefined. */
  settleRepeat: (sessionId: string, idempotencyKey: string, agentId: string | undefined) => Promise<Session | undefined>;
  /** The runner's own observe (not the channel-facing one): it takes the key. */
  observe: (input: ObserveInput) => Promise<Session>;
  /** Post a fallback notice to the origin's conversation, once. Rejects when there is nowhere to post it or the channel refused. */
  postToOrigin: (notice: TaskNotice) => Promise<void>;
  /** The gateway's `abortTurns`: aborts every turn running on a session with `reason`. */
  abortTurns: (sessionId: string, reason: string) => number;
  isStopping: () => boolean;
  refusal: () => Error;
  log: (line: string) => void;
  warn: (line: string) => void;
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * A task's status as its worker session tells it now, for what the agent
 * and the operator are shown. The row's once it is final. For an open row,
 * the row is a cache settling refreshes at the turn's end, so: a worker in
 * flight is `running`, or `waiting_approval` while parked on a person,
 * which the session says for a kernel-loop provider and the row says for
 * any (the broker writes it while the question is out, `approvalWait`); a
 * worker whose turn has ended reads how it ended, which settling is about
 * to write; a worker with no turn yet (a start still on its way) keeps the
 * row's status.
 */
export const liveTaskStatus = (
  row: Pick<TaskRow, 'status' | 'stoppedBy'>,
  worker: Pick<Session, 'status' | 'messages' | 'lastError'> | undefined,
): TaskStatus => {
  if (!isOpenTaskStatus(row.status) || worker === undefined) {
    return row.status;
  }
  if (worker.status === 'pending_approval') {
    return 'waiting_approval';
  }
  if (worker.status === 'running') {
    return row.status === 'waiting_approval' ? 'waiting_approval' : 'running';
  }
  if (turnMessageOf(worker) === undefined) {
    return row.status;
  }
  return deriveTaskOutcome(row, worker)?.status ?? row.status;
};

export const createBackgroundTasks = ({
  options,
  fleetDb,
  stateHome,
  store,
  bus,
  dispatchInternal,
  onSessionChain,
  onWorkerChain,
  settleRepeat,
  observe,
  postToOrigin,
  abortTurns,
  isStopping,
  refusal,
  log,
  warn,
}: BackgroundTasksDeps) => {
  const limits = options.tasks?.maxRunningPerAgent ?? {};
  // Checked whether or not tasks are on, so a bad value is found when it is
  // written, not on the day someone turns tasks on.
  if (typeof limits !== 'object' || limits === null || Array.isArray(limits)) {
    throw new Error(`tasks.maxRunningPerAgent must map agent ids to a number of running tasks, like { "atlas": 5 } (got ${JSON.stringify(limits)}).`);
  }
  for (const [agentId, limit] of Object.entries(limits)) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`tasks.maxRunningPerAgent.${agentId} must be a whole number of at least 1 (got ${String(limit)}).`);
    }
  }
  /** One agent's cap. Own keys only: an agent id like `constructor` doesn't pick up an inherited property. */
  const capFor = (agentId: string): number =>
    Object.hasOwn(limits, agentId) ? limits[agentId]! : DEFAULT_MAX_RUNNING_TASKS_PER_AGENT;
  const enabled = options.tasks?.enabled !== false;
  const named = Object.entries(limits).map(([agentId, limit]) => `${agentId} ${limit}`).join(', ');
  /** The startup line: whether agents may start tasks, and each cap. */
  const summary = enabled
    ? `background tasks: on, up to ${DEFAULT_MAX_RUNNING_TASKS_PER_AGENT} running per agent${named.length > 0 ? ` (${named})` : ''}`
    : 'background tasks: off (tasks.enabled is false)';

  // Its own connection to fleet.db, like the schedule and event stores.
  // Opened whether or not tasks are on, for the restart sweep.
  const tasks = new SqliteTaskStore(fleetDb, { stateHome });
  /** Each running task's own stop, for a cancel and the drain (`cutOff`). */
  const controllers = new Map<string, AbortController>();
  /** The task each running worker session is doing, while its turn runs: what an approval question names. */
  const workers = new Map<string, string>();
  /**
   * Each task with questions out: how many, and its mark as waiting on a
   * person, which every question awaits before it is asked. The first
   * question makes the mark and the last answer clears it.
   */
  const approvalWaits = new Map<string, { out: number; marked: Promise<void> }>();
  /** Each task started here: its follow-ups, from its start until it is settled. */
  const followUps = new Map<string, FollowUps>();

  /**
   * A worker turn's steer hook: the follow-ups queued for its task, oldest
   * first, as one steered message labeled with the least trusted sender's
   * label. At most a merged message's worth (`MERGED_TEXT_BUDGET_CHARS`),
   * for the reason a merged batch is held to it: overflow recovery can't
   * trim the newest message. The rest wait for the next step, and one
   * longer than that on its own goes alone. No dispatch keys go with it: a
   * worker's turn stays unkeyed, which is what keeps a restart from ever
   * continuing it. Nothing is taken into a turn already stopping, or while
   * the gateway stops.
   */
  const steerFor = (taskId: string) => async (turnSignal: AbortSignal): Promise<SteeredMessage | undefined> => {
    const entry = followUps.get(taskId);
    if (entry === undefined || !entry.open || entry.queued.length === 0 || turnSignal.aborted || isStopping()) {
      return undefined;
    }
    const parts: string[] = [];
    let chars = 0;
    for (const followUp of entry.queued) {
      const part = `${TASK_FOLLOW_UP_HEADER}\n${followUp.text}`;
      const size = (parts.length > 0 ? MERGED_SEPARATOR.length : 0) + part.length;
      if (parts.length > 0 && chars + size > MERGED_TEXT_BUDGET_CHARS) {
        break;
      }
      parts.push(part);
      chars += size;
    }
    const taken = entry.queued.splice(0, parts.length);
    const userMessage = parts.join(MERGED_SEPARATOR);
    // Unread until the transcript shows it: see `unreadOf`.
    entry.handed.push({ message: userMessage, followUps: taken });
    log(`task ${taskId}: ${taken.length} follow-up(s) handed to its worker at its next step`);
    return {
      userMessage,
      metadata: { [SENDER_TRUST_METADATA_KEY]: leastTrusted(...taken.map((followUp) => followUp.trust)) },
    };
  };

  const settler = createTaskSettler({
    tasks,
    getSession: (sessionId) => store.get(sessionId),
    // The startup sweep's, which settles on the worker's chain already, so
    // this doesn't queue on it again. A parked worker's checkpoint is spent
    // with it, as the parked-turn sweep spends one it fails: nothing may
    // pick that call up again.
    async failCutOffTurn(sessionId, error) {
      const worker = await store.get(sessionId);
      if (worker === undefined || (worker.status !== 'running' && worker.status !== 'pending_approval')) {
        return;
      }
      if (worker.metadata?.[PENDING_APPROVAL_METADATA_KEY] !== undefined) {
        const metadata = { ...worker.metadata };
        delete metadata[PENDING_APPROVAL_METADATA_KEY];
        worker.metadata = metadata;
      }
      recordTurnFailure(worker, error);
      await store.save(worker);
      await bus.emit({ type: 'session.updated', sessionId, status: 'failed' });
      await bus.emit({ type: 'session.failed', sessionId, error });
    },
    // Queued behind any running turn on the origin's chain, the way a
    // scheduled firing is, and answered from the transcript when the key
    // is already there: a repeat after a crash never runs a second turn.
    dispatchNotice(notice) {
      if (isStopping()) {
        return Promise.reject(refusal());
      }
      return onSessionChain(notice.sessionId, async () => {
        const repeated = await settleRepeat(notice.sessionId, notice.idempotencyKey, notice.agentId);
        if (repeated !== undefined) {
          return repeated;
        }
        // A conversation turn: the outcome lands where a person asked for
        // the work, so an agent with a front writes it up there as its front.
        return dispatchInternal({
          sessionId: notice.sessionId,
          agentId: notice.agentId,
          userMessage: notice.text,
          idempotencyKey: notice.idempotencyKey,
          metadata: { [SENDER_TRUST_METADATA_KEY]: notice.trust },
        }, true);
      });
    },
    appendFallback(notice) {
      return onSessionChain(notice.sessionId, async () => {
        const origin = await store.get(notice.sessionId);
        // Settling is single-flight, but a second process (a restore
        // started beside this one) could get here first: written once.
        if (origin?.messages.some((message) => carriesKey(message, notice.idempotencyKey))) {
          return origin;
        }
        return observe({
          sessionId: notice.sessionId,
          message: notice.text,
          metadata: { [SENDER_TRUST_METADATA_KEY]: notice.trust },
          idempotencyKey: notice.idempotencyKey,
        });
      });
    },
    postFallback: (notice) => postToOrigin(notice),
    // Only once the worker's turn has ended: until then, a follow-up still
    // queued may yet be read.
    unreadFollowUps: (taskId, worker) => {
      const entry = followUps.get(taskId);
      return entry === undefined || entry.open ? [] : unreadOf(entry, worker);
    },
    emit: (event) => bus.emit(event),
    warn,
  });

  /** Settle one task at its worker's turn end. Never rejects: what went wrong is logged with the task id. */
  const settleQuietly = async (taskId: string): Promise<void> => {
    try {
      const settled = await settler.settle(taskId);
      if (settled.kind === 'open') {
        warn(`task ${taskId}: its worker's turn ended, but the worker session still says it is in flight; left for the next start.`);
      } else {
        followUps.delete(taskId);
      }
    } catch (error) {
      warn(`task ${taskId}: settling failed; the next start tries again (${reason(error)}).`);
    }
  };

  const startTask: DelegateBackgroundStart = async ({ origin, agent, prompt, workerSessionId, metadata }) => {
    if (isStopping()) {
      throw refusal();
    }
    // Made before the row is written, so a cancel that finds the row always
    // finds its stop.
    const controller = new AbortController();
    const id = newTaskId();
    const claim = tasks.claim({
      id,
      agentId: origin.agent.id,
      workerAgentId: agent.id,
      originSessionId: origin.id,
      workerSessionId: workerSessionId(id),
      promptDigest: taskPromptDigest(agent.id, prompt),
    }, capFor(origin.agent.id), new Date().toISOString());
    if (claim.kind === 'full') {
      throw new Error(
        `${origin.agent.id} already has ${claim.running} background tasks running, the most it may `
        + `(tasks.maxRunningPerAgent is ${claim.cap}). Wait for one to end, its result arrives in its conversation, `
        + 'or tell the person.',
      );
    }
    if (claim.kind === 'existing') {
      return { task: claim.task.id, status: claim.task.status, existing: true };
    }

    const task = claim.task;
    controllers.set(task.id, controller);
    workers.set(task.workerSessionId, task.id);
    followUps.set(task.id, { open: true, queued: [], handed: [], keys: new Set() });
    // Before the worker is dispatched, so a consumer hears the start before
    // anything the worker does, and before its end.
    await bus.emit(taskEvent('task.started', task));
    // Not awaited: the turn that asked gets its task id now. On the
    // worker's own chain, so the settle after it is on the same chain. A
    // shutdown doesn't wait for it: it cuts it off (`cutOff`).
    void onWorkerChain(task.workerSessionId, async () => {
      try {
        // Dispatched once, by the call that wrote the row, and with no
        // idempotency key: the generic abandoned-turn sweep fails an
        // unkeyed turn rather than continuing it, so no build reruns a
        // worker after a crash.
        await dispatchInternal({
          sessionId: task.workerSessionId,
          agentId: agent.id,
          userMessage: prompt,
          metadata: { ...metadata, [TASK_ID_METADATA_KEY]: task.id },
          signal: controller.signal,
        }, false, steerFor(task.id));
      } catch (error) {
        // How it ended is read from the worker session. This line is for a
        // start that failed before its turn began, which the session can't say.
        warn(`task ${task.id}: the worker's turn ended with an error: ${reason(error)}`);
      } finally {
        controllers.delete(task.id);
        workers.delete(task.workerSessionId);
        // Its turn reads nothing more: what is still queued is unread.
        const entry = followUps.get(task.id);
        if (entry !== undefined) {
          entry.open = false;
        }
      }
      await settleQuietly(task.id);
    }).catch((error: unknown) => {
      warn(`task ${task.id}: ${reason(error)}`);
    });
    return { task: task.id, status: task.status };
  };

  /**
   * Cancel one task: the one function every way of stopping a task calls
   * (the agent's tool, a person's Stop, the CLI, the control API).
   *
   * 1. Re-read the worker session. If its turn already reached a final
   *    state, the task already finished: nothing is written, and settling
   *    reports its result.
   * 2. Record the stop on the row if it is still open. That write is durable
   *    before anything is aborted, so settling reports `cancelled` whatever
   *    happens next, a crash before the abort included. The one exception is
   *    a turn that finishes on its own before the abort reaches it, which
   *    reports its result.
   * 3. Abort the task's own signal, which refuses a start that hasn't begun
   *    its turn and stops one that has, then the worker session's running
   *    turns, as a backstop.
   *
   * Not queued on the worker session's chain: the worker's turn holds that
   * chain until it ends, so a cancel queued there would wait for the turn
   * it means to stop. It needs no lock either. Settling derives the status
   * from a fresh read of the row and writes it with nothing awaited in
   * between, and `recordStop` writes only an open row, so a stop lands
   * either before that write, and counts, or after it, and finds the task
   * finished.
   */
  const cancel = async (taskId: string, { stoppedBy, agentId }: TaskCancelInput): Promise<TaskCancelResult> => {
    // The row keeps '' for "no stop", so an empty stopper would read as none.
    if (typeof stoppedBy !== 'string' || stoppedBy.trim() === '') {
      throw new Error('A task cancel must say who asked for it (stoppedBy), like "cli" or a person\'s chat id.');
    }
    const row = tasks.get(taskId);
    if (row === undefined || (agentId !== undefined && row.agentId !== agentId)) {
      return { kind: 'missing' };
    }
    if (!isOpenTaskStatus(row.status)) {
      return { kind: 'finished', task: row, status: row.status };
    }
    const worker = await store.get(row.workerSessionId);
    if (worker !== undefined && turnMessageOf(worker) !== undefined && worker.status !== 'running' && worker.status !== 'pending_approval') {
      const latest = tasks.get(taskId) ?? row;
      return { kind: 'finished', task: latest, status: liveTaskStatus(latest, worker) };
    }
    const recorded = tasks.recordStop(taskId, stoppedBy, new Date().toISOString());
    const current = tasks.get(taskId) ?? row;
    if (!isOpenTaskStatus(current.status) || current.stoppedBy === undefined) {
      // Settling wrote a final status while this read the worker session.
      return { kind: 'finished', task: current, status: current.status };
    }
    const why = taskStoppedError(taskId, current.stoppedBy);
    const controller = controllers.get(taskId);
    if (controller !== undefined && !controller.signal.aborted) {
      controller.abort(new RunAbortedError(why));
    }
    abortTurns(row.workerSessionId, why);
    return { kind: 'stopping', task: current, ...(recorded ? {} : { already: true }) };
  };

  /**
   * A person's Stop in a conversation, for the tasks that conversation
   * started (decision 3): each one running in this process is cancelled
   * through `cancel`, as `stoppedBy`. `open` is counted before anything is
   * awaited, so a channel can tell at once whether there was anything to
   * stop. It includes a task an earlier stop reached that is still winding
   * down, the way `abortTurns` counts a stopped turn until it ends. A row no
   * worker here is running (one the last process left) isn't counted or
   * stopped: the restart sweep settles it. `stopped` names the tasks whose
   * stop this call wrote, and never rejects.
   */
  const stopTasks = (originSessionId: string, stoppedBy: string): TasksStop => {
    let running: TaskRow[];
    try {
      running = tasks.openForOrigin(originSessionId).filter((row) => controllers.has(row.id));
    } catch (error) {
      warn(`background tasks: could not read the tasks ${originSessionId} started, so a stop there reached none: ${reason(error)}`);
      return { open: 0, stopped: Promise.resolve([]) };
    }
    const stopped = Promise.all(running.map(async (row) => {
      try {
        const result = await cancel(row.id, { stoppedBy });
        return result.kind === 'stopping' && result.already !== true ? row.id : undefined;
      } catch (error) {
        warn(`task ${row.id}: the stop from ${stoppedBy} could not be recorded, so it keeps running: ${reason(error)}`);
        return undefined;
      }
    })).then((ids) => ids.filter((id): id is string => id !== undefined));
    return { open: running.length, stopped };
  };

  /**
   * A worker's approval question: the task its session is
   * running, marked `waiting_approval` until `release`, with
   * `task.waiting-approval` sent before the question goes out. Only a
   * worker this process is running asks: the restart sweep fails a parked
   * worker rather than asking again. With several questions out at once,
   * the first marks the task, each waits for that mark to be announced (so
   * no question goes out before its task says it waits), and the last
   * answer puts it back to running; a task settling has ended since stays
   * ended (`setStatus` never reopens a final row). A row that can't be
   * written is logged and the question is still asked.
   */
  const approvalWait = async (workerSessionId: string): Promise<TaskApprovalWait | undefined> => {
    const taskId = workers.get(workerSessionId);
    if (taskId === undefined) {
      return undefined;
    }
    let wait = approvalWaits.get(taskId);
    if (wait === undefined) {
      const mark = async (): Promise<void> => {
        try {
          const row = tasks.setStatus(taskId, 'waiting_approval', new Date().toISOString()) ? tasks.get(taskId) : undefined;
          if (row !== undefined) {
            await bus.emit(taskEvent('task.waiting-approval', row));
          }
        } catch (error) {
          warn(`task ${taskId}: could not mark it waiting on an approval: ${reason(error)}`);
        }
      };
      wait = { out: 0, marked: mark() };
      approvalWaits.set(taskId, wait);
    }
    const entry = wait;
    entry.out += 1;
    await entry.marked;
    let released = false;
    return {
      taskId,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        entry.out -= 1;
        if (entry.out > 0) {
          return;
        }
        approvalWaits.delete(taskId);
        try {
          tasks.setStatus(taskId, 'running', new Date().toISOString());
        } catch (error) {
          warn(`task ${taskId}: could not mark it running again after its approval: ${reason(error)}`);
        }
      },
    };
  };

  /** A row's status and steps as its worker session tells them now. */
  const liveOf = async (row: TaskRow): Promise<{ status: TaskStatus; steps: number }> => {
    const worker = await store.get(row.workerSessionId);
    return { status: liveTaskStatus(row, worker), steps: worker === undefined ? 0 : taskSteps(worker) };
  };

  /**
   * `agent.messageTask`: queue a follow-up for a task's running turn, which
   * takes it at its next tool step (`steerFor`).
   *
   * Only the agent's own task, and only from the conversation that started
   * it: a task id seen in another conversation can't steer the work. A task
   * that ended, whose turn ended, that a stop was asked for, or that no
   * worker here is running (one the last process left) takes nothing, and
   * says so. While it still takes them, the same key twice is queued once,
   * so a call run again is not passed on again.
   *
   * Every check after the session read is made again against the row and
   * the queue with nothing awaited before the push, so a follow-up is
   * either queued while the turn can still read it or listed when it ends,
   * never lost between the two.
   */
  const message = async ({ taskId, agentId, originSessionId, text, trust, key }: TaskMessageInput): Promise<TaskMessageAnswer> => {
    if (isStopping()) {
      throw refusal();
    }
    const row = tasks.get(taskId);
    if (row === undefined || row.agentId !== agentId) {
      return { kind: 'missing' };
    }
    if (row.originSessionId !== originSessionId) {
      return { kind: 'elsewhere' };
    }
    const worker = await store.get(row.workerSessionId);
    const current = tasks.get(taskId) ?? row;
    const entry = followUps.get(taskId);
    if (!isOpenTaskStatus(current.status)) {
      return { kind: 'ended', status: current.status };
    }
    if (current.stoppedBy !== undefined) {
      return { kind: 'stopping' };
    }
    const turnEnded = worker !== undefined && turnMessageOf(worker) !== undefined
      && worker.status !== 'running' && worker.status !== 'pending_approval';
    if (entry === undefined || !entry.open || turnEnded) {
      return { kind: 'ended', status: liveTaskStatus(current, worker) };
    }
    if (key !== undefined && entry.keys.has(key)) {
      return { kind: 'queued', status: liveTaskStatus(current, worker), already: true };
    }
    if (key !== undefined) {
      entry.keys.add(key);
    }
    entry.queued.push({ text, trust });
    return { kind: 'queued', status: liveTaskStatus(current, worker) };
  };

  /**
   * What `agent.tasks`, `agent.cancelTask` and `agent.messageTask` reach,
   * scoped to the calling agent. A listed task's status is read live from
   * its worker session (`liveTaskStatus`): the row learns a parked worker
   * or a finished turn only when settling runs.
   */
  const toolsHost: TaskToolsHost = {
    async list(agentId) {
      const rows = tasks.list(agentId, TASKS_LIST_FINISHED_LIMIT);
      return Promise.all(rows.map(async (row): Promise<TaskSummary> => {
        const { status, steps } = await liveOf(row);
        return {
          task: row.id,
          status,
          worker: row.workerAgentId,
          startedAt: row.createdAt,
          ...(row.endedAt !== undefined ? { endedAt: row.endedAt } : {}),
          steps,
          delivery: row.delivery,
          ...(row.stoppedBy !== undefined ? { stoppedBy: row.stoppedBy } : {}),
        };
      }));
    },
    async cancel(taskId, agentId) {
      const result = await cancel(taskId, { stoppedBy: 'agent', agentId });
      switch (result.kind) {
        case 'missing':
          return result;
        case 'finished':
          return { kind: 'finished', status: result.status };
        case 'stopping':
          return { kind: 'stopping', status: result.task.status, ...(result.already === true ? { already: true } : {}) };
      }
    },
    message,
  };

  /**
   * The operator's list, one agent's or the fleet's: every task open or
   * owed a delivery, then the most recently finished. Read whether or not
   * tasks are on, so rows an earlier run left stay visible.
   */
  const list = async (agentId?: string): Promise<TaskListing[]> =>
    Promise.all(tasks.list(agentId, TASKS_OPERATOR_FINISHED_LIMIT).map(async (row): Promise<TaskListing> => {
      const { status, steps } = await liveOf(row);
      return {
        id: row.id,
        agentId: row.agentId,
        workerAgentId: row.workerAgentId,
        originSessionId: row.originSessionId,
        workerSessionId: row.workerSessionId,
        status,
        delivery: row.delivery,
        ...(row.stoppedBy !== undefined ? { stoppedBy: row.stoppedBy } : {}),
        steps,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        ...(row.endedAt !== undefined ? { endedAt: row.endedAt } : {}),
      };
    }));

  return {
    start: enabled ? startTask : undefined,
    cancel,
    list,
    stopTasks,
    approvalWait,
    /** The agent's task tools' host; offered only while tasks are on. */
    toolsHost: enabled ? toolsHost : undefined,
    summary,
    /**
     * What the last process left for settling, read before the channels
     * start, the way the abandoned and parked lists are: nothing of this
     * process's is in it yet. Settled rows past retention are pruned first.
     */
    unsettledAtStart(): TaskRow[] {
      const pruned = tasks.prune(new Date().toISOString());
      if (pruned > 0) {
        log(`pruned ${pruned} settled background task(s) past retention`);
      }
      return tasks.unsettled();
    },
    /**
     * The restart sweep, after the channels are up: each row settled on its
     * worker's chain with `startup`, the one caller that may fail a worker
     * turn the last process left in flight. It goes through the settle
     * function a turn's end uses, so a finished worker is reported with its
     * result and a notice that already landed isn't sent again. Never
     * rejects; a row it can't settle is left for the next start.
     */
    async sweep(rows: readonly TaskRow[]): Promise<void> {
      if (rows.length === 0) {
        return;
      }
      log(`settling ${rows.length} background task(s) the last stratusd left`);
      await Promise.allSettled(rows.map((row) => onSessionChain(row.workerSessionId, async () => {
        if (isStopping()) {
          return;
        }
        try {
          await settler.settle(row.id, { startup: true });
        } catch (error) {
          warn(`task ${row.id}: settling it after the restart failed; the next start tries again (${reason(error)}).`);
        }
      })));
    },
    /**
     * A stop's or restart's end for every running task, once the ordinary
     * turns have drained: each task's own signal aborted with the fixed
     * cut-off error, so the worker's turn fails with it and settling reports
     * `interrupted` (`cancelled` when a stop was recorded first). A start
     * still queued is refused by the same abort and reads as never started.
     * The notice is refused while stopping, so it stays `pending` for the
     * next start's sweep. Not resumable: a worker is never continued.
     */
    cutOff(): number {
      const running = [...controllers.values()].filter((controller) => !controller.signal.aborted);
      for (const controller of running) {
        controller.abort(new RunAbortedError(TASK_CUT_OFF_ERROR));
      }
      return running.length;
    },
    close(): void {
      tasks.close();
    },
  };
};

export type BackgroundTasks = ReturnType<typeof createBackgroundTasks>;
