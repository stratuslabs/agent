import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, type JsonWebKey, type KeyObject } from 'node:crypto';
import {
  CHATGPT_RESOURCE,
  ChatGPTAuthError,
  DYNAMIC_CLIENT_ID,
  TERMINAL_REFRESH_ERRORS,
  completeSignIn,
  createHostId,
  createSignInAttempt,
  discoverEndpoints,
  readCallback,
  refreshTokens,
  revokeRefreshToken,
  verifyIdToken,
  type ChatGPTEndpoints,
  type SignInAttempt,
} from '../src/index.ts';

const ISSUER = 'https://auth.example.test';
const ISSUED_CLIENT_ID = 'oaiapp_issued123';
const HOST_ID = 'urn:uuid:5b9a3f0e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const REDIRECT_URI = 'http://127.0.0.1:1455/auth/callback';
const NOW = Date.UTC(2026, 10, 12, 18, 0, 0);
const FULL_SCOPE = 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke';

const endpoints: ChatGPTEndpoints = {
  issuer: ISSUER,
  authorizationEndpoint: `${ISSUER}/api/accounts/authorize`,
  tokenEndpoint: `${ISSUER}/api/accounts/oauth/token`,
  revocationEndpoint: `${ISSUER}/api/accounts/oauth/revoke`,
  jwksUri: `${ISSUER}/.well-known/jwks.json`,
};

const signingKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publishedKey: JsonWebKey = { ...signingKey.publicKey.export({ format: 'jwk' }), kid: 'key-1', use: 'sig', alg: 'RS256' };

const segment = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

const signJwt = (
  claims: Record<string, unknown>,
  options: { readonly key?: KeyObject; readonly kid?: string; readonly alg?: string } = {},
): string => {
  const head = segment({ alg: options.alg ?? 'RS256', kid: options.kid ?? 'key-1', typ: 'JWT' });
  const body = segment(claims);
  const signature = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), options.key ?? signingKey.privateKey).toString('base64url');
  return `${head}.${body}.${signature}`;
};

const idTokenClaims = (attempt: SignInAttempt, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  iss: ISSUER,
  aud: ISSUED_CLIENT_ID,
  sub: 'user-sub-1',
  email: 'person@example.com',
  nonce: attempt.nonce,
  iat: NOW / 1000,
  exp: NOW / 1000 + 3600,
  ...overrides,
});

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly form: URLSearchParams;
}

type Reply = { readonly status: number; readonly body?: unknown } | 'network-error';

const createFakeAuthServer = (replies: { token?: Reply[]; revoke?: Reply[]; jwks?: Reply | Reply[]; discovery?: Reply } = {}) => {
  const requests: RecordedRequest[] = [];
  const queues = {
    token: [...(replies.token ?? [])],
    revoke: [...(replies.revoke ?? [])],
    jwks: Array.isArray(replies.jwks) ? [...replies.jwks] : undefined,
  };
  const toResponse = (reply: Reply | undefined): Response => {
    if (reply === undefined) {
      throw new Error('the fake auth server got a request nothing was queued for');
    }
    if (reply === 'network-error') {
      throw new TypeError('fetch failed');
    }
    return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), { status: reply.status });
  };
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? 'GET', form: new URLSearchParams(typeof init?.body === 'string' ? init.body : '') });
    if (url === endpoints.tokenEndpoint) {
      return toResponse(queues.token.shift());
    }
    if (url === endpoints.revocationEndpoint) {
      return toResponse(queues.revoke.shift());
    }
    if (url === endpoints.jwksUri) {
      if (queues.jwks !== undefined) {
        return toResponse(queues.jwks.shift());
      }
      return toResponse((replies.jwks as Reply | undefined) ?? { status: 200, body: { keys: [publishedKey] } });
    }
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return toResponse(replies.discovery);
    }
    throw new Error(`the fake auth server has no route for ${url}`);
  };
  return { fetch: fakeFetch, requests };
};

const tokenReply = (idToken: string | undefined, overrides: Record<string, unknown> = {}): Reply => ({
  status: 200,
  body: {
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    ...(idToken !== undefined ? { id_token: idToken } : {}),
    token_type: 'Bearer',
    expires_in: 3600,
    scope: FULL_SCOPE,
    ...overrides,
  },
});

const firstAttempt = (): SignInAttempt => createSignInAttempt({ endpoints, hostId: HOST_ID, redirectUri: REDIRECT_URI });

const callbackFor = (attempt: SignInAttempt, extra: Record<string, string> = { client_id: ISSUED_CLIENT_ID }): URLSearchParams =>
  new URLSearchParams({ code: 'auth-code-1', state: attempt.state, scope: FULL_SCOPE, ...extra });

const rejectsWithCode = async (promise: Promise<unknown>, code: string, message?: RegExp): Promise<ChatGPTAuthError> => {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ChatGPTAuthError, `expected a ChatGPTAuthError, got ${String(caught)}`);
  assert.equal(caught.code, code, caught.message);
  if (message !== undefined) {
    assert.match(caught.message, message);
  }
  return caught;
};

test('createHostId makes a urn:uuid host ID, a new one each call', () => {
  const id = createHostId();
  assert.match(id, /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(createHostId(), id);
});

test('a first sign-in registers through dynamic_agent_client with the host ID, PKCE S256 and the agent name', () => {
  const attempt = firstAttempt();
  const url = new URL(attempt.url);
  assert.equal(`${url.origin}${url.pathname}`, endpoints.authorizationEndpoint);
  assert.ok(!attempt.url.includes('+'), 'spaces are percent-encoded, not form-encoded');
  const params = url.searchParams;
  assert.deepEqual(Object.fromEntries(params), {
    response_type: 'code',
    client_id: DYNAMIC_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
    resource: CHATGPT_RESOURCE,
    state: attempt.state,
    nonce: attempt.nonce,
    code_challenge: createHash('sha256').update(attempt.codeVerifier).digest('base64url'),
    code_challenge_method: 'S256',
    ext_agent_host_id: HOST_ID,
    agent_name_hint: 'Stratus Agent',
  });
  assert.equal(attempt.registering, true);
  assert.equal(attempt.clientId, DYNAMIC_CLIENT_ID);
  assert.ok(attempt.codeVerifier.length >= 43, 'the PKCE verifier has at least 256 bits');
  const second = firstAttempt();
  assert.notEqual(second.state, attempt.state);
  assert.notEqual(second.nonce, attempt.nonce);
  assert.notEqual(second.codeVerifier, attempt.codeVerifier);
});

test('a returning sign-in sends the issued client ID and the hints, and no agent name', () => {
  const attempt = createSignInAttempt({
    endpoints,
    hostId: HOST_ID,
    redirectUri: 'http://127.0.0.1:54321/auth/callback',
    account: { clientId: ISSUED_CLIENT_ID, subject: 'user-sub-1', idToken: 'old.id.token', email: 'person@example.com' },
  });
  const params = new URL(attempt.url).searchParams;
  assert.equal(params.get('client_id'), ISSUED_CLIENT_ID);
  assert.equal(params.get('id_token_hint'), 'old.id.token');
  assert.equal(params.get('login_hint'), 'person@example.com');
  assert.equal(params.get('ext_agent_host_id'), HOST_ID);
  assert.equal(params.has('agent_name_hint'), false);
  assert.equal(attempt.registering, false);
  assert.equal(attempt.expectedSubject, 'user-sub-1');

  // After sign-out the ID token is gone, so there is no id_token_hint.
  const signedOut = createSignInAttempt({
    endpoints,
    hostId: HOST_ID,
    redirectUri: REDIRECT_URI,
    account: { clientId: ISSUED_CLIENT_ID, subject: 'user-sub-1', email: 'person@example.com' },
  });
  assert.equal(new URL(signedOut.url).searchParams.has('id_token_hint'), false);
});

test('a sign-in attempt refuses a callback OpenAI would reject, a missing host ID, and dynamic_agent_client as a saved client', () => {
  for (const redirectUri of [
    'http://localhost:1455/auth/callback',
    'http://127.0.0.1:1455/callback',
    'https://127.0.0.1:1455/auth/callback',
    'http://127.0.0.1/auth/callback',
    'http://127.0.0.1:1455/auth/callback?x=1',
  ]) {
    assert.throws(() => createSignInAttempt({ endpoints, hostId: HOST_ID, redirectUri }), /is not a ChatGPT sign-in callback/, redirectUri);
  }
  assert.throws(() => createSignInAttempt({ endpoints, hostId: ' ', redirectUri: REDIRECT_URI }), /host's ID/);
  assert.throws(
    () => createSignInAttempt({ endpoints, hostId: HOST_ID, redirectUri: REDIRECT_URI, account: { clientId: DYNAMIC_CLIENT_ID, subject: 's' } }),
    /needs the issued client ID/,
  );
});

test('a callback is checked against its attempt: state first, then errors, then the client ID', () => {
  const attempt = firstAttempt();
  const code = (fn: () => unknown): string => {
    try {
      fn();
    } catch (error) {
      assert.ok(error instanceof ChatGPTAuthError);
      return error.code;
    }
    return 'none';
  };
  // An error from another attempt is a state mismatch, not a decline.
  assert.equal(code(() => readCallback(attempt, new URLSearchParams({ state: 'other', error: 'access_denied' }))), 'state_mismatch');
  assert.equal(code(() => readCallback(attempt, new URLSearchParams({ error: 'access_denied' }))), 'state_mismatch');
  assert.equal(code(() => readCallback(attempt, new URLSearchParams({ state: attempt.state, error: 'access_denied' }))), 'access_denied');
  assert.equal(code(() => readCallback(attempt, new URLSearchParams({ state: attempt.state, error: 'server_error' }))), 'authorization_failed');
  assert.equal(code(() => readCallback(attempt, new URLSearchParams({ state: attempt.state, client_id: ISSUED_CLIENT_ID }))), 'request_failed');
  assert.equal(code(() => readCallback(attempt, callbackFor(attempt, {}))), 'registration_incomplete');
  assert.equal(code(() => readCallback(attempt, callbackFor(attempt, { client_id: DYNAMIC_CLIENT_ID }))), 'registration_incomplete');
  assert.deepEqual(readCallback(attempt, callbackFor(attempt)), { code: 'auth-code-1', clientId: ISSUED_CLIENT_ID });

  const returning = createSignInAttempt({ endpoints, hostId: HOST_ID, redirectUri: REDIRECT_URI, account: { clientId: ISSUED_CLIENT_ID, subject: 'user-sub-1' } });
  assert.equal(code(() => readCallback(returning, callbackFor(returning, { client_id: 'oaiapp_someone_else' }))), 'client_mismatch');
  assert.deepEqual(readCallback(returning, callbackFor(returning, {})), { code: 'auth-code-1', clientId: ISSUED_CLIENT_ID });
});

test('completeSignIn exchanges the code with the issued client ID and returns the validated account', async () => {
  const attempt = firstAttempt();
  const server = createFakeAuthServer({ token: [tokenReply(signJwt(idTokenClaims(attempt)))] });
  const signIn = await completeSignIn({ endpoints, attempt, callback: callbackFor(attempt), fetch: server.fetch, now: () => NOW });

  const exchange = server.requests.find((request) => request.url === endpoints.tokenEndpoint);
  assert.ok(exchange);
  assert.equal(exchange.method, 'POST');
  assert.deepEqual(Object.fromEntries(exchange.form), {
    grant_type: 'authorization_code',
    client_id: ISSUED_CLIENT_ID,
    code: 'auth-code-1',
    code_verifier: attempt.codeVerifier,
    redirect_uri: REDIRECT_URI,
    resource: CHATGPT_RESOURCE,
  });
  assert.equal(signIn.clientId, ISSUED_CLIENT_ID);
  assert.equal(signIn.subject, 'user-sub-1');
  assert.equal(signIn.email, 'person@example.com');
  assert.equal(signIn.planUsage, true);
  assert.equal(signIn.tokens.accessToken, 'access-1');
  assert.equal(signIn.tokens.refreshToken, 'refresh-1');
  assert.equal(signIn.tokens.expiresAt, NOW + 3600 * 1000);
  assert.equal(signIn.tokens.receivedAt, NOW);
  assert.ok(signIn.tokens.scopes?.includes('chatgpt.tokens.use.direct'));
});

test('a sign-in without the plan scope is valid but may not spend the ChatGPT plan', async () => {
  for (const scope of ['email offline_access openid profile resource.invoke', undefined]) {
    const attempt = firstAttempt();
    const server = createFakeAuthServer({ token: [tokenReply(signJwt(idTokenClaims(attempt)), { scope })] });
    // The callback's own scope list says the plan scope was granted; only the token response counts.
    const signIn = await completeSignIn({ endpoints, attempt, callback: callbackFor(attempt), fetch: server.fetch, now: () => NOW });
    assert.equal(signIn.planUsage, false, `scope ${String(scope)}`);
  }
});

test('completeSignIn refuses an ID token that fails any check', async () => {
  const cases: { readonly name: string; readonly token: (attempt: SignInAttempt) => string | undefined; readonly message: RegExp }[] = [
    { name: 'wrong nonce', token: (a) => signJwt(idTokenClaims(a, { nonce: 'replayed' })), message: /nonce/ },
    { name: 'wrong audience', token: (a) => signJwt(idTokenClaims(a, { aud: 'oaiapp_other' })), message: /addressed to another client/ },
    {
      name: 'issued to another party',
      token: (a) => signJwt(idTokenClaims(a, { aud: [ISSUED_CLIENT_ID, 'oaiapp_other'], azp: 'oaiapp_other' })),
      message: /issued to another client/,
    },
    { name: 'wrong issuer', token: (a) => signJwt(idTokenClaims(a, { iss: 'https://evil.example' })), message: /issued by https:\/\/evil\.example/ },
    { name: 'expired', token: (a) => signJwt(idTokenClaims(a, { exp: NOW / 1000 - 120 })), message: /expired/ },
    { name: 'not yet valid', token: (a) => signJwt(idTokenClaims(a, { nbf: NOW / 1000 + 600 })), message: /not valid yet/ },
    { name: 'no subject', token: (a) => signJwt(idTokenClaims(a, { sub: '' })), message: /names no account/ },
    { name: 'signed by another key', token: (a) => signJwt(idTokenClaims(a), { key: otherKey.privateKey }), message: /signature/ },
    { name: 'unknown key id', token: (a) => signJwt(idTokenClaims(a), { kid: 'key-9' }), message: /key key-9/ },
    {
      name: 'alg none',
      token: (a) => `${segment({ alg: 'none', kid: 'key-1' })}.${segment(idTokenClaims(a))}.`,
      message: /signed with none, not RS256/,
    },
    { name: 'missing', token: () => undefined, message: /no ID token/ },
  ];
  for (const { name, token, message } of cases) {
    const attempt = firstAttempt();
    const server = createFakeAuthServer({ token: [tokenReply(token(attempt))] });
    const error = await rejectsWithCode(
      completeSignIn({ endpoints, attempt, callback: callbackFor(attempt), fetch: server.fetch, now: () => NOW }),
      'id_token_invalid',
      message,
    );
    assert.ok(!error.message.includes('access-1') && !error.message.includes('refresh-1'), `${name}: no token in the message`);
  }
});

test('an ID token inside the allowed clock skew still validates', () => {
  const attempt = firstAttempt();
  const claims = verifyIdToken({
    token: signJwt(idTokenClaims(attempt, { exp: NOW / 1000 - 30 })),
    keys: { keys: [publishedKey] },
    issuer: ISSUER,
    audience: ISSUED_CLIENT_ID,
    nonce: attempt.nonce,
    now: NOW,
  });
  assert.equal(claims.sub, 'user-sub-1');
});

test('a returning sign-in that validates as another account is refused', async () => {
  const attempt = createSignInAttempt({ endpoints, hostId: HOST_ID, redirectUri: REDIRECT_URI, account: { clientId: ISSUED_CLIENT_ID, subject: 'user-sub-1' } });
  const server = createFakeAuthServer({ token: [tokenReply(signJwt(idTokenClaims(attempt, { sub: 'user-sub-2' })))] });
  await rejectsWithCode(
    completeSignIn({ endpoints, attempt, callback: callbackFor(attempt, {}), fetch: server.fetch, now: () => NOW }),
    'account_mismatch',
  );
});

test('a refused code exchange maps to a fresh sign-in, an outage to a temporary error', async () => {
  const attempt = firstAttempt();
  await rejectsWithCode(
    completeSignIn({
      endpoints,
      attempt,
      callback: callbackFor(attempt),
      fetch: createFakeAuthServer({ token: [{ status: 400, body: { error: 'invalid_grant' } }] }).fetch,
    }),
    'invalid_grant',
  );
  await rejectsWithCode(
    completeSignIn({ endpoints, attempt, callback: callbackFor(attempt), fetch: createFakeAuthServer({ token: [{ status: 503 }] }).fetch }),
    'temporary',
  );
  await rejectsWithCode(
    completeSignIn({ endpoints, attempt, callback: callbackFor(attempt), fetch: createFakeAuthServer({ token: ['network-error'] }).fetch }),
    'temporary',
    /fetch failed/,
  );
});

test('a signing-key outage fails before the single-use code is spent, so the same callback can be retried', async () => {
  const attempt = firstAttempt();
  const outage = createFakeAuthServer({ jwks: { status: 503 }, token: [tokenReply(signJwt(idTokenClaims(attempt)))] });
  await rejectsWithCode(
    completeSignIn({ endpoints, attempt, callback: callbackFor(attempt), fetch: outage.fetch, now: () => NOW }),
    'temporary',
  );
  assert.equal(outage.requests.some((request) => request.url === endpoints.tokenEndpoint), false, 'the code was not exchanged');

  const recovered = createFakeAuthServer({ token: [tokenReply(signJwt(idTokenClaims(attempt)))] });
  const signIn = await completeSignIn({ endpoints, attempt, callback: callbackFor(attempt), fetch: recovered.fetch, now: () => NOW });
  assert.equal(signIn.subject, 'user-sub-1');
});

test('an ID token signed with a key newer than the fetched set gets one refetch of the keys', async () => {
  const attempt = firstAttempt();
  const retiredKey: JsonWebKey = { ...otherKey.publicKey.export({ format: 'jwk' }), kid: 'key-0', use: 'sig', alg: 'RS256' };
  const rollover = createFakeAuthServer({
    jwks: [
      { status: 200, body: { keys: [retiredKey] } },
      { status: 200, body: { keys: [retiredKey, publishedKey] } },
    ],
    token: [tokenReply(signJwt(idTokenClaims(attempt)))],
  });
  const signIn = await completeSignIn({ endpoints, attempt, callback: callbackFor(attempt), fetch: rollover.fetch, now: () => NOW });
  assert.equal(signIn.subject, 'user-sub-1');
  assert.equal(rollover.requests.filter((request) => request.url === endpoints.jwksUri).length, 2);

  // A key that is still missing after the refetch is refused, not retried again.
  const second = firstAttempt();
  const missing = createFakeAuthServer({
    jwks: [
      { status: 200, body: { keys: [retiredKey] } },
      { status: 200, body: { keys: [retiredKey] } },
    ],
    token: [tokenReply(signJwt(idTokenClaims(second)))],
  });
  await rejectsWithCode(
    completeSignIn({ endpoints, attempt: second, callback: callbackFor(second), fetch: missing.fetch, now: () => NOW }),
    'id_token_invalid',
    /key key-1/,
  );
  assert.equal(missing.requests.filter((request) => request.url === endpoints.jwksUri).length, 2);
});

test('refreshTokens sends the issued client ID and resource without scope, and returns the replacement', async () => {
  const server = createFakeAuthServer({ token: [tokenReply(undefined, { access_token: 'access-2', refresh_token: 'refresh-2' })] });
  const tokens = await refreshTokens({ endpoints, clientId: ISSUED_CLIENT_ID, refreshToken: 'refresh-1', fetch: server.fetch, now: () => NOW });
  const [request] = server.requests;
  assert.ok(request);
  assert.deepEqual(Object.fromEntries(request.form), {
    grant_type: 'refresh_token',
    client_id: ISSUED_CLIENT_ID,
    refresh_token: 'refresh-1',
    resource: CHATGPT_RESOURCE,
  });
  assert.equal(tokens.accessToken, 'access-2');
  assert.equal(tokens.refreshToken, 'refresh-2');
  assert.equal(tokens.expiresAt, NOW + 3600 * 1000);

  // A refresh response without a scope list leaves the saved scopes alone.
  const unlisted = await refreshTokens({
    endpoints,
    clientId: ISSUED_CLIENT_ID,
    refreshToken: 'refresh-2',
    fetch: createFakeAuthServer({ token: [tokenReply(undefined, { scope: undefined })] }).fetch,
  });
  assert.equal(unlisted.scopes, undefined);
});

test('every terminal refresh code, in either error shape, asks for a new sign-in', async () => {
  assert.equal(TERMINAL_REFRESH_ERRORS.length, 6);
  for (const code of TERMINAL_REFRESH_ERRORS) {
    for (const body of [{ error: code }, { error: { code, message: 'gone' } }]) {
      const server = createFakeAuthServer({ token: [{ status: 400, body }] });
      const error = await rejectsWithCode(
        refreshTokens({ endpoints, clientId: ISSUED_CLIENT_ID, refreshToken: 'refresh-secret-xyz', fetch: server.fetch }),
        'signin_required',
        new RegExp(code),
      );
      assert.ok(!error.message.includes('refresh-secret-xyz'));
    }
  }
});

test('a refresh outage keeps the sign-in; invalid_client and other refusals are told apart', async () => {
  const refresh = (reply: Reply) =>
    refreshTokens({ endpoints, clientId: ISSUED_CLIENT_ID, refreshToken: 'refresh-1', fetch: createFakeAuthServer({ token: [reply] }).fetch });
  await rejectsWithCode(refresh({ status: 503, body: { error: 'temporarily_unavailable' } }), 'temporary', /kept/);
  await rejectsWithCode(refresh({ status: 429 }), 'temporary');
  await rejectsWithCode(refresh('network-error'), 'temporary');
  await rejectsWithCode(refresh({ status: 401, body: { error: 'invalid_client' } }), 'invalid_client');
  await rejectsWithCode(refresh({ status: 400, body: { detail: 'region not permitted' } }), 'request_failed', /region not permitted/);
});

test('a refresh answered 200 but missing a field ends the sign-in, since the old refresh token may already be spent', async () => {
  const refresh = (reply: Reply) =>
    refreshTokens({ endpoints, clientId: ISSUED_CLIENT_ID, refreshToken: 'refresh-secret-xyz', fetch: createFakeAuthServer({ token: [reply] }).fetch });
  for (const [field, overrides] of [
    ['refresh_token', { refresh_token: undefined }],
    ['access_token', { access_token: '' }],
    ['expires_in', { expires_in: 'soon' }],
  ] as const) {
    const error = await rejectsWithCode(refresh(tokenReply(undefined, overrides)), 'signin_required', new RegExp(field));
    assert.ok(!error.message.includes('refresh-secret-xyz'));
  }
  await rejectsWithCode(refresh({ status: 200, body: 'not an object' }), 'signin_required', /body/);
});

test('revocation posts the refresh token and the issued client ID, and confirms on 200', async () => {
  const server = createFakeAuthServer({ revoke: [{ status: 200 }] });
  const result = await revokeRefreshToken({ endpoints, clientId: ISSUED_CLIENT_ID, refreshToken: 'refresh-1', fetch: server.fetch });
  assert.deepEqual(result, { confirmed: true });
  const [request] = server.requests;
  assert.ok(request);
  assert.deepEqual(Object.fromEntries(request.form), { token: 'refresh-1', token_type_hint: 'refresh_token', client_id: ISSUED_CLIENT_ID });
});

test('revocation retries an outage with backoff, gives up unconfirmed, and never retries a 4xx', async () => {
  const waits: number[] = [];
  const wait = async (ms: number): Promise<void> => {
    waits.push(ms);
  };
  const retried = createFakeAuthServer({ revoke: [{ status: 503 }, 'network-error', { status: 200 }] });
  assert.deepEqual(
    await revokeRefreshToken({ endpoints, clientId: ISSUED_CLIENT_ID, refreshToken: 'r', fetch: retried.fetch, wait }),
    { confirmed: true },
  );
  assert.deepEqual(waits, [500, 1000]);

  const down = createFakeAuthServer({ revoke: ['network-error', 'network-error', 'network-error'] });
  const unconfirmed = await revokeRefreshToken({ endpoints, clientId: ISSUED_CLIENT_ID, refreshToken: 'r', fetch: down.fetch, wait });
  assert.equal(unconfirmed.confirmed, false);
  assert.equal(down.requests.length, 3);

  const refused = createFakeAuthServer({ revoke: [{ status: 400, body: { error: 'invalid_request' } }] });
  const result = await revokeRefreshToken({ endpoints, clientId: ISSUED_CLIENT_ID, refreshToken: 'r', fetch: refused.fetch, wait });
  assert.equal(result.confirmed, false);
  assert.match(result.reason ?? '', /HTTP 400, invalid_request/);
  assert.equal(refused.requests.length, 1);
});

test('discoverEndpoints reads the OpenID configuration and refuses one naming another issuer', async () => {
  const configuration = {
    issuer: ISSUER,
    authorization_endpoint: endpoints.authorizationEndpoint,
    token_endpoint: endpoints.tokenEndpoint,
    revocation_endpoint: endpoints.revocationEndpoint,
    jwks_uri: endpoints.jwksUri,
  };
  const found = await discoverEndpoints({ issuer: ISSUER, fetch: createFakeAuthServer({ discovery: { status: 200, body: configuration } }).fetch });
  assert.deepEqual(found, endpoints);
  await rejectsWithCode(
    discoverEndpoints({
      issuer: ISSUER,
      fetch: createFakeAuthServer({ discovery: { status: 200, body: { ...configuration, issuer: 'https://other.example' } } }).fetch,
    }),
    'request_failed',
    /names the issuer https:\/\/other\.example/,
  );
  await rejectsWithCode(
    discoverEndpoints({
      issuer: ISSUER,
      fetch: createFakeAuthServer({ discovery: { status: 200, body: { ...configuration, revocation_endpoint: undefined } } }).fetch,
    }),
    'request_failed',
    /revocation_endpoint/,
  );
});
