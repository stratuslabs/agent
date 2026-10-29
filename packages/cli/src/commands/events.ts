import { escapeControlCharacters } from '@stratusagent/core';
import { gatewayInfoPath } from '@stratusagent/state';
import { callRunningGateway, gatewayErrorMessage, runningGatewayBase } from '../daemon.ts';
import type { CliStreams, CliEnvironment } from '../environment.ts';
import { writeLine } from '../io.ts';
import type { ParsedEventsCommand } from '../parse.ts';

/** A daemon that doesn't answer in this long is reported, not waited on. */
const EVENTS_TIMEOUT_MS = 5_000;

/** The fields of `GET /api/v1/events/sources` the text view reads; JSON passes the rest through. */
interface SourceSummary {
  /** The plugin that feeds a source the config doesn't define. */
  plugin?: string;
  lastDelivery?: { at: string; type: string; subject?: string; status: string };
  lastRefusal?: { at: string; reason: string };
  deliveries?: Record<string, number>;
  firings?: Record<string, number>;
  refusedBeforeRow?: Record<string, number>;
}

interface EventsPayload {
  sources?: Record<string, SourceSummary>;
  unknownSource?: number;
}

// Most telling first: what reached an agent, then what didn't.
const DELIVERY_ORDER = ['matched', 'unmatched', 'duplicate', 'refused'];
const FIRING_ORDER = ['fired', 'failed', 'firing', 'pending', 'held', 'rate_limited', 'superseded', 'expired'];
const BEFORE_ROW_LABELS: Record<string, string> = {
  badSignature: 'bad signature',
  tooLarge: 'too large',
  rateLimited: 'over the rate',
  notReady: 'no secret set',
};

// Every string below is printed escaped. A delivery's type and subject, and
// a refusal reason quoting them, are whatever a signed sender wrote, so a
// raw newline, ANSI escape or bidi control could forge a line or recolor
// the terminal. The same rule `stratus sessions` and `stratus memory` follow.
const safe = escapeControlCharacters;

/** Nonzero counts in a fixed order, then any status this CLI doesn't know, so a newer daemon's are still shown. */
const counts = (byStatus: Record<string, number> | undefined, order: readonly string[], label = (key: string) => key): string[] => {
  const entries = Object.entries(byStatus ?? {}).filter(([, count]) => typeof count === 'number' && count > 0);
  const rank = (key: string) => (order.includes(key) ? order.indexOf(key) : order.length);
  return entries.sort(([a], [b]) => rank(a) - rank(b)).map(([key, count]) => `${count} ${safe(label(key))}`);
};

/**
 * `stratus events` — what the running daemon's events port has been doing,
 * per configured source: the last delivery, the last refusal and why, the
 * last 24 hours by status, and the requests refused before they could leave
 * a row (bad signature, too large, over the rate, no secret).
 *
 * Asked of the daemon, not read from `fleet.db`, because those last ones
 * live only in the running listener: a webhook with the wrong secret leaves
 * no row by design, and it is exactly what an operator runs this to find.
 */
export const runEvents = async (
  command: ParsedEventsCommand,
  streams: CliStreams,
  env: CliEnvironment = {},
): Promise<number> => {
  const fail = (message: string): number => {
    writeLine(streams.stderr, `Error: ${message}`);
    return 1;
  };

  const base = await runningGatewayBase(env, command);
  if (!base) {
    return fail(
      `stratusd is not serving — ${gatewayInfoPath(env)} does not exist, and no --gateway was given. `
      + 'Start it with `stratus serve` or `stratus service start`. The events port runs only inside a serving daemon.',
    );
  }

  let payload: EventsPayload;
  try {
    const response = await callRunningGateway(env, command, base, '/api/v1/events/sources', undefined, 'GET', AbortSignal.timeout(EVENTS_TIMEOUT_MS));
    if (response.status === 404) {
      return fail(`The gateway at ${base} has no /api/v1/events/sources. It is older than this CLI; restart it on this version.`);
    }
    if (!response.ok) {
      return fail(`The gateway at ${base} answered /api/v1/events/sources with ${await gatewayErrorMessage(response)}.`);
    }
    payload = await response.json() as EventsPayload;
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  if (command.format === 'json') {
    writeLine(streams.stdout, JSON.stringify({ gateway: base, ...payload }));
    return 0;
  }

  const sources = Object.entries(payload.sources ?? {});
  if (sources.length === 0) {
    writeLine(
      streams.stdout,
      'No event sources are configured. A source is an entry in the "events" block of ~/.stratus/config.json, or one a loaded plugin feeds; see docs/guides/events.md.',
    );
    return 0;
  }
  for (const [id, source] of sources) {
    writeLine(streams.stdout, typeof source.plugin === 'string' ? `${safe(id)} (fed by plugin ${safe(source.plugin)})` : safe(id));
    const last = source.lastDelivery;
    // A refused body may have no type to show (form-encoded, say).
    writeLine(streams.stdout, last
      ? `  last delivery: ${[last.at, last.type, last.subject].filter((part): part is string => part !== undefined && part !== '').map((part) => safe(part)).join(' ')} (${safe(last.status)})`
      : '  last delivery: none yet');
    if (source.lastRefusal) {
      writeLine(streams.stdout, `  last refusal: ${safe(source.lastRefusal.at)} ${safe(source.lastRefusal.reason)}`);
    }
    const deliveries = counts(source.deliveries, DELIVERY_ORDER);
    const firings = counts(source.firings, FIRING_ORDER);
    writeLine(streams.stdout, `  last 24h: ${deliveries.length > 0 ? deliveries.join(', ') : 'no deliveries'}; `
      + `${firings.length > 0 ? `firings: ${firings.join(', ')}` : 'no firings'}`);
    const beforeRow = counts(source.refusedBeforeRow, Object.keys(BEFORE_ROW_LABELS), (key) => BEFORE_ROW_LABELS[key] ?? key);
    if (beforeRow.length > 0) {
      writeLine(streams.stdout, `  refused before a row since the daemon started: ${beforeRow.join(', ')}`);
    }
  }
  if ((payload.unknownSource ?? 0) > 0) {
    writeLine(streams.stdout, `Requests to unknown sources since the daemon started: ${payload.unknownSource}`);
  }
  return 0;
};
