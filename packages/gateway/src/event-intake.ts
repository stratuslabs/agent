import { createHmac, timingSafeEqual } from 'node:crypto';

import type { JsonObject, JsonValue } from '@stratusagent/core';
import { matchesEventFilter, type EventFilter, type InboundEvent } from '@stratusagent/agents';

import {
  eventCoalescingKey,
  eventDispatchKey,
  eventSessionId,
  renderEventBlock,
  type NewEventFiring,
  type SqliteEventStore,
} from './events.ts';

// What happens to one request on the events port (card 590), in the order
// the spec's failure table gives: unknown source, size, signature, signed
// rate, content type, body, then dedup and the trigger match. Only a request
// with a good signature gets a delivery row, and the counters exist only per
// configured source plus one for every unknown path, so nothing a caller
// sends can grow them. The HTTP server lives in control-api; this is what it
// calls, with the raw bytes, so signatures are checked over exactly what
// arrived.

/** A source the operator configured under `events.sources`. */
export interface EventSourceConfig {
  /** How deliveries prove who sent them. */
  verify: 'standard-webhooks' | 'github';
  /** Credential names, tried in turn, so a secret can rotate without downtime. */
  secrets: string[];
}

/** A trigger as matching sees it: the schedule's id, its agent, and its event cadence's source and filter. */
export interface EventTrigger {
  triggerId: string;
  agentId: string;
  source: string;
  filter: EventFilter;
}

export interface EventIntakeRequest {
  /** The `<source>` in `/events/<source>`. */
  sourceId: string;
  /** As node:http gives them: lowercase names. */
  headers: Readonly<Record<string, string | string[] | undefined>>;
  /** The raw body, read no further than one byte past `maxBodyBytes`. */
  body: Buffer;
}

export interface EventIntakeResponse {
  status: number;
  body: JsonObject;
}

export interface EventSourceCounters {
  tooLarge: number;
  badSignature: number;
  rateLimited: number;
  notReady: number;
  lastRefusal?: { at: string; reason: string };
}

export interface EventIntakeCounters {
  /** Requests to a path no source is configured for, all paths together. */
  unknownSource: number;
  /** Per configured source: requests refused before they could leave a row. */
  sources: Record<string, EventSourceCounters>;
}

export interface EventIntakeOptions {
  store: Pick<SqliteEventStore, 'accept' | 'refuse'>;
  /** The configured sources, read per request. */
  sources(): Readonly<Record<string, EventSourceConfig>>;
  /** A stored credential's value by name, or undefined when it is not set. */
  secret(name: string): string | undefined;
  /** The event triggers on a source, read per delivery. Empty until triggers exist. */
  triggers(sourceId: string): readonly EventTrigger[];
  maxBodyBytes?: number;
  now?(): Date;
  warn(line: string): void;
}

export interface EventIntake {
  receive(request: EventIntakeRequest): EventIntakeResponse;
  counters(): EventIntakeCounters;
}

export const DEFAULT_EVENT_MAX_BODY_BYTES = 1_048_576;

/** Signed requests a source may make in any minute before it hears 429. */
export const EVENT_SOURCE_REQUESTS_PER_MINUTE = 120;

/** How far a Standard Webhooks timestamp may be from our clock: the replay window. */
const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1_000;

/** A refusal is warned in the daemon log at most this often per source. */
const REFUSAL_WARN_INTERVAL_MS = 10 * 60 * 1_000;

const headerOf = (headers: EventIntakeRequest['headers'], name: string): string | undefined => {
  const value = headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
};

const constantTimeEqual = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b);

/**
 * Standard Webhooks 1.0 symmetric verification: `v1,<base64 HMAC-SHA256 of
 * "id.timestamp.body">` keyed with the base64 secret (the `whsec_` prefix is
 * optional). The header may carry several space-separated signatures, and any
 * one valid `v1` under any one secret passes, which is how a sender rotates
 * keys. Does not check the timestamp's age; the intake does.
 */
export const verifyStandardWebhookSignature = (
  input: { id: string; timestamp: string; body: Buffer; signature: string | undefined },
  secrets: readonly string[],
): boolean => {
  const offered = (input.signature ?? '')
    .split(' ')
    .filter((entry) => entry.startsWith('v1,'))
    .map((entry) => Buffer.from(entry.slice(3), 'base64'));
  if (offered.length === 0) {
    return false;
  }
  const signed = Buffer.concat([Buffer.from(`${input.id}.${input.timestamp}.`), input.body]);
  return secrets.some((secret) => {
    const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
    if (key.length === 0) {
      return false;
    }
    const expected = createHmac('sha256', key).update(signed).digest();
    return offered.some((candidate) => constantTimeEqual(candidate, expected));
  });
};

/** GitHub's `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the raw body>`, keyed with the secret as text. */
export const verifyGithubSignature = (
  input: { body: Buffer; signature: string | undefined },
  secrets: readonly string[],
): boolean => {
  const signature = input.signature ?? '';
  if (!signature.startsWith('sha256=')) {
    return false;
  }
  const offered = Buffer.from(signature.slice('sha256='.length), 'utf8');
  return secrets.some((secret) => secret.length > 0
    && constantTimeEqual(offered, Buffer.from(createHmac('sha256', secret).update(input.body).digest('hex'), 'utf8')));
};

/** A body that parsed but isn't an event; its message is the 400's. */
class MalformedEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedEventError';
  }
}

const isPlainObject = (value: unknown): value is Record<string, JsonValue> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseJsonObject = (body: Buffer | string): Record<string, JsonValue> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof body === 'string' ? body : body.toString('utf8'));
  } catch {
    throw new MalformedEventError('The body is not JSON.');
  }
  if (!isPlainObject(parsed)) {
    throw new MalformedEventError('The body must be a JSON object.');
  }
  return parsed;
};

const ATTRIBUTE_NAME = /^[a-z0-9]+$/;

/**
 * A Standard Webhooks body as an event. A structured CloudEvent (it has
 * `specversion`) keeps its attributes, and its `id` must be the `webhook-id`
 * it was signed under, or one signed delivery could be replayed as another
 * event. A plain `{ type, timestamp?, data? }` payload takes its id from
 * `webhook-id` and its source from the configured source. Extension
 * attributes keep only valid names with scalar values, as strings; anything
 * else is dropped, not refused.
 */
export const parseStandardWebhookEvent = (
  input: { sourceId: string; webhookId: string; body: Buffer | string },
): InboundEvent => {
  const object = parseJsonObject(input.body);
  if (object.specversion === undefined) {
    if (typeof object.type !== 'string' || object.type.length === 0) {
      throw new MalformedEventError('A Standard Webhooks payload needs a string "type".');
    }
    return {
      attributes: {
        specversion: '1.0',
        id: input.webhookId,
        source: `stratus:source/${input.sourceId}`,
        type: object.type,
        ...(typeof object.timestamp === 'string' ? { time: object.timestamp } : {}),
      },
      ...(object.data !== undefined ? { data: object.data } : {}),
    };
  }
  if (object.specversion !== '1.0') {
    throw new MalformedEventError(`CloudEvents specversion "${String(object.specversion)}" is not supported; send "1.0".`);
  }
  for (const required of ['id', 'source', 'type']) {
    const value = object[required];
    if (typeof value !== 'string' || value.length === 0) {
      throw new MalformedEventError(`A CloudEvent needs a non-empty string "${required}".`);
    }
  }
  if (object.id !== input.webhookId) {
    throw new MalformedEventError('The CloudEvent id must equal the webhook-id header it was signed under.');
  }
  const attributes: Record<string, string> = {};
  for (const [name, value] of Object.entries(object)) {
    if (name === 'data' || name === 'data_base64' || !ATTRIBUTE_NAME.test(name)) {
      continue;
    }
    if (typeof value === 'string') {
      attributes[name] = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      attributes[name] = String(value);
    }
  }
  return { attributes, ...(object.data !== undefined ? { data: object.data } : {}) };
};

const stringAt = (value: JsonValue | undefined, ...path: string[]): string | undefined => {
  let cursor = value;
  for (const key of path) {
    if (!isPlainObject(cursor)) {
      return undefined;
    }
    cursor = cursor[key];
  }
  return typeof cursor === 'string' && cursor.length > 0 ? cursor : undefined;
};

const numberAt = (value: JsonValue | undefined, ...path: string[]): number | undefined => {
  let cursor = value;
  for (const key of path) {
    if (!isPlainObject(cursor)) {
      return undefined;
    }
    cursor = cursor[key];
  }
  return typeof cursor === 'number' && Number.isSafeInteger(cursor) ? cursor : undefined;
};

/**
 * A GitHub webhook delivery as a CloudEvent. The subject is `pull/<n>` for
 * anything on a PR, an issue comment on a PR included, so a review and a
 * comment on one PR share a session; `issues/<n>` for an issue. `actor` is
 * who acted, `author` who owns the PR or issue: what a trigger names to wake
 * only the PR's owner. GitHub sends no event time, so `time` is when it
 * arrived.
 */
export const mapGithubDelivery = (
  input: { event: string; delivery: string; payload: unknown; receivedAt: string },
): InboundEvent => {
  const payload = (isPlainObject(input.payload) ? input.payload : {}) as JsonObject;
  const action = stringAt(payload, 'action');
  const repository = stringAt(payload, 'repository', 'full_name');
  const organization = stringAt(payload, 'organization', 'login');
  const pullNumber = numberAt(payload, 'pull_request', 'number');
  const issueNumber = numberAt(payload, 'issue', 'number');
  const issueIsPull = isPlainObject(payload.issue) && payload.issue.pull_request !== undefined;
  const subject = pullNumber !== undefined
    ? `pull/${pullNumber}`
    : issueNumber !== undefined ? `${issueIsPull ? 'pull' : 'issues'}/${issueNumber}` : undefined;
  const actor = stringAt(payload, 'sender', 'login');
  const author = stringAt(payload, 'pull_request', 'user', 'login') ?? stringAt(payload, 'issue', 'user', 'login');
  return {
    attributes: {
      specversion: '1.0',
      id: input.delivery,
      source: `https://github.com${repository ? `/${repository}` : organization ? `/${organization}` : ''}`,
      type: `com.github.${input.event}${action ? `.${action}` : ''}`,
      ...(subject !== undefined ? { subject } : {}),
      time: input.receivedAt,
      ...(actor !== undefined ? { actor } : {}),
      ...(author !== undefined ? { author } : {}),
    },
    data: payload,
  };
};

const mediaType = (contentType: string | undefined): string =>
  (contentType ?? '').split(';')[0]!.trim().toLowerCase();

export const createEventIntake = (options: EventIntakeOptions): EventIntake => {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_EVENT_MAX_BODY_BYTES;
  const now = options.now ?? (() => new Date());
  let unknownSource = 0;
  const counters = new Map<string, EventSourceCounters>();
  const signedRequests = new Map<string, number[]>();
  const lastWarned = new Map<string, number>();

  const countersFor = (sourceId: string): EventSourceCounters => {
    let entry = counters.get(sourceId);
    if (!entry) {
      entry = { tooLarge: 0, badSignature: 0, rateLimited: 0, notReady: 0 };
      counters.set(sourceId, entry);
    }
    return entry;
  };

  const refusal = (sourceId: string, reason: string): void => {
    const at = now();
    countersFor(sourceId).lastRefusal = { at: at.toISOString(), reason };
    const last = lastWarned.get(sourceId);
    if (last === undefined || at.getTime() - last >= REFUSAL_WARN_INTERVAL_MS) {
      lastWarned.set(sourceId, at.getTime());
      options.warn(`events: refused a request to source "${sourceId}": ${reason}`);
    }
  };

  const answer = (status: number, body: JsonObject): EventIntakeResponse => ({ status, body });

  /** Count a signed request against its source's minute; false when the minute is full. */
  const admitSigned = (sourceId: string): boolean => {
    const at = now().getTime();
    const recent = (signedRequests.get(sourceId) ?? []).filter((time) => at - time < 60_000);
    if (recent.length >= EVENT_SOURCE_REQUESTS_PER_MINUTE) {
      signedRequests.set(sourceId, recent);
      return false;
    }
    recent.push(at);
    signedRequests.set(sourceId, recent);
    return true;
  };

  const receive = (request: EventIntakeRequest): EventIntakeResponse => {
    const { sourceId, headers, body } = request;
    const sources = options.sources();
    const source = Object.hasOwn(sources, sourceId) ? sources[sourceId] : undefined;
    if (!source) {
      unknownSource += 1;
      return answer(404, { error: 'unknown_source', message: 'No event source is configured at this path.' });
    }
    const count = countersFor(sourceId);

    if (body.length > maxBodyBytes) {
      count.tooLarge += 1;
      refusal(sourceId, `body over ${maxBodyBytes} bytes`);
      return answer(413, { error: 'too_large', message: `The body is over ${maxBodyBytes} bytes.` });
    }

    const secrets = source.secrets
      .map((name) => options.secret(name))
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    if (secrets.length === 0) {
      count.notReady += 1;
      const reason = `No secret is set for event source "${sourceId}". Run \`stratus credential set ${source.secrets[0] ?? `events.${sourceId}`}\` on the daemon's host.`;
      refusal(sourceId, reason);
      return answer(503, { error: 'source_not_ready', message: reason });
    }

    const receivedAt = now().toISOString();
    let eventId: string | undefined;
    let signatureProblem: string | undefined;
    if (source.verify === 'github') {
      eventId = headerOf(headers, 'x-github-delivery');
      if (!verifyGithubSignature({ body, signature: headerOf(headers, 'x-hub-signature-256') }, secrets)) {
        signatureProblem = 'missing or wrong X-Hub-Signature-256 signature';
      }
    } else {
      eventId = headerOf(headers, 'webhook-id');
      const timestamp = headerOf(headers, 'webhook-timestamp');
      if (eventId === undefined || timestamp === undefined
        || !verifyStandardWebhookSignature({ id: eventId, timestamp, body, signature: headerOf(headers, 'webhook-signature') }, secrets)) {
        signatureProblem = 'missing or wrong webhook-signature (Standard Webhooks v1)';
      } else if (!/^\d+$/.test(timestamp) || Math.abs(now().getTime() - Number(timestamp) * 1_000) > TIMESTAMP_TOLERANCE_MS) {
        signatureProblem = 'webhook-timestamp is more than 5 minutes from this host\'s clock';
      }
    }
    if (signatureProblem !== undefined) {
      count.badSignature += 1;
      refusal(sourceId, signatureProblem);
      return answer(401, { error: 'bad_signature', message: `Refused: ${signatureProblem}.` });
    }

    if (!admitSigned(sourceId)) {
      count.rateLimited += 1;
      refusal(sourceId, `over ${EVENT_SOURCE_REQUESTS_PER_MINUTE} signed requests a minute`);
      return answer(429, { error: 'rate_limited', message: `Over ${EVENT_SOURCE_REQUESTS_PER_MINUTE} requests a minute for this source.` });
    }

    // Signed from here on: refusals leave a row, without a tombstone, so the
    // sender can fix the request and retry under the same id.
    const refuse = (status: number, error: string, reason: string, type?: string): EventIntakeResponse => {
      options.store.refuse({ source: sourceId, eventId: eventId ?? '', ...(type !== undefined ? { type } : {}), reason, receivedAt });
      refusal(sourceId, reason);
      return answer(status, { error, message: reason });
    };

    const type = mediaType(headerOf(headers, 'content-type'));
    let event: InboundEvent;
    try {
      if (source.verify === 'github') {
        const githubEvent = headerOf(headers, 'x-github-event');
        if (type !== 'application/json') {
          return refuse(415, 'unsupported_content_type',
            `Content type "${type || 'none'}" is not supported. In the GitHub webhook's settings, set Content type to application/json.`,
            githubEvent !== undefined ? `com.github.${githubEvent}` : undefined);
        }
        if (githubEvent === undefined || githubEvent.length === 0 || eventId === undefined || eventId.length === 0) {
          throw new MalformedEventError('A GitHub delivery needs X-GitHub-Event and X-GitHub-Delivery headers.');
        }
        event = mapGithubDelivery({ event: githubEvent, delivery: eventId, payload: parseJsonObject(body), receivedAt });
      } else {
        if (type !== 'application/json' && type !== 'application/cloudevents+json') {
          return refuse(415, 'unsupported_content_type',
            `Content type "${type || 'none'}" is not supported. Send application/cloudevents+json or application/json.`);
        }
        event = parseStandardWebhookEvent({ sourceId, webhookId: eventId!, body });
      }
    } catch (error) {
      if (error instanceof MalformedEventError) {
        return refuse(400, 'malformed', error.message);
      }
      throw error;
    }

    // The rule filter, before anything that could cost a model call.
    const matched = options.triggers(sourceId)
      .filter((trigger) => trigger.source === sourceId && matchesEventFilter(trigger.filter, event));
    const coalescingKey = eventCoalescingKey(sourceId, event);
    const block = matched.length > 0 ? renderEventBlock(sourceId, event) : '';
    const firings: NewEventFiring[] = matched.map((trigger) => ({
      triggerId: trigger.triggerId,
      agentId: trigger.agentId,
      coalescingKey,
      sessionId: eventSessionId(trigger.triggerId, coalescingKey),
      dispatchKey: eventDispatchKey(trigger.triggerId, sourceId, event.attributes.id ?? ''),
      block,
    }));
    const accepted = options.store.accept({
      source: sourceId,
      eventId: event.attributes.id ?? '',
      type: event.attributes.type ?? '',
      ...(event.attributes.subject !== undefined ? { subject: event.attributes.subject } : {}),
      receivedAt,
      firings,
    });
    return answer(200, { status: accepted.status });
  };

  return {
    receive,
    counters: () => ({
      unknownSource,
      sources: Object.fromEntries(Object.keys(options.sources()).map((sourceId) => {
        const entry = countersFor(sourceId);
        return [sourceId, {
          ...entry,
          ...(entry.lastRefusal ? { lastRefusal: { ...entry.lastRefusal } } : {}),
        }];
      })),
    }),
  };
};
