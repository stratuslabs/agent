import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type JsonWebKey } from 'node:crypto';
import {
  CHATGPT_ISSUER,
  ChatGPTAuthError,
  DYNAMIC_CLIENT_ID,
  signInWithChatGPT,
  signOutOfChatGPT,
  type ChatGPTEndpoints,
  type ChatGPTSignInDocument,
} from '../src/index.ts';

// OpenAI's own issuer, since discovery goes there by default. Every request
// goes to the fake fetch below; nothing reaches the network.
const ISSUER = CHATGPT_ISSUER;
const ISSUED_CLIENT_ID = 'oaiapp_issued123';
const OTHER_CLIENT_ID = 'oaiapp_other456';
const HOST_ID = 'urn:uuid:5b9a3f0e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const NOW = Date.UTC(2026, 10, 13, 1, 0, 0);
const FULL_SCOPE = 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke';

const endpoints: ChatGPTEndpoints = {
  issuer: ISSUER,
  authorizationEndpoint: `${ISSUER}/api/accounts/authorize`,
  tokenEndpoint: `${ISSUER}/api/accounts/oauth/token`,
  revocationEndpoint: `${ISSUER}/api/accounts/oauth/revoke`,
  jwksUri: `${ISSUER}/.well-known/jwks.json`,
};

const signingKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publishedKey: JsonWebKey = { ...signingKey.publicKey.export({ format: 'jwk' }), kid: 'key-1', use: 'sig', alg: 'RS256' };

const segment = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

const signJwt = (claims: Record<string, unknown>): string => {
  const head = segment({ alg: 'RS256', kid: 'key-1', typ: 'JWT' });
  const body = segment(claims);
  return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), signingKey.privateKey).toString('base64url')}`;
};

type Reply = { readonly status: number; readonly body?: unknown } | 'network-error';

interface RecordedRequest {
  readonly url: string;
  readonly form: URLSearchParams;
}

/**
 * OpenAI's side: discovery, keys, the token and revocation endpoints. The
 * token reply is built from the authorize URL the browser opened, so the ID
 * token carries that attempt's nonce and the client it was issued to.
 */
const createFakeOpenAI = (options: {
  readonly scope?: string;
  readonly subject?: string;
  readonly email?: string;
  readonly revoke?: Reply[];
  readonly discovery?: Reply;
} = {}) => {
  const requests: RecordedRequest[] = [];
  const revokeQueue = [...(options.revoke ?? [])];
  let issued = 0;
  let lastAuthorize: URL | undefined;
  const toResponse = (reply: Reply | undefined): Response => {
    if (reply === undefined) {
      throw new Error('the fake OpenAI got a request nothing was queued for');
    }
    if (reply === 'network-error') {
      throw new TypeError('fetch failed');
    }
    return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), { status: reply.status });
  };
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (init?.signal?.aborted === true) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    requests.push({ url, form });
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return toResponse(options.discovery ?? {
        status: 200,
        body: {
          issuer: ISSUER,
          authorization_endpoint: endpoints.authorizationEndpoint,
          token_endpoint: endpoints.tokenEndpoint,
          revocation_endpoint: endpoints.revocationEndpoint,
          jwks_uri: endpoints.jwksUri,
        },
      });
    }
    if (url === endpoints.jwksUri) {
      return toResponse({ status: 200, body: { keys: [publishedKey] } });
    }
    if (url === endpoints.tokenEndpoint) {
      assert.ok(lastAuthorize, 'the code was exchanged before any browser sign-in');
      issued += 1;
      const clientId = form.get('client_id') ?? '';
      return toResponse({
        status: 200,
        body: {
          access_token: `access-${issued}`,
          refresh_token: `refresh-${issued}`,
          id_token: signJwt({
            iss: ISSUER,
            aud: clientId,
            sub: options.subject ?? 'user-sub-1',
            email: options.email ?? 'person@example.com',
            nonce: lastAuthorize.searchParams.get('nonce'),
            iat: NOW / 1000,
            exp: NOW / 1000 + 3600,
          }),
          token_type: 'Bearer',
          expires_in: 3600,
          scope: options.scope ?? FULL_SCOPE,
        },
      });
    }
    if (url === endpoints.revocationEndpoint) {
      return toResponse(revokeQueue.shift());
    }
    throw new Error(`the fake OpenAI has no route for ${url}`);
  };
  return {
    fetch: fakeFetch,
    requests,
    /** Where the browser went, as the sign-in passed it on. */
    authorized: (url: URL) => {
      lastAuthorize = url;
    },
    sent: (endpoint: string) => requests.filter((request) => request.url === endpoint),
  };
};

/**
 * The user's browser: opens the authorize URL and comes back to the
 * loopback callback with a code, or with whatever `answer` returns.
 */
const browser = (
  openai: ReturnType<typeof createFakeOpenAI>,
  answer: (authorize: URL) => Record<string, string> = (authorize) => ({
    code: 'auth-code-1',
    ...(authorize.searchParams.get('client_id') === DYNAMIC_CLIENT_ID ? { client_id: ISSUED_CLIENT_ID } : {}),
  }),
) => {
  const opened: URL[] = [];
  const openUrl = async (url: string): Promise<void> => {
    const authorize = new URL(url);
    opened.push(authorize);
    openai.authorized(authorize);
    const callback = new URL(authorize.searchParams.get('redirect_uri') ?? '');
    callback.search = new URLSearchParams({ state: authorize.searchParams.get('state') ?? '', ...answer(authorize) }).toString();
    const response = await fetch(callback);
    await response.text();
  };
  return { openUrl, opened };
};

const memoryDocument = (initial?: Record<string, unknown>) => {
  let contents = initial === undefined ? undefined : structuredClone(initial);
  const document: ChatGPTSignInDocument = {
    read: async () => (contents === undefined ? undefined : structuredClone(contents)),
    write: async (next) => {
      contents = structuredClone(next);
    },
  };
  return { document, current: () => contents, replace: (next: Record<string, unknown>) => { contents = structuredClone(next); } };
};

/** A lock that records whether each document write happened inside it. */
const recordingLock = (doc: ReturnType<typeof memoryDocument>) => {
  let held = false;
  const writesOutsideLock: number[] = [];
  let writes = 0;
  const write = doc.document.write;
  doc.document.write = async (next) => {
    writes += 1;
    if (!held) {
      writesOutsideLock.push(writes);
    }
    await write(next);
  };
  return {
    writesOutsideLock,
    withSessionLock: async <T>(work: () => Promise<T>): Promise<T> => {
      held = true;
      try {
        return await work();
      } finally {
        held = false;
      }
    },
  };
};

const signedInSession = {
  clientId: ISSUED_CLIENT_ID,
  subject: 'user-sub-1',
  email: 'person@example.com',
  idToken: 'saved-id-token',
  accessToken: 'saved-access',
  refreshToken: 'saved-refresh',
  expiresAt: NOW + 3_600_000,
  scopes: FULL_SCOPE.split(' '),
  savedAt: NOW - 60_000,
};

const signedOutSession = {
  clientId: ISSUED_CLIENT_ID,
  subject: 'user-sub-1',
  email: 'person@example.com',
  scopes: FULL_SCOPE.split(' '),
  savedAt: NOW - 60_000,
};

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

const noTokensIn = (text: string): void => {
  for (const secret of ['access-', 'refresh-', 'saved-access', 'saved-refresh', 'saved-id-token', 'eyJ']) {
    assert.ok(!text.includes(secret), `${JSON.stringify(text)} quotes a token (${secret})`);
  }
};

test('a first sign-in makes the host ID, registers through the browser, and saves the session under the lock', async () => {
  const openai = createFakeOpenAI();
  const user = browser(openai);
  const doc = memoryDocument();
  const lock = recordingLock(doc);

  const outcome = await signInWithChatGPT({
    document: doc.document,
    withSessionLock: lock.withSessionLock,
    fetch: openai.fetch,
    openUrl: user.openUrl,
    ports: [0],
    timeoutMs: 10_000,
    now: () => NOW,
  });

  assert.equal(user.opened.length, 1);
  const authorize = user.opened[0]!;
  assert.equal(`${authorize.origin}${authorize.pathname}`, endpoints.authorizationEndpoint, 'the authorize endpoint came from discovery');
  assert.equal(authorize.searchParams.get('client_id'), DYNAMIC_CLIENT_ID);
  assert.equal(authorize.searchParams.get('agent_name_hint'), 'Stratus Agent');
  assert.equal(authorize.searchParams.get('id_token_hint'), null);
  assert.match(authorize.searchParams.get('redirect_uri') ?? '', /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);

  const saved = doc.current() as { hostId: string; session: Record<string, unknown> };
  assert.match(saved.hostId, /^urn:uuid:/);
  assert.equal(authorize.searchParams.get('ext_agent_host_id'), saved.hostId, 'the URL carries the host ID that was saved');
  assert.equal(saved.session.clientId, ISSUED_CLIENT_ID);
  assert.equal(saved.session.subject, 'user-sub-1');
  assert.equal(saved.session.accessToken, 'access-1');
  assert.equal(saved.session.refreshToken, 'refresh-1');
  assert.equal(saved.session.expiresAt, NOW + 3_600_000);
  assert.deepEqual(lock.writesOutsideLock, [], 'every write of the document was inside the lock');

  assert.deepEqual(outcome, {
    email: 'person@example.com',
    subject: 'user-sub-1',
    registered: true,
    planUsage: true,
    expiresAt: NOW + 3_600_000,
  });
  noTokensIn(JSON.stringify(outcome));
});

test('signing in again reuses the saved registration and host ID, with the ID token as a hint while there is one', async () => {
  for (const [label, session, hint] of [
    ['signed in', signedInSession, 'saved-id-token'],
    ['signed out', signedOutSession, null],
  ] as const) {
    const openai = createFakeOpenAI();
    const user = browser(openai, () => ({ code: 'auth-code-2' }));
    const doc = memoryDocument({ hostId: HOST_ID, session });
    const lock = recordingLock(doc);

    const outcome = await signInWithChatGPT({
      document: doc.document,
      withSessionLock: lock.withSessionLock,
      endpoints,
      fetch: openai.fetch,
      openUrl: user.openUrl,
      ports: [0],
      // Bounded, so a sign-in that never sees its callback fails the test fast.
      timeoutMs: 10_000,
      now: () => NOW,
    });

    const authorize = user.opened[0]!;
    assert.equal(authorize.searchParams.get('client_id'), ISSUED_CLIENT_ID, label);
    assert.equal(authorize.searchParams.get('ext_agent_host_id'), HOST_ID, label);
    assert.equal(authorize.searchParams.get('agent_name_hint'), null, label);
    assert.equal(authorize.searchParams.get('id_token_hint'), hint, label);
    assert.equal(authorize.searchParams.get('login_hint'), 'person@example.com', label);
    assert.equal(openai.sent(`${ISSUER}/.well-known/openid-configuration`).length, 0, `${label}: given endpoints are not discovered again`);
    const saved = doc.current() as { hostId: string; session: Record<string, unknown> };
    assert.equal(saved.hostId, HOST_ID, label);
    assert.equal(saved.session.clientId, ISSUED_CLIENT_ID, label);
    assert.equal(saved.session.accessToken, 'access-1', label);
    assert.equal(outcome.registered, false, label);
    assert.deepEqual(lock.writesOutsideLock, [], label);
  }
});

test('a sign-in without the plan permission is saved and says so', async () => {
  const openai = createFakeOpenAI({ scope: 'email offline_access openid profile' });
  const user = browser(openai);
  const doc = memoryDocument({ hostId: HOST_ID });
  const outcome = await signInWithChatGPT({
    document: doc.document,
    withSessionLock: (work) => work(),
    endpoints,
    fetch: openai.fetch,
    openUrl: user.openUrl,
    ports: [0],
    timeoutMs: 10_000,
    now: () => NOW,
  });
  assert.equal(outcome.planUsage, false);
  assert.equal((doc.current() as { session: { accessToken: string } }).session.accessToken, 'access-1');
});

test('a new account is refused while another one is signed in, before the browser opens', async () => {
  const openai = createFakeOpenAI();
  const user = browser(openai);
  const doc = memoryDocument({ hostId: HOST_ID, session: signedInSession });
  const error = await rejectsWithCode(
    signInWithChatGPT({
      document: doc.document,
      withSessionLock: (work) => work(),
      endpoints,
      fetch: openai.fetch,
      openUrl: user.openUrl,
      account: 'new',
      ports: [0],
      // Bounded, so a sign-in that never sees its callback fails the test fast.
      timeoutMs: 10_000,
      now: () => NOW,
    }),
    'signed_in',
  );
  assert.match(error.message, /person@example\.com/);
  assert.match(error.message, /[Ss]ign out/);
  assert.equal(user.opened.length, 0);
  assert.deepEqual(doc.current(), { hostId: HOST_ID, session: signedInSession });
});

test('a new account after sign-out registers a new client and takes the saved account\'s place', async () => {
  const openai = createFakeOpenAI({ subject: 'user-sub-2', email: 'other@example.com' });
  const user = browser(openai, (authorize) => {
    assert.equal(authorize.searchParams.get('client_id'), DYNAMIC_CLIENT_ID);
    assert.equal(authorize.searchParams.get('login_hint'), null, 'no hint for the account being replaced');
    return { code: 'auth-code-3', client_id: OTHER_CLIENT_ID };
  });
  const doc = memoryDocument({ hostId: HOST_ID, session: signedOutSession });
  const outcome = await signInWithChatGPT({
    document: doc.document,
    withSessionLock: (work) => work(),
    endpoints,
    fetch: openai.fetch,
    openUrl: user.openUrl,
    account: 'new',
    ports: [0],
    timeoutMs: 10_000,
    now: () => NOW,
  });
  assert.equal(outcome.registered, true);
  assert.equal(outcome.email, 'other@example.com');
  const saved = doc.current() as { hostId: string; session: Record<string, unknown> };
  assert.equal(saved.hostId, HOST_ID);
  assert.equal(saved.session.clientId, OTHER_CLIENT_ID);
  assert.equal(saved.session.subject, 'user-sub-2');
});

test('a sign-in never overwrites a saved account that another sign-in changed while the browser was open', async () => {
  const otherSignedIn = { ...signedInSession, clientId: OTHER_CLIENT_ID, subject: 'user-sub-2', email: 'other@example.com' };
  const { idToken: _i, accessToken: _a, refreshToken: _r, expiresAt: _e, ...otherSignedOut } = otherSignedIn;
  const cases = [
    { label: 'first sign-in; another account signed in meanwhile', start: undefined, meanwhile: otherSignedIn, account: 'saved' },
    { label: 'first sign-in; another account signed in and out meanwhile', start: undefined, meanwhile: otherSignedOut, account: 'saved' },
    { label: 'returning sign-in; another account replaced it and signed out', start: signedOutSession, meanwhile: otherSignedOut, account: 'saved' },
    { label: 'new account; another account replaced the saved one', start: signedOutSession, meanwhile: otherSignedIn, account: 'new' },
  ] as const;
  for (const { label, start, meanwhile, account } of cases) {
    const openai = createFakeOpenAI();
    const doc = memoryDocument(start === undefined ? { hostId: HOST_ID } : { hostId: HOST_ID, session: start });
    const user = browser(openai, (authorize) => ({
      code: 'auth-code-4',
      ...(authorize.searchParams.get('client_id') === DYNAMIC_CLIENT_ID ? { client_id: 'oaiapp_third789' } : {}),
    }));
    const error = await rejectsWithCode(
      signInWithChatGPT({
        document: doc.document,
        withSessionLock: (work) => work(),
        endpoints,
        fetch: openai.fetch,
        openUrl: async (url) => {
          // Another setup finishes first.
          doc.replace({ hostId: HOST_ID, session: meanwhile });
          await user.openUrl(url);
        },
        account,
        ports: [0],
        timeoutMs: 10_000,
        now: () => NOW,
      }),
      'account_changed',
    );
    assert.match(error.message, /other@example\.com/, label);
    assert.deepEqual(doc.current(), { hostId: HOST_ID, session: meanwhile }, label);
  }
});

test('a new account is refused at save when the saved account was signed in again meanwhile', async () => {
  const openai = createFakeOpenAI({ subject: 'user-sub-2' });
  const doc = memoryDocument({ hostId: HOST_ID, session: signedOutSession });
  const user = browser(openai, () => ({ code: 'auth-code-5', client_id: OTHER_CLIENT_ID }));
  await rejectsWithCode(
    signInWithChatGPT({
      document: doc.document,
      withSessionLock: (work) => work(),
      endpoints,
      fetch: openai.fetch,
      openUrl: async (url) => {
        doc.replace({ hostId: HOST_ID, session: signedInSession });
        await user.openUrl(url);
      },
      account: 'new',
      ports: [0],
      timeoutMs: 10_000,
      now: () => NOW,
    }),
    'signed_in',
  );
  assert.deepEqual(doc.current(), { hostId: HOST_ID, session: signedInSession });
});

test('an openUrl that never settles holds up neither the callback nor a timeout or cancel', async () => {
  const never = new Promise<void>(() => undefined);
  // A sign-in held up by openUrl would hang here, so each one gets 5 s.
  const within = <T>(promise: Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('the sign-in waited on openUrl')), 5000);
    });
    return Promise.race([promise, late]).finally(() => clearTimeout(timer));
  };

  const openai = createFakeOpenAI();
  const user = browser(openai);
  const doc = memoryDocument({ hostId: HOST_ID });
  const outcome = await within(signInWithChatGPT({
    document: doc.document,
    withSessionLock: (work) => work(),
    endpoints,
    fetch: openai.fetch,
    openUrl: async (url) => {
      await user.openUrl(url);
      // The browser came back, but the process that opened it hasn't exited.
      return never;
    },
    ports: [0],
    timeoutMs: 10_000,
    now: () => NOW,
  }));
  assert.equal(outcome.registered, true);
  assert.equal((doc.current() as { session: { clientId: string } }).session.clientId, ISSUED_CLIENT_ID);

  await rejectsWithCode(
    within(signInWithChatGPT({
      document: memoryDocument({ hostId: HOST_ID }).document,
      withSessionLock: (work) => work(),
      endpoints,
      fetch: createFakeOpenAI().fetch,
      openUrl: () => never,
      ports: [0],
      timeoutMs: 50,
      now: () => NOW,
    })),
    'timeout',
  );

  const controller = new AbortController();
  await rejectsWithCode(
    within(signInWithChatGPT({
      document: memoryDocument({ hostId: HOST_ID }).document,
      withSessionLock: (work) => work(),
      endpoints,
      fetch: createFakeOpenAI().fetch,
      openUrl: () => {
        setImmediate(() => controller.abort());
        return never;
      },
      signal: controller.signal,
      ports: [0],
      timeoutMs: 10_000,
      now: () => NOW,
    })),
    'cancelled',
  );
});

test('a declined, failed or cancelled sign-in leaves the saved one as it was and frees the callback port', async () => {
  const cases: Array<{
    readonly label: string;
    readonly code: string;
    readonly run: (port: number, doc: ReturnType<typeof memoryDocument>) => Promise<unknown>;
  }> = [
    {
      label: 'declined in the browser',
      code: 'access_denied',
      run: (port, doc) => {
        const openai = createFakeOpenAI();
        return signInWithChatGPT({
          document: doc.document,
          withSessionLock: (work) => work(),
          endpoints,
          fetch: openai.fetch,
          openUrl: browser(openai, () => ({ error: 'access_denied' })).openUrl,
          ports: [port],
          timeoutMs: 10_000,
          now: () => NOW,
        });
      },
    },
    {
      label: 'cancelled while waiting for the browser',
      code: 'cancelled',
      run: (port, doc) => {
        const controller = new AbortController();
        return signInWithChatGPT({
          document: doc.document,
          withSessionLock: (work) => work(),
          endpoints,
          fetch: createFakeOpenAI().fetch,
          openUrl: () => {
            setImmediate(() => controller.abort());
          },
          signal: controller.signal,
          ports: [port],
          timeoutMs: 10_000,
          now: () => NOW,
        });
      },
    },
    {
      label: 'no browser came back in time',
      code: 'timeout',
      run: (port, doc) =>
        signInWithChatGPT({
          document: doc.document,
          withSessionLock: (work) => work(),
          endpoints,
          fetch: createFakeOpenAI().fetch,
          openUrl: () => undefined,
          timeoutMs: 50,
          ports: [port],
          now: () => NOW,
        }),
    },
  ];
  const { createServer } = await import('node:net');
  const freePort = (): Promise<number> =>
    new Promise((resolve, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen({ port: 0, host: '127.0.0.1' }, () => {
        const address = probe.address();
        probe.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0));
      });
    });
  const portIsFree = (port: number): Promise<boolean> =>
    new Promise((resolve) => {
      const probe = createServer();
      probe.once('error', () => resolve(false));
      probe.listen({ port, host: '127.0.0.1', exclusive: true }, () => probe.close(() => resolve(true)));
    });

  for (const { label, code, run } of cases) {
    const port = await freePort();
    const doc = memoryDocument({ hostId: HOST_ID, session: signedOutSession });
    await rejectsWithCode(run(port, doc), code);
    assert.deepEqual(doc.current(), { hostId: HOST_ID, session: signedOutSession }, label);
    assert.equal(await portIsFree(port), true, `${label}: the callback listener was closed`);
  }

  // A browser that can't be opened at all: its error comes through, and the listener is closed.
  const port = await freePort();
  const doc = memoryDocument({ hostId: HOST_ID });
  await assert.rejects(
    signInWithChatGPT({
      document: doc.document,
      withSessionLock: (work) => work(),
      endpoints,
      fetch: createFakeOpenAI().fetch,
      openUrl: () => {
        throw new Error('no browser here');
      },
      ports: [port],
      timeoutMs: 10_000,
      now: () => NOW,
    }),
    /no browser here/,
  );
  assert.deepEqual(doc.current(), { hostId: HOST_ID });
  assert.equal(await portIsFree(port), true, 'a browser that could not open: the callback listener was closed');
});

test('a lock or store failure is storage_failed and quotes nothing from the store', async () => {
  const openai = createFakeOpenAI();
  const leaky = new Error('EACCES writing {"refreshToken":"saved-refresh"}');
  const doc = memoryDocument({ hostId: HOST_ID, session: signedOutSession });
  const signIn = await rejectsWithCode(
    signInWithChatGPT({
      document: doc.document,
      withSessionLock: async () => {
        throw leaky;
      },
      endpoints,
      fetch: openai.fetch,
      openUrl: browser(openai).openUrl,
      ports: [0],
      // Bounded, so a sign-in that never sees its callback fails the test fast.
      timeoutMs: 10_000,
      now: () => NOW,
    }),
    'storage_failed',
  );
  assert.equal(signIn.cause, leaky);
  noTokensIn(signIn.message);

  const signOut = await rejectsWithCode(
    signOutOfChatGPT({
      document: memoryDocument({ hostId: HOST_ID, session: signedInSession }).document,
      withSessionLock: async () => {
        throw leaky;
      },
      endpoints,
      fetch: createFakeOpenAI().fetch,
      now: () => NOW,
    }),
    'storage_failed',
  );
  noTokensIn(signOut.message);
});

test('sign-out revokes the refresh token under the lock, then clears the tokens and keeps the account and host ID', async () => {
  const openai = createFakeOpenAI({ revoke: [{ status: 200 }] });
  const doc = memoryDocument({ hostId: HOST_ID, session: signedInSession });
  let held = false;
  let revokedWhileHeld: boolean | undefined;
  const fetchUnderLock: typeof fetch = async (input, init) => {
    if (String(input) === endpoints.revocationEndpoint) {
      revokedWhileHeld = held;
    }
    return openai.fetch(input, init);
  };
  const outcome = await signOutOfChatGPT({
    document: doc.document,
    withSessionLock: async (work) => {
      held = true;
      try {
        return await work();
      } finally {
        held = false;
      }
    },
    fetch: fetchUnderLock,
    now: () => NOW,
  });

  assert.deepEqual(outcome, { signedOut: true, email: 'person@example.com', revocation: { confirmed: true } });
  assert.equal(revokedWhileHeld, true);
  const [revoke] = openai.sent(endpoints.revocationEndpoint);
  assert.equal(revoke?.form.get('token'), 'saved-refresh');
  assert.equal(revoke?.form.get('token_type_hint'), 'refresh_token');
  assert.equal(revoke?.form.get('client_id'), ISSUED_CLIENT_ID);
  assert.deepEqual(doc.current(), {
    hostId: HOST_ID,
    session: {
      clientId: ISSUED_CLIENT_ID,
      subject: 'user-sub-1',
      email: 'person@example.com',
      scopes: signedInSession.scopes,
      savedAt: NOW,
    },
  });
});

test('sign-out revokes the token saved at that moment, not one read before the lock', async () => {
  const openai = createFakeOpenAI({ revoke: [{ status: 200 }] });
  const doc = memoryDocument({ hostId: HOST_ID, session: signedInSession });
  await signOutOfChatGPT({
    document: doc.document,
    withSessionLock: async (work) => {
      // Another process refreshed while this one waited for the lock.
      doc.replace({ hostId: HOST_ID, session: { ...signedInSession, refreshToken: 'rotated-refresh' } });
      return work();
    },
    endpoints,
    fetch: openai.fetch,
    now: () => NOW,
  });
  assert.equal(openai.sent(endpoints.revocationEndpoint)[0]?.form.get('token'), 'rotated-refresh');
});

test('sign-out clears the tokens even when OpenAI does not confirm the revocation', async () => {
  const cases: Array<{ readonly label: string; readonly openai: ReturnType<typeof createFakeOpenAI>; readonly withEndpoints: boolean }> = [
    { label: 'refused', openai: createFakeOpenAI({ revoke: [{ status: 400, body: { error: 'invalid_request' } }] }), withEndpoints: true },
    { label: 'unreachable', openai: createFakeOpenAI({ revoke: ['network-error', 'network-error', 'network-error'] }), withEndpoints: true },
    { label: 'no sign-in configuration', openai: createFakeOpenAI({ discovery: { status: 503 } }), withEndpoints: false },
  ];
  for (const { label, openai, withEndpoints } of cases) {
    const doc = memoryDocument({ hostId: HOST_ID, session: signedInSession });
    const outcome = await signOutOfChatGPT({
      document: doc.document,
      withSessionLock: (work) => work(),
      ...(withEndpoints ? { endpoints } : {}),
      fetch: openai.fetch,
      wait: async () => undefined,
      now: () => NOW,
    });
    assert.equal(outcome.signedOut, true, label);
    assert.equal(outcome.revocation?.confirmed, false, label);
    assert.ok(outcome.revocation?.reason, `${label}: a reason is given`);
    noTokensIn(outcome.revocation?.reason ?? '');
    const session = (doc.current() as { session: Record<string, unknown> }).session;
    assert.deepEqual(
      [session.accessToken, session.refreshToken, session.idToken, session.expiresAt],
      [undefined, undefined, undefined, undefined],
      label,
    );
    assert.equal(session.clientId, ISSUED_CLIENT_ID, label);
  }
});

test('sign-out with nothing to revoke sends nothing, and clears a leftover ID token', async () => {
  const openai = createFakeOpenAI();
  const empty = memoryDocument();
  assert.deepEqual(
    await signOutOfChatGPT({ document: empty.document, withSessionLock: (work) => work(), fetch: openai.fetch, now: () => NOW }),
    { signedOut: false },
  );
  assert.equal(empty.current(), undefined, 'nothing was written');

  const ended = memoryDocument({ hostId: HOST_ID, session: { ...signedOutSession, idToken: 'saved-id-token' } });
  const outcome = await signOutOfChatGPT({ document: ended.document, withSessionLock: (work) => work(), fetch: openai.fetch, now: () => NOW });
  assert.deepEqual(outcome, { signedOut: false, email: 'person@example.com' });
  assert.equal((ended.current() as { session: Record<string, unknown> }).session.idToken, undefined, 'OpenAI says to drop the ID token hint at sign-out');
  assert.equal(openai.requests.length, 0);
});

test('a cancelled sign-out keeps the sign-in', async () => {
  const controller = new AbortController();
  controller.abort();
  const doc = memoryDocument({ hostId: HOST_ID, session: signedInSession });
  await rejectsWithCode(
    signOutOfChatGPT({
      document: doc.document,
      withSessionLock: (work) => work(),
      endpoints,
      fetch: createFakeOpenAI({ revoke: [{ status: 200 }] }).fetch,
      signal: controller.signal,
      now: () => NOW,
    }),
    'cancelled',
  );
  assert.deepEqual(doc.current(), { hostId: HOST_ID, session: signedInSession });
});

test('sign-out of an account already signed out writes nothing', async () => {
  const doc = memoryDocument({ hostId: HOST_ID, session: signedOutSession });
  let wrote = false;
  const write = doc.document.write;
  doc.document.write = async (next) => {
    wrote = true;
    await write(next);
  };
  const outcome = await signOutOfChatGPT({ document: doc.document, withSessionLock: (work) => work(), fetch: createFakeOpenAI().fetch, now: () => NOW });
  assert.deepEqual(outcome, { signedOut: false, email: 'person@example.com' });
  assert.equal(wrote, false);
});

test('a sign-out cancelled before it starts takes no lock', async () => {
  const controller = new AbortController();
  controller.abort();
  let locked = false;
  await rejectsWithCode(
    signOutOfChatGPT({
      document: memoryDocument({ hostId: HOST_ID, session: { ...signedOutSession, idToken: 'saved-id-token' } }).document,
      withSessionLock: (work) => {
        locked = true;
        return work();
      },
      fetch: createFakeOpenAI().fetch,
      signal: controller.signal,
      now: () => NOW,
    }),
    'cancelled',
  );
  assert.equal(locked, false);
});

test('cancelling while the revocation is in flight stops it and keeps the sign-in', async () => {
  const controller = new AbortController();
  const doc = memoryDocument({ hostId: HOST_ID, session: signedInSession });
  // OpenAI takes its time; the user presses Ctrl+C meanwhile. A request sent
  // without the signal would get its 200 and the sign-out would go through.
  const slowFetch: typeof fetch = (_input, init) =>
    new Promise((resolve, reject) => {
      const answer = setTimeout(() => resolve(new Response('', { status: 200 })), 200);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(answer);
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      }, { once: true });
      setImmediate(() => controller.abort());
    });
  await rejectsWithCode(
    signOutOfChatGPT({
      document: doc.document,
      withSessionLock: (work) => work(),
      endpoints,
      fetch: slowFetch,
      signal: controller.signal,
      now: () => NOW,
    }),
    'cancelled',
  );
  assert.deepEqual(doc.current(), { hostId: HOST_ID, session: signedInSession });
});
