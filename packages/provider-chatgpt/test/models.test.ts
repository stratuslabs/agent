import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';

import { ResponsesApiError } from '@stratusagent/providers';
import { CHATGPT_USAGE_URL, ChatGPTAuthError, listChatGPTModels } from '../src/index.ts';

const MODELS_URL = 'https://api.openai.com/v1/models';

interface SentRequest {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const fakeFetch = (answer: (request: SentRequest) => Response | Promise<Response>) => {
  const sent: SentRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = { url: String(input), init };
    sent.push(request);
    return answer(request);
  }) as typeof fetch;
  return { fetch: fetchImpl, sent };
};

/** A fetch that answers only when its signal aborts, by rejecting the way fetch does. */
const hangingFetch = () =>
  fakeFetch(({ init }) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) {
        reject(new Error('test: no signal passed, the request could hang forever'));
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));

const token = (value = 'access-1') => async () => value;

test('lists the models meant to be shown, in the order OpenAI sent them', async () => {
  const { fetch, sent } = fakeFetch(() =>
    jsonResponse(200, {
      models: [
        { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list' },
        { slug: 'internal-eval', display_name: 'Internal', visibility: 'hide' },
        { slug: 'gpt-5.4-mini', display_name: 'GPT-5.4 mini', visibility: 'list' },
        { slug: 'gpt-5.5-pro', display_name: 'GPT-5.5 Pro', visibility: 'list' },
      ],
    }));

  const models = await listChatGPTModels({ accessToken: token(), fetch });

  assert.deepEqual(models, [
    { slug: 'gpt-5.5', displayName: 'GPT-5.5' },
    { slug: 'gpt-5.4-mini', displayName: 'GPT-5.4 mini' },
    { slug: 'gpt-5.5-pro', displayName: 'GPT-5.5 Pro' },
  ]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, MODELS_URL);
  assert.equal(sent[0]!.init?.method ?? 'GET', 'GET');
  const headers = new Headers(sent[0]!.init?.headers);
  assert.equal(headers.get('authorization'), 'Bearer access-1');
  assert.equal(headers.get('accept'), 'application/json');
});

test('skips entries it cannot offer, and shows the slug when there is no display name', async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse(200, {
      models: [
        'gpt-5.5',
        null,
        { display_name: 'No slug', visibility: 'list' },
        { slug: '', display_name: 'Empty slug', visibility: 'list' },
        { slug: 42, visibility: 'list' },
        { slug: 'no-visibility', display_name: 'No visibility' },
        { slug: 'gpt-5.5', visibility: 'list' },
        { slug: 'gpt-5.4', display_name: '  ', visibility: 'list' },
        { slug: 'gpt-5.4-mini', display_name: 7, visibility: 'list' },
      ],
    }));

  assert.deepEqual(await listChatGPTModels({ accessToken: token(), fetch }), [
    { slug: 'gpt-5.5', displayName: 'gpt-5.5' },
    { slug: 'gpt-5.4', displayName: 'gpt-5.4' },
    { slug: 'gpt-5.4-mini', displayName: 'gpt-5.4-mini' },
  ]);
});

test('an account with nothing to show lists nothing', async () => {
  const { fetch } = fakeFetch(() => jsonResponse(200, { models: [{ slug: 'hidden', visibility: 'hide' }] }));
  assert.deepEqual(await listChatGPTModels({ accessToken: token(), fetch }), []);
});

test('asks for the token with the caller\'s signal', async () => {
  const controller = new AbortController();
  const seen: (AbortSignal | undefined)[] = [];
  const { fetch } = fakeFetch(() => jsonResponse(200, { models: [] }));

  await listChatGPTModels({
    accessToken: async (signal) => {
      seen.push(signal);
      return 'access-1';
    },
    fetch,
    signal: controller.signal,
  });

  assert.deepEqual(seen, [controller.signal]);
});

test('a sign-in that can\'t hand out a token fails as the token source said, and sends nothing', async () => {
  const { fetch, sent } = fakeFetch(() => jsonResponse(200, { models: [] }));
  const ended = new ChatGPTAuthError('signin_required', 'Sign in with ChatGPT again.');

  await assert.rejects(
    listChatGPTModels({ accessToken: async () => { throw ended; }, fetch }),
    (error) => error === ended,
  );
  assert.equal(sent.length, 0);
});

test('a plan error says what to do, keeping OpenAI\'s text, the status and the request ID', async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse(
      429,
      { error: { message: 'Usage limit reached.', code: 'subscription_sharing_usage_limit_exceeded', param: null } },
      { 'x-request-id': 'req_limit' },
    ));

  await assert.rejects(listChatGPTModels({ accessToken: token(), fetch }), (error: unknown) => {
    assert.ok(error instanceof ResponsesApiError);
    assert.equal(error.status, 429);
    assert.equal(error.code, 'subscription_sharing_usage_limit_exceeded');
    assert.equal(error.requestId, 'req_limit');
    assert.match(error.message, /usage limit/);
    assert.ok(error.message.includes(CHATGPT_USAGE_URL));
    assert.match(error.message, /OpenAI: Usage limit reached\.; HTTP 429; request req_limit\)$/);
    return true;
  });
});

test('a refusal at admission says what to do, as it does for a turn', async () => {
  const { fetch } = fakeFetch(() => jsonResponse(401, { detail: 'identity not accepted' }, { 'x-request-id': 'req_adm' }));

  await assert.rejects(listChatGPTModels({ accessToken: token(), fetch }), (error: unknown) => {
    assert.ok(error instanceof ResponsesApiError);
    assert.equal(error.status, 401);
    assert.equal(error.code, undefined);
    assert.match(error.message, /^ChatGPT didn't accept this sign-in for plan usage\. Sign in with ChatGPT again/);
    assert.match(error.message, /identity not accepted/);
    assert.match(error.message, /HTTP 401; request req_adm\)$/);
    return true;
  });
});

test('any other refusal says the list failed, with what OpenAI said', async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse(404, { error: { message: 'Unknown route.', code: 'not_found' } }, { 'x-request-id': 'req_404' }));

  await assert.rejects(listChatGPTModels({ accessToken: token(), fetch }), (error: unknown) => {
    assert.ok(error instanceof ResponsesApiError);
    assert.equal(error.status, 404);
    assert.equal(error.code, 'not_found');
    assert.equal(error.message, "OpenAI didn't list the models for this ChatGPT account. (OpenAI: Unknown route.; HTTP 404; request req_404)");
    return true;
  });
});

test('a refusal that is not JSON is shown as it came, and never with the token in it', async () => {
  const { fetch } = fakeFetch(() => new Response('bad gateway for Bearer access-secret-9', { status: 502 }));

  await assert.rejects(listChatGPTModels({ accessToken: token('access-secret-9'), fetch }), (error: unknown) => {
    assert.ok(error instanceof ResponsesApiError);
    assert.equal(error.status, 502);
    assert.ok(!error.message.includes('access-secret-9'), error.message);
    assert.match(error.message, /bad gateway for Bearer \[redacted\]/);
    return true;
  });
});

test('a list that is not readable fails as a refused response', async () => {
  for (const body of ['not json', JSON.stringify({ data: [] }), JSON.stringify({ models: 'gpt-5.5' }), '']) {
    const { fetch } = fakeFetch(() => new Response(body, { status: 200 }));
    await assert.rejects(
      listChatGPTModels({ accessToken: token(), fetch }),
      (error: unknown) => error instanceof ChatGPTAuthError && error.code === 'request_failed' && /model list/.test(error.message),
      `body ${JSON.stringify(body)}`,
    );
  }
});

test('a request that can\'t reach OpenAI fails as temporary', async () => {
  const { fetch } = fakeFetch(() => {
    throw new TypeError('fetch failed');
  });

  await assert.rejects(
    listChatGPTModels({ accessToken: token(), fetch }),
    (error: unknown) => error instanceof ChatGPTAuthError && error.code === 'temporary' && /model list/.test(error.message),
  );
});

test('a request that fails quoting its authorization header doesn\'t carry the token, in the message or the cause', async () => {
  // Codex's case: a fetch (or a wrapper around it) whose error quotes the
  // request's header, here only the token in it.
  const quoting = fakeFetch(({ init }) => {
    const header = new Headers(init?.headers).get('authorization') ?? '';
    throw new TypeError(`could not send credential ${header.slice('Bearer '.length)}`);
  });
  await assert.rejects(listChatGPTModels({ accessToken: token('secret-access-1'), fetch: quoting.fetch }), (error: unknown) => {
    assert.ok(error instanceof ChatGPTAuthError);
    assert.equal(error.code, 'temporary');
    assert.match(error.message, /\[redacted\]/);
    assert.doesNotMatch(inspect(error, { depth: 10 }), /secret-access-1/);
    return true;
  });
});

test('Node\'s own fetch quotes a token it can\'t send, and the token comes out of that too', async () => {
  // A token with a character no header may hold (a damaged sign-in file).
  // Node's fetch refuses it before connecting, quoting the whole header;
  // the request goes to a closed local port in case it ever does connect.
  const local = (async (_input: string | URL | Request, init?: RequestInit) =>
    globalThis.fetch('http://127.0.0.1:9/', init)) as typeof fetch;
  await assert.rejects(listChatGPTModels({ accessToken: token('secret-access-1\nX'), fetch: local }), (error: unknown) => {
    assert.ok(error instanceof ChatGPTAuthError);
    assert.equal(error.code, 'temporary');
    assert.doesNotMatch(inspect(error, { depth: 10 }), /secret-access-1/);
    return true;
  });
});

test('a cancelled or timed-out request whose failure quotes the header keeps no token in the cause either', async () => {
  // A fetch wrapper that, once aborted, rejects quoting the request's header.
  const quotingOnAbort = () => fakeFetch(({ init }) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new Error(`aborted ${new Headers(init?.headers).get('authorization')}`));
      }, { once: true });
    }));

  const controller = new AbortController();
  const cancelled = listChatGPTModels({ accessToken: token('secret-access-1'), fetch: quotingOnAbort().fetch, signal: controller.signal, timeoutMs: 60_000 });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error('stopped'));
  await assert.rejects(cancelled, (error: unknown) => {
    assert.ok(error instanceof ChatGPTAuthError);
    assert.equal(error.code, 'cancelled');
    assert.doesNotMatch(inspect(error, { depth: 10 }), /secret-access-1/);
    return true;
  });

  await assert.rejects(listChatGPTModels({ accessToken: token('secret-access-1'), fetch: quotingOnAbort().fetch, timeoutMs: 20 }), (error: unknown) => {
    assert.ok(error instanceof ChatGPTAuthError);
    assert.equal(error.code, 'timeout');
    assert.doesNotMatch(inspect(error, { depth: 10 }), /secret-access-1/);
    return true;
  });
});

test('gives up after its timeout, and says so', async () => {
  const { fetch } = hangingFetch();
  const started = Date.now();

  await assert.rejects(
    listChatGPTModels({ accessToken: token(), fetch, timeoutMs: 1000 }),
    (error: unknown) =>
      error instanceof ChatGPTAuthError && error.code === 'timeout' && /didn't answer within 1 second\./.test(error.message),
  );
  const waited = Date.now() - started;
  assert.ok(waited >= 900 && waited < 5000, `waited ${waited} ms`);
});

test('a cancelled caller stops the request, and it is not called a timeout', async () => {
  const { fetch, sent } = hangingFetch();
  const controller = new AbortController();
  const listing = listChatGPTModels({ accessToken: token(), fetch, signal: controller.signal, timeoutMs: 60_000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  controller.abort(new Error('stopped'));

  await assert.rejects(listing, (error: unknown) => error instanceof ChatGPTAuthError && error.code === 'cancelled');
});
