import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { StratusEvent } from '@stratusagent/core';
import { withCredentialsFileLock, withSoulFileLock } from '@stratusagent/state';
import { createGateway, type GatewayChannelAdapter } from '../src/index.ts';

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

type DeliveredRequest = Parameters<NonNullable<GatewayChannelAdapter['requestCredential']>>[0];

/**
 * A `slack` channel that shows credential forms by recording them, or
 * refuses to the way a failed post does.
 */
const createFormChannel = (options: { refuse?: string } = {}) => {
  const delivered: DeliveredRequest[] = [];
  const adapter: GatewayChannelAdapter = {
    name: 'slack',
    start: async () => {},
    stop: async () => {},
    requestCredential: async (request) => {
      if (options.refuse !== undefined) {
        throw new Error(options.refuse);
      }
      delivered.push(request);
    },
  };
  return { adapter, delivered };
};

/**
 * A daemon whose model asks for a credential on its first call and answers
 * in words on every call after, with the events it emitted collected.
 */
const startRequesting = async (options: {
  soul?: string;
  request?: object;
  agentless?: boolean;
  processEnv?: Record<string, string>;
  channel?: GatewayChannelAdapter;
  /** Serve Kai as the configured default soul, from outside the roster. */
  configSoul?: boolean;
} = {}) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-gw-credreq-'));
  const agentsDir = path.join(home, '.stratus', 'agents');
  await mkdir(agentsDir, { recursive: true });
  const soulFile = options.configSoul ? path.join(home, 'souls', 'kai-a.md') : path.join(agentsDir, 'kai.md');
  if (options.configSoul) {
    await mkdir(path.dirname(soulFile), { recursive: true });
    await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'openai', model: 'model-a', soul: soulFile }));
  }
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
  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test', ...options.processEnv }, fetch: fetchImpl };
  const form = createFormChannel();
  const gateway = createGateway({ env, idleTimeoutMs: 0, log: () => {}, warn: () => {}, channels: [options.channel ?? form.adapter] });
  const events: StratusEvent[] = [];
  gateway.bus.subscribe(async (event) => {
    events.push(event);
  });
  await gateway.start();
  return { home, soulFile, gateway, events, delivered: form.delivered };
};

const requestedIn = (events: StratusEvent[]) =>
  events.find((event): event is Extract<StratusEvent, { type: 'credential.requested' }> => event.type === 'credential.requested');

test('an agent asks for a credential, an approver provides it, and it is stored for that agent and granted in its soul', async () => {
  const { home, soulFile, gateway, events, delivered } = await startRequesting();
  try {
    const session = await gateway.dispatch({ sessionId: 'kai-1', agentId: 'kai', userMessage: 'open a PR', metadata: SLACK });
    const requested = requestedIn(events);
    assert.ok(requested, 'the request was announced once delivered');
    assert.equal(delivered[0]?.requestId, requested.requestId, 'the channel was handed the request to show');
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

test('a key the daemon environment already supplies is not asked for, so a form never replaces it', async () => {
  const { gateway, events } = await startRequesting({
    request: { name: 'GITHUB_TOKEN' },
    processEnv: { GITHUB_TOKEN: 'from-the-environment' },
  });
  try {
    const session = await gateway.dispatch({ sessionId: 'kai-7', agentId: 'kai', userMessage: 'go', metadata: SLACK });
    const result = session.messages.find((message) => message.role === 'tool')?.toolResult;
    assert.equal(result?.ok, false);
    assert.match(result?.error ?? '', /GITHUB_TOKEN is already supplied by the daemon's environment but not granted to you/);
    assert.equal(requestedIn(events), undefined);
  } finally {
    await gateway.stop();
  }
});

test('a channel that cannot show a credential form is refused before anything is pending', async () => {
  // A started `slack` adapter with no form, and a conversation in a kind
  // no adapter serves: both would have announced a request nobody sees.
  const formless: GatewayChannelAdapter = { name: 'slack', start: async () => {}, stop: async () => {} };
  for (const [kind, metadata] of [['slack', SLACK], ['discord', { channel: 'discord' }]] as const) {
    const { gateway, events } = await startRequesting({ channel: formless });
    try {
      const session = await gateway.dispatch({ sessionId: `kai-${kind}`, agentId: 'kai', userMessage: 'go', metadata });
      const result = session.messages.find((message) => message.role === 'tool')?.toolResult;
      assert.equal(result?.ok, false);
      assert.match(result?.error ?? '', new RegExp(`channel \\(${kind}\\) cannot show your operator a credential form.*stratus credential set github\\.token --agent kai`));
      assert.equal(requestedIn(events), undefined);
    } finally {
      await gateway.stop();
    }
  }
});

test('a form the channel failed to post is reported to the agent and leaves nothing pending', async () => {
  const refusing = createFormChannel({ refuse: 'Slack refused the post (ratelimited).' });
  let seen: string | undefined;
  const channel: GatewayChannelAdapter = {
    ...refusing.adapter,
    requestCredential: async (request) => {
      seen = request.requestId;
      await refusing.adapter.requestCredential?.(request);
    },
  };
  const { gateway, events } = await startRequesting({ channel });
  try {
    const session = await gateway.dispatch({ sessionId: 'kai-10', agentId: 'kai', userMessage: 'go', metadata: SLACK });
    const result = session.messages.find((message) => message.role === 'tool')?.toolResult;
    assert.equal(result?.ok, false);
    assert.match(result?.error ?? '', /could not be shown to your operator: Slack refused the post \(ratelimited\)\. Nothing is pending/);
    assert.equal(requestedIn(events), undefined, 'a request that reached nobody is not announced');
    assert.ok(seen);
    const late = await gateway.provideCredential({ requestId: seen, value: 'ghp-1' });
    assert.equal(late.ok, false, 'the dropped request cannot be answered');
  } finally {
    await gateway.stop();
  }
});

test('a key stored whose grant then fails is still announced, so the change on disk has a record', async () => {
  const { home, soulFile, gateway, events } = await startRequesting();
  try {
    await gateway.dispatch({ sessionId: 'kai-11', agentId: 'kai', userMessage: 'go', metadata: SLACK });
    const requestId = requestedIn(events)?.requestId ?? '';
    const credentialsFile = path.join(home, '.stratus', 'credentials.json');
    // Holding the soul lock parks the grant behind this, and the owner check
    // ran before the key was stored: so once the value is on disk, a
    // reassigned soul is what the grant finds. Gated on the store itself,
    // over a bounded run of reads rather than a clock.
    const reassigned = withSoulFileLock(async () => {
      for (let attempt = 0; attempt < 10_000; attempt += 1) {
        if ((await readFile(credentialsFile, 'utf8').catch(() => '')).includes('ghp-secret-value')) {
          await writeFile(soulFile, '---\nname: Bea\nid: bea\nprovider: openai\nmodel: model-a\n---\n\nYou are Bea.\n');
          return;
        }
      }
      throw new Error('the value was never stored');
    });
    const result = await gateway.provideCredential({ requestId, value: 'ghp-secret-value', actor: 'U-DYLAN' });
    await reassigned;

    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.message, /github\.token was stored, but could not be added to .*now declares agent bea/);
    const provided = events.find((event): event is Extract<StratusEvent, { type: 'credential.provided' }> => event.type === 'credential.provided');
    assert.ok(provided, 'the stored key was announced');
    assert.equal(provided.actor, 'U-DYLAN');
    assert.match(provided.grantError ?? '', /now declares agent bea, not kai/);
    assert.doesNotMatch(JSON.stringify(events), /ghp-secret-value/);
  } finally {
    await gateway.stop();
  }
});

test('a request whose name was stored since is retired, since add-only means no answer can ever land', async () => {
  const { home, gateway, events } = await startRequesting({ request: { name: 'search.apiKey', scope: 'shared' } });
  try {
    await gateway.dispatch({ sessionId: 'kai-12', agentId: 'kai', userMessage: 'go', metadata: SLACK });
    const requestId = requestedIn(events)?.requestId ?? '';
    // Another form for the same shared key, or the machine, got there first.
    await writeFile(
      path.join(home, '.stratus', 'credentials.json'),
      JSON.stringify({ named: { shared: { 'search.apiKey': 'sk-first' }, agents: {} } }),
    );

    const conflict = await gateway.provideCredential({ requestId, value: 'sk-second' });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.ok ? undefined : conflict.retired, true, 'the channel is told to take the form down');
    const again = await gateway.provideCredential({ requestId, value: 'sk-third' });
    assert.match(again.ok ? '' : again.message, /no longer pending/);

    // An empty value is the other kind of refusal: fixable, so not retired.
    const fresh = await startRequesting();
    try {
      await fresh.gateway.dispatch({ sessionId: 'kai-13', agentId: 'kai', userMessage: 'go', metadata: SLACK });
      const empty = await fresh.gateway.provideCredential({ requestId: requestedIn(fresh.events)?.requestId ?? '', value: ' ' });
      assert.equal(empty.ok ? undefined : empty.retired, undefined);
    } finally {
      await fresh.gateway.stop();
    }
  } finally {
    await gateway.stop();
  }
});

test('two answers to one request at once store one, and the other waits instead of retiring it', async () => {
  const { gateway, events } = await startRequesting({ request: { name: 'search.apiKey', scope: 'shared' } });
  try {
    await gateway.dispatch({ sessionId: 'kai-14', agentId: 'kai', userMessage: 'go', metadata: SLACK });
    const requestId = requestedIn(events)?.requestId ?? '';
    const [first, second] = await Promise.all([
      gateway.provideCredential({ requestId, value: 'sk-first', actor: 'U-DYLAN' }),
      gateway.provideCredential({ requestId, value: 'sk-second', actor: 'U-BEA' }),
    ]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(second.ok ? undefined : second.retired, undefined, 'the answer being stored is not retired by the one behind it');
    assert.match(second.ok ? '' : second.message, /being stored right now/);
    const provided = events.filter((event) => event.type === 'credential.provided');
    assert.equal(provided.length, 1);
  } finally {
    await gateway.stop();
  }
});

test('a request whose agent is served from another soul file since stores nothing and is retired', async () => {
  const { home, soulFile, gateway, events } = await startRequesting({ configSoul: true });
  try {
    await gateway.dispatch({ sessionId: 'kai-15', agentId: 'kai', userMessage: 'go', metadata: SLACK });
    const requestId = requestedIn(events)?.requestId ?? '';
    assert.ok(requestId, 'the request was made against the configured soul');
    // The default is repointed at another file declaring the same agent;
    // the old one still exists, and still says it is Kai.
    const moved = path.join(home, 'souls', 'kai-b.md');
    await writeFile(moved, await readFile(soulFile, 'utf8'));
    await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'openai', model: 'model-a', soul: moved }));
    await gateway.reloadRoster();

    const result = await gateway.provideCredential({ requestId, value: 'ghp-secret-value' });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.retired, true);
    assert.match(result.ok ? '' : result.message, /kai is no longer served from .*kai-a\.md, so nothing was stored/);
    const credentials = await readFile(path.join(home, '.stratus', 'credentials.json'), 'utf8').catch(() => '');
    assert.doesNotMatch(credentials, /ghp-secret-value/);
    assert.doesNotMatch(await readFile(soulFile, 'utf8'), /credentials/);
  } finally {
    await gateway.stop();
  }
});

test('a soul repointed while the key is being stored is not granted in the file it left', async () => {
  const { home, soulFile, gateway, events } = await startRequesting({ configSoul: true });
  try {
    await gateway.dispatch({ sessionId: 'kai-16', agentId: 'kai', userMessage: 'go', metadata: SLACK });
    const requestId = requestedIn(events)?.requestId ?? '';
    // The store waits on the credentials lock this holds, so the repoint
    // lands after the first path check and before the grant.
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = withCredentialsFileLock(() => released);
    const answer = gateway.provideCredential({ requestId, value: 'ghp-secret-value', actor: 'U-DYLAN' });
    const moved = path.join(home, 'souls', 'kai-b.md');
    await writeFile(moved, await readFile(soulFile, 'utf8'));
    await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'openai', model: 'model-a', soul: moved }));
    await gateway.reloadRoster();
    release();
    await held;
    const result = await answer;

    assert.equal(result.ok, false);
    assert.doesNotMatch(await readFile(soulFile, 'utf8'), /credentials/, 'the file it left was not granted');
    const provided = events.find((event): event is Extract<StratusEvent, { type: 'credential.provided' }> => event.type === 'credential.provided');
    assert.match(provided?.grantError ?? '', /kai is now served from .*kai-b\.md/);
  } finally {
    await gateway.stop();
  }
});
