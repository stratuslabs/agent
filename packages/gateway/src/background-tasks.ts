import {
  carriesKey,
  recordTurnFailure,
  SENDER_TRUST_METADATA_KEY,
  type EventBus,
  type ObserveInput,
  type Session,
} from '@stratusagent/core';
import { type DelegateBackgroundStart, TASK_ID_METADATA_KEY } from '@stratusagent/agents';

import type { ShardedSessionStore } from './sessions.ts';
import { createTaskSettler, type TaskNotice } from './task-settle.ts';
import { newTaskId, SqliteTaskStore, taskPromptDigest } from './tasks.ts';
import type { DispatchInput, GatewayOptions } from './types.ts';

// Background tasks in the gateway (AGT-211, agent-plans
// roadmap/952-background-tasks.md): `agent.delegate`'s background hook.
// It claims the row, starts the worker on its own session chain without
// waiting for it, and settles the task on that chain when the worker's
// turn ends, so a stop recorded later (AGT-357) can't interleave with
// settling. Off unless `tasks.enabled`: until the restart sweep lands
// (AGT-356 PR 5), a restart would leave a running row counting against the
// cap with nobody to settle it.

/** Open background tasks one agent may have unless `tasks.maxRunningPerAgent` says otherwise. */
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
  /** The keyed-dispatch check the public door makes: the finished or settled turn a key already names, else undefined. */
  settleRepeat: (sessionId: string, idempotencyKey: string, agentId: string | undefined) => Promise<Session | undefined>;
  /** The runner's own observe (not the channel-facing one): it takes the key. */
  observe: (input: ObserveInput) => Promise<Session>;
  /** Post a fallback notice to the origin's conversation, once. Rejects when there is nowhere to post it or the channel refused. */
  postToOrigin: (notice: TaskNotice) => Promise<void>;
  isStopping: () => boolean;
  refusal: () => Error;
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
  settleRepeat,
  observe,
  postToOrigin,
  isStopping,
  refusal,
  warn,
}: BackgroundTasksDeps) => {
  const cap = options.tasks?.maxRunningPerAgent ?? DEFAULT_MAX_RUNNING_TASKS_PER_AGENT;
  // Checked whether or not tasks are on, so a bad value is found when it is
  // written, not on the day someone turns tasks on.
  if (!Number.isInteger(cap) || cap < 1) {
    throw new Error(`tasks.maxRunningPerAgent must be a whole number of at least 1 (got ${String(cap)}).`);
  }
  if (options.tasks?.enabled !== true) {
    return { start: undefined, close: (): void => {} };
  }

  // Its own connection to fleet.db, like the schedule and event stores.
  const tasks = new SqliteTaskStore(fleetDb, { stateHome });
  /** Each running task's own stop, for a cancel (AGT-357) and the drain (PR 5). */
  const controllers = new Map<string, AbortController>();

  const settler = createTaskSettler({
    tasks,
    getSession: (sessionId) => store.get(sessionId),
    // The startup sweep's (PR 5), which settles on the worker's chain
    // already, so this doesn't queue on it again.
    async failCutOffTurn(sessionId, error) {
      const worker = await store.get(sessionId);
      if (worker === undefined || (worker.status !== 'running' && worker.status !== 'pending_approval')) {
        return;
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

  const start: DelegateBackgroundStart = async ({ origin, agent, prompt, workerSessionId, metadata }) => {
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
    }, cap, new Date().toISOString());
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
    // worker's own chain, so the drain waits for it like any turn, and the
    // settle after it is on the same chain.
    void onSessionChain(task.workerSessionId, async () => {
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
    start,
    close(): void {
      tasks.close();
    },
  };
};

export type BackgroundTasks = ReturnType<typeof createBackgroundTasks>;
