import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { Gateway, GatewayChannelAdapter } from '@stratusagent/gateway';

import { authority } from './authority.ts';

// The events port (card 590): a second HTTP server, apart from the control
// API, that serves `POST /events/<source>` and nothing else. Apart so a
// deployment can expose it to the internet (a tunnel, a Fly service) while
// `/api/v1` stays on loopback, and so the control port never serves events.
// Everything a delivery means is decided by the gateway's intake; this only
// reads a bounded body and writes the answer.

export const DEFAULT_EVENTS_PORT = 4124;
export const DEFAULT_EVENTS_HOST = '127.0.0.1';

/** Matches the intake's own default; the body is read no further than one byte past it. */
const DEFAULT_MAX_BODY_BYTES = 1_048_576;

/**
 * A slow sender holds a socket and a buffer; GitHub gives up after 10 s, so
 * nothing honest needs longer than this to send a body.
 */
const REQUEST_TIMEOUT_MS = 15_000;
const HEADERS_TIMEOUT_MS = 10_000;

const SOURCE_PATH = /^\/events\/([^/]+)$/;

export interface EventListenerOptions {
  /** Interface to bind. Loopback by default; exposing it is the operator's tunnel or proxy decision. */
  host?: string;
  /** Port to bind. 0 picks a free one. */
  port?: number;
  maxBodyBytes?: number;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

export interface EventListener extends GatewayChannelAdapter {
  /** Where it is listening, once started. */
  readonly url: string | undefined;
}

const sendJson = (response: ServerResponse, status: number, payload: unknown): void => {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(payload));
};

/**
 * The body, read no further than `limit + 1` bytes: one past the limit is
 * enough for the intake to answer 413, and reading on would buffer whatever
 * a sender chose to stream.
 */
const readBounded = (request: IncomingMessage, limit: number): Promise<{ body: Buffer; complete: boolean }> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (complete: boolean): void => {
      if (!settled) {
        settled = true;
        resolve({ body: Buffer.concat(chunks).subarray(0, limit + 1), complete });
      }
    };
    request.on('data', (chunk: Buffer) => {
      if (settled) {
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
      if (size > limit) {
        request.pause();
        finish(false);
      }
    });
    request.once('end', () => finish(true));
    request.once('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });

export const createEventListener = (options: EventListenerOptions = {}): EventListener => {
  const host = options.host ?? DEFAULT_EVENTS_HOST;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const log = options.log ?? (() => {});
  const warn = options.warn ?? (() => {});
  let server: Server | undefined;
  let url: string | undefined;

  const handle = async (gateway: Gateway, request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const pathname = new URL(request.url ?? '/', 'http://events.invalid').pathname;
    const match = SOURCE_PATH.exec(pathname);
    if (!match) {
      sendJson(response, 404, { error: 'not_found', message: 'This port takes POST /events/<source> only.' });
      return;
    }
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      sendJson(response, 405, { error: 'method_not_allowed', message: 'Send events with POST.' });
      return;
    }
    let sourceId: string;
    try {
      sourceId = decodeURIComponent(match[1]!);
    } catch {
      sendJson(response, 404, { error: 'not_found', message: 'No event source is configured at this path.' });
      return;
    }
    const { body, complete } = await readBounded(request, maxBodyBytes);
    if (!complete) {
      // The rest of an oversized body is not read; the connection goes
      // with the answer rather than draining it.
      response.setHeader('connection', 'close');
    }
    const answer = await gateway.receiveEvent({ sourceId, headers: request.headers, body });
    sendJson(response, answer.status, answer.body);
    if (!complete) {
      response.once('finish', () => request.destroy());
    }
  };

  return {
    name: 'events',
    // An events port that fails to bind leaves agents running and reachable
    // every other way, so the daemon serves on and says so; a refused
    // delivery shows in the sender's own history.
    required: false,

    get url() {
      return url;
    },

    async start(gateway: Gateway) {
      const listening = createServer((request, response) => {
        void handle(gateway, request, response).catch((error: unknown) => {
          warn(`events: a request failed: ${error instanceof Error ? error.message : String(error)}`);
          if (!response.headersSent) {
            sendJson(response, 500, { error: 'internal_error', message: 'The delivery could not be recorded; retry it.' });
          } else {
            response.end();
          }
        });
      });
      listening.requestTimeout = REQUEST_TIMEOUT_MS;
      listening.headersTimeout = HEADERS_TIMEOUT_MS;
      const asked = authority(host, options.port ?? DEFAULT_EVENTS_PORT);
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(new Error(
          `The events listener could not listen on ${asked} (${error.message}). Another program may hold the port: `
            + 'pick a different one with `events.listen.port` in the config.',
        ));
        listening.once('error', onError);
        listening.listen(options.port ?? DEFAULT_EVENTS_PORT, host, () => {
          listening.off('error', onError);
          resolve();
        });
      });
      server = listening;
      const address = listening.address();
      if (!address || typeof address === 'string') {
        throw new Error('The events listener could not determine the address it bound.');
      }
      url = `http://${authority(host, address.port)}`;
      log(`events listener on ${url}/events/<source>`);
    },

    async stop() {
      const closing = server;
      server = undefined;
      url = undefined;
      if (closing) {
        await new Promise<void>((resolve) => {
          closing.close(() => resolve());
          closing.closeAllConnections?.();
        });
      }
    },
  };
};
