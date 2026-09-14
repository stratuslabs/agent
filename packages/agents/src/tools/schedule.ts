import {
  isTaintedTrust,
  leastTrusted,
  sessionWriteTrust,
  type JsonObject,
  type Session,
  type Tool,
} from '@stratusagent/core';
import {
  type ScheduleCadence,
  parseInterval,
  parseCronExpression,
  type SchedulerHandle,
  parseDestinationInput,
  DESTINATION_PARAMETER,
  describeSchedule,
} from '../schedules.ts';

export const SCHEDULE_EVERY_TOOL_NAME = 'schedule.every';

export const SCHEDULE_AT_TOOL_NAME = 'schedule.at';

export const SCHEDULE_LIST_TOOL_NAME = 'schedule.list';

export const SCHEDULE_CANCEL_TOOL_NAME = 'schedule.cancel';

/**
 * The four `schedule.*` tools over one handle.
 *
 * Risk is split per tool, not per toolset: creating a schedule spends
 * future money unattended and (with a destination) mints a standing
 * permission to speak, so `schedule.every` and `schedule.at` are `gated` —
 * the approval of THAT call is the human decision the whole step leans on.
 * `schedule.list` is a read, and `schedule.cancel` only ever narrows
 * authority — it is the reversal the risk note in the spec names — so both
 * are `safe`: a headless agent that set a bad schedule must be able to
 * undo it without waiting for the human whose absence is the problem.
 */
export const createScheduleTools = (scheduler: SchedulerHandle): Tool[] => {
  const create = async (
    session: Session,
    cadence: ScheduleCadence,
    input: JsonObject,
  ): Promise<JsonObject> => {
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (!prompt) {
      throw new Error('A schedule needs a non-empty "prompt" — the instruction each firing runs.');
    }
    if (input.destination !== undefined && parseDestinationInput(input.destination) === undefined) {
      throw new Error('"destination" must be { channel, to } with non-empty strings, or omitted.');
    }
    const destination = parseDestinationInput(input.destination);
    const record = await scheduler.create({
      agentId: session.agent.id,
      cadence,
      prompt,
      ...(destination ? { destination } : {}),
      createdBy: session.id,
      trust: sessionWriteTrust(session),
    });
    return { created: true, schedule: describeSchedule(record) };
  };

  return [
    {
      name: SCHEDULE_EVERY_TOOL_NAME,
      description: 'Set a recurring schedule for yourself: an interval ("30m", "1d") or a five-field cron expression, the prompt each firing runs, and optionally the destination your reports are pre-authorized to post to. Creating a schedule needs human approval once; its firings then run unattended.',
      risk: 'gated',
      parameters: {
        type: 'object',
        properties: {
          every: { type: 'string', description: 'Interval like "90s", "30m", "2h", "1d". Exactly one of "every" or "cron".' },
          cron: { type: 'string', description: 'Five-field cron expression (minute hour day-of-month month day-of-week), local time. Exactly one of "every" or "cron".' },
          prompt: { type: 'string', description: 'The instruction each firing runs, phrased to stand alone.' },
          destination: DESTINATION_PARAMETER,
        },
        required: ['prompt'],
      },
      async execute(input: JsonObject, session: Session) {
        const every = typeof input.every === 'string' ? input.every.trim() : '';
        const cron = typeof input.cron === 'string' ? input.cron.trim() : '';
        if ((every === '') === (cron === '')) {
          throw new Error('Pass exactly one of "every" (an interval) or "cron" (a cron expression).');
        }
        if (every) {
          const intervalMs = parseInterval(every);
          if (intervalMs === undefined) {
            throw new Error(`Not an interval: "${every}". Use a positive integer and one unit — "90s", "30m", "2h", "1d".`);
          }
          return create(session, { kind: 'every', intervalMs }, input);
        }
        parseCronExpression(cron); // Refuse a bad expression here, with its own message.
        return create(session, { kind: 'cron', expression: cron }, input);
      },
    },
    {
      name: SCHEDULE_AT_TOOL_NAME,
      description: 'Schedule a one-shot run of a prompt at a future time (ISO-8601). Needs human approval once; the firing then runs unattended.',
      risk: 'gated',
      parameters: {
        type: 'object',
        properties: {
          at: { type: 'string', description: 'When to fire, ISO-8601 (e.g. 2026-09-01T07:00:00). Must be in the future.' },
          prompt: { type: 'string', description: 'The instruction the firing runs, phrased to stand alone.' },
          destination: DESTINATION_PARAMETER,
        },
        required: ['at', 'prompt'],
      },
      async execute(input: JsonObject, session: Session) {
        const at = typeof input.at === 'string' ? input.at.trim() : '';
        const parsed = new Date(at);
        if (!at || Number.isNaN(parsed.getTime())) {
          throw new Error(`Not a timestamp: "${at}". Use ISO-8601, e.g. 2026-09-01T07:00:00.`);
        }
        if (parsed.getTime() <= Date.now()) {
          throw new Error(`${at} is in the past — a one-shot schedule must name a future time.`);
        }
        return create(session, { kind: 'at', at: parsed.toISOString() }, input);
      },
    },
    {
      name: SCHEDULE_LIST_TOOL_NAME,
      description: 'List your own schedules: cadence, prompt, destination, and when each fires next.',
      // A read of state this agent itself created.
      risk: 'safe',
      parameters: { type: 'object', properties: {} },
      async execute(_input: JsonObject, session: Session, context) {
        const records = await scheduler.list(session.agent.id);
        // Each prompt was written by the session that set the schedule, at
        // that session's label — and a schedule from before labels existed
        // has none. Listing puts those prompts in front of the model, so the
        // call is marked at the lowest of them, as `memory.recall` marks a
        // hit: a fresh session must not restate a tainted prompt as its own.
        const lowest = leastTrusted(...records.map((record) => record.trust ?? 'unknown'));
        if (records.length > 0 && isTaintedTrust(lowest)) {
          context?.markTrust?.(lowest);
        }
        return { schedules: records.map(describeSchedule) };
      },
    },
    {
      name: SCHEDULE_CANCEL_TOOL_NAME,
      description: 'Cancel one of your schedules by id. Cancelling also revokes the pre-authorized destination that was approved with it.',
      // Cancel only ever NARROWS authority — it destroys a human-minted
      // grant — and it is the reversal that keeps schedule creation short
      // of `dangerous`. Gating it would leave a headless agent unable to
      // undo its own schedule for want of the human whose absence is the
      // point of headless.
      risk: 'safe',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The schedule id, from schedule.list or the creation result.' },
        },
        required: ['id'],
      },
      async execute(input: JsonObject, session: Session) {
        const id = typeof input.id === 'string' ? input.id.trim() : '';
        if (!id) {
          throw new Error('schedule.cancel requires a non-empty "id".');
        }
        const cancelled = await scheduler.cancel(session.agent.id, id);
        if (!cancelled) {
          throw new Error(`No schedule of yours has id ${id}. schedule.list shows what exists.`);
        }
        return { cancelled: true, id };
      },
    },
  ];
};
