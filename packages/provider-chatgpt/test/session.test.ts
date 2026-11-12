import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatGPTAuthError,
  createChatGPTTokenSource,
  sessionFromSignIn,
  type ChatGPTEndpoints,
  type ChatGPTSession,
  type ChatGPTSessionStore,
  type ChatGPTSignIn,
} from '../src/index.ts';

const ISSUER = 'https://auth.example.test';
const CLIENT_ID = 'oaiapp_issued123';
const NOW = Date.UTC(2026, 10, 12, 18, 0, 0);
const MINUTE = 60_000;

const endpoints: ChatGPTEndpoints = {
  issuer: ISSUER,
  authorizationEndpoint: `${ISSUER}/api/accounts/authorize`,
  tokenEndpoint: `${ISSUER}/api/accounts/oauth/token`,
  revocationEndpoint: `${ISSUER}/api/accounts/oauth/revoke`,
  jwksUri: `${ISSUER}/.well-known/jwks.json`,
};

const savedSession = (overrides: Partial<ChatGPTSession> = {}): ChatGPTSession => ({
  clientId: CLIENT_ID,
  subject: 'user-sub-1',
  email: 'person@example.com',
  idToken: 'id-token-1',
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: NOW + 60 * MINUTE,
  scopes: ['openid', 'chatgpt.tokens.use.direct'],
  savedAt: NOW - 1000,
  ...overrides,
});

const memoryStore = (initial: ChatGPTSession | undefined) => {
  let session = initial;
  const writes: ChatGPTSession[] = [];
  const store: ChatGPTSessionStore = {
    read: async () => session,
    write: async (next) => {
      writes.push(next);
      session = next;
    },
  };
  return {
    store,
    writes,
    current: () => session,
    replace: (next: ChatGPTSession) => {
      session = next;
    },
  };
};

/** Serializes callers like the real lock does, and counts how often it was taken. */
const memoryLock = (beforeWork?: () => void | Promise<void>) => {
  let tail: Promise<unknown> = Promise.resolve();
  const lock = {
    taken: 0,
    withRefreshLock: <T>(work: () => Promise<T>): Promise<T> => {
      const run = tail.then(async () => {
        lock.taken += 1;
        await beforeWork?.();
        return work();
      });
      tail = run.catch(() => undefined);
      return run;
    },
  };
  return lock;
};

type Reply = { readonly status: number; readonly body?: unknown } | 'network-error';

const refreshServer = (replies: Reply[], gate?: Promise<void>) => {
  const requests: { form: URLSearchParams; signal: AbortSignal | undefined }[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    assert.equal(String(input), endpoints.tokenEndpoint);
    requests.push({ form: new URLSearchParams(String(init?.body ?? '')), signal: init?.signal ?? undefined });
    await gate;
    const reply = replies.shift();
    if (reply === undefined) {
      throw new Error('the fake token endpoint got a request nothing was queued for');
    }
    if (reply === 'network-error') {
      throw new TypeError('fetch failed');
    }
    return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), { status: reply.status });
  };
  return { fetch: fakeFetch, requests };
};

const refreshed = (overrides: Record<string, unknown> = {}): Reply => ({
  status: 200,
  body: { access_token: 'access-2', refresh_token: 'refresh-2', token_type: 'Bearer', expires_in: 3600, ...overrides },
});

const rejectsWithCode = async (promise: Promise<unknown>, code: string): Promise<ChatGPTAuthError> => {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ChatGPTAuthError, `expected a ChatGPTAuthError, got ${String(caught)}`);
  assert.equal(caught.code, code, caught.message);
  return caught;
};

const sourceFor = (
  store: ChatGPTSessionStore,
  server: { fetch: typeof fetch },
  lock = memoryLock(),
  now: () => number = () => NOW,
) => ({ lock, source: createChatGPTTokenSource({ endpoints, store, withRefreshLock: lock.withRefreshLock, fetch: server.fetch, now }) });

test('a token with more than five minutes left is used as is, without the lock or a refresh', async () => {
  const saved = memoryStore(savedSession({ expiresAt: NOW + 5 * MINUTE + 1 }));
  const server = refreshServer([]);
  const { lock, source } = sourceFor(saved.store, server);
  assert.equal(await source.accessToken(undefined), 'access-1');
  assert.equal(lock.taken, 0);
  assert.equal(server.requests.length, 0);
  assert.equal(saved.writes.length, 0);
});

test('inside the last five minutes it refreshes under the lock and saves the replacement before returning it', async () => {
  const saved = memoryStore(savedSession({ expiresAt: NOW + 5 * MINUTE }));
  const server = refreshServer([refreshed()]);
  const { lock, source } = sourceFor(saved.store, server);
  assert.equal(await source.accessToken(undefined), 'access-2');
  assert.equal(lock.taken, 1);
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0]?.form.get('refresh_token'), 'refresh-1');
  assert.equal(server.requests[0]?.form.get('client_id'), CLIENT_ID);
  // No scope list and no ID token in the reply: the saved ones stay.
  assert.deepEqual(saved.writes, [
    savedSession({ accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: NOW + 3600 * 1000, savedAt: NOW }),
  ]);
});

test('a refresh that lists scopes or brings an ID token replaces the saved ones', async () => {
  const saved = memoryStore(savedSession({ expiresAt: NOW - 1 }));
  const server = refreshServer([refreshed({ scope: 'openid email', id_token: 'id-token-2' })]);
  const { source } = sourceFor(saved.store, server);
  await source.accessToken(undefined);
  assert.deepEqual(saved.current()?.scopes, ['openid', 'email']);
  assert.equal(saved.current()?.idToken, 'id-token-2');
});

test('callers waiting together get one refresh: the second rereads the record inside the lock', async () => {
  const saved = memoryStore(savedSession({ expiresAt: NOW - 1 }));
  const server = refreshServer([refreshed()]);
  const { lock, source } = sourceFor(saved.store, server);
  const tokens = await Promise.all([source.accessToken(undefined), source.accessToken(undefined), source.accessToken(undefined)]);
  assert.deepEqual(tokens, ['access-2', 'access-2', 'access-2']);
  assert.equal(server.requests.length, 1);
  assert.equal(lock.taken, 3);
});

test('a record another process refreshed while this one waited for the lock is used, not refreshed again', async () => {
  const saved = memoryStore(savedSession({ expiresAt: NOW - 1 }));
  const otherProcess = savedSession({ accessToken: 'access-other', refreshToken: 'refresh-other', expiresAt: NOW + 60 * MINUTE });
  const server = refreshServer([]);
  const lock = memoryLock(() => saved.replace(otherProcess));
  const { source } = sourceFor(saved.store, server, lock);
  assert.equal(await source.accessToken(undefined), 'access-other');
  assert.equal(server.requests.length, 0);
  assert.equal(saved.writes.length, 0);
});

test('a dead refresh token clears the access and refresh tokens, keeps the account, and asks for a new sign-in', async () => {
  for (const reply of [
    { status: 400, body: { error: 'refresh_token_reused' } },
    // A 200 without the replacement: the old token may already be spent.
    refreshed({ refresh_token: undefined }),
  ] satisfies Reply[]) {
    const saved = memoryStore(savedSession({ expiresAt: NOW + 2 * MINUTE }));
    const server = refreshServer([reply]);
    const { source } = sourceFor(saved.store, server);
    const error = await rejectsWithCode(source.accessToken(undefined), 'signin_required');
    assert.ok(!/access-1|refresh-1|id-token-1/.test(error.message), 'no token in the message');
    const { accessToken, refreshToken, expiresAt, ...kept } = savedSession();
    assert.deepEqual(saved.current(), { ...kept, savedAt: NOW });
    // The next call asks for a sign-in without spending a request.
    await rejectsWithCode(source.accessToken(undefined), 'signin_required');
    assert.equal(server.requests.length, 1);
  }
});

test('an outage keeps the tokens: the current token is used while it lasts, then the outage is reported', async () => {
  for (const reply of ['network-error', { status: 503 }, { status: 400, body: { detail: 'region not permitted' } }, { status: 401, body: { error: 'invalid_client' } }] satisfies Reply[]) {
    const stillValid = memoryStore(savedSession({ expiresAt: NOW + 2 * MINUTE }));
    const { source } = sourceFor(stillValid.store, refreshServer([reply]));
    assert.equal(await source.accessToken(undefined), 'access-1');
    assert.equal(stillValid.writes.length, 0);
  }
  const expired = memoryStore(savedSession({ expiresAt: NOW }));
  const { source } = sourceFor(expired.store, refreshServer(['network-error']));
  await rejectsWithCode(source.accessToken(undefined), 'temporary');
  assert.equal(expired.writes.length, 0);
  assert.deepEqual(expired.current(), savedSession({ expiresAt: NOW }));
});

test('no saved sign-in, or one already ended, asks for a sign-in without a request', async () => {
  const { accessToken, refreshToken, expiresAt, ...signedOut } = savedSession();
  for (const initial of [undefined, signedOut]) {
    const server = refreshServer([]);
    const { lock, source } = sourceFor(memoryStore(initial).store, server);
    await rejectsWithCode(source.accessToken(undefined), 'signin_required');
    assert.equal(server.requests.length, 0);
    assert.equal(lock.taken, 0);
  }
});

// The timeout is how this test loses: without it, a cancel that isn't
// honored hangs on the gated refresh.
test("cancelling the caller doesn't cancel a refresh in flight: the replacement is still saved", { timeout: 5000 }, async () => {
  const saved = memoryStore(savedSession({ expiresAt: NOW - 1 }));
  let release!: () => void;
  const server = refreshServer([refreshed()], new Promise<void>((resolve) => (release = resolve)));
  const { source } = sourceFor(saved.store, server);
  const controller = new AbortController();
  const pending = source.accessToken(controller.signal);
  while (server.requests.length === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(server.requests[0]?.signal, undefined, "the refresh doesn't carry the caller's signal");
  controller.abort();
  await rejectsWithCode(pending, 'cancelled');
  assert.equal(saved.writes.length, 0, 'the caller returned before the refresh finished');
  release();
  // The refresh still holds the lock, so the next caller waits for it and
  // finds the saved replacement.
  assert.equal(await source.accessToken(undefined), 'access-2');
  assert.equal(server.requests.length, 1);
  assert.equal(saved.current()?.refreshToken, 'refresh-2');
});

test('an already cancelled caller gets cancelled before anything is read or sent', async () => {
  const server = refreshServer([]);
  const { source } = sourceFor(memoryStore(savedSession({ expiresAt: NOW - 1 })).store, server);
  await rejectsWithCode(source.accessToken(AbortSignal.abort()), 'cancelled');
  assert.equal(server.requests.length, 0);
});

test('a cancel that lands while the record is being read still returns the caller promptly', { timeout: 5000 }, async () => {
  const controller = new AbortController();
  const saved = memoryStore(savedSession({ expiresAt: NOW - 1 }));
  const store: ChatGPTSessionStore = {
    read: async () => {
      controller.abort();
      return saved.current();
    },
    write: saved.store.write,
  };
  let release!: () => void;
  const server = refreshServer([refreshed()], new Promise<void>((resolve) => (release = resolve)));
  const { source } = sourceFor(store, server);
  await rejectsWithCode(source.accessToken(controller.signal), 'cancelled');
  release();
});

test('sessionFromSignIn saves the account and its tokens, and the ID token from the validated sign-in', () => {
  const signIn: ChatGPTSignIn = {
    clientId: CLIENT_ID,
    subject: 'user-sub-1',
    email: 'person@example.com',
    idToken: 'id-token-1',
    planUsage: true,
    tokens: {
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      idToken: 'id-token-1',
      tokenType: 'Bearer',
      expiresAt: NOW + 60 * MINUTE,
      scopes: ['openid', 'chatgpt.tokens.use.direct'],
      receivedAt: NOW - 1000,
    },
  };
  assert.deepEqual(sessionFromSignIn(signIn), savedSession());
  const { email, ...noEmail } = signIn;
  const { scopes, ...unlisted } = signIn.tokens;
  const { email: _email, ...expected } = savedSession();
  assert.deepEqual(sessionFromSignIn({ ...noEmail, tokens: unlisted }), { ...expected, scopes: [] });
});
