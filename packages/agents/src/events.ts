import type { JsonValue } from '@stratusagent/core';

// The pure half of event triggers (card 590, agent-plans
// roadmap/590-event-triggers.md): what an event looks like to a trigger, the
// filter that decides whether it fires, and quiet hours. The listener that
// verifies signatures, the store that dedups deliveries, and the dispatch
// live in the gateway and control-api. This stays free of them so the CLI can
// describe a trigger, and the approval prompt can show one, without a daemon.

/**
 * An event as a trigger sees it: CloudEvents 1.0 context attributes plus its
 * data. Attributes are strings, by their CloudEvents names (`id`, `source`,
 * `specversion`, `type`, and optionally `subject`, `time`, and extensions
 * such as the GitHub mapping's `actor` and `author`). Every value here came
 * from outside: a valid signature proves who delivered it, not who wrote it.
 */
export interface InboundEvent {
  attributes: Readonly<Record<string, string>>;
  data?: JsonValue;
}

/**
 * A filter expression, in the six dialects every CloudEvents Subscriptions
 * implementation must support (Subscriptions API 0.1, 3.2.4.1.1). Matching is
 * case-sensitive. No code, no regex, no model: it runs on every delivery,
 * before anything else can spend money.
 *
 * One Stratus extension: a key starting `data.` is a dotted path into the
 * event's JSON data, and matches only a string there. The Codex use case
 * needs it, because a Codex result and its in-progress summary differ only in
 * the first line of the comment body.
 */
export type EventFilter =
  | { exact: Record<string, string> }
  | { prefix: Record<string, string> }
  | { suffix: Record<string, string> }
  | { all: EventFilter[] }
  | { any: EventFilter[] }
  | { not: EventFilter };

/**
 * A daily window in which a trigger's firings are held, not sent: `from` and
 * `to` are `HH:MM` on a 24-hour clock in `timeZone` (IANA). A window whose
 * `to` is earlier than its `from` runs across midnight.
 */
export interface QuietHours {
  from: string;
  to: string;
  timeZone: string;
}

/** A trigger fires at most this many turns an hour unless it says otherwise. */
export const DEFAULT_EVENT_MAX_PER_HOUR = 12;

const DIALECTS = ['exact', 'prefix', 'suffix', 'all', 'any', 'not'] as const;
type Dialect = typeof DIALECTS[number];

/**
 * Bounds on a filter's shape. A person approves a trigger by reading its
 * filter, and the listener evaluates every filter on every delivery; both
 * stop working on a filter nobody can read.
 */
const MAX_FILTER_DEPTH = 8;
const MAX_FILTER_NODES = 64;

// CloudEvents attribute names are lowercase ASCII letters and digits. The
// `data.` extension's segments are any non-empty JSON key without a dot.
const ATTRIBUTE_NAME = /^[a-z0-9]+$/;
const DATA_PATH = /^data(\.[^.]+)+$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseComparison = (dialect: Dialect, raw: unknown): Record<string, string> => {
  if (!isPlainObject(raw)) {
    throw new Error(`A "${dialect}" filter takes an object of attribute names to strings, e.g. { "${dialect}": { "type": "com.github.push" } }.`);
  }
  const entries = Object.entries(raw);
  if (entries.length === 0) {
    throw new Error(`A "${dialect}" filter needs at least one attribute to compare.`);
  }
  const out: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!ATTRIBUTE_NAME.test(name) && !DATA_PATH.test(name)) {
      throw new Error(
        `"${name}" is not an attribute name a filter can use. Use a CloudEvents attribute (lowercase letters and digits, e.g. type, subject, actor) or a data path like data.review.body.`,
      );
    }
    if (typeof value !== 'string') {
      throw new Error(`The "${dialect}" value for "${name}" must be a string.`);
    }
    if (value.length === 0) {
      throw new Error(`The "${dialect}" value for "${name}" is empty; the CloudEvents filter dialects do not allow empty values.`);
    }
    out[name] = value;
  }
  return out;
};

/**
 * Validate a filter and return a canonical copy that shares nothing with the
 * input. Throws a sentence naming the problem: an unknown dialect is refused
 * at creation, as the Subscriptions spec requires, never ignored at match
 * time where nobody would hear about it.
 */
export const parseEventFilter = (raw: unknown): EventFilter => {
  let nodes = 0;
  const parse = (value: unknown, depth: number): EventFilter => {
    if (depth > MAX_FILTER_DEPTH) {
      throw new Error(`This filter is nested more than ${MAX_FILTER_DEPTH} levels deep; flatten it with "all" or "any".`);
    }
    nodes += 1;
    if (nodes > MAX_FILTER_NODES) {
      throw new Error(`This filter is too large (over ${MAX_FILTER_NODES} expressions); a person approving it has to be able to read it.`);
    }
    if (!isPlainObject(value)) {
      throw new Error('A filter is an object with one dialect key: exact, prefix, suffix, all, any or not.');
    }
    const keys = Object.keys(value);
    if (keys.length !== 1) {
      throw new Error(`A filter expression has exactly one dialect key; this one has ${keys.length}${keys.length > 0 ? ` (${keys.join(', ')})` : ''}.`);
    }
    const dialect = keys[0]!;
    const body = value[dialect];
    switch (dialect) {
      case 'exact':
      case 'prefix':
      case 'suffix':
        return { [dialect]: parseComparison(dialect, body) } as EventFilter;
      case 'all':
      case 'any': {
        if (!Array.isArray(body)) {
          throw new Error(`An "${dialect}" filter takes an array of filter expressions.`);
        }
        if (body.length === 0) {
          throw new Error(`An "${dialect}" filter needs at least one filter expression.`);
        }
        const children = body.map((child) => parse(child, depth + 1));
        return dialect === 'all' ? { all: children } : { any: children };
      }
      case 'not': {
        if (!isPlainObject(body)) {
          throw new Error('A "not" filter takes one filter expression (an object), not an array.');
        }
        return { not: parse(body, depth + 1) };
      }
      default:
        throw new Error(`"${dialect}" is not a supported filter dialect. Use one of ${DIALECTS.join(', ')}.`);
    }
  };
  return parse(raw, 1);
};

/** The string at a `data.` path, or undefined when the path leads anywhere else. */
const dataString = (data: JsonValue | undefined, path: string): string | undefined => {
  let cursor: JsonValue | undefined = data;
  for (const segment of path.split('.').slice(1)) {
    // Own keys of plain objects only: a path through an array index or the
    // prototype (`constructor.name`) is not something the sender wrote.
    if (!isPlainObject(cursor) || !Object.hasOwn(cursor, segment)) {
      return undefined;
    }
    cursor = (cursor as Record<string, JsonValue>)[segment];
  }
  return typeof cursor === 'string' ? cursor : undefined;
};

const valueOf = (event: InboundEvent, name: string): string | undefined =>
  name.startsWith('data.')
    ? dataString(event.data, name)
    : Object.hasOwn(event.attributes, name) ? event.attributes[name] : undefined;

const compare = (
  event: InboundEvent,
  pairs: Record<string, string>,
  test: (actual: string, expected: string) => boolean,
): boolean => Object.entries(pairs).every(([name, expected]) => {
  const actual = valueOf(event, name);
  return actual !== undefined && test(actual, expected);
});

/**
 * Whether `event` passes `filter`. An attribute the event lacks matches no
 * comparison, so `not` of that comparison is true, as the dialects define.
 * Expects a filter that went through `parseEventFilter`.
 */
export const matchesEventFilter = (filter: EventFilter, event: InboundEvent): boolean => {
  if ('exact' in filter) {
    return compare(event, filter.exact, (actual, expected) => actual === expected);
  }
  if ('prefix' in filter) {
    return compare(event, filter.prefix, (actual, expected) => actual.startsWith(expected));
  }
  if ('suffix' in filter) {
    return compare(event, filter.suffix, (actual, expected) => actual.endsWith(expected));
  }
  if ('all' in filter) {
    return filter.all.every((child) => matchesEventFilter(child, event));
  }
  if ('any' in filter) {
    return filter.any.some((child) => matchesEventFilter(child, event));
  }
  return !matchesEventFilter(filter.not, event);
};

const CLOCK_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

const minutesOf = (text: string): number => {
  const match = CLOCK_TIME.exec(text)!;
  return Number(match[1]) * 60 + Number(match[2]);
};

/** Validate quiet hours, throwing a sentence that names the problem. */
export const parseQuietHours = (raw: unknown): QuietHours => {
  if (!isPlainObject(raw)) {
    throw new Error('quietHours is an object: { "from": "22:00", "to": "07:00", "timeZone": "America/New_York" }.');
  }
  const { from, to, timeZone } = raw;
  for (const [name, value] of [['from', from], ['to', to]] as const) {
    if (typeof value !== 'string' || !CLOCK_TIME.test(value)) {
      throw new Error(`quietHours.${name} must be a 24-hour time written HH:MM, like "22:00".`);
    }
  }
  if (from === to) {
    throw new Error('quietHours.from and quietHours.to are the same time, which leaves no window.');
  }
  if (typeof timeZone !== 'string' || timeZone.trim().length === 0) {
    throw new Error('quietHours.timeZone is required: an IANA time zone like "America/New_York" or "UTC".');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new Error(`"${timeZone}" is not a time zone this host knows. Use an IANA name like "America/New_York" or "UTC".`);
  }
  return { from: from as string, to: to as string, timeZone };
};

/** Whether `now` falls inside the window, in the window's own time zone. */
export const isWithinQuietHours = (quietHours: QuietHours, now: Date): boolean => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: quietHours.timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  const at = hour * 60 + minute;
  const from = minutesOf(quietHours.from);
  const to = minutesOf(quietHours.to);
  return from < to ? at >= from && at < to : at >= from || at < to;
};
