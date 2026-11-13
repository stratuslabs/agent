import test from 'node:test';
import assert from 'node:assert/strict';

import { chatgptSignInStatus, describeChatGPTSignIn } from '../src/index.ts';

// What `stratus doctor` may say about the saved ChatGPT sign-in: whose it
// is, whether it can use the plan, and when its access token runs out.
// Never a token, so the summary carries none of them.

const session = (overrides: object = {}) => ({
  clientId: 'oaiapp_issued123',
  subject: 'user-sub-1',
  email: 'person@example.com',
  idToken: 'id-secret-1',
  accessToken: 'access-secret-1',
  refreshToken: 'refresh-secret-1',
  expiresAt: 4_102_444_800_000,
  scopes: ['openid', 'chatgpt.tokens.use.direct'],
  savedAt: 1_700_000_000_000,
  ...overrides,
});

const fileHolding = (document: Record<string, unknown> | undefined) => ({ read: async () => document });

test('a ready sign-in is described by account and expiry, with no token in it', async () => {
  const summary = await describeChatGPTSignIn(fileHolding({ hostId: 'urn:uuid:host-1', session: session() }));
  assert.deepEqual(summary, { status: 'ready', account: 'person@example.com', expiresAt: 4_102_444_800_000 });
  assert.doesNotMatch(JSON.stringify(summary), /secret/);
});

test('an account without an email is named by its subject', async () => {
  const summary = await describeChatGPTSignIn(fileHolding({ session: session({ email: undefined }) }));
  assert.equal(summary.account, 'user-sub-1');
  const blank = await describeChatGPTSignIn(fileHolding({ session: session({ email: '' }) }));
  assert.equal(blank.account, 'user-sub-1');
});

test('a sign-in without plan usage keeps its account and expiry', async () => {
  const summary = await describeChatGPTSignIn(fileHolding({ session: session({ scopes: ['openid', 'email'] }) }));
  assert.deepEqual(summary, { status: 'plan_usage_not_granted', account: 'person@example.com', expiresAt: 4_102_444_800_000 });
});

test('a signed-out record names its account and has no expiry', async () => {
  // Sign-out (or a refused refresh) clears the tokens and keeps the account.
  const summary = await describeChatGPTSignIn(fileHolding({
    session: session({ idToken: undefined, accessToken: undefined, refreshToken: undefined }),
  }));
  assert.deepEqual(summary, { status: 'none', account: 'person@example.com' });
});

test('no file, no session or a session that is not an object is not signed in, with no account', async () => {
  for (const document of [undefined, { hostId: 'urn:uuid:host-1' }, { session: 'person@example.com' }, { session: [session()] }]) {
    assert.deepEqual(await describeChatGPTSignIn(fileHolding(document)), { status: 'none' });
  }
});

test('an expiry that is not a finite number is left out', async () => {
  for (const expiresAt of ['4102444800000', Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
    const summary = await describeChatGPTSignIn(fileHolding({ session: session({ expiresAt }) }));
    assert.equal(summary.status, 'ready');
    assert.equal('expiresAt' in summary, false, `expiresAt ${String(expiresAt)} was kept`);
  }
});

test('the summary\'s status is the status a run is resolved by', async () => {
  const variants = [
    session(),
    session({ clientId: undefined }),
    session({ subject: '' }),
    session({ accessToken: undefined }),
    session({ refreshToken: '' }),
    session({ scopes: undefined }),
    session({ scopes: ['openid'] }),
    session({ scopes: 'chatgpt.tokens.use.direct' }),
    undefined,
  ];
  for (const value of variants) {
    const file = fileHolding(value === undefined ? {} : { session: value });
    assert.equal((await describeChatGPTSignIn(file)).status, await chatgptSignInStatus(file));
  }
});

test('a file that cannot be read throws, as read does', async () => {
  const broken = { read: async () => { throw new Error('not a JSON object'); } };
  await assert.rejects(describeChatGPTSignIn(broken), /not a JSON object/);
});
