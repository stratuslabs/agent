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
const createFormChannel = (options: { refuse?: string; replaceForms?: boolean; envForms?: boolean } = {}) => {
  const delivered: DeliveredRequest[] = [];
  const adapter: GatewayChannelAdapter = {
    name: 'slack',
    start: async () => {},
    stop: async () => {},
    ...(options.replaceForms === false ? {} : { credentialReplaceForms: true }),
    ...(options.envForms === false ? {} : { credentialEnvForms: true }),
    requestCredential: async (request) => {
      if (options.refuse !== undefined) {
        throw new Error(options.refuse);
      }
      delivered.push(request);
    },
  };
  return { adapter, delivered };
};

type LinkRequest = Parameters<NonNullable<GatewayChannelAdapter['requestCredentialLink']>>[0];

/** An adapter that issues credential links the way the control API does, or fails to. */
const createLinkIssuer = (options: { fail?: string } = {}) => {
  const issued: LinkRequest[] = [];
  const adapter: GatewayChannelAdapter = {
    name: 'control-api',
    start: async () => {},
    stop: async () => {},
    requestCredentialLink: async (request) => {
      if (options.fail !== undefined) {
        throw new Error(options.fail);
      }
      issued.push(request);
      return { url: `https://daemon.example/link/${request.requestId}`, expiresAt: '2026-10-01T12:30:00.000Z' };
    },
  };
  return { adapter, issued };
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
  /** Started beside the channel, the way the control API is. */
  also?: GatewayChannelAdapter[];
  /** Serve Kai as the configured default soul, from outside the roster. */
  configSoul?: boolean;
  /** Stamp the home the way 0.14.2 left it: set up before the safe-tools default. */
  olderHome?: boolean;
} = {}) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-gw-credreq-'));
  const agentsDir = path.join(home, '.stratus', 'agents');
  await mkdir(agentsDir, { recursive: true });
  if (options.olderHome) {
    await writeFile(path.join(home, '.stratus', 'state.json'), JSON.stringify({ schemaVersion: 4, applied: ['0001-owner-only-state-files', '0002-provenance-labels', '0003-per-agent-state-layout', '0004-per-agent-workspaces'] }));
  }
  const soulFile = options.configSoul ? path.join(home, 'souls', 'kai-a.md') : path.join(agentsDir, 'kai.md');
  if (options.configSoul) {
    await mkdir(path.dirname(soulFile), { recursive: true });
    await writeFile(path.join(home, '.stratus', 'config.json'), JSON.stringify({ provider: 'openai', model: 'model-a', soul: soulFile }));
  }
  // `tools: ["*"]`, which names credential.request, so a link may be
  // offered; a soul with no list gets forms only (tested below).
  await writeFile(soulFile, options.soul ?? '---\nname: Kai\nprovider: openai\nmodel: model-a\nlanguage: en-GB\ntools: ["*"]\n---\n\nYou are Kai.\n');
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
  const gateway = createGateway({ env, idleTimeoutMs: 0, log: () => {}, warn: () => {}, channels: [options.channel ?? form.adapter, ...(options.also ?? [])] });
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
    assert.match(result?.error ?? '', /The form could not be shown here: Slack refused the post \(ratelimited\)\. No control API is running to issue a link either/);
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

test('a roster reload waits for a soul write holding the lock, so a grant\'s served-path check cannot go stale', async () => {
  const { gateway } = await startRequesting();
  try {
    let release!: () => void;
    const held = withSoulFileLock(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    const reload = gateway.reloadRoster();
    // Bounded by event-loop turns, not the clock: an unlocked reload is a
    // few file reads and finishes well inside this.
    const yields = async (): Promise<'still waiting'> => {
      for (let turn = 0; turn < 10_000; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      return 'still waiting';
    };
    const before = await Promise.race([reload.then(() => 'reloaded' as const), yields()]);
    release();
    await held;
    await reload;
    assert.equal(before, 'still waiting', 'the reload queued behind the held soul lock');
  } finally {
    await gateway.stop();
  }
});

test('a request whose form cannot go up gets a link instead, and says why', async () => {
  const links = createLinkIssuer();
  const refusing = createFormChannel({ refuse: 'Nobody who can add it can see this conversation.' });
  const { gateway, events } = await startRequesting({ channel: refusing.adapter, also: [links.adapter] });
  try {
    const session = await gateway.dispatch({ sessionId: 'kai-17', agentId: 'kai', userMessage: 'go', metadata: SLACK });
    const result = session.messages.find((message) => message.role === 'tool')?.toolResult;
    assert.equal(result?.ok, true);
    const output = result?.output as { via?: string; link?: string; note?: string };
    assert.equal(output.via, 'link');
    assert.equal(output.link, `https://daemon.example/link/${links.issued[0]?.requestId}`);
    assert.match(output.note ?? '', /^The form could not be shown here: Nobody who can add it can see this conversation\. Give this link/);
    assert.equal(links.issued[0]?.agentName, 'Kai');
    assert.equal(requestedIn(events)?.via, 'link');
    // The link answers the same pending request a form would have.
    assert.equal((await gateway.provideCredential({ requestId: links.issued[0]?.requestId ?? '', value: 'ghp-1', actor: 'link' })).ok, true);
  } finally {
    await gateway.stop();
  }
});

test('an agent asking for a link gets one even where a form could go, and one asking for a form gets no link', async () => {
  const links = createLinkIssuer();
  const viaLink = await startRequesting({ request: { name: 'github.token', via: 'link' }, also: [links.adapter] });
  try {
    await viaLink.gateway.dispatch({ sessionId: 'kai-18', agentId: 'kai', userMessage: 'go', metadata: SLACK });
    assert.equal(viaLink.delivered.length, 0, 'no form was posted');
    assert.equal(links.issued.length, 1);
  } finally {
    await viaLink.gateway.stop();
  }

  const formless: GatewayChannelAdapter = { name: 'slack', start: async () => {}, stop: async () => {} };
  const viaForm = await startRequesting({ request: { name: 'github.token', via: 'form' }, channel: formless, also: [links.adapter] });
  try {
    const session = await viaForm.gateway.dispatch({ sessionId: 'kai-19', agentId: 'kai', userMessage: 'go', metadata: SLACK });
    const result = session.messages.find((message) => message.role === 'tool')?.toolResult;
    assert.equal(result?.ok, false);
    assert.match(result?.error ?? '', /cannot show your operator a credential form here\. Nothing is pending\. Ask for a link instead/);
    assert.equal(links.issued.length, 1, 'no second link');
    assert.equal(requestedIn(viaForm.events), undefined);
  } finally {
    await viaForm.gateway.stop();
  }
});

test('a link that could not be issued leaves nothing pending', async () => {
  const links = createLinkIssuer({ fail: 'The control API is not serving yet.' });
  const { gateway, events } = await startRequesting({ also: [links.adapter] });
  try {
    const session = await gateway.dispatch({ sessionId: 'kai-20', agentId: 'kai', userMessage: 'go' });
    const result = session.messages.find((message) => message.role === 'tool')?.toolResult;
    assert.equal(result?.ok, false);
    assert.match(result?.error ?? '', /A link for github\.token could not be issued: The control API is not serving yet\. Nothing is pending/);
    assert.equal(requestedIn(events), undefined);
  } finally {
    await gateway.stop();
  }
});

test('an agent with no tools: list asks through forms only: the link is for a soul that names the tool', async () => {
  // An omitted list grants the safe tools, credential.request among them,
  // but a link is a bearer credential the model is handed, so only a soul
  // that lists the tool (by name, a glob or "*") gets one.
  const unlisted = '---\nname: Kai\nprovider: openai\nmodel: model-a\n---\n\nYou are Kai.\n';
  const links = createLinkIssuer();
  const viaLink = await startRequesting({ soul: unlisted, request: { name: 'github.token', via: 'link' }, also: [links.adapter] });
  try {
    const session = await viaLink.gateway.dispatch({ sessionId: 'kai-33', agentId: 'kai', userMessage: 'go', metadata: SLACK });
    const result = session.messages.find((message) => message.role === 'tool')?.toolResult;
    assert.equal(result?.ok, false);
    assert.match(result?.error ?? '', /A one-time link needs credential\.request in your soul's tools: list/);
    assert.equal(links.issued.length, 0, 'no link was issued');
  } finally {
    await viaLink.gateway.stop();
  }

  const viaForm = await startRequesting({ soul: unlisted });
  try {
    const session = await viaForm.gateway.dispatch({ sessionId: 'kai-34', agentId: 'kai', userMessage: 'go', metadata: SLACK });
    assert.equal(session.messages.find((message) => message.role === 'tool')?.toolResult?.ok, true, 'a form still goes up');
    assert.equal(viaForm.delivered.length, 1);
  } finally {
    await viaForm.gateway.stop();
  }
});

test('on a home an older build set up, an agent with no tools: list may still be handed a link', async () => {
  // An omitted list is every tool there, as it always was, and that has
  // always included a link.
  const unlisted = '---\nname: Kai\nprovider: openai\nmodel: model-a\n---\n\nYou are Kai.\n';
  const links = createLinkIssuer();
  const viaLink = await startRequesting({ soul: unlisted, olderHome: true, request: { name: 'github.token', via: 'link' }, also: [links.adapter] });
  try {
    const session = await viaLink.gateway.dispatch({ sessionId: 'kai-35', agentId: 'kai', userMessage: 'go', metadata: SLACK });
    assert.equal(session.messages.find((message) => message.role === 'tool')?.toolResult?.ok, true);
    assert.equal(links.issued.length, 1, 'a link was issued');
  } finally {
    await viaLink.gateway.stop();
  }
});

test('an agent whose tools: leaves out credential.request can still ask through a form, but is never handed a link', async () => {
  const listed = '---\nname: Kai\nprovider: openai\nmodel: model-a\ntools: []\n---\n\nYou are Kai.\n';
  const viaForm = await startRequesting({ soul: listed });
  try {
    const session = await viaForm.gateway.dispatch({ sessionId: 'kai-30', agentId: 'kai', userMessage: 'go', metadata: SLACK });
    const result = session.messages.find((message) => message.role === 'tool')?.toolResult;
    assert.equal(result?.ok, true, 'the form path is granted to every agent');
    assert.equal(viaForm.delivered.length, 1);
  } finally {
    await viaForm.gateway.stop();
  }

  const links = createLinkIssuer();
  const viaLink = await startRequesting({ soul: listed, request: { name: 'github.token', via: 'link' }, also: [links.adapter] });
  try {
    const session = await viaLink.gateway.dispatch({ sessionId: 'kai-31', agentId: 'kai', userMessage: 'go', metadata: SLACK });
    const result = session.messages.find((message) => message.role === 'tool')?.toolResult;
    assert.equal(result?.ok, false);
    assert.match(result?.error ?? '', /A one-time link needs credential\.request in your soul's tools: list/);
    assert.equal(links.issued.length, 0, 'no link was issued');
    assert.equal(requestedIn(viaLink.events), undefined);
  } finally {
    await viaLink.gateway.stop();
  }

  // Where no form can go, the fallback is refused too rather than becoming a link.
  const refusing = createFormChannel({ refuse: 'Nobody who can add it can see this conversation.' });
  const fallback = await startRequesting({ soul: listed, channel: refusing.adapter, also: [links.adapter] });
  try {
    const session = await fallback.gateway.dispatch({ sessionId: 'kai-32', agentId: 'kai', userMessage: 'go', metadata: SLACK });
    const result = session.messages.find((message) => message.role === 'tool')?.toolResult;
    assert.equal(result?.ok, false);
    assert.match(result?.error ?? '', /^The form could not be shown here: .* A one-time link needs/);
    assert.equal(links.issued.length, 0);
  } finally {
    await fallback.gateway.stop();
  }

  // A soul that lists the tool keeps the link.
  const granted = await startRequesting({
    soul: '---\nname: Kai\nprovider: openai\nmodel: model-a\ntools: [credential.request]\n---\n\nYou are Kai.\n',
    request: { name: 'github.token', via: 'link' },
    also: [links.adapter],
  });
  try {
    await granted.gateway.dispatch({ sessionId: 'kai-33', agentId: 'kai', userMessage: 'go', metadata: SLACK });
    assert.equal(links.issued.length, 1);
  } finally {
    await granted.gateway.stop();
  }
});

const KAI_HOLDS = '---\nname: Kai\nprovider: openai\nmodel: model-a\ncredentials: [github.token]\n---\n\nYou are Kai.\n';

const storeNamed = async (home: string, named: { shared?: Record<string, string>; agents?: Record<string, Record<string, string>> }) => {
  await mkdir(path.join(home, '.stratus'), { recursive: true });
  await writeFile(path.join(home, '.stratus', 'credentials.json'), JSON.stringify({ named: { shared: {}, agents: {}, ...named } }));
};

const readNamed = async (home: string) => (JSON.parse(await readFile(path.join(home, '.stratus', 'credentials.json'), 'utf8')) as {
  named: { shared: Record<string, string>; agents: Record<string, Record<string, string>> };
}).named;

const toolError = (session: { messages: Array<{ role: string; toolResult?: { ok: boolean; error?: string } }> }) =>
  session.messages.find((message) => message.role === 'tool')?.toolResult?.error ?? '';

/**
 * A PEM-shaped value. Assembled here rather than written out, so nothing in
 * the repository looks like a committed private key to a secret scanner;
 * the body is base64 of a sentence, not a key.
 */
const PEM_LABEL = ['PRIVATE', 'KEY'].join(' ');
const PEM = [
  `-----BEGIN ${PEM_LABEL}-----`,
  'bm90IGEga2V5LCBqdXN0IGEgdGVzdCBvZiBsaW5lIGJyZWFrcyBpbiBhIHN0b3Jl',
  'ZCBjcmVkZW50aWFsIHZhbHVlLCB3cmFwcGVkIGF0IHNpeHR5LWZvdXI=',
  `-----END ${PEM_LABEL}-----`,
].join('\n');

test('a multi-line key is stored with its line breaks, and line breaks around a value are dropped', async () => {
  const cases: Array<[string, string]> = [
    // A key file pasted whole, its last line break included.
    [`\n${PEM}\n`, PEM],
    // A one-line key copied with the line break after it, which would
    // otherwise end up inside an Authorization header.
    ['ghp-secret-value\r\n', 'ghp-secret-value'],
    // Only line breaks: a value's own spaces are its own, as on the CLI.
    ['ghp-spaced \n', 'ghp-spaced '],
  ];
  for (const [index, [sent, stored]] of cases.entries()) {
    const { home, gateway, events } = await startRequesting();
    try {
      await gateway.dispatch({ sessionId: `kai-ml-${index}`, agentId: 'kai', userMessage: 'go', metadata: SLACK });
      const result = await gateway.provideCredential({ requestId: requestedIn(events)?.requestId ?? '', value: sent, actor: 'U-DYLAN' });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal((await readNamed(home)).agents.kai?.['github.token'], stored);
    } finally {
      await gateway.stop();
    }
  }
});

test('a PEM key whose line breaks were lost is refused with how to keep them, and the request stays open', async () => {
  const { home, gateway, events } = await startRequesting();
  try {
    await gateway.dispatch({ sessionId: 'kai-pem', agentId: 'kai', userMessage: 'go', metadata: SLACK });
    const requestId = requestedIn(events)?.requestId ?? '';
    // What a one-line field makes of a pasted key file: spaces, or nothing.
    for (const flattened of [PEM.replace(/\n/g, ' '), PEM.replace(/\n/g, '')]) {
      const refused = await gateway.provideCredential({ requestId, value: flattened, actor: 'U-DYLAN' });
      assert.equal(refused.ok, false);
      assert.equal(refused.ok ? undefined : refused.retired, undefined, 'not retired: the same form can take the real key');
      const message = refused.ok ? '' : refused.message;
      assert.match(message, /line breaks/);
      assert.match(message, /stratus credential set github\.token --agent kai < key\.pem/);
      assert.doesNotMatch(message, /bm90IGEga2V5/, 'the refusal never repeats the value');
    }
    await assert.rejects(readFile(path.join(home, '.stratus', 'credentials.json'), 'utf8'), 'nothing was stored');

    assert.equal((await gateway.provideCredential({ requestId, value: PEM, actor: 'U-DYLAN' })).ok, true);
    assert.equal((await readNamed(home)).agents.kai?.['github.token'], PEM);
  } finally {
    await gateway.stop();
  }
});

test('a one-line value that only contains a PEM block, such as a service account key in JSON, is stored as sent', async () => {
  const { home, gateway, events } = await startRequesting({ request: { name: 'gcp.serviceAccount' } });
  try {
    await gateway.dispatch({ sessionId: 'kai-json', agentId: 'kai', userMessage: 'go', metadata: SLACK });
    // JSON escapes the key's line breaks, so the value has none of its own.
    const json = JSON.stringify({ type: 'service_account', private_key: `${PEM}\n` });
    assert.ok(!json.includes('\n'));
    const result = await gateway.provideCredential({ requestId: requestedIn(events)?.requestId ?? '', value: json });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal((await readNamed(home)).agents.kai?.['gcp.serviceAccount'], json);
  } finally {
    await gateway.stop();
  }
});

test('an agent asks to replace a key it holds, an approver enters the new value, and it is swapped in place with an audit line', async () => {
  const { home, gateway, events, delivered } = await startRequesting({ soul: KAI_HOLDS, request: { name: 'github.token', replace: true, reason: 'It expires tomorrow.' } });
  try {
    await storeNamed(home, { agents: { kai: { 'github.token': 'ghp-old' } } });
    const session = await gateway.dispatch({ sessionId: 'kai-r1', agentId: 'kai', userMessage: 'rotate', metadata: SLACK });
    const requested = requestedIn(events);
    assert.ok(requested, toolError(session));
    assert.equal(requested.replace, true);
    assert.equal(requested.via, 'form');
    assert.equal(delivered[0]?.replace, true, 'the channel is told it is a replacement, to say so on the form');

    // Until the answer, the old key is the one in use.
    assert.equal((await readNamed(home)).agents.kai?.['github.token'], 'ghp-old');
    const result = await gateway.provideCredential({ requestId: requested.requestId, value: 'ghp-new', actor: 'U-DYLAN' });
    assert.deepEqual(result, { ok: true, name: 'github.token', scope: 'agent', agentId: 'kai', granted: false });
    assert.equal((await readNamed(home)).agents.kai?.['github.token'], 'ghp-new');

    const provided = events.find((event): event is Extract<StratusEvent, { type: 'credential.provided' }> => event.type === 'credential.provided');
    assert.equal(provided?.replace, true);
    assert.equal(provided?.actor, 'U-DYLAN');

    const audit = (await readFile(path.join(home, '.stratus', 'credential-audit.log'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, string>);
    assert.equal(audit.length, 1);
    assert.deepEqual({ ...audit[0], at: undefined }, { at: undefined, action: 'replace', name: 'github.token', store: 'agent:kai', actor: 'U-DYLAN', via: 'form', requestedBy: 'kai' });
    assert.ok(!Number.isNaN(Date.parse(audit[0]!.at!)));
    // Neither value is anywhere but the credential store.
    const auditText = await readFile(path.join(home, '.stratus', 'credential-audit.log'), 'utf8');
    assert.doesNotMatch(JSON.stringify([await gateway.store.get('kai-r1'), events]) + auditText, /ghp-old|ghp-new/);
  } finally {
    await gateway.stop();
  }
});

test('a replacement whose PEM key lost its line breaks is refused, and the stored key stays in use', async () => {
  const { home, gateway, events } = await startRequesting({ soul: KAI_HOLDS, request: { name: 'github.token', replace: true } });
  try {
    await storeNamed(home, { agents: { kai: { 'github.token': PEM } } });
    await gateway.dispatch({ sessionId: 'kai-r-pem', agentId: 'kai', userMessage: 'rotate', metadata: SLACK });
    const requestId = requestedIn(events)?.requestId ?? '';
    const refused = await gateway.provideCredential({ requestId, value: PEM.replace(/\n/g, ' '), actor: 'U-DYLAN' });
    assert.equal(refused.ok, false);
    assert.match(refused.ok ? '' : refused.message, /line breaks/);
    assert.equal((await readNamed(home)).agents.kai?.['github.token'], PEM);
    const next = `${PEM.replace('bm90', 'bmV3')}\n`;
    assert.equal((await gateway.provideCredential({ requestId, value: next, actor: 'U-DYLAN' })).ok, true);
    assert.equal((await readNamed(home)).agents.kai?.['github.token'], next.trimEnd());
  } finally {
    await gateway.stop();
  }
});

test('a channel whose forms predate replace is never handed one, so an approver cannot rotate a key from an add form', async () => {
  // Codex P1 4332724257: an adapter that ignores `replace` would show its
  // ordinary add form while the answer overwrote the stored key.
  const plain = createFormChannel({ replaceForms: false });
  const { home, gateway, events } = await startRequesting({ soul: KAI_HOLDS, channel: plain.adapter, request: { name: 'github.token', replace: true } });
  try {
    await storeNamed(home, { agents: { kai: { 'github.token': 'ghp-old' } } });
    const session = await gateway.dispatch({ sessionId: 'kai-r9', agentId: 'kai', userMessage: 'rotate', metadata: SLACK });
    assert.equal(requestedIn(events), undefined);
    assert.equal(plain.delivered.length, 0, 'no form went up');
    assert.match(toolError(session), /cannot show your operator a replacement form/);
    assert.equal((await readNamed(home)).agents.kai?.['github.token'], 'ghp-old');
  } finally {
    await gateway.stop();
  }
});

test('a replacement whose grant was removed from the soul while it waited is retired, and the key is kept', async () => {
  // Codex P2 4332724265: the soul is re-read under the soul lock first.
  const { home, soulFile, gateway, events } = await startRequesting({ soul: KAI_HOLDS, request: { name: 'github.token', replace: true } });
  try {
    await storeNamed(home, { agents: { kai: { 'github.token': 'ghp-old' } } });
    await gateway.dispatch({ sessionId: 'kai-r10', agentId: 'kai', userMessage: 'rotate', metadata: SLACK });
    const requestId = requestedIn(events)?.requestId ?? '';
    assert.ok(requestId);
    await writeFile(soulFile, '---\nname: Kai\nprovider: openai\nmodel: model-a\n---\n\nYou are Kai.\n');
    const result = await gateway.provideCredential({ requestId, value: 'ghp-new', actor: 'U-DYLAN' });
    assert.equal(result.ok, false);
    assert.equal((result as { retired?: boolean }).retired, true);
    assert.match((result as { message: string }).message, /no longer granted github\.token/);
    assert.equal((await readNamed(home)).agents.kai?.['github.token'], 'ghp-old');
  } finally {
    await gateway.stop();
  }
});

test('an add from a form writes an audit line too', async () => {
  const { home, gateway, events } = await startRequesting();
  try {
    await gateway.dispatch({ sessionId: 'kai-r2', agentId: 'kai', userMessage: 'go', metadata: SLACK });
    const requestId = requestedIn(events)?.requestId ?? '';
    assert.equal((await gateway.provideCredential({ requestId, value: 'ghp-first', actor: 'U-DYLAN' })).ok, true);
    const line = JSON.parse((await readFile(path.join(home, '.stratus', 'credential-audit.log'), 'utf8')).trim()) as Record<string, string>;
    assert.equal(line.action, 'add');
    assert.equal(line.store, 'agent:kai');
    assert.equal(line.actor, 'U-DYLAN');
  } finally {
    await gateway.stop();
  }
});

test('a replace is refused before anyone is asked when there is nothing of the agent\'s to replace, or it would be a link', async () => {
  const cases: Array<{ request: object; named?: Parameters<typeof storeNamed>[1]; soul?: string; processEnv?: Record<string, string>; metadata?: typeof SLACK; error: RegExp }> = [
    { request: { name: 'github.token', replace: true }, soul: KAI_HOLDS, error: /You don't hold github\.token, so there is nothing to replace/ },
    { request: { name: 'github.token', replace: true }, named: { agents: { kai: { 'github.token': 'ghp-x' } } }, error: /You don't hold github\.token/ },
    { request: { name: 'github.token', replace: true }, soul: KAI_HOLDS, named: { shared: { 'github.token': 'ghp-fleet' } }, error: /shared credential, so replacing it changes the key for every agent/ },
    { request: { name: 'github.token', replace: true, scope: 'shared' }, soul: KAI_HOLDS, named: { agents: { kai: { 'github.token': 'ghp-x' } } }, error: /your own credential, not a shared one/ },
    { request: { name: 'github.token', replace: true }, soul: KAI_HOLDS, processEnv: { 'github.token': 'ghp-env' }, error: /daemon's environment, which a form can't change/ },
    { request: { name: 'github.token', replace: true, via: 'link' }, soul: KAI_HOLDS, named: { agents: { kai: { 'github.token': 'ghp-x' } } }, error: /never a link/ },
  ];
  for (const entry of cases) {
    const link = createLinkIssuer();
    const started = await startRequesting({
      request: entry.request,
      ...(entry.soul !== undefined ? { soul: entry.soul } : {}),
      ...(entry.processEnv !== undefined ? { processEnv: entry.processEnv } : {}),
      also: [link.adapter],
    });
    try {
      if (entry.named) {
        await storeNamed(started.home, entry.named);
      }
      const session = await started.gateway.dispatch({ sessionId: 'kai-r3', agentId: 'kai', userMessage: 'go', metadata: SLACK });
      assert.match(toolError(session), entry.error, JSON.stringify(entry.request));
      assert.equal(requestedIn(started.events), undefined, 'nothing pending');
      assert.equal(started.delivered.length, 0);
      assert.equal(link.issued.length, 0, 'never a link');
    } finally {
      await started.gateway.stop();
    }
  }
});

test('a replace where no form can go is refused instead of falling back to a link', async () => {
  const link = createLinkIssuer();
  const { home, gateway, events } = await startRequesting({ soul: KAI_HOLDS, request: { name: 'github.token', replace: true }, also: [link.adapter] });
  try {
    await storeNamed(home, { agents: { kai: { 'github.token': 'ghp-x' } } });
    // No channel metadata: a scheduled or HTTP turn.
    const session = await gateway.dispatch({ sessionId: 'kai-r4', agentId: 'kai', userMessage: 'go' });
    assert.match(toolError(session), /A replacement needs a conversation that can show an approver a form/);
    assert.equal(link.issued.length, 0);
    assert.equal(requestedIn(events), undefined);
  } finally {
    await gateway.stop();
  }
});

test('a replace whose key was removed while it waited is retired, and nothing is created', async () => {
  const { home, gateway, events } = await startRequesting({ soul: KAI_HOLDS, request: { name: 'github.token', replace: true } });
  try {
    await storeNamed(home, { agents: { kai: { 'github.token': 'ghp-x' } } });
    await gateway.dispatch({ sessionId: 'kai-r5', agentId: 'kai', userMessage: 'go', metadata: SLACK });
    const requestId = requestedIn(events)?.requestId ?? '';
    assert.ok(requestId);
    await storeNamed(home, {});
    const result = await gateway.provideCredential({ requestId, value: 'ghp-new' });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.retired, true);
    assert.equal((await readNamed(home)).agents.kai, undefined);
    // An empty answer to a live replace keeps the old key and the request.
  } finally {
    await gateway.stop();
  }
});

test('a shared key is replaced only when the request says shared, and then for the fleet', async () => {
  const { home, gateway, events } = await startRequesting({ soul: KAI_HOLDS, request: { name: 'github.token', replace: true, scope: 'shared' } });
  try {
    await storeNamed(home, { shared: { 'github.token': 'ghp-fleet-old' } });
    await gateway.dispatch({ sessionId: 'kai-r6', agentId: 'kai', userMessage: 'go', metadata: SLACK });
    const requestId = requestedIn(events)?.requestId ?? '';
    assert.equal((await gateway.provideCredential({ requestId, value: 'ghp-fleet-new', actor: 'U-DYLAN' })).ok, true);
    const named = await readNamed(home);
    assert.equal(named.shared['github.token'], 'ghp-fleet-new');
    assert.equal(named.agents.kai, undefined, 'no agent entry created');
  } finally {
    await gateway.stop();
  }
});

const readBindings = async (home: string) => (JSON.parse(await readFile(path.join(home, '.stratus', 'credentials.json'), 'utf8')) as {
  envBindings?: { agents?: Record<string, Record<string, string>> };
}).envBindings?.agents;

test('an agent asks for a key in a variable, the form says so, and the answer stores the value and the binding together', async () => {
  const { home, gateway, events, delivered } = await startRequesting({
    request: { name: 'twilio.authToken', env: 'TWILIO_AUTH_TOKEN', reason: 'For the CNAM lookup script.' },
  });
  try {
    const session = await gateway.dispatch({ sessionId: 'kai-e1', agentId: 'kai', userMessage: 'set up cnam', metadata: SLACK });
    const requested = requestedIn(events);
    assert.ok(requested, toolError(session));
    assert.equal(requested.env, 'TWILIO_AUTH_TOKEN');
    assert.equal(delivered[0]?.env, 'TWILIO_AUTH_TOKEN', 'the channel is told the variable, to say so on the form');
    const output = session.messages.find((message) => message.role === 'tool')?.toolResult?.output as { env?: string; note?: string };
    assert.equal(output.env, 'TWILIO_AUTH_TOKEN');
    assert.match(output.note ?? '', /read it as \$TWILIO_AUTH_TOKEN/);

    const result = await gateway.provideCredential({ requestId: requested.requestId, value: 'tw-secret', actor: 'U-DYLAN' });
    assert.deepEqual(result, { ok: true, name: 'twilio.authToken', scope: 'agent', agentId: 'kai', granted: true });
    assert.equal((await readNamed(home)).agents.kai?.['twilio.authToken'], 'tw-secret');
    assert.deepEqual(await readBindings(home), { kai: { TWILIO_AUTH_TOKEN: 'twilio.authToken' } });

    const provided = events.find((event): event is Extract<StratusEvent, { type: 'credential.provided' }> => event.type === 'credential.provided');
    assert.equal(provided?.env, 'TWILIO_AUTH_TOKEN');
    const line = JSON.parse((await readFile(path.join(home, '.stratus', 'credential-audit.log'), 'utf8')).trim()) as Record<string, string>;
    assert.equal(line.env, 'TWILIO_AUTH_TOKEN');
    assert.equal(line.bindingFor, 'kai');
    const auditText = await readFile(path.join(home, '.stratus', 'credential-audit.log'), 'utf8');
    assert.doesNotMatch(JSON.stringify([await gateway.store.get('kai-e1'), events]) + auditText, /tw-secret/);
  } finally {
    await gateway.stop();
  }
});

test('a shared key asked for in a variable is bound for the agent that asked, and a replace can bind too', async () => {
  const shared = await startRequesting({ request: { name: 'github.token', scope: 'shared', env: 'GH_TOKEN' } });
  try {
    await shared.gateway.dispatch({ sessionId: 'kai-e2', agentId: 'kai', userMessage: 'go', metadata: SLACK });
    const requestId = requestedIn(shared.events)?.requestId ?? '';
    assert.equal((await shared.gateway.provideCredential({ requestId, value: 'ghp-shared', actor: 'U-DYLAN' })).ok, true);
    assert.equal((await readNamed(shared.home)).shared['github.token'], 'ghp-shared');
    assert.deepEqual(await readBindings(shared.home), { kai: { GH_TOKEN: 'github.token' } });
  } finally {
    await shared.gateway.stop();
  }

  const replace = await startRequesting({ soul: KAI_HOLDS, request: { name: 'github.token', replace: true, env: 'GH_TOKEN' } });
  try {
    await storeNamed(replace.home, { agents: { kai: { 'github.token': 'ghp-old' } } });
    await replace.gateway.dispatch({ sessionId: 'kai-e3', agentId: 'kai', userMessage: 'rotate', metadata: SLACK });
    assert.equal(replace.delivered[0]?.env, 'GH_TOKEN');
    const requestId = requestedIn(replace.events)?.requestId ?? '';
    assert.equal((await replace.gateway.provideCredential({ requestId, value: 'ghp-new', actor: 'U-DYLAN' })).ok, true);
    assert.equal((await readNamed(replace.home)).agents.kai?.['github.token'], 'ghp-new');
    assert.deepEqual(await readBindings(replace.home), { kai: { GH_TOKEN: 'github.token' } });
  } finally {
    await replace.gateway.stop();
  }
});

test('a channel whose forms cannot name the variable is never handed the request: a link names it instead, or nothing is pending', async () => {
  const links = createLinkIssuer();
  const plain = createFormChannel({ envForms: false });
  const withLink = await startRequesting({ channel: plain.adapter, also: [links.adapter], request: { name: 'twilio.authToken', env: 'TWILIO_AUTH_TOKEN' } });
  try {
    const session = await withLink.gateway.dispatch({ sessionId: 'kai-e4', agentId: 'kai', userMessage: 'go', metadata: SLACK });
    assert.equal(plain.delivered.length, 0, 'no form went up');
    assert.equal(links.issued[0]?.env, 'TWILIO_AUTH_TOKEN', 'the link page is told the variable');
    const output = session.messages.find((message) => message.role === 'tool')?.toolResult?.output as { via?: string; note?: string };
    assert.equal(output.via, 'link');
    assert.match(output.note ?? '', /that says which variable your shell will read it from/);
    assert.equal(requestedIn(withLink.events)?.env, 'TWILIO_AUTH_TOKEN');
  } finally {
    await withLink.gateway.stop();
  }

  const noLink = await startRequesting({ channel: createFormChannel({ envForms: false }).adapter, request: { name: 'twilio.authToken', env: 'TWILIO_AUTH_TOKEN' } });
  try {
    const session = await noLink.gateway.dispatch({ sessionId: 'kai-e5', agentId: 'kai', userMessage: 'go', metadata: SLACK });
    assert.equal(requestedIn(noLink.events), undefined);
    assert.match(toolError(session), /No control API is running to issue a link either\..*stratus credential set twilio\.authToken --agent kai --env TWILIO_AUTH_TOKEN/);
  } finally {
    await noLink.gateway.stop();
  }
});

test('a variable that is not secret-shaped, or changes how commands run, is refused before anyone is asked', async () => {
  for (const env of ['NODE_OPTIONS', 'DATABASE_URL', 'PATH', 'GIT_DIR', 'gh_token', 'BASH_FUNC_x_TOKEN']) {
    const { gateway, events, delivered } = await startRequesting({ request: { name: 'some.key', env } });
    try {
      const session = await gateway.dispatch({ sessionId: 'kai-e6', agentId: 'kai', userMessage: 'go', metadata: SLACK });
      assert.equal(delivered.length, 0, env);
      assert.equal(requestedIn(events), undefined, env);
      assert.match(toolError(session), /Nothing is pending\./, env);
    } finally {
      await gateway.stop();
    }
  }
});

test('asking for a key already held, in a variable, is refused with the one command the operator runs', async () => {
  const { home, gateway, events, delivered } = await startRequesting({ soul: KAI_HOLDS, request: { name: 'github.token', env: 'GH_TOKEN' } });
  try {
    await storeNamed(home, { agents: { kai: { 'github.token': 'ghp-held' } } });
    const session = await gateway.dispatch({ sessionId: 'kai-e7', agentId: 'kai', userMessage: 'go', metadata: SLACK });
    assert.equal(delivered.length, 0);
    assert.equal(requestedIn(events), undefined);
    assert.match(toolError(session), /You already hold github\.token.*`stratus credential env github\.token GH_TOKEN --agent kai`.*Nothing is pending\./);
  } finally {
    await gateway.stop();
  }
});
