import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { StratusEvent } from '@stratusagent/core';
import { apiTokensPath, createApiToken, revokeApiToken, type StateEnvironment } from '@stratusagent/state';

import { createAuthenticator, SESSION_COOKIE, tokenFingerprint } from '../src/auth.ts';
import { routes } from '../src/routes.ts';
import { openSocket, settles, startApi, type Harness } from './harness.ts';

const envOf = (harness: Harness): StateEnvironment => ({ homeDir: harness.home, cwd: harness.home, processEnv: {} });

/** A member token, created the way `stratus token create` creates one: straight into the file. */
const createMember = async (harness: Harness, name = 'alice'): Promise<{ token: string; id: string }> => {
  const { token, record } = await createApiToken(envOf(harness), { name });
  return { token, id: record.id };
};

const asMember = (harness: Harness, token: string, pathname: string, init: RequestInit = {}): Promise<Response> =>
  harness.call(pathname, {
    ...init,
    auth: 'none',
    headers: { authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) },
  });

const errorCode = async (response: Response): Promise<string | undefined> =>
  ((await response.json()) as { error?: { code?: string } }).error?.code;

/** A browser session minted through the member's own one-time token. */
const memberCookie = async (harness: Harness, token: string): Promise<string> => {
  const minted = await asMember(harness, token, '/api/v1/auth/ott', { method: 'POST' });
  assert.equal(minted.status, 200, 'a member may lend a browser its own authority');
  const { url } = await minted.json() as { url: string };
  const exchanged = await fetch(url, { redirect: 'manual' });
  assert.equal(exchanged.status, 302);
  return (exchanged.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
};

test('every route has an explicit role decision, so a new one cannot become a member\'s by default', () => {
  // The whole table, both halves. A route added without `member: true`
  // lands in the operator half and fails this until someone decides; one
  // flagged without thought lands in the member half and fails it too.
  const expected: Record<string, 'member' | 'operator'> = {
    'POST /api/v1/auth/ott': 'member',
    'GET /api/v1/auth/session': 'member',
    'GET /api/v1/health': 'member',
    'GET /api/v1/agents': 'member',
    'GET /api/v1/agents/:id': 'member',
    'POST /api/v1/agents': 'member',
    'PUT /api/v1/agents/:id': 'member',
    'POST /api/v1/roster/reload': 'member',
    'POST /api/v1/skills/reload': 'member',
    'POST /api/v1/restart': 'operator',
    'GET /api/v1/sessions': 'member',
    'GET /api/v1/sessions/:id': 'member',
    'POST /api/v1/sessions/:id/messages': 'member',
    'POST /api/v1/sessions/:id/rollover': 'member',
    'GET /api/v1/agents/:id/grants': 'member',
    'POST /api/v1/agents/:id/grants/revoke': 'member',
    'GET /api/v1/approvals': 'member',
    'POST /api/v1/approvals': 'member',
    'GET /api/v1/schedules': 'member',
    'DELETE /api/v1/schedules/:id': 'member',
    'GET /api/v1/catalog/models': 'member',
    'GET /api/v1/catalog/tools': 'member',
    'GET /api/v1/credentials': 'member',
    'POST /api/v1/credentials/verify': 'operator',
    'PUT /api/v1/credentials/:provider': 'operator',
    'PUT /api/v1/credentials/channels/:channel': 'member',
    'POST /api/v1/credentials/named': 'member',
    'GET /api/v1/config': 'member',
    'PUT /api/v1/config': 'operator',
  };
  const actual = Object.fromEntries(
    routes.map((route) => [`${route.method} ${route.pattern}`, route.member === true ? 'member' : 'operator']),
  );
  assert.deepEqual(actual, expected);
});

test('a member token is accepted for conversations: sessions, messages, and the event stream', async () => {
  const harness = await startApi();
  const member = await createMember(harness);
  const client = await openSocket(`${harness.url.replace('http', 'ws')}/api/v1/events`, {
    headers: { authorization: `Bearer ${member.token}` },
  });
  try {
    assert.equal(client.opened, true, 'the event stream accepts a member');
    await client.waitFor((frame) => frame.type === 'subscribed', 'the subscribe ack');

    const accepted = await asMember(harness, member.token, '/api/v1/sessions/m-1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello', agentId: 'stratus' }),
    });
    assert.equal(accepted.status, 202);
    await client.waitFor(
      (frame) => (frame.event as StratusEvent | undefined)?.type === 'session.completed',
      'the member\'s own turn completing on its stream',
    );

    assert.equal((await asMember(harness, member.token, '/api/v1/sessions')).status, 200);
    assert.equal((await asMember(harness, member.token, '/api/v1/sessions/m-1')).status, 200);
    assert.equal((await asMember(harness, member.token, '/api/v1/config')).status, 200, 'a member reads the policy');
  } finally {
    client.close();
    await harness.stop();
  }
});

test('a member is refused the routes that rewrite the operator\'s policy, and nothing is written', async () => {
  const harness = await startApi();
  const member = await createMember(harness);
  try {
    const refused: Array<[string, string, Record<string, unknown>]> = [
      ['PUT', '/api/v1/config', { config: { baseUrl: 'https://attacker.example' } }],
      ['PUT', '/api/v1/credentials/anthropic', { type: 'api_key', value: 'sk-member', baseUrl: 'https://attacker.example' }],
      ['POST', '/api/v1/restart', {}],
      ['POST', '/api/v1/credentials/verify', { provider: 'openai', key: 'k', baseUrl: 'http://169.254.169.254' }],
    ];
    for (const [method, pathname, body] of refused) {
      const response = await asMember(harness, member.token, pathname, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 403, `${method} ${pathname}`);
      const payload = await response.json() as { error: { code: string; message: string } };
      assert.equal(payload.error.code, 'operator_required', `${method} ${pathname}`);
      assert.match(payload.error.message, /operator token from ~\/\.stratus\/gateway-token/);
    }
    // Refused before the handler ran: no config and no sign-in were written,
    // and the daemon is still serving.
    await assert.rejects(readFile(path.join(harness.home, '.stratus', 'config.json'), 'utf8'), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(harness.home, '.stratus', 'credentials.json'), 'utf8'), { code: 'ENOENT' });
    assert.equal((await harness.call('/api/v1/health')).status, 200);

    // The operator token is unchanged by any of this.
    const operator = await harness.call('/api/v1/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: { model: 'gpt-4.1-mini' } }),
    });
    assert.equal(operator.status, 200);
  } finally {
    await harness.stop();
  }
});

test('a revoked member token is refused on its next request, with no restart', async () => {
  const harness = await startApi();
  const member = await createMember(harness);
  const other = await createMember(harness, 'bob');
  try {
    assert.equal((await asMember(harness, member.token, '/api/v1/health')).status, 200);
    await revokeApiToken(envOf(harness), member.id);
    const after = await asMember(harness, member.token, '/api/v1/health');
    assert.equal(after.status, 401);
    assert.equal(await errorCode(after), 'unauthorized');
    // Only that one: another member and the operator carry on.
    assert.equal((await asMember(harness, other.token, '/api/v1/health')).status, 200);
    assert.equal((await harness.call('/api/v1/health')).status, 200);
  } finally {
    await harness.stop();
  }
});

test('a session minted from a member\'s one-time token is a member, and dies with the token', async () => {
  const harness = await startApi();
  const member = await createMember(harness);
  try {
    const cookie = await memberCookie(harness, member.token);
    const origin = harness.url;
    assert.equal((await harness.call('/api/v1/sessions', { auth: 'cookie', cookie })).status, 200);

    // The browser does not climb to operator.
    const config = await harness.call('/api/v1/config', {
      method: 'PUT',
      auth: 'cookie',
      cookie,
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ config: { model: 'x' } }),
    });
    assert.equal(config.status, 403);
    assert.equal(await errorCode(config), 'operator_required');

    await revokeApiToken(envOf(harness), 'alice');
    assert.equal((await harness.call('/api/v1/sessions', { auth: 'cookie', cookie })).status, 401);
    // And stays dead: re-creating a token under the same name is a new id,
    // not a revival of the sessions the old one vouched for.
    await createMember(harness, 'alice');
    assert.equal((await harness.call('/api/v1/sessions', { auth: 'cookie', cookie })).status, 401);
  } finally {
    await harness.stop();
  }
});

test('a member\'s open event stream is closed when its token is revoked', async () => {
  const harness = await startApi();
  const member = await createMember(harness);
  const client = await openSocket(`${harness.url.replace('http', 'ws')}/api/v1/events`, {
    headers: { authorization: `Bearer ${member.token}` },
  });
  try {
    assert.equal(client.opened, true);
    await client.waitFor((frame) => frame.type === 'subscribed', 'the subscribe ack');
    const closed = new Promise<number>((resolve) => {
      client.socket.once('close', (code) => resolve(code));
    });
    await revokeApiToken(envOf(harness), member.id);
    assert.equal(await settles(closed, 'the revoked member\'s stream closing'), 1008);
  } finally {
    client.close();
    await harness.stop();
  }
});

test('a member\'s approval is recorded under its token name, not a label it chose', async () => {
  const harness = await startApi({ approvals: true });
  const transport = harness.transport;
  assert.ok(transport);
  const member = await createMember(harness);
  try {
    const requested = new Promise<string>((resolve) => {
      const off = harness.gateway.bus.subscribe((event) => {
        if (event.type === 'tool.approval-requested') {
          off();
          resolve(event.requestId);
        }
      });
    });
    const answer = transport.request({
      session: {
        id: 'sess-member',
        agent: { id: 'stratus', name: 'Stratus' },
        status: 'running',
        messages: [],
        createdAt: '2026-09-29T00:00:00.000Z',
        updatedAt: '2026-09-29T00:00:00.000Z',
      },
      call: { id: 'call-1', toolName: 'shell.run', input: { command: 'ls' } },
      risk: 'gated',
    });
    const requestId = await settles(requested, 'the approval request');
    const resolved = await asMember(harness, member.token, '/api/v1/approvals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId, answer: 'once', actor: 'the-operator' }),
    });
    assert.equal(resolved.status, 200);
    assert.deepEqual(await settles(answer, 'the parked call'), { answer: 'once', actor: 'api:alice' });
  } finally {
    await harness.stop();
  }
});

test('an unreadable token file refuses every member and never the operator', async () => {
  const harness = await startApi();
  const member = await createMember(harness);
  try {
    await writeFile(apiTokensPath(envOf(harness)), 'not json');
    assert.equal((await asMember(harness, member.token, '/api/v1/health')).status, 401);
    assert.equal((await harness.call('/api/v1/health')).status, 200);
  } finally {
    await harness.stop();
  }
});

test('a member session crosses a restart as a member, one of unknown role is dropped, and a pre-role one is the operator\'s', async () => {
  const records = [{ id: 'tok_0123456789ab', name: 'alice', role: 'member' as const, hash: 'a'.repeat(64), createdAt: '2026-09-29T00:00:00.000Z' }];
  const before = createAuthenticator({ token: 'gateway-token', memberTokens: async () => records });
  const minted = before.redeemOneTimeToken(
    await before.mintOneTimeToken({ role: 'member', tokenId: 'tok_0123456789ab', tokenName: 'alice' }),
  );
  assert.ok(minted);
  const handed = before.exportSessions();
  assert.deepEqual(handed.map(({ role, tokenId, tokenName, vouchedBy }) => ({ role, tokenId, tokenName, vouchedBy })), [
    { role: 'member', tokenId: 'tok_0123456789ab', tokenName: 'alice', vouchedBy: 'a'.repeat(16) },
  ]);

  const after = createAuthenticator({ token: 'gateway-token', memberTokens: async () => records });
  const expiresAt = Date.now() + 60_000;
  after.adoptSessions([
    ...handed,
    // A role from some future build is never read as more than it says.
    { id: 'from-the-future', expiresAt, vouchedBy: 'x', role: 'admin' as unknown as 'member' },
    // A build before roles had one token, the operator's.
    { id: 'pre-role', expiresAt, vouchedBy: tokenFingerprint('gateway-token') },
  ]);
  assert.equal(after.sessionCount(), 2);
  assert.deepEqual(await after.authenticate({ headers: { cookie: `${SESSION_COOKIE}=${minted}` } }), {
    kind: 'cookie', sessionId: minted, role: 'member', tokenId: 'tok_0123456789ab', tokenName: 'alice',
  });
  assert.deepEqual(await after.authenticate({ headers: { cookie: `${SESSION_COOKIE}=pre-role` } }), {
    kind: 'cookie', sessionId: 'pre-role', role: 'operator',
  });

  // Revoked in the file between the two processes: judged on first use.
  records.length = 0;
  assert.equal(await after.authenticate({ headers: { cookie: `${SESSION_COOKIE}=${minted}` } }), undefined);
});
