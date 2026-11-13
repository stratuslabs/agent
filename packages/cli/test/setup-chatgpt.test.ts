import './home-guard.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type JsonWebKey } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { CHATGPT_ISSUER, DYNAMIC_CLIENT_ID } from '@stratusagent/provider-chatgpt';
import { packageResolvable } from '@stratusagent/state';

import { runCli } from '../src/index.ts';

// `stratus setup`'s "Continue with ChatGPT" and sign-out, end to end through
// provider-chatgpt's real flows: a real loopback callback, a fake OpenAI
// behind `env.fetch`, and a fake browser behind `env.openExternal`.
// Synthetic values only; nothing reaches the network.

const ISSUED_CLIENT_ID = 'oaiapp_issued123';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const FULL_SCOPE = `${PLAN_SCOPE} email offline_access openid profile resource.invoke`;
const PACKAGE = '@stratusagent/provider-chatgpt';

const endpoints = {
  authorizationEndpoint: `${CHATGPT_ISSUER}/api/accounts/authorize`,
  tokenEndpoint: `${CHATGPT_ISSUER}/api/accounts/oauth/token`,
  revocationEndpoint: `${CHATGPT_ISSUER}/api/accounts/oauth/revoke`,
  jwksUri: `${CHATGPT_ISSUER}/.well-known/jwks.json`,
};

const signingKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publishedKey: JsonWebKey = { ...signingKey.publicKey.export({ format: 'jwk' }), kid: 'key-1', use: 'sig', alg: 'RS256' };
const segment = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const signJwt = (claims: Record<string, unknown>): string => {
  const head = segment({ alg: 'RS256', kid: 'key-1', typ: 'JWT' });
  const body = segment(claims);
  return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), signingKey.privateKey).toString('base64url')}`;
};

/** OpenAI's side: discovery, keys, tokens and revocation. */
const createFakeOpenAI = (options: { scope?: string; email?: string; revokeStatus?: number } = {}) => {
  const requests: Array<{ url: string; form: URLSearchParams }> = [];
  let lastAuthorize: URL | undefined;
  let issued = 0;
  const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    requests.push({ url, form });
    if (url === `${CHATGPT_ISSUER}/.well-known/openid-configuration`) {
      return json(200, {
        issuer: CHATGPT_ISSUER,
        authorization_endpoint: endpoints.authorizationEndpoint,
        token_endpoint: endpoints.tokenEndpoint,
        revocation_endpoint: endpoints.revocationEndpoint,
        jwks_uri: endpoints.jwksUri,
      });
    }
    if (url === endpoints.jwksUri) {
      return json(200, { keys: [publishedKey] });
    }
    if (url === endpoints.tokenEndpoint) {
      assert.ok(lastAuthorize, 'a code was exchanged before the browser came back');
      issued += 1;
      const now = Math.floor(Date.now() / 1000);
      return json(200, {
        access_token: `synthetic-access-${issued}`,
        refresh_token: `synthetic-refresh-${issued}`,
        id_token: signJwt({
          iss: CHATGPT_ISSUER,
          aud: form.get('client_id') ?? '',
          sub: 'user-sub-1',
          email: options.email ?? 'person@example.com',
          nonce: lastAuthorize.searchParams.get('nonce'),
          iat: now,
          exp: now + 3600,
        }),
        token_type: 'Bearer',
        expires_in: 3600,
        scope: options.scope ?? FULL_SCOPE,
      });
    }
    if (url === endpoints.revocationEndpoint) {
      return json(options.revokeStatus ?? 200, {});
    }
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
  return {
    fetch: fakeFetch,
    sent: (endpoint: string) => requests.filter((request) => request.url === endpoint),
    authorized: (url: URL) => {
      lastAuthorize = url;
    },
  };
};

/** The person's browser: opens the authorize URL and comes back to the loopback callback with a code. */
const browser = (openai: ReturnType<typeof createFakeOpenAI>) => {
  const opened: URL[] = [];
  const visit = async (url: string): Promise<void> => {
    const authorize = new URL(url);
    opened.push(authorize);
    openai.authorized(authorize);
    const callback = new URL(authorize.searchParams.get('redirect_uri') ?? '');
    callback.search = new URLSearchParams({
      state: authorize.searchParams.get('state') ?? '',
      code: 'auth-code-1',
      ...(authorize.searchParams.get('client_id') === DYNAMIC_CLIENT_ID ? { client_id: ISSUED_CLIENT_ID } : {}),
    }).toString();
    await (await fetch(callback)).text();
  };
  return { visit, opened };
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

const readJson = async (home: string, name: string): Promise<any> =>
  JSON.parse(await readFile(path.join(home, '.stratus', name), 'utf8'));

const signedInSession = () => ({
  clientId: ISSUED_CLIENT_ID,
  subject: 'user-sub-1',
  email: 'person@example.com',
  idToken: 'synthetic-id-token',
  accessToken: 'synthetic-access-0',
  refreshToken: 'synthetic-refresh-0',
  expiresAt: Date.now() + 3_600_000,
  scopes: ['openid', PLAN_SCOPE],
  savedAt: Date.now(),
});

const noTokensIn = (text: string): void => {
  assert.doesNotMatch(text, /synthetic-(access|refresh|id-token)/);
  assert.doesNotMatch(text, /id_token_hint/);
};

// Providers is menu 1; ChatGPT is its fourth row; Save & finish is 9.
const PROVIDERS = '1\n';
const CHATGPT = '4\n';
const SAVE = '9\n';

test('setup signs in with ChatGPT in the browser, saves the sign-in and makes chatgpt the default', async () => {
  const home = await newHome();
  const openai = createFakeOpenAI();
  const person = browser(openai);
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
      openExternal: person.visit,
      setupInput: Readable.from([PROVIDERS, CHATGPT, '1\n', SAVE]),
    },
  });

  assert.equal(exitCode, 0, output.stderr);
  assert.match(output.stdout, /ChatGPT — not signed in/);
  assert.match(output.stdout, /Continue with ChatGPT/);
  assert.match(output.stdout, /Opened your browser to sign in with ChatGPT/);
  assert.match(output.stdout, /✓ Signed in with ChatGPT as person@example\.com\./);
  assert.equal(person.opened.length, 1);
  assert.equal(person.opened[0]?.origin, CHATGPT_ISSUER);
  // A browser opened, so the link isn't printed.
  assert.doesNotMatch(output.stdout, /auth\.openai\.com\/api\/accounts\/authorize/);
  assert.equal(openai.sent(endpoints.tokenEndpoint).length, 1);

  const saved = await readJson(home, 'chatgpt-sign-in.json');
  assert.match(saved.hostId, /^urn:uuid:/);
  assert.equal(saved.session.clientId, ISSUED_CLIENT_ID);
  assert.equal(saved.session.email, 'person@example.com');
  assert.equal(saved.session.accessToken, 'synthetic-access-1');
  assert.ok(saved.session.scopes.includes(PLAN_SCOPE));
  assert.equal((await readJson(home, 'config.json')).provider, 'chatgpt');
  assert.match(output.stdout, /Providers {12}chatgpt \(ChatGPT sign-in\)/);
  assert.match(output.stdout, /You are signed in with ChatGPT as person@example\.com — ready to go/);
  noTokensIn(output.stdout + output.stderr);
});

test('a ChatGPT sign-in that does not allow plan usage is saved, says so, and is not made the default', async () => {
  const home = await newHome();
  const openai = createFakeOpenAI({ scope: 'email offline_access openid profile' });
  const person = browser(openai);
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
      openExternal: person.visit,
      setupInput: Readable.from([PROVIDERS, CHATGPT, '1\n', SAVE]),
    },
  });

  assert.equal(exitCode, 0, output.stderr);
  assert.match(output.stdout, /Signed in with ChatGPT as person@example\.com, but you didn't allow Stratus Agent to use your ChatGPT plan/);
  assert.notEqual((await readJson(home, 'config.json')).provider, 'chatgpt');
  assert.equal((await readJson(home, 'chatgpt-sign-in.json')).session.accessToken, 'synthetic-access-1');
});

test('over SSH, setup prints the sign-in link and how to forward the callback port instead of opening a browser', async () => {
  const home = await newHome();
  const openai = createFakeOpenAI();
  const person = browser(openai);
  const { streams, output } = createStreams();
  let openedHere = 0;

  const setup = runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: { SSH_CONNECTION: '10.0.0.2 52000 10.0.0.1 22' },
      serviceRunner: stubServiceRunner,
      fetch: openai.fetch,
      openExternal: () => {
        openedHere += 1;
      },
      setupInput: Readable.from([PROVIDERS, CHATGPT, '1\n', SAVE]),
    },
  });

  // The person copies the link from the terminal into a browser elsewhere.
  let link: string | undefined;
  for (let waited = 0; link === undefined && waited < 10_000; waited += 20) {
    link = /(https:\/\/auth\.openai\.com\/api\/accounts\/authorize\S+)/.exec(output.stdout)?.[1];
    if (link === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.ok(link, `no sign-in link printed:\n${output.stdout}`);
  const port = new URL(new URL(link).searchParams.get('redirect_uri') ?? '').port;
  assert.match(output.stdout, new RegExp(`ssh -L ${port}:127\\.0\\.0\\.1:${port}`));
  await person.visit(link);

  assert.equal(await setup, 0, output.stderr);
  assert.equal(openedHere, 0);
  assert.match(output.stdout, /✓ Signed in with ChatGPT as person@example\.com\./);
});

test('when the browser cannot be opened, setup prints the link and the sign-in still completes from it', async () => {
  const home = await newHome();
  const openai = createFakeOpenAI();
  const person = browser(openai);
  const { streams, output } = createStreams();
  let printedLink: string | undefined;

  const exitCode = await runCli({
    argv: ['setup'],
    streams,
    env: {
      cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
      homeDir: home,
      processEnv: { DISPLAY: ':0' },
      serviceRunner: stubServiceRunner,
      fetch: openai.fetch,
      openExternal: () => {
        // Visit what setup printed after this failure, as a person would.
        setTimeout(() => {
          printedLink = /(https:\/\/auth\.openai\.com\/api\/accounts\/authorize\S+)/.exec(output.stdout)?.[1];
          void person.visit(printedLink ?? 'https://missing.invalid/?redirect_uri=http://127.0.0.1:1/');
        }, 50);
        throw new Error('spawn xdg-open ENOENT');
      },
      setupInput: Readable.from([PROVIDERS, CHATGPT, '1\n', SAVE]),
    },
  });

  assert.equal(exitCode, 0, output.stderr);
  assert.ok(printedLink, `no sign-in link printed:\n${output.stdout}`);
  assert.match(output.stdout, /Couldn't open a browser here \(spawn xdg-open ENOENT\)/);
  assert.match(output.stdout, /✓ Signed in with ChatGPT as person@example\.com\./);
});

test('setup signs out of ChatGPT: revokes, clears the tokens, keeps the account and says the default needs a sign-in', async () => {
  const home = await newHome({
    'config.json': { provider: 'chatgpt' },
    'chatgpt-sign-in.json': { hostId: 'urn:uuid:host-1', session: signedInSession() },
  });
  const openai = createFakeOpenAI();
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
      openExternal: () => assert.fail('signing out opens no browser'),
      setupInput: Readable.from([PROVIDERS, CHATGPT, '2\n', SAVE]),
    },
  });

  assert.equal(exitCode, 0, output.stderr);
  assert.match(output.stdout, /ChatGPT — signed in as person@example\.com/);
  assert.match(output.stdout, /Signed out of ChatGPT \(person@example\.com\)\./);
  assert.match(output.stdout, /chatgpt is still your default provider/);
  const revoked = openai.sent(endpoints.revocationEndpoint);
  assert.equal(revoked.length, 1);
  assert.equal(revoked[0]?.form.get('token'), 'synthetic-refresh-0');

  const saved = await readJson(home, 'chatgpt-sign-in.json');
  assert.equal(saved.hostId, 'urn:uuid:host-1');
  assert.equal(saved.session.clientId, ISSUED_CLIENT_ID);
  assert.equal(saved.session.email, 'person@example.com');
  assert.equal(saved.session.accessToken, undefined);
  assert.equal(saved.session.refreshToken, undefined);
  assert.equal(saved.session.idToken, undefined);
  // Nothing changed the default behind the person's back, and the end of
  // setup doesn't call it ready.
  assert.equal((await readJson(home, 'config.json')).provider, 'chatgpt');
  assert.match(output.stdout, /You are NOT signed in with ChatGPT yet/);
  assert.doesNotMatch(output.stdout, /ready to go/);
  noTokensIn(output.stdout + output.stderr);
});

test('a sign-out OpenAI does not confirm still clears the tokens and says where to disconnect the app', async () => {
  const home = await newHome({
    'chatgpt-sign-in.json': { hostId: 'urn:uuid:host-1', session: signedInSession() },
  });
  const openai = createFakeOpenAI({ revokeStatus: 400 });
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
      setupInput: Readable.from([PROVIDERS, CHATGPT, '2\n', SAVE]),
    },
  });

  assert.equal(exitCode, 0, output.stderr);
  assert.match(output.stdout, /OpenAI didn't confirm it ended the sign-in/);
  assert.match(output.stdout, /chatgpt\.com/);
  assert.equal((await readJson(home, 'chatgpt-sign-in.json')).session.refreshToken, undefined);
});

test('after a sign-out, setup offers the saved account again and signs it back in with its issued client', async () => {
  const { accessToken: _a, refreshToken: _r, idToken: _i, expiresAt: _e, ...account } = signedInSession();
  const home = await newHome({ 'chatgpt-sign-in.json': { hostId: 'urn:uuid:host-1', session: account } });
  const openai = createFakeOpenAI();
  const person = browser(openai);
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
      openExternal: person.visit,
      setupInput: Readable.from([PROVIDERS, CHATGPT, '1\n', SAVE]),
    },
  });

  assert.equal(exitCode, 0, output.stderr);
  assert.match(output.stdout, /ChatGPT — signed out \(person@example\.com\)/);
  assert.match(output.stdout, /Continue with ChatGPT as person@example\.com/);
  assert.match(output.stdout, /Use a different ChatGPT account/);
  assert.equal(person.opened[0]?.searchParams.get('client_id'), ISSUED_CLIENT_ID);
  assert.equal((await readJson(home, 'chatgpt-sign-in.json')).session.accessToken, 'synthetic-access-1');
});

test('setup installs the ChatGPT provider package before signing in when it is missing, and stops if that fails', async () => {
  const run = async (installOk: boolean) => {
    const home = await newHome();
    const openai = createFakeOpenAI();
    const person = browser(openai);
    const { streams, output } = createStreams();
    const installs: string[][] = [];
    let installed = false;
    const exitCode = await runCli({
      argv: ['setup'],
      streams,
      env: {
        cwd: await mkdtemp(path.join(os.tmpdir(), 'stratus-setup-')),
        homeDir: home,
        processEnv: { DISPLAY: ':0' },
        serviceRunner: stubServiceRunner,
        fetch: openai.fetch,
        openExternal: person.visit,
        packageResolver: (specifier) =>
          specifier === PACKAGE ? installed : packageResolvable(specifier, import.meta.url, import.meta.resolve),
        packageInstaller: async (specifiers) => {
          installs.push([...specifiers]);
          installed = installOk;
          return { ok: installOk, message: installOk ? '' : 'npm ERR! 403' };
        },
        setupInput: Readable.from([PROVIDERS, CHATGPT, '1\n', SAVE]),
      },
    });
    return { exitCode, output, installs, person, home };
  };

  const ok = await run(true);
  assert.match(ok.output.stdout, /Running: npm install -g @stratusagent\/provider-chatgpt@/);
  assert.equal(ok.installs[0]?.[0]?.startsWith(`${PACKAGE}@`), true);
  assert.match(ok.output.stdout, /✓ Signed in with ChatGPT as person@example\.com\./);

  const failed = await run(false);
  assert.equal(failed.person.opened.length, 0);
  assert.match(failed.output.stdout, /Signing in with ChatGPT needs @stratusagent\/provider-chatgpt/);
  assert.doesNotMatch(failed.output.stdout, /Signed in with ChatGPT/);
});
