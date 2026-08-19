import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * The version every path is prefixed with.
 *
 * A path rather than a header, because the macOS app pins against it and a
 * version you can see in a curl, a proxy log, and a browser address bar is
 * one that gets noticed when it changes.
 */
export const API_PREFIX = '/api/v1';

/**
 * The largest request body the API will read.
 *
 * A bound rather than a stream to memory: every body here is a small JSON
 * document (a message, a soul, a config), and an unbounded read is a way to
 * exhaust a daemon's memory from a socket that never closes.
 */
const MAX_BODY_BYTES = 1_048_576;

/** An error a client can act on: a stable code plus a sentence for a human. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export const sendJson = (response: ServerResponse, status: number, payload: unknown): void => {
  const body = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  // Nothing here is cacheable and some of it is sensitive; a proxy or a
  // browser holding a roster or a session transcript is not wanted.
  response.setHeader('cache-control', 'no-store');
  response.end(body);
};

export const sendError = (response: ServerResponse, error: unknown): void => {
  if (error instanceof ApiError) {
    sendJson(response, error.status, { error: { code: error.code, message: error.message } });
    return;
  }
  sendJson(response, 500, {
    error: {
      code: 'internal_error',
      message: error instanceof Error ? error.message : String(error),
    },
  });
};

/** Read a bounded request body, or refuse. */
export const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new ApiError(413, 'body_too_large', `Request bodies are limited to ${MAX_BODY_BYTES} bytes.`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
};

/** Read a JSON object body, refusing anything that is not one. */
export const readJsonObject = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const raw = (await readBody(request)).trim();
  if (raw.length === 0) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ApiError(400, 'invalid_json', `Request body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ApiError(400, 'invalid_body', 'Request body must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
};

/** A non-empty string field, or a 400 that names the field. */
export const requireString = (body: Record<string, unknown>, field: string): string => {
  const value = body[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ApiError(400, 'invalid_body', `"${field}" must be a non-empty string.`);
  }
  return value;
};

/** An optional string field, or a 400 if present and not a string. */
export const optionalString = (body: Record<string, unknown>, field: string): string | undefined => {
  const value = body[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new ApiError(400, 'invalid_body', `"${field}" must be a string when present.`);
  }
  return value;
};

export interface RouteMatch {
  params: Record<string, string>;
}

/**
 * Match one path against a pattern with `:name` segments.
 *
 * A hand-rolled matcher rather than a framework: there are two dozen routes
 * and none of them needs middleware, mounting, or wildcards. Segments are
 * compared after decoding, so an id containing a slash cannot smuggle itself
 * into the next segment.
 */
export const matchPath = (pattern: string, pathname: string): RouteMatch | undefined => {
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');
  if (patternParts.length !== pathParts.length) {
    return undefined;
  }
  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index] ?? '';
    const actual = pathParts[index] ?? '';
    if (expected.startsWith(':')) {
      if (actual.length === 0) {
        return undefined;
      }
      let decoded: string;
      try {
        decoded = decodeURIComponent(actual);
      } catch {
        return undefined;
      }
      params[expected.slice(1)] = decoded;
      continue;
    }
    if (expected !== actual) {
      return undefined;
    }
  }
  return { params };
};

/** True for methods that change state, and so must be origin-bound. */
export const isStateChanging = (method: string): boolean =>
  method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
