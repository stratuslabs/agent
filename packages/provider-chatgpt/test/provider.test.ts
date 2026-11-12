import test from 'node:test';
import assert from 'node:assert/strict';

import type { ProviderCallUsage, ProviderRequest } from '@stratusagent/core';
import { ResponsesApiError } from '@stratusagent/providers';
import {
  CHATGPT_ISSUER,
  ChatGPTAuthError,
  createChatGPTProvider,
  type ChatGPTSession,
  type ChatGPTSessionStore,
} from '../src/index.ts';

const NOW = Date.UTC(2026, 10, 12, 21, 0, 0);
const MINUTE = 60_000;
const RESPONSES_URL = 'https://api.openai.com/v1/responses';
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

const withSessionLock = <T>(work: () => Promise<T>): Promise<T> => work();

const now = new Date(NOW).toISOString();
const sayHello = (): ProviderRequest => ({
  session: {
    id: 'session-1',
    agent: { id: 'agent-1', name: 'Kernel' },
    status: 'running',
    messages: [{ id: 'session-1:user:1', role: 'user', content: 'Say hello', createdAt: now }],
    createdAt: now,
    updatedAt: now,
  },
  tools: [{ name: 'fs.read' }],
});

const encoder = new TextEncoder();
const sseResponse = (events: readonly object[], headers: Record<string, string> = {}): Response =>
  new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } });

const completed = (text: string) => ({
  type: 'response.completed',
  response: {
    id: 'resp_1',
    status: 'completed',
    model: 'gpt-test',
    output: [{ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }],
    usage: { input_tokens: 10, output_tokens: 2 },
  },
});

const failed = (code: string, message: string) => ({
  type: 'response.failed',
  response: { id: 'resp_1', status: 'failed', model: 'gpt-test', output: [], error: { code, message } },
});

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

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('a turn goes to the Responses API on the saved access token, with the tools in one namespace', async () => {
  const net = network({ [RESPONSES_URL]: () => sseResponse([completed('Hello!')]) });
  const usage: ProviderCallUsage[] = [];
  const provider = createChatGPTProvider({
    model: 'gpt-test',
    store: memoryStore(savedSession()),
    withSessionLock,
    fetch: net.fetch,
    now: () => NOW,
  });
  assert.equal(provider.name, 'chatgpt');

  const response = await provider.generate({ ...sayHello(), onUsage: (call) => usage.push(call) });
  assert.deepEqual(response.parts, [{ type: 'text', text: 'Hello!' }]);

  // Nothing else was asked: a fresh token needs no discovery and no refresh.
  assert.deepEqual(net.calls.map((call) => call.url), [RESPONSES_URL]);
  const [call] = net.calls;
  assert.equal(new Headers(call?.init.headers).get('authorization'), 'Bearer access-1');
  const body = JSON.parse(String(call?.init.body)) as Record<string, unknown>;
  assert.equal(body.model, 'gpt-test');
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  const tools = body.tools as Array<{ type: string; name: string; tools: Array<{ name: string }> }>;
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.type, 'namespace');
  assert.equal(tools[0]?.name, 'stratus');
  assert.equal(tools[0]?.tools.length, 1);
  assert.equal(usage[0]?.provider, 'chatgpt');
});

test('a token close to expiry is refreshed first, finding the token endpoint once and only then', async () => {
  let clock = NOW;
  const store = memoryStore(savedSession({ expiresAt: NOW + 2 * MINUTE }));
  const net = network({
    [DISCOVERY_URL]: [() => json(200, discovery)],
    [TOKEN_URL]: [
      () => json(200, { access_token: 'access-2', refresh_token: 'refresh-2', token_type: 'Bearer', expires_in: 3600 }),
      () => json(200, { access_token: 'access-3', refresh_token: 'refresh-3', token_type: 'Bearer', expires_in: 3600 }),
    ],
    [RESPONSES_URL]: [() => sseResponse([completed('one')]), () => sseResponse([completed('two')]), () => sseResponse([completed('three')])],
  });
  const provider = createChatGPTProvider({ model: 'gpt-test', store, withSessionLock, fetch: net.fetch, now: () => clock });

  await provider.generate(sayHello());
  await provider.generate(sayHello());
  // Most of an hour later the new token is due too, and the endpoint found
  // for the first refresh serves the second.
  clock = NOW + 58 * MINUTE;
  await provider.generate(sayHello());

  assert.deepEqual(net.calls.map((call) => call.url), [DISCOVERY_URL, TOKEN_URL, RESPONSES_URL, RESPONSES_URL, TOKEN_URL, RESPONSES_URL]);
  assert.deepEqual(
    net.to(RESPONSES_URL).map((call) => new Headers(call.init.headers).get('authorization')),
    ['Bearer access-2', 'Bearer access-2', 'Bearer access-3'],
  );
  assert.equal(store.current()?.refreshToken, 'refresh-3');
});

test('when the token endpoint can\'t be found, a token that hasn\'t run out still serves, and the next turn looks again', async () => {
  const store = memoryStore(savedSession({ expiresAt: NOW + 2 * MINUTE }));
  const net = network({
    [DISCOVERY_URL]: [() => new Response('unavailable', { status: 503 }), () => json(200, discovery)],
    [TOKEN_URL]: [() => json(200, { access_token: 'access-2', refresh_token: 'refresh-2', token_type: 'Bearer', expires_in: 3600 })],
    [RESPONSES_URL]: [() => sseResponse([completed('one')]), () => sseResponse([completed('two')])],
  });
  const provider = createChatGPTProvider({ model: 'gpt-test', store, withSessionLock, fetch: net.fetch, now: () => NOW });

  await provider.generate(sayHello());
  assert.equal(new Headers(net.to(RESPONSES_URL)[0]?.init.headers).get('authorization'), 'Bearer access-1');
  assert.equal(store.current()?.refreshToken, 'refresh-1');

  await provider.generate(sayHello());
  assert.equal(net.to(DISCOVERY_URL).length, 2);
  assert.equal(new Headers(net.to(RESPONSES_URL)[1]?.init.headers).get('authorization'), 'Bearer access-2');
});

test('with no saved sign-in the turn fails asking for one, and nothing is sent', async () => {
  const net = network({});
  const provider = createChatGPTProvider({ model: 'gpt-test', store: memoryStore(undefined), withSessionLock, fetch: net.fetch, now: () => NOW });
  await assert.rejects(provider.generate(sayHello()), (error: unknown) => {
    assert.ok(error instanceof ChatGPTAuthError);
    assert.equal(error.code, 'signin_required');
    assert.match(error.message, /stratus setup/);
    return true;
  });
  assert.equal(net.calls.length, 0);
});

test('a sign-in that didn\'t allow plan usage fails the turn before anything is sent', async () => {
  const net = network({});
  const provider = createChatGPTProvider({
    model: 'gpt-test',
    store: memoryStore(savedSession({ scopes: ['openid', 'profile', 'email'] })),
    withSessionLock,
    fetch: net.fetch,
    now: () => NOW,
  });
  await assert.rejects(provider.generate(sayHello()), (error: unknown) => {
    assert.ok(error instanceof ChatGPTAuthError);
    assert.equal(error.code, 'plan_usage_not_granted');
    return true;
  });
  assert.equal(net.calls.length, 0);
});

test('ChatGPT plan errors say what to do, keeping OpenAI\'s words, the status, the code and the request ID', async () => {
  const cases: Array<{ what: string; reply: () => Response; expected: RegExp; status: number | undefined; code: string | undefined }> = [
    {
      what: 'usage limit before the stream',
      reply: () => json(429, { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Usage limit reached.' } }, { 'x-request-id': 'req_1' }),
      expected: /^ChatGPT says this account has reached a usage limit for Stratus Agent\. See https:\/\/chatgpt\.com\/settings\/usage and try again later\. \(OpenAI: Usage limit reached\.; HTTP 429; request req_1\)$/,
      status: 429,
      code: 'subscription_sharing_usage_limit_exceeded',
    },
    {
      what: 'usage limit inside the stream',
      reply: () => sseResponse([failed('subscription_sharing_usage_limit_exceeded', 'Usage limit reached.')], { 'x-request-id': 'req_2' }),
      expected: /^ChatGPT says this account has reached a usage limit for Stratus Agent\. See https:\/\/chatgpt\.com\/settings\/usage .*request req_2\)$/,
      status: undefined,
      code: 'subscription_sharing_usage_limit_exceeded',
    },
    {
      what: 'usage unavailable',
      reply: () => json(503, { error: { code: 'subscription_sharing_usage_unavailable', message: 'Try later.' } }),
      expected: /^ChatGPT couldn't check this account's plan usage just now\. Try again in a few minutes\. \(OpenAI: Try later\.; HTTP 503\)$/,
      status: 503,
      code: 'subscription_sharing_usage_unavailable',
    },
    {
      what: 'user unavailable',
      reply: () => json(503, { error: { code: 'subscription_sharing_user_unavailable', message: 'Try later.' } }),
      expected: /^ChatGPT couldn't check this account's plan usage just now\./,
      status: 503,
      code: 'subscription_sharing_user_unavailable',
    },
    {
      what: 'not eligible',
      reply: () => json(403, { error: { code: 'subscription_sharing_user_not_eligible', message: 'Not eligible.' } }),
      expected: /^ChatGPT plan usage isn't available for this account or workspace\. Sign in with another ChatGPT account, or use an OpenAI API key, in `stratus setup`\./,
      status: 403,
      code: 'subscription_sharing_user_not_eligible',
    },
    {
      what: 'unsupported capability, with its param',
      reply: () => json(400, { error: { code: 'subscription_sharing_unsupported_capability', message: 'Unsupported.', param: 'tools[0]' } }),
      expected: /^ChatGPT plan usage doesn't support part of this request \(tools\[0\]\)\. \(OpenAI: Unsupported\.; HTTP 400\)$/,
      status: 400,
      code: 'subscription_sharing_unsupported_capability',
    },
    {
      what: 'route not supported',
      reply: () => json(403, { error: { code: 'subscription_sharing_route_not_supported', message: 'Wrong route.' } }),
      expected: /^ChatGPT plan usage doesn't support the endpoint Stratus called\. This is a Stratus bug; please report it\./,
      status: 403,
      code: 'subscription_sharing_route_not_supported',
    },
    {
      what: 'invalid user',
      reply: () => json(401, { error: { code: 'subscription_sharing_invalid_user', message: 'Invalid user.' } }),
      expected: /^ChatGPT couldn't validate the signed-in account\. If it keeps happening, sign in with ChatGPT again in `stratus setup`\./,
      status: 401,
      code: 'subscription_sharing_invalid_user',
    },
    {
      what: 'permission context',
      reply: () => json(403, { error: { code: 'chatpass_v2_scope_not_authorized', message: 'Scope.' } }),
      expected: /^This ChatGPT sign-in isn't authorized to use the plan for this request\. Sign in with ChatGPT again in `stratus setup`\./,
      status: 403,
      code: 'chatpass_v2_scope_not_authorized',
    },
    {
      what: 'admission 401 with a detail body',
      reply: () => json(401, { detail: 'Signed identity rejected.' }),
      expected: /^ChatGPT didn't accept this sign-in for plan usage\. Sign in with ChatGPT again in `stratus setup`\. \(OpenAI: \{"detail":"Signed identity rejected\."\}; HTTP 401\)$/,
      status: 401,
      code: undefined,
    },
    {
      what: 'admission 403 with a detail body',
      reply: () => json(403, { detail: 'Region.' }),
      expected: /^ChatGPT refused to serve this request, for example from this region\./,
      status: 403,
      code: undefined,
    },
    {
      what: 'admission 503 with a detail body',
      reply: () => json(503, { detail: 'Direct routing off.' }),
      expected: /^ChatGPT plan usage is unavailable right now\. Try again later\./,
      status: 503,
      code: undefined,
    },
  ];
  for (const { what, reply, expected, status, code } of cases) {
    const net = network({ [RESPONSES_URL]: reply });
    const provider = createChatGPTProvider({ model: 'gpt-test', store: memoryStore(savedSession()), withSessionLock, fetch: net.fetch, now: () => NOW });
    await assert.rejects(provider.generate(sayHello()), (error: unknown) => {
      assert.ok(error instanceof ResponsesApiError, what);
      assert.match(error.message, expected, what);
      assert.equal(error.status, status, what);
      assert.equal(error.code, code, what);
      assert.doesNotMatch(error.message, /access-1/, what);
      return true;
    }, what);
    assert.equal(net.calls.length, 1, `${what}: sent once, never retried on another billing path`);
  }
});

test('other failures come through as the adapter reports them', async () => {
  for (const [what, reply, message] of [
    ['a server error with a code', () => json(500, { error: { code: 'server_error', message: 'The server had an error.' } }), 'The server had an error.'],
    ['a 401 with another code', () => json(401, { error: { code: 'invalid_api_key', message: 'Bad token.' } }), 'Bad token.'],
    ['a 429 without a code', () => json(429, { error: { message: 'Slow down.' } }), 'Slow down.'],
  ] as const) {
    const net = network({ [RESPONSES_URL]: reply });
    const provider = createChatGPTProvider({ model: 'gpt-test', store: memoryStore(savedSession()), withSessionLock, fetch: net.fetch, now: () => NOW });
    await assert.rejects(provider.generate(sayHello()), (error: unknown) => {
      assert.ok(error instanceof Error, what);
      assert.equal(error.message, message, what);
      return true;
    }, what);
  }
});
