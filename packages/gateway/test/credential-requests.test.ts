import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { StratusEvent } from '@stratusagent/core';
import { createGateway } from '../src/index.ts';

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

const SLACK = { channel: 'slack', slackChannel: 'C1', slackThread: '100.1' };

/**
 * A daemon whose model asks for a credential on its first call and answers
 * in words on every call after, with the events it emitted collected.
 */
const startRequesting = async (options: { soul?: string; request?: object; agentless?: boolean } = {}) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-gw-credreq-'));
  const agentsDir = path.join(home, '.stratus', 'agents');
  await mkdir(agentsDir, { recursive: true });
  const soulFile = path.join(agentsDir, 'kai.md');
  await writeFile(soulFile, options.soul ?? '---\nname: Kai\nprovider: openai\nmodel: model-a\nlanguage: en-GB\n---\n\nYou are Kai.\n');
  if (options.agentless) {
    await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'openai', model: 'model-a' }));
  }
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return calls === 1
      ? openAiToolCall('credential_request', options.request ?? { name: 'github.token', reason: 'To open pull requests.' })
      : openAiText('asked');
  }) as typeof fetch;
  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  const gateway = createGateway({ env, idleTimeoutMs: 0, log: () => {}, warn: () => {} });
  const events: StratusEvent[] = [];
  gateway.bus.subscribe(async (event) => {
    events.push(event);
  });
  await gateway.start();
  return { home, soulFile, gateway, events };
};

const requestedIn = (events: StratusEvent[]) =>
  events.find((event): event is Extract<StratusEvent, { type: 'credential.requested' }> => event.type === 'credential.requested');

test('an agent asks for a credential, an approver provides it, and it is stored for that agent and granted in its soul', async () => {
  const { home, soulFile, gateway, events } = await startRequesting();
  try {
    const session = await gateway.dispatch({ sessionId: 'kai-1', agentId: 'kai', userMessage: 'open a PR', metadata: SLACK });
    const requested = requestedIn(events);
    assert.ok(requested, 'the request was announced for a channel to render');
    assert.deepEqual(
      { agentId: requested.agentId, name: requested.name, scope: requested.scope, reason: requested.reason, slackChannel: requested.metadata?.slackChannel },
      { agentId: 'kai', name: 'github.token', scope: 'agent', reason: 'To open pull requests.', slackChannel: 'C1' },
    );
    const toolResult = session.messages.find((message) => message.role === 'tool')?.toolResult;
    assert.equal(toolResult?.ok, true);
    assert.match(JSON.stringify(toolResult?.output), /You will not see the value/);

    const result = await gateway.provideCredential({ requestId: requested.requestId, value: 'ghp-secret-value', actor: 'U-DYLAN' });
    assert.deepEqual(result, { ok: true, name: 'github.token', scope: 'agent', agentId: 'kai', granted: true });

    // Stored as the agent's own, since the request defaulted to that.
    const credentials = JSON.parse(await readFile(path.join(home, '.stratus', 'credentials.json'), 'utf8')) as {
      named?: { shared?: Record<string, string>; agents?: Record<string, Record<string, string>> };
    };
    assert.equal(credentials.named?.agents?.kai?.['github.token'], 'ghp-secret-value');
    assert.equal(credentials.named?.shared?.['github.token'], undefined);
    // Granted in the soul, which keeps everything else it said.
    const soul = await readFile(soulFile, 'utf8');
    assert.match(soul, /^credentials:\n  - github\.token$/m);
    assert.match(soul, /^language: en-GB$/m);
    assert.ok(events.some((event) => event.type === 'credential.provided' && event.actor === 'U-DYLAN'));

    // The value is nowhere but the credential store.
    const stored = await gateway.store.get('kai-1');
    assert.doesNotMatch(JSON.stringify([stored, events]), /ghp-secret-value/);

    // One answer per request.
    const again = await gateway.provideCredential({ requestId: requested.requestId, value: 'ghp-other', actor: 'U-DYLAN' });
    assert.equal(again.ok, false);
  } finally {
    await gateway.stop();
  }
});

test('a shared request is stored for the fleet but granted only to the agent that asked', async () => {
  const { home, gateway, events } = await startRequesting({ request: { name: 'search.apiKey', scope: 'shared' } });
  try {
    await gateway.dispatch({ sessionId: 'kai-2', agentId: 'kai', userMessage: 'search', metadata: SLACK });
    const requested = requestedIn(events);
    assert.equal(requested?.scope, 'shared');
    const result = await gateway.provideCredential({ requestId: requested?.requestId ?? '', value: 'sk-search' });
    assert.equal(result.ok, true);
    const credentials = JSON.parse(await readFile(path.join(home, '.stratus', 'credentials.json'), 'utf8')) as {
      named?: { shared?: Record<string, string> };
    };
    assert.equal(credentials.named?.shared?.['search.apiKey'], 'sk-search');
  } finally {
    await gateway.stop();
  }
});

test('an empty value is refused and the request stays open for a real one', async () => {
  const { gateway, events } = await startRequesting();
  try {
    await gateway.dispatch({ sessionId: 'kai-3', agentId: 'kai', userMessage: 'go', metadata: SLACK });
    const requestId = requestedIn(events)?.requestId ?? '';
    const empty = await gateway.provideCredential({ requestId, value: '   ' });
    assert.equal(empty.ok, false);
    assert.match(empty.ok ? '' : empty.message, /empty/);
    assert.equal((await gateway.provideCredential({ requestId, value: 'ghp-1' })).ok, true);
  } finally {
    await gateway.stop();
  }
});

test('a request nothing can show a form for, or for a key already held, is refused with what to do instead', async () => {
  // No channel started this conversation, so nobody would see the form.
  const headless = await startRequesting();
  try {
    const session = await headless.gateway.dispatch({ sessionId: 'kai-4', agentId: 'kai', userMessage: 'go' });
    const result = session.messages.find((message) => message.role === 'tool')?.toolResult;
    assert.equal(result?.ok, false);
    assert.match(result?.error ?? '', /not in a channel that can show your operator a form.*stratus credential set github\.token --agent kai/);
    assert.equal(requestedIn(headless.events), undefined);
  } finally {
    await headless.gateway.stop();
  }

  // Already stored and granted: nothing to ask for.
  const held = await startRequesting({ soul: '---\nname: Kai\nprovider: openai\nmodel: model-a\ncredentials: [github.token]\n---\n\nYou are Kai.\n' });
  try {
    await mkdir(path.join(held.home, '.stratus'), { recursive: true });
    await writeFile(
      path.join(held.home, '.stratus', 'credentials.json'),
      JSON.stringify({ named: { shared: { 'github.token': 'ghp-existing' }, agents: {} } }),
    );
    const session = await held.gateway.dispatch({ sessionId: 'kai-5', agentId: 'kai', userMessage: 'go', metadata: SLACK });
    const result = session.messages.find((message) => message.role === 'tool')?.toolResult;
    assert.match(result?.error ?? '', /You already hold github\.token/);
    assert.equal(requestedIn(held.events), undefined);
  } finally {
    await held.gateway.stop();
  }
});

test('a request whose soul was given to another agent while it waited stores nothing', async () => {
  const { home, soulFile, gateway, events } = await startRequesting();
  try {
    await gateway.dispatch({ sessionId: 'kai-6', agentId: 'kai', userMessage: 'go', metadata: SLACK });
    const requestId = requestedIn(events)?.requestId ?? '';
    await writeFile(soulFile, '---\nname: Bea\nid: bea\nprovider: openai\nmodel: model-a\n---\n\nYou are Bea.\n');

    const result = await gateway.provideCredential({ requestId, value: 'ghp-secret-value', actor: 'U-DYLAN' });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.message, /now belongs to bea, not kai, so nothing was stored/);
    const credentials = await readFile(path.join(home, '.stratus', 'credentials.json'), 'utf8').catch(() => '');
    assert.doesNotMatch(credentials, /ghp-secret-value/);
    assert.doesNotMatch(await readFile(soulFile, 'utf8'), /credentials/);
  } finally {
    await gateway.stop();
  }
});
