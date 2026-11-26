import {
  sessionWriteTrust,
  turnMessageOf,
  type ExecutionContext,
  type JsonObject,
  type Session,
  type Tool,
  type TrustLevel,
} from '@stratusagent/core';

import { isDelegatedSession, TASK_ID_METADATA_KEY } from './delegate.ts';

// An agent's own view of its background tasks: `agent.tasks`
// lists them, `agent.cancelTask` stops one, and `agent.messageTask` passes
// a follow-up into one that is running. The host keeps the table and owns
// the cancel (in the gateway, the one function every way of stopping a
// task calls) and the follow-up queue. These tools only scope each call to
// the calling agent and conversation and say what happened.

export const TASKS_TOOL_NAME = 'agent.tasks';

export const CANCEL_TASK_TOOL_NAME = 'agent.cancelTask';

export const MESSAGE_TASK_TOOL_NAME = 'agent.messageTask';

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

/** A follow-up for a running task, as `agent.messageTask` hands it to the host. */
export interface TaskMessageInput {
  taskId: string;
  /** The calling agent: only its own tasks. */
  agentId: string;
  /** The calling conversation: only the one that started the task may send it follow-ups. */
  originSessionId: string;
  text: string;
  /** The label the follow-up carries into the task's turn: the calling session's write label. */
  trust: TrustLevel;
  /**
   * What makes one call one follow-up, so a call run twice is passed on
   * once: the assistant message carrying the call, and the call's id.
   * Absent when the host gave the tool no call id; such a follow-up is
   * never taken for a repeat.
   */
  key?: string;
}

/** What became of a follow-up, as the host tells it. */
export type TaskMessageAnswer =
  /** No such task among the caller's. */
  | { kind: 'missing' }
  /** The caller's task, but another conversation started it. Nothing was queued. */
  | { kind: 'elsewhere' }
  /** It ended, or its turn did, or it isn't running here. Nothing was queued. */
  | { kind: 'ended'; status: string }
  /** A stop was asked for. Nothing was queued. */
  | { kind: 'stopping' }
  /** Queued for its turn's next step; `already` when this same call was queued before. */
  | { kind: 'queued'; status: string; already?: boolean };

export interface TaskToolsHost {
  /** The agent's tasks: every one open or owed a delivery, then its most recent finished ones. */
  list(agentId: string): Promise<TaskSummary[]>;
  /** Cancel one of the agent's own tasks. */
  cancel(taskId: string, agentId: string): Promise<TaskCancelAnswer>;
  /** Queue a follow-up for one of the agent's running tasks, from the conversation that started it. */
  message(input: TaskMessageInput): Promise<TaskMessageAnswer>;
}

/**
 * The key one `agent.messageTask` call is passed on under: the assistant
 * message carrying the call, then the call's id. Both the kernel loop and
 * the hosted path record that message, one call each, before the call
 * runs, so the same call asked to run again gets the same key, and a
 * provider that reuses an id in a later response gets a new one. Without a
 * call id there is no key, and nothing is taken for a repeat.
 */
const followUpKey = (session: Session, callId: string | undefined): string | undefined => {
  if (callId === undefined) {
    return undefined;
  }
  const carrier = session.messages.findLast((message) => message.role === 'assistant' && message.toolCalls?.some((call) => call.id === callId) === true);
  return `${carrier?.id ?? turnMessageOf(session)?.id ?? session.id}#${callId}`;
};

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
  {
    name: MESSAGE_TASK_TOOL_NAME,
    description: 'Pass a follow-up about one of your running background tasks into it: an edit, a correction, something to '
      + 'add. It joins the task\'s running turn at its next step. Only the conversation that started the task can do this. '
      + 'A task that has ended takes nothing; start a new one instead. If the task ends before reading it, its result says so.',
    risk: 'safe',
    // Clean, it only passes on what this conversation already asked for.
    // After a page or a stranger's text, it asks first, as agent.delegate
    // does, so injected text can't steer work already running.
    riskAfterExternalContent: 'gated',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task id (t_…), from agent.delegate or agent.tasks.' },
        message: { type: 'string', description: 'What to pass on, written for the task: what to change, add or stop doing.' },
      },
      required: ['task', 'message'],
    },
    async execute(input: JsonObject, session: Session, context?: ExecutionContext) {
      const taskId = typeof input.task === 'string' ? input.task.trim() : '';
      if (taskId === '') {
        throw new Error('agent.messageTask needs "task": the id of one of your background tasks (t_…), from agent.tasks.');
      }
      const text = typeof input.message === 'string' ? input.message.trim() : '';
      if (text === '') {
        throw new Error('agent.messageTask needs "message": what to pass on to the task.');
      }
      // A worker's follow-ups come from the conversation that started it,
      // never from another worker.
      if (isDelegatedSession(session) || session.metadata?.[TASK_ID_METADATA_KEY] !== undefined) {
        throw new Error('A delegated session can\'t message background tasks. The conversation that started them can.');
      }
      const key = followUpKey(session, context?.callId);
      const answer = await host.message({
        taskId,
        agentId: session.agent.id,
        originSessionId: session.id,
        text,
        trust: sessionWriteTrust(session),
        ...(key !== undefined ? { key } : {}),
      });
      switch (answer.kind) {
        case 'missing':
          throw new Error(`No background task ${taskId} of yours. agent.tasks lists them.`);
        case 'elsewhere':
          throw new Error(
            `Only the conversation that started background task ${taskId} can send it follow-ups, and this isn't it, `
            + 'so nothing was passed on. Start a new task from here if the work is needed here.',
          );
        case 'ended':
          throw new Error(
            `Background task ${taskId} isn't taking follow-ups any more (${answer.status}), so nothing was passed on. `
            + 'Its result reaches its conversation as a notice. Start a new task if the work still needs this.',
          );
        case 'stopping':
          throw new Error(`A stop was already asked for background task ${taskId}, so nothing was passed on.`);
        case 'queued':
          return {
            task: taskId,
            status: answer.status,
            delivered: 'at_next_step',
            note: answer.already === true
              ? 'This follow-up was already passed on, so it was not sent again.'
              : 'Passed on. The task reads it at its next step. If it ends before reading it, which a task on a provider '
                + 'that can\'t take messages mid-task always does, its result lists it as unread.',
          };
      }
    },
  },
];
