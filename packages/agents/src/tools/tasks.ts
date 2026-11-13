import type { JsonObject, Session, Tool } from '@stratusagent/core';

import { isDelegatedSession, TASK_ID_METADATA_KEY } from './delegate.ts';

// An agent's own view of its background tasks (AGT-211): `agent.tasks`
// lists them and `agent.cancelTask` stops one. The host keeps the table and
// owns the cancel (in the gateway, the one function every way of stopping a
// task calls). These tools only scope each call to the calling agent and
// say what happened.

export const TASKS_TOOL_NAME = 'agent.tasks';

export const CANCEL_TASK_TOOL_NAME = 'agent.cancelTask';

/** One task, as the agent's list shows it. Status only: never the prompt or the result. */
export interface TaskSummary {
  task: string;
  /** `running`, `waiting_approval`, `completed`, `failed`, `cancelled` or `interrupted`. */
  status: string;
  /** The agent doing the work. */
  worker: string;
  startedAt: string;
  endedAt?: string;
  /** Responses the worker's turn has taken so far. */
  steps: number;
  /** Whether the outcome is in the conversation: `pending`, `delivered`, or `dropped` when that conversation is gone. */
  delivery: string;
  /** Who asked for a stop, once someone did. */
  stoppedBy?: string;
}

/** What a cancel did, as the host tells it. */
export type TaskCancelAnswer =
  /** No such task among the caller's. */
  | { kind: 'missing' }
  /** It had already ended, or its turn had. Nothing was stopped. */
  | { kind: 'finished'; status: string }
  /** The stop is recorded and its turn is being stopped. */
  | { kind: 'stopping'; status: string; already?: boolean };

export interface TaskToolsHost {
  /** The agent's tasks: every one open or owed a delivery, then its most recent finished ones. */
  list(agentId: string): Promise<TaskSummary[]>;
  /** Cancel one of the agent's own tasks. */
  cancel(taskId: string, agentId: string): Promise<TaskCancelAnswer>;
}

/** How long ago, roughly: `45s`, `12m`, `2h 15m`, `3d 4h`. */
const ageOf = (startedAt: string, now: number): string => {
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1_000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  }
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
};

export const createTaskTools = (host: TaskToolsHost, { now = Date.now }: { now?: () => number } = {}): Tool[] => [
  {
    name: TASKS_TOOL_NAME,
    description: 'List your background tasks (the ones agent.delegate started with background: true): every one still running or '
      + 'whose result hasn\'t reached its conversation yet, then your most recent finished ones. Each has its id, status, worker, '
      + 'age and step count. Report a task\'s state from this list or from its notice, never from memory of what you meant to do.',
    risk: 'safe',
    parameters: { type: 'object', properties: {} },
    async execute(_input: JsonObject, session: Session) {
      const at = now();
      const tasks = (await host.list(session.agent.id)).map((row) => ({ ...row, age: ageOf(row.startedAt, at) }));
      return tasks.length === 0
        ? { tasks, note: 'You have no background tasks.' }
        : { tasks };
    },
  },
  {
    name: CANCEL_TASK_TOOL_NAME,
    description: 'Stop one of your background tasks by its id. A stopped task is not resumed, and a notice in its conversation '
      + 'says it was stopped. A task that already finished is left as it is, and its result still arrives.',
    risk: 'gated',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task id (t_…), from agent.delegate or agent.tasks.' },
      },
      required: ['task'],
    },
    async execute(input: JsonObject, session: Session) {
      const taskId = typeof input.task === 'string' ? input.task.trim() : '';
      if (taskId === '') {
        throw new Error('agent.cancelTask needs "task": the id of one of your background tasks (t_…), from agent.tasks.');
      }
      // A worker can't start tasks in phase 1, and it can't stop them either:
      // only the conversation that owns them, or a person, can.
      if (isDelegatedSession(session) || session.metadata?.[TASK_ID_METADATA_KEY] !== undefined) {
        throw new Error('A delegated session can\'t cancel background tasks. The agent that started them, or a person, can.');
      }
      const answer = await host.cancel(taskId, session.agent.id);
      switch (answer.kind) {
        case 'missing':
          throw new Error(`No background task ${taskId} of yours. agent.tasks lists them.`);
        case 'finished':
          return {
            task: taskId,
            stopped: false,
            status: answer.status,
            note: 'It had already finished, so nothing was stopped. Its result reaches the conversation as a notice.',
          };
        case 'stopping':
          return {
            task: taskId,
            stopped: true,
            status: answer.status,
            note: answer.already === true
              ? 'A stop was already asked for. It is stopping, and a notice in the conversation says when it has.'
              : 'Stopping it. A notice in the conversation says when it has stopped.',
          };
      }
    },
  },
];
