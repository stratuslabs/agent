// The Sign in with ChatGPT protocol for an open-source host, as OpenAI
// documents it at developers.openai.com/siwc/token-sharing-open-source:
// dynamic client registration with a per-host ID, Authorization Code with
// PKCE on a 127.0.0.1 callback, ID-token validation, rotating refresh tokens
// and revocation. Nothing here stores a token or opens a browser; the caller
// (setup and the runtime) owns both.
import { createHash, randomBytes, randomUUID, type JsonWebKey } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { redactSecrets } from '@stratusagent/core';
import { ChatGPTAuthError } from './errors.ts';
import { idTokenKeyId, verifyIdToken, type JsonWebKeySet } from './id-token.ts';

export const CHATGPT_ISSUER = 'https://auth.openai.com';
/** The API the tokens are for, sent as `resource` on every authorize and token request. */
export const CHATGPT_RESOURCE = 'https://api.openai.com/v1';
/** Without this scope a sign-in is valid but may not spend the user's ChatGPT plan. */
export const CHATGPT_PLAN_SCOPE = 'chatgpt.tokens.use.direct';
export const CHATGPT_SCOPES: readonly string[] = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'resource.invoke',
  CHATGPT_PLAN_SCOPE,
];
/** The first-sign-in entry point. Never an issued client ID, so never saved or used for tokens. */
export const DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
/** Shown to the user when they name the agent; the same on every install. */
export const CHATGPT_AGENT_NAME = 'Stratus Agent';
export const CALLBACK_PATH = '/auth/callback';

/**
 * Refresh-token errors after which the token can't be used again, so the
 * tokens are cleared and the user signs in again. Anything else (a network
 * failure, a 5xx) keeps them.
 */
export const TERMINAL_REFRESH_ERRORS: readonly string[] = [
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
];

export interface ChatGPTEndpoints {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint: string;
  readonly jwksUri: string;
}

export interface RequestOptions {
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
}

export interface ChatGPTTokens {
  readonly accessToken: string;
  /** Rotating: every refresh returns a replacement, and the old one is dead. */
  readonly refreshToken: string;
  readonly idToken?: string;
  readonly tokenType: string;
  /** Milliseconds since the epoch. */
  readonly expiresAt: number;
  /**
   * The granted scopes, when the response lists them. Absent on a refresh
   * that doesn't, in which case the grant is unchanged (refresh sends no
   * `scope`), so the caller keeps the scopes it saved.
   */
  readonly scopes?: readonly string[];
  /** Milliseconds since the epoch. */
  readonly receivedAt: number;
}

/** A completed, validated sign-in: what setup stores. */
export interface ChatGPTSignIn {
  /** The issued `oaiapp_…` client ID, kept through sign-out for the next sign-in. */
  readonly clientId: string;
  /** The validated ID-token subject: the account's identity. */
  readonly subject: string;
  readonly email?: string;
  readonly idToken: string;
  readonly tokens: ChatGPTTokens;
  /** Whether the user let this host spend their ChatGPT plan. */
  readonly planUsage: boolean;
}

/** A saved account being signed in again. */
export interface ReturningAccount {
  readonly clientId: string;
  readonly subject: string;
  /** Sent as `id_token_hint`. OpenAI's docs say to omit it after sign-out. */
  readonly idToken?: string;
  /** Sent as `login_hint`. */
  readonly email?: string;
}

export interface SignInAttemptOptions {
  readonly endpoints: ChatGPTEndpoints;
  /** This host's `ext_agent_host_id`, made once by `createHostId` and kept through sign-out. */
  readonly hostId: string;
  /** `http://127.0.0.1:<port>/auth/callback`, from the callback listener. */
  readonly redirectUri: string;
  /** Omitted for a first sign-in, which registers a new client. */
  readonly account?: ReturningAccount;
}

export interface SignInAttempt {
  /**
   * The browser URL. On a returning sign-in it carries the ID token as
   * `id_token_hint`, so show it to the user but never log it.
   */
  readonly url: string;
  readonly redirectUri: string;
  /** `dynamic_agent_client` on a first sign-in, the issued ID after that. */
  readonly clientId: string;
  readonly registering: boolean;
  readonly expectedSubject?: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const clip = (text: string): string => (text.length > 300 ? `${text.slice(0, 300)}…` : text);

const randomToken = (): string => randomBytes(32).toString('base64url');

/** A new `ext_agent_host_id`. Make it once per host, before the first sign-in, and keep it. */
export const createHostId = (): string => `urn:uuid:${randomUUID()}`;

/**
 * OpenAI accepts only this callback shape: plain HTTP on 127.0.0.1 (never
 * `localhost`) and the path `/auth/callback`; only the port may vary.
 */
export const isLoopbackRedirectUri = (value: string): boolean => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'http:' &&
    url.hostname === '127.0.0.1' &&
    url.port !== '' &&
    url.pathname === CALLBACK_PATH &&
    url.search === '' &&
    url.hash === '' &&
    url.username === '' &&
    url.password === ''
  );
};

export const createSignInAttempt = (options: SignInAttemptOptions): SignInAttempt => {
  if (options.hostId.trim() === '' || /\s/.test(options.hostId)) {
    throw new Error('A ChatGPT sign-in needs this host\'s ID: make one with createHostId and keep it.');
  }
  if (!isLoopbackRedirectUri(options.redirectUri)) {
    throw new Error(`${options.redirectUri} is not a ChatGPT sign-in callback: it must be http://127.0.0.1:<port>${CALLBACK_PATH}.`);
  }
  const { account } = options;
  if (account?.clientId === DYNAMIC_CLIENT_ID || account?.clientId === '') {
    throw new Error(`A returning ChatGPT sign-in needs the issued client ID, not ${DYNAMIC_CLIENT_ID}.`);
  }

  const state = randomToken();
  const nonce = randomToken();
  const codeVerifier = randomToken();
  const clientId = account?.clientId ?? DYNAMIC_CLIENT_ID;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: options.redirectUri,
    scope: CHATGPT_SCOPES.join(' '),
    resource: CHATGPT_RESOURCE,
    state,
    nonce,
    code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'),
    code_challenge_method: 'S256',
    ext_agent_host_id: options.hostId,
  });
  if (account === undefined) {
    params.set('agent_name_hint', CHATGPT_AGENT_NAME);
  } else {
    if (account.idToken !== undefined) {
      params.set('id_token_hint', account.idToken);
    }
    if (account.email !== undefined) {
      params.set('login_hint', account.email);
    }
  }
  const url = new URL(options.endpoints.authorizationEndpoint);
  // URLSearchParams writes a space as `+`, which is form encoding; OpenAI's
  // docs ask for each value URL-encoded. A literal `+` is already `%2B`.
  url.search = params.toString().replaceAll('+', '%20');

  return {
    url: url.toString(),
    redirectUri: options.redirectUri,
    clientId,
    registering: account === undefined,
    ...(account !== undefined ? { expectedSubject: account.subject } : {}),
    state,
    nonce,
    codeVerifier,
  };
};

export interface CallbackResult {
  readonly code: string;
  /** The client ID to exchange the code with and to save. */
  readonly clientId: string;
}

/** Checks a callback's query against the attempt it should belong to. */
export const readCallback = (attempt: SignInAttempt, params: URLSearchParams): CallbackResult => {
  // State first, even for an error: an error for some other attempt says
  // nothing about this one.
  if (params.get('state') !== attempt.state) {
    throw new ChatGPTAuthError('state_mismatch', "The browser returned a sign-in that doesn't match the one Stratus started. Start the sign-in again.");
  }
  const error = params.get('error');
  if (error === 'access_denied') {
    throw new ChatGPTAuthError('access_denied', 'The ChatGPT sign-in was declined in the browser. Start it again to allow Stratus Agent to use your ChatGPT plan.');
  }
  if (error !== null) {
    const description = params.get('error_description');
    throw new ChatGPTAuthError(
      'authorization_failed',
      `ChatGPT sign-in failed (${clip(error)}${description !== null ? `: ${clip(description)}` : ''}). Start the sign-in again.`,
    );
  }
  const code = params.get('code');
  if (code === null || code === '') {
    throw new ChatGPTAuthError('request_failed', 'The browser returned no sign-in code. Start the sign-in again.');
  }
  const returnedClientId = params.get('client_id');
  if (attempt.registering) {
    if (returnedClientId === null || returnedClientId === '' || returnedClientId === DYNAMIC_CLIENT_ID) {
      throw new ChatGPTAuthError('registration_incomplete', "ChatGPT didn't finish registering Stratus Agent (no client ID came back). Start the sign-in again.");
    }
    return { code, clientId: returnedClientId };
  }
  // A reauthorization may leave client_id out. If it names another one, the
  // saved account's registration is not replaced with it.
  if (returnedClientId !== null && returnedClientId !== attempt.clientId) {
    throw new ChatGPTAuthError('client_mismatch', 'ChatGPT returned a different registration than the account being signed in. Start the sign-in again, or add it as a new account.');
  }
  return { code, clientId: attempt.clientId };
};

/**
 * One request to OpenAI: the response, its body as JSON (undefined when it
 * isn't) and as text. A failure to get an answer is `cancelled` when the
 * caller's signal ended it, and `temporary` otherwise.
 */
export const send = async (
  options: RequestOptions,
  url: string,
  init: RequestInit,
  what: string,
): Promise<{ response: Response; body: unknown; text: string }> => {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  try {
    const response = await fetchImpl(url, { ...init, ...(options.signal !== undefined ? { signal: options.signal } : {}) });
    const text = await response.text();
    let body: unknown;
    try {
      body = text === '' ? undefined : JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { response, body, text };
  } catch (error) {
    // A failure can quote the request's own header (Node's fetch does, for a
    // value it can't send, and a wrapper may on abort). Then the token comes
    // out of the message, and the original error, which still holds it,
    // isn't kept as the cause.
    const quoted = error instanceof Error ? error.message : String(error);
    const reason = redactSecrets(quoted, credentialsIn(init.headers));
    const cause = reason === quoted ? { cause: error } : undefined;
    if (options.signal?.aborted === true) {
      throw new ChatGPTAuthError('cancelled', `${what} was cancelled.`, cause);
    }
    throw new ChatGPTAuthError('temporary', `Couldn't reach ${what} (${clip(reason)}). Check the connection and try again.`, cause);
  }
};

/** The request's `authorization` value, and the token in it, for redaction. */
const credentialsIn = (headers: RequestInit['headers']): string[] => {
  const entries: Array<[string, string]> = headers === undefined
    ? []
    : headers instanceof Headers
      ? [...headers.entries()]
      : Array.isArray(headers)
        ? headers.map(([name, value]) => [String(name), String(value)])
        : Object.entries(headers).flatMap(([name, value]): Array<[string, string]> => (value === undefined ? [] : [[name, String(value)]]));
  return entries
    .filter(([name]) => name.toLowerCase() === 'authorization')
    .flatMap(([, value]) => [value, value.replace(/^\S+\s+/, '')]);
};

const postForm = (options: RequestOptions, url: string, form: Record<string, string>, what: string) =>
  send(
    options,
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    },
    what,
  );

/** The OAuth error code and description, in either the standard or the Responses error shape. */
const oauthErrorOf = (body: unknown): { readonly code?: string; readonly description?: string } => {
  if (!isRecord(body)) {
    return {};
  }
  const { error } = body;
  if (typeof error === 'string') {
    return {
      code: error,
      ...(typeof body.error_description === 'string' ? { description: body.error_description } : {}),
    };
  }
  if (isRecord(error) && typeof error.code === 'string') {
    return { code: error.code, ...(typeof error.message === 'string' ? { description: error.message } : {}) };
  }
  // Admission errors carry only `{detail}`: diagnostic text, not a code.
  return typeof body.detail === 'string' ? { description: body.detail } : {};
};

const describeFailure = (status: number, body: unknown): string => {
  const { code, description } = oauthErrorOf(body);
  return [`HTTP ${status}`, code, description !== undefined ? clip(description) : undefined]
    .filter((part) => part !== undefined)
    .join(', ');
};

const isTemporaryStatus = (status: number): boolean => status === 429 || status >= 500;

const tokensOf = (body: unknown, receivedAt: number, what: 'sign-in' | 'refresh'): ChatGPTTokens => {
  // A refresh answered 200 has spent the old refresh token, so a reply
  // missing a field ends the sign-in rather than leaving a dead token to be
  // tried again (OpenAI treats a reused one as `refresh_token_reused`).
  const malformed = (field: string): ChatGPTAuthError =>
    what === 'refresh'
      ? new ChatGPTAuthError('signin_required', `OpenAI's refresh response has no ${field}, and the old sign-in may already be spent. Sign in with ChatGPT again.`)
      : new ChatGPTAuthError('request_failed', `OpenAI's ${what} response has no ${field}. Sign in with ChatGPT again.`);
  if (!isRecord(body)) {
    throw malformed('body');
  }
  const { access_token, refresh_token, id_token, token_type, expires_in, scope } = body;
  if (typeof access_token !== 'string' || access_token === '') {
    throw malformed('access_token');
  }
  if (typeof refresh_token !== 'string' || refresh_token === '') {
    throw malformed('refresh_token');
  }
  if (typeof expires_in !== 'number' || !Number.isFinite(expires_in) || expires_in <= 0) {
    throw malformed('expires_in');
  }
  return {
    accessToken: access_token,
    refreshToken: refresh_token,
    ...(typeof id_token === 'string' && id_token !== '' ? { idToken: id_token } : {}),
    tokenType: typeof token_type === 'string' && token_type !== '' ? token_type : 'Bearer',
    expiresAt: receivedAt + expires_in * 1000,
    ...(typeof scope === 'string' ? { scopes: scope.split(/\s+/).filter((part) => part !== '') } : {}),
    receivedAt,
  };
};

export interface DiscoverEndpointsOptions extends RequestOptions {
  readonly issuer?: string;
}

/** Reads the endpoints from the issuer's OpenID configuration. */
export const discoverEndpoints = async (options: DiscoverEndpointsOptions = {}): Promise<ChatGPTEndpoints> => {
  const issuer = options.issuer ?? CHATGPT_ISSUER;
  const what = "OpenAI's sign-in configuration";
  const { response, body } = await send(options, `${issuer}/.well-known/openid-configuration`, { headers: { accept: 'application/json' } }, what);
  if (!response.ok) {
    throw new ChatGPTAuthError(isTemporaryStatus(response.status) ? 'temporary' : 'request_failed', `${what} failed to load (HTTP ${response.status}). Try again later.`);
  }
  const field = (name: string): string => {
    const value = isRecord(body) ? body[name] : undefined;
    if (typeof value !== 'string' || value === '') {
      throw new ChatGPTAuthError('request_failed', `${what} has no ${name}. Try again later.`);
    }
    return value;
  };
  const named = field('issuer');
  if (named !== issuer) {
    throw new ChatGPTAuthError('request_failed', `${what} names the issuer ${clip(named)}, not ${issuer}, so it was not used.`);
  }
  return {
    issuer,
    authorizationEndpoint: field('authorization_endpoint'),
    tokenEndpoint: field('token_endpoint'),
    revocationEndpoint: field('revocation_endpoint'),
    jwksUri: field('jwks_uri'),
  };
};

const fetchSigningKeys = async (endpoints: ChatGPTEndpoints, options: RequestOptions): Promise<JsonWebKeySet> => {
  const what = "OpenAI's signing keys";
  const { response, body } = await send(options, endpoints.jwksUri, { headers: { accept: 'application/json' } }, what);
  if (!response.ok) {
    throw new ChatGPTAuthError(isTemporaryStatus(response.status) ? 'temporary' : 'request_failed', `${what} failed to load (HTTP ${response.status}). Try again later.`);
  }
  if (!isRecord(body) || !Array.isArray(body.keys)) {
    throw new ChatGPTAuthError('request_failed', `${what} came back unreadable. Try again later.`);
  }
  return { keys: body.keys.filter((key): key is JsonWebKey => isRecord(key)) };
};

export interface ExchangeCodeOptions extends RequestOptions {
  readonly endpoints: ChatGPTEndpoints;
  readonly clientId: string;
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly now?: () => number;
}

export const exchangeCode = async (options: ExchangeCodeOptions): Promise<ChatGPTTokens> => {
  const what = "OpenAI's token endpoint";
  const { response, body } = await postForm(
    options,
    options.endpoints.tokenEndpoint,
    {
      grant_type: 'authorization_code',
      client_id: options.clientId,
      code: options.code,
      code_verifier: options.codeVerifier,
      redirect_uri: options.redirectUri,
      resource: CHATGPT_RESOURCE,
    },
    what,
  );
  if (!response.ok) {
    const { code } = oauthErrorOf(body);
    if (isTemporaryStatus(response.status)) {
      throw new ChatGPTAuthError('temporary', `${what} is unavailable (${describeFailure(response.status, body)}). Start the sign-in again in a moment.`);
    }
    if (code === 'invalid_grant') {
      throw new ChatGPTAuthError('invalid_grant', 'OpenAI refused the sign-in code (invalid_grant). Start the sign-in again.');
    }
    if (code === 'invalid_client') {
      throw new ChatGPTAuthError('invalid_client', `OpenAI doesn't recognize this registration (invalid_client). Start the sign-in again.`);
    }
    throw new ChatGPTAuthError('request_failed', `${what} refused the sign-in (${describeFailure(response.status, body)}). Start the sign-in again.`);
  }
  return tokensOf(body, (options.now ?? Date.now)(), 'sign-in');
};

export interface CompleteSignInOptions extends RequestOptions {
  readonly endpoints: ChatGPTEndpoints;
  readonly attempt: SignInAttempt;
  /** The callback's query, from the listener. */
  readonly callback: URLSearchParams;
  readonly now?: () => number;
}

/**
 * Turns a callback into a validated sign-in: checks the callback, loads
 * OpenAI's signing keys, exchanges the code, and validates the ID token
 * (signature, issuer, audience, expiry, nonce) before anything is returned.
 */
export const completeSignIn = async (options: CompleteSignInOptions): Promise<ChatGPTSignIn> => {
  const { attempt, endpoints } = options;
  const now = options.now ?? Date.now;
  const { code, clientId } = readCallback(attempt, options.callback);
  // The keys come first: the code is single-use, so a key outage after the
  // exchange would throw away a good sign-in, and before it the caller can
  // retry with the same callback.
  let keys = await fetchSigningKeys(endpoints, options);
  const tokens = await exchangeCode({
    ...options,
    clientId,
    code,
    codeVerifier: attempt.codeVerifier,
    redirectUri: attempt.redirectUri,
    now,
  });
  if (tokens.idToken === undefined) {
    throw new ChatGPTAuthError('id_token_invalid', "OpenAI's sign-in response has no ID token, so the sign-in was not accepted. Sign in with ChatGPT again.");
  }
  // A key published after that fetch (a rollover) gets one refetch rather
  // than costing the user a new browser sign-in.
  const kid = idTokenKeyId(tokens.idToken);
  if (kid !== undefined && !keys.keys.some((key) => key.kid === kid)) {
    keys = await fetchSigningKeys(endpoints, options);
  }
  const claims = verifyIdToken({
    token: tokens.idToken,
    keys,
    issuer: endpoints.issuer,
    audience: clientId,
    nonce: attempt.nonce,
    now: now(),
  });
  if (attempt.expectedSubject !== undefined && claims.sub !== attempt.expectedSubject) {
    throw new ChatGPTAuthError('account_mismatch', 'You signed in as a different ChatGPT account than the one being signed in again. Pick the same account, or add it as a new one.');
  }
  return {
    clientId,
    subject: claims.sub,
    ...(claims.email !== undefined ? { email: claims.email } : {}),
    idToken: tokens.idToken,
    tokens,
    // OpenAI's docs: decide from the token response's granted scopes, not
    // the callback's, and a sign-in without this one is valid but may not
    // spend the plan.
    planUsage: tokens.scopes?.includes(CHATGPT_PLAN_SCOPE) ?? false,
  };
};

export interface RefreshTokensOptions extends RequestOptions {
  readonly endpoints: ChatGPTEndpoints;
  readonly clientId: string;
  readonly refreshToken: string;
  readonly now?: () => number;
}

/**
 * Trades the refresh token for a new token set, replacement refresh token
 * included. The old refresh token is dead afterward, so the caller saves the
 * whole result before using it and serializes refreshes across processes.
 */
export const refreshTokens = async (options: RefreshTokensOptions): Promise<ChatGPTTokens> => {
  const what = "OpenAI's token endpoint";
  const { response, body } = await postForm(
    options,
    options.endpoints.tokenEndpoint,
    {
      // `scope` is left out so the refreshed grant keeps every scope.
      grant_type: 'refresh_token',
      client_id: options.clientId,
      refresh_token: options.refreshToken,
      resource: CHATGPT_RESOURCE,
    },
    what,
  );
  if (!response.ok) {
    const { code } = oauthErrorOf(body);
    if (isTemporaryStatus(response.status)) {
      throw new ChatGPTAuthError('temporary', `${what} is unavailable (${describeFailure(response.status, body)}). The ChatGPT sign-in is kept; try again in a moment.`);
    }
    if (code !== undefined && TERMINAL_REFRESH_ERRORS.includes(code)) {
      throw new ChatGPTAuthError('signin_required', `The ChatGPT sign-in has ended (${code}). Sign in with ChatGPT again.`);
    }
    if (code === 'invalid_client') {
      throw new ChatGPTAuthError('invalid_client', "OpenAI doesn't recognize this registration (invalid_client). Sign in with ChatGPT again.");
    }
    throw new ChatGPTAuthError('request_failed', `${what} refused the refresh (${describeFailure(response.status, body)}).`);
  }
  return tokensOf(body, (options.now ?? Date.now)(), 'refresh');
};

export interface RevokeOptions extends RequestOptions {
  readonly endpoints: ChatGPTEndpoints;
  readonly clientId: string;
  readonly refreshToken: string;
  /** Tries, counting the first; a network failure or 5xx is retried. Default 3. */
  readonly attempts?: number;
  readonly wait?: (ms: number, signal?: AbortSignal) => Promise<unknown>;
}

export interface RevokeResult {
  /** OpenAI answered 200: the session is ended (or was already). */
  readonly confirmed: boolean;
  readonly reason?: string;
}

/**
 * Ends the renewable session at OpenAI. Never throws for a failed
 * revocation: sign-out clears the local tokens either way and, when
 * `confirmed` is false, tells the user they can disconnect the app in
 * ChatGPT settings.
 */
export const revokeRefreshToken = async (options: RevokeOptions): Promise<RevokeResult> => {
  const what = "OpenAI's revocation endpoint";
  const attempts = Math.max(1, options.attempts ?? 3);
  const wait = options.wait ?? ((ms: number, signal?: AbortSignal) => sleep(ms, undefined, signal !== undefined ? { signal } : {}));
  let reason = '';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const { response, body } = await postForm(
        options,
        options.endpoints.revocationEndpoint,
        { token: options.refreshToken, token_type_hint: 'refresh_token', client_id: options.clientId },
        what,
      );
      if (response.ok) {
        return { confirmed: true };
      }
      reason = `${what} answered ${describeFailure(response.status, body)}`;
      if (response.status < 500) {
        return { confirmed: false, reason };
      }
    } catch (error) {
      if (!(error instanceof ChatGPTAuthError) || error.code !== 'temporary') {
        throw error;
      }
      reason = error.message;
    }
    if (attempt < attempts) {
      try {
        await wait(500 * 2 ** (attempt - 1), options.signal);
      } catch (error) {
        throw new ChatGPTAuthError('cancelled', 'Ending the ChatGPT session was cancelled.', { cause: error });
      }
    }
  }
  return { confirmed: false, reason };
};
