import './home-guard.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { runCli } from '../src/index.ts';

// `stratus setup`'s model picker on a ChatGPT sign-in: the account's own
// models (OpenAI's `GET /v1/models` on its token, behind `env.fetch`), a
// typed model that stays on ChatGPT, and `chatgpt:<model>`. Synthetic
// values only; nothing reaches the network.

const MODELS_URL = 'https://api.openai.com/v1/models';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';

/** OpenAI's model list for the signed-in account; anything else is a 404. */
const createFakeOpenAI = (options: { modelsStatus?: number } = {}) => {
  const sent: Array<{ url: string; authorization: string | null }> = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, authorization: new Headers(init?.headers).get('authorization') });
    if (url === MODELS_URL) {
      if (options.modelsStatus !== undefined && options.modelsStatus !== 200) {
        return new Response(JSON.stringify({ error: { message: 'The server had an error.' } }), { status: options.modelsStatus });
      }
      return new Response(JSON.stringify({
        models: [
          { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list' },
          { slug: 'gpt-5.5-mini', display_name: 'GPT-5.5 mini', visibility: 'list' },
          { slug: 'gpt-5.5-hidden', display_name: 'Hidden', visibility: 'hide' },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
  }) as typeof fetch;
  return { fetch: fakeFetch, sent, listed: () => sent.filter((request) => request.url === MODELS_URL) };
};

const createStreams = () => {
  let stdout = '';
  let stderr = '';
  return {
    streams: {
      stdout: { write(chunk: string) { stdout += chunk; return true; } },
      stderr: { write(chunk: string) { stderr += chunk; return true; } },
    },
    output: {
      get stdout() { return stdout; },
      get stderr() { return stderr; },
    },
  };
};

const stubServiceRunner = async (command: string, args: string[]) => ({
  code: 0,
  stdout: command === 'launchctl' && args[0] === 'print'
    ? '\tstate = running\n'
    : command === 'systemctl' && args.includes('is-active') ? 'active\n' : '',
  stderr: '',
});

const newHome = async (files: Record<string, unknown> = {}): Promise<string> => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-home-'));
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(path.join(home, '.stratus', name), JSON.stringify(contents));
  }
  return home;
};

const readConfig = async (home: string): Promise<any> =>
  JSON.parse(await readFile(path.join(home, '.stratus', 'config.json'), 'utf8'));

const signedIn = (overrides: object = {}) => ({
  hostId: 'urn:uuid:host-1',
  session: {
    clientId: 'oaiapp_issued123',
    subject: 'user-sub-1',
    email: 'person@example.com',
    idToken: 'synthetic-id-token',
    accessToken: 'synthetic-access-0',
    refreshToken: 'synthetic-refresh-0',
    expiresAt: Date.now() + 3_600_000,
    scopes: ['openid', PLAN_SCOPE],
    savedAt: Date.now(),
    ...overrides,
  },
});

const runSetup = async (home: string, openai: ReturnType<typeof createFakeOpenAI>, lines: string[]) => {
  const { streams, output } = createStreams();
  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: { DISPLAY: ':0' },
      serviceRunner: stubServiceRunner,
      fetch: openai.fetch,
      openExternal: () => assert.fail('choosing a model opens no browser'),
      setupInput: Readable.from(lines),
    },
  });
  assert.equal(exitCode, 0, output.stderr);
  assert.doesNotMatch(output.stdout + output.stderr, /synthetic-(access|refresh|id-token)/);
  return output;
};

// Models is menu 2: 1 chooses the default, 2 a fallback. Save & finish is 9.
const MODELS = '2\n';
const DEFAULT = '1\n';
const FALLBACK = '2\n';
const SAVE = '9\n';

test('the picker lists the ChatGPT account\'s models first, on its token, and choosing one makes it the default', async () => {
  const home = await newHome({
    'config.json': { provider: 'anthropic' },
    'credentials.json': { anthropic: { type: 'oauth_token', value: 'sk-ant-oat-synthetic' } },
    'chatgpt-sign-in.json': signedIn(),
  });
  const openai = createFakeOpenAI();

  const output = await runSetup(home, openai, [MODELS, DEFAULT, '2\n', SAVE]);

  assert.match(output.stdout, / 1\) gpt-5\.5 — chatgpt \(GPT-5\.5\)/);
  assert.match(output.stdout, / 2\) gpt-5\.5-mini — chatgpt \(GPT-5\.5 mini\)/);
  // Only what OpenAI marks to be shown; the Claude lineup follows.
  assert.doesNotMatch(output.stdout, /gpt-5\.5-hidden/);
  assert.match(output.stdout, / 3\) claude-opus-5-5 — anthropic/);
  assert.equal(openai.listed().length, 1);
  assert.equal(openai.listed()[0]?.authorization, 'Bearer synthetic-access-0');
  assert.match(output.stdout, /Default model set to gpt-5\.5-mini \(chatgpt\)\./);
  const config = await readConfig(home);
  assert.equal(config.provider, 'chatgpt');
  assert.equal(config.model, 'gpt-5.5-mini');
});

test('with chatgpt as the default, a typed model that isn\'t listed stays on ChatGPT, beside another sign-in', async () => {
  const home = await newHome({
    'config.json': { provider: 'chatgpt' },
    'credentials.json': { anthropic: { type: 'oauth_token', value: 'sk-ant-oat-synthetic' } },
    'chatgpt-sign-in.json': signedIn(),
  });
  const output = await runSetup(home, createFakeOpenAI(), [MODELS, DEFAULT, 'gpt-5.6-preview\n', SAVE]);

  assert.match(output.stdout, /Default model set to gpt-5\.6-preview \(chatgpt\)\./);
  const config = await readConfig(home);
  assert.equal(config.provider, 'chatgpt');
  assert.equal(config.model, 'gpt-5.6-preview');
});

test('a typed model both ChatGPT and Codex list goes to the default provider', async () => {
  const home = await newHome({
    'config.json': { provider: 'codex' },
    'credentials.json': { codex: { type: 'oauth_token', value: 'chatgpt' } },
    'chatgpt-sign-in.json': signedIn(),
  });
  const output = await runSetup(home, createFakeOpenAI(), [MODELS, DEFAULT, 'gpt-5.5\n', SAVE]);

  assert.match(output.stdout, /Default model set to gpt-5\.5 \(codex\)\./);
  const config = await readConfig(home);
  assert.equal(config.provider, 'codex');
  assert.equal(config.model, 'gpt-5.5');
});

test('chatgpt:<model> names a ChatGPT fallback, which is saved with its provider', async () => {
  const home = await newHome({
    'config.json': { provider: 'anthropic' },
    'credentials.json': { anthropic: { type: 'oauth_token', value: 'sk-ant-oat-synthetic' } },
    'chatgpt-sign-in.json': signedIn(),
  });
  const output = await runSetup(home, createFakeOpenAI(), [MODELS, FALLBACK, 'chatgpt:gpt-5.5-mini\n', SAVE]);

  assert.match(output.stdout, /Fallback model set to gpt-5\.5-mini \(chatgpt\)/);
  const config = await readConfig(home);
  assert.equal(config.provider, 'anthropic');
  assert.equal(config.fallbackProvider, 'chatgpt');
  assert.equal(config.fallbackModel, 'gpt-5.5-mini');
});

test('when OpenAI won\'t list the models, the picker says so and a model can still be typed', async () => {
  const home = await newHome({
    'config.json': { provider: 'chatgpt' },
    'chatgpt-sign-in.json': signedIn(),
  });
  const output = await runSetup(home, createFakeOpenAI({ modelsStatus: 500 }), [MODELS, DEFAULT, 'gpt-5.5\n', SAVE]);

  assert.match(output.stdout, /Couldn't list your ChatGPT account's models: .*The server had an error\./);
  assert.match(output.stdout, /Type a model id…/);
  assert.doesNotMatch(output.stdout, /No models available yet/);
  assert.match(output.stdout, /Default model set to gpt-5\.5 \(chatgpt\)\./);
  const config = await readConfig(home);
  assert.equal(config.provider, 'chatgpt');
  assert.equal(config.model, 'gpt-5.5');
});

test('a ChatGPT sign-in without plan usage lists no models and asks OpenAI for none', async () => {
  const home = await newHome({
    'config.json': { provider: 'anthropic' },
    'credentials.json': { anthropic: { type: 'oauth_token', value: 'sk-ant-oat-synthetic' } },
    'chatgpt-sign-in.json': signedIn({ scopes: ['openid', 'email'] }),
  });
  const openai = createFakeOpenAI();
  const output = await runSetup(home, openai, [MODELS, DEFAULT, '1\n', SAVE]);

  assert.equal(openai.listed().length, 0);
  assert.doesNotMatch(output.stdout, /— chatgpt|Couldn't list/);
  assert.match(output.stdout, /Default model set to claude-opus-5-5 \(anthropic\)\./);
});
