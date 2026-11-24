import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHATGPT_ISSUER,
  ChatGPTAuthError,
  listSignedInChatGPTModels,
  type ChatGPTSession,
  type ChatGPTSessionStore,
} from '../src/index.ts';

// The model list on a saved sign-in, as setup's picker asks for it: the
// same token source a turn uses, so a token about to run out is refreshed
// under the session lock first, and no sign-in sends nothing.

const NOW = Date.UTC(2026, 10, 13, 3, 0, 0);
const MINUTE = 60_000;
const MODELS_URL = 'https://api.openai.com/v1/models';
const DISCOVERY_URL = `${CHATGPT_ISSUER}/.well-known/openid-configuration`;
const TOKEN_URL = `${CHATGPT_ISSUER}/api/accounts/oauth/token`;

const savedSession = (overrides: Partial<ChatGPTSession> = {}): ChatGPTSession => ({
  clientId: 'oaiapp_issued123',
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

const memoryStore = (initial: ChatGPTSession | undefined): ChatGPTSessionStore & { current: () => ChatGPTSession | undefined } => {
  let session = initial;
  return {
    read: async () => session,
    write: async (next) => {
      session = next;
    },
    current: () => session,
  };
};

const discovery = {
  issuer: CHATGPT_ISSUER,
  authorization_endpoint: `${CHATGPT_ISSUER}/api/accounts/authorize`,
  token_endpoint: TOKEN_URL,
  revocation_endpoint: `${CHATGPT_ISSUER}/api/accounts/oauth/revoke`,
  jwks_uri: `${CHATGPT_ISSUER}/.well-known/jwks.json`,
};

type Route = (init: RequestInit) => Response | Promise<Response>;

/** A fake network by URL. A request to a URL with no route fails the test. */
const network = (routes: Record<string, Route | Route[]>) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes[url];
    const next = Array.isArray(route) ? route.shift() : route;
    if (next === undefined) {
      throw new Error(`the fake network has nothing for ${url}`);
    }
    return next(init);
  }) as typeof globalThis.fetch;
  return { fetch, calls, to: (url: string) => calls.filter((call) => call.url === url) };
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const listed = () => json(200, {
  models: [
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list' },
    { slug: 'gpt-5.5-mini', display_name: 'GPT-5.5 mini', visibility: 'list' },
    { slug: 'internal-only', display_name: 'Hidden', visibility: 'hide' },
  ],
});

const bearer = (init: RequestInit | undefined): string | null => new Headers(init?.headers).get('authorization');

test('lists the saved account\'s models on its access token, asking nothing else', async () => {
  const net = network({ [MODELS_URL]: () => listed() });
  let locked = 0;
  const models = await listSignedInChatGPTModels({
    store: memoryStore(savedSession()),
    withSessionLock: async (work) => {
      locked += 1;
      return work();
    },
    fetch: net.fetch,
    now: () => NOW,
  });

  assert.deepEqual(models, [
    { slug: 'gpt-5.5', displayName: 'GPT-5.5' },
    { slug: 'gpt-5.5-mini', displayName: 'GPT-5.5 mini' },
  ]);
  assert.deepEqual(net.calls.map((call) => call.url), [MODELS_URL]);
  assert.equal(bearer(net.calls[0]?.init), 'Bearer access-1');
  // A token that isn't due needs no refresh, so the lock isn't taken.
  assert.equal(locked, 0);
});

test('a token about to run out is refreshed under the session lock first, and the list goes out on the new one', async () => {
  const store = memoryStore(savedSession({ expiresAt: NOW + 2 * MINUTE }));
  const net = network({
    [DISCOVERY_URL]: [() => json(200, discovery)],
    [TOKEN_URL]: [() => json(200, { access_token: 'access-2', refresh_token: 'refresh-2', token_type: 'Bearer', expires_in: 3600 })],
    [MODELS_URL]: [() => listed()],
  });
  let locked = 0;
  const models = await listSignedInChatGPTModels({
    store,
    withSessionLock: async (work) => {
      locked += 1;
      return work();
    },
    fetch: net.fetch,
    now: () => NOW,
  });

  assert.equal(models.length, 2);
  assert.deepEqual(net.calls.map((call) => call.url), [DISCOVERY_URL, TOKEN_URL, MODELS_URL]);
  assert.equal(bearer(net.to(MODELS_URL)[0]?.init), 'Bearer access-2');
  assert.equal(locked, 1);
  assert.equal(store.current()?.accessToken, 'access-2');
  assert.equal(store.current()?.refreshToken, 'refresh-2');
});

test('with no saved sign-in it fails asking for one, and nothing is sent', async () => {
  const net = network({});
  await assert.rejects(
    listSignedInChatGPTModels({ store: memoryStore(undefined), withSessionLock: (work) => work(), fetch: net.fetch, now: () => NOW }),
    (error: unknown) => {
      assert.ok(error instanceof ChatGPTAuthError);
      assert.equal(error.code, 'signin_required');
      return true;
    },
  );
  assert.equal(net.calls.length, 0);
});

test('a sign-in that didn\'t allow plan usage lists nothing, and nothing is sent', async () => {
  const net = network({});
  await assert.rejects(
    listSignedInChatGPTModels({
      store: memoryStore(savedSession({ scopes: ['openid', 'profile', 'email'] })),
      withSessionLock: (work) => work(),
      fetch: net.fetch,
      now: () => NOW,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ChatGPTAuthError);
      assert.equal(error.code, 'plan_usage_not_granted');
      return true;
    },
  );
  assert.equal(net.calls.length, 0);
});

test('once the token has run out, a lookup of the sign-in endpoints that never answers gives up as a timeout', { timeout: 5000 }, async () => {
  const net = network({
    [DISCOVERY_URL]: (init) => new Promise<Response>((_resolve, reject) => {
      const signal = init.signal;
      if (!signal) {
        reject(new Error('test: no signal passed, the lookup could hang forever'));
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  await assert.rejects(
    listSignedInChatGPTModels({
      store: memoryStore(savedSession({ expiresAt: NOW - MINUTE })),
      withSessionLock: (work) => work(),
      fetch: net.fetch,
      now: () => NOW,
      discoveryTimeoutMs: 50,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ChatGPTAuthError);
      assert.equal(error.code, 'timeout');
      assert.match(error.message, /sign-in configuration/);
      return true;
    },
  );
  assert.equal(net.to(MODELS_URL).length, 0);
});
