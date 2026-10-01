import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { StratusEvent } from '@stratusagent/core';
import { createGateway } from '@stratusagent/gateway';

import { createCredentialLinkStore } from '../src/credential-links.ts';
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
  await writeFile(soulFile, '---\nname: Kai\nprovider: openai\nmodel: model-a\n---\n\nYou are Kai.\n');
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
    assert.match(link, /^https:\/\/mac-mini\.example\.ts\.net\/api\/v1\/credential-links\/[A-Za-z0-9_-]{43}$/, 'built on api.publicUrl');
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

    // Spent: the link answers once.
    assert.equal((await fetch(local)).status, 404);
    const again = await fetch(local, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'value=ghp-other' });
    assert.equal(again.status, 404);

    // The value is nowhere but the credential store.
    assert.doesNotMatch(JSON.stringify([await gateway.store.get('kai-link-1'), events]), /ghp-secret-value/);
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
    assert.equal((await fetch(local)).status, 404, 'no form left for an answer that cannot land');
  } finally {
    await gateway.stop();
  }
});

test('a link token stops opening its form once its time is up', () => {
  let at = 1_000;
  const links = createCredentialLinkStore({ now: () => at, ttlMs: 60_000 });
  const { token, expiresAt } = links.mint({ requestId: 'r1', agentId: 'kai', agentName: 'Kai', name: 'github.token', scope: 'agent' });
  assert.equal(expiresAt, 61_000);
  assert.equal(links.get(token)?.requestId, 'r1');
  at = 61_000;
  assert.equal(links.get(token), undefined);
  assert.equal(links.get('not-a-token'), undefined);
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
