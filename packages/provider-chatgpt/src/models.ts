// The models a signed-in ChatGPT account can run, for setup's model picker:
// OpenAI's list for that account (`GET /v1/models` on its access token), only
// the entries meant to be shown, in the order OpenAI sent them. OpenAI's docs
// ask for this list rather than a fixed catalog, and for it to be read again
// when the account changes.
import { ResponsesApiError } from '@stratusagent/providers';
import { ChatGPTAuthError } from './errors.ts';
import { CHATGPT_RESOURCE, clip, isRecord, send, type RequestOptions } from './protocol.ts';
import { createSignedInTokenSource, planErrorLead, withLead, type SignedInTokenSourceOptions } from './provider.ts';

export interface ChatGPTModel {
  /** What to pass as `model`. */
  readonly slug: string;
  /** What to show a person: OpenAI's display name, or the slug when it gave none. */
  readonly displayName: string;
}

export interface ListChatGPTModelsOptions extends RequestOptions {
  /**
   * The account's access token, as the token source hands it out (which may
   * refresh it first). Asked with `signal`.
   */
  readonly accessToken: (signal: AbortSignal | undefined) => Promise<string>;
  /** How long the list may take once the token is in hand. Default 15 seconds. */
  readonly timeoutMs?: number;
}

export const DEFAULT_MODEL_LIST_TIMEOUT_MS = 15_000;

const WHAT = "OpenAI's model list";

const NOT_LISTED = "OpenAI didn't list the models for this ChatGPT account.";

/**
 * Lists the models the signed-in account can pick. Fails with the token
 * source's own error when there is no usable sign-in (nothing is sent then);
 * with a `ResponsesApiError` when OpenAI refuses, in the same words a turn
 * would use for the plan's own errors; and with a `ChatGPTAuthError` when
 * OpenAI can't be reached (`temporary`), doesn't answer in time (`timeout`),
 * sends a list it can't read (`request_failed`), or the caller cancels
 * (`cancelled`). An account with nothing to show lists nothing.
 */
export const listChatGPTModels = async (options: ListChatGPTModelsOptions): Promise<ChatGPTModel[]> => {
  const token = await options.accessToken(options.signal);
  const timeoutMs = options.timeoutMs ?? DEFAULT_MODEL_LIST_TIMEOUT_MS;
  // A timer of our own, cleared once the answer is read, rather than
  // AbortSignal.timeout, whose timer doesn't keep the process waiting.
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error('The model list timed out.')), timeoutMs);
  let answer: Awaited<ReturnType<typeof send>>;
  try {
    answer = await send(
      {
        ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
        signal: options.signal !== undefined ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal,
      },
      `${CHATGPT_RESOURCE}/models`,
      { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' } },
      WHAT,
    );
  } catch (error) {
    if (timeout.signal.aborted && options.signal?.aborted !== true) {
      const seconds = Math.ceil(timeoutMs / 1000);
      throw new ChatGPTAuthError(
        'timeout',
        `${WHAT} didn't answer within ${seconds} second${seconds === 1 ? '' : 's'}. Check the connection and try again.`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const { response, body, text } = answer;
  if (!response.ok) {
    throw refusal(response, body, text, token);
  }
  const models = isRecord(body) && Array.isArray(body.models) ? body.models : undefined;
  if (models === undefined) {
    throw new ChatGPTAuthError('request_failed', `${WHAT} came back unreadable. Try again later.`);
  }
  return models.flatMap((entry): ChatGPTModel[] => {
    if (!isRecord(entry) || entry.visibility !== 'list' || typeof entry.slug !== 'string' || entry.slug === '') {
      return [];
    }
    const named = typeof entry.display_name === 'string' && entry.display_name.trim() !== '';
    return [{ slug: entry.slug, displayName: named ? (entry.display_name as string) : entry.slug }];
  });
};

export interface ListSignedInChatGPTModelsOptions extends SignedInTokenSourceOptions {
  readonly signal?: AbortSignal;
  /** As on `listChatGPTModels`. */
  readonly timeoutMs?: number;
}

/**
 * `listChatGPTModels` on the sign-in in `store`, through the token source a
 * turn uses: a token about to run out is refreshed under the session lock
 * first, and with no sign-in that allows plan usage nothing is sent. Fails
 * as `listChatGPTModels` and the token source do.
 */
export const listSignedInChatGPTModels = (options: ListSignedInChatGPTModelsOptions): Promise<ChatGPTModel[]> => {
  const tokens = createSignedInTokenSource(options);
  return listChatGPTModels({
    accessToken: (signal) => tokens.accessToken(signal),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
};

/**
 * OpenAI's refusal as the Responses adapter reports one (its message, code,
 * param, request ID, and the `detail` of an admission refusal), led by what
 * to do. The token is taken out of anything OpenAI sent back.
 */
const refusal = (response: Response, body: unknown, text: string, token: string): ResponsesApiError => {
  const hide = (value: string): string => (token === '' ? value : value.split(token).join('[redacted]'));
  const shown = (value: unknown): string | undefined =>
    typeof value === 'string' && value !== '' ? clip(hide(value)) : undefined;
  const error = isRecord(body) && isRecord(body.error) ? body.error : undefined;
  const reported = typeof error?.message === 'string'
    ? error.message
    : error?.message != null
      ? JSON.stringify(error.message)
      : text !== '' ? text : `HTTP ${response.status} with no body`;
  const refused = new ResponsesApiError(clip(hide(reported)), {
    status: response.status,
    code: shown(error?.code),
    param: shown(error?.param),
    requestId: shown(response.headers.get('x-request-id')),
    detail: error === undefined && isRecord(body) ? shown(body.detail) : undefined,
  });
  return withLead(refused, planErrorLead(refused) ?? NOT_LISTED);
};
