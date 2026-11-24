import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ProviderRequest } from '@stratusagent/core';
import {
  type RuntimeConfig,
  CHATGPT_PLAN_SCOPE,
  DEFAULT_CHATGPT_MODEL,
  hasChatGPTSignIn,
  PROVIDER_PACKAGE_NAMES,
  createRuntimeProvider,
  openChatGPTSignInFile,
  parseProviderName,
  providerPackagesUsedBy,
  resolveRuntimeConfig,
} from '../src/index.ts';

// `provider: chatgpt` runs on the install's ChatGPT sign-in, kept in
// ~/.stratus/chatgpt-sign-in.json: resolution carries where that file is,
// never a token, and the provider reads and refreshes the tokens there.

const HOUR = 60 * 60 * 1000;

const homeWith = async (options: { config?: object; signIn?: object | string; credentials?: object } = {}): Promise<string> => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-chatgpt-runtime-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  if (options.config) {
    await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify(options.config));
  }
  if (options.credentials) {
    await writeFile(path.join(home, '.stratus', 'credentials.json'), JSON.stringify(options.credentials));
  }
  if (options.signIn !== undefined) {
    await writeFile(
      path.join(home, '.stratus', 'chatgpt-sign-in.json'),
      typeof options.signIn === 'string' ? options.signIn : JSON.stringify(options.signIn),
    );
  }
  return home;
};

const session = (overrides: object = {}) => ({
  clientId: 'oaiapp_issued123',
  subject: 'user-sub-1',
  email: 'person@example.com',
  accessToken: 'access-secret-1',
  refreshToken: 'refresh-secret-1',
  expiresAt: Date.now() + HOUR,
  scopes: ['openid', 'chatgpt.tokens.use.direct'],
  savedAt: Date.now(),
  ...overrides,
});

const signedIn = (overrides: object = {}) => ({ hostId: 'urn:uuid:host-1', session: session(overrides) });

// Every variant but demo's can carry a fallback.
const fallbackOf = (config: RuntimeConfig) => ('fallback' in config ? config.fallback : undefined);

const envFor = (home: string, processEnv: NodeJS.ProcessEnv = {}) => ({ homeDir: home, cwd: home, processEnv });

test('chatgpt is a built-in provider name, not a plugin\'s', () => {
  assert.equal(parseProviderName('chatgpt', 'test'), 'chatgpt');
});

test('a chatgpt runtime resolves to where the sign-in is, with no token in it', async () => {
  const home = await homeWith({ config: { provider: 'chatgpt' }, signIn: signedIn() });
  const resolved = await resolveRuntimeConfig({}, envFor(home));
  assert.equal(resolved.provider, 'chatgpt');
  assert.ok(resolved.provider === 'chatgpt');
  assert.equal(resolved.model, DEFAULT_CHATGPT_MODEL);
  assert.deepEqual(resolved.signIn, {
    path: path.join(home, '.stratus', 'chatgpt-sign-in.json'),
    lockPath: path.join(home, '.stratus', 'chatgpt-sign-in.lock'),
  });
  const serialized = JSON.stringify(resolved);
  assert.ok(!serialized.includes('secret'), 'no token may ride in the runtime config');

  const named = await resolveRuntimeConfig({ model: 'gpt-5.4' }, envFor(home));
  assert.equal(named.provider === 'chatgpt' && named.model, 'gpt-5.4');
});

test('a chatgpt runtime reads no API key from the environment or the credentials file', async () => {
  const home = await homeWith({
    config: { provider: 'chatgpt' },
    signIn: signedIn(),
    credentials: { openai: { type: 'api_key', value: 'sk-stored-openai' }, anthropic: { type: 'api_key', value: 'sk-stored-anthropic' } },
  });
  const resolved = await resolveRuntimeConfig({}, envFor(home, {
    STRATUS_API_KEY: 'sk-env-generic',
    OPENAI_API_KEY: 'sk-env-openai',
    ANTHROPIC_API_KEY: 'sk-env-anthropic',
  }));
  assert.equal(resolved.provider, 'chatgpt');
  assert.ok(!/sk-/.test(JSON.stringify(resolved)), 'a chatgpt run carries no key');
});

test('provider chatgpt with no sign-in, or a sign-in that ended, refuses with where to sign in', async () => {
  const none = await homeWith({ config: { provider: 'chatgpt' } });
  await assert.rejects(() => resolveRuntimeConfig({}, envFor(none)), /Missing sign-in for provider=chatgpt\. Sign in with ChatGPT in `stratus setup`/);

  // A refused refresh clears the tokens and keeps the account.
  const ended = await homeWith({
    config: { provider: 'chatgpt' },
    signIn: signedIn({ accessToken: undefined, refreshToken: undefined, expiresAt: undefined }),
  });
  await assert.rejects(() => resolveRuntimeConfig({}, envFor(ended)), /Missing sign-in for provider=chatgpt/);

  // Tokens without the account they were issued to aren't a sign-in.
  const noAccount = await homeWith({ config: { provider: 'chatgpt' }, signIn: signedIn({ clientId: '' }) });
  await assert.rejects(() => resolveRuntimeConfig({}, envFor(noAccount)), /Missing sign-in for provider=chatgpt/);

  // Nor is half a pair: the provider needs both tokens, so a run on one
  // would only fail on its first turn.
  for (const half of [{ accessToken: undefined }, { refreshToken: undefined }]) {
    const damaged = await homeWith({ config: { provider: 'chatgpt' }, signIn: signedIn(half) });
    await assert.rejects(() => resolveRuntimeConfig({}, envFor(damaged)), /Missing sign-in for provider=chatgpt/);
  }

  // A sign-in that doesn't allow using the plan is refused in the provider's
  // own words, before the run rather than on its first turn.
  const noPlan = await homeWith({ config: { provider: 'chatgpt' }, signIn: signedIn({ scopes: ['openid'] }) });
  await assert.rejects(
    () => resolveRuntimeConfig({}, envFor(noPlan)),
    /doesn't allow Stratus Agent to use your ChatGPT plan\. Sign in with ChatGPT again in `stratus setup` and allow it/,
  );

  // A file that isn't a sign-in says so, without quoting it.
  const garbled = await homeWith({ config: { provider: 'chatgpt' }, signIn: '{"session": "access-secret-1' });
  await assert.rejects(
    () => resolveRuntimeConfig({}, envFor(garbled)),
    (error: Error) => /is not valid JSON/.test(error.message) && !error.message.includes('secret'),
  );
});

test('a chatgpt run refuses any base URL: the sign-in goes only to OpenAI', async () => {
  const home = await homeWith({ config: { provider: 'chatgpt' }, signIn: signedIn() });
  await assert.rejects(
    () => resolveRuntimeConfig({ baseUrl: 'https://proxy.local/v1' }, envFor(home)),
    /provider=chatgpt does not use a custom base URL.*proxy\.local/,
  );
  await assert.rejects(
    () => resolveRuntimeConfig({}, envFor(home, { STRATUS_BASE_URL: 'https://proxy.local/v1' })),
    /provider=chatgpt does not use a custom base URL/,
  );
  const configured = await homeWith({ config: { provider: 'chatgpt', baseUrl: 'https://proxy.local/v1' }, signIn: signedIn() });
  await assert.rejects(() => resolveRuntimeConfig({}, envFor(configured)), /provider=chatgpt does not use a custom base URL/);

  // A base URL written for another provider's config doesn't apply to a
  // chatgpt run that a flag selected, so it doesn't refuse it.
  const otherProvider = await homeWith({ config: { provider: 'openai', baseUrl: 'https://proxy.local/v1' }, signIn: signedIn() });
  const resolved = await resolveRuntimeConfig({ provider: 'chatgpt' }, envFor(otherProvider));
  assert.equal(resolved.provider, 'chatgpt');
});

test('a chatgpt fallback stands on the sign-in file, and is left out without one', async () => {
  const config = { provider: 'anthropic', fallbackProvider: 'chatgpt', fallbackModel: 'gpt-5.4' };
  const credentials = { anthropic: { type: 'api_key', value: 'sk-ant-primary' } };

  const withSignIn = await homeWith({ config, credentials, signIn: signedIn() });
  const resolved = await resolveRuntimeConfig({}, envFor(withSignIn, { ANTHROPIC_API_KEY: 'sk-ant-env' }));
  assert.deepEqual(fallbackOf(resolved), {
    provider: 'chatgpt',
    model: 'gpt-5.4',
    signIn: {
      path: path.join(withSignIn, '.stratus', 'chatgpt-sign-in.json'),
      lockPath: path.join(withSignIn, '.stratus', 'chatgpt-sign-in.lock'),
    },
  });

  const without = await homeWith({ config, credentials });
  assert.equal(fallbackOf(await resolveRuntimeConfig({}, envFor(without))), undefined);
  const half = await homeWith({ config, credentials, signIn: signedIn({ refreshToken: undefined }) });
  assert.equal(fallbackOf(await resolveRuntimeConfig({}, envFor(half))), undefined);
  const noPlan = await homeWith({ config, credentials, signIn: signedIn({ scopes: ['openid'] }) });
  assert.equal(fallbackOf(await resolveRuntimeConfig({}, envFor(noPlan))), undefined);

  // An unreadable file leaves the fallback out rather than failing the run.
  const garbled = await homeWith({ config, credentials, signIn: 'not json' });
  const rescued = await resolveRuntimeConfig({}, envFor(garbled));
  assert.equal(rescued.provider, 'anthropic');
  assert.equal(rescued.fallback, undefined);
});

test('a chatgpt primary keeps a fallback on another provider\'s own sign-in', async () => {
  const home = await homeWith({
    config: { provider: 'chatgpt', fallbackProvider: 'anthropic', fallbackModel: 'claude-sonnet-4-6' },
    credentials: { anthropic: { type: 'api_key', value: 'sk-ant-fallback' } },
    signIn: signedIn(),
  });
  const resolved = await resolveRuntimeConfig({}, envFor(home));
  assert.equal(resolved.provider, 'chatgpt');
  assert.equal(resolved.fallback?.provider, 'anthropic');
  assert.equal(resolved.fallback?.apiKey, 'sk-ant-fallback');

  // Implicit (no fallbackProvider): written for chatgpt, a chatgpt fallback.
  const implicit = await homeWith({ config: { provider: 'chatgpt', fallbackModel: 'gpt-5.4-mini' }, signIn: signedIn() });
  const same = await resolveRuntimeConfig({}, envFor(implicit));
  assert.equal(fallbackOf(same)?.provider, 'chatgpt');
  assert.equal(fallbackOf(same)?.model, 'gpt-5.4-mini');
});

test('resolution accepts exactly the sign-ins provider-chatgpt\'s token source serves', async () => {
  const chatgpt = await import('@stratusagent/provider-chatgpt');
  assert.equal(CHATGPT_PLAN_SCOPE, chatgpt.CHATGPT_PLAN_SCOPE);
  const variants: Record<string, object | undefined> = {
    complete: session(),
    'no client ID': session({ clientId: undefined }),
    'empty client ID': session({ clientId: '' }),
    'no subject': session({ subject: undefined }),
    'no access token': session({ accessToken: undefined }),
    'no refresh token': session({ refreshToken: undefined }),
    'empty refresh token': session({ refreshToken: '' }),
    'no scopes': session({ scopes: undefined }),
    'scopes without plan usage': session({ scopes: ['openid', 'email'] }),
    'scopes not a list': session({ scopes: 'chatgpt.tokens.use.direct' }),
    'no session': undefined,
  };
  for (const [name, value] of Object.entries(variants)) {
    const document = { read: async () => (value === undefined ? { hostId: 'urn:uuid:host-1' } : { hostId: 'urn:uuid:host-1', session: value }) };
    const source = chatgpt.createChatGPTTokenSource({
      endpoints: discovery as never,
      store: chatgpt.createChatGPTSessionStore({ ...document, write: async () => undefined }),
      withSessionLock: (work) => work(),
    });
    const served = await source.accessToken(undefined).then(() => true, () => false);
    assert.equal(await hasChatGPTSignIn(document), served, `${name}: resolution and the token source disagree`);
  }
});

test('providerPackagesUsedBy names provider-chatgpt for a chatgpt runtime or fallback', () => {
  const signIn = { path: '/h/.stratus/chatgpt-sign-in.json', lockPath: '/h/.stratus/chatgpt-sign-in.lock' };
  assert.deepEqual(providerPackagesUsedBy({ provider: 'chatgpt', model: 'gpt-5.5', signIn }), ['chatgpt']);
  assert.deepEqual(
    providerPackagesUsedBy({ provider: 'anthropic', model: 'm', apiKey: 'k', fallback: { provider: 'chatgpt', model: 'gpt-5.5', signIn } }),
    ['anthropic', 'chatgpt'],
  );
  assert.equal(PROVIDER_PACKAGE_NAMES.chatgpt, '@stratusagent/provider-chatgpt');
});

// ---- the provider a chatgpt runtime builds --------------------------------

const encoder = new TextEncoder();
const sse = (events: readonly object[]): Response =>
  new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });

const completed = (text: string) => ({
  type: 'response.completed',
  response: {
    id: 'resp_1',
    status: 'completed',
    model: 'gpt-5.5',
    output: [{ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }],
    usage: { input_tokens: 10, output_tokens: 2 },
  },
});

const ISSUER = 'https://auth.openai.com';

const discovery = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/oauth/authorize`,
  token_endpoint: `${ISSUER}/oauth/token`,
  revocation_endpoint: `${ISSUER}/oauth/revoke`,
  jwks_uri: `${ISSUER}/.well-known/jwks.json`,
};

const helloRequest = (): ProviderRequest => {
  const now = new Date().toISOString();
  return {
    session: {
      id: 'session-1',
      agent: { id: 'agent-1', name: 'Kernel' },
      status: 'running',
      messages: [{ id: 'session-1:user:1', role: 'user', content: 'Say hello', createdAt: now }],
      createdAt: now,
      updatedAt: now,
    },
    tools: [{ name: 'fs.read' }],
  };
};

interface Sent {
  url: string;
  authorization: string | null;
  body: string;
}

const recordingFetch = (sent: Sent[], refreshed?: { access: string; refresh: string }) =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : '';
    sent.push({ url, authorization: headers.get('authorization'), body });
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return new Response(JSON.stringify(discovery), { headers: { 'content-type': 'application/json' } });
    }
    if (url === discovery.token_endpoint && refreshed) {
      return new Response(JSON.stringify({
        access_token: refreshed.access,
        refresh_token: refreshed.refresh,
        token_type: 'Bearer',
        expires_in: 3600,
      }), { headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://api.openai.com/v1/responses') {
      return sse([completed('Hello from ChatGPT')]);
    }
    return new Response('unexpected', { status: 500 });
  }) as typeof fetch;

test('a chatgpt runtime builds a provider that runs a turn on the sign-in\'s token', async () => {
  const home = await homeWith({ config: { provider: 'chatgpt' }, signIn: signedIn() });
  const sent: Sent[] = [];
  const resolved = await resolveRuntimeConfig({}, { ...envFor(home), fetch: recordingFetch(sent) });
  const provider = createRuntimeProvider(resolved);
  assert.equal(provider.name, 'chatgpt');

  const response = await provider.generate(helloRequest());
  assert.equal(response.parts.map((part) => (part as { text?: string }).text ?? '').join(''), 'Hello from ChatGPT');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.url, 'https://api.openai.com/v1/responses');
  assert.equal(sent[0]?.authorization, 'Bearer access-secret-1');
  const body = JSON.parse(sent[0]?.body ?? '{}') as { model?: string; tools?: Array<{ type?: string; name?: string }> };
  assert.equal(body.model, DEFAULT_CHATGPT_MODEL);
  // Sign in with ChatGPT takes function tools only inside a namespace.
  assert.equal(body.tools?.[0]?.type, 'namespace');
});

test('a chatgpt runtime refreshes a token due to expire in the sign-in file, under its lock', async () => {
  const signInPath = (home: string) => path.join(home, '.stratus', 'chatgpt-sign-in.json');
  const home = await homeWith({ config: { provider: 'chatgpt' }, signIn: signedIn({ expiresAt: Date.now() + 60_000 }) });
  const sent: Sent[] = [];
  const resolved = await resolveRuntimeConfig({}, { ...envFor(home), fetch: recordingFetch(sent, { access: 'access-secret-2', refresh: 'refresh-secret-2' }) });
  const provider = createRuntimeProvider(resolved);

  await provider.generate(helloRequest());
  const refresh = sent.find((request) => request.url === discovery.token_endpoint);
  assert.ok(refresh, 'a token inside its last five minutes is refreshed first');
  assert.equal(new URLSearchParams(refresh.body).get('refresh_token'), 'refresh-secret-1');
  assert.equal(sent.at(-1)?.authorization, 'Bearer access-secret-2');

  const saved = JSON.parse(await readFile(signInPath(home), 'utf8')) as { hostId: string; session: { refreshToken: string } };
  assert.equal(saved.session.refreshToken, 'refresh-secret-2', 'the replacement refresh token reaches the file');
  assert.equal(saved.hostId, 'urn:uuid:host-1');
});

test('a chatgpt runtime waits for a write already holding the sign-in lock, and runs on what it saved', async () => {
  const home = await homeWith({ config: { provider: 'chatgpt' }, signIn: signedIn({ expiresAt: Date.now() + 60_000 }) });
  const sent: Sent[] = [];
  const resolved = await resolveRuntimeConfig({}, { ...envFor(home), fetch: recordingFetch(sent, { access: 'access-wrong', refresh: 'refresh-wrong' }) });
  assert.ok(resolved.provider === 'chatgpt');
  // Another writer (a refresh in a CLI run, say) holds the lock and saves a
  // fresh token. The turn's refresh must wait for it, read the file again
  // inside the lock, and find nothing left to do.
  const file = openChatGPTSignInFile(resolved.signIn);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const otherWriter = file.withLock(async () => {
    await held;
    await file.write(signedIn({ accessToken: 'access-secret-3', refreshToken: 'refresh-secret-3', expiresAt: Date.now() + HOUR }));
  });
  const turn = createRuntimeProvider(resolved).generate(helloRequest());
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(sent.filter((request) => request.url !== `${ISSUER}/.well-known/openid-configuration`), [], 'nothing is sent while the lock is held');
  release();
  await Promise.all([otherWriter, turn]);
  assert.equal(sent.find((request) => request.url === discovery.token_endpoint), undefined, 'no second refresh');
  assert.equal(sent.at(-1)?.authorization, 'Bearer access-secret-3');
});

test('a chatgpt provider whose sign-in ends after resolution fails the turn with where to sign in', async () => {
  const home = await homeWith({ config: { provider: 'chatgpt' }, signIn: signedIn() });
  const resolved = await resolveRuntimeConfig({}, { ...envFor(home), fetch: recordingFetch([]) });
  // Signed out from another process between resolution and the turn.
  await writeFile(path.join(home, '.stratus', 'chatgpt-sign-in.json'), JSON.stringify({ hostId: 'urn:uuid:host-1' }));
  await assert.rejects(() => createRuntimeProvider(resolved).generate(helloRequest()), /not signed in with ChatGPT/);
});
