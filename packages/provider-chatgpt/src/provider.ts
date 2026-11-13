// The model provider for a ChatGPT sign-in: the Responses adapter on the
// signed-in account's access token, kept current by the token source, with
// the plan's own errors put in words a person can act on. Where the session
// is kept and how it is locked belong to the caller, as for the token source.
import type { ModelProvider } from '@stratusagent/core';
import { ResponsesApiError, createOpenAIResponsesProvider } from '@stratusagent/providers';
import { ChatGPTAuthError } from './errors.ts';
import { CHATGPT_RESOURCE, discoverEndpoints, type ChatGPTEndpoints } from './protocol.ts';
import { createChatGPTTokenSource, type ChatGPTSessionStore } from './session.ts';

export interface ChatGPTProviderOptions {
  /** A model slug the signed-in account lists (`GET /v1/models`). */
  readonly model: string;
  readonly store: ChatGPTSessionStore;
  /** As on the token source: every write of the session takes it. */
  readonly withSessionLock: <T>(work: () => Promise<T>) => Promise<T>;
  /**
   * OpenAI's sign-in endpoints. Default: read from its OpenID configuration
   * the first time a refresh needs them, and kept once read.
   */
  readonly endpoints?: ChatGPTEndpoints;
  /** How long that lookup may take. Default 15 seconds. */
  readonly discoveryTimeoutMs?: number;
  readonly systemPrompt?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** As on the Responses adapter. */
  readonly requestTimeoutMs?: number;
}

/**
 * Sign in with ChatGPT takes function tools only inside a namespace. The
 * model sees this name and description above the tools.
 */
export const CHATGPT_TOOL_NAMESPACE = {
  name: 'stratus',
  description: 'The tools this Stratus agent can use.',
} as const;

export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage';

export const DEFAULT_DISCOVERY_TIMEOUT_MS = 15_000;

const SIGN_IN_AGAIN = 'Sign in with ChatGPT again in `stratus setup`.';

const CLIENT_NOT_AUTHORIZED =
  "ChatGPT says this sign-in isn't authorized to use the plan for this request. That points to how Stratus registered the sign-in, not to your account, so signing in again won't help: please report it with the request ID.";

/**
 * What to tell a person for each ChatGPT plan error OpenAI documents a
 * recovery for, by code ("Errors and recovery" in OpenAI's Sign in with
 * ChatGPT docs). None of them is retried here or sent another way: OpenAI
 * asks that plan errors stop the request.
 */
const PLAN_ERRORS: Readonly<Record<string, (param: string | undefined) => string>> = {
  subscription_sharing_usage_limit_exceeded: () =>
    `ChatGPT says this account has reached a usage limit for Stratus Agent. See ${CHATGPT_USAGE_URL} and try again later.`,
  subscription_sharing_usage_unavailable: () =>
    "ChatGPT couldn't check this account's plan usage just now. Try again in a few minutes.",
  subscription_sharing_user_unavailable: () =>
    "ChatGPT couldn't check this account's plan usage just now. Try again in a few minutes.",
  subscription_sharing_user_not_eligible: () =>
    "ChatGPT plan usage isn't available for this account or workspace. Sign in with another ChatGPT account, or use an OpenAI API key, in `stratus setup`.",
  subscription_sharing_unsupported_capability: (param) =>
    `ChatGPT plan usage doesn't support part of this request${param !== undefined ? ` (${param})` : ''}.`,
  subscription_sharing_route_not_supported: () =>
    "ChatGPT plan usage doesn't support the endpoint Stratus called. This is a Stratus bug; please report it.",
  // OpenAI: sign in again only after a confirmed revocation or a dead
  // refresh token, which the token source already handles; otherwise keep
  // the request ID and diagnose.
  subscription_sharing_invalid_user: () =>
    "ChatGPT couldn't validate the account this sign-in belongs to. Try again later, and if it keeps failing, report it with the request ID.",
  // OpenAI: check the client and grant configuration, not OAuth again. The
  // client is the one Stratus registered at sign-in.
  chatpass_v2_scope_not_authorized: () => CLIENT_NOT_AUTHORIZED,
  chatpass_v2_invalid_authorization_context: () => CLIENT_NOT_AUTHORIZED,
};

/**
 * Refusals at admission, before the Responses API sees the request: a body
 * like `{"detail": "..."}` with no error code, whose text OpenAI says is
 * diagnostic only. By status.
 */
const ADMISSION_ERRORS: Readonly<Record<number, string>> = {
  401: `ChatGPT didn't accept this sign-in for plan usage. ${SIGN_IN_AGAIN}`,
  403: 'ChatGPT refused to serve this request, for example from this region.',
  503: 'ChatGPT plan usage is unavailable right now. Try again later.',
};

/**
 * What to tell a person when `error` is one of the plan's own errors: by its
 * code, or by status for a refusal at admission. Undefined for any other.
 */
export const planErrorLead = (error: ResponsesApiError): string | undefined => {
  const explain = error.code !== undefined ? PLAN_ERRORS[error.code] : undefined;
  return explain !== undefined
    ? explain(error.param)
    : error.code === undefined && error.detail !== undefined && error.status !== undefined
      ? ADMISSION_ERRORS[error.status]
      : undefined;
};

/**
 * `error` led by `lead`, keeping what OpenAI said, the status and the request
 * ID (which OpenAI asks to be kept).
 */
export const withLead = (error: ResponsesApiError, lead: string): ResponsesApiError => {
  const facts = [
    `OpenAI: ${error.message}`,
    ...(error.status !== undefined ? [`HTTP ${error.status}`] : []),
    ...(error.requestId !== undefined ? [`request ${error.requestId}`] : []),
  ];
  return new ResponsesApiError(
    `${lead} (${facts.join('; ')})`,
    { status: error.status, code: error.code, param: error.param, requestId: error.requestId },
    { cause: error },
  );
};

/**
 * The error in words a person can act on when it is one of the plan's own;
 * anything else as it came.
 */
const describePlanError = (error: unknown): unknown => {
  if (!(error instanceof ResponsesApiError)) {
    return error;
  }
  const lead = planErrorLead(error);
  return lead === undefined ? error : withLead(error, lead);
};

/**
 * A model provider that runs on the ChatGPT sign-in in `store`. Each request
 * asks the token source for the access token, so a turn that outlives the
 * hour-long token sends the refreshed one; a missing or ended sign-in fails
 * the turn with a `ChatGPTAuthError` before anything is sent.
 */
export const createChatGPTProvider = (options: ChatGPTProviderOptions): ModelProvider => {
  const discoveryTimeoutMs = options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  // The lookup runs inside the session lock, so it stops at its own timeout
  // and when the turn is cancelled: a GET spends nothing, unlike the refresh
  // it is for, which is never cut off once sent.
  const lookUp = async (signal: AbortSignal | undefined): Promise<ChatGPTEndpoints> => {
    // A timer of our own, cleared when the lookup ends, rather than
    // AbortSignal.timeout, whose timer doesn't keep the process waiting.
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error('The lookup timed out.')), discoveryTimeoutMs);
    try {
      return await discoverEndpoints({
        ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
        signal: signal !== undefined ? AbortSignal.any([signal, timeout.signal]) : timeout.signal,
      });
    } catch (error) {
      if (timeout.signal.aborted && signal?.aborted !== true) {
        const seconds = Math.ceil(discoveryTimeoutMs / 1000);
        throw new ChatGPTAuthError(
          'timeout',
          `OpenAI's sign-in configuration didn't answer within ${seconds} second${seconds === 1 ? '' : 's'}. Check the connection and try again.`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
  let discovered: Promise<ChatGPTEndpoints> | undefined;
  const endpoints = options.endpoints ?? ((signal: AbortSignal | undefined) => {
    // Kept once found; a lookup that failed, timed out or was cancelled is
    // not, so the next refresh looks again.
    discovered ??= lookUp(signal).catch((error: unknown) => {
      discovered = undefined;
      throw error;
    });
    return discovered;
  });
  const tokens = createChatGPTTokenSource({
    endpoints,
    store: options.store,
    withSessionLock: options.withSessionLock,
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  const adapter = createOpenAIResponsesProvider({
    name: 'chatgpt',
    model: options.model,
    apiKey: (signal) => tokens.accessToken(signal),
    baseUrl: CHATGPT_RESOURCE,
    toolNamespace: CHATGPT_TOOL_NAMESPACE,
    ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
  });
  return {
    ...adapter,
    async generate(request) {
      try {
        return await adapter.generate(request);
      } catch (error) {
        throw describePlanError(error);
      }
    },
  };
};
