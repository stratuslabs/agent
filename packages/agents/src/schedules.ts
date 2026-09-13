import type { JsonObject, TrustLevel } from '@stratusagent/core';

// The pure half of step 10: what a schedule *is* — its cadence, its prompt,
// its optional destination — and the arithmetic of when it fires next. The
// scheduler that arms timers, the store that makes rows durable, and the
// channel that delivers a send all live in the gateway; this stays free of
// them so the CLI can describe a schedule and the tests can check the
// arithmetic without standing a daemon up.

/**
 * Where a schedule reports, or a `message.send` speaks: a channel kind plus
 * a channel-native id — the same convention approver lists use, because
 * mapping through a Stratus identity adds a lookup that can only be wrong.
 */
export interface ScheduleDestination {
  /** Channel kind, e.g. 'slack' — which adapter must do the talking. */
  channel: string;
  /** Channel-native conversation id (Slack: `C…`/`G…`/`D…`). */
  to: string;
}

/**
 * The one string form of a destination, `<channel>:<native id>`, used
 * everywhere a destination is *compared*: `Tool.destinationFor`, the
 * permission policy's pre-authorization check, and the schedule row it is
 * checked against. One canonicalization, or two writers of `slack:C01` and
 * `SLACK:C01` would disagree about the same channel.
 */
export const canonicalDestination = (destination: ScheduleDestination): string =>
  `${destination.channel.trim().toLowerCase()}:${destination.to.trim()}`;

/**
 * When a schedule runs. Three shapes rather than one string, because the
 * three are advanced differently: an interval adds itself to the previous
 * slot, a cron expression is searched forward, and a one-shot has no next
 * at all.
 */
export type ScheduleCadence =
  | { kind: 'every'; intervalMs: number }
  | { kind: 'cron'; expression: string }
  | { kind: 'at'; at: string };

/** One durable schedule, exactly as the human approved it. */
export interface ScheduleRecord {
  id: string;
  agentId: string;
  cadence: ScheduleCadence;
  /** The user message each firing dispatches — the payload of the feature. */
  prompt: string;
  /**
   * Where firings are pre-authorized to report. Absent for a silent
   * schedule, whose firings face the gate like any inbound turn.
   */
  destination?: ScheduleDestination;
  createdAt: string;
  /** The session whose turn created it, for the audit trail. */
  createdBy?: string;
  /**
   * The trust label of the session that set the schedule. The prompt is
   * that session's text, so each firing's "sender" is the agent's past
   * self at that label — a tainted session must not launder attacker text
   * into a fresh, trusted firing. Absent on a schedule set before
   * provenance was tracked, and a firing reads that as `unknown`.
   */
  trust?: TrustLevel;
  /**
   * The next slot, ISO-8601. Consumed — advanced — BEFORE the dispatch, so
   * a daemon that dies mid-firing can never run the same window twice.
   * Absent for a spent one-shot: it will not fire again and its row stays
   * only until the firing it pre-authorized has finished.
   */
  nextFireAt?: string;
  lastFiredAt?: string;
  /**
   * The session id of the most recent firing. What the restart sweep uses
   * to tell a spent one-shot whose turn is parked on a human (keep the row
   * — it is the approval's scope) from one whose turn is over (delete it).
   */
  lastSessionId?: string;
}

/** `every` strings: a positive integer and one unit — `90s`, `10m`, `2h`, `1d`. */
export const parseInterval = (text: string): number | undefined => {
  const match = /^(\d+)(s|m|h|d)$/.exec(text.trim());
  if (!match) {
    return undefined;
  }
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return undefined;
  }
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 's' | 'm' | 'h' | 'd'];
  return amount * unit;
};

interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /**
   * Whether the day fields were written as anything but `*`. Standard cron
   * semantics: when BOTH are restricted, a day matches if EITHER does —
   * `0 0 1 * 1` is "the 1st, and every Monday", not "the 1st when it is a
   * Monday".
   */
  domRestricted: boolean;
  dowRestricted: boolean;
}

const parseCronField = (
  field: string,
  min: number,
  max: number,
  label: string,
): Set<number> => {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const stepMatch = /^([^/]+)(?:\/(\d+))?$/.exec(part);
    if (!stepMatch || part.length === 0) {
      throw new Error(`Invalid cron ${label} field: ${field}`);
    }
    const [, rangeText, stepText] = stepMatch;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isSafeInteger(step) || step < 1) {
      throw new Error(`Invalid cron ${label} step: ${part}`);
    }
    let low: number;
    let high: number;
    if (rangeText === '*') {
      low = min;
      high = max;
    } else {
      const rangeMatch = /^(\d+)(?:-(\d+))?$/.exec(rangeText!);
      if (!rangeMatch) {
        throw new Error(`Invalid cron ${label} field: ${field} (numbers only — names are not supported)`);
      }
      low = Number(rangeMatch[1]);
      high = rangeMatch[2] === undefined ? low : Number(rangeMatch[2]);
      // A bare value with a step (`5/15`) reads to the end of the range,
      // matching vixie cron.
      if (rangeMatch[2] === undefined && stepText !== undefined) {
        high = max;
      }
    }
    if (low < min || high > max || low > high) {
      throw new Error(`Cron ${label} value out of range ${min}-${max}: ${part}`);
    }
    for (let value = low; value <= high; value += step) {
      values.add(value);
    }
  }
  return values;
};

/**
 * Five fields — minute, hour, day-of-month, month, day-of-week — with `*`,
 * lists, ranges, and steps. Numbers only; day-of-week 0-7 with both 0 and 7
 * as Sunday. Evaluated in the daemon's local time, which is what "every
 * morning at 7" means to the person whose machine it is.
 */
export const parseCronExpression = (expression: string): CronFields => {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `A cron expression has five fields (minute hour day-of-month month day-of-week); got ${fields.length} in "${expression}".`,
    );
  }
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  const daysOfWeek = parseCronField(dow, 0, 7, 'day-of-week');
  if (daysOfWeek.has(7)) {
    daysOfWeek.delete(7);
    daysOfWeek.add(0);
  }
  return {
    minutes: parseCronField(minute, 0, 59, 'minute'),
    hours: parseCronField(hour, 0, 23, 'hour'),
    daysOfMonth: parseCronField(dom, 1, 31, 'day-of-month'),
    months: parseCronField(month, 1, 12, 'month'),
    daysOfWeek,
    domRestricted: dom !== '*',
    dowRestricted: dow !== '*',
  };
};

/** How far a cron search looks before concluding the expression never fires. */
const CRON_SEARCH_DAYS = 366 * 4;

const nextCronFire = (fields: CronFields, after: Date): Date | undefined => {
  // Strictly after `after`, at minute granularity.
  const start = new Date(after.getTime());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  const dayMatches = (date: Date): boolean => {
    if (!fields.months.has(date.getMonth() + 1)) {
      return false;
    }
    const domMatch = fields.daysOfMonth.has(date.getDate());
    const dowMatch = fields.daysOfWeek.has(date.getDay());
    if (fields.domRestricted && fields.dowRestricted) {
      return domMatch || dowMatch;
    }
    return fields.domRestricted ? domMatch : fields.dowRestricted ? dowMatch : true;
  };

  const hours = [...fields.hours].sort((a, b) => a - b);
  const minutes = [...fields.minutes].sort((a, b) => a - b);

  const day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  for (let offset = 0; offset < CRON_SEARCH_DAYS; offset += 1) {
    if (dayMatches(day)) {
      for (const hour of hours) {
        for (const minute of minutes) {
          const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
          if (candidate >= start && candidate > after) {
            return candidate;
          }
        }
      }
    }
    day.setDate(day.getDate() + 1);
  }
  // Reachable: `0 0 31 2 *` matches no real date. Creation treats this as
  // a refusal, not a schedule that quietly never runs.
  return undefined;
};

/**
 * The slot after `after`, or undefined when there is none — a one-shot
 * already past, or a cron expression that matches no real date. One
 * implementation, because the scheduler advancing a fired slot and the
 * creation path computing the first one must never disagree.
 */
export const nextFireAfter = (cadence: ScheduleCadence, after: Date): Date | undefined => {
  switch (cadence.kind) {
    case 'every':
      return new Date(after.getTime() + cadence.intervalMs);
    case 'cron':
      return nextCronFire(parseCronExpression(cadence.expression), after);
    case 'at': {
      const at = new Date(cadence.at);
      if (Number.isNaN(at.getTime())) {
        return undefined;
      }
      return at.getTime() > after.getTime() ? at : undefined;
    }
    default:
      return undefined;
  }
};

/** One line for a human: `every 30m`, `cron 0 7 * * *`, `once at 2026-…`. */
export const describeCadence = (cadence: ScheduleCadence): string => {
  switch (cadence.kind) {
    case 'every': {
      const units: Array<[number, string]> = [[86_400_000, 'd'], [3_600_000, 'h'], [60_000, 'm'], [1_000, 's']];
      for (const [ms, suffix] of units) {
        if (cadence.intervalMs % ms === 0) {
          return `every ${cadence.intervalMs / ms}${suffix}`;
        }
      }
      return `every ${cadence.intervalMs}ms`;
    }
    case 'cron':
      return `cron ${cadence.expression}`;
    case 'at':
      return `once at ${cadence.at}`;
    default:
      return 'unknown';
  }
};

/**
 * Metadata a firing's session carries. The schedule id is what the
 * permission carve-out resolves the approved destination from, and
 * `scheduled: true` is what lets a renderer say a turn arrived from a
 * schedule rather than a person.
 */
export const SCHEDULE_ID_METADATA_KEY = 'scheduleId';

export const SCHEDULED_TURN_METADATA_KEY = 'scheduled';

export interface ScheduleCreateInput {
  agentId: string;
  cadence: ScheduleCadence;
  prompt: string;
  destination?: ScheduleDestination;
  /** The session whose turn asked, for the audit trail. */
  createdBy?: string;
  /** That session's trust label at the time — see `ScheduleRecord.trust`. */
  trust?: TrustLevel;
}

/**
 * The gateway-supplied handle the schedule tools close over — the same
 * pattern as `agent.delegate`'s dispatcher, because the scheduler needs the
 * store, the roster, and the channels, and none of those are this package's
 * to hold. `create` owns every refusal that needs daemon knowledge: the
 * interval floor, and a destination the agent's channel cannot address —
 * checked NOW, while a person is present to hear why, not at 6am.
 */
export interface SchedulerHandle {
  create(input: ScheduleCreateInput): Promise<ScheduleRecord>;
  list(agentId: string): Promise<ScheduleRecord[]>;
  /** True when a schedule of this agent's was cancelled; false when nothing matched. */
  cancel(agentId: string, scheduleId: string): Promise<boolean>;
}

export const parseDestinationInput = (raw: unknown): ScheduleDestination | undefined => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const channel = (raw as JsonObject).channel;
  const to = (raw as JsonObject).to;
  if (typeof channel !== 'string' || channel.trim().length === 0
    || typeof to !== 'string' || to.trim().length === 0) {
    return undefined;
  }
  return { channel: channel.trim().toLowerCase(), to: to.trim() };
};

export const DESTINATION_PARAMETER = {
  type: 'object',
  description: 'Where firings report. Omit for a schedule that does not speak — its sends will need approval like any other. The channel kind plus the channel-native conversation id (for Slack, a channel id like C0123456789 that your app is a member of).',
  properties: {
    channel: { type: 'string', description: "Channel kind, e.g. 'slack'." },
    to: { type: 'string', description: 'Channel-native conversation id.' },
  },
  required: ['channel', 'to'],
} satisfies JsonObject;

/**
 * One schedule as a surface shows it — the CLI table, the control API's
 * listing, and the tool results all render this one projection, so the
 * operator's view and the agent's cannot drift.
 */
export const describeSchedule = (record: ScheduleRecord): JsonObject => ({
  id: record.id,
  agentId: record.agentId,
  cadence: describeCadence(record.cadence),
  prompt: record.prompt,
  trust: record.trust ?? 'unknown',
  ...(record.destination ? { destination: canonicalDestination(record.destination) } : {}),
  ...(record.nextFireAt ? { nextFireAt: record.nextFireAt } : {}),
  ...(record.lastFiredAt ? { lastFiredAt: record.lastFiredAt } : {}),
  createdAt: record.createdAt,
});
