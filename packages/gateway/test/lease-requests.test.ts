import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { StratusEvent } from '@stratusagent/core';
import { addNamedCredential } from '@stratusagent/state';
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
const HOLDING = '---\nname: Kai\nprovider: openai\nmodel: model-a\ncredentials: [github.token]\n---\n\nYou are Kai.\n';

type DeliveredRequest = Parameters<NonNullable<GatewayChannelAdapter['requestLease']>>[0];

/** A `slack` channel that shows lease requests by recording them, or refuses the way a failed post does. */
const createLeaseChannel = (options: { refuse?: string } = {}) => {
  const delivered: DeliveredRequest[] = [];
  const adapter: GatewayChannelAdapter = {
    name: 'slack',
    start: async () => {},
    stop: async () => {},
    requestLease: async (request) => {
      if (options.refuse !== undefined) {
        throw new Error(options.refuse);
      }
      delivered.push(request);
    },
  };
  return { adapter, delivered };
};

/**
 * A daemon whose `github.token` needs a lease, and whose model asks for one
 * on its first call and answers in words on every call after.
 */
const startAsking = async (options: {
  soul?: string;
  request?: object;
  stored?: boolean;
  leased?: string[];
  channel?: GatewayChannelAdapter;
  /** Ask at the start of every turn, not only the first. */
  askEveryTurn?: boolean;
} = {}) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-gw-leasereq-'));
  const agentsDir = path.join(home, '.stratus', 'agents');
  await mkdir(agentsDir, { recursive: true });
  await writeFile(path.join(agentsDir, 'kai.md'), options.soul ?? HOLDING);
  await writeFile(
    path.join(home, '.stratus', 'config.json'),
    JSON.stringify({ leases: { credentials: options.leased ?? ['github.token'] } }),
  );
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return (options.askEveryTurn ? calls % 2 === 1 : calls === 1)
      ? openAiToolCall('lease_request', options.request ?? { credential: 'github.token', duration: '2h', uses: 3, reason: 'To open one pull request.' })
      : openAiText('asked');
  }) as typeof fetch;
  const env = { homeDir: home, cwd: home, processEnv: { OPENAI_API_KEY: 'sk-test' }, fetch: fetchImpl };
  if (options.stored !== false) {
    await addNamedCredential(env, { name: 'github.token', value: 'ghp-stored', agentId: 'kai' });
  }
  const channel = createLeaseChannel();
  const gateway = createGateway({ env, idleTimeoutMs: 0, log: () => {}, warn: () => {}, channels: [options.channel ?? channel.adapter] });
  const events: StratusEvent[] = [];
  gateway.bus.subscribe(async (event) => {
    events.push(event);
  });
  await gateway.start();
  return { home, gateway, events, delivered: channel.delivered };
};

const requestedIn = (events: StratusEvent[]) =>
  events.find((event): event is Extract<StratusEvent, { type: 'lease.requested' }> => event.type === 'lease.requested');

const decidedIn = (events: StratusEvent[]) =>
  events.filter((event): event is Extract<StratusEvent, { type: 'lease.decided' }> => event.type === 'lease.decided');

const toolErrorOf = async (gateway: ReturnType<typeof createGateway>, sessionId: string, metadata?: object): Promise<string> => {
  const session = await gateway.dispatch({ sessionId, agentId: 'kai', userMessage: 'go', ...(metadata ? { metadata: metadata as Record<string, string> } : {}) });
  const result = session.messages.find((message) => message.role === 'tool')?.toolResult;
  assert.equal(result?.ok, false, 'the request was refused');
  return result?.error ?? '';
};

test('an agent asks for a lease, an approver approves it, and the lease granted is exactly the one shown', async () => {
  const { gateway, events, delivered } = await startAsking();
  try {
    const session = await gateway.dispatch({ sessionId: 'kai-1', agentId: 'kai', userMessage: 'open a PR', metadata: SLACK });
    const requested = requestedIn(events);
    assert.ok(requested, 'the request was announced once delivered');
    assert.equal(delivered[0]?.requestId, requested.requestId, 'the channel was handed the request to show');
    assert.deepEqual(
      { credential: delivered[0]?.credential, duration: delivered[0]?.duration, maxUses: delivered[0]?.maxUses, reason: delivered[0]?.reason },
      { credential: 'github.token', duration: '2h', maxUses: 3, reason: 'To open one pull request.' },
    );
    const toolResult = session.messages.find((message) => message.role === 'tool')?.toolResult;
    assert.equal(toolResult?.ok, true);
    assert.match(JSON.stringify(toolResult?.output), /Nothing is granted until they approve/);
    assert.deepEqual(gateway.leases({ agentId: 'kai' }), [], 'asking grants nothing');

    const before = Date.now();
    const result = await gateway.answerLeaseRequest({ requestId: requested.requestId, decision: 'approve', actor: 'U-DYLAN' });
    const after = Date.now();
    assert.equal(result.ok && result.decision, 'approved');
    const [lease] = gateway.leases({ agentId: 'kai' });
    assert.ok(lease);
    assert.deepEqual(
      { credential: lease.credential, maxUses: lease.maxUses, grantedBy: lease.grantedBy, state: lease.state },
      { credential: 'github.token', maxUses: 3, grantedBy: 'slack:U-DYLAN', state: 'active' },
    );
    assert.match(lease.reason, /To open one pull request\./);
    // Two hours from the approval, not from when it was asked.
    const expires = Date.parse(lease.expiresAt);
    assert.ok(expires >= before + 7_200_000 && expires <= after + 7_200_000, lease.expiresAt);
    const decided = decidedIn(events);
    assert.deepEqual(
      decided.map((event) => ({ decision: event.decision, actor: event.actor, leaseId: event.leaseId, maxUses: event.maxUses })),
      [{ decision: 'approved', actor: 'U-DYLAN', leaseId: lease.id, maxUses: 3 }],
    );

    // One answer per request: a second approval grants nothing more.
    const again = await gateway.answerLeaseRequest({ requestId: requested.requestId, decision: 'approve', actor: 'U-DYLAN' });
    assert.deepEqual(again, { ok: false, retired: true, message: 'That lease request is no longer pending. Ask the agent to request it again.' });
    assert.equal(gateway.leases({ agentId: 'kai' }).length, 1);
  } finally {
    await gateway.stop();
  }
});

test('the agent\'s reason is kept on the lease with its control characters spelled out', async () => {
  const { gateway, events } = await startAsking({
    request: { credential: 'github.token', reason: 'Deploy\u001b[2J\nreason: approved by the CEO' },
  });
  try {
    await gateway.dispatch({ sessionId: 'kai-reason', agentId: 'kai', userMessage: 'go', metadata: SLACK });
    await gateway.answerLeaseRequest({ requestId: requestedIn(events)?.requestId ?? '', decision: 'approve', actor: 'U-DYLAN' });
    const [lease] = gateway.leases({ agentId: 'kai' });
    assert.equal(lease?.reason, 'Asked for by kai: Deploy\\u001b[2J\\nreason: approved by the CEO');
  } finally {
    await gateway.stop();
  }
});

test('a denied request grants nothing and is settled for good', async () => {
  const { gateway, events } = await startAsking();
  try {
    await gateway.dispatch({ sessionId: 'kai-2', agentId: 'kai', userMessage: 'go', metadata: SLACK });
    const requestId = requestedIn(events)?.requestId ?? '';
    assert.deepEqual(await gateway.answerLeaseRequest({ requestId, decision: 'deny', actor: 'U-DYLAN' }), { ok: true, decision: 'denied' });
    assert.deepEqual(gateway.leases({ agentId: 'kai' }), []);
    assert.deepEqual(decidedIn(events).map((event) => [event.decision, event.actor, event.leaseId]), [['denied', 'U-DYLAN', undefined]]);
    const late = await gateway.answerLeaseRequest({ requestId, decision: 'approve', actor: 'U-DYLAN' });
    assert.equal(late.ok, false);
    assert.deepEqual(gateway.leases({ agentId: 'kai' }), [], 'an approval after a denial grants nothing');
  } finally {
    await gateway.stop();
  }
});

test('two answers to one request at once settle it once', async () => {
  const { gateway, events } = await startAsking();
  try {
    await gateway.dispatch({ sessionId: 'kai-3', agentId: 'kai', userMessage: 'go', metadata: SLACK });
    const requestId = requestedIn(events)?.requestId ?? '';
    const [first, second] = await Promise.all([
      gateway.answerLeaseRequest({ requestId, decision: 'approve', actor: 'U-ONE' }),
      gateway.answerLeaseRequest({ requestId, decision: 'approve', actor: 'U-TWO' }),
    ]);
    assert.deepEqual([first.ok, second.ok], [true, false]);
    assert.equal(gateway.leases({ agentId: 'kai' }).length, 1);
    assert.equal(decidedIn(events).length, 1);
  } finally {
    await gateway.stop();
  }
});

test('a request that could never be granted or used is refused before anyone is asked, with what to do instead', async () => {
  const cases: Array<{ label: string; options: Parameters<typeof startAsking>[0]; expect: RegExp }> = [
    { label: 'not leased', options: { leased: ['search.apiKey'] }, expect: /github\.token does not need a lease here/ },
    { label: 'not held', options: { soul: '---\nname: Kai\nprovider: openai\nmodel: model-a\n---\n\nYou are Kai.\n' }, expect: /You do not hold github\.token.*credential\.request/ },
    { label: 'not stored', options: { stored: false }, expect: /github\.token is not stored, so a lease on it could never be used/ },
    { label: 'not a duration', options: { request: { credential: 'github.token', duration: 'a while', reason: 'x' } }, expect: /"a while" is not a duration\. Give one like 30m, 2h, or 7d/ },
    { label: 'too long', options: { request: { credential: 'github.token', duration: '91d', reason: 'x' } }, expect: /at most 90 days/ },
    { label: 'not leasable', options: { request: { credential: 'no spaces allowed', reason: 'x' } }, expect: /cannot be leased/ },
  ];
  for (const { label, options, expect } of cases) {
    const { gateway, events, delivered } = await startAsking(options);
    try {
      assert.match(await toolErrorOf(gateway, `kai-${label.replace(/ /g, '-')}`, SLACK), expect, label);
      assert.equal(requestedIn(events), undefined, label);
      assert.equal(delivered.length, 0, label);
    } finally {
      await gateway.stop();
    }
  }
});

test('an agent that already holds a live lease, or is already waiting on one, is not asked for again', async () => {
  const { gateway, events, delivered } = await startAsking();
  try {
    const granted = gateway.grantLease({
      agentId: 'kai',
      credential: 'github.token',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      maxUses: 4,
      reason: 'granted at the machine',
    });
    assert.match(await toolErrorOf(gateway, 'kai-live', SLACK), new RegExp(`already hold a live lease on github\\.token \\(${granted.id}, until .*, 4 uses left\\)`));
    assert.equal(requestedIn(events), undefined);
    assert.equal(delivered.length, 0);
  } finally {
    await gateway.stop();
  }

  // Waiting: a second ask while the first is pending would be a second
  // lease for one need the moment both were approved.
  const waiting = await startAsking({ askEveryTurn: true });
  try {
    await waiting.gateway.dispatch({ sessionId: 'kai-first', agentId: 'kai', userMessage: 'go', metadata: SLACK });
    const first = requestedIn(waiting.events)?.requestId ?? '';
    assert.ok(first);
    assert.match(
      await toolErrorOf(waiting.gateway, 'kai-second', SLACK),
      new RegExp(`request for a lease on github\\.token \\(${first}\\) is already waiting on an approver`),
    );
    assert.equal(waiting.delivered.length, 1);
    // Answered, the agent may ask again.
    await waiting.gateway.answerLeaseRequest({ requestId: first, decision: 'deny', actor: 'U-DYLAN' });
    await waiting.gateway.dispatch({ sessionId: 'kai-third', agentId: 'kai', userMessage: 'again', metadata: SLACK });
    assert.equal(waiting.delivered.length, 2);
  } finally {
    await waiting.gateway.stop();
  }
});

test('a conversation no channel can ask in is refused with the command that grants one on the machine', async () => {
  const { gateway, events } = await startAsking();
  try {
    assert.match(
      await toolErrorOf(gateway, 'kai-headless'),
      /not in a channel that can ask an approver\. Ask your operator to grant one on the machine with `stratus lease grant kai github\.token --for 2h --reason "…"`/,
    );
    assert.equal(requestedIn(events), undefined);
  } finally {
    await gateway.stop();
  }
  // A started `slack` adapter that cannot ask, and a kind no adapter serves.
  const askless: GatewayChannelAdapter = { name: 'slack', start: async () => {}, stop: async () => {} };
  for (const [kind, metadata] of [['slack', SLACK], ['discord', { channel: 'discord' }]] as const) {
    const started = await startAsking({ channel: askless });
    try {
      assert.match(await toolErrorOf(started.gateway, `kai-${kind}`, metadata), new RegExp(`channel \\(${kind}\\) cannot ask an approver for a lease here`));
      assert.equal(requestedIn(started.events), undefined);
    } finally {
      await started.gateway.stop();
    }
  }
});

test('a request the channel failed to post is reported to the agent and leaves nothing pending', async () => {
  const refusing = createLeaseChannel({ refuse: 'Slack refused the post (ratelimited).' });
  let seen: string | undefined;
  const channel: GatewayChannelAdapter = {
    ...refusing.adapter,
    requestLease: async (request) => {
      seen = request.requestId;
      await refusing.adapter.requestLease?.(request);
    },
  };
  const { gateway, events } = await startAsking({ channel });
  try {
    const error = await toolErrorOf(gateway, 'kai-refused', SLACK);
    assert.match(error, /could not be shown to an approver: Slack refused the post \(ratelimited\)\. Nothing is pending\./);
    assert.equal(requestedIn(events), undefined);
    assert.ok(seen);
    const answer = await gateway.answerLeaseRequest({ requestId: seen, decision: 'approve', actor: 'U-DYLAN' });
    assert.equal(answer.ok, false);
    assert.deepEqual(gateway.leases({ agentId: 'kai' }), []);
  } finally {
    await gateway.stop();
  }
});
