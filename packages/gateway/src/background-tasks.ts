import {
  carriesKey,
  PENDING_APPROVAL_METADATA_KEY,
  recordTurnFailure,
  RunAbortedError,
  SENDER_TRUST_METADATA_KEY,
  type EventBus,
  type ObserveInput,
  type Session,
} from '@stratusagent/core';
import { type DelegateBackgroundStart, TASK_ID_METADATA_KEY } from '@stratusagent/agents';

import type { ShardedSessionStore } from './sessions.ts';
import { createTaskSettler, TASK_CUT_OFF_ERROR, type TaskNotice } from './task-settle.ts';
import { newTaskId, SqliteTaskStore, taskPromptDigest, type TaskRow } from './tasks.ts';
import type { DispatchInput, GatewayOptions } from './types.ts';

// Background tasks in the gateway (AGT-211, agent-plans
// roadmap/952-background-tasks.md): `agent.delegate`'s background hook.
// It claims the row, starts the worker on its own session chain without
// waiting for it, and settles the task on that chain when the worker's
// turn ends, so a stop recorded later (AGT-357) can't interleave with
// settling. Starting tasks is off unless `tasks.enabled`. The restart sweep
// runs either way: rows a process left before tasks were turned off still
// get settled, and their workers failed as cut off, never left running.

/** Open background tasks one agent may have unless `tasks.maxRunningPerAgent` names it. */
export const DEFAULT_MAX_RUNNING_TASKS_PER_AGENT = 3;

/** What background tasks close over in `createGateway`. */
export interface BackgroundTasksDeps {
  options: GatewayOptions;
  /** `fleet.db`, where the task table lives next to the schedules. */
  fleetDb: string;
  stateHome: string;
  store: ShardedSessionStore;
  bus: Pick<EventBus, 'emit'>;
  dispatchInternal: (input: DispatchInput) => Promise<Session>;
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
  isStopping: () => boolean;
  refusal: () => Error;
  log: (line: string) => void;
  warn: (line: string) => void;
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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
  const enabled = options.tasks?.enabled === true;
  const named = Object.entries(limits).map(([agentId, limit]) => `${agentId} ${limit}`).join(', ');
  /** The startup line: whether agents may start tasks, and each cap. Nothing when the config says nothing. */
  const summary = enabled
    ? `background tasks: on, up to ${DEFAULT_MAX_RUNNING_TASKS_PER_AGENT} running per agent${named.length > 0 ? ` (${named})` : ''}`
    : options.tasks?.enabled === false ? 'background tasks: off (tasks.enabled is false)' : undefined;

  // Its own connection to fleet.db, like the schedule and event stores.
  // Opened whether or not tasks are on, for the restart sweep.
  const tasks = new SqliteTaskStore(fleetDb, { stateHome });
  /** Each running task's own stop, for a cancel (AGT-357) and the drain (`cutOff`). */
  const controllers = new Map<string, AbortController>();

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
        return dispatchInternal({
          sessionId: notice.sessionId,
          agentId: notice.agentId,
          userMessage: notice.text,
          idempotencyKey: notice.idempotencyKey,
          metadata: { [SENDER_TRUST_METADATA_KEY]: notice.trust },
        });
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
    warn,
  });

  /** Settle one task at its worker's turn end. Never rejects: what went wrong is logged with the task id. */
  const settleQuietly = async (taskId: string): Promise<void> => {
    try {
      const settled = await settler.settle(taskId);
      if (settled.kind === 'open') {
        warn(`task ${taskId}: its worker's turn ended, but the worker session still says it is in flight; left for the next start.`);
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
        });
      } catch (error) {
        // How it ended is read from the worker session. This line is for a
        // start that failed before its turn began, which the session can't say.
        warn(`task ${task.id}: the worker's turn ended with an error: ${reason(error)}`);
      } finally {
        controllers.delete(task.id);
      }
      await settleQuietly(task.id);
    }).catch((error: unknown) => {
      warn(`task ${task.id}: ${reason(error)}`);
    });
    return { task: task.id, status: task.status };
  };

  return {
    start: enabled ? startTask : undefined,
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
