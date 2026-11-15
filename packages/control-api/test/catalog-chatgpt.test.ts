import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { newHome, startApi } from './harness.ts';

// The dashboard's Models list (GET /catalog/models) offers the install's
// ChatGPT account's models next to the stored sign-ins', as setup's picker
// does: listed live for that account, on the token in
// ~/.stratus/chatgpt-sign-in.json, and only when that sign-in can serve a run.

const HOUR = 60 * 60 * 1000;
const MODELS_URL = 'https://api.openai.com/v1/models';

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

const homeWith = async (signIn?: object | string): Promise<string> => {
  const home = await newHome();
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  if (signIn !== undefined) {
    await writeFile(
      path.join(home, '.stratus', 'chatgpt-sign-in.json'),
      typeof signIn === 'string' ? signIn : JSON.stringify(signIn),
    );
  }
  return home;
};

const signedIn = (overrides: object = {}) => ({ hostId: 'urn:uuid:host-1', session: session(overrides) });

interface Sent {
  url: string;
  authorization: string | null;
}

/**
 * OpenAI as both callers see it. The ChatGPT account and an API key list
 * models at the same URL, so the answer goes by whose token asked: the
 * sign-in's gets the account's list (or `chatgpt`, when given), any other
 * bearer the platform's.
 */
const openAI = (sent: Sent[], chatgpt?: () => Promise<Response>) => (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const authorization = new Headers(init?.headers).get('authorization');
  sent.push({ url, authorization });
  if (url === MODELS_URL && authorization === 'Bearer access-secret-1') {
    if (chatgpt) {
      return chatgpt();
    }
    return new Response(JSON.stringify({
      models: [
        { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list' },
        { slug: 'gpt-5.5-mini', display_name: 'GPT-5.5 mini', visibility: 'list' },
        { slug: 'gpt-internal', display_name: 'Internal', visibility: 'hide' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url === MODELS_URL) {
    return new Response(JSON.stringify({ data: [{ id: 'gpt-4.1-mini' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response('{}', { status: 404 });
}) as typeof fetch;

const catalog = async (home: string, fetchImpl: typeof fetch, processEnv: NodeJS.ProcessEnv = {}) => {
  const harness = await startApi({ home, env: { processEnv: { STRATUS_PROVIDER: 'demo', ...processEnv }, fetch: fetchImpl } });
  try {
    const response = await harness.call('/api/v1/catalog/models');
    const text = await response.text();
    return { status: response.status, text, models: (JSON.parse(text) as { models: Array<{ provider: string; id: string }> }).models };
  } finally {
    await harness.stop();
  }
};

test('the model catalog lists the ChatGPT account\'s models first, on the sign-in file\'s token', async () => {
  const home = await homeWith(signedIn());
  const sent: Sent[] = [];
  const { status, models } = await catalog(home, openAI(sent), { OPENAI_API_KEY: 'sk-platform' });
  assert.equal(status, 200);
  assert.deepEqual(models, [
    { provider: 'chatgpt', id: 'gpt-5.5' },
    { provider: 'chatgpt', id: 'gpt-5.5-mini' },
    { provider: 'openai', id: 'gpt-4.1-mini' },
  ]);
  // Each list went out on its own credential: the account's on the sign-in's
  // token, the platform's on the key.
  assert.deepEqual(
    sent.map((request) => request.authorization).sort(),
    ['Bearer access-secret-1', 'Bearer sk-platform'],
  );
});

test('a chatgpt default lists the account\'s models too', async () => {
  const home = await homeWith(signedIn());
  await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'chatgpt', model: 'gpt-5.5' }));
  const sent: Sent[] = [];
  const harness = await startApi({ home, env: { processEnv: {}, fetch: openAI(sent) } });
  try {
    const { models } = await (await harness.call('/api/v1/catalog/models')).json() as { models: unknown[] };
    assert.deepEqual(models, [
      { provider: 'chatgpt', id: 'gpt-5.5' },
      { provider: 'chatgpt', id: 'gpt-5.5-mini' },
    ]);
  } finally {
    await harness.stop();
  }
});

for (const [name, signIn] of [
  ['no sign-in', undefined],
  ['a signed-out account (tokens cleared)', signedIn({ accessToken: undefined, refreshToken: undefined })],
  ['a sign-in that did not allow plan usage', signedIn({ scopes: ['openid'] })],
] as const) {
  test(`${name} lists no ChatGPT models and sends nothing for them`, async () => {
    const home = await homeWith(signIn);
    const sent: Sent[] = [];
    const { status, models } = await catalog(home, openAI(sent));
    assert.equal(status, 200);
    assert.deepEqual(models, []);
    assert.deepEqual(sent, []);
  });
}

test('an unreadable sign-in file leaves ChatGPT out and still lists the rest', async () => {
  const home = await homeWith('[not a sign-in');
  const sent: Sent[] = [];
  const { status, models } = await catalog(home, openAI(sent), { OPENAI_API_KEY: 'sk-platform' });
  assert.equal(status, 200);
  assert.deepEqual(models, [{ provider: 'openai', id: 'gpt-4.1-mini' }]);
});

for (const [name, answer] of [
  ['a refused listing', async () => new Response('{"error":{"message":"nope"}}', { status: 403 })],
  ['a server error', async () => new Response('upstream broke', { status: 502 })],
  ['a network failure', async () => { throw new TypeError('fetch failed: Bearer access-secret-1'); }],
] as const) {
  test(`${name} leaves ChatGPT out, still lists the rest, and puts no token in the answer`, async () => {
    const home = await homeWith(signedIn());
    const sent: Sent[] = [];
    const { status, models, text } = await catalog(home, openAI(sent, answer), { OPENAI_API_KEY: 'sk-platform' });
    assert.equal(status, 200);
    assert.deepEqual(models, [{ provider: 'openai', id: 'gpt-4.1-mini' }]);
    assert.ok(!text.includes('access-secret'), text);
    assert.ok(sent.some((request) => request.authorization === 'Bearer access-secret-1'), 'the account was asked');
  });
}
