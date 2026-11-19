import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { StratusEvent } from '@stratusagent/core';
import { createGateway } from '@stratusagent/gateway';

import { CREDENTIAL_LINK_TTL_MS, createCredentialLinkStore, credentialLinkRefusal } from '../src/credential-links.ts';
import { createControlApi } from '../src/index.ts';

const openAiText = (text: string): Response =>
  new Response(
    JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const openAiToolCall = (name: string, args: object): Response =>
  new Response(
    JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(args) } }],
        },
      }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

/**
 * A daemon serving the control API as its channel, the way `stratus serve`
 * runs it, whose model asks for a credential once and then answers in words.
 */
const startLinking = async (request: object = { name: 'github.token', reason: 'To open <b>pull requests</b>.' }) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-api-credlink-'));
  const agentsDir = path.join(home, '.stratus', 'agents');
  await mkdir(agentsDir, { recursive: true });
  const soulFile = path.join(agentsDir, 'kai.md');
  // A link needs a tools: list naming credential.request; "*" names it.
  await writeFile(soulFile, '---\nname: Kai\nprovider: openai\nmodel: model-a\ntools: ["*"]\n---\n\nYou are Kai.\n');
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return calls === 1 ? openAiToolCall('credential_request', request) : openAiText('asked');
  }) as typeof fetch;
  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const api = createControlApi({ env, port: 0, publicUrl: 'https://mac-mini.example.ts.net/' });
  const gateway = createGateway({ env, idleTimeoutMs: 0, log: () => {}, warn: () => {}, channels: [api] });
  const events: StratusEvent[] = [];
  gateway.bus.subscribe(async (event) => {
    events.push(event);
  });
  await gateway.start();
  return { home, soulFile, gateway, api, events };
};

/** The link the agent was handed, and the same path on the address this test can reach. */
const linkFrom = (session: Awaited<ReturnType<ReturnType<typeof createGateway>['dispatch']>>, bound: string) => {
  const output = session.messages.find((message) => message.role === 'tool')?.toolResult?.output as { link?: string } | undefined;
  assert.ok(output?.link, 'the agent was handed a link');
  const link = new URL(output.link);
  return { link: output.link, local: `${bound}${link.pathname}` };
};

test('a request no channel can show a form for gets a one-time link that adds the key and grants it', async () => {
  const { home, soulFile, gateway, api, events } = await startLinking();
  try {
    // No channel started this turn, so there is nowhere to show a form.
    const session = await gateway.dispatch({ sessionId: 'kai-link-1', agentId: 'kai', userMessage: 'open a PR' });
    const { link, local } = linkFrom(session, api.url ?? '');
    assert.match(link, /^https:\/\/mac-mini\.example\.ts\.net\/api\/v1\/credential-links\/[A-Za-z0-9_-]{55}$/, 'built on api.publicUrl');
    const output = JSON.stringify(session.messages.find((message) => message.role === 'tool')?.toolResult?.output);
    assert.match(output, /not in a channel that can show your operator a form/);
    assert.match(output, /works once, and expires at/);
    assert.match(output, /Anyone holding it can add the key/);
    const requested = events.find((event) => event.type === 'credential.requested');
    assert.equal(requested?.type === 'credential.requested' ? requested.via : undefined, 'link');

    // Opening it shows the request, escaped, and spends nothing.
    const page = await fetch(local);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'.*frame-ancestors 'none'/);
    const html = await page.text();
    assert.match(html, /<strong>Kai<\/strong> is asking for <code>github\.token<\/code>, for Kai only\./);
    assert.match(html, /To open &lt;b&gt;pull requests&lt;\/b&gt;\./);
    assert.doesNotMatch(html, /<b>pull requests<\/b>/);
    assert.equal((await fetch(local)).status, 200, 'a second look still has a form');

    // An empty value is refused beside the field, and the link stays good.
    const empty = await fetch(local, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'value=' });
    assert.equal(empty.status, 400);
    assert.match(await empty.text(), /empty/);

    const added = await fetch(local, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ value: 'ghp-secret-value' }).toString(),
    });
    assert.equal(added.status, 200);
    assert.match(await added.text(), /Added github\.token for Kai\. Kai can use it from its next reply/);

    const credentials = JSON.parse(await readFile(path.join(home, '.stratus', 'credentials.json'), 'utf8')) as {
      named?: { agents?: Record<string, Record<string, string>> };
    };
    assert.equal(credentials.named?.agents?.kai?.['github.token'], 'ghp-secret-value');
    assert.match(await readFile(soulFile, 'utf8'), /^credentials:\n {2}- github\.token$/m);
    const provided = events.find((event) => event.type === 'credential.provided');
    assert.equal(provided?.type === 'credential.provided' ? provided.actor : undefined, 'link');

    // Spent: the link answers once, and says so rather than guessing.
    const spent = await fetch(local);
    assert.equal(spent.status, 404);
    const spentPage = await spent.text();
    assert.match(spentPage, /This link was already used, at \d{4}-\d\d-\d\dT[\d:.]+Z\. A link works once\./);
    assert.doesNotMatch(spentPage, /expired/);
    const again = await fetch(local, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'value=ghp-other' });
    assert.equal(again.status, 404);
    assert.match(await again.text(), /This link was already used/);

    // The value is nowhere but the credential store.
    assert.doesNotMatch(JSON.stringify([await gateway.store.get('kai-link-1'), events]), /ghp-secret-value/);
  } finally {
    await gateway.stop();
  }
});

test('a link for a key in a variable says the agent\'s shell will read it, and answering binds it', async () => {
  const { home, gateway, api } = await startLinking({ name: 'twilio.authToken', env: 'TWILIO_AUTH_TOKEN' });
  try {
    const session = await gateway.dispatch({ sessionId: 'kai-link-env', agentId: 'kai', userMessage: 'set up cnam' });
    const { local } = linkFrom(session, api.url ?? '');
    const html = await (await fetch(local)).text();
    assert.match(html, /Kai's shell commands will be able to read this as <code>TWILIO_AUTH_TOKEN<\/code>, so Kai can see the value\./);

    const added = await fetch(local, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ value: 'tw-secret' }).toString(),
    });
    assert.equal(added.status, 200);
    assert.match(await added.text(), /Kai can use it from its next reply, and its shell commands read it as TWILIO_AUTH_TOKEN\./);
    const credentials = JSON.parse(await readFile(path.join(home, '.stratus', 'credentials.json'), 'utf8')) as {
      envBindings?: { agents?: Record<string, Record<string, string>> };
    };
    assert.deepEqual(credentials.envBindings?.agents, { kai: { TWILIO_AUTH_TOKEN: 'twilio.authToken' } });
  } finally {
    await gateway.stop();
  }
});

/** A PEM-shaped value, assembled so nothing here looks like a committed key; the body is base64 of a sentence. */
const PEM_LABEL = ['PRIVATE', 'KEY'].join(' ');
const PEM = [
  `-----BEGIN ${PEM_LABEL}-----`,
  'bm90IGEga2V5LCBqdXN0IGEgdGVzdCBvZiBsaW5lIGJyZWFrcyBpbiBhIHN0b3Jl',
  'ZCBjcmVkZW50aWFsIHZhbHVlLCB3cmFwcGVkIGF0IHNpeHR5LWZvdXI=',
  `-----END ${PEM_LABEL}-----`,
].join('\n');

test('a link keeps a multi-line key whole: a masked text area, and the browser\'s line breaks stored as the file\'s', async () => {
  const { home, gateway, api } = await startLinking({ name: 'github.appKey' });
  try {
    const session = await gateway.dispatch({ sessionId: 'kai-link-pem', agentId: 'kai', userMessage: 'set up the app' });
    const { local } = linkFrom(session, api.url ?? '');
    const html = await (await fetch(local)).text();
    // A password input strips line breaks from whatever is pasted into it,
    // so the field is a text area, masked the way a password field is.
    const field = html.match(/<textarea id="value" name="value"[^>]*>/)?.[0];
    assert.ok(field, 'the value is a text area');
    assert.match(field, /autocomplete="off"/);
    assert.match(field, /spellcheck="false"/);
    assert.match(field, / required/);
    assert.doesNotMatch(html, /<input id="value"/);
    assert.match(html, /textarea\{[^}]*-webkit-text-security:disc/);

    // A flattened key is refused beside the field, and the link stays good.
    const flattened = await fetch(local, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ value: PEM.replace(/\n/g, ' ') }).toString(),
    });
    assert.equal(flattened.status, 400);
    assert.match(await flattened.text(), /line breaks were lost/);
    assert.equal((await fetch(local)).status, 200);

    // A browser submits a text area's line breaks as CRLF, whatever was
    // pasted; the key file had LF, and LF is what is stored.
    const added = await fetch(local, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ value: `${PEM.replace(/\n/g, '\r\n')}\r\n` }).toString(),
    });
    assert.equal(added.status, 200);
    const credentials = JSON.parse(await readFile(path.join(home, '.stratus', 'credentials.json'), 'utf8')) as {
      named?: { agents?: Record<string, Record<string, string>> };
    };
    assert.equal(credentials.named?.agents?.kai?.['github.appKey'], PEM);
  } finally {
    await gateway.stop();
  }
});

test('a link whose request can no longer be answered is spent with the reason', async () => {
  const { soulFile, gateway, api } = await startLinking();
  try {
    const session = await gateway.dispatch({ sessionId: 'kai-link-2', agentId: 'kai', userMessage: 'go' });
    const { local } = linkFrom(session, api.url ?? '');
    // The soul went to another agent while the link waited.
    await writeFile(soulFile, '---\nname: Bea\nid: bea\nprovider: openai\nmodel: model-a\n---\n\nYou are Bea.\n');
    const refused = await fetch(local, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'value=ghp-1' });
    assert.equal(refused.status, 409);
    assert.match(await refused.text(), /now belongs to bea, not kai, so nothing was stored/);
    const closed = await fetch(local);
    assert.equal(closed.status, 404, 'no form left for an answer that cannot land');
    assert.match(await closed.text(), /This link was closed at [\d\-T:.]+Z, because its request could no longer be answered\./);
  } finally {
    await gateway.stop();
  }
});

const KAI_REQUEST = { requestId: 'r1', agentId: 'kai', agentName: 'Kai', name: 'github.token', scope: 'agent' } as const;

test('a link token stops opening its form once its time is up, and says when it expired', () => {
  let at = 1_000;
  const links = createCredentialLinkStore({ now: () => at, ttlMs: 60_000 });
  const { token, expiresAt } = links.mint(KAI_REQUEST);
  assert.equal(expiresAt, 61_000);
  assert.equal(links.get(token)?.requestId, 'r1');
  at = 61_000;
  assert.equal(links.get(token), undefined);
  assert.deepEqual(links.refusal(token), { reason: 'expired', at: 61_000 });
  assert.equal(links.get('not-a-token'), undefined);
});

test('a refused link token gets the real reason: used, closed, from before a restart, or not recognized', () => {
  let at = 5_000;
  const links = createCredentialLinkStore({ now: () => at });
  const used = links.mint(KAI_REQUEST).token;
  const closed = links.mint({ ...KAI_REQUEST, requestId: 'r2' }).token;
  at = 6_000;
  links.retire(used, 'used');
  at = 7_000;
  links.retire(closed, 'closed');
  assert.equal(links.get(used), undefined);
  assert.deepEqual(links.refusal(used), { reason: 'used', at: 6_000 });
  assert.deepEqual(links.refusal(closed), { reason: 'closed', at: 7_000 });
  // A second submission that lost the race to the first: still used.
  links.retire(used, 'closed');
  assert.deepEqual(links.refusal(used), { reason: 'used', at: 6_000 });
  // An answer that landed as the link ran out: used, not expired.
  const late = links.mint({ ...KAI_REQUEST, requestId: 'r4' }).token;
  at += CREDENTIAL_LINK_TTL_MS;
  assert.equal(links.get(late), undefined);
  links.retire(late, 'used');
  assert.deepEqual(links.refusal(late), { reason: 'used', at });

  // Another daemon's link, or this one's before it restarted: the store is
  // in memory, so a link never outlives the process that issued it.
  const before = createCredentialLinkStore().mint(KAI_REQUEST).token;
  assert.equal(links.get(before), undefined);
  assert.deepEqual(links.refusal(before), { reason: 'restarted' });
  // A link from a build before the check: it can't be told from one cut
  // short, so it isn't claimed to be a restart.
  assert.deepEqual(links.refusal('A'.repeat(43)), { reason: 'unrecognized' });
  assert.deepEqual(links.refusal('A'.repeat(55)), { reason: 'unrecognized' });

  // Cut short, run on, or reformatted in a chat app.
  const live = links.mint({ ...KAI_REQUEST, requestId: 'r3' }).token;
  assert.deepEqual(links.refusal(live.slice(0, -1)), { reason: 'unrecognized' });
  assert.deepEqual(links.refusal(live.slice(0, -4)), { reason: 'unrecognized' }, 'cut by the length of the check');
  assert.deepEqual(links.refusal(live.slice(0, -12)), { reason: 'unrecognized' }, 'cut to the length of an old token');
  assert.deepEqual(links.refusal(`${live[0] === 'A' ? 'B' : 'A'}${live.slice(1)}`), { reason: 'unrecognized' }, 'its run id changed');
  assert.deepEqual(links.refusal(`${before[0] === 'A' ? 'B' : 'A'}${before.slice(1)}`), { reason: 'unrecognized' }, 'another run\'s, changed');
  assert.deepEqual(links.refusal(`${live}>`), { reason: 'unrecognized' });
  assert.deepEqual(links.refusal(`${live.slice(0, -1)}${live.endsWith('A') ? 'B' : 'A'}`), { reason: 'unrecognized' });
  assert.deepEqual(links.refusal(''), { reason: 'unrecognized' });
  assert.equal(links.get(live)?.requestId, 'r3', 'asking why another token was refused spends nothing');
});

test('a spent link is remembered for its reason only up to a bound', () => {
  const links = createCredentialLinkStore({ keepEnded: 2 });
  const tokens = ['r1', 'r2', 'r3'].map((requestId) => links.mint({ ...KAI_REQUEST, requestId }).token);
  for (const token of tokens) {
    links.retire(token, 'used');
  }
  // The oldest is forgotten: this daemon issued it, so it is not a restart.
  assert.deepEqual(links.refusal(tokens[0] ?? ''), { reason: 'unrecognized' });
  assert.equal(links.refusal(tokens[1] ?? '').reason, 'used');
  assert.equal(links.refusal(tokens[2] ?? '').reason, 'used');
});

test('the refusal page names the reason in words a person can act on', () => {
  assert.match(credentialLinkRefusal({ reason: 'expired', at: Date.UTC(2026, 10, 14, 21, 50) }), /^This link expired at 2026-11-14T21:50:00\.000Z\. Ask the agent to request the credential again\.$/);
  assert.match(credentialLinkRefusal({ reason: 'used', at: 0 }), /already used, at 1970-01-01T00:00:00\.000Z\. A link works once\./);
  assert.match(credentialLinkRefusal({ reason: 'closed', at: 0 }), /closed at 1970-01-01T00:00:00\.000Z, because its request could no longer be answered/);
  assert.match(credentialLinkRefusal({ reason: 'restarted' }), /before the daemon last restarted, or from another daemon\. A link works only on the daemon that issued it/);
  assert.match(credentialLinkRefusal({ reason: 'unrecognized' }), /doesn't recognize this link\. Check that it was copied whole/);
});

test('a link from before a restart, or one cut short, is refused with that reason and stores nothing', async () => {
  const { home, gateway, api } = await startLinking();
  try {
    const session = await gateway.dispatch({ sessionId: 'kai-link-3', agentId: 'kai', userMessage: 'go' });
    const { local } = linkFrom(session, api.url ?? '');
    const base = local.slice(0, local.lastIndexOf('/') + 1);
    const before = `${base}${createCredentialLinkStore().mint(KAI_REQUEST).token}`;
    for (const response of [await fetch(before), await fetch(before, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'value=ghp-1' })]) {
      assert.equal(response.status, 404);
      assert.match(await response.text(), /before the daemon last restarted, or from another daemon/);
    }
    const cut = await fetch(local.slice(0, -3));
    assert.equal(cut.status, 404);
    assert.match(await cut.text(), /doesn&#39;t recognize this link\. Check that it was copied whole/);
    await assert.rejects(readFile(path.join(home, '.stratus', 'credentials.json'), 'utf8'), /ENOENT/);
    assert.equal((await fetch(local)).status, 200, 'the real link still opens its form');
  } finally {
    await gateway.stop();
  }
});

test('without api.publicUrl a link is built on the bound address and says it opens only there', async () => {
  const api = createControlApi({ env: { homeDir: await mkdtemp(path.join(os.tmpdir(), 'stratus-api-local-')), processEnv: {} }, port: 0, ui: false });
  const gateway = createGateway({ env: { homeDir: await mkdtemp(path.join(os.tmpdir(), 'stratus-gw-local-')), processEnv: {} }, idleTimeoutMs: 0, log: () => {}, warn: () => {} });
  await api.start(gateway);
  try {
    const link = await api.requestCredentialLink?.({ sessionId: 's', agentId: 'kai', agentName: 'Kai', requestId: 'r', name: 'github.token', scope: 'agent' });
    assert.ok(link?.url.startsWith(`${api.url}/api/v1/credential-links/`));
    assert.equal(link?.localOnly, true);
  } finally {
    await api.stop();
  }
});

test('a publicUrl passed straight to createControlApi is held to the config rule', () => {
  // A host skipping the config file must not be a way to put a sign-in in
  // every link, and the refusal must not repeat it.
  assert.throws(
    () => createControlApi({ port: 0, publicUrl: 'https://proxy-user:hunter2@mac-mini.example' }),
    (error: Error) => /Invalid publicUrl.*username or password/.test(error.message) && !error.message.includes('hunter2'),
  );
  assert.throws(() => createControlApi({ port: 0, publicUrl: 'https://mac-mini.example/?' }), /no query or fragment/);
});
